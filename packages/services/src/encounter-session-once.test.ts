import { randomUUID } from "node:crypto"
import { appointment } from "@odentia/db/schema/agenda"
import { appointmentPlanItem, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createRoom } from "./appointments.js"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addEncounterProcedure, finalizeEncounter, voidEncounterProcedure } from "./encounters.js"
import { addPlanItem } from "./plan.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Un tratamiento del plan lleva como mucho una sesión vigente por atención (mesa
 * del 17 nov): con el cobro por sesión, dos pestañas cargaban dos sesiones en una
 * sola visita. Y anular la única sesión lo devuelve a por empezar, no a
 * «programado» sin una cita que lo lleve.
 */
setupTestDb()

/** Una endodoncia aceptada en su presupuesto, cobrada por sesión. */
async function acceptedBySession(plannedSessions: number) {
  const f = await clinicalFixture()
  await f.run((tx) =>
    tx.execute(
      sql`update "service_catalog" set "price_cents" = 15000, "billing_mode" = 'session' where "id" = ${f.service.id}`,
    ),
  )
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, {
      serviceId: f.service.id,
      planId: f.plan.id,
      sourceEncounterId: f.encounter.id,
      plannedSessions,
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
  return { f, item }
}

async function itemOf(id: string) {
  const [row] = await ownerDb.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, id))
  return row!
}

it("la segunda sesión del mismo tratamiento en la misma atención se rechaza, también por el servicio, y anulada se puede volver a registrar", async () => {
  const { f, item } = await acceptedBySession(3)
  const first = await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }),
  )
  await expect(
    f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id })),
  ).rejects.toMatchObject({ code: "SESSION_REGISTERED", status: 409 })
  // «Registrar algo fuera del plan» con el mismo servicio ejecuta ese tratamiento: tampoco suma otra.
  await expect(
    f.run((tx) =>
      addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: f.service.id }),
    ),
  ).rejects.toMatchObject({ code: "SESSION_REGISTERED", status: 409 })
  // Lo anulado no cuenta: se corrige y se registra bien.
  await f.run((tx) =>
    voidEncounterProcedure(tx, ...f.args, f.encounter.id, first.id, { reason: "Era otra pieza" }),
  )
  await expect(
    f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id })),
  ).resolves.toMatchObject({ planItemId: item.id, voidedAt: null })
})

it("dos pedidos a la vez registran una sola sesión, y al firmar se cobra una vez", async () => {
  const { f, item } = await acceptedBySession(3)
  // El primero inserta y tarda en confirmar; el segundo llega mientras tanto.
  let inserted!: () => void
  const firstInserted = new Promise<void>((resolve) => {
    inserted = resolve
  })
  const first = f.run(async (tx) => {
    const row = await addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id })
    inserted()
    await new Promise((resolve) => setTimeout(resolve, 300))
    return row
  })
  await firstInserted
  const second = f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }),
  )
  const [a, b] = await Promise.allSettled([first, second])
  expect(a.status).toBe("fulfilled")
  expect(b).toMatchObject({
    status: "rejected",
    reason: { code: "SESSION_REGISTERED", status: 409 },
  })
  const [{ n }] = await ownerDb.execute<{ n: number }>(
    sql`select count(*)::int as n from encounter_procedure where encounter_id = ${f.encounter.id} and plan_item_id = ${item.id} and voided_at is null`,
  )
  expect(n).toBe(1)
  await f.ready(f.encounter.id)
  const closed = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(closed.charges.map((charge) => charge.amountCents)).toEqual([15000])
})

it("anular la única sesión lo devuelve a por empezar; con una cita por venir que lo lleva, a programado", async () => {
  const { f, item } = await acceptedBySession(2)
  expect((await itemOf(item.id)).status).toBe("pendiente")
  const session = await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }),
  )
  expect((await itemOf(item.id)).status).toBe("en_curso")
  await f.run((tx) =>
    voidEncounterProcedure(tx, ...f.args, f.encounter.id, session.id, { reason: "Era otra pieza" }),
  )
  expect(await itemOf(item.id)).toMatchObject({
    status: "pendiente",
    startedAt: null,
    completedAt: null,
  })

  // Con su cita de mañana reservada, sí está programado.
  const [site] = await ownerDb
    .insert(branch)
    .values({
      organizationId: "org_a",
      name: `Sede ${randomUUID().slice(0, 6)}`,
      timezone: "America/Lima",
    })
    .returning()
  const room = await f.run((tx) =>
    createRoom(tx, "org_a", { branchId: site!.id, name: "Unidad dental" }),
  )
  const startsAt = new Date(Date.now() + 24 * 3_600_000)
  const [booked] = await ownerDb
    .insert(appointment)
    .values({
      organizationId: "org_a",
      branchId: site!.id,
      patientId: f.patient.id,
      professionalUserId: f.actor,
      roomId: room.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      durationMin: 30,
      status: "programada",
    })
    .returning({ id: appointment.id })
  await ownerDb
    .insert(appointmentPlanItem)
    .values({
      organizationId: "org_a",
      patientId: f.patient.id,
      appointmentId: booked!.id,
      planItemId: item.id,
    })
  const again = await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }),
  )
  await f.run((tx) =>
    voidEncounterProcedure(tx, ...f.args, f.encounter.id, again.id, {
      reason: "Se hace en su cita",
    }),
  )
  expect((await itemOf(item.id)).status).toBe("programado")
})
