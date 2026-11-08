/**
 * Sesiones habituales (ADR 0164): cada servicio trae con cuántas sesiones suele
 * hacerse y el plan las hereda al indicarlo. Sin eso, toda indicación nacía con
 * 1 y, desde ADR 0161, una endodoncia se terminaba en su primera firma.
 */
import { patientCharge, serviceCatalog, treatmentPlanItem, treatmentTemplate } from "@odentia/db/schema/clinical"
import { seedCatalog } from "@odentia/db/products"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, finalizeEncounter, getEncounterClosing } from "./encounters.js"
import { addPlanItem, addPlanItemsBatch, reopenPlanItemForSession, setPlanItemStatus, updatePlanItem } from "./plan.js"
import { fromTemplates, getService, listServices, updateService } from "./service-catalog.js"
import { ensureClinicSpecialties } from "./specialties.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

let keySeq = 0

/** Un tratamiento de la biblioteca de `sessions` sesiones habituales y el servicio de la clínica que lo usa. */
async function libraryService(f: Awaited<ReturnType<typeof clinicalFixture>>, sessions: number, scope = "general") {
  keySeq += 1
  const [template] = await ownerDb
    .insert(treatmentTemplate)
    .values({ key: `prueba-sesiones-${keySeq}`, name: `Endodoncia de prueba ${keySeq}`, kind: "endodoncia", scope, usualSessions: sessions })
    .returning()
  const [service] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: "org_a",
      templateId: template!.id,
      source: "template",
      name: template!.name,
      scope,
      priceCents: 45_000,
      currency: "PEN",
    })
    .returning()
  return { template: template!, service: service! }
}

it("el servicio dice sus sesiones habituales: las de la clínica, si no las de la biblioteca, y uno propio 1", async () => {
  const f = await clinicalFixture()
  const { service } = await libraryService(f, 2)
  expect((await f.run((tx) => getService(tx, "org_a", service.id))).usualSessions).toBe(2)
  const listed = await f.run((tx) => listServices(tx, "org_a", { ids: [service.id, f.service.id] }))
  expect(Object.fromEntries(listed.data.map((row) => [row.id, row.usualSessions]))).toEqual({ [service.id]: 2, [f.service.id]: 1 })
  // La clínica pone las suyas; nulas vuelve a lo que sugiere la biblioteca.
  const own = await f.run((tx) => updateService(tx, "org_a", f.actor, service.id, { usualSessions: 3 }))
  expect(own).toMatchObject({ usualSessions: 3, ownUsualSessions: 3 })
  const back = await f.run((tx) => updateService(tx, "org_a", f.actor, service.id, { usualSessions: null }))
  expect(back).toMatchObject({ usualSessions: 2, ownUsualSessions: null })
  await expect(
    f.run((tx) => updateService(tx, "org_a", f.actor, service.id, { usualSessions: 61 })),
  ).rejects.toMatchObject({ fields: { usualSessions: "Sesiones habituales: un número entero entre 1 y 60" } })
})

it("al indicarlo, el plan nace con las sesiones habituales de su servicio; lo indicado se puede cambiar", async () => {
  const f = await clinicalFixture()
  const { service } = await libraryService(f, 2)
  const inherited = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  expect(inherited.plannedSessions).toBe(2)
  const told = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: 3 }),
  )
  expect(told.plannedSessions).toBe(3)
  const own = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  expect(own.plannedSessions).toBe(1)
  // Cambiar el servicio no reescribe lo ya indicado.
  await f.run((tx) => updateService(tx, "org_a", f.actor, service.id, { usualSessions: 4 }))
  const [kept] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, inherited.id))
  expect(kept!.plannedSessions).toBe(2)
})

it("varias piezas a la vez también nacen con las sesiones habituales", async () => {
  const f = await clinicalFixture()
  const { service } = await libraryService(f, 3, "tooth")
  const rows = await f.run((tx) =>
    addPlanItemsBatch(tx, ...f.args, { serviceId: service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, toothNumbers: [11, 21] }),
  )
  expect(rows.map((row) => row.plannedSessions)).toEqual([3, 3])
})

it("una endodoncia de dos sesiones no se termina en su primera firma (ADR 0161)", async () => {
  const f = await clinicalFixture()
  const { service } = await libraryService(f, 2)
  const endo = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  await ownerDb.update(treatmentPlanItem).set({ decisionStatus: "aceptado" }).where(eq(treatmentPlanItem.id, endo.id))
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: endo.id }))
  expect((await f.run((tx) => getEncounterClosing(tx, ...f.args, f.encounter.id))).sessions).toMatchObject({
    finishing: [],
    continuing: [{ planItemId: endo.id, n: 1, m: 2 }],
  })
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const [after] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, endo.id))
  expect(after).toMatchObject({ status: "en_curso", plannedSessions: 2 })
})

it("«Falta otra sesión» desde el Plan: lo que se terminó al llegar a sus previstas vuelve a en curso con una más, sin cobrar de nuevo", async () => {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  await ownerDb.update(treatmentPlanItem).set({ decisionStatus: "aceptado" }).where(eq(treatmentPlanItem.id, item.id))
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  // Firmar sin tocar «¿Terminaste?» lo termina (ADR 0161).
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const charges = async () => (await ownerDb.select().from(patientCharge).where(eq(patientCharge.planItemId, item.id))).length
  const before = await charges()
  expect(before).toBe(1)
  const reopened = await f.run((tx) => reopenPlanItemForSession(tx, ...f.args, item.id))
  expect(reopened).toMatchObject({ status: "en_curso", plannedSessions: 2, sessionsDone: 1, completedAt: null })
  expect(await charges()).toBe(before)
  await expect(f.run((tx) => reopenPlanItemForSession(tx, ...f.args, item.id))).rejects.toMatchObject({ code: "ITEM_NOT_DONE" })
})

it("lo que se terminó antes de sus previstas no se reabre: se terminó a propósito", async () => {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: 3 }),
  )
  await ownerDb.update(treatmentPlanItem).set({ decisionStatus: "aceptado" }).where(eq(treatmentPlanItem.id, item.id))
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  await f.run((tx) => setPlanItemStatus(tx, ...f.args, item.id, { status: "realizado", encounterId: f.encounter.id }))
  await expect(f.run((tx) => reopenPlanItemForSession(tx, ...f.args, item.id))).rejects.toMatchObject({
    code: "ITEM_FINISHED_EARLY",
    message: "Se terminó antes de sus 3 sesiones previstas: si necesita más, indícalo de nuevo",
  })
})

it("un servicio directo de varias sesiones habituales queda en curso; uno de una sesión, realizado", async () => {
  const f = await clinicalFixture()
  const { service } = await libraryService(f, 2)
  const other = await clinicalFixture()
  const multi = await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: service.id }))
  const single = await other.run((tx) => addEncounterProcedure(tx, ...other.args, other.encounter.id, { serviceId: other.service.id }))
  const itemOf = async (id: string | null) => (await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, id!)))[0]!
  expect(await itemOf(multi.planItemId)).toMatchObject({ status: "en_curso", decisionStatus: "aceptado", plannedSessions: 2, completedAt: null })
  expect(await itemOf(single.planItemId)).toMatchObject({ status: "realizado", plannedSessions: 1 })
})

it("la biblioteca sembrada trae las sesiones habituales: una corona nace con 2, una endodoncia con 1, y el paquete prenatal de latidIA con 8", async () => {
  await seedCatalog(ownerDb)
  const usual = async (key: string) =>
    (await ownerDb.select({ n: treatmentTemplate.usualSessions }).from(treatmentTemplate).where(eq(treatmentTemplate.key, key)))[0]?.n
  expect(await usual("corona-de-porcelana")).toBe(2)
  expect(await usual("endodoncia-posterior-vital")).toBe(1)
  expect(await usual("control-prenatal-7-o-mas")).toBe(8)
  const f = await clinicalFixture()
  await f.run((tx) => ensureClinicSpecialties(tx, "org_a"))
  const [crown] = await ownerDb
    .select({ id: treatmentTemplate.id })
    .from(treatmentTemplate)
    .where(and(eq(treatmentTemplate.key, "corona-de-porcelana"), eq(treatmentTemplate.isActive, true)))
  const added = await f.run((tx) => fromTemplates(tx, "org_a", f.actor, [{ templateId: crown!.id, priceCents: 90_000 }]))
  const service = [...added.created, ...added.existing][0]!
  expect(service).toMatchObject({ usualSessions: 2, ownUsualSessions: null })
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, toothNumber: 46 }),
  )
  expect(item.plannedSessions).toBe(2)
})

it("cambiar de servicio lo que aún no empieza toma las sesiones del servicio nuevo", async () => {
  const f = await clinicalFixture()
  const { service: two } = await libraryService(f, 2)
  const { service: four } = await libraryService(f, 4)
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: two.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const changed = await f.run((tx) => updatePlanItem(tx, ...f.args, item.id, { serviceId: four.id, encounterId: f.encounter.id }))
  expect(changed.plannedSessions).toBe(4)
})
