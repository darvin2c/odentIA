/**
 * «Reservar la sesión 2» con quien la empezó (mesa del 17 nov, hallazgo 3 de la clínica): desde la
 * ficha («Qué sigue») solo se ofrecía a quien atiende la especialidad del servicio, y en la sede que
 * se miraba en la Agenda. El botón lleva quién hizo la sesión anterior y la sede de esa atención,
 * para proponerlos primero; la reserva deja elegir a otro.
 */
import { randomUUID } from "node:crypto"
import { user } from "@odentia/db/schema/auth"
import { encounter } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, finalizeEncounter } from "./encounters.js"
import { lastSessionOf } from "./last-session.js"
import { addPlanItem } from "./plan.js"
import { getPlanNextStep, planNextStepsOf } from "./plan-next.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const all = () => true
type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

/** Un tratamiento de dos sesiones, aceptado en su presupuesto. */
async function accepted(f: Fixture) {
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
      plannedSessions: 2,
    }),
  )
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  return item
}

it("la sesión siguiente se propone con quien hizo la anterior y en la sede de esa atención", async () => {
  const f = await clinicalFixture()
  const item = await accepted(f)
  // La sesión 1, en Miraflores: otra sede que la primera de la clínica.
  const [miraflores] = await ownerDb
    .insert(branch)
    .values({
      organizationId: "org_a",
      name: `Sede Miraflores ${randomUUID().slice(0, 6)}`,
      timezone: "America/Lima",
    })
    .returning()
  await ownerDb
    .update(encounter)
    .set({ branchId: miraflores!.id })
    .where(eq(encounter.id, f.encounter.id))
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))

  const next = await f.run((tx) => getPlanNextStep(tx, "org_a", f.patient.id, all))
  expect(next).toMatchObject({
    kind: "continuar",
    action: {
      label: "Reservar la sesión 2",
      planItemIds: [item.id],
      professionalUserId: f.actor,
      professionalName: "Clínico",
      branchId: miraflores!.id,
    },
  })
  // La lista de Pacientes dice lo mismo que la ficha.
  expect(
    (await f.run((tx) => planNextStepsOf(tx, "org_a", [f.patient.id], all))).get(f.patient.id),
  ).toEqual(next)
})

it("quien ya no está en la clínica no se propone, y una sede cerrada tampoco", async () => {
  const f = await clinicalFixture()
  const item = await accepted(f)
  const [closed] = await ownerDb
    .insert(branch)
    .values({
      organizationId: "org_a",
      name: `Sede cerrada ${randomUUID().slice(0, 6)}`,
      timezone: "America/Lima",
      isActive: false,
    })
    .returning()
  await ownerDb
    .update(encounter)
    .set({ branchId: closed!.id })
    .where(eq(encounter.id, f.encounter.id))
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  expect((await f.run((tx) => lastSessionOf(tx, "org_a", [item.id]))).get(item.id)).toEqual({
    professionalUserId: f.actor,
    professionalName: "Clínico",
    branchId: null,
  })
  // La sesión la hizo una colega que ya no es de la clínica.
  const colleague = randomUUID()
  await ownerDb
    .insert(user)
    .values({ id: colleague, name: "Colega", email: `${colleague}@example.test` })
  await ownerDb
    .update(encounter)
    .set({ professionalUserId: colleague })
    .where(eq(encounter.id, f.encounter.id))
  expect((await f.run((tx) => lastSessionOf(tx, "org_a", [item.id]))).has(item.id)).toBe(false)
})

it("si quien hizo la última sesión ya no está, no se propone a quien hizo una anterior", async () => {
  const f = await clinicalFixture()
  const item = await accepted(f)
  // La sesión 1 la hizo quien sigue en la clínica, y se firmó.
  await f.ready(f.encounter.id)
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }))
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  // La sesión 2, otra atención, la hizo una colega que ya salió de la clínica.
  const [second] = await ownerDb
    .insert(encounter)
    .values({ organizationId: "org_a", patientId: f.patient.id, professionalUserId: f.actor })
    .returning({ id: encounter.id })
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, second!.id, { planItemId: item.id }))
  const colleague = randomUUID()
  await ownerDb
    .insert(user)
    .values({ id: colleague, name: "Dra. Paz", email: `${colleague}@example.test` })
  await ownerDb
    .update(encounter)
    .set({ professionalUserId: colleague })
    .where(eq(encounter.id, second!.id))
  expect((await f.run((tx) => lastSessionOf(tx, "org_a", [item.id]))).has(item.id)).toBe(false)
})
