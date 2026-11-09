/**
 * En qué sesión quedó un tratamiento con cada atención (tercer repaso del 9 nov,
 * E8 y E12): la Historia dice «sesión 2 de 2 · tratamiento terminado» sin abrir
 * la tarjeta, y una sesión de un tratamiento en curso nunca se lee «Realizado».
 */
import { encounter } from "@odentia/db/schema/clinical"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, finalizeEncounter } from "./encounters.js"
import { getTimeline } from "./patient-history.js"
import { addPlanItem } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { encounterSessionKey, encounterSessionsOf } from "./to-schedule.js"

setupTestDb()

it("la sesión 1 de 2 sigue en curso y la 2 de 2 lo termina, en la Historia y en la regla", async () => {
  const f = await clinicalFixture()
  const endo = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id, plannedSessions: 2 }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [endo.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: endo.id, decision: "aceptado" }] }))

  // Sesión 1, firmada: el tratamiento sigue en curso.
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: endo.id }))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  const first = await f.run((tx) => encounterSessionsOf(tx, "org_a", [f.encounter.id]))
  expect(first.get(encounterSessionKey(f.encounter.id, endo.id))).toMatchObject({ n: 1, m: 2, finished: false })

  // Sesión 2, firmada sin «Falta otra sesión»: lo termina.
  const [second] = await ownerDb
    .insert(encounter)
    .values({ organizationId: "org_a", patientId: f.patient.id, professionalUserId: f.actor, reason: "Sesión 2" })
    .returning({ id: encounter.id })
  await f.ready(second!.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, second!.id, { planItemId: endo.id }))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, second!.id))
  const both = await f.run((tx) => encounterSessionsOf(tx, "org_a", [f.encounter.id, second!.id]))
  expect(both.get(encounterSessionKey(f.encounter.id, endo.id))).toMatchObject({ n: 1, m: 2, finished: false })
  expect(both.get(encounterSessionKey(second!.id, endo.id))).toMatchObject({ n: 2, m: 2, finished: true })

  // La tarjeta plegada lo dice sin abrirla.
  const timeline = await f.run((tx) => getTimeline(tx, "org_a", f.patient.id, { types: ["encounter"] }))
  const card = (id: string) => timeline.data.find((row) => row.refId === id)
  expect(card(f.encounter.id)?.procedures?.[0]).toMatch(/sesión 1 de 2$/)
  expect(card(second!.id)?.procedures?.[0]).toMatch(/sesión 2 de 2 · tratamiento terminado$/)
})
