import { randomUUID } from "node:crypto"
import { branch } from "@odentia/db/schema/org"
import { sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  addEncounterProcedure,
  createEncounter,
  finalizeEncounter,
} from "./encounters.js"
import { createPaymentMethod } from "./payment-methods.js"
import { collectCharge, createCharge, getAccountSummary } from "./payments.js"
import { addPlanItem } from "./plan.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()

interface AttendCtx {
  run: <T>(fn: (tx: typeof appDb) => Promise<T>) => Promise<T>
  ready: (encounterId: string) => Promise<void>
  args: readonly [string, string, string]
  patient: { id: string }
}

/** Marca el servicio del fixture como `session` (precio por visita). */
async function sessionFixture(plannedSessions: number, priceCents = 15000) {
  const f = await clinicalFixture()
  await f.run((tx) =>
    tx.execute(
      sql`update "service_catalog" set "price_cents" = ${priceCents}, "billing_mode" = 'session' where "id" = ${f.service.id}`,
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
  expect(budget.items.find((l) => l.planItemId === item.id)?.billingMode).toBe("session")
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  return { f, item, lineId: budget.items.find((l) => l.planItemId === item.id)!.id }
}

async function attendOnce(
  f: AttendCtx,
  itemId: string,
  encounterId?: string,
  answer: Parameters<typeof finalizeEncounter>[5] = {},
) {
  const encounter = encounterId
    ? { id: encounterId }
    : await f.run((tx) => createEncounter(tx, ...f.args, { reason: "Control" }))
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, encounter.id, { planItemId: itemId }),
  )
  await f.ready(encounter.id)
  return f.run((tx) => finalizeEncounter(tx, ...f.args, encounter.id, answer))
}

it("por sesión genera un cargo por visita sin duplicar y con tope", async () => {
  const { f, item } = await sessionFixture(3, 15000)
  const first = await attendOnce(f, item.id, f.encounter.id)
  expect(first.charges).toHaveLength(1)
  expect(first.charges[0]?.amountCents).toBe(15000)
  expect(first.billing.chargedCents).toBe(15000)
  expect(first.billing.lines).toMatchObject([{ status: "charged", amountCents: 15000 }])
  const second = await attendOnce(f, item.id)
  expect(second.charges).toHaveLength(1)
  expect(second.charges[0]?.amountCents).toBe(15000)
  // En la tercera llega a sus previstas: «Falta otra sesión» la deja abierta.
  const third = await attendOnce(f, item.id, undefined, { addSessionPlanItemIds: [item.id] })
  expect(third.charges).toHaveLength(1)
  // Cuarta visita: tope de las sesiones del presupuesto, sin cargo duplicado.
  const fourth = await attendOnce(f, item.id)
  expect(fourth.charges).toHaveLength(0)
  expect(fourth.skippedCharges).toMatchObject([{ reason: "sessions_complete" }])
  expect(fourth.billing.lines).toMatchObject([{ status: "skipped", reason: "sessions_complete" }])
})

it("el cierre describe lo cobrado y lo no cobrable", async () => {
  const { f, item } = await sessionFixture(2, 15000)
  // Acto libre sin servicio: registrado pero nunca cargo.
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, {
      description: "Control de oclusión",
    }),
  )
  await f.run((tx) =>
    addEncounterProcedure(tx, ...f.args, f.encounter.id, { planItemId: item.id }),
  )
  await f.ready(f.encounter.id)
  const result = await f.run((tx) =>
    finalizeEncounter(tx, ...f.args, f.encounter.id),
  )
  expect(result.charges).toHaveLength(1)
  expect(result.skippedCharges).toMatchObject([{ reason: "free_act" }])
  expect(result.billing.lines).toHaveLength(2)
})

it("lo que se cobra por sesión no se carga desde el presupuesto antes de la visita: la visita se debe una sola vez", async () => {
  const { f, item, lineId } = await sessionFixture(3, 15000)
  // Un cargo de la línea antes de la visita: firmarla volvía a cargar la misma sesión.
  const early = await f.run((tx) => createCharge(tx, ...f.args, { budgetItemId: lineId })).catch((error: unknown) => error)
  // Lo que la persona paga antes queda como adelanto, a favor.
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}` }).returning()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId: site!.id,
      advanceCents: 15000,
      payments: [{ paymentMethodId: cash.id, amountCents: 15000 }],
      requestId: randomUUID(),
    }),
  )
  const first = await attendOnce(f, item.id, f.encounter.id)
  expect(first.charges.map((charge) => charge.amountCents)).toEqual([15000])
  // Se debe la sesión una vez, y el adelanto la cubre.
  const account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(account.byCurrency.find((row) => row.currency === "PEN")).toMatchObject({ porCobrar: 15000, aFavor: 15000, saldo: 0 })
  expect(early).toMatchObject({ code: "CHARGED_PER_VISIT", status: 409 })
})
