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
import { formatMoney } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { conversation } from "@odentia/db/schema/crm"
import {
  encounter,
  encounterProcedure,
  patient,
  patientCharge,
  patientContact,
  patientPayment,
  patientPaymentApplication,
  patientPaymentRefund,
  paymentTicket,
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
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { promotionServicePrice } from "@odentia/db/schema/promotions"
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm"
import {
  branchNotFound,
  isUniqueViolation,
  notFound,
  ServiceError,
  validation,
} from "./errors.js"
import { getOrgLocale, orgProfileRequired } from "./locale.js"
import { monthStart } from "./report-periods.js"
import { bySpan, safeCents, type Span, spansSql } from "./report-spans.js"
import { createWorkspaceNotification } from "./workspace.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
export const MOVEMENT_DIRECTIONS = ["ingreso", "egreso"] as const
export const EXPENSE_CATEGORIES = ["Personal", "Alquiler", "Laboratorio", "Materiales", "Servicios", "Impuestos", "Otros"] as const

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

export function assertCents(value: number, field = "El importe"): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
    throw validation(`${field} debe ser un importe entero mayor que cero`)
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

/** Suma exacta de importes enteros: revienta antes de salir del rango entero seguro. */
function addCents(a: number, b: number): number {
  const total = a + b
  if (!Number.isSafeInteger(total)) throw validation("El total excede el rango exacto admitido")
  return total
}

/**
 * Aviso de organización: la caja cambió (gasto, ingreso, retiro, anulación o
 * cierre). Solo dice que algo cambió; quien escucha vuelve a consultar.
 */
async function notifyCash(tx: Db, orgId: string): Promise<void> {
  const payload = { orgId, kind: "finance.cash.updated", at: new Date().toISOString() }
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
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
  if (!row) throw branchNotFound()
  return row
}
/** Moneda de la clínica con bloqueo compartido: orden perfil→caja, sin deadlocks con el cambio de región. */
async function lockOrgCurrency(tx: Db, orgId: string): Promise<string> {
  const [profile] = await tx
    .select({ currency: orgProfile.currency })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .for("share")
  // Sin respaldo de un país: la moneda sale del perfil o no hay operación.
  if (!profile) throw orgProfileRequired()
  return profile.currency
}

async function requireShift(tx: Db, orgId: string, shiftId: string) {
  const [row] = await tx
    .select()
    .from(cashShift)
    .where(and(eq(cashShift.id, shiftId), eq(cashShift.organizationId, orgId)))
  if (!row) throw notFound("Turno de caja")
  return row
}

/**
 * Ventana bloqueada para escribir: serializa con el cierre, que toma el mismo
 * bloqueo de fila. Tras esperar, el estado leído ya es el confirmado.
 */
async function lockShift(tx: Db, orgId: string, shiftId: string) {
  const [row] = await tx
    .select()
    .from(cashShift)
    .where(and(eq(cashShift.id, shiftId), eq(cashShift.organizationId, orgId)))
    .for("update")
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

/** Serializa todo lo que crea o cierra la ventana de una sede y moneda. */
async function lockCashWindow(tx: Db, orgId: string, branchId: string, unit: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('cash:' || ${orgId} || ':' || ${branchId} || ':' || ${unit}))`,
  )
}

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
  await lockCashWindow(tx, orgId, branchId, currencyCode)
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

/**
 * Un cobro es electrónico por su tipo UN/CEFACT 4461 (10 = efectivo). El
 * nombre del medio nunca decide: todo movimiento con medio lleva el tipo.
 */
function isElectronic(m: { kind: string; methodTypeCode: string | null }): boolean {
  if (m.kind !== "cobro") return false
  return m.methodTypeCode !== null && m.methodTypeCode !== "10"
}

/**
 * Un egreso sale del efectivo si no lleva medio (gasto de caja, retiro) o su
 * medio es efectivo. La devolución o compensación por otro medio no toca el
 * contado: el dinero salió por ese medio, no del cajón.
 */
function isCashEgreso(m: { direction: string; methodTypeCode: string | null }): boolean {
  if (m.direction !== "egreso") return false
  return m.methodTypeCode === null || m.methodTypeCode === "10"
}

type CashMove = typeof cashMovement.$inferSelect

/**
 * De dónde sale el efectivo que debe haber. Siempre suma el esperado:
 * quedó + cobros + ingresado − gastos − retirado − devuelto.
 */
export interface CashBreakdown {
  /** Lo que quedó del cierre anterior. */
  openingCents: number
  /** Cobros en efectivo. */
  cashCollectedCents: number
  /** Efectivo ingresado a mano (fondo, cambio). */
  cashAddedCents: number
  /** Gastos pagados con efectivo de la caja. */
  cashExpensesCents: number
  /** Efectivo retirado a mano. */
  cashWithdrawnCents: number
  /** Efectivo devuelto a pacientes. */
  cashRefundedCents: number
}

function cashBreakdown(movements: CashMove[]): CashBreakdown {
  const total = (keep: (m: CashMove) => boolean) =>
    sumCents(movements.filter(keep).map((m) => ({ amountCents: m.amountCents })))
  return {
    openingCents: total((m) => m.direction === "ingreso" && m.kind === "apertura"),
    cashCollectedCents: total((m) => m.direction === "ingreso" && m.kind === "cobro" && !isElectronic(m)),
    cashAddedCents: total((m) => m.direction === "ingreso" && m.kind === "aporte"),
    cashExpensesCents: total((m) => isCashEgreso(m) && m.kind === "gasto"),
    cashWithdrawnCents: total((m) => isCashEgreso(m) && m.kind === "retiro"),
    cashRefundedCents: total((m) => isCashEgreso(m) && m.kind === "devolucion"),
  }
}

/** Total por medio de la ventana: lo cobrado y, aparte, lo devuelto por ese medio. */
export interface MethodTotal {
  name: string
  typeCode: string | null
  /** Movimientos de cobro (un ticket con dos medios cuenta en cada uno). */
  count: number
  amountCents: number
  /** Devuelto por ese mismo medio (devoluciones y anulaciones posteriores al cierre). */
  refundedCents: number
}

function methodTotals(movements: CashMove[]): MethodTotal[] {
  const byMethod: Record<string, MethodTotal> = {}
  const entryOf = (m: CashMove): MethodTotal => {
    const name = m.method ?? "Otro"
    byMethod[name] ??= { name, typeCode: m.methodTypeCode, count: 0, amountCents: 0, refundedCents: 0 }
    return byMethod[name]
  }
  for (const m of movements) {
    if (m.direction === "ingreso" && m.kind === "cobro") {
      const entry = entryOf(m)
      entry.count += 1
      entry.amountCents = addCents(entry.amountCents, m.amountCents)
    } else if (m.direction === "egreso" && m.kind === "devolucion" && m.method) {
      const entry = entryOf(m)
      entry.refundedCents = addCents(entry.refundedCents, m.amountCents)
    }
  }
  return Object.values(byMethod)
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
  const out = movements.filter(isCashEgreso)
  const electronicOut = movements.filter((m) => m.direction === "egreso" && !isCashEgreso(m))
  const ingresosCents = sumCents(cashIn.map((m) => ({ amountCents: m.amountCents })))
  const electronicosCents = sumCents(electronic.map((m) => ({ amountCents: m.amountCents })))
  const egresosCents = sumCents(out.map((m) => ({ amountCents: m.amountCents })))
  const egresosElectronicosCents = sumCents(electronicOut.map((m) => ({ amountCents: m.amountCents })))
  return {
    shift,
    movements,
    /** Efectivo que entró: lo que quedó del cierre anterior, cobros en efectivo e ingresos a mano. */
    ingresosCents,
    electronicosCents,
    /** Solo lo que salió del cajón; lo devuelto por otro medio va aparte. */
    egresosCents,
    egresosElectronicosCents,
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
  const shift = requireOpenShift(await lockShift(tx, orgId, shiftId))
  if (!MOVEMENT_DIRECTIONS.includes(input.direction)) throw validation("Dirección inválida")
  if (!["aporte", "retiro"].includes(input.kind))
    throw validation("Los cobros, gastos y devoluciones se registran por su propio flujo")
  // Ingresar es un aporte y retirar es un retiro: no hay otra combinación.
  if ((input.kind === "aporte") !== (input.direction === "ingreso"))
    throw validation("Ingresar efectivo es un aporte y retirarlo es un retiro")
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
  await notifyCash(tx, orgId)
  return row
}

export interface CashMovementInput {
  branchId: string
  kind: "aporte" | "retiro"
  amountCents: number
  concept: string
  currency?: string
}

/**
 * Ingresar o retirar efectivo en la caja de una sede. La ventana nace sola si
 * aún no existía: una sede nueva puede recibir su fondo inicial sin cobrar antes.
 */
export async function addCashMovement(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CashMovementInput,
) {
  const unit = input.currency ? currency(input.currency) : await lockOrgCurrency(tx, orgId)
  const shift = await ensureOpenShift(tx, orgId, actorUserId, input.branchId, unit)
  return addShiftMovement(tx, orgId, actorUserId, shift.id, {
    direction: input.kind === "aporte" ? "ingreso" : "egreso",
    kind: input.kind,
    amountCents: input.amountCents,
    concept: input.concept,
  })
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
  const shift = requireOpenShift(await lockShift(tx, orgId, shiftId))
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
  const shift = requireOpenShift(await lockShift(tx, orgId, shiftId))
  if (input.currency !== shift.currency)
    throw conflict("CURRENCY_MISMATCH", "El egreso es de otra moneda que la caja")
  const amount = assertCents(input.amountCents)
  // Solo lo que sale del cajón exige efectivo: lo devuelto por otro medio no lo toca.
  const fromCash = isCashEgreso({ direction: "egreso", methodTypeCode: input.methodTypeCode ?? null })
  if (fromCash && !input.allowNegative) await requireCashAvailable(tx, orgId, shift.id, amount)
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
  // Bloqueada: un cierre simultáneo espera o ya se ve cerrado, nunca a medias.
  const shift = await lockShift(tx, orgId, movement.shiftId)
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
    methodName: payment.methodName,
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
  requireOpenShift(await lockShift(tx, orgId, current.shiftId))
  if (current.kind === "apertura")
    throw conflict("OPENING_IMMUTABLE", "La apertura solo se corrige cerrando el turno con arqueo")
  // Un cobro, un gasto o una devolución se anulan en su origen (ticket o
  // gasto): anular solo su movimiento dejaría el documento vigente y el
  // arqueo cuadrando con dinero que falta.
  if (current.kind !== "aporte" && current.kind !== "retiro")
    throw conflict(
      "MOVEMENT_NOT_MANUAL",
      "Ese movimiento viene de un cobro, un gasto o una devolución: anúlalo desde su ticket o su gasto",
    )
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
  await notifyCash(tx, orgId)
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
    throw validation("El contado debe ser un importe entero mayor o igual a 0")
  for (const [value, label] of [[input.retainedCents, "Lo que queda"], [input.deliveredCents, "Lo que se entrega"]] as const) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw validation(`${label} debe ser un importe entero mayor o igual a 0`)
  }
  if (input.retainedCents + input.deliveredCents !== input.countedCents)
    throw validation("Lo que queda más lo que se entrega suma el contado")
  const detail = await getShiftDetail(tx, orgId, shiftId)
  const closedAt = new Date()
  const difference = input.countedCents - detail.esperadoCents
  const breakdown = cashBreakdown(detail.movements)
  // Los medios que no son efectivo no se cuentan: quedan listados con su
  // total para compararlos con el reporte de cada uno.
  const electronicTotals = methodTotals(detail.movements).filter((total) => total.typeCode !== "10")
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
    openingRetainedCents: breakdown.openingCents,
    cashCollectedCents: breakdown.cashCollectedCents,
    cashAddedCents: breakdown.cashAddedCents,
    expenseCashCents: breakdown.cashExpensesCents,
    cashWithdrawnCents: breakdown.cashWithdrawnCents,
    cashRefundedCents: breakdown.cashRefundedCents,
    expectedCents: detail.esperadoCents,
    countedCents: input.countedCents,
    differenceCents: difference,
    retainedCents: input.retainedCents,
    deliveredCents: input.deliveredCents,
    totalsByMethod: electronicTotals,
    notes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
    closedBy: actorUserId,
    closedAt,
  })
  await audit(tx, orgId, actorUserId, "cash_shift", shiftId, "cash.shift_closed")
  await notifyCash(tx, orgId)
  // La ventana siguiente abre sola con lo que quedó.
  await ensureOpenShift(tx, orgId, actorUserId, locked.branchId, locked.currency)
  if (difference !== 0) {
    // Administración es el dueño y quien administra: ambos reciben el aviso.
    const recipients = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
    const userIds = [...new Set([...recipients.map((r) => r.userId), locked.openedBy].filter((id): id is string => !!id && id !== actorUserId))]
    const { locale } = await getOrgLocale(tx, orgId)
    const branchRow = await requireBranch(tx, orgId, locked.branchId)
    const amount = formatMoney(Math.abs(difference), locked.currency, locale)
    for (const userId of userIds) {
      await createWorkspaceNotification(tx, orgId, {
        userId,
        dedupeKey: `cash-shift-diff:${shiftId}`,
        title: "La caja cerró con diferencia",
        body:
          difference > 0
            ? `En ${branchRow.name} sobraron ${amount} al contar el efectivo.`
            : `En ${branchRow.name} faltaron ${amount} al contar el efectivo.`,
        href: `/finance?cierre=${shiftId}`,
        permission: "finance.read",
        actorUserId,
      })
    }
  }
  return row
}

export interface CloseCashInput extends CloseShiftInput {
  branchId: string
  currency?: string
  /**
   * Ventana que la persona tenía a la vista al contar. Con su identificador,
   * repetir el cierre (doble envío, reintento) devuelve ese mismo cierre en
   * vez de cerrar la ventana recién abierta. `null` afirma que no había
   * ventana: si entretanto nació una, hay que volver a contar. Omitido
   * cierra la ventana actual (uso interno: semilla y pruebas).
   */
  shiftId?: string | null
}

/** Cierra la ventana de una sede y moneda (la crea si aún no existía). */
export async function closeCashWindow(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CloseCashInput,
) {
  if (input.shiftId) {
    const seen = await requireShift(tx, orgId, input.shiftId)
    if (seen.branchId !== input.branchId) throw notFound("Turno de caja")
    // Ya cerrada: `closeShift` devuelve el cierre existente, sin efectos.
    return closeShift(tx, orgId, actorUserId, seen.id, input)
  }
  const unit = input.currency ? currency(input.currency) : await lockOrgCurrency(tx, orgId)
  if (input.shiftId === null) {
    await requireBranch(tx, orgId, input.branchId)
    await lockCashWindow(tx, orgId, input.branchId, unit)
    const [open] = await tx
      .select({ id: cashShift.id })
      .from(cashShift)
      .where(
        and(
          eq(cashShift.organizationId, orgId),
          eq(cashShift.branchId, input.branchId),
          eq(cashShift.currency, unit),
          eq(cashShift.status, "abierta"),
        ),
      )
      .limit(1)
    if (open)
      throw conflict(
        "CASH_WINDOW_CHANGED",
        "La caja tuvo movimientos mientras contabas: revisa los importes y vuelve a cerrar",
      )
  }
  const shift = await ensureOpenShift(tx, orgId, actorUserId, input.branchId, unit)
  return closeShift(tx, orgId, actorUserId, shift.id, input)
}

/** Hubo un cierre de esa sede y moneda después del instante dado. */
export async function hasClosureSince(
  tx: Db,
  orgId: string,
  branchId: string,
  unit: string,
  since: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: cashClosure.id })
    .from(cashClosure)
    .where(
      and(
        eq(cashClosure.organizationId, orgId),
        eq(cashClosure.branchId, branchId),
        eq(cashClosure.currency, unit),
        gte(cashClosure.closedAt, since),
      ),
    )
    .limit(1)
  return !!row
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
  await notifyCash(tx, orgId)
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
 * Gastos de un mes (el de la zona horaria de la clínica) con su total por
 * tipo. Los anulados siguen en la lista, marcados, y no suman.
 */
export async function getMonthExpenses(
  tx: Db,
  orgId: string,
  query: { year: number; month: number; branchId?: string },
) {
  const { timezone, currency: unit } = await getOrgLocale(tx, orgId)
  const { start, end } = monthBounds(timezone, query.year, query.month)
  const filters = [eq(expense.organizationId, orgId), gte(expense.spentAt, start), lt(expense.spentAt, end)]
  if (query.branchId) filters.push(eq(expense.branchId, query.branchId))
  const rows = await tx
    .select()
    .from(expense)
    .where(and(...filters))
    .orderBy(desc(expense.spentAt), desc(expense.id))
  const live = rows.filter((row) => !row.voidedAt && row.currency === unit)
  const byCategory = new Map<string, number>()
  for (const row of live) byCategory.set(row.category, addCents(byCategory.get(row.category) ?? 0, row.amountCents))
  return {
    year: query.year,
    month: query.month,
    currency: unit,
    timezone,
    totalCents: sumCents(live.map((row) => ({ amountCents: row.amountCents }))),
    byCategory: [...byCategory.entries()]
      .map(([category, cents]) => ({ category, cents }))
      .sort((a, b) => b.cents - a.cents),
    expenses: rows.map((row) => ({ ...row, fromCash: row.shiftId !== null })),
  }
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
  opts: { fromCommission?: boolean } = {},
) {
  const [current] = await tx
    .select()
    .from(expense)
    .where(and(eq(expense.id, expenseId), eq(expense.organizationId, orgId)))
  if (!current) throw notFound("Gasto")
  if (current.voidedAt) throw conflict("EXPENSE_VOIDED", "El gasto ya está anulado")
  // El gasto que registra el pago de una comisión se anula con ese pago: si
  // se anulara suelto, la comisión seguiría «pagada» sin su gasto.
  if (!opts.fromCommission) {
    const [linked] = await tx
      .select({ id: commissionSettlement.id })
      .from(commissionSettlement)
      .where(
        and(
          eq(commissionSettlement.organizationId, orgId),
          eq(commissionSettlement.expenseId, expenseId),
          isNull(commissionSettlement.voidedAt),
        ),
      )
      .limit(1)
    if (linked)
      throw conflict(
        "EXPENSE_IS_COMMISSION",
        "Ese gasto es el pago de una comisión: anula el pago desde Comisiones",
      )
  }
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
    // Bloqueada: un cierre simultáneo espera o ya se ve cerrado.
    const shift = await lockShift(tx, orgId, current.shiftId)
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
  await notifyCash(tx, orgId)
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
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 }
  return { start: monthStart(timezone, year, month), end: monthStart(timezone, next.y, next.m) }
}

/** Vigente en el mes: no anulado, o anulado después del fin de mes. */
function liveInMonth(voidedAt: Date | null, end: Date): boolean {
  return voidedAt === null || voidedAt >= end
}

/** Efectivo por tipo UN/CEFACT 4461 (10); el nombre del medio nunca decide. */
function methodCashOf(payment: { methodTypeCode: string | null }): boolean {
  return payment.methodTypeCode === "10"
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
  /** Precio acordado del concepto (solo en el desglose por promoción). */
  chargeAmountCents?: number
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
  query: {
    professionalUserId?: string
    branchId?: string
    /**
     * `true`: solo lo que sigue en pie hoy (comisiones: lo anulado deja de
     * deberse). Por defecto, lo que estaba en pie al terminar el mes (reportes
     * de un mes ya cerrado, que no cambian por lo que pase después).
     */
    liveNow?: boolean
  } = {},
): Promise<CollectedApp[]> {
  const stillLive = (column: typeof patientPaymentApplication.voidedAt | typeof patientCharge.voidedAt | typeof patientPayment.voidedAt) =>
    query.liveNow ? isNull(column) : or(isNull(column), gte(column, end))
  const filters = [
    eq(patientPaymentApplication.organizationId, orgId),
    gte(patientPaymentApplication.createdAt, start),
    lt(patientPaymentApplication.createdAt, end),
    stillLive(patientPaymentApplication.voidedAt),
    eq(patientCharge.currency, currency),
    stillLive(patientCharge.voidedAt),
    stillLive(patientPayment.voidedAt),
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
    methodLabel: r.payment.methodName,
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
    chargeAmountCents: r.charge.amountCents,
    paymentId: r.payment.id,
  }))
}

/**
 * Modo de cada promoción: «desde» si alguno de sus servicios admite precio
 * abierto, fijo si todos lo traen cerrado, ausente si ya no tiene servicios.
 */
async function promotionModes(
  tx: Db,
  orgId: string,
  promotionIds: string[],
): Promise<Map<string, "fixed" | "from">> {
  const out = new Map<string, "fixed" | "from">()
  // El cargo guarda la promoción como texto: solo se consultan identificadores válidos.
  const ids = promotionIds.filter((id) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id))
  if (ids.length === 0) return out
  const rows = await tx
    .select({ promotionId: promotionServicePrice.promotionId, mode: promotionServicePrice.mode })
    .from(promotionServicePrice)
    .where(
      and(
        eq(promotionServicePrice.organizationId, orgId),
        inArray(promotionServicePrice.promotionId, ids),
      ),
    )
  for (const row of rows) {
    if (row.mode === "from") out.set(row.promotionId, "from")
    else if (!out.has(row.promotionId)) out.set(row.promotionId, "fixed")
  }
  return out
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
  patientName: string
  description: string
  /** Lo cobrado de ese concepto en ese cobro. */
  baseCents: number
  rateBps: number
  commissionCents: number
  occurredAt: Date
  promotionName: string | null
  /** Ya entró en un pago registrado: su porcentaje e importe quedaron congelados. */
  settled: boolean
  /** Cuándo se pagó (nulo si aún no). */
  paidAt: Date | null
  /** El cobro se anuló después de pagada su comisión: se descuenta del siguiente pago. */
  voidedAfterPaid: boolean
}

/** Comisión ya pagada por un cobro que después se anuló. */
export interface CommissionAdjustment {
  applicationId: string
  patientId: string
  patientName: string
  description: string
  commissionCents: number
  /** Cuándo se pagó la comisión que ahora se descuenta. */
  paidAt: Date | null
}

export type CommissionStatus = "por_pagar" | "pagado" | "sin_cobros" | "por_descontar"

interface FrozenLine {
  line: typeof commissionSettlementLine.$inferSelect
  settledAt: Date | null
}

/** Líneas ya pagadas del profesional (pagos vigentes), con la fecha del pago. */
async function frozenLines(tx: Db, orgId: string, professionalUserId: string): Promise<FrozenLine[]> {
  const rows = await tx
    .select({ line: commissionSettlementLine, settledAt: commissionSettlement.settledAt })
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
  return rows
}

async function patientNames(tx: Db, orgId: string, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await tx
    .select({ id: patient.id, displayName: patientPerson.displayName })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.organizationId, orgId), inArray(patient.id, unique)))
  return new Map(rows.map((r) => [r.id, r.displayName]))
}

export interface MonthlyCommissionsQuery {
  professionalUserId: string
  year: number
  month: number
  /** Por defecto, la moneda de la clínica. */
  currency?: string
}

/**
 * Mes de un profesional: cada cobro de lo que atendió, con su comisión.
 *
 * - Lo aún no pagado usa el porcentaje vigente y solo cuenta mientras el
 *   cobro siga en pie: si se anula antes de pagar, deja de deberse.
 * - Lo ya pagado conserva el porcentaje y el importe con que se pagó, aunque
 *   el porcentaje cambie después.
 * - Un cobro anulado después de pagada su comisión queda como ajuste: se
 *   descuenta del siguiente pago al profesional, sea del mes que sea.
 */
export async function getMonthlyCommissions(tx: Db, orgId: string, query: MonthlyCommissionsQuery) {
  await requireProfessional(tx, orgId, query.professionalUserId)
  const { timezone, locale, currency: orgCurrency } = await getOrgLocale(tx, orgId)
  const unit = query.currency ? currency(query.currency) : orgCurrency
  const { start, end } = monthBounds(timezone, query.year, query.month)
  const rateBps = await commissionRateOf(tx, orgId, query.professionalUserId)
  const live = await collectedApplications(tx, orgId, start, end, unit, {
    professionalUserId: query.professionalUserId,
    liveNow: true,
  })
  const liveById = new Map(live.map((app) => [app.appId, app]))
  const frozen = await frozenLines(tx, orgId, query.professionalUserId)
  const frozenCobros = frozen.filter((f) => f.line.kind === "cobro" && f.line.applicationId)
  const adjusted = new Set(
    frozen.filter((f) => f.line.kind === "ajuste" && f.line.applicationId).map((f) => f.line.applicationId as string),
  )
  // Cobros pagados cuya aplicación ya no está en pie (cualquier mes).
  const paidIds = frozenCobros.map((f) => f.line.applicationId as string)
  const stillLive = new Set<string>()
  if (paidIds.length > 0) {
    const rows = await tx
      .select({ id: patientPaymentApplication.id })
      .from(patientPaymentApplication)
      .innerJoin(
        patientPayment,
        and(eq(patientPayment.id, patientPaymentApplication.paymentId), eq(patientPayment.organizationId, orgId)),
      )
      .innerJoin(
        patientCharge,
        and(eq(patientCharge.id, patientPaymentApplication.chargeId), eq(patientCharge.organizationId, orgId)),
      )
      .where(
        and(
          eq(patientPaymentApplication.organizationId, orgId),
          inArray(patientPaymentApplication.id, paidIds),
          isNull(patientPaymentApplication.voidedAt),
          isNull(patientPayment.voidedAt),
          isNull(patientCharge.voidedAt),
        ),
      )
    for (const row of rows) stillLive.add(row.id)
  }
  const names = await patientNames(tx, orgId, [
    ...live.map((app) => app.patientId),
    ...frozenCobros.map((f) => f.line.patientId).filter((id): id is string => !!id),
  ])
  const inMonth = (at: Date) => at >= start && at < end
  const lines: CommissionLine[] = []
  const paidThisMonth = new Set<string>()
  for (const f of frozenCobros) {
    const appId = f.line.applicationId as string
    if (!inMonth(f.line.occurredAt)) continue
    paidThisMonth.add(appId)
    lines.push({
      applicationId: appId,
      chargeId: f.line.chargeId ?? "",
      paymentId: f.line.paymentId ?? "",
      patientId: f.line.patientId ?? "",
      patientName: f.line.patientId ? (names.get(f.line.patientId) ?? "") : "",
      description: f.line.description,
      baseCents: f.line.baseCents,
      rateBps: f.line.rateBps ?? rateBps,
      commissionCents: f.line.commissionCents,
      occurredAt: f.line.occurredAt,
      promotionName: liveById.get(appId)?.chargePromotionName ?? null,
      settled: true,
      paidAt: f.settledAt,
      voidedAfterPaid: !stillLive.has(appId),
    })
  }
  for (const app of live) {
    if (paidThisMonth.has(app.appId)) continue
    lines.push({
      applicationId: app.appId,
      chargeId: app.chargeId,
      paymentId: app.paymentId,
      patientId: app.patientId,
      patientName: names.get(app.patientId) ?? "",
      description: app.chargeDescription,
      baseCents: app.appCents,
      rateBps,
      commissionCents: Math.floor((app.appCents * rateBps) / 10000),
      occurredAt: app.appCreatedAt,
      promotionName: app.chargePromotionName,
      settled: false,
      paidAt: null,
      voidedAfterPaid: false,
    })
  }
  lines.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.applicationId < b.applicationId ? -1 : 1))
  const adjustments: CommissionAdjustment[] = frozenCobros
    .filter((f) => {
      const appId = f.line.applicationId as string
      return !stillLive.has(appId) && !adjusted.has(appId) && f.line.commissionCents > 0
    })
    .map((f) => ({
      applicationId: f.line.applicationId as string,
      patientId: f.line.patientId ?? "",
      patientName: f.line.patientId ? (names.get(f.line.patientId) ?? "") : "",
      description: f.line.description,
      commissionCents: f.line.commissionCents,
      paidAt: f.settledAt,
    }))
  const counted = lines.filter((line) => !line.voidedAfterPaid)
  const fresh = lines.filter((line) => !line.settled)
  const paid = lines.filter((line) => line.settled)
  const adjustmentCents = sumCents(adjustments.map((a) => ({ amountCents: a.commissionCents })))
  const freshCents = sumCents(fresh.map((l) => ({ amountCents: l.commissionCents })))
  const pendingCents = freshCents - adjustmentCents
  const paidCents = sumCents(paid.map((l) => ({ amountCents: l.commissionCents })))
  const lastPaidAt = paid.reduce<Date | null>(
    (latest, line) => (line.paidAt && (!latest || line.paidAt > latest) ? line.paidAt : latest),
    null,
  )
  const status: CommissionStatus =
    pendingCents > 0 ? "por_pagar" : pendingCents < 0 ? "por_descontar" : paidCents > 0 ? "pagado" : "sin_cobros"
  const professionalNames = await userNames(tx, [query.professionalUserId])
  return {
    professionalUserId: query.professionalUserId,
    professionalName: professionalNames.get(query.professionalUserId) ?? null,
    year: query.year,
    month: query.month,
    currency: unit,
    timezone,
    locale,
    /** Porcentaje vigente (lo aún no pagado se calcula con él). */
    rateBps,
    lines,
    adjustments,
    /** Lo cobrado en el mes de lo que atendió (sin lo anulado). */
    baseCents: sumCents(counted.map((l) => ({ amountCents: l.baseCents }))),
    /** Lo que le corresponde por el mes. */
    commissionCents: sumCents(counted.map((l) => ({ amountCents: l.commissionCents }))),
    paidCents,
    /** Lo que falta pagarle hoy: lo nuevo del mes menos lo que haya que descontar. */
    pendingCents,
    adjustmentCents,
    lastPaidAt,
    status,
  }
}

export type MonthlyCommissions = Awaited<ReturnType<typeof getMonthlyCommissions>>

/** Resumen de un mes para listas: sin el detalle por cobro. */
function commissionSummary(view: MonthlyCommissions) {
  return {
    professionalUserId: view.professionalUserId,
    professionalName: view.professionalName,
    year: view.year,
    month: view.month,
    currency: view.currency,
    rateBps: view.rateBps,
    collections: view.lines.filter((line) => !line.voidedAfterPaid).length,
    baseCents: view.baseCents,
    commissionCents: view.commissionCents,
    paidCents: view.paidCents,
    pendingCents: view.pendingCents,
    lastPaidAt: view.lastPaidAt,
    status: view.status,
  }
}

export type CommissionSummary = ReturnType<typeof commissionSummary>

/**
 * El mes de toda la clínica: una fila por profesional con porcentaje fijado
 * o con cobros de lo que atendió ese mes.
 */
export async function listMonthCommissions(
  tx: Db,
  orgId: string,
  query: { year: number; month: number; currency?: string },
): Promise<CommissionSummary[]> {
  const { timezone, currency: orgCurrency } = await getOrgLocale(tx, orgId)
  const unit = query.currency ? currency(query.currency) : orgCurrency
  const { start, end } = monthBounds(timezone, query.year, query.month)
  const withRate = await tx
    .select({ userId: commissionRule.professionalUserId })
    .from(commissionRule)
    .where(eq(commissionRule.organizationId, orgId))
  const active = await collectedApplications(tx, orgId, start, end, unit, { liveNow: true })
  const ids = [...new Set([...withRate.map((r) => r.userId), ...active.map((a) => a.dentistUserId)])]
  // Solo quienes siguen en la clínica; el histórico de un ex miembro se ve en sus pagos.
  const members = ids.length
    ? await tx
        .select({ userId: member.userId })
        .from(member)
        .where(and(eq(member.organizationId, orgId), inArray(member.userId, ids)))
    : []
  const rows: CommissionSummary[] = []
  for (const { userId } of members) {
    rows.push(
      commissionSummary(
        await getMonthlyCommissions(tx, orgId, { ...query, currency: unit, professionalUserId: userId }),
      ),
    )
  }
  return rows.sort(
    (a, b) => b.commissionCents - a.commissionCents || (a.professionalName ?? "").localeCompare(b.professionalName ?? ""),
  )
}

/**
 * Lo propio de un profesional: el mes pedido con su detalle y los meses
 * anteriores resumidos, con la fecha en que se le pagó cada uno.
 */
export async function getMyCommissions(
  tx: Db,
  orgId: string,
  userId: string,
  query: { year: number; month: number; currency?: string },
) {
  const current = await getMonthlyCommissions(tx, orgId, { ...query, professionalUserId: userId })
  const previous: CommissionSummary[] = []
  let year = query.year
  let month = query.month
  for (let i = 0; i < 3; i += 1) {
    month -= 1
    if (month === 0) {
      month = 12
      year -= 1
    }
    if (year < 2000) break
    const view = await getMonthlyCommissions(tx, orgId, {
      professionalUserId: userId,
      year,
      month,
      currency: current.currency,
    })
    if (view.lines.length > 0) previous.push(commissionSummary(view))
  }
  return { ...current, previous }
}

export interface PayMonthCommissionInput {
  professionalUserId: string
  year: number
  month: number
  currency?: string
  /** Sede a la que se imputa el gasto de Personal. */
  branchId: string
  notes?: string | null
  /** Importe que la pantalla mostró al confirmar: si ya no es ese, no se paga otra cifra. */
  expectedCents?: number
}

/**
 * Registra el pago de lo que falta pagar del mes, en un solo paso: congela
 * los cobros aún no pagados (y descuenta los que se anularon después de
 * pagados) y deja el gasto de Personal. Se puede pagar más de una vez en el
 * mes: cada pago cubre lo pendiente hasta ese momento, y ningún cobro entra
 * en dos pagos.
 */
export async function payMonthCommission(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: PayMonthCommissionInput,
) {
  // Un pago a la vez por profesional: dos envíos simultáneos no duplican el gasto.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`commission:${orgId}:${input.professionalUserId}`}, 0))`,
  )
  const branchRow = await requireBranch(tx, orgId, input.branchId)
  const view = await getMonthlyCommissions(tx, orgId, input)
  const fresh = view.lines.filter((line) => !line.settled)
  if (fresh.length === 0 && view.adjustments.length === 0)
    throw conflict("COMMISSION_NOTHING_TO_PAY", "No hay nada por pagar de ese mes")
  if (view.pendingCents <= 0)
    throw conflict(
      "COMMISSION_NOT_POSITIVE",
      "Lo que se anuló después de pagado cubre lo de este mes: se descontará cuando haya más cobros",
    )
  if (input.expectedCents !== undefined && input.expectedCents !== view.pendingCents)
    throw conflict(
      "COMMISSION_AMOUNT_CHANGED",
      "El importe por pagar cambió mientras lo revisabas: vuelve a mirarlo antes de pagar",
    )
  const paidAt = new Date()
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
      commissionCents: view.pendingCents,
      status: "liquidada",
      notes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
      settledBy: actorUserId,
      settledAt: paidAt,
    })
    .returning()
  if (!settlement) throw new ServiceError("INTERNAL", 409, "No se pudo registrar el pago")
  try {
    for (const line of fresh) {
      await tx.insert(commissionSettlementLine).values({
        organizationId: orgId,
        settlementId: settlement.id,
        kind: "cobro",
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
    for (const adjustment of view.adjustments) {
      await tx.insert(commissionSettlementLine).values({
        organizationId: orgId,
        settlementId: settlement.id,
        kind: "ajuste",
        sourceKey: `adj:${adjustment.applicationId}`,
        applicationId: adjustment.applicationId,
        patientId: adjustment.patientId || null,
        description: adjustment.description,
        baseCents: 0,
        commissionCents: adjustment.commissionCents,
        occurredAt: paidAt,
      })
    }
  } catch (e) {
    // La unicidad por fuente respalda al bloqueo: un cobro nunca entra dos veces.
    if (isUniqueViolation(e))
      throw conflict("COMMISSION_ALREADY_PAID", "Parte de esos cobros ya está en otro pago registrado")
    throw e
  }
  const names = await userNames(tx, [input.professionalUserId])
  const professionalName = names.get(input.professionalUserId) ?? ""
  const monthLabel = new Intl.DateTimeFormat(view.locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(input.year, input.month - 1, 15)),
  )
  const [paidExpense] = await tx
    .insert(expense)
    .values({
      organizationId: orgId,
      branchId: branchRow.id,
      concept: `Comisión de ${monthLabel} — ${professionalName}`.slice(0, 500),
      amountCents: view.pendingCents,
      currency: view.currency,
      category: COMMISSION_EXPENSE_CATEGORY,
      spentAt: paidAt,
      receiptKind: "ninguno",
      createdBy: actorUserId,
    })
    .returning()
  if (!paidExpense) throw new ServiceError("INTERNAL", 409, "No se pudo registrar el gasto")
  const [paid] = await tx
    .update(commissionSettlement)
    .set({ expenseId: paidExpense.id, updatedAt: paidAt })
    .where(and(eq(commissionSettlement.id, settlement.id), eq(commissionSettlement.organizationId, orgId)))
    .returning()
  await audit(tx, orgId, actorUserId, "commission_settlement", settlement.id, "finance.commission_paid")
  await audit(tx, orgId, actorUserId, "expense", paidExpense.id, "finance.expense_created")
  await createWorkspaceNotification(tx, orgId, {
    userId: input.professionalUserId,
    dedupeKey: `commission-paid:${settlement.id}`,
    title: "Se registró el pago de tu comisión",
    body: `${monthLabel}: ${formatMoney(view.pendingCents, view.currency, view.locale)}.`,
    href: `/commissions?year=${input.year}&month=${input.month}`,
    permission: "commissions.read",
    actorUserId,
  })
  return { settlement: paid ?? settlement, expense: paidExpense }
}

/**
 * Pagos registrados de un profesional o de un mes. Vigentes por defecto; con
 * `includeVoided` también los anulados, con quién los anuló.
 */
export async function listCommissionSettlements(
  tx: Db,
  orgId: string,
  query: { professionalUserId?: string; year?: number; month?: number; includeVoided?: boolean } = {},
) {
  const filters = [eq(commissionSettlement.organizationId, orgId)]
  if (!query.includeVoided) filters.push(isNull(commissionSettlement.voidedAt))
  if (query.professionalUserId)
    filters.push(eq(commissionSettlement.professionalUserId, query.professionalUserId))
  if (query.year) filters.push(eq(commissionSettlement.periodYear, query.year))
  if (query.month) filters.push(eq(commissionSettlement.periodMonth, query.month))
  const rows = await tx
    .select()
    .from(commissionSettlement)
    .where(and(...filters))
    .orderBy(desc(commissionSettlement.settledAt), desc(commissionSettlement.id))
  const names = await userNames(tx, [
    ...rows.map((r) => r.professionalUserId),
    ...rows.map((r) => r.voidedBy).filter((id): id is string => !!id),
  ])
  return rows.map((r) => ({
    ...r,
    professionalName: names.get(r.professionalUserId) ?? null,
    voidedByName: r.voidedBy ? (names.get(r.voidedBy) ?? null) : null,
  }))
}

/**
 * Anula un pago registrado por error: sus cobros vuelven a quedar por pagar
 * y su gasto de Personal se anula con él.
 */
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
    .for("update")
  if (!current) throw notFound("Pago de comisión")
  if (current.voidedAt) throw conflict("SETTLEMENT_VOIDED", "Ese pago ya está anulado")
  const voidReason = reason(input.reason)
  const [row] = await tx
    .update(commissionSettlement)
    .set({
      status: "anulada",
      voidedAt: new Date(),
      voidedBy: actorUserId,
      voidReason,
      updatedAt: new Date(),
    })
    .where(
      and(eq(commissionSettlement.id, settlementId), eq(commissionSettlement.organizationId, orgId)),
    )
    .returning()
  await tx
    .update(commissionSettlementLine)
    .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason })
    .where(
      and(
        eq(commissionSettlementLine.organizationId, orgId),
        eq(commissionSettlementLine.settlementId, settlementId),
        isNull(commissionSettlementLine.voidedAt),
      ),
    )
  // El gasto del pago se anula con él (misma transacción).
  if (current.expenseId)
    await voidExpense(tx, orgId, actorUserId, current.expenseId, { reason: input.reason }, { fromCommission: true })
  await audit(tx, orgId, actorUserId, "commission_settlement", settlementId, "finance.commission_payment_voided")
  return row
}

// --- Resultado de un tramo (Reportes › Dinero) ---------------------------------------------

/** Tramo semiabierto [start, end) de un resultado. */
export interface FinanceResultRange {
  start: Date
  end: Date
  branchId?: string
  currency?: string
}

/**
 * Cobrado, devuelto, anulado y gastado de un tramo, por moneda. Es la base
 * común del resultado completo y de los totales con que se compara un periodo.
 */
async function financeBuckets(
  tx: Db,
  orgId: string,
  start: Date,
  end: Date,
  branch: { id: string } | null,
  unit: string | null,
) {
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
    const key = payment.methodName
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
  return buckets
}

/**
 * Lo cobrado por profesional en un tramo: solo lo atendido, la misma base de
 * las comisiones (aplicaciones del tramo, netas de devoluciones con la regla
 * de las comisiones). Lo usan Finanzas y el Resumen de Reportes.
 */
export async function collectedByProfessional(
  tx: Db,
  orgId: string,
  range: { start: Date; end: Date; branchId?: string },
  curr: string,
): Promise<Array<{ professionalUserId: string; name: string | null; currency: string; cobradoCents: number }>> {
  const apps = await collectedApplications(tx, orgId, range.start, range.end, curr, { branchId: range.branchId })
  const totals = await paymentTotalsOf(
    tx,
    orgId,
    apps.map((a) => a.paymentId),
  )
  for (const app of apps) if (!totals.has(app.paymentId)) totals.set(app.paymentId, app.paymentCents)
  const refundByApp = await allocateRefunds(tx, orgId, apps, totals, range.start, range.end)
  const profSums = new Map<string, number>()
  for (const a of apps) {
    const net = a.appCents - Math.min(a.appCents, refundByApp.get(a.appId) ?? 0)
    profSums.set(a.dentistUserId, (profSums.get(a.dentistUserId) ?? 0) + net)
  }
  const names = await userNames(tx, [...profSums.keys()])
  return [...profSums].map(([professionalUserId, cobradoCents]) => ({
    professionalUserId,
    name: names.get(professionalUserId) ?? null,
    currency: curr,
    cobradoCents,
  }))
}

/**
 * Lo cobrado neto de varios tramos en una sola consulta, por moneda: la misma
 * regla de `netoCents` de `financeBuckets` (cobros del tramo que siguen en pie
 * al cerrarlo, menos las anulaciones del tramo de cobros anteriores y las
 * devoluciones del tramo). Así el Resumen dibuja sus 12 meses sin 12 idas.
 */
export async function collectedNetMany(
  tx: Db,
  orgId: string,
  spans: Span[],
  options: { branchId?: string } = {},
): Promise<Array<Array<{ currency: string; cents: number }>>> {
  const branchOf = (column: SQL): SQL => (options.branchId ? sql`and ${column} = ${options.branchId}` : sql``)
  const rows = await tx.execute<{ idx: number; currency: string; cents: string }>(sql`
    select b.idx, x.currency, sum(x.cents)::text as cents
    from ${spansSql(spans)}
    join lateral (
      select p.currency, p.amount_cents::bigint as cents from patient_payment p
      where p.organization_id = ${orgId} and p.paid_at >= b.start_at and p.paid_at < b.end_at
        and (p.voided_at is null or p.voided_at >= b.end_at) ${branchOf(sql`p.branch_id`)}
      union all
      select p.currency, -p.amount_cents::bigint from patient_payment p
      where p.organization_id = ${orgId} and p.paid_at < b.start_at
        and p.voided_at >= b.start_at and p.voided_at < b.end_at ${branchOf(sql`p.branch_id`)}
      union all
      select p.currency, -r.amount_cents::bigint from patient_payment_refund r
      join patient_payment p on p.id = r.payment_id and p.organization_id = r.organization_id
      where r.organization_id = ${orgId} and r.refunded_at >= b.start_at and r.refunded_at < b.end_at ${branchOf(sql`p.branch_id`)}
    ) x on true
    group by b.idx, x.currency`)
  return bySpan(
    spans,
    [...rows],
    (): Array<{ currency: string; cents: number }> => [],
    (list, row) => [...list, { currency: row.currency, cents: safeCents(row.cents) }],
  )
}

/**
 * Solo los totales por moneda de un tramo: con ellos se compara un periodo con
 * el anterior y se dibujan las barras por mes, sin recalcular los desgloses.
 */
export async function getFinanceTotalsBetween(tx: Db, orgId: string, range: FinanceResultRange) {
  const branch = range.branchId ? await requireBranch(tx, orgId, range.branchId) : null
  const unit = range.currency ? currency(range.currency) : null
  const buckets = await financeBuckets(tx, orgId, range.start, range.end, branch, unit)
  return [...buckets.entries()].map(([curr, entry]) => {
    const netoCents = entry.cobradoCents - entry.devolucionesCents - entry.anulacionesCents
    return { currency: curr, netoCents, gastadoCents: entry.gastadoCents, quedaCents: netoCents - entry.gastadoCents }
  })
}

/**
 * Resultado completo de un tramo: cobrado (pagos vigentes por fecha de pago,
 * sin aportes de caja como ingreso) menos devoluciones y anulaciones, gastado
 * por categoría, queda por moneda, desgloses por medio/profesional/promoción,
 * deuda al cierre del tramo y cierres de caja para conciliar el efectivo.
 */
export async function getFinanceResultBetween(tx: Db, orgId: string, range: FinanceResultRange) {
  const { start, end } = range
  const branch = range.branchId ? await requireBranch(tx, orgId, range.branchId) : null
  const unit = range.currency ? currency(range.currency) : null
  const buckets = await financeBuckets(tx, orgId, start, end, branch, unit)

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
    /** Precio fijo o «desde»; nulo si la promoción ya no tiene servicios. */
    mode: "fixed" | "from" | null
    /** Promedio del precio acordado de sus conceptos (no de lo cobrado). */
    averageCents: number | null
  }> = []
  for (const curr of currencies) {
    byProfessional.push(...(await collectedByProfessional(tx, orgId, { start, end, branchId: branch?.id }, curr)))
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
    const promoAgg = new Map<
      string,
      { name: string; veces: Set<string>; cents: number; agreedCents: number }
    >()
    for (const a of promoApps) {
      const promo = promotions.get(a.appId)
      if (!promo) continue
      const net = a.appCents - Math.min(a.appCents, promoRefunds.get(a.appId) ?? 0)
      const slot = promoAgg.get(promo.id) ?? {
        name: promo.name,
        veces: new Set<string>(),
        cents: 0,
        agreedCents: 0,
      }
      // El precio acordado cuenta una vez por concepto, aunque se pague en partes.
      if (!slot.veces.has(a.chargeId)) slot.agreedCents += a.chargeAmountCents ?? 0
      slot.veces.add(a.chargeId)
      slot.cents += net
      promoAgg.set(promo.id, slot)
    }
    const modes = await promotionModes(tx, orgId, [...promoAgg.keys()])
    for (const [promotionId, agg] of promoAgg)
      byPromotion.push({
        promotionId,
        name: agg.name,
        currency: curr,
        veces: agg.veces.size,
        cobradoCents: agg.cents,
        mode: modes.get(promotionId) ?? null,
        averageCents: agg.veces.size > 0 ? Math.round(agg.agreedCents / agg.veces.size) : null,
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
    {
      cierres: number
      efectivoCents: number
      /** Efectivo devuelto a pacientes en esas ventanas: el resultado compara el efectivo ya descontado. */
      efectivoDevueltoCents: number
      gastosCajaCents: number
      diferenciasCents: number
    }
  >()
  for (const c of closures) {
    const slot = closureAgg.get(c.currency) ?? {
      cierres: 0,
      efectivoCents: 0,
      efectivoDevueltoCents: 0,
      gastosCajaCents: 0,
      diferenciasCents: 0,
    }
    slot.cierres += 1
    slot.efectivoCents = addCents(slot.efectivoCents, c.cashCollectedCents)
    slot.efectivoDevueltoCents = addCents(slot.efectivoDevueltoCents, c.cashRefundedCents)
    slot.gastosCajaCents = addCents(slot.gastosCajaCents, c.expenseCashCents)
    slot.diferenciasCents = addCents(slot.diferenciasCents, c.differenceCents)
    closureAgg.set(c.currency, slot)
  }

  return {
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
  // La zona de la sede o, si no tiene, la de la clínica; nunca una fija.
  return (await getOrgLocale(tx, orgId)).timezone
}

export interface DebtRow {
  patientId: string
  displayName: string
  branchId: string | null
  currency: string
  /** Lo que debe (suma de los saldos de sus conceptos). */
  totalCents: number
  /** Saldo a favor que tiene: al cobrar se descuenta solo. */
  creditCents: number
  oldestSince: Date | null
  latestSince: Date | null
  chargesCount: number
  /** Conceptos pendientes, del más antiguo al más nuevo (hasta tres). */
  concepts: string[]
  /** Última atención que dejó algo por cobrar: cuándo terminó y quién atendió. */
  lastAttended: { at: Date; dentistName: string | null } | null
  /**
   * Cuándo salió hoy de su atención (o se le anotó algo hoy), en el día de la
   * sede; null si debe de antes. Con esto se arma «Atendidos hoy» de la caja y
   * «Por cobrar» de Inicio: la regla vive aquí y ninguna pantalla la repite.
   */
  attendedTodayAt: Date | null
  /** La persona (su vínculo `self`): a quien se le escribe. */
  contactId: string | null
  /** Su conversación abierta más reciente, si tiene alguna. */
  conversationId: string | null
}

/**
 * Deudas por persona, de mayor a menor importe. Sin sede lista todo; con sede,
 * lo de esa sede más lo que nació sin sede. Lo aceptado sin atender no es
 * deuda: solo conceptos vigentes con saldo.
 */
export async function getDebts(
  tx: Db,
  orgId: string,
  query: { branchId?: string } = {},
): Promise<DebtRow[]> {
  const rows = await getReceivables(tx, orgId, {})
  const live = rows.filter((r) => r.outstandingCents > 0)
  if (live.length === 0) return []
  const groups: Record<string, DebtRow & { latestCharge: string | null }> = {}
  const chargesOf: Record<string, Array<{ id: string; procedureId: string | null }>> = {}
  for (const row of live) {
    const own = row.charge.branchId ?? null
    // Lo que nació sin sede (un concepto sin atención, una atención sin cita)
    // se debe igual: se ve en la caja de cualquier sede, nunca en ninguna.
    if (query.branchId && own !== null && own !== query.branchId) continue
    const branchId = query.branchId ?? own
    const key = `${row.charge.patientId}|${branchId ?? ""}|${row.charge.currency}`
    const entry = groups[key] ?? {
      patientId: row.charge.patientId,
      displayName: "",
      branchId,
      currency: row.charge.currency,
      totalCents: 0,
      creditCents: 0,
      oldestSince: null as Date | null,
      latestSince: null as Date | null,
      chargesCount: 0,
      concepts: [],
      lastAttended: null,
      attendedTodayAt: null,
      contactId: null,
      conversationId: null,
      latestCharge: null,
    }
    entry.totalCents = addCents(entry.totalCents, row.outstandingCents)
    entry.chargesCount += 1
    if (entry.concepts.length < 3) entry.concepts.push(row.charge.description)
    const at = row.charge.createdAt
    if (!entry.oldestSince || (at && at < entry.oldestSince)) entry.oldestSince = at
    if (!entry.latestSince || (at && at > entry.latestSince)) entry.latestSince = at
    groups[key] = entry
    ;(chargesOf[key] ??= []).push({ id: row.charge.id, procedureId: row.charge.encounterProcedureId })
  }
  const list = Object.values(groups)
  if (list.length === 0) return []
  const patientIds = [...new Set(list.map((row) => row.patientId))]
  const people = await tx
    .select({ id: patient.id, displayName: patientPerson.displayName })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.organizationId, orgId), inArray(patient.id, patientIds)))
  const names = new Map(people.map((person) => [person.id, person.displayName]))
  // Saldo a favor por persona y moneda: pagado − aplicado − devuelto.
  const [payments, applications, refunds] = await Promise.all([
    tx
      .select({ id: patientPayment.id, patientId: patientPayment.patientId, currency: patientPayment.currency, amountCents: patientPayment.amountCents })
      .from(patientPayment)
      .where(
        and(
          eq(patientPayment.organizationId, orgId),
          inArray(patientPayment.patientId, patientIds),
          isNull(patientPayment.voidedAt),
        ),
      ),
    tx
      .select({ paymentId: patientPaymentApplication.paymentId, amountCents: patientPaymentApplication.amountCents })
      .from(patientPaymentApplication)
      .where(
        and(
          eq(patientPaymentApplication.organizationId, orgId),
          inArray(patientPaymentApplication.patientId, patientIds),
          isNull(patientPaymentApplication.voidedAt),
        ),
      ),
    tx
      .select({ paymentId: patientPaymentRefund.paymentId, amountCents: patientPaymentRefund.amountCents })
      .from(patientPaymentRefund)
      .where(and(eq(patientPaymentRefund.organizationId, orgId), inArray(patientPaymentRefund.patientId, patientIds))),
  ])
  const used = new Map<string, number>()
  for (const row of [...applications, ...refunds])
    used.set(row.paymentId, (used.get(row.paymentId) ?? 0) + row.amountCents)
  const credit = new Map<string, number>()
  for (const payment of payments) {
    const rest = payment.amountCents - (used.get(payment.id) ?? 0)
    if (rest <= 0) continue
    const key = `${payment.patientId}|${payment.currency}`
    credit.set(key, (credit.get(key) ?? 0) + rest)
  }
  // Atención de la que salió cada concepto: cuándo terminó y quién atendió.
  const procedureIds = [
    ...new Set(
      Object.values(chargesOf)
        .flat()
        .map((charge) => charge.procedureId)
        .filter((id): id is string => !!id),
    ),
  ]
  const attended = new Map<string, { at: Date; dentistUserId: string }>()
  if (procedureIds.length > 0) {
    const visits = await tx
      .select({
        procedureId: encounterProcedure.id,
        finalizedAt: encounter.finalizedAt,
        dentistUserId: encounter.dentistUserId,
      })
      .from(encounterProcedure)
      .innerJoin(
        encounter,
        and(eq(encounter.id, encounterProcedure.encounterId), eq(encounter.organizationId, orgId)),
      )
      .where(and(eq(encounterProcedure.organizationId, orgId), inArray(encounterProcedure.id, procedureIds)))
    for (const visit of visits)
      if (visit.finalizedAt) attended.set(visit.procedureId, { at: visit.finalizedAt, dentistUserId: visit.dentistUserId })
  }
  const dentists = await userNames(tx, [...attended.values()].map((visit) => visit.dentistUserId))
  // A quién escribirle: la propia persona y, si la tiene, su conversación abierta.
  const selves = await tx
    .select({ patientId: patientContact.patientId, contactId: patientContact.contactId })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        inArray(patientContact.patientId, patientIds),
        eq(patientContact.relationship, "self"),
      ),
    )
  const contactOf = new Map(selves.map((row) => [row.patientId, row.contactId]))
  const openThread = new Map<string, string>()
  if (selves.length > 0) {
    const threads = await tx
      .select({ id: conversation.id, contactId: conversation.contactId })
      .from(conversation)
      .where(
        and(
          eq(conversation.organizationId, orgId),
          inArray(
            conversation.contactId,
            selves.map((row) => row.contactId),
          ),
          eq(conversation.status, "open"),
        ),
      )
      .orderBy(desc(sql`coalesce(${conversation.lastMessageAt}, ${conversation.createdAt})`))
    for (const thread of threads)
      if (!openThread.has(thread.contactId)) openThread.set(thread.contactId, thread.id)
  }
  // El día se parte con la zona de la sede o, sin sede, con la de la clínica.
  const [zoneRow] = query.branchId
    ? await tx
        .select({ timezone: branch.timezone })
        .from(branch)
        .where(and(eq(branch.organizationId, orgId), eq(branch.id, query.branchId)))
        .limit(1)
    : []
  const timezone = zoneRow?.timezone ?? (await getOrgLocale(tx, orgId)).timezone
  const today = dayKeyIn(new Date(), timezone)
  const isToday = (at: Date | null): at is Date => at !== null && dayKeyIn(at, timezone) === today
  return Object.entries(groups)
    .map(([key, { latestCharge: _latest, ...row }]) => {
      let last: { at: Date; dentistUserId: string } | null = null
      for (const charge of chargesOf[key] ?? []) {
        const visit = charge.procedureId ? attended.get(charge.procedureId) : undefined
        if (visit && (!last || visit.at > last.at)) last = visit
      }
      return {
        ...row,
        displayName: names.get(row.patientId) ?? "",
        creditCents: credit.get(`${row.patientId}|${row.currency}`) ?? 0,
        lastAttended: last ? { at: last.at, dentistName: dentists.get(last.dentistUserId) ?? null } : null,
        attendedTodayAt: last && isToday(last.at) ? last.at : isToday(row.latestSince) ? row.latestSince : null,
        contactId: contactOf.get(row.patientId) ?? null,
        conversationId: openThread.get(contactOf.get(row.patientId) ?? "") ?? null,
      }
    })
    .sort((a, b) => b.totalCents - a.totalCents)
}

/** Día civil `YYYY-MM-DD` de un instante en una zona horaria. */
function dayKeyIn(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
}

/**
 * «Caja de hoy» de una sede, para Inicio: lo cobrado en el día (importe y
 * número de cobros, con las mismas cuentas que la Caja: un ticket con dos
 * medios es un cobro) y a quién falta cobrar de lo atendido hoy, que es la
 * lista «Atendidos hoy» de Finanzas › Caja (`getDebts`), no otra regla.
 */
export async function getCashToday(tx: Db, orgId: string, query: { branchId: string }) {
  const branchRow = await requireBranch(tx, orgId, query.branchId)
  const timezone = await branchTimezone(tx, orgId, branchRow)
  const unit = (await getOrgLocale(tx, orgId)).currency
  const today = dayKeyIn(new Date(), timezone)
  const { movements } = await getDayMovements(tx, orgId, { branchId: branchRow.id, day: today, timezone, currency: unit })
  const cobros = movements.filter((m) => m.direction === "ingreso" && m.kind === "cobro")
  const seen = new Set(cobros.map((m) => (m.ticketId ? `ticket:${m.ticketId}` : m.patientPaymentId ? `pago:${m.patientPaymentId}` : `mov:${m.id}`)))
  const toCollect = (await getDebts(tx, orgId, { branchId: branchRow.id }))
    .filter((row): row is DebtRow & { attendedTodayAt: Date } => row.attendedTodayAt !== null)
    .sort((a, b) => a.attendedTodayAt.getTime() - b.attendedTodayAt.getTime())
  return {
    branchId: branchRow.id,
    branchName: branchRow.name,
    currency: unit,
    timezone,
    collectedCents: sumCents(cobros.map((m) => ({ amountCents: m.amountCents }))),
    tickets: seen.size,
    toCollect,
  }
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
  const voidedTickets = await voidedTicketsOfDay(tx, orgId, branchRow.id, start, end, query.currency)
  if (shifts.length === 0)
    return { branchId: branchRow.id, day: query.day, timezone, movements: [], voidedTickets }
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
  // Ticket, número y persona de cada cobro: la pantalla muestra un renglón
  // por ticket (un cobro con dos medios es un solo cobro) con su nombre.
  const paymentIds = [
    ...new Set(movements.map((m) => m.patientPaymentId).filter((id): id is string => id !== null)),
  ]
  const origin = new Map<string, { ticketId: string | null; ticketNumber: number | null; patientId: string; patientName: string }>()
  if (paymentIds.length > 0) {
    const rows = await tx
      .select({
        paymentId: patientPayment.id,
        ticketId: patientPayment.ticketId,
        ticketNumber: paymentTicket.ticketNumber,
        patientId: patientPayment.patientId,
        patientName: patientPerson.displayName,
      })
      .from(patientPayment)
      .innerJoin(patient, and(eq(patient.id, patientPayment.patientId), eq(patient.organizationId, orgId)))
      .innerJoin(patientPerson, joinPatientPerson(patientPerson))
      .leftJoin(
        paymentTicket,
        and(eq(paymentTicket.id, patientPayment.ticketId), eq(paymentTicket.organizationId, orgId)),
      )
      .where(and(eq(patientPayment.organizationId, orgId), inArray(patientPayment.id, paymentIds)))
    for (const row of rows) origin.set(row.paymentId, row)
  }
  return {
    branchId: branchRow.id,
    day: query.day,
    timezone,
    movements: movements.map((m) => {
      const from = m.patientPaymentId ? origin.get(m.patientPaymentId) : undefined
      return {
        ...m,
        ticketId: from?.ticketId ?? null,
        ticketNumber: from?.ticketNumber ?? null,
        patientId: from?.patientId ?? null,
        patientName: from?.patientName ?? null,
      }
    }),
    voidedTickets,
  }
}

/** Ticket anulado del día: sigue a la vista, marcado y con su motivo, sin sumar. */
export interface VoidedTicketOfDay {
  ticketId: string
  ticketNumber: number
  patientId: string
  patientName: string
  currency: string
  totalCents: number
  /** Medios del cobro, congelados en el ticket. */
  methods: Array<{ name: string; amountCents: number }>
  createdAt: Date
  voidedAt: Date
  voidReason: string | null
}

/** Tickets de la sede cobrados ese día y ya anulados. */
async function voidedTicketsOfDay(
  tx: Db,
  orgId: string,
  branchId: string,
  start: Date,
  end: Date,
  unit?: string,
): Promise<VoidedTicketOfDay[]> {
  const filters = [
    eq(paymentTicket.organizationId, orgId),
    eq(paymentTicket.branchId, branchId),
    gte(paymentTicket.createdAt, start),
    lte(paymentTicket.createdAt, end),
    sql`${paymentTicket.voidedAt} IS NOT NULL`,
  ]
  if (unit) filters.push(eq(paymentTicket.currency, currency(unit)))
  const rows = await tx
    .select({ ticket: paymentTicket, patientName: patientPerson.displayName })
    .from(paymentTicket)
    .innerJoin(patient, and(eq(patient.id, paymentTicket.patientId), eq(patient.organizationId, orgId)))
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(...filters))
    .orderBy(asc(paymentTicket.createdAt), asc(paymentTicket.id))
  return rows.map(({ ticket, patientName }) => {
    const snapshot = ticket.snapshot as { methods?: Array<{ name?: unknown; amountCents?: unknown }> } | null
    return {
      ticketId: ticket.id,
      ticketNumber: ticket.ticketNumber,
      patientId: ticket.patientId,
      patientName,
      currency: ticket.currency,
      totalCents: ticket.totalCents,
      methods: (snapshot?.methods ?? []).flatMap((method) =>
        typeof method.name === "string" && typeof method.amountCents === "number"
          ? [{ name: method.name, amountCents: method.amountCents }]
          : [],
      ),
      createdAt: ticket.createdAt,
      voidedAt: ticket.voidedAt as Date,
      voidReason: ticket.voidReason,
    }
  })
}

export interface CashStateQuery {
  branchId: string
  currency?: string
}

/** Último cierre de la sede: cuándo, quién y si cuadró. */
export interface LastClosure {
  id: string
  closedAt: Date
  closedByName: string | null
  differenceCents: number
}

async function lastClosureOf(tx: Db, orgId: string, branchId: string, unit: string): Promise<LastClosure | null> {
  const [row] = await tx
    .select({
      id: cashClosure.id,
      closedAt: cashClosure.closedAt,
      closedBy: cashClosure.closedBy,
      differenceCents: cashClosure.differenceCents,
    })
    .from(cashClosure)
    .where(
      and(
        eq(cashClosure.organizationId, orgId),
        eq(cashClosure.branchId, branchId),
        eq(cashClosure.currency, unit),
      ),
    )
    .orderBy(desc(cashClosure.closedAt), desc(cashClosure.id))
    .limit(1)
  if (!row) return null
  const names = row.closedBy ? await userNames(tx, [row.closedBy]) : new Map<string, string>()
  return {
    id: row.id,
    closedAt: row.closedAt,
    closedByName: row.closedBy ? (names.get(row.closedBy) ?? null) : null,
    differenceCents: row.differenceCents,
  }
}

const EMPTY_BREAKDOWN: CashBreakdown = {
  openingCents: 0,
  cashCollectedCents: 0,
  cashAddedCents: 0,
  cashExpensesCents: 0,
  cashWithdrawnCents: 0,
  cashRefundedCents: 0,
}

/**
 * Estado de la caja de una sede: el efectivo que debe haber y de dónde sale,
 * lo cobrado por cada medio desde el último cierre, y cómo terminó ese cierre.
 * Es lo que muestran Caja y «Cerrar caja»; ambas leen lo mismo.
 */
export async function getCashState(tx: Db, orgId: string, query: CashStateQuery) {
  const branchRow = await requireBranch(tx, orgId, query.branchId)
  const unit = query.currency ? currency(query.currency) : (await getOrgLocale(tx, orgId)).currency
  const lastClosure = await lastClosureOf(tx, orgId, branchRow.id, unit)
  // Zona con que se parte el día de esta caja: la de la sede o la de la clínica.
  const timezone = await branchTimezone(tx, orgId, branchRow)
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
    return {
      branchId: branchRow.id,
      currency: unit,
      timezone,
      shiftId: null,
      openedAt: null,
      cashOnHandCents: 0,
      breakdown: EMPTY_BREAKDOWN,
      byMethod: [] as MethodTotal[],
      tickets: 0,
      lastClosure,
    }
  const detail = await getShiftDetail(tx, orgId, open.id)
  // Un ticket multimedio es un solo cobro: se deduplica por ticket (o pago si es histórico).
  const cobros = detail.movements.filter((m) => m.direction === "ingreso" && m.kind === "cobro")
  const ticketByPayment = await ticketIdsByPayment(
    tx,
    orgId,
    cobros.map((m) => m.patientPaymentId).filter((id): id is string => id !== null),
  )
  const seen = new Set<string>()
  for (const m of cobros) {
    const ticketId = m.patientPaymentId ? ticketByPayment[m.patientPaymentId] : null
    seen.add(ticketId ? `ticket:${ticketId}` : m.patientPaymentId ? `pago:${m.patientPaymentId}` : `mov:${m.id}`)
  }
  return {
    branchId: branchRow.id,
    currency: unit,
    timezone,
    shiftId: open.id,
    openedAt: open.openedAt,
    cashOnHandCents: detail.esperadoCents,
    breakdown: cashBreakdown(detail.movements),
    byMethod: methodTotals(detail.movements),
    tickets: seen.size,
    lastClosure,
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
  /** Nombre de quien cerró. */
  closedByName: string | null
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
  query: { branchId?: string; limit?: number; before?: string } = {},
): Promise<ClosureListItem[]> {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100)
  // Página siguiente: lo cerrado antes del último cierre ya mostrado.
  const before = query.before ? instant(query.before) : null
  const closureFilters = [eq(cashClosure.organizationId, orgId)]
  if (before) closureFilters.push(lt(cashClosure.closedAt, before))
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
  if (before) shiftFilters.push(lt(cashShift.closedAt, before))
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
    closedByName: null,
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
      closedByName: null,
      expectedCents: shift.expectedCents,
      countedCents: shift.countedCents,
      differenceCents: shift.differenceCents,
      retainedCents: null,
      deliveredCents: null,
      notes: shift.closeNotes,
    })
  }
  items.sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0))
  const page = items.slice(0, limit)
  const closers = await userNames(
    tx,
    page.map((item) => item.closedBy).filter((id): id is string => !!id),
  )
  return page.map((item) => ({ ...item, closedByName: item.closedBy ? (closers.get(item.closedBy) ?? null) : null }))
}

/** Hoja de cierre imprimible: todo lo contado desde el cierre anterior. */
export async function getClosureSheet(tx: Db, orgId: string, closureId: string) {
  // Se acepta el identificador del cierre o el de su ventana: cerrar devuelve
  // la ventana, y el aviso de diferencia enlaza con ella.
  const [closure] = await tx
    .select()
    .from(cashClosure)
    .where(
      and(
        eq(cashClosure.organizationId, orgId),
        or(eq(cashClosure.id, closureId), eq(cashClosure.shiftId, closureId)),
      ),
    )
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
