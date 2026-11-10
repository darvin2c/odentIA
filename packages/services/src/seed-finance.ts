import type { Db } from "@odentia/db"
import { paymentTicket } from "@odentia/db/schema/clinical"
import { and, eq, sql } from "drizzle-orm"
import { addShiftMovement, closeCashWindow, createExpense, ensureOpenShift, getCashState } from "./finance.js"
import { listPaymentMethods, updatePaymentMethod } from "./payment-methods.js"
import { collectCharge, createCharge, patientCreditSql, voidTicket } from "./payments.js"

/** Escenarios manuales de caja: multimedio, anulación, cierre con diferencia y medio apagado. */
export async function seedFinance(tx: Db, input: {
  orgId: string
  ownerUserId: string
  branchId: string
  patientId: string
  contactId: string
}): Promise<void> {
  const { orgId, ownerUserId, branchId, patientId, contactId } = input
  const requestId = "50206010-0000-4000-8000-000000000001"
  const [existing] = await tx.select({ id: paymentTicket.id }).from(paymentTicket)
    .where(and(eq(paymentTicket.organizationId, orgId), eq(paymentTicket.requestId, requestId)))
  if (existing) return
  const methods = await listPaymentMethods(tx, orgId, { activeOnly: false })
  const cash = methods.find((method) => method.typeCode === "10")
  const wallet = methods.find((method) => method.name === "Yape")
  // El medio apagado es Plin: la transferencia queda para pagar el alquiler y los sueldos (ADR 0167).
  const off = methods.find((method) => method.name === "Plin")
  if (!cash || !wallet || !off) throw new Error("Faltan los medios de pago de la clínica demo")
  const shift = await ensureOpenShift(tx, orgId, ownerUserId, branchId, "PEN")
  await addShiftMovement(tx, orgId, ownerUserId, shift.id, {
    direction: "ingreso", kind: "aporte", amountCents: 20000, concept: "Fondo de caja inicial",
  })
  const charge = await createCharge(tx, orgId, ownerUserId, patientId, {
    branchId, description: "Profilaxis", amountCents: 12000, currency: "PEN",
  })
  // Lo que ya tiene a favor se usa solo al cobrar, y con el concepto marcado no se cobra
  // más de lo que le falta (EXCEEDS_DUE): se paga solo lo que queda, en efectivo y Yape.
  const [credit] = (await tx.execute(
    sql`select ${patientCreditSql(orgId, sql`${patientId}::uuid`, sql`'PEN'`)} as cents`,
  )) as unknown as Array<{ cents: string | number }>
  const due = Math.max(0, 12000 - Number(credit?.cents ?? 0))
  const inCash = Math.min(5000, due)
  const inWallet = due - inCash
  await collectCharge(tx, orgId, ownerUserId, patientId, {
    branchId, payerContactId: contactId, chargeIds: [charge.id], requestId,
    payments: [
      ...(inCash > 0 ? [{ paymentMethodId: cash.id, amountCents: inCash }] : []),
      ...(inWallet > 0 ? [{ paymentMethodId: wallet.id, amountCents: inWallet, reference: `DEMO-${inWallet}` }] : []),
    ],
    ...(inCash > 0 ? { cashReceivedCents: 10000 } : {}),
  })
  await createExpense(tx, orgId, ownerUserId, {
    branchId, category: "Materiales", concept: "Guantes y mascarillas", amountCents: 3550, paymentMethodId: cash.id,
    receiptType: "03", receiptNumber: "B001-4512",
  })
  // Lo chico del día, como en una clínica de verdad (ADR 0167): el motorizado que trae un trabajo
  // del laboratorio, en efectivo y sin comprobante, y la limpieza con tarjeta y su boleta.
  await createExpense(tx, orgId, ownerUserId, {
    branchId, category: "Otros", concept: "Motorizado: trajo la corona del laboratorio", amountCents: 1500, paymentMethodId: cash.id,
    receiptType: "sin",
  })
  const card = methods.find((method) => method.typeCode === "48" && method.isActive)
  await createExpense(tx, orgId, ownerUserId, {
    branchId, category: "Otros", concept: "Útiles de limpieza", amountCents: 4280,
    ...(card ? { paymentMethodId: card.id } : {}), receiptType: "03", receiptNumber: "B003-0291",
  })
  const cancelled = await collectCharge(tx, orgId, ownerUserId, patientId, {
    branchId, advanceCents: 5000, requestId: "50206010-0000-4000-8000-000000000002",
    payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
  })
  await voidTicket(tx, orgId, ownerUserId, patientId, cancelled.ticket.id, {
    reason: "Importe digitado por error", allowPostClose: false,
  })
  const state = await getCashState(tx, orgId, { branchId, currency: "PEN" })
  const countedCents = state.cashOnHandCents - 500
  await closeCashWindow(tx, orgId, ownerUserId, {
    branchId, countedCents, retainedCents: 10000, deliveredCents: countedCents - 10000,
    notes: "Faltan 5 soles al cierre; se revisará con administración",
  })
  await createCharge(tx, orgId, ownerUserId, patientId, {
    branchId, description: "Resina", amountCents: 24000, currency: "PEN",
  })
  await updatePaymentMethod(tx, orgId, ownerUserId, off.id, { isActive: false })
}
