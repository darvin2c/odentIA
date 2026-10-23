import { withPlanItemDental } from "./plan-finding.js"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { validateLeavesFinding } from "@odentia/dental"
import { user } from "@odentia/db/schema/auth"
import { encounter, encounterDiagnosis, serviceCatalog, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { odontogramEntry, serviceFinding } from "@odentia/db/schema/dental"
import { and, eq, isNull, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "../budgets.js"
import {
  addOdontogramEntries,
  closingOdontogramOf,
  createOdontogramAssessment,
  getOdontogram,
  listOdontogramAssessments,
} from "./odontogram.js"
import { makeSigner, readyToClose, seedDiagnosisCodes } from "../clinical-test-fixture.js"
import {
  addEncounterProcedure,
  finalizeEncounter,
  getEncounterClosing,
  voidEncounterProcedure,
} from "../encounters.js"
import { nextPatientNumber } from "../patients.js"
import { addPlanItem, setPlanItemStatus } from "../plan.js"
import { createService } from "../service-catalog.js"
import { librarySpecialtyIds } from "../specialties.js"
import { appDb, ownerDb, setupTestDb } from "../test-setup.js"
import { registerToothFinding } from "./tooth-panel.js"
import { drawTreatedFinding } from "./treated-findings.js"
import { withOrgContext } from "@odentia/db"
import { seedOdentiaCatalog } from "@odentia/db/dental"
import { insertTestPatients } from "../test-patient.js"

setupTestDb()

/** Clínica de otro país, armada en la prueba: la semilla sigue siendo peruana. */
async function colombianClinic(): Promise<string> {
  const id = `org_co_${randomUUID().slice(0, 8)}`
  await ownerDb.execute(
    sql`insert into "organization" ("id", "name", "slug", "created_at")
        values (${id}, 'Clínica Bogotá', ${id}, now())`,
  )
  await ownerDb.execute(
    sql`insert into "org_profile" ("organization_id", "legal_name", "country_code", "currency", "timezone", "locale")
        values (${id}, 'Clínica Bogotá', 'CO', 'COP', 'America/Bogota', 'es-CO')`,
  )
  return id
}

/** Quien atiende, una persona y una atención en borrador en la clínica dada. */
async function attending(orgId: string) {
  const actor = randomUUID()
  await ownerDb.insert(user).values({ id: actor, name: "Ana Torres", email: `${actor}@example.test` })
  await makeSigner(orgId, actor)
  await seedDiagnosisCodes([
      { code: "K02", title: "Caries dental" },
      { code: "K02.1", title: "Caries de la dentina" },
    ])
  const [person] = await insertTestPatients(ownerDb, {
      organizationId: orgId,
      displayName: "Lucía Fernández",
      patientNumber: await nextPatientNumber(ownerDb, orgId),
    })
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const open = async () => {
    const [row] = await ownerDb
      .insert(encounter)
      .values({ organizationId: orgId, patientId: person!.id, professionalUserId: actor, reason: "Control" })
      .returning()
    return row!.id
  }
  return { orgId, actor, patientId: person!.id, run, open, args: [orgId, actor, person!.id] as const }
}

const caries16 = { toothNumber: 16, condition: "caries", surfaces: ["occlusal"] }

it("los hallazgos solo se registran dentro de una atención de quien la lleva", async () => {
  const f = await attending("org_a")
  await expect(
    f.run((tx) =>
      addOdontogramEntries(tx, ...f.args, {
        ...caries16,
        details: { variant: "dentin" },
      } as unknown as Parameters<typeof addOdontogramEntries>[4]),
    ),
  ).rejects.toMatchObject({ code: "ENCOUNTER_REQUIRED", status: 400 })
  // En la atención de otro profesional se toma el relevo antes.
  const colleague = await attending("org_a")
  const theirs = await colleague.open()
  await expect(
    f.run((tx) =>
      addOdontogramEntries(tx, "org_a", f.actor, colleague.patientId, {
        ...caries16,
        details: { variant: "dentin" },
        encounterId: theirs,
      }),
    ),
  ).rejects.toMatchObject({ code: "NOT_ATTENDING" })
  const mine = await f.open()
  const rows = await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, { ...caries16, details: { variant: "dentin" }, encounterId: mine }),
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ encounterId: mine, leftByPlanItemId: null })
})

it("en Perú la variante sigue obligatoria y en otro país es opcional", async () => {
  const peru = await attending("org_a")
  const peruDraft = await peru.open()
  await expect(
    peru.run((tx) => addOdontogramEntries(tx, ...peru.args, { ...caries16, encounterId: peruDraft })),
  ).rejects.toMatchObject({ status: 400 })
  const bogota = await attending(await colombianClinic())
  const draft = await bogota.open()
  const [row] = await bogota.run((tx) =>
    addOdontogramEntries(tx, ...bogota.args, { ...caries16, encounterId: draft }),
  )
  expect(row).toMatchObject({ condition: "caries", surface: "occlusal" })
  expect(row?.details).toEqual({})
})

it("al cerrar en Perú una atención que cambió el gráfico sale el odontograma firmado con su momento", async () => {
  const f = await attending("org_a")
  const first = await f.open()
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, { ...caries16, details: { variant: "dentin" }, encounterId: first }),
  )
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 26,
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "enamel" },
      encounterId: first,
    }),
  )
  // El cierre lo dice antes de firmar, con lo que cambió.
  const closing = await f.run((tx) => getEncounterClosing(tx, ...f.args, first))
  expect(closing.odontogram).toEqual({
    purpose: "initial",
    standard: "NTS 188-MINSA/DGIESP-2022",
    shortName: "NTS 188",
    findings: [{ condition: "caries", teeth: [16, 26] }],
  })
  await readyToClose(f.orgId, f.actor, f.patientId, first)
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, first))
  expect(closed.odontogram).toMatchObject({ purpose: "initial" })
  const [signed] = await f.run((tx) => listOdontogramAssessments(tx, f.orgId, f.patientId))
  expect(signed).toMatchObject({
    purpose: "initial",
    encounterId: first,
    standard: "NTS 188-MINSA/DGIESP-2022",
    examinerName: "Ana Torres",
    examinerTitle: "Cirujano dentista",
    registrationNumber: "COP 12345",
  })
  expect(signed?.entries as unknown[]).toHaveLength(2)

  // Una atención que no cambió el gráfico no firma otro.
  const quiet = await f.open()
  await readyToClose(f.orgId, f.actor, f.patientId, quiet)
  expect((await f.run((tx) => finalizeEncounter(tx, ...f.args, quiet))).odontogram).toBeNull()

  // Lo siguiente que cambia el gráfico son nuevos hallazgos.
  const next = await f.open()
  await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, {
      toothNumber: 36,
      condition: "root_remnant",
      encounterId: next,
    }),
  )
  await readyToClose(f.orgId, f.actor, f.patientId, next)
  expect((await f.run((tx) => finalizeEncounter(tx, ...f.args, next))).odontogram).toMatchObject({
    purpose: "new_findings",
  })
  expect(await f.run((tx) => listOdontogramAssessments(tx, f.orgId, f.patientId))).toHaveLength(2)
})

it("fuera de Perú no hay odontograma firmado: el cierre no firma y el botón no existe", async () => {
  const f = await attending(await colombianClinic())
  const draft = await f.open()
  await f.run((tx) => addOdontogramEntries(tx, ...f.args, { ...caries16, encounterId: draft }))
  expect(await f.run((tx) => closingOdontogramOf(tx, f.orgId, f.patientId, draft))).toBeNull()
  await readyToClose(f.orgId, f.actor, f.patientId, draft)
  expect((await f.run((tx) => finalizeEncounter(tx, ...f.args, draft))).odontogram).toBeNull()
  expect(await f.run((tx) => listOdontogramAssessments(tx, f.orgId, f.patientId))).toEqual([])
  await expect(
    f.run((tx) => createOdontogramAssessment(tx, ...f.args, { purpose: "personal" })),
  ).rejects.toMatchObject({ code: "SIGNED_ODONTOGRAM_UNAVAILABLE" })
})

it("«Firmar odontograma» firma con el perfil, solo para pedidos y reingreso, y no toma datos del cuerpo", async () => {
  const f = await attending("org_a")
  await expect(
    f.run((tx) => createOdontogramAssessment(tx, ...f.args, { purpose: "initial" })),
  ).rejects.toMatchObject({ status: 400 })
  const signed = await f.run((tx) =>
    createOdontogramAssessment(tx, ...f.args, {
      purpose: "legal",
      observations: "Pedido del juzgado",
      // Lo que se escriba como firmante o trazo no cuenta: firma el perfil.
      examinerName: "Otra persona",
      registrationNumber: "COP 999",
      signature: [[[1, 1], [2, 2]]],
    } as Parameters<typeof createOdontogramAssessment>[4]),
  )
  expect(signed).toMatchObject({
    purpose: "legal",
    encounterId: null,
    examinerName: "Ana Torres",
    examinerTitle: "Cirujano dentista",
    registrationNumber: "COP 12345",
    observations: "Pedido del juzgado",
  })
  expect(Object.keys(signed)).not.toContain("signature")
})

it("completar un tratamiento cuyo servicio deja algo lo dibuja una sola vez", async () => {
  const f = await attending("org_a")
  const draft = await f.open()
  // En el Perú cada servicio propio lleva su código CPMS (ADR 0069).
  await seedOdentiaCatalog(ownerDb)
  const resin = await f.run(async (tx) =>
    createService(tx, f.orgId, f.actor, {
      name: "Resina compuesta",
      officialCode: "D2391",
      specialtyId: (await librarySpecialtyIds(tx, f.orgId, ["restauradora"])).get("restauradora")!,
      scope: "surfaces",
      priceCents: 18000,
      leavesFinding: { condition: "definitive_restoration", variant: "resin" },
    }),
  )
  // En Perú lo que deja se configura con su variante.
  await expect(
    f.run(async (tx) =>
      createService(tx, f.orgId, f.actor, {
        name: "Corona",
        officialCode: "D2740",
        specialtyId: (await librarySpecialtyIds(tx, f.orgId, ["protesis"])).get("protesis")!,
        scope: "tooth",
        priceCents: 50000,
        leavesFinding: { condition: "crown" },
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  const [caries] = await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, { ...caries16, details: { variant: "dentin" }, encounterId: draft }),
  )
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: resin.id,
      sourceEncounterId: draft,
      toothNumber: 16,
      surfaces: ["occlusal"],
      odontogramEntryId: caries!.id,
    }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: item.planId, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  const procedure = await f.run((tx) => addEncounterProcedure(tx, ...f.args, draft, { planItemId: item.id }))
  await f.run((tx) => setPlanItemStatus(tx, ...f.args, item.id, { status: "realizado", encounterId: draft }))
  const left = () =>
    ownerDb
      .select()
      .from(odontogramEntry)
      .where(and(eq(odontogramEntry.leftByPlanItemId, item.id), isNull(odontogramEntry.voidedAt)))
  const [restoration] = await left()
  expect(restoration).toMatchObject({
    toothNumber: 16,
    surface: "occlusal",
    condition: "definitive_restoration",
    encounterId: draft,
    details: { variant: "resin", quality: "good" },
  })
  // Otra vez no lo duplica.
  const [row] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, item.id))
  const treated = await withPlanItemDental(ownerDb, f.orgId, row!)
  expect(await f.run((tx) => drawTreatedFinding(tx, ...f.args, draft, treated))).toBeNull()
  expect(await left()).toHaveLength(1)
  // Si se anula su procedimiento deja de estar realizado y lo dibujado se anula.
  await f.run((tx) => voidEncounterProcedure(tx, ...f.args, draft, procedure.id, { reason: "Pieza equivocada" }))
  expect(await left()).toHaveLength(0)
  // Al cerrar, la caries ya no está pero la restauración sí (con otro procedimiento y otro «Completar»).
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, draft, { planItemId: item.id }))
  await f.run((tx) => setPlanItemStatus(tx, ...f.args, item.id, { status: "realizado", encounterId: draft }))
  await readyToClose(f.orgId, f.actor, f.patientId, draft)
  await f.run((tx) => finalizeEncounter(tx, ...f.args, draft))
  const chart = await f.run((tx) => getOdontogram(tx, f.orgId, f.patientId))
  const active = chart.teeth["16"]!.entries.map((id) => chart.history.find((entry) => entry.id === id)?.condition)
  expect(active).toEqual(["definitive_restoration"])
})

it("la exodoncia de un servicio directo deja la pieza ausente con su causa en Perú", async () => {
  const f = await attending("org_a")
  const draft = await f.open()
  const [service] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: f.orgId,
      name: "Exodoncia simple",
      scope: "tooth",
      source: "custom",
      priceCents: 9000,
      currency: "PEN",
    })
    .returning()
  await ownerDb.insert(serviceFinding).values({ serviceId: service!.id, organizationId: f.orgId, condition: "missing_tooth" })
  const [remnant] = await f.run((tx) =>
    addOdontogramEntries(tx, ...f.args, { toothNumber: 46, condition: "root_remnant", encounterId: draft }),
  )
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, draft, {
      serviceId: service!.id,
      toothNumber: 46,
      odontogramEntryId: remnant!.id,
    }),
  )
  const [absent] = await ownerDb
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.encounterId, draft), eq(odontogramEntry.condition, "missing_tooth")))
  expect(absent?.details).toMatchObject({ variant: "caries_extraction" })
  expect(absent?.leftByPlanItemId).not.toBeNull()
})

it("el panel de la pieza deja hallazgo, diagnóstico y tratamiento juntos, o nada", async () => {
  const f = await attending("org_a")
  const draft = await f.open()
  const [resin] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: f.orgId,
      name: "Resina compuesta",
      scope: "surfaces",
      source: "custom",
      priceCents: 18000,
      currency: "PEN",
    })
    .returning()
  const result = await f.run((tx) =>
    registerToothFinding(tx, ...f.args, {
      encounterId: draft,
      toothNumbers: [16],
      condition: "caries",
      surfaces: ["occlusal"],
      details: { variant: "dentin" },
      diagnosis: { diagnosisCode: "K02.1", diagnosisType: "provisional" },
      treatment: { serviceId: resin!.id },
    }),
  )
  expect(result.entries).toHaveLength(1)
  const [diagnosis] = await ownerDb
    .select()
    .from(encounterDiagnosis)
    .where(eq(encounterDiagnosis.encounterId, draft))
  expect(diagnosis).toMatchObject({ diagnosisCode: "K02.1", diagnosisType: "provisional", siteSystem: "ISO-3950", siteCode: "16", siteQualifiers: ["occlusal"] })
  expect(result.planItems[0]).toMatchObject({
    toothNumber: 16,
    surfaces: ["occlusal"],
    odontogramEntryId: result.entries[0]!.id,
    diagnosisCode: "K02.1",
    sourceEncounterId: draft,
  })
  // Cuenta como diagnóstico de la atención: el cierre ya no lo pide.
  expect((await f.run((tx) => getEncounterClosing(tx, ...f.args, draft))).missing).not.toContain("diagnosis")

  // Si algo falla (aquí, una categoría CIE-10 sin su subcódigo), no queda nada.
  const before = await ownerDb.select().from(odontogramEntry).where(eq(odontogramEntry.encounterId, draft))
  await expect(
    f.run((tx) =>
      registerToothFinding(tx, ...f.args, {
        encounterId: draft,
        toothNumbers: [26],
        condition: "caries",
        surfaces: ["occlusal"],
        details: { variant: "enamel" },
        diagnosis: { diagnosisCode: "K02", diagnosisType: "provisional" },
        treatment: { serviceId: resin!.id },
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })
  expect(await ownerDb.select().from(odontogramEntry).where(eq(odontogramEntry.encounterId, draft))).toHaveLength(
    before.length,
  )
  expect(await ownerDb.select().from(encounterDiagnosis).where(eq(encounterDiagnosis.encounterId, draft))).toHaveLength(1)
})

it("lo que deja cada tratamiento de la biblioteca encaja con su ámbito y es un hallazgo completo", () => {
  const rows = readFileSync(new URL("../../../db/seeds/biblioteca.csv", import.meta.url), "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(",", 9))
  const leaving = rows.filter((cols) => cols[5])
  expect(leaving.length).toBeGreaterThan(0)
  for (const [key, , scope, , , condition, variant] of leaving) {
    const leaves = variant ? { condition: condition!, variant } : { condition: condition! }
    expect(validateLeavesFinding(leaves, { scope, strictVariants: true }), key).toEqual([])
  }
})
