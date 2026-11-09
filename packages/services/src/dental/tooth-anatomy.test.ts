/**
 * La anatomía de la biblioteca (entrega 8 de la atención, punto 1): la
 * «Endodoncia anterior vital» indicada en la 46 llegó al consentimiento. Cada
 * tratamiento dice para qué piezas es y el servicio de la clínica lo trae con
 * sus hermanos, para que la atención avise y ofrezca la posterior.
 */
import { seedOdentiaCatalog } from "@odentia/db/dental"
import { treatmentTemplate } from "@odentia/db/schema/clinical"
import { dentalTemplateRule } from "@odentia/db/schema/dental"
import { toothFitNotice } from "@odentia/dental"
import { eq, inArray } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "../clinical-test-fixture.js"
import { createService, getService, listServices, updateService } from "../service-catalog.js"
import { ownerDb, setupTestDb } from "../test-setup.js"

setupTestDb()

async function templateIds(keys: string[]): Promise<Map<string, string>> {
  const rows = await ownerDb
    .select({ id: treatmentTemplate.id, key: treatmentTemplate.key })
    .from(treatmentTemplate)
    .where(inArray(treatmentTemplate.key, keys))
  return new Map(rows.map((row) => [row.key, row.id]))
}

it("la biblioteca guarda para qué piezas es cada tratamiento, sin subir su versión", async () => {
  await seedOdentiaCatalog(ownerDb)
  const ids = await templateIds([
    "endodoncia-posterior-vital",
    "resina-fotocurable-de-corona-completa-anterior",
  ])
  const ruleOf = async (key: string) =>
    (
      await ownerDb
        .select()
        .from(dentalTemplateRule)
        .where(eq(dentalTemplateRule.templateId, ids.get(key)!))
    )[0]
  expect(await ruleOf("endodoncia-posterior-vital")).toMatchObject({
    toothGroups: ["molar"],
    dentition: "permanent",
    family: "endodoncia-vital",
  })
  // Sin caras ni lo que deja, la fila se conserva por su anatomía.
  expect(await ruleOf("resina-fotocurable-de-corona-completa-anterior")).toMatchObject({
    surfaceCountMin: null,
    leavesCondition: null,
    toothGroups: ["anterior"],
  })
  // Sembrar otra vez no cambia la versión: la anatomía es una ayuda, como las sesiones.
  const versions = async () =>
    (
      await ownerDb
        .select({ version: treatmentTemplate.version })
        .from(treatmentTemplate)
        .where(eq(treatmentTemplate.id, ids.get("endodoncia-posterior-vital")!))
    )[0]?.version
  const before = await versions()
  await ownerDb
    .update(dentalTemplateRule)
    .set({ family: "otra", toothGroups: ["anterior"] })
    .where(eq(dentalTemplateRule.templateId, ids.get("endodoncia-posterior-vital")!))
  await seedOdentiaCatalog(ownerDb)
  expect(await versions()).toBe(before)
  expect((await ruleOf("endodoncia-posterior-vital"))?.family).toBe("endodoncia-vital")
})

it("el servicio trae la anatomía de su tratamiento y sus hermanos activos; uno propio, ninguna", async () => {
  await seedOdentiaCatalog(ownerDb)
  const f = await clinicalFixture()
  const ids = await templateIds([
    "endodoncia-anterior-vital",
    "endodoncia-posterior-vital",
    "endodoncia-bicuspide-vital",
  ])
  const create = (key: string, priceCents: number) =>
    f.run((tx) => createService(tx, "org_a", f.actor, { templateId: ids.get(key)!, priceCents }))
  const anterior = await create("endodoncia-anterior-vital", 45_000)
  const posterior = await create("endodoncia-posterior-vital", 65_000)
  const bicuspid = await create("endodoncia-bicuspide-vital", 55_000)

  const found = await f.run((tx) => getService(tx, "org_a", anterior.id))
  expect(found.toothAnatomy).toMatchObject({
    groups: ["anterior"],
    dentition: "permanent",
    family: "endodoncia-vital",
  })
  expect(found.toothAnatomy?.siblings.map((sibling) => sibling.id).sort()).toEqual(
    [bicuspid.id, posterior.id].sort(),
  )
  // La atención avisa en la 46 y ofrece la posterior con su precio.
  const notice = toothFitNotice(
    { name: found.name, anatomy: found.toothAnatomy },
    46,
    found.toothAnatomy!.siblings,
  )
  expect(notice?.message).toBe(
    "La 46 es un molar y «Endodoncia anterior vital» es para dientes anteriores.",
  )
  expect(notice?.sibling).toMatchObject({ id: posterior.id, priceCents: 65_000 })

  // Desactivada la posterior, no hay a quién ofrecer: la bicúspide no sirve en un molar.
  await f.run((tx) => updateService(tx, "org_a", f.actor, posterior.id, { isActive: false }))
  const listed = await f.run((tx) =>
    listServices(tx, "org_a", { ids: [anterior.id, f.service.id] }),
  )
  const again = listed.data.find((row) => row.id === anterior.id)!
  expect(again.toothAnatomy?.siblings.map((sibling) => sibling.id)).toEqual([bicuspid.id])
  expect(
    toothFitNotice(
      { name: again.name, anatomy: again.toothAnatomy },
      46,
      again.toothAnatomy!.siblings,
    )?.missing,
  ).toBe("Tu lista no tiene una para molares: el consentimiento dirá «anterior».")
  // Un servicio propio, sin biblioteca, nunca avisa.
  expect(listed.data.find((row) => row.id === f.service.id)?.toothAnatomy).toBeNull()
})

it("la endodoncia de una permanente en una temporal ofrece la pulpectomía; al revés, ninguna (QA del 9 nov, repaso 3)", async () => {
  await seedOdentiaCatalog(ownerDb)
  const f = await clinicalFixture()
  const ids = await templateIds(["endodoncia-posterior-no-vital", "pulpectomia-posterior-deciduo"])
  const create = (key: string, priceCents: number) =>
    f.run((tx) => createService(tx, "org_a", f.actor, { templateId: ids.get(key)!, priceCents }))
  const endodontics = await create("endodoncia-posterior-no-vital", 70_000)
  const pulpectomy = await create("pulpectomia-posterior-deciduo", 28_000)
  const found = await f.run((tx) => getService(tx, "org_a", endodontics.id))
  const notice = toothFitNotice({ name: found.name, anatomy: found.toothAnatomy }, 75, found.toothAnatomy!.siblings)
  expect(notice?.sibling).toMatchObject({ id: pulpectomy.id, priceCents: 28_000 })
  // En una permanente la pulpectomía de temporal no sabe si la pulpa vive: no elige por la persona.
  const back = await f.run((tx) => getService(tx, "org_a", pulpectomy.id))
  expect(back.toothAnatomy?.siblings.map((sibling) => sibling.id)).not.toContain(endodontics.id)
})
