/**
 * Lo que un profesional le debe a la clínica (ADR 0157): comisiones ya pagadas de cobros que después
 * se anularon. Se descuenta sola del próximo pago, y también se cierra a mano: «lo devolvió» (en
 * efectivo entra a la caja sin su nombre; por transferencia o tarjeta no la toca) o «darlo por
 * saldado» (con su motivo, sin mover dinero). Después no debe nada en ninguna cuenta: Finanzas, Mis
 * comisiones y Reportes.
 */
import { randomUUID } from "node:crypto"
import { member, user } from "@odentia/db/schema/auth"
import { encounter, encounterProcedure } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  getCashState,
  getDayMovements,
  getMonthlyCommissions,
  getMyCommissions,
  getShiftDetail,
  listCommissionSettlements,
  listMonthCommissions,
  payMonthCommission,
  setCommissionRate,
  settleCommissionDebt,
  voidCommissionSettlement,
} from "./finance.js"
import { collectCharge, createCharge, voidTicket } from "./payments.js"
import { createPaymentMethod } from "./payment-methods.js"
import { commissionsOwedByMonth, getReportCommissions, getReportFinance } from "./report-finance.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()

function currentPeriod(): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date())
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get("year"), month: get("month") }
}

/**
 * Un profesional al 30 % con dos cobros del mes anterior: el de 1 000 se le pagó (300) y después se
 * anuló, y el de 500 (150) sigue por pagar. Le debe 300 a la clínica, como Luis en la demo.
 */
async function owing() {
  const f = await clinicalFixture()
  const [sede] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede deuda ${randomUUID()}` }).returning()
  const branchId = sede!.id
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  const procedures = await ownerDb
    .insert(encounterProcedure)
    .values([100000, 50000].map((priceCents) => ({ organizationId: "org_a", encounterId: f.encounter.id, serviceId: f.service.id, description: "Tratamiento", priceCents, currency: "PEN", createdBy: f.actor })))
    .returning()
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), branchId, signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 3000 }))
  const now = currentPeriod()
  const before = now.month === 1 ? { year: now.year - 1, month: 12 } : { year: now.year, month: now.month - 1 }
  const lastMonth = new Date(Date.UTC(before.year, before.month - 1, 15, 15))
  const collect = async (index: number) => {
    const row = procedures[index]!
    const charge = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: row.id }))
    const paid = await f.run((tx) =>
      collectCharge(tx, ...f.args, { branchId, chargeIds: [charge.id], payments: [{ paymentMethodId: cash.id, amountCents: row.priceCents! }], requestId: randomUUID() }),
    )
    await ownerDb.execute(sql`update patient_payment_application set created_at = ${lastMonth.toISOString()}::timestamptz
      where organization_id = 'org_a' and payment_id in (select id from patient_payment where ticket_id = ${paid.ticket.id})`)
    return paid
  }
  const first = await collect(0)
  const paidBefore = await f.run((tx) => payMonthCommission(tx, "org_a", f.actor, { professionalUserId: f.actor, ...before, branchId }))
  expect(paidBefore.expense!.amountCents).toBe(30000)
  await f.run((tx) => voidTicket(tx, "org_a", f.actor, f.patient.id, first.ticket.id, { reason: "Cobro errado", allowPostClose: true }))
  await collect(1)
  // Quien registra es otra persona de administración: al profesional se le avisa.
  const admin = randomUUID()
  await ownerDb.insert(user).values({ id: admin, name: "Administración deuda", email: `${admin}@example.com` })
  await ownerDb.insert(member).values({ id: randomUUID(), organizationId: "org_a", userId: admin, role: "admin", createdAt: new Date() })
  const viewOf = (period: { year: number; month: number }) =>
    f.run((tx) => getMonthlyCommissions(tx, "org_a", { professionalUserId: f.actor, ...period }))
  const inDrawer = async () => (await f.run((tx) => getCashState(tx, "org_a", { branchId }))).cashOnHandCents
  return { f, branchId, now, before, admin, viewOf, inDrawer, paidBefore }
}

it("la deuda de otro mes dice de qué pago se descuenta, y la fila del mes dice lo que se descuenta", async () => {
  const { f, now, before, viewOf } = await owing()
  // Este mes no tiene cobros: lo que debe espera… pero hay un mes con cobros por pagar, el anterior.
  expect(await viewOf(now)).toMatchObject({ adjustmentCents: 30000, discountCents: 0, owedCents: 30000, discountFrom: before })
  // El mes anterior descuenta lo que alcanza de su cobro por pagar y no tiene otro de donde descontar el resto.
  expect(await viewOf(before)).toMatchObject({ discountCents: 15000, pendingCents: 0, owedCents: 15000, discountFrom: null, status: "por_descontar" })
  // La fila de la lista lleva lo que se descuenta: sin esto, la diferencia parecía ya pagada. «Ya pagado»
  // es el pago del cobro que después se anuló.
  const row = (await f.run((tx) => listMonthCommissions(tx, "org_a", before))).find((item) => item.professionalUserId === f.actor)
  expect(row).toMatchObject({ commissionCents: 15000, pendingCents: 0, paidCents: 30000, discountCents: 15000 })
  // Los cobros del mes: el anulado se cuenta aparte.
  const lines = (await viewOf(before)).lines
  expect(lines.filter((line) => line.voidedAfterPaid)).toEqual([
    expect.objectContaining({ commissionCents: 30000, owedLeftCents: 30000, owedClosedBy: null }),
  ])
})

it("«lo devolvió» en efectivo entra a la caja sin su nombre y deja la deuda en cero en todas partes", async () => {
  const { f, branchId, now, before, admin, viewOf, inDrawer, paidBefore } = await owing()
  const drawer = await inDrawer()
  const settle = (input: Partial<Parameters<typeof settleCommissionDebt>[3]> = {}) =>
    f.run((tx) =>
      settleCommissionDebt(tx, "org_a", admin, {
        professionalUserId: f.actor,
        ...now,
        kind: "devuelto",
        methodTypeCode: "10",
        branchId,
        ...input,
      }),
    )
  // Sin medio o sin sede no se registra; si lo que debe cambió, tampoco.
  await expect(settle({ methodTypeCode: undefined })).rejects.toMatchObject({ code: "VALIDATION", fields: { methodTypeCode: expect.any(String) } })
  await expect(settle({ branchId: undefined })).rejects.toMatchObject({ fields: { branchId: expect.any(String) } })
  await expect(settle({ expectedCents: 1 })).rejects.toMatchObject({ code: "COMMISSION_AMOUNT_CHANGED" })
  const reportBefore = await f.run((tx) => getReportFinance(tx, "org_a", { period: "este_mes" }))
  const done = await settle({ expectedCents: 30000, notes: "Lo trajo en un sobre" })
  expect(done.settlement).toMatchObject({ kind: "devuelto", methodTypeCode: "10", commissionCents: 30000, expenseId: null, settledBy: admin })
  // Entra a la caja, como «Devolución de comisiones»: caja no ve a quién se le pagan las comisiones.
  expect(await inDrawer()).toBe(drawer + 30000)
  const state = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  const detail = await f.run((tx) => getShiftDetail(tx, "org_a", state.shiftId!))
  const movement = detail.movements.find((m) => m.id === done.movementId)
  expect(movement).toMatchObject({ direction: "ingreso", kind: "gasto", amountCents: 30000, concept: "Devolución de comisiones" })
  const [who] = await ownerDb.select({ name: user.name }).from(user).where(eq(user.id, f.actor))
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
  const day = await f.run((tx) => getDayMovements(tx, "org_a", { branchId, day: today }))
  expect(day.movements.filter((m) => m.concept.includes(who!.name))).toEqual([])
  // Ya no debe nada: ni este mes, ni el anterior, que ahora paga entero lo suyo.
  expect(await viewOf(now)).toMatchObject({ adjustmentCents: 0, owedCents: 0, discountFrom: null })
  const previous = await viewOf(before)
  expect(previous).toMatchObject({ adjustmentCents: 0, discountCents: 0, pendingCents: 15000, status: "por_pagar" })
  expect(previous.lines.find((line) => line.voidedAfterPaid)).toMatchObject({ owedLeftCents: 0, owedClosedBy: "devuelto" })
  // «Mis comisiones» dice lo mismo: es la misma cuenta.
  const mine = await f.run((tx) => getMyCommissions(tx, "org_a", f.actor, before))
  expect(mine).toMatchObject({ adjustmentCents: 0, owedCents: 0 })
  expect(mine.lines.find((line) => line.voidedAfterPaid)).toMatchObject({ owedClosedBy: "devuelto" })
  // Reportes deja de contarlo: lo que se debe hoy vuelve a ser lo del mes anterior, entero.
  const report = await f.run((tx) => getReportFinance(tx, "org_a", { period: "este_mes" }))
  expect(report.payables.commissions.nowCents).toBe(reportBefore.payables.commissions.nowCents + 15000)
  const professionals = await f.run((tx) => getReportCommissions(tx, "org_a", { period: "este_mes" }))
  expect(professionals.rows.find((row) => row.userId === f.actor)?.discountCents ?? 0).toBe(0)
  const owedMonths = await f.run((tx) => commissionsOwedByMonth(tx, "org_a"))
  expect(owedMonths.months.find((m) => m.year === before.year && m.month === before.month)?.cents).toBeGreaterThanOrEqual(15000)
  // Queda entre los pagos del mes, con quién lo registró, y al profesional se le avisa.
  const payments = await f.run((tx) => listCommissionSettlements(tx, "org_a", { professionalUserId: f.actor, ...now }))
  expect(payments).toEqual([expect.objectContaining({ id: done.settlement.id, kind: "devuelto", settledByName: "Administración deuda" })])
  const notice = await ownerDb.execute<{ title: string }>(
    sql`select title from workspace_notification where organization_id = 'org_a' and dedupe_key = ${`commission-debt:${done.settlement.id}`}`,
  )
  expect(notice[0]).toMatchObject({ title: "Se registró lo que devolviste" })
  const audit = await ownerDb.execute<{ action: string; actor: string }>(
    sql`select action, actor_user_id as actor from audit_event where organization_id = 'org_a' and entity_id = ${done.settlement.id}`,
  )
  expect(audit).toEqual([expect.objectContaining({ action: "finance.commission_debt_returned", actor: admin })])
  // Ya no hay nada que registrar.
  await expect(settle()).rejects.toMatchObject({ code: "COMMISSION_NOTHING_OWED" })
  // El pago que lo originó no se anula mientras la devolución lo cierre.
  await expect(
    f.run((tx) => voidCommissionSettlement(tx, "org_a", admin, paidBefore.settlement.id, { reason: "Prueba" })),
  ).rejects.toMatchObject({ code: "COMMISSION_DISCOUNTED_LATER" })
  // Anularla devuelve todo como estaba: sale de la caja y vuelve a deber.
  await f.run((tx) => voidCommissionSettlement(tx, "org_a", admin, done.settlement.id, { reason: "Era de otro" }))
  expect(await inDrawer()).toBe(drawer)
  expect(await viewOf(now)).toMatchObject({ adjustmentCents: 30000, owedCents: 30000 })
  const voidNotice = await ownerDb.execute<{ title: string }>(
    sql`select title from workspace_notification where organization_id = 'org_a' and dedupe_key = ${`commission-voided:${done.settlement.id}`}`,
  )
  expect(voidNotice[0]).toMatchObject({ title: "Se anuló el registro de lo que devolviste" })
})

it("devuelto por transferencia no toca la caja, y darlo por saldado pide su motivo y no mueve dinero", async () => {
  const { f, branchId, now, before, admin, viewOf, inDrawer } = await owing()
  const drawer = await inDrawer()
  const forgive = (notes: string | undefined) =>
    f.run((tx) => settleCommissionDebt(tx, "org_a", admin, { professionalUserId: f.actor, ...now, kind: "saldado", notes }))
  await expect(forgive(undefined)).rejects.toMatchObject({ fields: { notes: "Escribe el motivo." } })
  await expect(forgive("   ")).rejects.toMatchObject({ fields: { notes: "Escribe el motivo." } })
  await expect(forgive("x".repeat(201))).rejects.toMatchObject({ fields: { notes: expect.stringContaining("200") } })
  const forgiven = await forgive("Ya no trabaja aquí")
  expect(forgiven.settlement).toMatchObject({ kind: "saldado", methodTypeCode: null, cashMovementId: null, notes: "Ya no trabaja aquí" })
  expect(forgiven.movementId).toBeNull()
  expect(await inDrawer()).toBe(drawer)
  expect(await viewOf(now)).toMatchObject({ adjustmentCents: 0, owedCents: 0 })
  const previous = await viewOf(before)
  expect(previous.lines.find((line) => line.voidedAfterPaid)).toMatchObject({ owedLeftCents: 0, owedClosedBy: "saldado" })
  const audit = await ownerDb.execute<{ action: string; actor: string }>(
    sql`select action, actor_user_id as actor from audit_event where organization_id = 'org_a' and entity_id = ${forgiven.settlement.id}`,
  )
  expect(audit).toEqual([expect.objectContaining({ action: "finance.commission_debt_forgiven", actor: admin })])
  // Se anula con su motivo y vuelve a deber; después lo devuelve por transferencia, sin tocar la caja.
  await f.run((tx) => voidCommissionSettlement(tx, "org_a", admin, forgiven.settlement.id, { reason: "Se equivocó" }))
  expect(await viewOf(now)).toMatchObject({ adjustmentCents: 30000 })
  const transfer = await f.run((tx) =>
    settleCommissionDebt(tx, "org_a", admin, { professionalUserId: f.actor, ...now, kind: "devuelto", methodTypeCode: "30", branchId }),
  )
  expect(transfer.settlement).toMatchObject({ kind: "devuelto", methodTypeCode: "30", cashMovementId: null })
  expect(await inDrawer()).toBe(drawer)
  expect(await viewOf(now)).toMatchObject({ adjustmentCents: 0 })
  // Lo que no es un pago no sale como una comisión pagada en el mes: «Ya pagado» sigue siendo el dinero que salió.
  expect(await viewOf(now)).toMatchObject({ paidCents: 0, lastPaidAt: null })
})
