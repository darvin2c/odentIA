/**
 * Finanzas: caja automática por sede y moneda, gastos con tipo y salida de
 * caja, deudas, cierres inmutables y saldos para Home/Reportes y Portal.
 * Comisiones y resultado del mes viven en su sección (Fases 6 y 8).
 *
 * Convención del repo: cada función recibe un `tx: Db` que YA corre dentro de
 * `withOrgContext(db, orgId, …)`; los servicios nunca abren el contexto.
 * Dinero siempre en enteros de la unidad menor con moneda ISO congelada por
 * documento; la presentación usa la utilidad compartida con el locale del perfil.
 * Sin emisor fiscal ni pasarela: no hay emisión de comprobantes ni cobro online.
 */
import type { Db } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
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
} from "@odentia/db/schema/clinical"
import {
  cashClosure,
  cashMovement,
  cashShift,
  commissionRule,
  commissionSettlement,
  commissionSettlementLine,
  expense,
} from "@odentia/db/schema/finance"
import { supplier } from "@odentia/db/schema/inventory"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { getOrgLocale } from "./locale.js"
import { createWorkspaceNotification } from "./workspace.js"
export const SHIFT_STATUSES = ["abierta", "cerrada"] as const
export const MOVEMENT_KINDS = [
  "apertura",
  "cobro",
  "gasto",
  "aporte",
  "retiro",
  "devolucion",
] as const
export const MOVEMENT_DIRECTIONS = ["ingreso", "egreso"] as const
export const EXPENSE_CATEGORIES = ["Personal", "Alquiler", "Laboratorio", "Materiales", "Servicios", "Impuestos", "Otros"] as const

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

export function assertCents(value: number, field = "El importe"): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
    throw validation(`${field} debe ser un entero positivo de centavos`)
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

function concept(value: string): string {
  const text = value?.trim()
  if (!text || text.length > 500) throw validation("El concepto debe tener 1–500 caracteres")
  return text
}

function instant(value: string): Date {
  const date = new Date(value)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(date.getTime()))
    throw validation("Fecha ISO inválida")
  return date
}

function day(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw validation("La fecha debe tener formato AAAA-MM-DD")
  return value
}

function sumCents(rows: Array<{ amountCents: number }>): number {
  let total = 0
  for (const row of rows) {
    total = addCents(total, row.amountCents)
  }
  return total
}

/** Suma exacta de centavos: revienta antes de salir del rango entero seguro. */
function addCents(a: number, b: number): number {
  const total = a + b
  if (!Number.isSafeInteger(total)) throw validation("El total excede el rango exacto admitido")
  return total
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  entity: string,
  id: string,
  action: string,
): Promise<void> {
  await tx
    .insert(auditEvent)
    .values({ organizationId: orgId, actorUserId, entity, entityId: id, action })
}

export async function requireBranch(tx: Db, orgId: string, branchId: string) {
  const [row] = await tx
    .select()
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.organizationId, orgId)))
  if (!row) throw notFound("Sucursal")
  return row
}
/** Moneda de la clínica con bloqueo compartido: orden perfil→caja, sin deadlocks con el cambio de región. */
async function lockOrgCurrency(tx: Db, orgId: string): Promise<string> {
  const [profile] = await tx
    .select({ currency: orgProfile.currency })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .for("share")
  return profile?.currency ?? "PEN"
}

async function requireShift(tx: Db, orgId: string, shiftId: string) {
  const [row] = await tx
    .select()
    .from(cashShift)
    .where(and(eq(cashShift.id, shiftId), eq(cashShift.organizationId, orgId)))
  if (!row) throw notFound("Turno de caja")
  return row
}

function requireOpenShift(row: typeof cashShift.$inferSelect) {
  if (row.status !== "abierta")
    throw conflict("SHIFT_CLOSED", "El turno ya está cerrado; el histórico no se modifica")
  return row
}

/** Profesional de la organización (regla de comisión y liquidaciones). */
async function requireProfessional(tx: Db, orgId: string, userId: string) {
  const [row] = await tx
    .select()
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
  if (!row) throw notFound("Profesional")
  return row
}

// --- Caja: apertura -----------------------------------------------------------

/**
 * Ventana de caja de una sede y moneda. La caja se crea sola al primer cobro
 * y nunca se abre desde la UI: cobrar jamás se bloquea. La apertura de una
 * ventana nueva es lo que quedó del cierre anterior.
 */
export async function ensureOpenShift(
  tx: Db,
  orgId: string,
  actorUserId: string,
  branchId: string,
  unit: string,
) {
  await requireBranch(tx, orgId, branchId)
  const currencyCode = currency(unit)
  // Una sola ventana por sede y moneda: se serializa antes de leer (sin catch
  // de carrera: el lock transaccional ordena los cobros concurrentes).
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('cash:' || ${orgId} || ':' || ${branchId} || ':' || ${currencyCode}))`,
  )
  const [open] = await tx
    .select()
    .from(cashShift)
    .where(
      and(
        eq(cashShift.organizationId, orgId),
        eq(cashShift.branchId, branchId),
        eq(cashShift.currency, currencyCode),
        eq(cashShift.status, "abierta"),
      ),
    )
    .limit(1)
  if (open) return open
  // Lo que quedó del último cierre abre la ventana nueva.
  const [last] = await tx
    .select()
    .from(cashShift)
    .where(
      and(
        eq(cashShift.organizationId, orgId),
        eq(cashShift.branchId, branchId),
        eq(cashShift.currency, currencyCode),
        eq(cashShift.status, "cerrada"),
      ),
    )
    .orderBy(desc(cashShift.closedAt), desc(cashShift.id))
    .limit(1)
  const opening = last?.retainedCents ?? 0
  const [shift] = await tx
    .insert(cashShift)
    .values({
      organizationId: orgId,
      branchId,
      currency: currencyCode,
      openingCents: opening,
      status: "abierta",
      openedBy: actorUserId,
    })
    .returning()
  if (!shift) throw new ServiceError("INTERNAL", 409, "No se pudo abrir la caja")
  if (opening > 0) {
    await tx.insert(cashMovement).values({
      organizationId: orgId,
      shiftId: shift.id,
      direction: "ingreso",
      kind: "apertura",
      amountCents: opening,
      currency: currencyCode,
      concept: "Quedó del cierre anterior",
      createdBy: actorUserId,
    })
  }
  await audit(tx, orgId, actorUserId, "cash_shift", shift.id, "cash.shift_opened")
  return shift
}

export async function listShifts(
  tx: Db,
  orgId: string,
  query: { branchId?: string; status?: "abierta" | "cerrada" },
) {
  const filters = [eq(cashShift.organizationId, orgId)]
  if (query.branchId) filters.push(eq(cashShift.branchId, query.branchId))
  if (query.status) filters.push(eq(cashShift.status, query.status))
  return tx
    .select()
    .from(cashShift)
    .where(and(...filters))
    .orderBy(desc(cashShift.openedAt), desc(cashShift.id))
}

/** Un cobro es electrónico por su tipo UN/CEFACT (10 = efectivo); el histórico sin tipo usa el nombre. */
function isElectronic(m: { kind: string; methodTypeCode: string | null; method: string | null }): boolean {
  if (m.kind !== "cobro") return false
  if (m.methodTypeCode) return m.methodTypeCode !== "10"
  return m.method !== null && m.method !== "efectivo"
}

/** Turno con movimientos vigentes y esperado de efectivo calculado en vivo. */
export async function getShiftDetail(tx: Db, orgId: string, shiftId: string) {
  const shift = await requireShift(tx, orgId, shiftId)
  const movements = await tx
    .select()
    .from(cashMovement)
    .where(
      and(
        eq(cashMovement.organizationId, orgId),
        eq(cashMovement.shiftId, shiftId),
        isNull(cashMovement.voidedAt),
      ),
    )
    .orderBy(asc(cashMovement.createdAt), asc(cashMovement.id))
  const cashIn = movements.filter((m) => m.direction === "ingreso" && !isElectronic(m))
  const electronic = movements.filter((m) => m.direction === "ingreso" && isElectronic(m))
  const out = movements.filter((m) => m.direction === "egreso")
  const ingresosCents = sumCents(cashIn.map((m) => ({ amountCents: m.amountCents })))
  const electronicosCents = sumCents(electronic.map((m) => ({ amountCents: m.amountCents })))
  const egresosCents = sumCents(out.map((m) => ({ amountCents: m.amountCents })))
  return {
    shift,
    movements,
    ingresosCents,
    electronicosCents,
    egresosCents,
    esperadoCents: ingresosCents - egresosCents,
  }
}

// --- Caja: movimientos ----------------------------------------------------------

export interface AddMovementInput {
  direction: "ingreso" | "egreso"
  kind: "aporte" | "retiro"
  amountCents: number
  concept: string
}

/**
 * Ingresa o retira efectivo de la ventana abierta (único movimiento manual).
 * Cobros, gastos y devoluciones entran por su propio flujo, nunca a mano.
 */
export async function addShiftMovement(
  tx: Db,
  orgId: string,
  actorUserId: string,
  shiftId: string,
  input: AddMovementInput,
) {
  const shift = requireOpenShift(await requireShift(tx, orgId, shiftId))
  if (!MOVEMENT_DIRECTIONS.includes(input.direction)) throw validation("Dirección inválida")
  if (!["aporte", "retiro"].includes(input.kind))
    throw validation("Los cobros, gastos y devoluciones se registran por su propio flujo")
  const amount = assertCents(input.amountCents)
  // El efectivo nunca queda negativo: el egreso no supera el contado actual.
  if (input.direction === "egreso") await requireCashAvailable(tx, orgId, shift.id, amount)
  const [row] = await tx
    .insert(cashMovement)
    .values({
      organizationId: orgId,
      shiftId: shift.id,
      direction: input.direction,
      kind: input.kind,
      amountCents: amount,
      currency: shift.currency,
      concept: concept(input.concept),
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "cash_movement", row.id, "cash.movement_added")
  return row
}

/**
 * El efectivo nunca queda negativo: un egreso exige contado suficiente en la
 * ventana (gasto, retiro, devolución y compensación por igual).
 */
async function requireCashAvailable(tx: Db, orgId: string, shiftId: string, amountCents: number) {
  const detail = await getShiftDetail(tx, orgId, shiftId)
  if (amountCents > detail.esperadoCents)
    throw conflict("INSUFFICIENT_CASH", "La caja no tiene efectivo suficiente para este egreso")
}

export interface CashIncomeInput {
  paymentId: string
  amountCents: number
  currency: string
  methodName: string
  methodTypeCode: string | null
  concept: string
}

/**
 * Deja un cobro real en la ventana abierta, una sola vez y en la misma
 * moneda. Solo el efectivo (tipo 10) suma al contado del arqueo; los demás
 * medios quedan trazados como electrónicos sin entrar al contado.
 */
export async function recordCashIncome(
  tx: Db,
  orgId: string,
  actorUserId: string,
  shiftId: string,
  input: CashIncomeInput,
) {
  const shift = requireOpenShift(await requireShift(tx, orgId, shiftId))
  if (input.currency !== shift.currency)
    throw conflict("CURRENCY_MISMATCH", "El pago es de otra moneda que la caja")
  // Un cobro entra una sola vez: se comprueba antes de insertar (sin catch de
  // carrera; la unicidad parcial lo respalda y el flujo serio nunca reintenta).
  const [existing] = await tx
    .select({ id: cashMovement.id })
    .from(cashMovement)
    .where(
      and(
        eq(cashMovement.organizationId, orgId),
        eq(cashMovement.patientPaymentId, input.paymentId),
        isNull(cashMovement.voidedAt),
      ),
    )
    .limit(1)
  if (existing) throw conflict("PAYMENT_ALREADY_IN_SHIFT", "Ese cobro ya ingresó a la caja")
  const [row] = await tx
    .insert(cashMovement)
    .values({
      organizationId: orgId,
      shiftId: shift.id,
      direction: "ingreso",
      kind: "cobro",
      amountCents: assertCents(input.amountCents),
      currency: input.currency,
      method: input.methodName.slice(0, 60),
      methodTypeCode: input.methodTypeCode,
      concept: concept(input.concept),
      patientPaymentId: input.paymentId,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "cash_movement", row.id, "cash.payment_registered")
  return row
}

export interface CashEgresoInput {
  kind: "gasto" | "devolucion" | "retiro"
  amountCents: number
  currency: string
  methodName?: string | null
  methodTypeCode?: string | null
  concept: string
  expenseId?: string | null
  /**
   * Compensación administrativa post-cierre: corrección del día que puede
   * dejar el contado en negativo (el test fija -10000). Los egresos
   * voluntarios (gasto, retiro, devolución) nunca dejan la caja en negativo.
   */
  allowNegative?: boolean
}

/** Egreso de dominio (gasto de caja, devolución o compensación) en la ventana abierta. */
export async function recordCashEgreso(
  tx: Db,
  orgId: string,
  actorUserId: string,
  shiftId: string,
  input: CashEgresoInput,
) {
  const shift = requireOpenShift(await requireShift(tx, orgId, shiftId))
  if (input.currency !== shift.currency)
    throw conflict("CURRENCY_MISMATCH", "El egreso es de otra moneda que la caja")
  const amount = assertCents(input.amountCents)
  if (!input.allowNegative) await requireCashAvailable(tx, orgId, shift.id, amount)
  const [row] = await tx
    .insert(cashMovement)
    .values({
      organizationId: orgId,
      shiftId: shift.id,
      direction: "egreso",
      kind: input.kind,
      amountCents: amount,
      currency: input.currency,
      method: input.methodName?.slice(0, 60) ?? null,
      methodTypeCode: input.methodTypeCode ?? null,
      concept: concept(input.concept),
      expenseId: input.expenseId ?? null,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "cash_movement", row.id, "cash.egreso_recorded")
  return row
}

/**
 * Revierte el ingreso a caja de un pago anulado. Con la ventana abierta se
 * anula el movimiento; con la ventana cerrada (inmutable) el dinero sale de
 * la ventana actual de la misma sede y moneda como compensación. Devuelve si
 * compensó (para que el ticket lo refleje).
 */
export async function reverseCashIncome(
  tx: Db,
  orgId: string,
  actorUserId: string,
  payment: typeof patientPayment.$inferSelect,
  voidReason: string,
  allowPostClose: boolean,
): Promise<boolean> {
  const [movement] = await tx
    .select()
    .from(cashMovement)
    .where(
      and(
        eq(cashMovement.organizationId, orgId),
        eq(cashMovement.patientPaymentId, payment.id),
        isNull(cashMovement.voidedAt),
      ),
    )
  if (!movement) return false
  const shift = await requireShift(tx, orgId, movement.shiftId)
  if (shift.status === "abierta") {
    await tx
      .update(cashMovement)
      .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason })
      .where(eq(cashMovement.id, movement.id))
    await audit(tx, orgId, actorUserId, "cash_movement", movement.id, "cash.movement_voided")
    return false
  }
  if (!allowPostClose)
    throw conflict(
      "POST_CLOSE_NEEDS_ADMIN",
      "La caja donde ingresó el cobro ya cerró y no se modifica: solo administración puede anularlo",
    )
  const current = await ensureOpenShift(tx, orgId, actorUserId, shift.branchId, payment.currency)
  await recordCashEgreso(tx, orgId, actorUserId, current.id, {
    kind: "devolucion",
    amountCents: payment.amountCents,
    currency: payment.currency,
    methodName: payment.methodName ?? payment.method,
    methodTypeCode: payment.methodTypeCode,
    concept: `Compensación por anulación`,
    allowNegative: true,
  })
  return true
}

export async function voidMovement(
  tx: Db,
  orgId: string,
  actorUserId: string,
  movementId: string,
  input: { reason: string },
) {
  const [current] = await tx
    .select()
    .from(cashMovement)
    .where(and(eq(cashMovement.id, movementId), eq(cashMovement.organizationId, orgId)))
  if (!current) throw notFound("Movimiento")
  if (current.voidedAt) throw conflict("MOVEMENT_VOIDED", "El movimiento ya está anulado")
  requireOpenShift(await requireShift(tx, orgId, current.shiftId))
  if (current.kind === "apertura")
    throw conflict("OPENING_IMMUTABLE", "La apertura solo se corrige cerrando el turno con arqueo")
  // Anular un ingreso en efectivo tampoco deja el contado negativo.
  if (current.direction === "ingreso" && !isElectronic(current)) {
    const detail = await getShiftDetail(tx, orgId, current.shiftId)
    if (current.amountCents > detail.esperadoCents)
      throw conflict("INSUFFICIENT_CASH", "Anularlo dejaría la caja en negativo")
  }
  const [row] = await tx
    .update(cashMovement)
    .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason: reason(input.reason) })
    .where(and(eq(cashMovement.id, movementId), eq(cashMovement.organizationId, orgId)))
    .returning()
  await audit(tx, orgId, actorUserId, "cash_movement", movementId, "cash.movement_voided")
  return row
}

// --- Caja: cierre / arqueo ------------------------------------------------------

export interface CloseShiftInput {
  countedCents: number
  /** Lo que queda en caja para mañana y lo que se entrega: suman el contado. */
  retainedCents: number
  deliveredCents: number
  notes?: string | null
}

/**
 * Cierra la ventana con arqueo: congela esperado en efectivo, electrónico,
 * contado, diferencia (contado − esperado), lo que queda y lo que se entrega.
 * Crea el cierre inmutable, abre la ventana siguiente con lo que quedó y
 * avisa a administración y a quien abrió si el efectivo no cuadra. El cierre
 * es de una sola vez (lock + trigger); lo posterior corrige como movimiento
 * del día en que se corrige. Permiso en ruta: `finance.close`.
 */
export async function closeShift(
  tx: Db,
  orgId: string,
  actorUserId: string,
  shiftId: string,
  input: CloseShiftInput,
) {
  const [locked] = await tx
    .select()
    .from(cashShift)
    .where(and(eq(cashShift.id, shiftId), eq(cashShift.organizationId, orgId)))
    .for("update")
  if (!locked) throw notFound("Turno de caja")
  if (locked.status === "cerrada") return locked
  if (!Number.isSafeInteger(input.countedCents) || input.countedCents < 0)
    throw validation("El contado debe ser un entero de centavos mayor o igual a 0")
  for (const [value, label] of [[input.retainedCents, "Lo que queda"], [input.deliveredCents, "Lo que se entrega"]] as const) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw validation(`${label} debe ser un entero de centavos mayor o igual a 0`)
  }
  if (input.retainedCents + input.deliveredCents !== input.countedCents)
    throw validation("Lo que queda más lo que se entrega suma el contado")
  const detail = await getShiftDetail(tx, orgId, shiftId)
  const closedAt = new Date()
  const difference = input.countedCents - detail.esperadoCents
  const byMethod: Record<string, { name: string; count: number; amountCents: number }> = {}
  for (const m of detail.movements) {
    if (m.direction !== "ingreso" || m.kind !== "cobro" || !isElectronic(m)) continue
    const name = m.method ?? "Otro"
    const entry = byMethod[name] ?? { name, count: 0, amountCents: 0 }
    entry.count += 1
    entry.amountCents = addCents(entry.amountCents, m.amountCents)
    byMethod[name] = entry
  }
  const cashCollected = sumCents(
    detail.movements
      .filter((m) => m.direction === "ingreso" && m.kind === "cobro" && !isElectronic(m))
      .map((m) => ({ amountCents: m.amountCents })),
  )
  // Solo los gastos son gasto: retiros y devoluciones son egresos, no gasto.
  const expenseCash = sumCents(
    detail.movements
      .filter((m) => m.direction === "egreso" && m.kind === "gasto")
      .map((m) => ({ amountCents: m.amountCents })),
  )
  const [row] = await tx
    .update(cashShift)
    .set({
      status: "cerrada",
      closedBy: actorUserId,
      closedAt,
      expectedCents: detail.esperadoCents,
      electronicCents: detail.electronicosCents,
      countedCents: input.countedCents,
      differenceCents: difference,
      retainedCents: input.retainedCents,
      deliveredCents: input.deliveredCents,
      closeNotes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
    })
    .where(and(eq(cashShift.id, shiftId), eq(cashShift.organizationId, orgId)))
    .returning()
  await tx.insert(cashClosure).values({
    organizationId: orgId,
    branchId: locked.branchId,
    currency: locked.currency,
    shiftId: locked.id,
    windowFrom: locked.openedAt,
    windowTo: closedAt,
    openingRetainedCents: locked.openingCents,
    cashCollectedCents: cashCollected,
    expenseCashCents: expenseCash,
    expectedCents: detail.esperadoCents,
    countedCents: input.countedCents,
    differenceCents: difference,
    retainedCents: input.retainedCents,
    deliveredCents: input.deliveredCents,
    totalsByMethod: Object.values(byMethod),
    notes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
    closedBy: actorUserId,
    closedAt,
  })
  await audit(tx, orgId, actorUserId, "cash_shift", shiftId, "cash.shift_closed")
  // La ventana siguiente abre sola con lo que quedó.
  await ensureOpenShift(tx, orgId, actorUserId, locked.branchId, locked.currency)
  if (difference !== 0) {
    const recipients = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.role, "admin")))
    const userIds = [...new Set([...recipients.map((r) => r.userId), locked.openedBy].filter((id): id is string => !!id && id !== actorUserId))]
    for (const userId of userIds) {
      await createWorkspaceNotification(tx, orgId, {
        userId,
        dedupeKey: `cash-shift-diff:${shiftId}`,
        title: "Arqueo con diferencia",
        body: `La caja cerró con una diferencia de ${difference} centavos (${locked.currency}).`,
        href: `/finance?turno=${shiftId}`,
        permission: "finance.read",
      })
    }
  }
  return row
}

export interface CloseCashInput extends CloseShiftInput {
  branchId: string
  currency?: string
}

/** Cierra la ventana actual de una sede y moneda (la crea si no existe). */
export async function closeCashWindow(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CloseCashInput,
) {
  const unit = input.currency ? currency(input.currency) : await lockOrgCurrency(tx, orgId)
  const shift = await ensureOpenShift(tx, orgId, actorUserId, input.branchId, unit)
  return closeShift(tx, orgId, actorUserId, shift.id, input)
}

// --- Gastos (formulario corto; los proveedores quedan solo en Inventario) -------------------

export interface CreateExpenseInput {
  branchId: string
  category?: string
  concept: string
  amountCents: number
  currency?: string
  spentAt?: string | null
  receiptKind?: string
  receiptNumber?: string | null
  notes?: string | null
  /** Con salida del efectivo de la caja (descuenta del contado al cerrar). */
  fromCash?: boolean
}

/**
 * Registra un gasto con su tipo. Con `fromCash` el egreso sale del efectivo
 * de la ventana abierta (movimiento + gasto en la misma transacción); sin
 * caja es gasto directo. Sin proveedor ni turno a mano.
 */
export async function createExpense(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateExpenseInput,
) {
  const branchRow = await requireBranch(tx, orgId, input.branchId)
  const unit = input.currency ? currency(input.currency) : await lockOrgCurrency(tx, orgId)
  const category = input.category?.trim() || "Otros"
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category))
    throw validation("Tipo de gasto inválido")
  // Comprobante libre según país (el catálogo fiscal llega con su módulo).
  const receiptKind = input.receiptKind?.trim() ? input.receiptKind.trim().slice(0, 60) : "ninguno"
  const shift = input.fromCash
    ? await ensureOpenShift(tx, orgId, actorUserId, branchRow.id, unit)
    : null
  const [row] = await tx
    .insert(expense)
    .values({
      organizationId: orgId,
      branchId: branchRow.id,
      shiftId: shift?.id ?? null,
      concept: concept(input.concept),
      category,
      amountCents: assertCents(input.amountCents, "El gasto"),
      currency: unit,
      spentAt: input.spentAt ? instant(input.spentAt) : new Date(),
      receiptKind,
      receiptNumber: input.receiptNumber?.trim() || null,
      notes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
      createdBy: actorUserId,
    })
    .returning()
  if (shift) {
    await recordCashEgreso(tx, orgId, actorUserId, shift.id, {
      kind: "gasto",
      amountCents: row.amountCents,
      currency: row.currency,
      concept: row.concept,
      expenseId: row.id,
    })
  }
  await audit(tx, orgId, actorUserId, "expense", row.id, "finance.expense_created")
  return row
}

export async function listExpenses(
  tx: Db,
  orgId: string,
  query: { branchId?: string; category?: string; from?: string; to?: string; limit?: number },
) {
  const filters = [eq(expense.organizationId, orgId), isNull(expense.voidedAt)]
  if (query.branchId) filters.push(eq(expense.branchId, query.branchId))
  if (query.category) filters.push(eq(expense.category, query.category))
  if (query.from) filters.push(gte(expense.spentAt, instant(`${query.from}T00:00:00.000Z`)))
  if (query.to) filters.push(lte(expense.spentAt, instant(`${query.to}T23:59:59.999Z`)))
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  return tx
    .select()
    .from(expense)
    .where(and(...filters))
    .orderBy(desc(expense.spentAt), desc(expense.id))
    .limit(limit)
}



/**
 * Anula un gasto con motivo. Si su turno sigue abierto, también anula el
 * movimiento de caja chica; si el turno ya cerró, el movimiento queda como
 * histórico preservado y solo se marca el gasto.
 */
export async function voidExpense(
  tx: Db,
  orgId: string,
  actorUserId: string,
  expenseId: string,
  input: { reason: string },
) {
  const [current] = await tx
    .select()
    .from(expense)
    .where(and(eq(expense.id, expenseId), eq(expense.organizationId, orgId)))
  if (!current) throw notFound("Gasto")
  if (current.voidedAt) throw conflict("EXPENSE_VOIDED", "El gasto ya está anulado")
  const [row] = await tx
    .update(expense)
    .set({
      voidedAt: new Date(),
      voidedBy: actorUserId,
      voidReason: reason(input.reason),
      updatedAt: new Date(),
    })
    .where(and(eq(expense.id, expenseId), eq(expense.organizationId, orgId)))
    .returning()
  if (current.shiftId) {
    const shift = await requireShift(tx, orgId, current.shiftId)
    if (shift.status === "abierta") {
      const [movement] = await tx
        .select()
        .from(cashMovement)
        .where(
          and(
            eq(cashMovement.organizationId, orgId),
            eq(cashMovement.expenseId, expenseId),
            isNull(cashMovement.voidedAt),
          ),
        )
      if (movement) {
        await tx
          .update(cashMovement)
          .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason: reason(input.reason) })
          .where(eq(cashMovement.id, movement.id))
        await audit(tx, orgId, actorUserId, "cash_movement", movement.id, "cash.movement_voided")
      }
    }
  }
  await audit(tx, orgId, actorUserId, "expense", expenseId, "finance.expense_voided")
  return row
}

// --- Cuentas por cobrar ------------------------------------------------------------

/**
 * Cuentas por cobrar por paciente y moneda: cargos vigentes menos aplicaciones
 * vigentes. Contrato para Reportes y Portal (saldo del paciente).
 */
export async function getReceivables(
  tx: Db,
  orgId: string,
  query: { patientId?: string; branchId?: string } = {},
) {
  const chargeFilter = [eq(patientCharge.organizationId, orgId), isNull(patientCharge.voidedAt)]
  if (query.patientId) chargeFilter.push(eq(patientCharge.patientId, query.patientId))
  if (query.branchId) chargeFilter.push(eq(patientCharge.branchId, query.branchId))
  const charges = await tx
    .select()
    .from(patientCharge)
    .where(and(...chargeFilter))
    .orderBy(asc(patientCharge.createdAt), asc(patientCharge.id))
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        isNull(patientPaymentApplication.voidedAt),
        ...(query.patientId ? [eq(patientPaymentApplication.patientId, query.patientId)] : []),
      ),
    )
  const appliedByCharge = new Map<string, number>()
  for (const app of applications) {
    appliedByCharge.set(app.chargeId, (appliedByCharge.get(app.chargeId) ?? 0) + app.amountCents)
  }
  return charges.map((charge) => {
    const applied = appliedByCharge.get(charge.id) ?? 0
    return { charge, appliedCents: applied, outstandingCents: charge.amountCents - applied }
  })
}

/**
 * Saldo de un paciente para el Portal: por cobrar, crédito real disponible
 * (pagado − aplicado − devuelto) e historial de pagos. Solo lectura.
 */
export async function getPatientBalanceForPortal(
  tx: Db,
  orgId: string,
  patientId: string,
) {
  const rows = await getReceivables(tx, orgId, { patientId })
  const payments = await tx
    .select()
    .from(patientPayment)
    .where(and(eq(patientPayment.organizationId, orgId), eq(patientPayment.patientId, patientId)))
    .orderBy(asc(patientPayment.paidAt), asc(patientPayment.id))
  const livePayments = payments.filter((p) => !p.voidedAt)
  const liveIds = new Set(livePayments.map((p) => p.id))
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.patientId, patientId),
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
      ),
    )
  type Totals = {
    outstandingCents: number
    chargedCents: number
    paidCents: number
    appliedCents: number
    refundedCents: number
    availableCreditCents: number
  }
  const byCurrency = new Map<string, Totals>()
  const totals = (unit: string): Totals => {
    let entry = byCurrency.get(unit)
    if (!entry) {
      entry = {
        outstandingCents: 0,
        chargedCents: 0,
        paidCents: 0,
        appliedCents: 0,
        refundedCents: 0,
        availableCreditCents: 0,
      }
      byCurrency.set(unit, entry)
    }
    return entry
  }
  for (const row of rows) {
    const entry = totals(row.charge.currency)
    entry.outstandingCents = addCents(entry.outstandingCents, row.outstandingCents)
    entry.chargedCents = addCents(entry.chargedCents, row.charge.amountCents)
  }
  for (const payment of livePayments) {
    const entry = totals(payment.currency)
    entry.paidCents = addCents(entry.paidCents, payment.amountCents)
  }
  for (const app of applications) {
    if (!liveIds.has(app.paymentId)) continue
    const payment = livePayments.find((p) => p.id === app.paymentId)
    if (!payment) continue
    const entry = totals(payment.currency)
    entry.appliedCents = addCents(entry.appliedCents, app.amountCents)
  }
  for (const refund of refunds) {
    if (!liveIds.has(refund.paymentId)) continue
    const payment = livePayments.find((p) => p.id === refund.paymentId)
    if (!payment) continue
    const entry = totals(payment.currency)
    entry.refundedCents = addCents(entry.refundedCents, refund.amountCents)
  }
  for (const entry of byCurrency.values()) {
    entry.availableCreditCents = entry.paidCents - entry.appliedCents - entry.refundedCents
  }
  return {
    byCurrency: [...byCurrency.entries()].map(([unit, entry]) => ({ currency: unit, ...entry })),
    charges: rows,
    payments: livePayments,
  }
}


// --- Comisiones y resultado del mes (Fases 6 y 8) --------------------------------------
//
// Comisiones simples: un porcentaje único por profesional sobre lo cobrado de
// lo que atendió (aplicaciones vigentes sobre cargos con procedimiento de una
// atención finalizada; lo que caja agrega sin atención no cuenta para nadie).
// Neto de devoluciones (cada devolución consume primero el saldo sin aplicar
// del pago; solo el excedente reduce la base comisionable) y de anulaciones
// (cada entidad cuenta si no fue anulada dentro del mes; lo anulado en el mes
// corrige como movimiento de ese mes, el histórico no se reescribe).
// Mes en la zona horaria de la organización; monedas nunca mezcladas.
// Resultado del mes: cobrado desde `patient_payment` (los aportes de caja no
// son ingreso), gastado desde `expense` por categoría, queda = neto − gasto,
// coherencia con cierres vía `cash_closure`, deuda al fin de mes por fecha.

/** Categoría del gasto que registra el pago de una liquidación (la define y
 * valida CobrosCaja en `createExpense`; aquí solo se usa el literal). */
const COMMISSION_EXPENSE_CATEGORY = "Personal"

/** Límites UTC de un mes civil en la zona horaria indicada. */
function monthBounds(timezone: string, year: number, month: number): { start: Date; end: Date } {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw validation("Año inválido")
  if (!Number.isInteger(month) || month < 1 || month > 12) throw validation("Mes inválido")
  const offsetAt = (utc: Date): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(utc)
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
    return (
      (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) -
        utc.getTime()) /
      60000
    )
  }
  const firstOf = (y: number, m: number): Date => {
    let utc = Date.UTC(y, m - 1, 1, 0, 0, 0)
    for (let i = 0; i < 3; i += 1) utc = Date.UTC(y, m - 1, 1, 0, 0, 0) - offsetAt(new Date(utc)) * 60000
    return new Date(utc)
  }
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }
  return { start: firstOf(year, month), end: firstOf(next.y, next.m) }
}

/** Vigente en el mes: no anulado, o anulado después del fin de mes. */
function liveInMonth(voidedAt: Date | null, end: Date): boolean {
  return voidedAt === null || voidedAt >= end
}

/** Efectivo por tipo UN/CEFACT 4461 ('10'); histórico sin tipo usa `method`. */
function methodCashOf(payment: { methodTypeCode: string | null; method: string }): boolean {
  return payment.methodTypeCode ? payment.methodTypeCode === "10" : payment.method === "efectivo"
}

async function userNames(tx: Db, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await tx
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(inArray(user.id, unique))
  return new Map(rows.map((r) => [r.id, r.name]))
}

async function paymentTotalsOf(
  tx: Db,
  orgId: string,
  paymentIds: string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(paymentIds)]
  if (unique.length === 0) return new Map()
  const rows = await tx
    .select({ id: patientPayment.id, amountCents: patientPayment.amountCents })
    .from(patientPayment)
    .where(and(eq(patientPayment.organizationId, orgId), inArray(patientPayment.id, unique)))
  return new Map(rows.map((r) => [r.id, r.amountCents]))
}

/** Fija o actualiza el porcentaje único de un profesional (puntos básicos). */
export async function setCommissionRate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { professionalUserId: string; rateBps: number },
) {
  await requireProfessional(tx, orgId, input.professionalUserId)
  if (!Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 10000)
    throw validation("La tasa debe estar entre 0 y 10000 puntos básicos")
  const [existing] = await tx
    .select()
    .from(commissionRule)
    .where(
      and(
        eq(commissionRule.organizationId, orgId),
        eq(commissionRule.professionalUserId, input.professionalUserId),
      ),
    )
  if (existing) {
    const [row] = await tx
      .update(commissionRule)
      .set({ rateBps: input.rateBps, updatedAt: new Date() })
      .where(eq(commissionRule.id, existing.id))
      .returning()
    await audit(tx, orgId, actorUserId, "commission_rule", row.id, "finance.rule_updated")
    return row
  }
  const [row] = await tx
    .insert(commissionRule)
    .values({
      organizationId: orgId,
      professionalUserId: input.professionalUserId,
      rateBps: input.rateBps,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "commission_rule", row.id, "finance.rule_created")
  return row
}

export async function listCommissionRates(
  tx: Db,
  orgId: string,
  query: { professionalUserId?: string } = {},
) {
  const filters = [eq(commissionRule.organizationId, orgId)]
  if (query.professionalUserId)
    filters.push(eq(commissionRule.professionalUserId, query.professionalUserId))
  const rows = await tx
    .select()
    .from(commissionRule)
    .where(and(...filters))
    .orderBy(asc(commissionRule.professionalUserId))
  const names = await userNames(
    tx,
    rows.map((r) => r.professionalUserId),
  )
  return rows.map((r) => ({ ...r, professionalName: names.get(r.professionalUserId) ?? null }))
}

async function commissionRateOf(tx: Db, orgId: string, professionalUserId: string): Promise<number> {
  const [rule] = await tx
    .select({ rateBps: commissionRule.rateBps })
    .from(commissionRule)
    .where(
      and(
        eq(commissionRule.organizationId, orgId),
        eq(commissionRule.professionalUserId, professionalUserId),
      ),
    )
  return rule?.rateBps ?? 0
}

interface CollectedApp {
  appId: string
  appCents: number
  appCreatedAt: Date
  chargeId: string
  chargeDescription: string
  chargeCurrency: string
  chargePromotionId: string | null
  chargePromotionName: string | null
  chargeBudgetItemId: string | null
  paymentId: string
  paymentCents: number
  paidAt: Date
  methodLabel: string
  cashMethod: boolean
  patientId: string
  dentistUserId: string
}

/**
 * Aplicación con promoción para el resultado del mes: lo mínimo para
 * netear devoluciones y resolver la promoción, sin filtro de atención ni
 * profesional (las promociones cobradas sin atención también cuentan).
 */
interface PromotionApp {
  appId: string
  appCents: number
  appCreatedAt: Date
  chargeId: string
  chargePromotionId: string | null
  chargePromotionName: string | null
  chargeBudgetItemId: string | null
  paymentId: string
}

/**
 * Aplicaciones cobradas en la ventana: vigentes en el mes sobre cargos con
 * procedimiento de una atención finalizada no anulada. Excluye cargos
 * manuales sin atención y actos anulados o de atenciones no finalizadas.
 */
async function collectedApplications(
  tx: Db,
  orgId: string,
  start: Date,
  end: Date,
  currency: string,
  query: { professionalUserId?: string; branchId?: string } = {},
): Promise<CollectedApp[]> {
  const filters = [
    eq(patientPaymentApplication.organizationId, orgId),
    gte(patientPaymentApplication.createdAt, start),
    lt(patientPaymentApplication.createdAt, end),
    or(isNull(patientPaymentApplication.voidedAt), gte(patientPaymentApplication.voidedAt, end)),
    eq(patientCharge.currency, currency),
    or(isNull(patientCharge.voidedAt), gte(patientCharge.voidedAt, end)),
    or(isNull(patientPayment.voidedAt), gte(patientPayment.voidedAt, end)),
    isNull(encounterProcedure.voidedAt),
    eq(encounter.status, "finalizada"),
    isNull(encounter.voidedAt),
  ]
  if (query.professionalUserId) filters.push(eq(encounter.dentistUserId, query.professionalUserId))
  if (query.branchId) filters.push(eq(patientPayment.branchId, query.branchId))
  const rows = await tx
    .select({
      app: patientPaymentApplication,
      charge: patientCharge,
      payment: patientPayment,
      dentistUserId: encounter.dentistUserId,
    })
    .from(patientPaymentApplication)
    .innerJoin(
      patientPayment,
      and(
        eq(patientPayment.id, patientPaymentApplication.paymentId),
        eq(patientPayment.organizationId, orgId),
      ),
    )
    .innerJoin(
      patientCharge,
      and(
        eq(patientCharge.id, patientPaymentApplication.chargeId),
        eq(patientCharge.organizationId, orgId),
      ),
    )
    .innerJoin(
      encounterProcedure,
      and(
        eq(encounterProcedure.id, patientCharge.encounterProcedureId),
        eq(encounterProcedure.organizationId, orgId),
      ),
    )
    .innerJoin(
      encounter,
      and(eq(encounter.id, encounterProcedure.encounterId), eq(encounter.organizationId, orgId)),
    )
    .where(and(...filters))
  return rows.map((r) => ({
    appId: r.app.id,
    appCents: r.app.amountCents,
    appCreatedAt: r.app.createdAt,
    chargeId: r.charge.id,
    chargeDescription: r.charge.description,
    chargeCurrency: r.charge.currency,
    chargePromotionId: r.charge.promotionId,
    chargePromotionName: r.charge.promotionName,
    chargeBudgetItemId: r.charge.budgetItemId,
    paymentId: r.payment.id,
    paymentCents: r.payment.amountCents,
    paidAt: r.payment.paidAt,
    methodLabel: r.payment.methodName ?? r.payment.method,
    cashMethod: methodCashOf(r.payment),
    patientId: r.app.patientId,
    dentistUserId: r.dentistUserId,
  }))
}

/**
 * Aplicaciones cobradas en la ventana sobre TODOS los cargos (con o sin
 * atención): base del desglose por promoción del resultado del mes. Sin
 * join clínico: los cargos manuales y de presupuesto también cuentan.
 */
async function promotionApplications(
  tx: Db,
  orgId: string,
  start: Date,
  end: Date,
  currency: string,
  query: { branchId?: string } = {},
): Promise<PromotionApp[]> {
  const filters = [
    eq(patientPaymentApplication.organizationId, orgId),
    gte(patientPaymentApplication.createdAt, start),
    lt(patientPaymentApplication.createdAt, end),
    or(isNull(patientPaymentApplication.voidedAt), gte(patientPaymentApplication.voidedAt, end)),
    eq(patientCharge.currency, currency),
    or(isNull(patientCharge.voidedAt), gte(patientCharge.voidedAt, end)),
    or(isNull(patientPayment.voidedAt), gte(patientPayment.voidedAt, end)),
  ]
  if (query.branchId) filters.push(eq(patientPayment.branchId, query.branchId))
  const rows = await tx
    .select({
      app: patientPaymentApplication,
      charge: patientCharge,
      payment: patientPayment,
    })
    .from(patientPaymentApplication)
    .innerJoin(
      patientPayment,
      and(
        eq(patientPayment.id, patientPaymentApplication.paymentId),
        eq(patientPayment.organizationId, orgId),
      ),
    )
    .innerJoin(
      patientCharge,
      and(
        eq(patientCharge.id, patientPaymentApplication.chargeId),
        eq(patientCharge.organizationId, orgId),
      ),
    )
    .where(and(...filters))
  return rows.map((r) => ({
    appId: r.app.id,
    appCents: r.app.amountCents,
    appCreatedAt: r.app.createdAt,
    chargeId: r.charge.id,
    chargePromotionId: r.charge.promotionId,
    chargePromotionName: r.charge.promotionName,
    chargeBudgetItemId: r.charge.budgetItemId,
    paymentId: r.payment.id,
  }))
}
/**
 * Promoción de cada aplicación: snapshot del cargo y, en su defecto, la
 * línea del presupuesto origen cuando su propuesta ya no es borrador.
 */
async function promotionOfApps(
  tx: Db,
  orgId: string,
  apps: PromotionApp[],
): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>()
  for (const app of apps) {
    if (app.chargePromotionId && app.chargePromotionName)
      out.set(app.appId, { id: app.chargePromotionId, name: app.chargePromotionName })
  }
  const missing = apps.filter((a) => !out.has(a.appId) && a.chargeBudgetItemId)
  if (missing.length === 0) return out
  const lines = await tx
    .select({
      id: treatmentBudgetItem.id,
      promotionId: treatmentBudgetItem.promotionId,
      promotionName: treatmentBudgetItem.promotionName,
      status: treatmentBudget.status,
    })
    .from(treatmentBudgetItem)
    .innerJoin(
      treatmentBudget,
      and(
        eq(treatmentBudget.id, treatmentBudgetItem.budgetId),
        eq(treatmentBudget.organizationId, orgId),
      ),
    )
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        inArray(
          treatmentBudgetItem.id,
          missing.map((a) => a.chargeBudgetItemId as string),
        ),
      ),
    )
  const byItem = new Map(lines.map((l) => [l.id, l]))
  for (const app of missing) {
    const line = byItem.get(app.chargeBudgetItemId as string)
    if (line && line.status !== "borrador" && line.promotionId && line.promotionName)
      out.set(app.appId, { id: line.promotionId, name: line.promotionName })
  }
  return out
}

/**
 * Reparte las devoluciones del mes entre las aplicaciones incluidas: cada
 * devolución consume primero el saldo sin aplicar del pago y solo el
 * excedente reduce la base comisionable, a prorrata del importe aplicado.
 */
async function allocateRefunds(
  tx: Db,
  orgId: string,
  apps: PromotionApp[],
  paymentTotals: Map<string, number>,
  start: Date,
  end: Date,
): Promise<Map<string, number>> {
  const byApp = new Map<string, number>()
  const paymentIds = [...new Set(apps.map((a) => a.paymentId))]
  if (paymentIds.length === 0) return byApp
  const [allApps, allRefunds] = await Promise.all([
    tx
      .select()
      .from(patientPaymentApplication)
      .where(
        and(
          eq(patientPaymentApplication.organizationId, orgId),
          inArray(patientPaymentApplication.paymentId, paymentIds),
        ),
      ),
    tx
      .select()
      .from(patientPaymentRefund)
      .where(
        and(
          eq(patientPaymentRefund.organizationId, orgId),
          inArray(patientPaymentRefund.paymentId, paymentIds),
        ),
      ),
  ])
  const includedByPayment = new Map<string, PromotionApp[]>()
  for (const app of apps) {
    const list = includedByPayment.get(app.paymentId) ?? []
    list.push(app)
    includedByPayment.set(app.paymentId, list)
  }
  const monthRefunds = allRefunds
    .filter((r) => r.refundedAt >= start && r.refundedAt < end)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  for (const refund of monthRefunds) {
    const total = paymentTotals.get(refund.paymentId) ?? 0
    const liveAtRefund = allApps.filter(
      (a) =>
        a.paymentId === refund.paymentId &&
        a.createdAt <= refund.createdAt &&
        (a.voidedAt === null || a.voidedAt > refund.createdAt),
    )
    const earlier = allRefunds
      .filter((r) => r.paymentId === refund.paymentId && r.createdAt < refund.createdAt)
      .reduce((sum, r) => sum + r.amountCents, 0)
    const chargeable = Math.max(
      0,
      refund.amountCents -
        Math.max(0, total - sumCents(liveAtRefund.map((a) => ({ amountCents: a.amountCents }))) - earlier),
    )
    if (chargeable <= 0) continue
    const targets = (includedByPayment.get(refund.paymentId) ?? []).filter(
      (a) => a.appCreatedAt <= refund.createdAt,
    )
    const base = sumCents(targets.map((t) => ({ amountCents: t.appCents })))
    if (targets.length === 0 || base <= 0) continue
    let assigned = 0
    targets.forEach((t, i) => {
      const share =
        i === targets.length - 1 ? chargeable - assigned : Math.floor((chargeable * t.appCents) / base)
      assigned += share
      byApp.set(t.appId, (byApp.get(t.appId) ?? 0) + share)
    })
  }
  return byApp
}

export interface CommissionLine {
  applicationId: string
  chargeId: string
  paymentId: string
  patientId: string
  description: string
  grossCents: number
  refundChargeCents: number
  baseCents: number
  rateBps: number
  commissionCents: number
  occurredAt: Date
  paidAt: Date
  methodLabel: string
  cashMethod: boolean
  promotionId: string | null
  promotionName: string | null
  settled: boolean
}

async function settledSourceKeys(tx: Db, orgId: string, professionalUserId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ sourceKey: commissionSettlementLine.sourceKey })
    .from(commissionSettlementLine)
    .innerJoin(
      commissionSettlement,
      and(
        eq(commissionSettlement.id, commissionSettlementLine.settlementId),
        eq(commissionSettlement.organizationId, orgId),
        isNull(commissionSettlement.voidedAt),
      ),
    )
    .where(
      and(
        eq(commissionSettlementLine.organizationId, orgId),
        isNull(commissionSettlementLine.voidedAt),
        eq(commissionSettlement.professionalUserId, professionalUserId),
      ),
    )
  return new Set(rows.map((r) => r.sourceKey))
}

async function liveMonthSettlement(
  tx: Db,
  orgId: string,
  professionalUserId: string,
  year: number,
  month: number,
  currency: string,
) {
  const [row] = await tx
    .select()
    .from(commissionSettlement)
    .where(
      and(
        eq(commissionSettlement.organizationId, orgId),
        eq(commissionSettlement.professionalUserId, professionalUserId),
        eq(commissionSettlement.periodYear, year),
        eq(commissionSettlement.periodMonth, month),
        eq(commissionSettlement.currency, currency),
        isNull(commissionSettlement.voidedAt),
      ),
    )
  return row ?? null
}

export interface MonthlyCommissionsQuery {
  professionalUserId: string
  year: number
  month: number
  currency: string
}

/** Mes de un profesional: detalle por cobro con tasa, base neta y estado. */
export async function getMonthlyCommissions(tx: Db, orgId: string, query: MonthlyCommissionsQuery) {
  await requireProfessional(tx, orgId, query.professionalUserId)
  const unit = currency(query.currency)
  const { timezone, locale } = await getOrgLocale(tx, orgId)
  const { start, end } = monthBounds(timezone, query.year, query.month)
  const rateBps = await commissionRateOf(tx, orgId, query.professionalUserId)
  const apps = await collectedApplications(tx, orgId, start, end, unit, {
    professionalUserId: query.professionalUserId,
  })
  const paymentTotals = await paymentTotalsOf(
    tx,
    orgId,
    apps.map((a) => a.paymentId),
  )
  for (const app of apps)
    if (!paymentTotals.has(app.paymentId)) paymentTotals.set(app.paymentId, app.paymentCents)
  const refundByApp = await allocateRefunds(tx, orgId, apps, paymentTotals, start, end)
  const promotions = await promotionOfApps(tx, orgId, apps)
  const settled = await settledSourceKeys(tx, orgId, query.professionalUserId)
  const names = await userNames(tx, [query.professionalUserId])
  const lines: CommissionLine[] = apps.map((app) => {
    const refundChargeCents = Math.min(app.appCents, refundByApp.get(app.appId) ?? 0)
    const baseCents = app.appCents - refundChargeCents
    const promo = promotions.get(app.appId) ?? null
    return {
      applicationId: app.appId,
      chargeId: app.chargeId,
      paymentId: app.paymentId,
      patientId: app.patientId,
      description: app.chargeDescription,
      grossCents: app.appCents,
      refundChargeCents,
      baseCents,
      rateBps,
      commissionCents: Math.floor((baseCents * rateBps) / 10000),
      occurredAt: app.appCreatedAt,
      paidAt: app.paidAt,
      methodLabel: app.methodLabel,
      cashMethod: app.cashMethod,
      promotionId: promo?.id ?? null,
      promotionName: promo?.name ?? null,
      settled: settled.has(`app:${app.appId}`),
    }
  })
  const fresh = lines.filter((l) => !l.settled)
  const settlement = await liveMonthSettlement(
    tx,
    orgId,
    query.professionalUserId,
    query.year,
    query.month,
    unit,
  )
  return {
    professionalUserId: query.professionalUserId,
    professionalName: names.get(query.professionalUserId) ?? null,
    year: query.year,
    month: query.month,
    currency: unit,
    timezone,
    locale,
    rateBps,
    lines,
    baseCents: sumCents(lines.map((l) => ({ amountCents: l.baseCents }))),
    commissionCents: sumCents(lines.map((l) => ({ amountCents: l.commissionCents }))),
    pendingCents: sumCents(fresh.map((l) => ({ amountCents: l.commissionCents }))),
    settlement,
    paidExpenseId: settlement?.expenseId ?? null,
  }
}

/** Acceso propio: el profesional ve solo sus comisiones del mes. */
export async function getMyCommissions(
  tx: Db,
  orgId: string,
  userId: string,
  query: { year: number; month: number; currency: string },
) {
  return getMonthlyCommissions(tx, orgId, { ...query, professionalUserId: userId })
}

export interface SettleMonthCommissionsInput {
  professionalUserId: string
  year: number
  month: number
  currency: string
  notes?: string | null
}

/** Liquida el mes: congela líneas trazables; una sola liquidación viva por mes. */
export async function settleMonthCommissions(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: SettleMonthCommissionsInput,
) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`commission:${orgId}:${input.professionalUserId}:${input.year}:${input.month}:${input.currency}`}, 0))`)
  const view = await getMonthlyCommissions(tx, orgId, input)
  if (view.settlement) throw conflict("SETTLEMENT_EXISTS", "El mes ya tiene una liquidación vigente")
  const fresh = view.lines.filter((l) => !l.settled)
  if (fresh.length === 0)
    throw conflict("SETTLEMENT_EMPTY", "No hay cobros pendientes de liquidar en ese mes")
  const [settlement] = await tx
    .insert(commissionSettlement)
    .values({
      organizationId: orgId,
      professionalUserId: input.professionalUserId,
      periodYear: input.year,
      periodMonth: input.month,
      base: "cobrado",
      currency: view.currency,
      rateBps: view.rateBps,
      baseCents: sumCents(fresh.map((l) => ({ amountCents: l.baseCents }))),
      commissionCents: sumCents(fresh.map((l) => ({ amountCents: l.commissionCents }))),
      status: "liquidada",
      notes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
      settledBy: actorUserId,
      settledAt: new Date(),
    })
    .returning()
  if (!settlement) throw new ServiceError("INTERNAL", 409, "No se pudo liquidar")
  try {
    for (const line of fresh) {
      await tx.insert(commissionSettlementLine).values({
        organizationId: orgId,
        settlementId: settlement.id,
        sourceKey: `app:${line.applicationId}`,
        applicationId: line.applicationId,
        chargeId: line.chargeId,
        paymentId: line.paymentId,
        patientId: line.patientId,
        description: line.description,
        baseCents: line.baseCents,
        commissionCents: line.commissionCents,
        rateBps: line.rateBps,
        occurredAt: line.occurredAt,
      })
    }
  } catch (e) {
    // Carreras entre liquidaciones concurrentes: la unique mensual y la de
    // fuente dejan pasar una sola; la otra recibe 409 sin duplicar.
    if (isUniqueViolation(e))
      throw conflict(
        "SETTLEMENT_OVERLAP",
        "Parte de esas fuentes ya quedó liquidada en otra liquidación vigente",
      )
    throw e
  }
  await audit(tx, orgId, actorUserId, "commission_settlement", settlement.id, "finance.settled")
  await createWorkspaceNotification(tx, orgId, {
    userId: input.professionalUserId,
    dedupeKey: `commission-settled:${settlement.id}`,
    title: "Liquidación de comisiones lista",
    body: `Periodo ${input.year}-${String(input.month).padStart(2, "0")}: ${settlement.commissionCents} centavos (${view.currency}).`,
    href: `/commissions?liquidacion=${settlement.id}`,
    permission: "commissions.read",
  })
  return settlement
}

export async function listCommissionSettlements(
  tx: Db,
  orgId: string,
  query: { professionalUserId?: string; year?: number; month?: number } = {},
) {
  const filters = [eq(commissionSettlement.organizationId, orgId), isNull(commissionSettlement.voidedAt)]
  if (query.professionalUserId)
    filters.push(eq(commissionSettlement.professionalUserId, query.professionalUserId))
  if (query.year) filters.push(eq(commissionSettlement.periodYear, query.year))
  if (query.month) filters.push(eq(commissionSettlement.periodMonth, query.month))
  const rows = await tx
    .select()
    .from(commissionSettlement)
    .where(and(...filters))
    .orderBy(desc(commissionSettlement.periodYear), desc(commissionSettlement.periodMonth))
  const names = await userNames(
    tx,
    rows.map((r) => r.professionalUserId),
  )
  return rows.map((r) => ({ ...r, professionalName: names.get(r.professionalUserId) ?? null }))
}

export async function getCommissionSettlementDetail(tx: Db, orgId: string, settlementId: string) {
  const [settlement] = await tx
    .select()
    .from(commissionSettlement)
    .where(
      and(eq(commissionSettlement.id, settlementId), eq(commissionSettlement.organizationId, orgId)),
    )
  if (!settlement) throw notFound("Liquidación")
  const lines = await tx
    .select()
    .from(commissionSettlementLine)
    .where(
      and(
        eq(commissionSettlementLine.organizationId, orgId),
        eq(commissionSettlementLine.settlementId, settlementId),
        isNull(commissionSettlementLine.voidedAt),
      ),
    )
    .orderBy(asc(commissionSettlementLine.occurredAt), asc(commissionSettlementLine.id))
  const names = await userNames(tx, [settlement.professionalUserId])
  const expenseRow = settlement.expenseId
    ? (
        await tx
          .select()
          .from(expense)
          .where(and(eq(expense.id, settlement.expenseId), eq(expense.organizationId, orgId)))
      )[0] ?? null
    : null
  return {
    settlement: {
      ...settlement,
      professionalName: names.get(settlement.professionalUserId) ?? null,
    },
    lines,
    expense: expenseRow,
  }
}

export interface PayCommissionSettlementInput {
  settlementId: string
  branchId: string
}

/**
 * Registra el pago de una liquidación como gasto de Personal, exactamente
 * una vez: el segundo intento se rechaza y el gasto queda enlazado.
 */
export async function payCommissionSettlement(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: PayCommissionSettlementInput,
) {
  const [settlement] = await tx
    .select()
    .from(commissionSettlement)
    .where(
      and(eq(commissionSettlement.id, input.settlementId), eq(commissionSettlement.organizationId, orgId)),
    )
  if (!settlement || settlement.voidedAt) throw notFound("Liquidación vigente")
  if (settlement.expenseId)
    throw conflict("SETTLEMENT_ALREADY_PAID", "La liquidación ya tiene su pago registrado")
  if (settlement.commissionCents <= 0)
    throw conflict("SETTLEMENT_ZERO", "La liquidación no tiene importe que pagar")
  await requireBranch(tx, orgId, input.branchId)
  const names = await userNames(tx, [settlement.professionalUserId])
  const professionalName = names.get(settlement.professionalUserId) ?? settlement.professionalUserId
  const period = `${settlement.periodYear}-${String(settlement.periodMonth).padStart(2, "0")}`
  const [row] = await tx
    .insert(expense)
    .values({
      organizationId: orgId,
      branchId: input.branchId,
      concept: `Pago de comisión ${period} — ${professionalName}`,
      amountCents: settlement.commissionCents,
      currency: settlement.currency,
      category: COMMISSION_EXPENSE_CATEGORY,
      spentAt: new Date(),
      receiptKind: "ninguno",
      notes: `Liquidación de comisiones ${settlement.id}.`,
      createdBy: actorUserId,
    })
    .returning()
  const [updated] = await tx
    .update(commissionSettlement)
    .set({ expenseId: row.id, updatedAt: new Date() })
    .where(
      and(eq(commissionSettlement.id, settlement.id), eq(commissionSettlement.organizationId, orgId)),
    )
    .returning()
  await audit(tx, orgId, actorUserId, "commission_settlement", settlement.id, "finance.settlement_paid")
  return { settlement: updated, expense: row }
}

export async function voidCommissionSettlement(
  tx: Db,
  orgId: string,
  actorUserId: string,
  settlementId: string,
  input: { reason: string },
) {
  const [current] = await tx
    .select()
    .from(commissionSettlement)
    .where(
      and(eq(commissionSettlement.id, settlementId), eq(commissionSettlement.organizationId, orgId)),
    )
  if (!current) throw notFound("Liquidación")
  if (current.voidedAt) throw conflict("SETTLEMENT_VOIDED", "La liquidación ya está anulada")
  const [row] = await tx
    .update(commissionSettlement)
    .set({
      status: "anulada",
      voidedAt: new Date(),
      voidedBy: actorUserId,
      voidReason: reason(input.reason),
      updatedAt: new Date(),
    })
    .where(
      and(eq(commissionSettlement.id, settlementId), eq(commissionSettlement.organizationId, orgId)),
    )
    .returning()
  // Las líneas se anulan con la liquidación y liberan sus fuentes: una
  // reliquidación posterior las vuelve a tomar sin duplicar historia.
  await tx
    .update(commissionSettlementLine)
    .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason: reason(input.reason) })
    .where(
      and(
        eq(commissionSettlementLine.organizationId, orgId),
        eq(commissionSettlementLine.settlementId, settlementId),
        isNull(commissionSettlementLine.voidedAt),
      ),
    )
  // El gasto del pago se anula con la liquidación (misma transacción).
  if (current.expenseId)
    await voidExpense(tx, orgId, actorUserId, current.expenseId, { reason: input.reason })
  await audit(tx, orgId, actorUserId, "commission_settlement", settlementId, "finance.settlement_voided")
  return row
}

// --- Resultado del mes (Fase 6) ------------------------------------------------------------

export interface MonthlyFinanceResultQuery {
  year: number
  month: number
  branchId?: string
  currency?: string
}

/**
 * Resultado del mes: cobrado (pagos vigentes por fecha de pago, sin aportes
 * de caja como ingreso) menos devoluciones y anulaciones del mes, gastado
 * por categoría, queda por moneda, desgloses por medio/profesional/promoción,
 * deuda al fin de mes y cierres para conciliar el efectivo.
 */
export async function getMonthlyFinanceResult(tx: Db, orgId: string, query: MonthlyFinanceResultQuery) {
  const { timezone, locale } = await getOrgLocale(tx, orgId)
  const { start, end } = monthBounds(timezone, query.year, query.month)
  const branch = query.branchId ? await requireBranch(tx, orgId, query.branchId) : null
  const unit = query.currency ? currency(query.currency) : null

  const paymentFilters = [
    eq(patientPayment.organizationId, orgId),
    gte(patientPayment.paidAt, start),
    lt(patientPayment.paidAt, end),
  ]
  if (unit) paymentFilters.push(eq(patientPayment.currency, unit))
  if (branch) paymentFilters.push(eq(patientPayment.branchId, branch.id))
  const payments = await tx.select().from(patientPayment).where(and(...paymentFilters))

  // Anulaciones del mes sobre cobros de meses anteriores: corrigen este mes.
  const voidCorrectionFilters = [
    eq(patientPayment.organizationId, orgId),
    lt(patientPayment.paidAt, start),
    gte(patientPayment.voidedAt, start),
    lt(patientPayment.voidedAt, end),
  ]
  if (unit) voidCorrectionFilters.push(eq(patientPayment.currency, unit))
  if (branch) voidCorrectionFilters.push(eq(patientPayment.branchId, branch.id))
  const voidCorrections = await tx.select().from(patientPayment).where(and(...voidCorrectionFilters))

  const paymentById = new Map(payments.map((p) => [p.id, p]))
  for (const p of voidCorrections) paymentById.set(p.id, p)
  const refunds = await tx
    .select()
    .from(patientPaymentRefund)
    .where(
      and(
        eq(patientPaymentRefund.organizationId, orgId),
        gte(patientPaymentRefund.refundedAt, start),
        lt(patientPaymentRefund.refundedAt, end),
      ),
    )
  // La devolución corrige el mes en que ocurre aunque el cobro sea anterior.
  const missingPaymentIds = [...new Set(refunds.map((r) => r.paymentId))].filter(
    (id) => !paymentById.has(id),
  )
  if (missingPaymentIds.length > 0) {
    const older = await tx
      .select()
      .from(patientPayment)
      .where(
        and(
          eq(patientPayment.organizationId, orgId),
          inArray(patientPayment.id, missingPaymentIds),
        ),
      )
    for (const p of older) paymentById.set(p.id, p)
  }

  const expenseFilters = [
    eq(expense.organizationId, orgId),
    gte(expense.spentAt, start),
    lt(expense.spentAt, end),
  ]
  if (unit) expenseFilters.push(eq(expense.currency, unit))
  if (branch) expenseFilters.push(eq(expense.branchId, branch.id))
  const expenses = await tx.select().from(expense).where(and(...expenseFilters))
  const expenseVoidFilters = [
    eq(expense.organizationId, orgId),
    lt(expense.spentAt, start),
    gte(expense.voidedAt, start),
    lt(expense.voidedAt, end),
  ]
  if (unit) expenseVoidFilters.push(eq(expense.currency, unit))
  if (branch) expenseVoidFilters.push(eq(expense.branchId, branch.id))
  const expenseCorrections = await tx.select().from(expense).where(and(...expenseVoidFilters))

  interface Bucket {
    cobradoCents: number
    devolucionesCents: number
    anulacionesCents: number
    gastadoCents: number
    efectivoCents: number
    byMethod: Map<string, { label: string; cash: boolean; cents: number }>
    byCategory: Map<string, number>
  }
  const buckets = new Map<string, Bucket>()
  const bucket = (curr: string): Bucket => {
    let entry = buckets.get(curr)
    if (!entry) {
      entry = {
        cobradoCents: 0,
        devolucionesCents: 0,
        anulacionesCents: 0,
        gastadoCents: 0,
        efectivoCents: 0,
        byMethod: new Map(),
        byCategory: new Map(),
      }
      buckets.set(curr, entry)
    }
    return entry
  }
  const methodAdd = (curr: string, payment: typeof payments[number], cents: number): void => {
    const entry = bucket(curr)
    const key = payment.methodName ?? payment.method
    const slot = entry.byMethod.get(key) ?? { label: key, cash: methodCashOf(payment), cents: 0 }
    slot.cents = addCents(slot.cents, cents)
    entry.byMethod.set(key, slot)
  }
  for (const p of payments) {
    if (!liveInMonth(p.voidedAt, end)) continue
    const entry = bucket(p.currency)
    entry.cobradoCents = addCents(entry.cobradoCents, p.amountCents)
    methodAdd(p.currency, p, p.amountCents)
    if (methodCashOf(p)) entry.efectivoCents = addCents(entry.efectivoCents, p.amountCents)
  }
  for (const p of voidCorrections) {
    const entry = bucket(p.currency)
    entry.anulacionesCents = addCents(entry.anulacionesCents, p.amountCents)
    methodAdd(p.currency, p, -p.amountCents)
    if (methodCashOf(p)) entry.efectivoCents = addCents(entry.efectivoCents, -p.amountCents)
  }
  for (const r of refunds) {
    const payment = paymentById.get(r.paymentId)
    if (!payment) continue
    if (unit && payment.currency !== unit) continue
    if (branch && payment.branchId !== branch.id) continue
    const entry = bucket(payment.currency)
    entry.devolucionesCents = addCents(entry.devolucionesCents, r.amountCents)
    methodAdd(payment.currency, payment, -r.amountCents)
    if (methodCashOf(payment)) entry.efectivoCents = addCents(entry.efectivoCents, -r.amountCents)
  }
  for (const e of expenses) {
    if (!liveInMonth(e.voidedAt, end)) continue
    const entry = bucket(e.currency)
    entry.gastadoCents = addCents(entry.gastadoCents, e.amountCents)
    const category = e.category ?? "Otros"
    entry.byCategory.set(category, addCents(entry.byCategory.get(category) ?? 0, e.amountCents))
  }
  for (const e of expenseCorrections) {
    const entry = bucket(e.currency)
    entry.gastadoCents = addCents(entry.gastadoCents, -e.amountCents)
    const category = e.category ?? "Otros"
    entry.byCategory.set(category, addCents(entry.byCategory.get(category) ?? 0, -e.amountCents))
  }

  // Cobrado por profesional (solo atendido) y por promoción (todo cargo con
  // snapshot): aplicaciones del mes, netas de devoluciones con la misma
  // regla de las comisiones.
  const currencies = [...buckets.keys()]
  const byProfessional: Array<{
    professionalUserId: string
    name: string | null
    currency: string
    cobradoCents: number
  }> = []
  const byPromotion: Array<{
    promotionId: string
    name: string
    currency: string
    veces: number
    cobradoCents: number
  }> = []
  for (const curr of currencies) {
    // Por profesional: solo lo atendido (misma base de las comisiones).
    const apps = await collectedApplications(tx, orgId, start, end, curr, {
      branchId: branch?.id,
    })
    const totals = await paymentTotalsOf(
      tx,
      orgId,
      apps.map((a) => a.paymentId),
    )
    for (const app of apps)
      if (!totals.has(app.paymentId)) totals.set(app.paymentId, app.paymentCents)
    const refundByApp = await allocateRefunds(tx, orgId, apps, totals, start, end)
    const profSums = new Map<string, number>()
    for (const a of apps) {
      const net = a.appCents - Math.min(a.appCents, refundByApp.get(a.appId) ?? 0)
      profSums.set(a.dentistUserId, (profSums.get(a.dentistUserId) ?? 0) + net)
    }
    const names = await userNames(tx, [...profSums.keys()])
    for (const [professionalUserId, cobradoCents] of profSums)
      byProfessional.push({
        professionalUserId,
        name: names.get(professionalUserId) ?? null,
        currency: curr,
        cobradoCents,
      })
    // Por promoción: todos los cargos cobrados con snapshot (con o sin
    // atención). veces = cargos distintos cobrados en el mes (sin doble
    // conteo por pagos parciales); importe = neto cobrado en el mes. El uso
    // histórico total (incluye gratuitas cotizadas) lo cuenta
    // getPromotionMetrics del dominio de promociones (tablero Tarifario);
    // cortesías directas sin línea ni cargo no existen en tablas.
    const promoApps = await promotionApplications(tx, orgId, start, end, curr, {
      branchId: branch?.id,
    })
    const promoTotals = await paymentTotalsOf(
      tx,
      orgId,
      promoApps.map((a) => a.paymentId),
    )
    const promoRefunds = await allocateRefunds(tx, orgId, promoApps, promoTotals, start, end)
    const promotions = await promotionOfApps(tx, orgId, promoApps)
    const promoAgg = new Map<string, { name: string; veces: Set<string>; cents: number }>()
    for (const a of promoApps) {
      const promo = promotions.get(a.appId)
      if (!promo) continue
      const net = a.appCents - Math.min(a.appCents, promoRefunds.get(a.appId) ?? 0)
      const slot = promoAgg.get(promo.id) ?? { name: promo.name, veces: new Set<string>(), cents: 0 }
      slot.veces.add(a.chargeId)
      slot.cents += net
      promoAgg.set(promo.id, slot)
    }
    for (const [promotionId, agg] of promoAgg)
      byPromotion.push({
        promotionId,
        name: agg.name,
        currency: curr,
        veces: agg.veces.size,
        cobradoCents: agg.cents,
      })
  }
  byProfessional.sort((a, b) => b.cobradoCents - a.cobradoCents)
  byPromotion.sort((a, b) => b.cobradoCents - a.cobradoCents)

  // Deuda al fin de mes: cargos creados antes del cierre menos aplicaciones
  // anteriores al cierre, con la vigencia de ese momento.
  const chargeFilters = [eq(patientCharge.organizationId, orgId), lt(patientCharge.createdAt, end)]
  if (unit) chargeFilters.push(eq(patientCharge.currency, unit))
  const charges = await tx.select().from(patientCharge).where(and(...chargeFilters))
  const oldApps = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        lt(patientPaymentApplication.createdAt, end),
      ),
    )
  const outstandingByCurrency = new Map<string, { pendienteCents: number; pacientes: Set<string> }>()
  const appliedByCharge = new Map<string, number>()
  for (const a of oldApps) {
    if (!liveInMonth(a.voidedAt, end)) continue
    appliedByCharge.set(a.chargeId, (appliedByCharge.get(a.chargeId) ?? 0) + a.amountCents)
  }
  for (const c of charges) {
    if (!liveInMonth(c.voidedAt, end)) continue
    if (branch && c.branchId !== branch.id) continue
    const remaining = c.amountCents - (appliedByCharge.get(c.id) ?? 0)
    if (remaining <= 0) continue
    const slot = outstandingByCurrency.get(c.currency) ?? {
      pendienteCents: 0,
      pacientes: new Set<string>(),
    }
    slot.pendienteCents = addCents(slot.pendienteCents, remaining)
    slot.pacientes.add(c.patientId)
    outstandingByCurrency.set(c.currency, slot)
  }

  // Cierres del mes como ayuda para contrastar el efectivo: sus ventanas
  // pueden cruzar de mes, así que no se promete igualdad exacta.
  const closureFilters = [
    eq(cashClosure.organizationId, orgId),
    gte(cashClosure.closedAt, start),
    lt(cashClosure.closedAt, end),
  ]
  if (unit) closureFilters.push(eq(cashClosure.currency, unit))
  if (branch) closureFilters.push(eq(cashClosure.branchId, branch.id))
  const closures = await tx.select().from(cashClosure).where(and(...closureFilters))
  const closureAgg = new Map<
    string,
    { cierres: number; efectivoCents: number; gastosCajaCents: number; diferenciasCents: number }
  >()
  for (const c of closures) {
    const slot = closureAgg.get(c.currency) ?? {
      cierres: 0,
      efectivoCents: 0,
      gastosCajaCents: 0,
      diferenciasCents: 0,
    }
    slot.cierres += 1
    slot.efectivoCents = addCents(slot.efectivoCents, c.cashCollectedCents)
    slot.gastosCajaCents = addCents(slot.gastosCajaCents, c.expenseCashCents)
    slot.diferenciasCents = addCents(slot.diferenciasCents, c.differenceCents)
    closureAgg.set(c.currency, slot)
  }

  return {
    year: query.year,
    month: query.month,
    timezone,
    locale,
    branchId: branch?.id ?? null,
    branchName: branch?.name ?? null,
    byCurrency: [...buckets.entries()].map(([curr, entry]) => {
      const netoCents = entry.cobradoCents - entry.devolucionesCents - entry.anulacionesCents
      return {
        currency: curr,
        cobradoCents: entry.cobradoCents,
        devolucionesCents: entry.devolucionesCents,
        anulacionesCents: entry.anulacionesCents,
        netoCents,
        gastadoCents: entry.gastadoCents,
        quedaCents: netoCents - entry.gastadoCents,
        efectivoCents: entry.efectivoCents,
        byMethod: [...entry.byMethod.entries()].map(([key, slot]) => ({
          key,
          label: slot.label,
          cash: slot.cash,
          cents: slot.cents,
        })),
        byCategory: [...entry.byCategory.entries()].map(([category, cents]) => ({ category, cents })),
      }
    }),
    byProfessional,
    byPromotion,
    outstanding: [...outstandingByCurrency.entries()].map(([curr, slot]) => ({
      currency: curr,
      pendienteCents: slot.pendienteCents,
      pacientes: slot.pacientes.size,
    })),
    closures: [...closureAgg.entries()].map(([curr, slot]) => ({ currency: curr, ...slot })),
  }
}

// --- Caja del día: deudas, movimientos, estado y cierres --------------------------------------

/** Límites UTC de un día civil en la zona horaria de la sede. */
function dayBoundsUTC(dayStr: string, timezone: string): { start: Date; end: Date } {
  const dayValue = day(dayStr)
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
  } catch {
    throw validation("Zona horaria inválida")
  }
  const noon = new Date(`${dayValue}T12:00:00.000Z`)
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(noon)) parts[part.type] = part.value
  const wall = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]) % 24,
    Number(parts["minute"]),
    Number(parts["second"]),
  )
  const start = new Date(Date.parse(`${dayValue}T00:00:00.000Z`) - (wall - noon.getTime()))
  return { start, end: new Date(start.getTime() + 86_400_000) }
}

async function branchTimezone(
  tx: Db,
  orgId: string,
  branchRow: typeof branch.$inferSelect,
): Promise<string> {
  if (branchRow.timezone) return branchRow.timezone
  const [profile] = await tx
    .select({ timezone: orgProfile.timezone })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
  return profile?.timezone ?? "America/Lima"
}

export interface DebtRow {
  patientId: string
  displayName: string
  branchId: string | null
  currency: string
  totalCents: number
  oldestSince: Date | null
  chargesCount: number
}

/**
 * Personas que deben, por sede y moneda: quién, cuánto y desde cuándo.
 * Con `branchId` filtra la sede (más lo no atribuido a sede); cada fila trae
 * su moneda. Lo aceptado sin atender no es deuda: solo cargos vigentes.
 */
export async function getDebts(
  tx: Db,
  orgId: string,
  query: { branchId?: string } = {},
): Promise<DebtRow[]> {
  const rows = await getReceivables(tx, orgId, {})
  const live = rows.filter((r) => r.outstandingCents > 0)
  if (live.length === 0) return []
  const people = await tx
    .select({ id: patient.id, displayName: patient.displayName })
    .from(patient)
    .where(eq(patient.organizationId, orgId))
  const names: Record<string, string> = {}
  for (const person of people) names[person.id] = person.displayName
  const groups: Record<string, DebtRow> = {}
  for (const row of live) {
    const branchId = row.charge.branchId ?? null
    // Sin sede atribuida solo suma en globales: bajo filtro de sede se excluye.
    if (query.branchId && branchId !== query.branchId) continue
    const key = `${row.charge.patientId}|${branchId ?? ""}|${row.charge.currency}`
    const entry = groups[key] ?? {
      patientId: row.charge.patientId,
      displayName: names[row.charge.patientId] ?? "",
      branchId,
      currency: row.charge.currency,
      totalCents: 0,
      oldestSince: null as Date | null,
      chargesCount: 0,
    }
    entry.totalCents = addCents(entry.totalCents, row.outstandingCents)
    entry.chargesCount += 1
    if (!entry.oldestSince || (row.charge.createdAt && row.charge.createdAt < entry.oldestSince))
      entry.oldestSince = row.charge.createdAt
    groups[key] = entry
  }
  return Object.values(groups).sort((a, b) => b.totalCents - a.totalCents)
}

export interface DayMovementsQuery {
  branchId: string
  currency?: string
  day: string
  timezone?: string
}

/** Movimientos del día en la zona horaria de la sede (tickets, gastos, efectivo). */
export async function getDayMovements(tx: Db, orgId: string, query: DayMovementsQuery) {
  const branchRow = await requireBranch(tx, orgId, query.branchId)
  const timezone = query.timezone ?? (await branchTimezone(tx, orgId, branchRow))
  const { start, end } = dayBoundsUTC(query.day, timezone)
  const shiftFilters = [
    eq(cashShift.organizationId, orgId),
    eq(cashShift.branchId, branchRow.id),
  ]
  if (query.currency) shiftFilters.push(eq(cashShift.currency, currency(query.currency)))
  const shifts = await tx
    .select({ id: cashShift.id })
    .from(cashShift)
    .where(and(...shiftFilters))
  if (shifts.length === 0) return { branchId: branchRow.id, day: query.day, timezone, movements: [] }
  const shiftIds = shifts.map((s) => s.id)
  const movements = await tx
    .select()
    .from(cashMovement)
    .where(
      and(
        eq(cashMovement.organizationId, orgId),
        sql`${cashMovement.shiftId} IN (${sql.join(shiftIds.map((id) => sql`${id}`), sql`, `)})`,
        isNull(cashMovement.voidedAt),
        gte(cashMovement.createdAt, start),
        lte(cashMovement.createdAt, end),
      ),
    )
    .orderBy(asc(cashMovement.createdAt), asc(cashMovement.id))
  // Ticket de cada cobro para agrupar multimedios en uno solo.
  const ticketByPayment = await ticketIdsByPayment(
    tx,
    orgId,
    [...new Set(movements.map((m) => m.patientPaymentId).filter((id): id is string => id !== null))],
  )
  return {
    branchId: branchRow.id,
    day: query.day,
    timezone,
    movements: movements.map((m) => ({
      ...m,
      ticketId: m.patientPaymentId ? (ticketByPayment[m.patientPaymentId] ?? null) : null,
    })),
  }
}

export interface CashStateQuery {
  branchId: string
  currency?: string
}

/** Estado de la caja por sede y moneda: efectivo, totales por medio y ventana abierta. */
export async function getCashState(tx: Db, orgId: string, query: CashStateQuery) {
  const branchRow = await requireBranch(tx, orgId, query.branchId)
  const unit = query.currency ? currency(query.currency) : await lockOrgCurrency(tx, orgId)
  const [open] = await tx
    .select()
    .from(cashShift)
    .where(
      and(
        eq(cashShift.organizationId, orgId),
        eq(cashShift.branchId, branchRow.id),
        eq(cashShift.currency, unit),
        eq(cashShift.status, "abierta"),
      ),
    )
    .limit(1)
  if (!open)
    return { branchId: branchRow.id, currency: unit, openedAt: null, cashOnHandCents: 0, byMethod: [], tickets: 0 }
  const detail = await getShiftDetail(tx, orgId, open.id)
  const byMethod: Record<string, { name: string; typeCode: string | null; count: number; amountCents: number }> = {}
  // Un ticket multimedio es un solo cobro: se deduplica por ticket (o pago si es histórico).
  const cobros = detail.movements.filter((m) => m.direction === "ingreso" && m.kind === "cobro")
  const ticketByPayment = await ticketIdsByPayment(
    tx,
    orgId,
    cobros.map((m) => m.patientPaymentId).filter((id): id is string => id !== null),
  )
  const seen = new Set<string>()
  let tickets = 0
  for (const m of cobros) {
    const ticketId = m.patientPaymentId ? ticketByPayment[m.patientPaymentId] : null
    const key = ticketId ? `ticket:${ticketId}` : m.patientPaymentId ? `pago:${m.patientPaymentId}` : `mov:${m.id}`
    if (!seen.has(key)) {
      seen.add(key)
      tickets += 1
    }
    const name = m.method ?? "Otro"
    const entry = byMethod[name] ?? { name, typeCode: m.methodTypeCode, count: 0, amountCents: 0 }
    entry.count += 1
    entry.amountCents = addCents(entry.amountCents, m.amountCents)
    byMethod[name] = entry
  }
  return {
    branchId: branchRow.id,
    currency: unit,
    openedAt: open.openedAt,
    cashOnHandCents: detail.esperadoCents,
    byMethod: Object.values(byMethod),
    tickets,
  }
}

/** Ticket de cada pago (nulo = histórico sin ticket). Una sola consulta. */
async function ticketIdsByPayment(
  tx: Db,
  orgId: string,
  paymentIds: string[],
): Promise<Record<string, string | null>> {
  const map: Record<string, string | null> = {}
  if (paymentIds.length === 0) return map
  const rows = await tx
    .select({ id: patientPayment.id, ticketId: patientPayment.ticketId })
    .from(patientPayment)
    .where(
      and(
        eq(patientPayment.organizationId, orgId),
        sql`${patientPayment.id} IN (${sql.join(paymentIds.map((id) => sql`${id}`), sql`, `)})`,
      ),
    )
  for (const row of rows) map[row.id] = row.ticketId
  return map
}

// --- Cierres: historial unido (tabla nueva + turnos anteriores) -------------------------------
export interface ClosureListItem {
  id: string
  /** 'cierre' (tabla inmutable nueva) o 'turno' (cierre anterior sin snapshot). */
  source: "cierre" | "turno"
  branchId: string
  currency: string
  closedAt: Date | null
  closedBy: string | null
  expectedCents: number | null
  countedCents: number | null
  differenceCents: number | null
  /** Nulo en histórico anterior: desconocido, no cero. */
  retainedCents: number | null
  deliveredCents: number | null
  notes: string | null
}

/**
 * Cierres anteriores: quién cerró y si hubo diferencia. Une la tabla
 * inmutable nueva con los turnos cerrados anteriores (sin snapshot:
 * retenido/entregado nulos, nunca inventados). Sin ruta de compatibilidad.
 */
export async function listClosures(
  tx: Db,
  orgId: string,
  query: { branchId?: string; limit?: number } = {},
): Promise<ClosureListItem[]> {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100)
  const closureFilters = [eq(cashClosure.organizationId, orgId)]
  if (query.branchId) closureFilters.push(eq(cashClosure.branchId, query.branchId))
  const closures = await tx
    .select()
    .from(cashClosure)
    .where(and(...closureFilters))
    .orderBy(desc(cashClosure.closedAt), desc(cashClosure.id))
    .limit(limit)
  const shiftFilters = [
    eq(cashShift.organizationId, orgId),
    eq(cashShift.status, "cerrada"),
  ]
  if (query.branchId) shiftFilters.push(eq(cashShift.branchId, query.branchId))
  const shifts = await tx
    .select()
    .from(cashShift)
    .where(and(...shiftFilters))
    .orderBy(desc(cashShift.closedAt), desc(cashShift.id))
    .limit(limit)
  const withSheet = new Set(closures.map((c) => c.shiftId))
  const items: ClosureListItem[] = closures.map((c) => ({
    id: c.id,
    source: "cierre",
    branchId: c.branchId,
    currency: c.currency,
    closedAt: c.closedAt,
    closedBy: c.closedBy,
    expectedCents: c.expectedCents,
    countedCents: c.countedCents,
    differenceCents: c.differenceCents,
    retainedCents: c.retainedCents,
    deliveredCents: c.deliveredCents,
    notes: c.notes,
  }))
  for (const shift of shifts) {
    if (withSheet.has(shift.id)) continue
    items.push({
      id: shift.id,
      source: "turno",
      branchId: shift.branchId,
      currency: shift.currency,
      closedAt: shift.closedAt,
      closedBy: shift.closedBy,
      expectedCents: shift.expectedCents,
      countedCents: shift.countedCents,
      differenceCents: shift.differenceCents,
      retainedCents: null,
      deliveredCents: null,
      notes: shift.closeNotes,
    })
  }
  items.sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0))
  return items.slice(0, limit)
}

/** Hoja de cierre imprimible: todo lo contado desde el cierre anterior. */
export async function getClosureSheet(tx: Db, orgId: string, closureId: string) {
  const [closure] = await tx
    .select()
    .from(cashClosure)
    .where(and(eq(cashClosure.id, closureId), eq(cashClosure.organizationId, orgId)))
  if (closure) {
    const context = await closureContext(tx, orgId, closure.branchId, closure.closedBy)
    return {
      legacy: false as const,
      closure,
      totalsByMethod: closure.totalsByMethod,
      ...context,
    }
  }
  // Turno cerrado anterior sin snapshot: hoja explícita como histórico, con
  // retenido/entregado nulos y sin totales por medio inventados.
  const shift = await requireShift(tx, orgId, closureId)
  if (shift.status !== "cerrada") throw notFound("Cierre de caja")
  const detail = await getShiftDetail(tx, orgId, shift.id)
  const context = await closureContext(tx, orgId, shift.branchId, shift.closedBy)
  return {
    legacy: true as const,
    closure: {
      id: shift.id,
      branchId: shift.branchId,
      currency: shift.currency,
      windowFrom: shift.openedAt,
      windowTo: shift.closedAt,
      openingRetainedCents: shift.openingCents,
      cashCollectedCents: null as number | null,
      expenseCashCents: sumCents(
        detail.movements
          .filter((m) => m.direction === "egreso" && m.kind === "gasto")
          .map((m) => ({ amountCents: m.amountCents })),
      ),
      expectedCents: shift.expectedCents,
      countedCents: shift.countedCents,
      differenceCents: shift.differenceCents,
      retainedCents: null as number | null,
      deliveredCents: null as number | null,
      notes: shift.closeNotes,
      closedBy: shift.closedBy,
      closedAt: shift.closedAt,
    },
    totalsByMethod: null as unknown,
    ...context,
  }
}

async function closureContext(
  tx: Db,
  orgId: string,
  branchId: string,
  closedBy: string | null,
) {
  const [branchRow] = await tx
    .select()
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.organizationId, orgId)))
  const [profile] = await tx
    .select()
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
  const [closer] = closedBy
    ? await tx.select({ name: user.name }).from(user).where(eq(user.id, closedBy))
    : []
  return { branch: branchRow ?? null, orgProfile: profile ?? null, closedByName: closer?.name ?? null }
}

// --- Resúmenes para Home / Reportes -----------------------------------------------------

/**
 * Resumen financiero por moneda para Home y Reportes: caja (ingresos/egresos
 * de turnos en rango), gastos y cuentas por cobrar. Contrato que el padre
 * consume en `services/workspace.ts`.
 */
export async function getFinanceOverview(
  tx: Db,
  orgId: string,
  query: { branchId?: string; from?: string; to?: string },
) {
  const fromAt = query.from ? new Date(`${day(query.from)}T00:00:00.000Z`) : null
  const toAt = query.to ? new Date(`${day(query.to)}T23:59:59.999Z`) : null
  const shiftFilters = [eq(cashShift.organizationId, orgId)]
  if (query.branchId) shiftFilters.push(eq(cashShift.branchId, query.branchId))
  const shifts = await tx
    .select()
    .from(cashShift)
    .where(and(...shiftFilters))
  const shiftIds = new Set(shifts.map((s) => s.id))
  const movementFilters = [
    eq(cashMovement.organizationId, orgId),
    isNull(cashMovement.voidedAt),
  ]
  if (fromAt) movementFilters.push(gte(cashMovement.createdAt, fromAt))
  if (toAt) movementFilters.push(lte(cashMovement.createdAt, toAt))
  const movements = (await tx.select().from(cashMovement).where(and(...movementFilters))).filter(
    (m) => shiftIds.has(m.shiftId),
  )
  const expenseFilters = [eq(expense.organizationId, orgId), isNull(expense.voidedAt)]
  if (query.branchId) expenseFilters.push(eq(expense.branchId, query.branchId))
  if (fromAt) expenseFilters.push(gte(expense.spentAt, fromAt))
  if (toAt) expenseFilters.push(lte(expense.spentAt, toAt))
  const expenses = await tx.select().from(expense).where(and(...expenseFilters))
  const receivables = await getReceivables(tx, orgId, {})
  type Bucket = { ingresosCents: number; egresosCents: number; gastosCents: number; porCobrarCents: number }
  const byCurrency = new Map<string, Bucket>()
  const bucket = (unit: string): Bucket => {
    let entry = byCurrency.get(unit)
    if (!entry) {
      entry = { ingresosCents: 0, egresosCents: 0, gastosCents: 0, porCobrarCents: 0 }
      byCurrency.set(unit, entry)
    }
    return entry
  }
  for (const m of movements) {
    // La apertura es efectivo que quedó (ya contado en su ventana): no es ingreso nuevo.
    if (m.kind === "apertura") continue
    const entry = bucket(m.currency)
    if (m.direction === "ingreso") entry.ingresosCents = addCents(entry.ingresosCents, m.amountCents)
    else entry.egresosCents = addCents(entry.egresosCents, m.amountCents)
  }
  for (const item of expenses)
    bucket(item.currency).gastosCents = addCents(bucket(item.currency).gastosCents, item.amountCents)
  for (const row of receivables) {
    if (row.outstandingCents > 0) {
      const entry = bucket(row.charge.currency)
      entry.porCobrarCents = addCents(entry.porCobrarCents, row.outstandingCents)
    }
  }
  return {
    byCurrency: [...byCurrency.entries()].map(([unit, totals]) => ({
      currency: unit,
      ...totals,
      balanceCents: totals.ingresosCents - totals.egresosCents,
    })),
    openShifts: shifts.filter((s) => s.status === "abierta").length,
    shifts: shifts.length,
  }
}
