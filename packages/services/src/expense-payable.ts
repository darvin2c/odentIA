/**
 * Factura por pagar (ADR 0174): la del laboratorio que llega hoy y se paga a fin de mes, en una vez o
 * en partes. Anotarla no paga ni toca la caja: queda en «Por pagar» con su saldo hasta que sus pagos
 * (gastos enlazados, `createExpense` con `payableId`) la cubren. Puede decir de qué paciente y de qué
 * tratamiento es; su costo se ve junto a lo cobrado solo para quien administra comisiones (la ruta lo
 * decide). Retenciones, planillas y reembolsos al equipo quedan fuera a propósito.
 */
import { contact } from "@odentia/db/schema/crm"
import { patient, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { expense, expensePayable } from "@odentia/db/schema/finance"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import type { Db } from "@odentia/db"
import { formatMoney } from "@odentia/clinical"
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { invalidField, ServiceError, validation } from "./errors.js"
import {
  assertCents,
  EXPENSE_CATEGORIES,
  expensePaper,
  lockPayable,
  lockRequest,
  requestKey,
  requestReused,
  requireBranch,
  STAFF_PAY_CATEGORY,
} from "./finance.js"
import { looksLikeId } from "./ids.js"
import { getOrgLocale } from "./locale.js"
import { joinPatientPerson } from "./patient-identity.js"

export interface NotePayableInput {
  requestId?: string | null
  branchId: string
  /** Por defecto, Laboratorio. Nunca «Personal»: lo del equipo no se anota así. */
  category?: string
  supplierId?: string | null
  supplierName?: string | null
  supplierTaxId?: string | null
  receiptType?: string | null
  receiptNumber?: string | null
  /** `YYYY-MM-DD` en el calendario de la clínica; por defecto, hoy. */
  issuedOn?: string | null
  dueOn?: string | null
  currency?: string
  amountCents: number
  patientId?: string | null
  planItemId?: string | null
  notes?: string | null
}

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

function dayOf(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)))
    throw invalidField(field, "Escribe la fecha como AAAA-MM-DD")
  return value
}

function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

/** «Factura E001-512 · Laboratorio Dental Andino»: lo que se lee en «Por pagar» y en su pago. */
function payableConcept(receiptKind: string, receiptNumber: string | null, supplierName: string): string {
  const paper = receiptKind && receiptKind !== "ninguno" ? receiptKind : "Comprobante"
  return `${paper}${receiptNumber ? ` ${receiptNumber}` : ""} · ${supplierName}`.slice(0, 500)
}

/** Anota la factura: no paga. Reintentar con la misma clave devuelve la misma factura. */
export async function notePayable(tx: Db, orgId: string, actorUserId: string, input: NotePayableInput) {
  const requestId = requestKey(input.requestId)
  if (requestId) {
    await lockRequest(tx, "expense_payable", orgId, requestId)
    const [seen] = await tx
      .select()
      .from(expensePayable)
      .where(and(eq(expensePayable.organizationId, orgId), eq(expensePayable.requestId, requestId)))
    if (seen) {
      if (seen.branchId !== input.branchId || seen.amountCents !== input.amountCents || (input.currency && seen.currency !== input.currency))
        throw requestReused()
      return seen
    }
  }
  const branchRow = await requireBranch(tx, orgId, input.branchId)
  const [profile] = await tx
    .select({ currency: orgProfile.currency, secondCurrency: orgProfile.secondCurrency })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
  const unit = input.currency ?? profile?.currency
  if (!unit || (unit !== profile?.currency && unit !== profile?.secondCurrency))
    throw invalidField("currency", "Esa moneda no es de la clínica")
  const category = input.category?.trim() || "Laboratorio"
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category) || category === STAFF_PAY_CATEGORY)
    throw invalidField("category", "Tipo de gasto inválido para una factura por pagar")
  const amountCents = assertCents(input.amountCents, "El importe", "amountCents")
  const paper = await expensePaper(tx, orgId, input)
  if (!paper.supplierName) throw invalidField("supplierName", "Escribe a quién se le debe")
  const { timezone } = await getOrgLocale(tx, orgId)
  const today = todayIn(timezone)
  const issuedOn = input.issuedOn ? dayOf(input.issuedOn, "issuedOn") : today
  if (issuedOn > today) throw invalidField("issuedOn", "La fecha de emisión no puede ser futura")
  const dueOn = input.dueOn ? dayOf(input.dueOn, "dueOn") : null
  if (dueOn && dueOn < issuedOn) throw invalidField("dueOn", "Vence el mismo día de la emisión o después")
  // De qué paciente y tratamiento (opcional): de esta clínica, y el tratamiento de esa paciente.
  let patientId: string | null = null
  let planItemId: string | null = null
  if (input.patientId) {
    if (!looksLikeId(input.patientId)) throw invalidField("patientId", "Esa paciente no existe")
    const [row] = await tx
      .select({ id: patient.id, lockedAt: contact.recordLockedAt })
      .from(patient)
      .innerJoin(contact, joinPatientPerson())
      .where(and(eq(patient.organizationId, orgId), eq(patient.id, input.patientId)))
    // Una historia bloqueada (ADR 0080) no existe para los demás.
    if (!row || row.lockedAt) throw invalidField("patientId", "Esa paciente no existe")
    patientId = row.id
    if (input.planItemId) {
      if (!looksLikeId(input.planItemId)) throw invalidField("planItemId", "Ese tratamiento no es de esa paciente")
      const [item] = await tx
        .select({ id: treatmentPlanItem.id })
        .from(treatmentPlanItem)
        .where(
          and(
            eq(treatmentPlanItem.organizationId, orgId),
            eq(treatmentPlanItem.patientId, row.id),
            eq(treatmentPlanItem.id, input.planItemId),
          ),
        )
      if (!item) throw invalidField("planItemId", "Ese tratamiento no es de esa paciente")
      planItemId = item.id
    }
  } else if (input.planItemId) throw invalidField("planItemId", "Elige primero la paciente")
  const receiptNumber = paper.receiptType === "sin" ? null : input.receiptNumber?.trim().slice(0, 60) || null
  const [row] = await tx
    .insert(expensePayable)
    .values({
      organizationId: orgId,
      branchId: branchRow.id,
      category,
      concept: payableConcept(paper.receiptKind, receiptNumber, paper.supplierName),
      supplierId: paper.supplierId,
      supplierName: paper.supplierName,
      supplierTaxId: paper.supplierTaxId,
      receiptType: paper.receiptType,
      receiptNumber,
      issuedOn,
      dueOn,
      currency: unit,
      amountCents,
      patientId,
      planItemId,
      notes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
      requestId,
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new Error("No se pudo anotar la factura")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    entity: "expense_payable",
    entityId: row.id,
    action: "finance.payable_noted",
    metadata: null,
  })
  return row
}

/**
 * Las facturas de la clínica con lo pagado y lo que falta. `open`: solo las que aún deben algo. Dice
 * de qué paciente y tratamiento son, sin la historia (un nombre y el título del tratamiento).
 */
export async function listPayables(
  tx: Db,
  orgId: string,
  query: { branchId?: string; patientId?: string; open?: boolean },
) {
  const filters = [eq(expensePayable.organizationId, orgId), isNull(expensePayable.voidedAt)]
  if (query.branchId) filters.push(eq(expensePayable.branchId, query.branchId))
  if (query.patientId) {
    if (!looksLikeId(query.patientId)) return { today: "", payables: [] }
    filters.push(eq(expensePayable.patientId, query.patientId))
  }
  const rows = await tx
    .select({
      payable: expensePayable,
      patientName: contact.displayName,
      patientLocked: contact.recordLockedAt,
      planItemTitle: treatmentPlanItem.title,
      planItemSite: treatmentPlanItem.siteCode,
    })
    .from(expensePayable)
    .leftJoin(patient, and(eq(patient.organizationId, expensePayable.organizationId), eq(patient.id, expensePayable.patientId)))
    .leftJoin(contact, joinPatientPerson())
    .leftJoin(
      treatmentPlanItem,
      and(eq(treatmentPlanItem.organizationId, expensePayable.organizationId), eq(treatmentPlanItem.id, expensePayable.planItemId)),
    )
    .where(and(...filters))
    .orderBy(asc(sql`coalesce(${expensePayable.dueOn}, ${expensePayable.issuedOn})`), asc(expensePayable.createdAt))
  const ids = rows.map((row) => row.payable.id)
  const paid = new Map(
    ids.length
      ? (
          await tx
            .select({ id: expense.payableId, cents: sql<string>`sum(${expense.amountCents})::text` })
            .from(expense)
            .where(and(eq(expense.organizationId, orgId), inArray(expense.payableId, ids), isNull(expense.voidedAt)))
            .groupBy(expense.payableId)
        ).map((row) => [row.id, Number(row.cents)] as const)
      : [],
  )
  const { timezone } = await getOrgLocale(tx, orgId)
  const today = todayIn(timezone)
  const payables = rows
    .map(({ payable, patientName, patientLocked, planItemTitle, planItemSite }) => {
      const paidCents = paid.get(payable.id) ?? 0
      const dueCents = Math.max(0, payable.amountCents - paidCents)
      // Una historia bloqueada (ADR 0080) no dice de quién es.
      const hidden = Boolean(patientLocked)
      return {
        id: payable.id,
        branchId: payable.branchId,
        category: payable.category,
        concept: payable.concept,
        supplierId: payable.supplierId,
        supplierName: payable.supplierName,
        supplierTaxId: payable.supplierTaxId,
        receiptType: payable.receiptType,
        receiptNumber: payable.receiptNumber,
        issuedOn: payable.issuedOn,
        dueOn: payable.dueOn,
        currency: payable.currency,
        amountCents: payable.amountCents,
        paidCents,
        dueCents,
        overdue: dueCents > 0 && payable.dueOn !== null && payable.dueOn < today,
        patientId: hidden ? null : payable.patientId,
        patientName: hidden ? null : patientName,
        planItemId: hidden ? null : payable.planItemId,
        planItemTitle: hidden ? null : planItemTitle,
        planItemSite: hidden ? null : planItemSite,
        notes: payable.notes,
        createdAt: payable.createdAt,
      }
    })
    .filter((row) => !query.open || row.dueCents > 0)
  return { today, payables }
}

/** Anula una factura anotada por error. Con pagos vigentes no: primero se anulan sus pagos. */
export async function voidPayable(tx: Db, orgId: string, actorUserId: string, payableId: string, input: { reason: string }) {
  const reason = input.reason?.trim()
  if (!reason || reason.length > 2000) throw invalidField("reason", "Escribe el motivo")
  const owed = await lockPayable(tx, orgId, payableId)
  if (owed.voidedAt) return owed
  if (owed.paidCents > 0) {
    const { locale } = await getOrgLocale(tx, orgId)
    throw conflict(
      "PAYABLE_HAS_PAYMENTS",
      `Tiene ${formatMoney(owed.paidCents, owed.currency, locale)} pagados: anula primero esos pagos en la lista de gastos`,
    )
  }
  const [row] = await tx
    .update(expensePayable)
    .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason: reason, updatedAt: new Date() })
    .where(and(eq(expensePayable.organizationId, orgId), eq(expensePayable.id, payableId)))
    .returning()
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    entity: "expense_payable",
    entityId: payableId,
    action: "finance.payable_voided",
    metadata: { reason },
  })
  if (!row) throw validation("No se pudo anular la factura")
  return row
}

/**
 * Lo que se debía de facturas por pagar en un momento (Reportes › Lo que debes): lo anotado hasta ese
 * día, menos lo pagado antes de ese momento; lo anulado después todavía contaba. En la moneda pedida.
 */
export async function payablesOwedAt(
  tx: Db,
  orgId: string,
  at: Date,
  query: { branchId?: string; currency: string; timezone: string },
): Promise<{ cents: number; count: number; overdueCents: number }> {
  const day = todayIn(query.timezone, at)
  const branch = query.branchId ? sql`and p.branch_id = ${query.branchId}::uuid` : sql``
  const [row] = await tx.execute<{ cents: string | null; count: number; overdue: string | null }>(sql`
    with owed as (
      select p.due_on,
        p.amount_cents - coalesce((
          select sum(e.amount_cents) from expense e
          where e.organization_id = p.organization_id and e.payable_id = p.id
            and e.spent_at < ${at.toISOString()}::timestamptz
            and (e.voided_at is null or e.voided_at >= ${at.toISOString()}::timestamptz)
        ), 0) as due
      from expense_payable p
      where p.organization_id = ${orgId} and p.currency = ${query.currency} ${branch}
        and p.issued_on <= ${day}::date
        and (p.voided_at is null or p.voided_at >= ${at.toISOString()}::timestamptz)
    )
    select sum(greatest(due, 0))::text as cents, count(*) filter (where due > 0)::int as count,
      sum(greatest(due, 0)) filter (where due_on is not null and due_on < ${day}::date)::text as overdue
    from owed`)
  return { cents: Number(row?.cents ?? 0), count: Number(row?.count ?? 0), overdueCents: Number(row?.overdue ?? 0) }
}
