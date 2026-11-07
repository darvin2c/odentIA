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
import { and, eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  getMonthExpenses,
  getMonthlyCommissions,
  listExpenses,
  listMonthCommissions,
  payMonthCommission,
  setCommissionRate,
  voidCommissionSettlement,
  voidExpense,
} from "./finance.js"
import { collectCharge, createCharge, getTicketReturnable, refundCredit, returnFromTicket, voidTicket } from "./payments.js"
import { createPromotion } from "./promotions.js"
import { getReportFinance, getReportPromotions } from "./report-finance.js"
import { getReportProfessionals } from "./report-summary.js"
import { createPaymentMethod } from "./payment-methods.js"
import { runArgosQuery } from "./argos-query.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
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
    getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...period }),
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
    getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...period }),
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
    getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...period }),
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
  expect(second.expense!.amountCents).toBe(600)
  expect(await view()).toMatchObject({ paidCents: 1600, pendingCents: 0, status: "pagado" })

  // En Gastos, quien no administra comisiones ve el total del mes en una fila, sin a quién se pagó;
  // quien las administra ve cada pago y lo que lo lleva a él.
  const forCashier = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...period, branchId }))
  expect(forCashier.expenses.filter((e) => e.commission)).toEqual([
    expect.objectContaining({ concept: "Pago de comisiones", amountCents: 1600, commissionPayment: null }),
  ])
  expect(forCashier.expenses.some((e) => e.concept.startsWith("Comisión de"))).toBe(false)
  const forAdmin = await f.run((tx) =>
    getMonthExpenses(tx, "org_a", { ...period, branchId }, { seesCommissions: true }),
  )
  expect(forAdmin.expenses.filter((e) => e.commission)).toHaveLength(2)
  expect(forAdmin.expenses.find((e) => e.id === first.expense!.id)?.commissionPayment).toEqual({
    professionalUserId: f.actor,
    ...period,
  })
  // La fila suma lo mismo que los dos pagos, y lo que se ve cuenta una fila menos.
  expect(forCashier.shown.totalCents).toBe(forAdmin.shown.totalCents)
  expect(forCashier.shown.count).toBe(forAdmin.shown.count - 1)
  // La lista cruda de la API tampoco da cada pago.
  const raw = await f.run((tx) => listExpenses(tx, "org_a", { branchId, limit: 200 }))
  expect(raw.filter((e) => e.category === "Personal")).toEqual([
    expect.objectContaining({ concept: "Pago de comisiones", amountCents: 1600, notes: null }),
  ])
  // Ni buscando el nombre en la lista del mes.
  const named = forAdmin.expenses.find((e) => e.id === first.expense!.id)?.concept ?? ""
  const who = named.split("—").pop()?.trim() ?? ""
  expect(who).not.toBe("")
  expect(
    (await f.run((tx) => getMonthExpenses(tx, "org_a", { ...period, branchId, q: who }))).expenses.filter((e) => e.commission),
  ).toEqual([])

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
  // El descuento es del profesional, no del mes: este mes ya no tiene nada nuevo, así que no queda
  // en negativo ni «por descontar»; los 600 esperan al próximo pago, de este mes o de otro.
  expect(owing).toMatchObject({ commissionCents: 1000, pendingCents: 0, adjustmentCents: 600, discountCents: 0, status: "pagado" })
  await expect(pay()).rejects.toMatchObject({ code: "COMMISSION_NOTHING_TO_PAY" })
  // Llega un cobro nuevo de 10 000 más los 1 000 a favor que volvieron: al 20 %
  // son 2 200, y el pago descuenta los 600.
  await collectMore(10000)
  expect(await view()).toMatchObject({ pendingCents: 1600, status: "por_pagar" })
  const third = await pay()
  expect(third.expense!.amountCents).toBe(1600)
  const settledUp = await view()
  expect(settledUp.adjustments).toHaveLength(0)
  // «Ya pagado» es el dinero que salió: 1 000 + 600 + 1 600, no la comisión de cobros ya descontados.
  expect(settledUp).toMatchObject({ pendingCents: 0, paidCents: 3200, status: "pagado" })
  // El segundo pago no se anula mientras el tercero tenga descontado un cobro suyo.
  await expect(
    f.run((tx) => voidCommissionSettlement(tx, "org_a", f.actor, second.settlement.id, { reason: "Prueba" })),
  ).rejects.toMatchObject({ code: "COMMISSION_DISCOUNTED_LATER" })

  // El mes de la clínica lista al profesional con su estado.
  const month = await f.run((tx) => listMonthCommissions(tx, "org_a", period))
  expect(month.find((row) => row.professionalUserId === f.actor)).toMatchObject({
    status: "pagado",
    pendingCents: 0,
    rateBps: 2000,
  })

  // Un descuento más grande que lo nuevo no bloquea el pago: se descuenta lo que alcanza y el resto
  // espera. Se anula el cobro grande (su comisión de 2 200 ya se pagó en el tercer pago)…
  const lastTicket = (await f.run((tx) =>
    ownerDb.execute<{ id: string }>(sql`select id from payment_ticket where organization_id = 'org_a' and patient_id = ${f.patient.id} and voided_at is null order by created_at desc limit 1`),
  ))[0]!
  await f.run((tx) => voidTicket(tx, "org_a", f.actor, f.patient.id, lastTicket.id, { reason: "Cobro errado", allowPostClose: false }))
  expect(await view()).toMatchObject({ adjustmentCents: 2200, pendingCents: 0 })
  // …y llega un cobro de 5 000 que, con lo que volvió a favor, deja menos comisión que el descuento.
  await collectMore(5000)
  const partial = await view()
  const fresh = partial.lines.filter((line) => !line.settled).reduce((sum, line) => sum + line.commissionCents, 0)
  expect(fresh).toBeGreaterThan(0)
  expect(fresh).toBeLessThan(2200)
  expect(partial).toMatchObject({ discountCents: fresh, pendingCents: 0, status: "por_descontar" })
  // Se registra el descuento sin que salga dinero, y queda lo demás por descontar.
  const discountOnly = await pay()
  expect(discountOnly.expense).toBeNull()
  expect(discountOnly.settlement.commissionCents).toBe(0)
  expect(await view()).toMatchObject({ adjustmentCents: 2200 - fresh, pendingCents: 0, status: "pagado" })

  // El gasto de un pago de comisión no se anula suelto…
  await expect(
    f.run((tx) => voidExpense(tx, "org_a", f.actor, first.expense!.id, { reason: "Prueba" })),
  ).rejects.toMatchObject({ code: "EXPENSE_IS_COMMISSION" })
  // …se anula con el pago: el gasto desaparece y sus cobros vuelven a quedar por pagar.
  await f.run((tx) => voidCommissionSettlement(tx, "org_a", f.actor, first.settlement.id, { reason: "Pago mal registrado" }))
  const expenses = await f.run((tx) => listExpenses(tx, "org_a", { branchId, limit: 200 }, { seesCommissions: true }))
  expect(expenses.find((e) => e.id === first.expense!.id)).toBeUndefined()
  // Para caja, el pago anulado deja de sumar en la fila del mes.
  const afterVoidCashier = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...period, branchId }))
  const paidLive = (await f.run((tx) => getMonthExpenses(tx, "org_a", { ...period, branchId }, { seesCommissions: true })))
    .expenses.filter((e) => e.commission && !e.voidedAt)
    .reduce((sum, e) => sum + e.amountCents, 0)
  expect(afterVoidCashier.expenses.filter((e) => e.commission)).toEqual([
    expect.objectContaining({ concept: "Pago de comisiones", amountCents: paidLive }),
  ])
  // El cobro liberado se calcula con el porcentaje vigente (20 % de 10 000).
  // y lo que quedaba por descontar se descuenta de ellos.
  const freed = await view()
  expect(freed.discountCents).toBe(Math.min(2000, 2200 - fresh))
  expect(freed).toMatchObject({ pendingCents: 2000 - freed.discountCents, status: freed.discountCents === 2000 ? "por_descontar" : "por_pagar" })
})

it("a quien deja el equipo se le paga lo pendiente, y sus meses no cambian en Reportes ni en Argos", async () => {
  // El fixture ya lo hace miembro del equipo (firma como clínico).
  const f = await clinicalFixture()
  const branchId = await seedBranch()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  const [procedure] = await ownerDb
    .insert(encounterProcedure)
    .values({ organizationId: "org_a", encounterId: f.encounter.id, serviceId: f.service.id, description: "Corona", priceCents: 50000, currency: "PEN", createdBy: f.actor })
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), branchId, signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  const charge = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: procedure!.id }))
  await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId, chargeIds: [charge.id], payments: [{ paymentMethodId: cash.id, amountCents: 50000 }], requestId: randomUUID() }),
  )
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 4000 }))
  const period = currentPeriod()
  const report = async () => (await f.run((tx) => getReportFinance(tx, "org_a", { period: "este_mes", branchId }))).commissions
  // El mes en curso termina «ahora»: las dos lecturas usan la misma hora.
  const asOf = new Date()
  const wholeReport = () => f.run((tx) => getReportFinance(tx, "org_a", { period: "este_mes", branchId }, asOf))
  // Argos lee la misma cuenta en su vista: lo de esta sede (solo de esta prueba).
  const [sede] = await ownerDb.select({ name: branch.name }).from(branch).where(eq(branch.id, branchId))
  const argos = async () =>
    Number(
      (
        await runArgosQuery(appDb, {
          orgId: "org_a",
          memberRole: "owner",
          query: `select sum(comision) * 100 as v from comisiones where sede = '${sede!.name}'`,
        })
      ).rows[0]?.v ?? 0,
    )
  const before = await report()
  expect(before).toMatchObject({ generatedCents: 20000, pendingCents: 20000 })
  const wholeBefore = await wholeReport()
  const argosBefore = await argos()
  expect(argosBefore).toBe(20000)

  // Deja la clínica con su comisión del mes por pagar.
  await ownerDb.delete(member).where(and(eq(member.organizationId, "org_a"), eq(member.userId, f.actor)))
  const view = await f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...period }))
  expect(view).toMatchObject({ inTeam: false, commissionCents: 20000, pendingCents: 20000, status: "por_pagar" })
  const month = await f.run((tx) => listMonthCommissions(tx, "org_a", period))
  expect(month.find((row) => row.professionalUserId === f.actor)).toMatchObject({ inTeam: false, pendingCents: 20000 })
  // Lo que ganó mientras atendía no se borra de Reportes ni de Argos por haberse ido.
  expect(await wholeReport()).toEqual(wholeBefore)
  expect(await argos()).toBe(argosBefore)
  // Y se le paga igual.
  const paid = await f.run((tx) => payMonthCommission(tx, "org_a", f.actor, { professionalUserId: f.actor, ...period, branchId }))
  expect(paid.expense!.amountCents).toBe(20000)
  expect(await report()).toMatchObject({ generatedCents: 20000, paidCents: 20000, pendingCents: 0 })
  // Quien nunca estuvo en la clínica sigue sin existir para Comisiones.
  await expect(
    f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: randomUUID(), ...period })),
  ).rejects.toMatchObject({ code: "NOT_FOUND" })
})

it("pagar la comisión anotando el gasto en otra sede baja lo que se debe en la sede del cobro", async () => {
  const f = await clinicalFixture()
  const cobroSede = await seedBranch()
  const gastoSede = await seedBranch()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  const [procedure] = await ownerDb
    .insert(encounterProcedure)
    .values({ organizationId: "org_a", encounterId: f.encounter.id, serviceId: f.service.id, description: "Corona", priceCents: 50000, currency: "PEN", createdBy: f.actor })
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), branchId: cobroSede, signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  const charge = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: procedure!.id }))
  await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId: cobroSede, chargeIds: [charge.id], payments: [{ paymentMethodId: cash.id, amountCents: 50000 }], requestId: randomUUID() }),
  )
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 4000 }))
  const owed = async (branchId: string) =>
    (await f.run((tx) => getReportFinance(tx, "org_a", { period: "este_mes", branchId }))).payables.commissions.cents
  expect(await owed(cobroSede)).toBe(20000)
  await f.run((tx) => payMonthCommission(tx, "org_a", f.actor, { professionalUserId: f.actor, ...currentPeriod(), branchId: gastoSede }))
  // La deuda era de la sede del cobro: ahí baja; en la sede del gasto nunca hubo deuda.
  expect(await owed(cobroSede)).toBe(0)
  expect(await owed(gastoSede)).toBe(0)
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

it("después de «Devolver», Por profesional cuenta lo cobrado el día del cobro y lo devuelto el día que se devolvió, y en el mismo mes cuadra con Comisiones", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(member).values({ id: randomUUID(), organizationId: "org_a", userId: f.actor, role: "clinician", createdAt: new Date() })
  const branchId = await seedBranch()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo devolución", typeCode: "10" }))
  // Dos actos de la misma atención, que se firma antes de cobrarlos.
  const procedures = await ownerDb
    .insert(encounterProcedure)
    .values(
      ["Endodoncia con devolución", "Corona con devolución"].map((description) => ({
        organizationId: "org_a",
        encounterId: f.encounter.id,
        serviceId: f.service.id,
        description,
        priceCents: 30000,
        currency: "PEN",
        createdBy: f.actor,
      })),
    )
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  const attended = async (description: string) => {
    const procedure = procedures.find((row) => row.description === description)!
    return f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: procedure.id }))
  }
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 1000 }))
  const collect = async (chargeId: string) =>
    f.run((tx) => collectCharge(tx, ...f.args, { branchId, chargeIds: [chargeId], payments: [{ paymentMethodId: cash.id, amountCents: 30000 }], requestId: randomUUID() }))
  const giveBack = async (ticketId: string) => {
    const { lines } = await f.run((tx) => getTicketReturnable(tx, "org_a", f.patient.id, ticketId))
    await f.run((tx) =>
      returnFromTicket(tx, "org_a", f.actor, f.patient.id, ticketId, {
        branchId,
        lines: [{ chargeId: lines[0]!.chargeId, amountCents: 10000 }],
        paymentMethodId: cash.id,
        reason: "Reclamo",
        requestId: randomUUID(),
      }),
    )
  }
  const professional = async (period: string) =>
    (await f.run((tx) => getReportProfessionals(tx, "org_a", { period, branchId }))).rows.find((row) => row.userId === f.actor)?.collectedCents ?? 0

  // Mismo mes: se cobran 300 y se devuelven 100. Quedan 200, en los dos lados (antes, Por profesional restaba 100 dos veces).
  const first = await attended("Endodoncia con devolución")
  const paid = await collect(first.id)
  await giveBack(paid.ticket.id)
  const period = currentPeriod()
  const monthly = await f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...period }))
  expect(monthly.baseCents).toBe(20000)
  expect(await professional("este_mes")).toBe(20000)

  // Cobrado hace 35 días (otro mes) y devuelto hoy: ese mes no cambia (300) y este resta lo devuelto (−100).
  // Antes, el reemplazo volvía a contar este mes como cobrado.
  const second = await attended("Corona con devolución")
  const earlier = await collect(second.id)
  const shifted = new Date(Date.now() - 35 * 86_400_000)
  await ownerDb.execute(sql`update patient_payment_application set created_at = ${shifted.toISOString()}::timestamptz where payment_id = ${earlier.payments[0]!.id}`)
  const shiftedMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).format(shifted)
  expect(await professional(shiftedMonth)).toBe(30000)
  await giveBack(earlier.ticket.id)
  expect(await professional(shiftedMonth)).toBe(30000)
  expect(await professional("este_mes")).toBe(20000 - 10000)
})
