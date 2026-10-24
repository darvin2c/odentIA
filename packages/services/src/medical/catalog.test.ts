import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { seedCatalog } from "@odentia/db/products"
import { user } from "@odentia/db/schema/auth"
import { orgSpecialty, serviceCatalog } from "@odentia/db/schema/clinical"
import { orgProfile } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { seedDiagnosisCodes } from "../clinical-test-fixture.js"
import { searchDiagnosisCodes } from "../diagnosis-codes.js"
import {
  createService,
  fromTemplates,
  listMostUsedServices,
  listTemplates,
  searchOfficialCodes,
} from "../service-catalog.js"
import { ensureClinicSpecialties } from "../specialties.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "../test-setup.js"

setupTestDb()

beforeAll(async () => {
  await seedCatalog(ownerDb)
})

/** Un consultorio de latidIA (o una clínica de odentIA) del país pedido, con quien lo configura. */
async function clinic(product: "dental" | "medical", country: string) {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `catalogo-${orgId}`)
  await ownerDb
    .update(orgProfile)
    .set({ product, countryCode: country })
    .where(eq(orgProfile.organizationId, orgId))
  const actor = randomUUID()
  await ownerDb
    .insert(user)
    .values({ id: actor, name: "Dra. Vela", email: `${actor}@catalogo.test` })
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  await run((tx) => ensureClinicSpecialties(tx, orgId))
  return { orgId, actor, run }
}

it("un consultorio de Perú nace con las cinco especialidades y ve la biblioteca médica con su código CPMS (issue 229, entrega 8)", async () => {
  const c = await clinic("medical", "PE")
  const specialties = await ownerDb
    .select({ key: orgSpecialty.key, name: orgSpecialty.name })
    .from(orgSpecialty)
    .where(eq(orgSpecialty.organizationId, c.orgId))
  expect(specialties.map((row) => row.name).sort()).toEqual([
    "Ginecología y obstetricia",
    "Medicina familiar",
    "Medicina general",
    "Medicina interna",
    "Pediatría",
  ])

  // Solo lo médico, cada uno con su código CPMS; la toma del Papanicolaou no
  // tiene código en la CPMS y, con la lista obligatoria, no se ofrece.
  const library = await c.run((tx) => listTemplates(tx, c.orgId, { limit: 100 }))
  expect(library.codeList).toEqual({ system: "CPMS", required: true })
  expect(library.total).toBe(37)
  expect(
    library.data.every((row) => row.product === "medical" && row.codings[0]?.system === "CPMS"),
  ).toBe(true)
  expect(library.data.some((row) => row.key === "papanicolaou")).toBe(false)
  const ecg = library.data.find((row) => row.key === "electrocardiograma")
  expect(ecg?.codings[0]?.code).toBe("93000")

  // «Más usados» agrupa por los tipos de latidIA.
  const most = await c.run((tx) => listMostUsedServices(tx, c.orgId))
  expect(most.map((group) => group.label)).toContain("Ginecología y obstetricia")
  expect(most.flatMap((group) => group.templates).every((row) => row.product === "medical")).toBe(
    true,
  )

  // El buscador de código ofrece lo médico de la CPMS, no lo odontológico.
  const consult = await c.run((tx) => searchOfficialCodes(tx, c.orgId, { q: "99215" }))
  expect(consult.data.map((row) => row.code)).toContain("99215")
  const dental = await c.run((tx) => searchOfficialCodes(tx, c.orgId, { q: "D0140" }))
  expect(dental.data).toEqual([])

  // Un servicio propio, con su especialidad y su código CPMS.
  const [interna] = specialties.filter((row) => row.key === "medicina_interna")
  const [internaRow] = await ownerDb
    .select({ id: orgSpecialty.id })
    .from(orgSpecialty)
    .where(and(eq(orgSpecialty.organizationId, c.orgId), eq(orgSpecialty.key, interna!.key)))
  const own = await c.run((tx) =>
    createService(tx, c.orgId, c.actor, {
      name: "Control de hipertensión",
      specialtyId: internaRow!.id,
      scope: "general",
      priceCents: 9000,
      officialCode: "99215",
    }),
  )
  expect(own).toMatchObject({ procedureSystem: "CPMS", procedureCode: "99215" })

  // De la biblioteca toma la especialidad que recibe su tipo: la nebulización, Medicina general.
  const nebulization = library.data.find((row) => row.key === "nebulizacion")!
  await c.run((tx) =>
    fromTemplates(tx, c.orgId, c.actor, [{ templateId: nebulization.id, priceCents: 3000 }]),
  )
  const [added] = await ownerDb
    .select({ specialty: orgSpecialty.key })
    .from(serviceCatalog)
    .innerJoin(orgSpecialty, eq(orgSpecialty.id, serviceCatalog.specialtyId))
    .where(
      and(
        eq(serviceCatalog.organizationId, c.orgId),
        eq(serviceCatalog.templateId, nebulization.id),
      ),
    )
  expect(added).toEqual({ specialty: "medicina_general" })

  // odentIA no ve la biblioteca médica ni puede agregar de ella.
  const d = await clinic("dental", "PE")
  const dentalLibrary = await d.run((tx) =>
    listTemplates(tx, d.orgId, { q: "nebulizacion", limit: 10 }),
  )
  expect(dentalLibrary.total).toBe(0)
  await expect(
    d.run((tx) =>
      createService(tx, d.orgId, d.actor, { templateId: nebulization.id, priceCents: 3000 }),
    ),
  ).rejects.toThrow(/biblioteca/)
})

it("cada país con la lista que vale para latidIA: la CUPS en Colombia; en Costa Rica, ninguna", async () => {
  // Colombia: la CUPS es obligatoria; la toma del Papanicolaou sí tiene código,
  // y un inyectable sin sustancia no (la CUPS los codifica por sustancia).
  const co = await clinic("medical", "CO")
  const colombia = await co.run((tx) => listTemplates(tx, co.orgId, { limit: 100 }))
  expect(colombia.codeList).toEqual({ system: "CUPS", required: true })
  expect(colombia.data.find((row) => row.key === "papanicolaou")?.codings[0]?.code).toBe("892901")
  expect(colombia.data.some((row) => row.key === "inyectable-intramuscular")).toBe(false)

  // Costa Rica: el tarifario del Colegio de Dentistas no es de un consultorio
  // médico; sin lista, la biblioteca entera y sin códigos.
  const cr = await clinic("medical", "CR")
  const costaRica = await cr.run((tx) => listTemplates(tx, cr.orgId, { limit: 100 }))
  expect(costaRica.codeList).toBeNull()
  expect(costaRica.total).toBe(38)
  expect(
    (await cr.run((tx) => searchOfficialCodes(tx, cr.orgId, { q: "consulta" }))).codeList,
  ).toBeNull()
})

it("el buscador de diagnósticos de latidIA pone primero los capítulos de la atención primaria", async () => {
  await seedDiagnosisCodes([
    { code: "C50.9", title: "Tumor maligno de la mama, dolor de prueba" },
    { code: "R52.9", title: "Dolor de prueba, no especificado" },
  ])
  const medical = await clinic("medical", "PE")
  const dental = await clinic("dental", "PE")
  const codes = async (c: {
    orgId: string
    run: (fn: (tx: typeof appDb) => Promise<unknown>) => Promise<unknown>
  }) =>
    (
      (await c.run((tx) => searchDiagnosisCodes(tx, c.orgId, "dolor de prueba"))) as Array<{
        code: string
      }>
    ).map((row) => row.code)
  expect(await codes(medical)).toEqual(["R52.9", "C50.9"])
  // En odentIA ninguno de los dos es de la boca: van por su código.
  expect(await codes(dental)).toEqual(["C50.9", "R52.9"])
})
