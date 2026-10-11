/**
 * Comisiones simples y resultado del mes (Fases 6 y 8): tasa única por
 * profesional sobre lo cobrado de lo que atendió (los conceptos sin atención
 * no comisionan), neto de devoluciones del saldo a favor y de anulaciones, el
 * pago registra un gasto de Personal exactamente una vez, y el resultado del
 * mes concilia cobrado, devoluciones, gastos y deuda.
 * (Escrito sin ejecutar: lo corre la verificación conjunta del integrador.)
 */
import { randomUUID } from "node:crypto"
import { member } from "@odentia/db/schema/auth"
import { encounter, encounterProcedure } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  getMonthlyCommissions,
  getMonthlyFinanceResult,
  listExpenses,
  payCommissionSettlement,
  setCommissionRate,
  settleMonthCommissions,
  voidCommissionSettlement,
} from "./finance.js"
import { collectCharge, createCharge, refundCredit, voidTicket } from "./payments.js"
import { createPromotion } from "./promotions.js"
import { createPaymentMethod } from "./payment-methods.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()

async function seedBranch(): Promise<string> {
  const [row] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede comisiones ${randomUUID()}` })
    .returning()
  return row.id
}

function currentPeriod(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date())
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get("year"), month: get("month") }
}

it("comisiones simples: tasa única sobre cobrado con atención y pago único como Personal", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(member).values({
    id: randomUUID(),
    organizationId: "org_a",
    userId: f.actor,
    role: "dentist",
    createdAt: new Date(),
  })
  const branchId = await seedBranch()
  const cash = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }),
  )
  const wallet = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Yape", typeCode: "68" }),
  )
  // Acto atendido por el profesional en una atención finalizada.
  const [procedure] = await ownerDb
    .insert(encounterProcedure)
    .values({
      organizationId: "org_a",
      encounterId: f.encounter.id,
      serviceId: f.service.id,
      description: "Endodoncia cobrada",
      priceCents: 30000,
      currency: "PEN",
      createdBy: f.actor,
    })
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  const charge = await f.run((tx) =>
    createCharge(tx, ...f.args, { encounterProcedureId: procedure.id }),
  )
  expect(charge.amountCents).toBe(30000)
  // Concepto manual sin atención: se cobra pero no comisiona a nadie.
  const manual = await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Cepillo", amountCents: 10000, currency: "PEN" }),
  )
  // Cobro del tratamiento + cobro del concepto manual (sin crédito previo que
  // interfiera: el saldo a favor se aplica solo y primero).
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [charge.id],
      payments: [{ paymentMethodId: cash.id, amountCents: 10000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [manual.id],
      payments: [{ paymentMethodId: wallet.id, amountCents: 10000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 1000 }),
  )
  const period = currentPeriod()
  const monthly = await f.run((tx) =>
    getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...period, currency: "PEN" }),
  )
  expect(monthly.lines).toHaveLength(1)
  expect(monthly.baseCents).toBe(10000)
  expect(monthly.commissionCents).toBe(1000)
  // Adelanto a favor y su devolución parcial: no reducen la base comisionable.
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 5000,
      payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    refundCredit(tx, "org_a", f.actor, f.patient.id, {
      branchId,
      amountCents: 4000,
      reason: "Prueba",
    }),
  )
  const net = await f.run((tx) =>
    getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...period, currency: "PEN" }),
  )
  expect(net.baseCents).toBe(10000)
  expect(net.commissionCents).toBe(1000)
  // Anular un cobro lo saca del mes: la fuente anulada no comisiona.
  const extra = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [charge.id],
      payments: [{ paymentMethodId: cash.id, amountCents: 6000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    voidTicket(tx, "org_a", f.actor, f.patient.id, extra.ticket.id, {
      reason: "Prueba",
      allowPostClose: false,
    }),
  )
  const afterVoid = await f.run((tx) =>
    getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...period, currency: "PEN" }),
  )
  expect(afterVoid.baseCents).toBe(10000)
  const settled = await f.run((tx) =>
    settleMonthCommissions(tx, "org_a", f.actor, {
      professionalUserId: f.actor,
      ...period,
      currency: "PEN",
    }),
  )
  expect(settled.commissionCents).toBe(1000)
  expect(settled.base).toBe("cobrado")
  expect(settled.rateBps).toBe(1000)
  await expect(
    f.run((tx) =>
      settleMonthCommissions(tx, "org_a", f.actor, {
        professionalUserId: f.actor,
        ...period,
        currency: "PEN",
      }),
    ),
  ).rejects.toMatchObject({ code: "SETTLEMENT_EXISTS" })
  const paid = await f.run((tx) =>
    payCommissionSettlement(tx, "org_a", f.actor, { settlementId: settled.id, branchId }),
  )
  expect(paid.expense.category).toBe("Personal")
  expect(paid.expense.amountCents).toBe(1000)
  await expect(
    f.run((tx) =>
      payCommissionSettlement(tx, "org_a", f.actor, { settlementId: settled.id, branchId }),
    ),
  ).rejects.toMatchObject({ code: "SETTLEMENT_ALREADY_PAID" })
  // Anular libera las fuentes y anula el gasto en la misma transacción.
  await f.run((tx) => voidCommissionSettlement(tx, "org_a", f.actor, settled.id, { reason: "Prueba" }))
  const expenses = await f.run((tx) => listExpenses(tx, "org_a", { branchId, limit: 200 }))
  expect(expenses.find((e) => e.id === paid.expense.id)).toBeUndefined()
  const resettled = await f.run((tx) =>
    settleMonthCommissions(tx, "org_a", f.actor, {
      professionalUserId: f.actor,
      ...period,
      currency: "PEN",
    }),
  )
  expect(resettled.commissionCents).toBe(1000)
})

it("resultado del mes concilia cobrado, gastos y deuda sin aportes como ingreso", async () => {
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  await ownerDb.update(encounter).set({ branchId }).where(eq(encounter.id, f.encounter.id))
  const cash = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }),
  )
  const [procedure] = await ownerDb
    .insert(encounterProcedure)
    .values({
      organizationId: "org_a",
      encounterId: f.encounter.id,
      serviceId: f.service.id,
      description: "Profilaxis del mes",
      priceCents: 20000,
      currency: "PEN",
      createdBy: f.actor,
    })
    .returning()
  const charge = await f.run((tx) =>
    createCharge(tx, ...f.args, { encounterProcedureId: procedure.id }),
  )
  // Promoción con precio fijo sobre el mismo servicio: el cargo hereda el
  // snapshot y el desglose la cuenta aunque el filtro de atención no aplique.
  const promo = await f.run((tx) =>
    createPromotion(tx, "org_a", f.actor, {
      name: "Limpieza promo",
      startsAt: new Date(Date.now() - 86_400_000).toISOString(),
      items: [{ serviceId: f.service.id, mode: "fixed", priceCents: 7900 }],
    }),
  )
  const [promoProcedure] = await ownerDb
    .insert(encounterProcedure)
    .values({
      organizationId: "org_a",
      encounterId: f.encounter.id,
      serviceId: f.service.id,
      description: "Profilaxis con promo",
      priceCents: 7900,
      currency: "PEN",
      createdBy: f.actor,
    })
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  const promoCharge = await f.run((tx) =>
    createCharge(tx, ...f.args, { encounterProcedureId: promoProcedure.id, promotionId: promo.id }),
  )
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [charge.id],
      payments: [{ paymentMethodId: cash.id, amountCents: 12000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [promoCharge.id],
      payments: [{ paymentMethodId: cash.id, amountCents: 7900 }],
      requestId: randomUUID(),
    }),
  )
  const period = currentPeriod()
  const result = await f.run((tx) => getMonthlyFinanceResult(tx, "org_a", { ...period, branchId }))
  const pen = result.byCurrency.find((b) => b.currency === "PEN")
  expect(pen?.cobradoCents).toBe(19900)
  expect(pen?.netoCents).toBe(19900)
  expect(pen?.gastadoCents).toBe(0)
  expect(pen?.quedaCents).toBe(19900)
  expect(result.byProfessional).toContainEqual({
    professionalUserId: f.actor,
    name: expect.anything(),
    currency: "PEN",
    cobradoCents: 19900,
  })
  expect(result.byPromotion).toContainEqual({
    promotionId: promo.id,
    name: "Limpieza promo",
    currency: "PEN",
    veces: 1,
    cobradoCents: 7900,
  })
  expect(result.outstanding).toContainEqual({ currency: "PEN", pendienteCents: 8000, pacientes: 1 })
})
