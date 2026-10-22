/**
 * Comisiones simples y resultado del mes (Fases 6 y 8): tasa única por
 * profesional sobre lo cobrado de lo que atendió (los conceptos sin atención
 * no comisionan), neto de devoluciones del saldo a favor y de anulaciones, el
 * pago registra un gasto de Personal exactamente una vez, y el resultado del
 * mes concilia cobrado, devoluciones, gastos y deuda.
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
  listExpenses,
  listMonthCommissions,
  payMonthCommission,
  setCommissionRate,
  voidCommissionSettlement,
  voidExpense,
} from "./finance.js"
import { collectCharge, createCharge, refundCredit, voidTicket } from "./payments.js"
import { createPromotion } from "./promotions.js"
import { getReportFinance, getReportPromotions } from "./report-finance.js"
import { getReportProfessionals } from "./report-summary.js"
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

it("comisiones: porcentaje sobre lo cobrado de lo atendido, pago en un paso y ajuste de lo anulado", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(member).values({
    id: randomUUID(),
    organizationId: "org_a",
    userId: f.actor,
    role: "clinician",
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
  const pay = () =>
    f.run((tx) =>
      payMonthCommission(tx, "org_a", f.actor, { professionalUserId: f.actor, ...period, branchId }),
    )
  const view = () =>
    f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...period }))
  const collectMore = (amountCents: number) =>
    f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId,
        chargeIds: [charge.id],
        payments: [{ paymentMethodId: cash.id, amountCents }],
        requestId: randomUUID(),
      }),
    )

  // Si el importe ya no es el que se mostró, no se paga otra cifra.
  await expect(
    f.run((tx) =>
      payMonthCommission(tx, "org_a", f.actor, {
        professionalUserId: f.actor,
        ...period,
        branchId,
        expectedCents: 1,
      }),
    ),
  ).rejects.toMatchObject({ code: "COMMISSION_AMOUNT_CHANGED" })

  // Un solo paso: registra el pago, congela los cobros y deja el gasto de Personal.
  const first = await pay()
  expect(first.settlement.commissionCents).toBe(1000)
  expect(first.settlement.rateBps).toBe(1000)
  expect(first.expense).toMatchObject({ category: "Personal", amountCents: 1000, currency: "PEN" })
  expect(await view()).toMatchObject({ paidCents: 1000, pendingCents: 0, status: "pagado" })
  // Repetir no duplica el gasto: ya no queda nada por pagar.
  await expect(pay()).rejects.toMatchObject({ code: "COMMISSION_NOTHING_TO_PAY" })

  // Haber pagado a mitad de mes no bloquea lo que se cobre después. Este cobro
  // usa además los 1 000 que quedaban a favor: se cobran 6 000 del tratamiento.
  const later = await collectMore(5000)
  expect(later.creditAppliedCents).toBe(1000)
  expect(await view()).toMatchObject({ commissionCents: 1600, paidCents: 1000, pendingCents: 600, status: "por_pagar" })
  const second = await pay()
  expect(second.expense.amountCents).toBe(600)
  expect(await view()).toMatchObject({ paidCents: 1600, pendingCents: 0, status: "pagado" })

  // Cambiar el porcentaje no reescribe lo ya pagado.
  await f.run((tx) =>
    setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 2000 }),
  )
  const afterRate = await view()
  expect(afterRate.rateBps).toBe(2000)
  expect(afterRate.commissionCents).toBe(1600)
  expect(afterRate.lines.every((line) => line.settled && line.rateBps === 1000)).toBe(true)

  // Un cobro anulado después de pagada su comisión se descuenta del siguiente pago.
  await f.run((tx) =>
    voidTicket(tx, "org_a", f.actor, f.patient.id, later.ticket.id, { reason: "Cobro errado", allowPostClose: false }),
  )
  const owing = await view()
  // Sus dos partes (dinero nuevo y saldo a favor) ya tenían comisión pagada: 500 + 100.
  expect(owing.adjustments.map((a) => a.commissionCents).sort((x, y) => x - y)).toEqual([100, 500])
  expect(owing).toMatchObject({ commissionCents: 1000, pendingCents: -600, status: "por_descontar" })
  await expect(pay()).rejects.toMatchObject({ code: "COMMISSION_NOT_POSITIVE" })
  // Llega un cobro nuevo de 10 000 más los 1 000 a favor que volvieron: al 20 %
  // son 2 200, y el pago descuenta los 600.
  await collectMore(10000)
  expect(await view()).toMatchObject({ pendingCents: 1600, status: "por_pagar" })
  const third = await pay()
  expect(third.expense.amountCents).toBe(1600)
  const settledUp = await view()
  expect(settledUp.adjustments).toHaveLength(0)
  expect(settledUp).toMatchObject({ pendingCents: 0, status: "pagado" })

  // El mes de la clínica lista al profesional con su estado.
  const month = await f.run((tx) => listMonthCommissions(tx, "org_a", period))
  expect(month.find((row) => row.professionalUserId === f.actor)).toMatchObject({
    status: "pagado",
    pendingCents: 0,
    rateBps: 2000,
  })

  // El gasto de un pago de comisión no se anula suelto…
  await expect(
    f.run((tx) => voidExpense(tx, "org_a", f.actor, first.expense.id, { reason: "Prueba" })),
  ).rejects.toMatchObject({ code: "EXPENSE_IS_COMMISSION" })
  // …se anula con el pago: el gasto desaparece y sus cobros vuelven a quedar por pagar.
  await f.run((tx) => voidCommissionSettlement(tx, "org_a", f.actor, first.settlement.id, { reason: "Pago mal registrado" }))
  const expenses = await f.run((tx) => listExpenses(tx, "org_a", { branchId, limit: 200 }))
  expect(expenses.find((e) => e.id === first.expense.id)).toBeUndefined()
  // El cobro liberado se calcula con el porcentaje vigente (20 % de 10 000).
  expect(await view()).toMatchObject({ pendingCents: 2000, status: "por_pagar" })
})

it("el mes en Reportes concilia cobrado, gastos y deuda de la sede, y el cobro con promoción cuenta en ella", async () => {
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
  // snapshot y su promoción lo cuenta aunque venga de una atención y no de un presupuesto.
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
  // Reportes › Finanzas de la sede: lo cobrado, sin gastos, queda en caja; te deben lo que falta del primer concepto.
  const finance = await f.run((tx) => getReportFinance(tx, "org_a", { period: "este_mes", branchId }))
  expect(finance.totals.current).toMatchObject({ cobradoCents: 19900, otherExpensesCents: 0, cashLeftCents: 19900 })
  expect(finance.debts.current).toMatchObject({ totalCents: 8000, people: 1 })
  // Por profesional, lo cobrado de lo que atendió.
  const professionals = await f.run((tx) => getReportProfessionals(tx, "org_a", { period: "este_mes", branchId }))
  expect(professionals.rows).toContainEqual(expect.objectContaining({ userId: f.actor, collectedCents: 19900 }))
  // El cobro con promoción de una atención cuenta en su promoción: frente a la tarifa (1 200) se dejó de cobrar 1 121,
  // y lo pagado desde entonces son los dos cobros de la persona.
  const promotions = await f.run((tx) => getReportPromotions(tx, "org_a", { period: "este_mes" }))
  expect(promotions.promotions.find((row) => row.promotionId === promo.id)).toMatchObject({
    name: "Limpieza promo",
    people: 1,
    accepted: 1,
    discountCents: 112_100,
    collectedCents: 19900,
  })
})
