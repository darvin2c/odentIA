/**
 * Finanzas comportamental: caja de un solo turno por sede/moneda, cada cobro
 * entra una sola vez, el arqueo cuenta solo efectivo, las cuotas se
 * actualizan solas al aplicar/anular y una fuente no se comisiona dos veces.
 * (Escrito sin ejecutar: lo corre la verificación conjunta del padre.)
 */
import { randomUUID } from "node:crypto"
import { member } from "@odentia/db/schema/auth"
import { branch } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  closeShift,
  createInstallmentPlan,
  getShiftDetail,
  listInstallmentPlans,
  openShift,
  registerPaymentInShift,
  settleCommissions,
  upsertCommissionRule,
} from "./finance.js"
import { applyPayment, createCharge, createPayment, voidPaymentApplication } from "./payments.js"
import { ownerDb } from "./test-setup.js"
import { setupTestDb } from "./test-setup.js"
setupTestDb()

async function seedBranch(): Promise<string> {
  const [row] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede caja ${randomUUID()}` })
    .returning()
  return row.id
}

it("caja integra cada cobro una sola vez y el arqueo cuenta solo efectivo", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const shift = await f.run((tx) =>
    openShift(tx, "org_a", f.actor, { branchId, currency: "PEN", openingCents: 50000 }),
  )
  await expect(
    f.run((tx) => openShift(tx, "org_a", f.actor, { branchId, currency: "PEN" })),
  ).rejects.toMatchObject({ code: "SHIFT_ALREADY_OPEN" })

  const charge = await f.run((tx) =>
    createCharge(tx, ...f.args, {
      description: "Obturación caja",
      amountCents: 30000,
      currency: "PEN",
    }),
  )
  const cash = await f.run((tx) =>
    createPayment(tx, ...f.args, {
      amountCents: 30000,
      currency: "PEN",
      paidAt: "2026-02-10T12:00:00Z",
      method: "efectivo",
      shiftId: shift.id,
    }),
  )
  await expect(
    f.run((tx) => registerPaymentInShift(tx, "org_a", f.actor, shift.id, cash.id)),
  ).rejects.toMatchObject({ code: "PAYMENT_ALREADY_IN_SHIFT" })

  await f.run((tx) =>
    createPayment(tx, ...f.args, {
      amountCents: 10000,
      currency: "PEN",
      paidAt: "2026-02-10T13:00:00Z",
      method: "transferencia",
      shiftId: shift.id,
    }),
  )
  const detail = await f.run((tx) => getShiftDetail(tx, "org_a", shift.id))
  expect(detail.esperadoCents).toBe(80000)
  expect(detail.electronicosCents).toBe(10000)

  const closed = await f.run((tx) =>
    closeShift(tx, "org_a", f.actor, shift.id, { countedCents: 80000 }),
  )
  expect(closed.differenceCents).toBe(0)
  const replay = await f.run((tx) =>
    closeShift(tx, "org_a", f.actor, shift.id, { countedCents: 0 }),
  )
  expect(replay.id).toBe(shift.id)
  expect(replay.status).toBe("cerrada")
  expect(replay.countedCents).toBe(80000)
  void charge
})

it("las cuotas se actualizan solas y una fuente no se comisiona dos veces", async () => {
  const f = await clinicalFixture()
  // Fechas relativas a hoy: el periodo siempre contiene la aplicación y el
  // primer vencimiento siempre es futuro (pendiente estable tras anular).
  const day = (offset: number): string =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const from = day(-60)
  const to = day(60)
  const firstDueAt = day(30)
  const charge = await f.run((tx) =>
    createCharge(tx, ...f.args, {
      description: "Corona cuotas",
      amountCents: 30000,
      currency: "PEN",
    }),
  )
  await f.run((tx) =>
    createInstallmentPlan(tx, ...f.args, {
      chargeId: charge.id,
      installments: 3,
      firstDueAt,
    }),
  )
  const payment = await f.run((tx) =>
    createPayment(tx, ...f.args, {
      amountCents: 10000,
      currency: "PEN",
      paidAt: "2026-03-05T12:00:00Z",
      method: "efectivo",
    }),
  )
  const application = await f.run((tx) =>
    applyPayment(tx, ...f.args, payment.id, { chargeId: charge.id, amountCents: 10000 }),
  )
  const advanced = await f.run((tx) => listInstallmentPlans(tx, "org_a", { patientId: f.patient.id }))
  const quotas = advanced.find((p) => p.plan.chargeId === charge.id)?.quotas ?? []
  expect(quotas[0]?.status).toBe("pagada")
  await f.run((tx) => voidPaymentApplication(tx, ...f.args, application.id, { reason: "Prueba" }))
  const reverted = await f.run((tx) => listInstallmentPlans(tx, "org_a", { patientId: f.patient.id }))
  expect(reverted.find((p) => p.plan.chargeId === charge.id)?.quotas[0]?.status).toBe("pendiente")

  await ownerDb.insert(member).values({
    id: randomUUID(),
    organizationId: "org_a",
    userId: f.actor,
    role: "dentist",
    createdAt: new Date(),
  })
  await f.run((tx) =>
    upsertCommissionRule(tx, "org_a", f.actor, {
      professionalUserId: f.actor,
      base: "cobrado",
      rateBps: 1000,
    }),
  )
  await f.run((tx) =>
    applyPayment(tx, ...f.args, payment.id, { chargeId: charge.id, amountCents: 10000 }),
  )
  const settled = await f.run((tx) =>
    settleCommissions(tx, "org_a", f.actor, {
      professionalUserId: f.actor,
      base: "cobrado",
      from,
      to,
      currency: "PEN",
    }),
  )
  expect(settled.commissionCents).toBe(1000)
  await expect(
    f.run((tx) =>
      settleCommissions(tx, "org_a", f.actor, {
        professionalUserId: f.actor,
        base: "cobrado",
        from,
        to,
        currency: "PEN",
      }),
    ),
  ).rejects.toMatchObject({ code: "SETTLEMENT_EMPTY" })
})
