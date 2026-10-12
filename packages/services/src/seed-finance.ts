import type { Db } from "@odentia/db"
import { paymentTicket } from "@odentia/db/schema/clinical"
import { and, eq } from "drizzle-orm"
import { addShiftMovement, closeCashWindow, createExpense, ensureOpenShift, getCashState } from "./finance.js"
import { listPaymentMethods, updatePaymentMethod } from "./payment-methods.js"
import { collectCharge, createCharge, voidTicket } from "./payments.js"

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
  const transfer = methods.find((method) => method.typeCode === "30")
  if (!cash || !wallet || !transfer) throw new Error("Faltan los medios de pago de la clínica demo")
  const shift = await ensureOpenShift(tx, orgId, ownerUserId, branchId, "PEN")
  await addShiftMovement(tx, orgId, ownerUserId, shift.id, {
    direction: "ingreso", kind: "aporte", amountCents: 20000, concept: "Fondo de efectivo demo",
  })
  const charge = await createCharge(tx, orgId, ownerUserId, patientId, {
    branchId, description: "Profilaxis demo caja", amountCents: 12000, currency: "PEN",
  })
  await collectCharge(tx, orgId, ownerUserId, patientId, {
    branchId, payerContactId: contactId, chargeIds: [charge.id], requestId,
    payments: [
      { paymentMethodId: cash.id, amountCents: 5000 },
      { paymentMethodId: wallet.id, amountCents: 7000, reference: "DEMO-7000" },
    ], cashReceivedCents: 10000,
  })
  await createExpense(tx, orgId, ownerUserId, {
    branchId, category: "Materiales", concept: "Guantes y mascarillas demo", amountCents: 3550, fromCash: true,
  })
  const cancelled = await collectCharge(tx, orgId, ownerUserId, patientId, {
    branchId, advanceCents: 5000, requestId: "50206010-0000-4000-8000-000000000002",
    payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
  })
  await voidTicket(tx, orgId, ownerUserId, patientId, cancelled.ticket.id, {
    reason: "Importe digitado por error en la demostración", allowPostClose: false,
  })
  const state = await getCashState(tx, orgId, { branchId, currency: "PEN" })
  const countedCents = state.cashOnHandCents - 500
  await closeCashWindow(tx, orgId, ownerUserId, {
    branchId, countedCents, retainedCents: 10000, deliveredCents: countedCents - 10000,
    notes: "Diferencia demo de 5 soles para revisar el aviso a administración",
  })
  await createCharge(tx, orgId, ownerUserId, patientId, {
    branchId, description: "Resina demo pendiente", amountCents: 24000, currency: "PEN",
  })
  await updatePaymentMethod(tx, orgId, ownerUserId, transfer.id, { isActive: false })
}
