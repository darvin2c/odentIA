import type { Db } from "@odentia/db"
import {
  encounter,
  encounterProcedure,
  patient,
  patientCharge,
  patientPayment,
  patientPaymentApplication,
  patientPaymentRefund,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import { requireLinkedActiveContact } from "./responsibilities.js"

export const PAYMENT_METHODS = [
  "efectivo",
  "tarjeta",
  "transferencia",
  "yape",
  "plin",
  "otro",
] as const
export function assertPositiveCents(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
    throw validation("El importe debe ser un entero positivo de centavos")
  return value
}
function currency(value: string): string {
  if (!/^[A-Z]{3}$/.test(value))
    throw validation("La moneda debe ser un código ISO 4217 de tres letras")
  return value
}
function reason(value: string): string {
  const text = value?.trim()
  if (!text || text.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
  return text
}
function instant(value: string): Date {
  const date = new Date(value)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(date.getTime()))
    throw validation("Fecha ISO inválida")
  return date
}
function sum(rows: Array<{ amountCents: number }>): number {
  let total = 0
  for (const row of rows) {
    total += row.amountCents
    if (!Number.isSafeInteger(total)) throw validation("El total excede el rango exacto admitido")
  }
  return total
}
function conflict(code: string, message: string) {
  return new ServiceError(code, 409, message)
}
// Serializa aplicaciones, anulaciones y devoluciones del paciente para impedir sobregiros.
async function lockAccount(tx: Db, orgId: string, patientId: string) {
  const [row] = await tx
    .select({ id: patient.id })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .for("update")
  if (!row) throw notFound("Paciente")
}
async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  entity: string,
  id: string,
  action: string,
) {
  await tx
    .insert(auditEvent)
    .values({ organizationId: orgId, actorUserId, entity, entityId: id, action })
}
async function paymentRow(tx: Db, orgId: string, patientId: string, id: string) {
  const [row] = await tx
    .select()
    .from(patientPayment)
    .where(
      and(
        eq(patientPayment.id, id),
        eq(patientPayment.organizationId, orgId),
        eq(patientPayment.patientId, patientId),
      ),
    )
  if (!row) throw notFound("Pago")
  if (row.voidedAt) throw conflict("PAYMENT_VOIDED", "El pago está anulado")
  return row
}
async function chargeRow(tx: Db, orgId: string, patientId: string, id: string) {
  const [row] = await tx
    .select()
    .from(patientCharge)
    .where(
      and(
        eq(patientCharge.id, id),
        eq(patientCharge.organizationId, orgId),
        eq(patientCharge.patientId, patientId),
      ),
    )
  if (!row) throw notFound("Cargo")
  if (row.voidedAt) throw conflict("CHARGE_VOIDED", "El cargo está anulado")
  return row
}
async function paymentBalance(
  tx: Db,
  orgId: string,
  patientId: string,
  payment: typeof patientPayment.$inferSelect,
) {
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
        eq(patientPaymentApplication.paymentId, payment.id),
        isNull(patientPaymentApplication.voidedAt),
      ),
    )
  const refunds = await tx
    .select()
    .from(patientPaymentRefund)
    .where(
      and(
        eq(patientPaymentRefund.organizationId, orgId),
        eq(patientPaymentRefund.patientId, patientId),
        eq(patientPaymentRefund.paymentId, payment.id),
      ),
    )
  return {
    available: payment.amountCents - sum(applications) - sum(refunds),
    applications,
    refunds,
  }
}
export interface CreateChargeInput {
  budgetItemId?: string | null
  encounterProcedureId?: string | null
  planItemId?: string | null
  description?: string
  amountCents?: number
  currency?: string
  dueAt?: string | null
  notes?: string | null
}
export async function createCharge(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateChargeInput,
) {
  await lockAccount(tx, orgId, patientId)
  if (input.budgetItemId && input.encounterProcedureId)
    throw validation("Seleccione una sola fuente del cargo")
  let planItemId = input.planItemId ?? null
  let description = input.description?.trim() ?? ""
  let amountCents = input.amountCents
  let unit = input.currency
  if (input.budgetItemId) {
    const [source] = await tx
      .select({ line: treatmentBudgetItem, budget: treatmentBudget })
      .from(treatmentBudgetItem)
      .innerJoin(
        treatmentBudget,
        and(
          eq(treatmentBudget.id, treatmentBudgetItem.budgetId),
          eq(treatmentBudget.organizationId, orgId),
          eq(treatmentBudget.patientId, patientId),
        ),
      )
      .where(
        and(
          eq(treatmentBudgetItem.id, input.budgetItemId),
          eq(treatmentBudgetItem.organizationId, orgId),
          eq(treatmentBudgetItem.patientId, patientId),
        ),
      )
    if (!source) throw notFound("Línea presupuestaria")
    await tx
      .select({ id: treatmentPlan.id })
      .from(treatmentPlan)
      .where(
        and(eq(treatmentPlan.id, source.budget.planId), eq(treatmentPlan.organizationId, orgId)),
      )
      .for("update")
    const [budget] = await tx
      .select()
      .from(treatmentBudget)
      .where(
        and(eq(treatmentBudget.id, source.budget.id), eq(treatmentBudget.organizationId, orgId)),
      )
    if (!["aceptado", "parcial"].includes(budget.status) || source.line.decision !== "aceptado")
      throw conflict(
        "BUDGET_NOT_ACCEPTED",
        "La línea no pertenece a una propuesta aceptada vigente",
      )
    if (planItemId && planItemId !== source.line.planItemId)
      throw validation("El cargo conserva el tratamiento de su fuente")
    planItemId = source.line.planItemId
    const [pricedItem] = await tx
      .select({ priceCents: treatmentPlanItem.priceCents })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, source.line.planItemId),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
    const itemPrice = pricedItem?.priceCents ?? null
    description = source.line.title
    unit = source.line.currency
    if (input.currency && input.currency !== unit)
      throw conflict("CURRENCY_MISMATCH", "La moneda no coincide con la propuesta")
    // El límite es por tratamiento, no por línea: una revisión crea otra línea
    // del mismo tratamiento y no puede volver a cobrarse lo ya cargado.
    const generated = await tx
      .select({ amountCents: patientCharge.amountCents })
      .from(patientCharge)
      .where(
        and(
          eq(patientCharge.organizationId, orgId),
          eq(patientCharge.patientId, patientId),
          eq(patientCharge.planItemId, source.line.planItemId),
          eq(patientCharge.currency, unit),
          isNull(patientCharge.voidedAt),
        ),
      )
    const remaining = Math.max(source.line.priceCents ?? 0, itemPrice ?? 0) - sum(generated)
    if (remaining <= 0)
      throw conflict("CHARGE_EXCEEDS_BUDGET", "El tratamiento ya tiene cargado el importe acordado")
    amountCents ??= remaining
    if (source.line.priceCents == null || amountCents > remaining)
      throw conflict(
        "CHARGE_EXCEEDS_BUDGET",
        "El cargo supera el importe pendiente de generar de este tratamiento",
      )
  } else if (input.encounterProcedureId) {
    const [source] = await tx
      .select({ procedure: encounterProcedure })
      .from(encounterProcedure)
      .innerJoin(
        encounter,
        and(
          eq(encounter.id, encounterProcedure.encounterId),
          eq(encounter.organizationId, orgId),
          eq(encounter.patientId, patientId),
        ),
      )
      .where(
        and(
          eq(encounterProcedure.id, input.encounterProcedureId),
          eq(encounterProcedure.organizationId, orgId),
        ),
      )
    if (!source) throw notFound("Procedimiento")
    // Sin servicio no hay tarifa: el acto libre nunca genera cargo.
    if (!source.procedure.serviceId) {
      throw conflict("ACT_NOT_BILLABLE", "El acto libre no genera cargo (no tiene tarifa)")
    }
    if (planItemId && planItemId !== source.procedure.planItemId)
      throw validation("El cargo conserva el tratamiento de su fuente")
    planItemId = source.procedure.planItemId
    description = source.procedure.description
    // El costo viaja con el acto: importe y moneda del snapshot registrado.
    amountCents ??= source.procedure.priceCents ?? undefined
    unit ??= source.procedure.currency ?? undefined
  }
  if (planItemId) {
    const [item] = await tx
      .select({ id: treatmentPlanItem.id })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, planItemId),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
    if (!item) throw notFound("Tratamiento")
  }
  if (!description || description.length > 2000)
    throw validation("La descripción debe tener 1–2000 caracteres")
  if (amountCents === undefined || !unit)
    throw validation("El importe y la moneda son obligatorios")
  const [row] = await tx
    .insert(patientCharge)
    .values({
      organizationId: orgId,
      patientId,
      planItemId,
      budgetItemId: input.budgetItemId,
      encounterProcedureId: input.encounterProcedureId,
      description,
      amountCents: assertPositiveCents(amountCents),
      currency: currency(unit),
      dueAt: input.dueAt ? instant(input.dueAt) : null,
      notes: input.notes,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "patient_charge", row.id, "charge.created")
  return row
}
export async function voidCharge(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  id: string,
  input: { reason: string },
) {
  await lockAccount(tx, orgId, patientId)
  await chargeRow(tx, orgId, patientId, id)
  const [application] = await tx
    .select({ id: patientPaymentApplication.id })
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
        eq(patientPaymentApplication.chargeId, id),
        isNull(patientPaymentApplication.voidedAt),
      ),
    )
    .limit(1)
  if (application)
    throw conflict("CHARGE_HAS_APPLICATIONS", "Anule las aplicaciones antes de anular el cargo")
  const [row] = await tx
    .update(patientCharge)
    .set({
      voidedAt: new Date(),
      voidedBy: actorUserId,
      voidReason: reason(input.reason),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(patientCharge.id, id),
        eq(patientCharge.organizationId, orgId),
        eq(patientCharge.patientId, patientId),
      ),
    )
    .returning()
  await audit(tx, orgId, actorUserId, "patient_charge", id, "charge.voided")
  return row
}
export interface CreatePaymentInput {
  payerContactId?: string | null
  amountCents: number
  currency: string
  paidAt: string
  method: (typeof PAYMENT_METHODS)[number]
  reference?: string | null
  notes?: string | null
}
export async function createPayment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreatePaymentInput,
) {
  await lockAccount(tx, orgId, patientId)
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.method))
    throw validation("Medio de pago inválido")
  if (input.payerContactId)
    await requireLinkedActiveContact(tx, orgId, patientId, input.payerContactId)
  const [row] = await tx
    .insert(patientPayment)
    .values({
      ...input,
      organizationId: orgId,
      patientId,
      amountCents: assertPositiveCents(input.amountCents),
      currency: currency(input.currency),
      paidAt: instant(input.paidAt),
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "patient_payment", row.id, "payment.created")
  return row
}
export async function applyPayment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  paymentId: string,
  input: { chargeId: string; amountCents: number },
) {
  await lockAccount(tx, orgId, patientId)
  const amount = assertPositiveCents(input.amountCents)
  const payment = await paymentRow(tx, orgId, patientId, paymentId)
  const charge = await chargeRow(tx, orgId, patientId, input.chargeId)
  if (payment.currency !== charge.currency)
    throw conflict("CURRENCY_MISMATCH", "No puede aplicar un pago en otra moneda")
  const balance = await paymentBalance(tx, orgId, patientId, payment)
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
        eq(patientPaymentApplication.chargeId, charge.id),
        isNull(patientPaymentApplication.voidedAt),
      ),
    )
  if (amount > balance.available || amount > charge.amountCents - sum(applications))
    throw conflict(
      "INSUFFICIENT_BALANCE",
      "La aplicación supera el saldo disponible del pago o del cargo",
    )
  const [row] = await tx
    .insert(patientPaymentApplication)
    .values({
      organizationId: orgId,
      patientId,
      paymentId,
      chargeId: charge.id,
      amountCents: amount,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "patient_payment_application", row.id, "payment.applied")
  return row
}
export async function voidPaymentApplication(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  id: string,
  input: { reason: string },
) {
  await lockAccount(tx, orgId, patientId)
  const where = and(
    eq(patientPaymentApplication.id, id),
    eq(patientPaymentApplication.organizationId, orgId),
    eq(patientPaymentApplication.patientId, patientId),
  )
  const [current] = await tx.select().from(patientPaymentApplication).where(where)
  if (!current) throw notFound("Aplicación de pago")
  if (current.voidedAt) throw conflict("APPLICATION_VOIDED", "La aplicación ya está anulada")
  const [row] = await tx
    .update(patientPaymentApplication)
    .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason: reason(input.reason) })
    .where(where)
    .returning()
  await audit(
    tx,
    orgId,
    actorUserId,
    "patient_payment_application",
    id,
    "payment.application_voided",
  )
  return row
}
export async function refundPayment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  paymentId: string,
  input: { amountCents: number; reason: string; refundedAt?: string },
) {
  await lockAccount(tx, orgId, patientId)
  const amount = assertPositiveCents(input.amountCents)
  const payment = await paymentRow(tx, orgId, patientId, paymentId)
  const balance = await paymentBalance(tx, orgId, patientId, payment)
  if (amount > balance.available)
    throw conflict("INSUFFICIENT_CREDIT", "Solo puede devolver el excedente no aplicado")
  const [row] = await tx
    .insert(patientPaymentRefund)
    .values({
      organizationId: orgId,
      patientId,
      paymentId,
      amountCents: amount,
      reason: reason(input.reason),
      refundedAt: input.refundedAt ? instant(input.refundedAt) : new Date(),
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "patient_payment_refund", row.id, "payment.refunded")
  return row
}
export async function voidPayment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  paymentId: string,
  input: { reason: string },
) {
  await lockAccount(tx, orgId, patientId)
  const payment = await paymentRow(tx, orgId, patientId, paymentId)
  const balance = await paymentBalance(tx, orgId, patientId, payment)
  if (balance.applications.length || balance.refunds.length)
    throw conflict("PAYMENT_HAS_MOVEMENTS", "El pago tiene aplicaciones activas o devoluciones")
  const [row] = await tx
    .update(patientPayment)
    .set({
      voidedAt: new Date(),
      voidedBy: actorUserId,
      voidReason: reason(input.reason),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(patientPayment.id, paymentId),
        eq(patientPayment.organizationId, orgId),
        eq(patientPayment.patientId, patientId),
      ),
    )
    .returning()
  await audit(tx, orgId, actorUserId, "patient_payment", paymentId, "payment.voided")
  return row
}
export async function getPatientAccount(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  const charges = await tx
    .select()
    .from(patientCharge)
    .where(and(eq(patientCharge.organizationId, orgId), eq(patientCharge.patientId, patientId)))
    .orderBy(asc(patientCharge.createdAt), asc(patientCharge.id))
  const payments = await tx
    .select()
    .from(patientPayment)
    .where(and(eq(patientPayment.organizationId, orgId), eq(patientPayment.patientId, patientId)))
    .orderBy(asc(patientPayment.paidAt), asc(patientPayment.id))
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
      ),
    )
    .orderBy(asc(patientPaymentApplication.createdAt), asc(patientPaymentApplication.id))
  const refunds = await tx
    .select()
    .from(patientPaymentRefund)
    .where(
      and(
        eq(patientPaymentRefund.organizationId, orgId),
        eq(patientPaymentRefund.patientId, patientId),
      ),
    )
    .orderBy(asc(patientPaymentRefund.refundedAt), asc(patientPaymentRefund.id))
  const agreed = await tx
    .select({ amountCents: treatmentBudgetItem.priceCents, currency: treatmentBudgetItem.currency })
    .from(treatmentBudgetItem)
    .innerJoin(
      treatmentPlanItem,
      and(
        eq(treatmentPlanItem.id, treatmentBudgetItem.planItemId),
        eq(treatmentPlanItem.budgetId, treatmentBudgetItem.budgetId),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
    .innerJoin(
      treatmentBudget,
      and(
        eq(treatmentBudget.id, treatmentBudgetItem.budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.patientId, patientId),
        eq(treatmentPlanItem.decisionStatus, "aceptado"),
        eq(treatmentBudgetItem.decision, "aceptado"),
      ),
    )
  const units = [...new Set([...charges, ...payments, ...agreed].map((r) => r.currency))].sort()
  const byCurrency = units.map((unit) => {
    const unitCharges = charges.filter((r) => r.currency === unit && !r.voidedAt)
    const unitPayments = payments.filter((r) => r.currency === unit && !r.voidedAt)
    const paymentIds = new Set(unitPayments.map((p) => p.id))
    const agreedCents = sum(
      agreed.filter((r) => r.currency === unit).map((r) => ({ amountCents: r.amountCents ?? 0 })),
    )
    const chargedCents = sum(unitCharges)
    const paidCents = sum(unitPayments)
    const appliedCents = sum(applications.filter((a) => paymentIds.has(a.paymentId) && !a.voidedAt))
    const refundedCents = sum(refunds.filter((r) => paymentIds.has(r.paymentId)))
    return {
      currency: unit,
      agreedCents,
      chargedCents,
      paidCents,
      appliedCents,
      refundedCents,
      outstandingCents: chargedCents - appliedCents,
      availableCreditCents: paidCents - appliedCents - refundedCents,
    }
  })
  return { byCurrency, charges, payments, applications, refunds }
}
