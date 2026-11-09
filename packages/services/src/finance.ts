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
import {
  commissionOfValue,
  type ExpenseExchange,
  expenseExchange,
  formatMoney,
  type MoneyFraction,
  roundMoneyValue,
  sumMoneyValues,
} from "@odentia/clinical"
import { canAttend } from "@odentia/auth/permissions"
import type { Db } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { conversation } from "@odentia/db/schema/crm"
import { appointment } from "@odentia/db/schema/agenda"
import {
  encounter,
  encounterProcedure,
  patient,
  patientCharge,
  patientContact,
  patientPayment,
  patientPaymentApplication,
  patientPaymentRefund,
  paymentReturn,
  paymentTicket,
  serviceCatalog,
} from "@odentia/db/schema/clinical"
import { requireCanAttend } from "./attending.js"
import {
  cashClosure,
  cashMovement,
  cashShift,
  commissionRate,
  COMMISSION_RETURN_TYPE_CODES,
  type CommissionReturnTypeCode,
  commissionSettlement,
  commissionSettlementLine,
  expense,
  expenseGapDismissal,
} from "@odentia/db/schema/finance"
import { purchaseOrder, supplier, supplierCreditUse } from "@odentia/db/schema/inventory"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, type SQL, sql } from "drizzle-orm"
import {
  branchNotFound,
  isUniqueViolation,
  invalidField,
  notFound,
  purchaseOrderNotFound,
  ServiceError,
  validation,
} from "./errors.js"
import { looksLikeId } from "./ids.js"
import { getOrgLocale, type OrgLocale, orgProfileRequired } from "./locale.js"
import { CLOSED_PURCHASE_STATUSES, type PurchaseBalance, purchaseBalances, supplierCredits } from "./purchase-balance.js"
import { monthStart } from "./report-periods.js"
import { bySpan, safeCents, type Span, spansSql } from "./report-spans.js"
import {
  type OrgMoney,
  orgMoney,
  orgMoneyOf,
  orgMoneySql,
  orgPartValue,
  paymentFlowSql,
  paymentValueSql,
} from "./report-value.js"
import { createWorkspaceNotification } from "./workspace.js"
import { salaryOfMonth } from "./expense-recurring-occurrences.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import type { TicketFrozen } from "./payments.js"
import { digitsContain, foldedWordsMatch, referenceNumber, searchDigits, textMatchesWords } from "./search-text.js"
export const MOVEMENT_DIRECTIONS = ["ingreso", "egreso"] as const
export const EXPENSE_CATEGORIES = ["Personal", "Alquiler", "Laboratorio", "Materiales", "Servicios", "Impuestos", "Otros"] as const
/** Los tipos con que se filtra Gastos: los de un gasto y el pago de comisiones, que va aparte de «Personal». */
export const EXPENSE_FILTER_TYPES = [...EXPENSE_CATEGORIES, "Pago de comisiones"] as const
/** El tipo del pago del impuesto de lo cobrado (ADR 0083): solo un gasto de «Impuestos» puede serlo. */
export const SALES_TAX_EXPENSE_CATEGORY = "Impuestos"

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

/** `name`: el dato del cuerpo de la petición, para que el error se diga junto a él. */
export function assertCents(value: number, field = "El importe", name?: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
    const message = `${field} debe ser un importe entero mayor que cero`
    throw name ? invalidField(name, message) : validation(message)
  }
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

function concept(value: string, name?: string): string {
  const text = value?.trim()
  if (!text || text.length > 500) {
    const message = "El concepto debe tener 1–500 caracteres"
    throw name ? invalidField(name, message) : validation(message)
  }
  return text
}

function instant(value: string, name?: string): Date {
  const date = new Date(value)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(date.getTime()))
    throw name ? invalidField(name, "Fecha ISO inválida") : validation("Fecha ISO inválida")
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
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx
    .insert(auditEvent)
    .values({ organizationId: orgId, actorUserId, entity, entityId: id, action, metadata: metadata ?? null })
}

export async function requireBranch(tx: Db, orgId: string, branchId: string) {
  const [row] = await tx
    .select()
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.organizationId, orgId)))
  if (!row) throw branchNotFound()
  return row
}
/**
 * Las monedas de la clínica con bloqueo compartido: orden perfil→cuenta/caja, sin
 * deadlocks con el cambio de región. `null` sin perfil.
 */
export async function lockOrgMoney(tx: Db, orgId: string) {
  const [profile] = await tx
    .select({
      currency: orgProfile.currency,
      secondCurrency: orgProfile.secondCurrency,
      exchangeRate: orgProfile.exchangeRate,
    })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .for("share")
  return profile ?? null
}

/**
 * La moneda en que se mueve dinero: la pedida, si es una de las de la clínica, o la del
 * negocio. Otra abriría una caja o un cargo que después impide activar la segunda moneda.
 */
export async function lockOrgUnit(
  tx: Db,
  orgId: string,
  requested: string | undefined,
  field = "currency",
): Promise<string> {
  const money = await lockOrgMoney(tx, orgId)
  if (!money) throw orgProfileRequired()
  if (!requested) return money.currency
  const code = currency(requested)
  const allowed = money.secondCurrency ? [money.currency, money.secondCurrency] : [money.currency]
  if (!allowed.includes(code))
    throw invalidField(field, `La clínica trabaja solo en ${allowed.join(" y ")}`)
  return code
}

export async function lockOrgCurrency(tx: Db, orgId: string): Promise<string> {
  const profile = await lockOrgMoney(tx, orgId)
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

/**
 * Alguien cuyas comisiones se pueden mirar y pagar: quien está en el equipo, o
 * quien estuvo y dejó algo en la clínica (atendió, tuvo porcentaje o se le
 * pagó). Lo que ganó mientras atendía sigue siendo suyo aunque ya no esté.
 */
async function requireCommissionPerson(tx: Db, orgId: string, userId: string): Promise<{ inTeam: boolean }> {
  const [inTeam] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
  if (inTeam) return { inTeam: true }
  const [was] = await tx.execute<{ found: number }>(sql`
    select 1 as found where exists (select 1 from encounter e where e.organization_id = ${orgId} and e.professional_user_id = ${userId})
      or exists (select 1 from commission_settlement s where s.organization_id = ${orgId} and s.professional_user_id = ${userId})
      or exists (select 1 from commission_rate r where r.organization_id = ${orgId} and r.professional_user_id = ${userId})`)
  if (!was) throw notFound("Profesional")
  return { inTeam: false }
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
 * Serializa todo lo que crea, cierra o corrige la ventana de una sede y moneda.
 * Orden de los bloqueos de caja, siempre el mismo para no bloquearse entre sí:
 * primero este, de cada caja en orden fijo (`lockCashWindows`), y después la fila
 * de la ventana (`lockShift`). Quien tiene la fila no pide este.
 */
async function lockCashWindow(tx: Db, orgId: string, branchId: string, unit: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('cash:' || ${orgId} || ':' || ${branchId} || ':' || ${unit}))`,
  )
}

/**
 * Lo que toca más de una caja las bloquea juntas y en orden fijo, por sede y
 * moneda: dos operaciones sobre las mismas cajas nunca se esperan en cruz.
 */
export async function lockCashWindows(
  tx: Db,
  orgId: string,
  windows: ReadonlyArray<{ branchId: string; unit: string }>,
): Promise<void> {
  const unique = new Map(windows.map((w) => [`${w.branchId}|${w.unit}`, w]))
  for (const key of [...unique.keys()].sort()) {
    const window = unique.get(key)
    if (window) await lockCashWindow(tx, orgId, window.branchId, window.unit)
  }
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
 * quedó + cobros + ingresado − gastos − retirado − devuelto + vuelto.
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
  /** Vuelto en otra moneda, con signo: entra el exceso del billete, sale el vuelto. */
  cashChangeCents: number
}

function cashBreakdown(movements: CashMove[]): CashBreakdown {
  const total = (keep: (m: CashMove) => boolean) =>
    sumCents(movements.filter(keep).map((m) => ({ amountCents: m.amountCents })))
  return {
    openingCents: total((m) => m.direction === "ingreso" && m.kind === "apertura"),
    cashCollectedCents: total((m) => m.direction === "ingreso" && m.kind === "cobro" && !isElectronic(m)),
    cashAddedCents: total((m) => m.direction === "ingreso" && m.kind === "aporte"),
    // Lo que volvió de un gasto anulado tras el cierre se resta de los gastos.
    cashExpensesCents:
      total((m) => isCashEgreso(m) && m.kind === "gasto") -
      total((m) => m.direction === "ingreso" && m.kind === "gasto" && (m.methodTypeCode === null || m.methodTypeCode === "10")),
    cashWithdrawnCents: total((m) => isCashEgreso(m) && m.kind === "retiro"),
    cashRefundedCents: total((m) => isCashEgreso(m) && m.kind === "devolucion"),
    cashChangeCents:
      total((m) => m.direction === "ingreso" && m.kind === "vuelto") -
      total((m) => isCashEgreso(m) && m.kind === "vuelto"),
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

/**
 * La caja la ve caja, que no ve a quién se pagó cada comisión (ADR 0018, D-14 de la ronda de
 * comisiones): el movimiento del pago de una comisión se llama «Pago de comisiones», como su
 * fila en Gastos. Lo nuevo ya se guarda así; esto cubre lo guardado antes con el nombre.
 */
async function withoutCommissionPayees<T extends { expenseId: string | null; concept: string }>(
  tx: Db,
  orgId: string,
  movements: T[],
): Promise<T[]> {
  const ids = [...new Set(movements.map((m) => m.expenseId).filter((id): id is string => !!id))]
  if (ids.length === 0) return movements
  const rows = await tx
    .select({ expenseId: commissionSettlement.expenseId })
    .from(commissionSettlement)
    .where(and(eq(commissionSettlement.organizationId, orgId), inArray(commissionSettlement.expenseId, ids)))
  const paid = new Set(rows.map((row) => row.expenseId))
  return movements.map((m) => (m.expenseId && paid.has(m.expenseId) ? { ...m, concept: COMMISSION_PAYMENTS_CONCEPT } : m))
}

/** Turno con movimientos vigentes y esperado de efectivo calculado en vivo. */
export async function getShiftDetail(tx: Db, orgId: string, shiftId: string) {
  const shift = await requireShift(tx, orgId, shiftId)
  const stored = await tx
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
  const movements = await withoutCommissionPayees(tx, orgId, stored)
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
  const amount = assertCents(input.amountCents, "El importe", "amountCents")
  // El efectivo nunca queda negativo: el egreso no supera el contado actual.
  if (input.direction === "egreso") await requireCashAvailable(tx, orgId, shift.id, amount, "amountCents")
  const [row] = await tx
    .insert(cashMovement)
    .values({
      organizationId: orgId,
      shiftId: shift.id,
      direction: input.direction,
      kind: input.kind,
      amountCents: amount,
      currency: shift.currency,
      concept: concept(input.concept, "concept"),
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
  const unit = await lockOrgUnit(tx, orgId, input.currency)
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
 * ventana (gasto, retiro, devolución y compensación por igual). `field`: el
 * importe en el cuerpo de la petición, para decir el error junto a él.
 */
async function requireCashAvailable(tx: Db, orgId: string, shiftId: string, amountCents: number, field?: string) {
  const detail = await getShiftDetail(tx, orgId, shiftId)
  if (amountCents > detail.esperadoCents) {
    const message = "La caja no tiene efectivo suficiente para este egreso"
    throw new ServiceError("INSUFFICIENT_CASH", 409, message, field ? { [field]: message } : undefined)
  }
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
        eq(cashMovement.kind, "cobro"),
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
  kind: "gasto" | "devolucion" | "retiro" | "vuelto"
  amountCents: number
  currency: string
  methodName?: string | null
  methodTypeCode?: string | null
  concept: string
  expenseId?: string | null
  /** El vuelto en otra moneda va unido a su pago. */
  patientPaymentId?: string | null
  /**
   * Compensación administrativa post-cierre: corrección del día que puede
   * dejar el contado en negativo (el test fija -10000). Los egresos
   * voluntarios (gasto, retiro, devolución) nunca dejan la caja en negativo.
   */
  allowNegative?: boolean
  /** El importe en el cuerpo de la petición (`amountCents`): el error de efectivo se dice junto a él. */
  amountField?: string
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
  const amount = assertCents(input.amountCents, "El importe", input.amountField)
  // Solo lo que sale del cajón exige efectivo: lo devuelto por otro medio no lo toca.
  const fromCash = isCashEgreso({ direction: "egreso", methodTypeCode: input.methodTypeCode ?? null })
  if (fromCash && !input.allowNegative) await requireCashAvailable(tx, orgId, shift.id, amount, input.amountField)
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
      patientPaymentId: input.patientPaymentId ?? null,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "cash_movement", row.id, "cash.egreso_recorded")
  return row
}

/** Entra efectivo por un vuelto en otra moneda, en la ventana abierta. */
async function recordCashChangeIncome(
  tx: Db,
  orgId: string,
  actorUserId: string,
  shiftId: string,
  input: {
    amountCents: number
    currency: string
    methodName: string | null
    methodTypeCode: string | null
    concept: string
    patientPaymentId?: string | null
  },
) {
  const shift = requireOpenShift(await lockShift(tx, orgId, shiftId))
  if (input.currency !== shift.currency)
    throw conflict("CURRENCY_MISMATCH", "El vuelto es de otra moneda que la caja")
  const [row] = await tx
    .insert(cashMovement)
    .values({
      organizationId: orgId,
      shiftId: shift.id,
      direction: "ingreso",
      kind: "vuelto",
      amountCents: assertCents(input.amountCents),
      currency: input.currency,
      method: input.methodName?.slice(0, 60) ?? null,
      methodTypeCode: input.methodTypeCode,
      concept: concept(input.concept),
      patientPaymentId: input.patientPaymentId ?? null,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "cash_movement", row.id, "cash.payment_registered")
  return row
}

export interface CashChangeInput {
  paymentId: string
  branchId: string
  methodName: string
  methodTypeCode: string
  /** El exceso del billete, que se queda en la caja de la moneda en que pagó. */
  keptCents: number
  keptCurrency: string
  /** El vuelto que se le da en la otra moneda; sale de la caja de esa moneda. */
  givenCents: number
  givenCurrency: string
  concept: string
}

/**
 * El vuelto en otra moneda: billete de USD 100 para un cobro de USD 80, con S/ 75
 * de vuelto. Los USD 20 de más entran en la caja de dólares y los S/ 75 salen de la
 * de soles. Cobrar nunca se frena: si en esa caja no constaba efectivo, lo dirá su
 * arqueo. Quien llama ya bloqueó las dos cajas (`lockCashWindows`).
 */
export async function recordCashChange(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CashChangeInput,
) {
  const kept = await ensureOpenShift(tx, orgId, actorUserId, input.branchId, input.keptCurrency)
  await recordCashChangeIncome(tx, orgId, actorUserId, kept.id, {
    amountCents: input.keptCents,
    currency: input.keptCurrency,
    methodName: input.methodName,
    methodTypeCode: input.methodTypeCode,
    concept: input.concept,
    patientPaymentId: input.paymentId,
  })
  if (input.givenCents <= 0) return
  const given = await ensureOpenShift(tx, orgId, actorUserId, input.branchId, input.givenCurrency)
  await recordCashEgreso(tx, orgId, actorUserId, given.id, {
    kind: "vuelto",
    amountCents: input.givenCents,
    currency: input.givenCurrency,
    methodName: input.methodName,
    methodTypeCode: input.methodTypeCode,
    concept: input.concept,
    patientPaymentId: input.paymentId,
    allowNegative: true,
  })
}

/**
 * Revierte lo que un pago anulado movió en la caja: su cobro y, si dio vuelto en
 * otra moneda, las dos filas del vuelto. Con la ventana abierta se anula el
 * movimiento; con la ventana cerrada (inmutable) la compensación sale en la ventana
 * actual de la misma sede y moneda, con los datos del movimiento. Sin cambio nuevo:
 * se revierte lo que pasó. Devuelve si compensó (para que el ticket lo refleje). Quien
 * llama ya bloqueó sus cajas (`lockCashOfPayments`), antes que sus filas, como todos.
 */
export async function reverseCashIncome(
  tx: Db,
  orgId: string,
  actorUserId: string,
  payment: typeof patientPayment.$inferSelect,
  voidReason: string,
  allowPostClose: boolean,
): Promise<boolean> {
  const movements = await tx
    .select()
    .from(cashMovement)
    .where(
      and(
        eq(cashMovement.organizationId, orgId),
        eq(cashMovement.patientPaymentId, payment.id),
        inArray(cashMovement.kind, ["cobro", "vuelto"]),
        isNull(cashMovement.voidedAt),
      ),
    )
    .orderBy(asc(cashMovement.createdAt), asc(cashMovement.id))
  if (!movements.length) return false
  let compensated = false
  for (const movement of movements) {
    // Bloqueada: un cierre simultáneo espera o ya se ve cerrado, nunca a medias.
    const shift = await lockShift(tx, orgId, movement.shiftId)
    if (shift.status === "abierta") {
      await tx
        .update(cashMovement)
        .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason })
        .where(eq(cashMovement.id, movement.id))
      await audit(tx, orgId, actorUserId, "cash_movement", movement.id, "cash.movement_voided")
      continue
    }
    if (!allowPostClose)
      throw conflict(
        "POST_CLOSE_NEEDS_ADMIN",
        "La caja donde ingresó el cobro ya cerró y no se modifica: solo administración puede anularlo",
      )
    // Sale lo que entró a la caja, con los datos del movimiento: un pago cruzado
    // entró en otra moneda que la que cancela.
    const current = await ensureOpenShift(tx, orgId, actorUserId, shift.branchId, movement.currency)
    const reversal = {
      amountCents: movement.amountCents,
      currency: movement.currency,
      methodName: movement.method,
      methodTypeCode: movement.methodTypeCode,
      concept: "Compensación por anulación",
    }
    if (movement.direction === "egreso")
      await recordCashChangeIncome(tx, orgId, actorUserId, current.id, reversal)
    else
      await recordCashEgreso(tx, orgId, actorUserId, current.id, {
        ...reversal,
        kind: movement.kind === "vuelto" ? "vuelto" : "devolucion",
        allowNegative: true,
      })
    compensated = true
  }
  return compensated
}

/**
 * Las cajas donde están estos pagos, bloqueadas en orden fijo antes de tocar
 * ninguna: una anulación con varios medios no se cruza con otra ni con un cierre.
 */
export async function lockCashOfPayments(tx: Db, orgId: string, paymentIds: string[]): Promise<void> {
  if (!paymentIds.length) return
  const windows = await tx
    .selectDistinct({ branchId: cashShift.branchId, unit: cashShift.currency })
    .from(cashMovement)
    .innerJoin(
      cashShift,
      and(eq(cashShift.id, cashMovement.shiftId), eq(cashShift.organizationId, orgId)),
    )
    .where(
      and(
        eq(cashMovement.organizationId, orgId),
        inArray(cashMovement.patientPaymentId, paymentIds),
        isNull(cashMovement.voidedAt),
      ),
    )
  await lockCashWindows(tx, orgId, windows)
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
  // La caja antes que la fila, como un cobro: al revés, cerrar y cobrar a la vez
  // se esperarían en cruz (la ventana siguiente pide esta misma caja al final).
  const seen = await requireShift(tx, orgId, shiftId)
  await lockCashWindow(tx, orgId, seen.branchId, seen.currency)
  const locked = await lockShift(tx, orgId, shiftId)
  if (locked.status === "cerrada") return locked
  if (!Number.isSafeInteger(input.countedCents) || input.countedCents < 0)
    throw invalidField("countedCents", "El contado debe ser un importe entero mayor o igual a 0")
  for (const [value, label, name] of [
    [input.retainedCents, "Lo que queda", "retainedCents"],
    [input.deliveredCents, "Lo que se entrega", "deliveredCents"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw invalidField(name, `${label} debe ser un importe entero mayor o igual a 0`)
  }
  // La suma se dice en el importe que se pasa de lo contado (si ninguno, en lo que se entrega).
  if (input.retainedCents + input.deliveredCents !== input.countedCents)
    throw invalidField(
      input.retainedCents > input.countedCents ? "retainedCents" : "deliveredCents",
      "Lo que queda más lo que se entrega suma el contado",
    )
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
    cashChangeCents: breakdown.cashChangeCents,
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
  const unit = await lockOrgUnit(tx, orgId, input.currency)
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

/** Hubo un cierre de esa sede, en la caja de alguna de esas monedas, después del instante dado. */
export async function hasClosureSince(
  tx: Db,
  orgId: string,
  branchId: string,
  units: readonly string[],
  since: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: cashClosure.id })
    .from(cashClosure)
    .where(
      and(
        eq(cashClosure.organizationId, orgId),
        eq(cashClosure.branchId, branchId),
        inArray(cashClosure.currency, [...units]),
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
  /**
   * El cambio de este gasto, si cancela en la otra moneda de la clínica; vale solo
   * para él. Sin él, el «Cambio de hoy»: nunca queda sin su valor congelado.
   */
  exchangeRate?: string
  spentAt?: string | null
  receiptKind?: string
  receiptNumber?: string | null
  notes?: string | null
  /** Con salida del efectivo de la caja (descuenta del contado al cerrar). */
  fromCash?: boolean
  /**
   * Un gasto de «Impuestos» que es el pago del impuesto de lo cobrado (el IGV,
   * ADR 0083): no resta de lo que deja, porque ese impuesto ya salió de lo cobrado.
   */
  salesTax?: boolean
}

/** Lo que salió en otra moneda que la que cancela un gasto. */
interface ExpenseTender {
  cents: number
  currency: string
}

/**
 * Lo que un gasto congela de otra moneda; `null` si no hay nada que congelar. En
 * una clínica de una moneda no hay cambio ni cruce y un gasto se guarda como
 * siempre. En una de dos, se gasta en cualquiera de las dos; lo único en otra
 * moneda es el pago de una compra que ya estaba en ella, sin valor, como antes.
 */
function frozenExpense(
  profile: Awaited<ReturnType<typeof lockOrgMoney>>,
  input: {
    amountCents: number
    unit: string
    rate?: string
    tender?: ExpenseTender
    isPurchase: boolean
  },
): ExpenseExchange | null {
  const { amountCents, unit, rate, tender, isPurchase } = input
  const second = profile?.secondCurrency ?? null
  if (!profile || !second) {
    if (tender) throw invalidField("tenderCurrency", "La clínica trabaja en una sola moneda")
    if (rate !== undefined)
      throw invalidField("exchangeRate", "La clínica trabaja en una sola moneda")
    return null
  }
  const business = profile.currency
  const onlyIn = `La clínica trabaja solo en ${business} y ${second}`
  if (unit !== business && unit !== second) {
    if (!isPurchase) throw invalidField("currency", onlyIn)
    if (tender) throw invalidField("tenderCurrency", onlyIn)
    if (rate !== undefined) throw invalidField("exchangeRate", onlyIn)
    return null
  }
  if (tender) {
    if (rate !== undefined)
      throw invalidField(
        "exchangeRate",
        "Con lo que salió en otra moneda, el cambio se calcula solo",
      )
    if (tender.currency !== business && tender.currency !== second)
      throw invalidField("tenderCurrency", onlyIn)
    if (tender.currency === unit)
      throw invalidField("tenderCurrency", "Lo que salió va en otra moneda que la de la compra")
  }
  try {
    return expenseExchange({
      amountCents,
      currency: unit,
      businessCurrency: business,
      tender: tender ?? null,
      rate: rate ?? profile.exchangeRate,
    })
  } catch (error) {
    throw invalidField(
      tender ? "tenderCents" : "exchangeRate",
      error instanceof Error ? error.message : "Revisa el cambio",
    )
  }
}

/**
 * Registra un gasto con su tipo. Con `fromCash` el egreso sale del efectivo
 * de la ventana abierta (movimiento + gasto en la misma transacción); sin
 * caja es gasto directo. Sin proveedor ni turno a mano. La caja que se usa es la
 * de la moneda en que salió el dinero.
 */
export async function createExpense(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateExpenseInput,
  /**
   * Solo `payPurchaseOrder`: el gasto es el pago de esa compra y, si se pagó en
   * otra moneda, lo que salió. Un gasto suelto no cruza monedas. Solo
   * `expense-recurring.ts`: el gasto es el pago de ese mes de un gasto que se repite.
   */
  link: { purchaseOrderId?: string; tender?: ExpenseTender; recurringId?: string; recurringMonth?: string } = {},
) {
  if (Boolean(link.recurringId) !== Boolean(link.recurringMonth))
    throw validation("El pago de un gasto que se repite lleva su plantilla y su mes")
  const branchRow = await requireBranch(tx, orgId, input.branchId)
  const profile = await lockOrgMoney(tx, orgId)
  if (!input.currency && !profile) throw orgProfileRequired()
  const unit = input.currency ? currency(input.currency) : (profile?.currency ?? "")
  const category = input.category?.trim() || "Otros"
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category))
    throw invalidField("category", "Tipo de gasto inválido")
  if (link.purchaseOrderId && category !== PURCHASE_EXPENSE_CATEGORY)
    throw invalidField("category", "El pago de una compra es un gasto de Materiales")
  const salesTax = input.salesTax === true
  if (salesTax && category !== SALES_TAX_EXPENSE_CATEGORY)
    throw invalidField("salesTax", "El pago del impuesto de lo cobrado es un gasto de Impuestos")
  // El impuesto de lo cobrado se paga en moneda del negocio: es la de lo que deja.
  if (salesTax && profile?.secondCurrency && unit !== profile.currency)
    throw invalidField("salesTax", "El impuesto de lo cobrado se paga en la moneda del negocio")
  // Comprobante libre según país (el catálogo fiscal llega con su módulo).
  const receiptKind = input.receiptKind?.trim() ? input.receiptKind.trim().slice(0, 60) : "ninguno"
  const amountCents = assertCents(input.amountCents, "El gasto", "amountCents")
  const tender = link.tender
    ? {
        cents: assertCents(link.tender.cents, "Lo que salió", "tenderCents"),
        currency: currency(link.tender.currency),
      }
    : undefined
  const frozen = frozenExpense(profile, {
    amountCents,
    unit,
    rate: input.exchangeRate,
    tender,
    isPurchase: Boolean(link.purchaseOrderId),
  })
  const out = frozen?.tender ?? { cents: amountCents, currency: unit }
  const shift = input.fromCash
    ? await ensureOpenShift(tx, orgId, actorUserId, branchRow.id, out.currency)
    : null
  const [row] = await tx
    .insert(expense)
    .values({
      organizationId: orgId,
      branchId: branchRow.id,
      shiftId: shift?.id ?? null,
      concept: concept(input.concept, "concept"),
      category,
      amountCents,
      currency: unit,
      ...(frozen
        ? {
            tenderCents: frozen.tender?.cents ?? null,
            tenderCurrency: frozen.tender?.currency ?? null,
            exchangeRate: frozen.exchangeRate,
            businessCents: frozen.businessCents,
          }
        : {}),
      spentAt: input.spentAt ? instant(input.spentAt, "spentAt") : new Date(),
      receiptKind,
      receiptNumber: input.receiptNumber?.trim() || null,
      notes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
      purchaseOrderId: link.purchaseOrderId ?? null,
      salesTax,
      recurringId: link.recurringId ?? null,
      recurringMonth: link.recurringMonth ?? null,
      createdBy: actorUserId,
    })
    .returning()
  if (shift) {
    await recordCashEgreso(tx, orgId, actorUserId, shift.id, {
      kind: "gasto",
      amountCents: out.cents,
      currency: out.currency,
      concept: row.concept,
      expenseId: row.id,
      amountField: frozen?.tender ? "tenderCents" : "amountCents",
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
  viewer: { seesCommissions: boolean } = { seesCommissions: false },
) {
  const filters = [eq(expense.organizationId, orgId), isNull(expense.voidedAt)]
  if (query.branchId) filters.push(eq(expense.branchId, query.branchId))
  if (query.category) filters.push(eq(expense.category, query.category))
  if (query.from) filters.push(gte(expense.spentAt, instant(`${query.from}T00:00:00.000Z`)))
  if (query.to) filters.push(lte(expense.spentAt, instant(`${query.to}T23:59:59.999Z`)))
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)
  const rows = await tx
    .select()
    .from(expense)
    .where(and(...filters))
    .orderBy(desc(expense.spentAt), desc(expense.id))
    .limit(limit)
  if (viewer.seesCommissions || rows.length === 0) return rows
  // Quien no administra comisiones no lee a quién se pagó ni cuánto a cada uno (ver `getMonthExpenses`).
  const paid = await commissionPaymentsOf(tx, orgId, rows.map((row) => row.id))
  return withoutCommissionNames(rows.map((row) => ({ ...row, commission: paid.has(row.id) }))).map(
    ({ commission: _commission, ...row }) => row,
  )
}

/** El pago de comisión de cada gasto que lo es, con su profesional y su mes. */
async function commissionPaymentsOf(tx: Db, orgId: string, expenseIds: string[]) {
  if (expenseIds.length === 0) return new Map<string, { professionalUserId: string; year: number | null; month: number | null }>()
  const rows = await tx
    .select({
      expenseId: commissionSettlement.expenseId,
      professionalUserId: commissionSettlement.professionalUserId,
      year: commissionSettlement.periodYear,
      month: commissionSettlement.periodMonth,
    })
    .from(commissionSettlement)
    .where(and(eq(commissionSettlement.organizationId, orgId), inArray(commissionSettlement.expenseId, expenseIds)))
  return new Map(rows.flatMap(({ expenseId, ...rest }) => (expenseId ? [[expenseId, rest] as const] : [])))
}



/** Concepto con que ve el pago de comisiones quien no administra comisiones. */
export const COMMISSION_PAYMENTS_CONCEPT = "Pago de comisiones"

/**
 * Concepto del efectivo que devuelve un profesional de comisiones ya pagadas (ADR 0157): como el
 * pago, la caja no dice de quién es.
 */
export const COMMISSION_RETURNS_CONCEPT = "Devolución de comisiones"

/**
 * Los pagos de comisión en una sola fila por sede y moneda, sin a quién ni de
 * qué pago: el total suma lo mismo y la lista no dice a quién se pagó. Los
 * anulados no se muestran (su anulación la ve Comisiones). El gasto de una
 * comisión va en la moneda de lo cobrado (ADR 0155), puede salir de la caja y
 * no lleva comprobante (`payMonthCommission`); su movimiento de caja se llama
 * igual que esta fila, sin a quién se pagó.
 */
function withoutCommissionNames<
  T extends {
    id: string
    branchId: string
    concept: string
    currency: string
    amountCents: number
    businessCents: number | null
    tenderCents: number | null
    tenderCurrency: string | null
    exchangeRate: string | null
    notes: string | null
    receiptNumber: string | null
    createdBy: string | null
    voidedAt: Date | null
    commission: boolean
  },
>(rows: T[]): T[] {
  const merged = new Map<string, T>()
  const out: T[] = []
  for (const row of rows) {
    if (!row.commission) {
      out.push(row)
      continue
    }
    if (row.voidedAt) continue
    const key = `${row.branchId}|${row.currency}`
    const seen = merged.get(key)
    if (!seen) {
      // Las filas llegan de la más reciente a la más antigua: la fecha es la del último pago.
      const first: T = {
        ...row,
        id: `comisiones:${row.branchId}:${row.currency}`,
        concept: COMMISSION_PAYMENTS_CONCEPT,
        businessCents: null,
        tenderCents: null,
        tenderCurrency: null,
        exchangeRate: null,
        notes: null,
        receiptNumber: null,
        createdBy: null,
      }
      merged.set(key, first)
      out.push(first)
      continue
    }
    seen.amountCents += row.amountCents
  }
  return out
}

/**
 * Gastos de un mes (el de la zona horaria de la clínica) con su total por
 * tipo. Los anulados siguen en la lista, marcados, y no suman. `q` (concepto,
 * proveedor, comprobante o nota) y `category` acotan la lista y su total
 * (`shown`); el total del mes y el de cada tipo siguen siendo del mes entero.
 */
export async function getMonthExpenses(
  tx: Db,
  orgId: string,
  query: { year: number; month: number; branchId?: string; q?: string; category?: string },
  /**
   * Lo que cada profesional cobra de comisión solo lo ve quien administra
   * comisiones (`commissions.write`). Los demás ven el total del mes, sin
   * nombres: el gasto existe y suma, pero no dice a quién se pagó.
   */
  viewer: { seesCommissions: boolean } = { seesCommissions: false },
) {
  const zone = await getOrgLocale(tx, orgId)
  const { timezone, currency: unit } = zone
  const { start, end } = monthBounds(timezone, query.year, query.month)
  const filters = [eq(expense.organizationId, orgId), gte(expense.spentAt, start), lt(expense.spentAt, end)]
  if (query.branchId) filters.push(eq(expense.branchId, query.branchId))
  const rows = await tx
    .select()
    .from(expense)
    .where(and(...filters))
    .orderBy(desc(expense.spentAt), desc(expense.id))
  // Lo que suma el mes va con su valor; lo viejo en otra moneda, sin valor ni factor, no entra.
  const money = orgMoneyOf(zone)
  const valueOf = (row: { amountCents: number; businessCents: number | null; currency: string }) =>
    orgPartValue(row.amountCents, row, money)
  const live = rows.filter((row) => !row.voidedAt && valueOf(row) !== null)
  const settlementOf = await commissionPaymentsOf(tx, orgId, rows.map((row) => row.id))
  // El pago de comisiones va aparte de «Personal», como en Reportes: así «Personal» dice lo mismo en
  // las dos pantallas (los sueldos) y el pago de comisiones tiene su propia cifra.
  const byCategoryValues = new Map<string, Array<MoneyFraction | null>>()
  for (const row of live) {
    const key = settlementOf.has(row.id) ? COMMISSION_PAYMENTS_CONCEPT : row.category
    const list = byCategoryValues.get(key) ?? []
    list.push(valueOf(row))
    byCategoryValues.set(key, list)
  }
  const byCategory = new Map(
    [...byCategoryValues].map(([category, values]) => [
      category,
      roundMoneyValue(sumMoneyValues(values)),
    ]),
  )
  // El pago de una compra lleva su orden y el de una comisión lo dice: la lista los enlaza (ADR 0061).
  const orderIds = [...new Set(rows.map((row) => row.purchaseOrderId).filter((id): id is string => id !== null))]
  const orders = orderIds.length
    ? await tx
        .select({ id: purchaseOrder.id, orderNumber: purchaseOrder.orderNumber, supplierName: supplier.name })
        .from(purchaseOrder)
        .leftJoin(supplier, and(eq(supplier.organizationId, purchaseOrder.organizationId), eq(supplier.id, purchaseOrder.supplierId)))
        .where(and(eq(purchaseOrder.organizationId, orgId), inArray(purchaseOrder.id, orderIds)))
    : []
  const detailed = rows.map((row) => {
    const order = orders.find((item) => item.id === row.purchaseOrderId)
    const settlement = settlementOf.get(row.id)
    return {
      ...row,
      // El tipo con que se ve y se filtra: el mismo que su cifra del mes (`byCategory`).
      category: settlement !== undefined ? COMMISSION_PAYMENTS_CONCEPT : row.category,
      fromCash: row.shiftId !== null,
      purchaseOrderNumber: order?.orderNumber ?? null,
      supplierName: order?.supplierName ?? null,
      commission: settlement !== undefined,
      /** A qué pago de comisión lleva la fila; solo para quien administra comisiones. */
      commissionPayment: viewer.seesCommissions && settlement ? settlement : null,
    }
  })
  const expenses = (viewer.seesCommissions ? detailed : withoutCommissionNames(detailed))
    .filter((row) => !query.category || row.category === query.category)
    .filter((row) => !query.q?.trim() || textMatchesWords([row.concept, row.supplierName, row.receiptNumber, row.notes], query.q))
  const shownLive = expenses.filter((row) => !row.voidedAt && valueOf(row) !== null)
  return {
    year: query.year,
    month: query.month,
    currency: unit,
    timezone,
    totalCents: roundMoneyValue(sumMoneyValues(live.map(valueOf))),
    byCategory: [...byCategory.entries()]
      .map(([category, cents]) => ({ category, cents }))
      .sort((a, b) => b.cents - a.cents),
    /** Lo que queda a la vista con la búsqueda y el tipo: cuántos y cuánto suman. */
    shown: {
      count: shownLive.length,
      totalCents: roundMoneyValue(sumMoneyValues(shownLive.map(valueOf))),
    },
    expenses,
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
  /**
   * `allowPostClose`: quien administra (`finance.admin`) puede anular un gasto
   * cuya caja ya cerró; la caja de hoy recibe la «Compensación por anulación»,
   * como al anular un cobro (`reverseCashIncome`). Lo cerrado no se toca.
   */
  opts: { fromCommission?: boolean; allowPostClose?: boolean } = {},
) {
  const [found] = await tx
    .select({ purchaseOrderId: expense.purchaseOrderId })
    .from(expense)
    .where(and(eq(expense.id, expenseId), eq(expense.organizationId, orgId)))
  if (!found) throw notFound("Gasto")
  // El pago de una compra se anula con su orden y su proveedor bloqueados antes
  // que el gasto, en el mismo orden que al pagarla o cancelarla: dos de esas
  // operaciones a la vez se esperan en fila en vez de bloquearse entre sí.
  if (found.purchaseOrderId) {
    const order = await lockPurchaseOrder(tx, orgId, found.purchaseOrderId)
    await lockSupplier(tx, orgId, order.supplierId)
  }
  const [current] = await tx
    .select()
    .from(expense)
    .where(and(eq(expense.id, expenseId), eq(expense.organizationId, orgId)))
    .for("update")
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
  // La caja donde salió: primero su ventana y después su fila, en el orden de siempre
  // (`lockCashWindow`), porque devolver lo que salió puede abrir la caja de hoy.
  if (current.shiftId) {
    const [where] = await tx
      .select({ branchId: cashShift.branchId, currency: cashShift.currency })
      .from(cashShift)
      .where(and(eq(cashShift.id, current.shiftId), eq(cashShift.organizationId, orgId)))
      .limit(1)
    if (where) await lockCashWindows(tx, orgId, [{ branchId: where.branchId, unit: where.currency }])
  }
  // Bloqueada: un cierre simultáneo espera o ya se ve cerrado.
  const shift = current.shiftId ? await lockShift(tx, orgId, current.shiftId) : null
  if (shift && shift.status !== "abierta" && !(opts.allowPostClose || opts.fromCommission))
    throw conflict(
      "POST_CLOSE_NEEDS_ADMIN",
      "La caja donde salió el gasto ya cerró y no se modifica: solo administración puede anularlo",
    )
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
  if (shift) {
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
    if (movement && shift.status === "abierta") {
      await tx
        .update(cashMovement)
        .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason: reason(input.reason) })
        .where(eq(cashMovement.id, movement.id))
      await audit(tx, orgId, actorUserId, "cash_movement", movement.id, "cash.movement_voided")
    } else if (movement) {
      // Ya cerrada: lo que salió vuelve a entrar en la caja de hoy (lo posterior se corrige como
      // movimiento del día). Es el mismo gasto que vuelve: `gasto` de entrada, unido a él, para que
      // el cierre lo reste de los gastos y Reportes no lo cuente aparte (ya cuenta el gasto anulado).
      const today = await ensureOpenShift(tx, orgId, actorUserId, shift.branchId, movement.currency)
      const [back] = await tx
        .insert(cashMovement)
        .values({
          organizationId: orgId,
          shiftId: today.id,
          direction: "ingreso",
          kind: "gasto",
          amountCents: movement.amountCents,
          currency: movement.currency,
          method: movement.method,
          methodTypeCode: movement.methodTypeCode,
          concept: "Compensación por anulación",
          expenseId,
          createdBy: actorUserId,
        })
        .returning()
      if (back) await audit(tx, orgId, actorUserId, "cash_movement", back.id, "cash.expense_compensated")
    }
  }
  // El pago de una compra cerrada puede ser lo que se tiene a favor con el
  // proveedor: si ya se usó para pagar otra compra, anularlo dejaría usado lo
  // que ya no existe.
  if (current.purchaseOrderId) await assertSupplierCreditCovered(tx, orgId, current.purchaseOrderId)
  await audit(tx, orgId, actorUserId, "expense", expenseId, "finance.expense_voided")
  await notifyCash(tx, orgId)
  return row
}

// --- Pago de compras de Inventario (ADR 0061) -----------------------------------------
//
// Pagar una compra es registrar un gasto de Materiales enlazado a su orden, en
// la sede de su almacén: en partes, por adelantado o con lo que se tiene a favor
// con el proveedor. La misma operación desde Inventario y desde Finanzas › Gastos.

/** Tipo de gasto del pago de una compra. */
export const PURCHASE_EXPENSE_CATEGORY = "Materiales"

/** «OC-0012»: el número de la orden como lo dicen la pantalla y el gasto. */
export function purchaseOrderLabel(orderNumber: number): string {
  return `OC-${String(orderNumber).padStart(4, "0")}`
}

/**
 * La compra ya no espera mercadería: llegó entera, se cerró con lo recibido o
 * se canceló. Lo pagado de más queda a favor con el proveedor (ADR 0061).
 */
function isClosedPurchase(status: string): boolean {
  return (CLOSED_PURCHASE_STATUSES as readonly string[]).includes(status)
}

/**
 * Bloquea la orden. Todo lo que cambia lo pagado de una compra (pagar, anular
 * un pago o un uso de lo que se tiene a favor, cancelar) bloquea primero la
 * orden y después su proveedor (`lockSupplier`), siempre en ese orden.
 */
export async function lockPurchaseOrder(tx: Db, orgId: string, orderId: string) {
  const [row] = await tx
    .select()
    .from(purchaseOrder)
    .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.id, orderId)))
    .for("update")
  if (!row) throw purchaseOrderNotFound()
  return row
}

/** Lo que se tiene a favor con un proveedor cambia de a uno: se bloquea el proveedor. */
export async function lockSupplier(tx: Db, orgId: string, supplierId: string): Promise<void> {
  await tx
    .select({ id: supplier.id })
    .from(supplier)
    .where(and(eq(supplier.organizationId, orgId), eq(supplier.id, supplierId)))
    .for("update")
}

/** Lo que se tiene a favor con el proveedor, en una moneda. */
async function creditWith(tx: Db, orgId: string, supplierId: string, unit: string): Promise<number> {
  const credits = await supplierCredits(tx, orgId, { supplierId })
  return credits.find((credit) => credit.currency === unit)?.cents ?? 0
}

/**
 * Nunca queda usado más de lo que se tenía a favor con el proveedor de la
 * orden. Se llama después del cambio, dentro de la misma transacción: si no
 * alcanza, el error deshace todo.
 */
export async function assertSupplierCreditCovered(tx: Db, orgId: string, orderId: string): Promise<void> {
  const [order] = await tx
    .select({ supplierId: purchaseOrder.supplierId, currency: purchaseOrder.currency })
    .from(purchaseOrder)
    .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.id, orderId)))
  if (!order) return
  await lockSupplier(tx, orgId, order.supplierId)
  if ((await creditWith(tx, orgId, order.supplierId, order.currency)) < 0) {
    // Dice qué compras lo usaron: ese uso se anula en su detalle, en Inventario › Compras.
    const users = await tx
      .select({ orderNumber: purchaseOrder.orderNumber })
      .from(supplierCreditUse)
      .innerJoin(purchaseOrder, and(eq(purchaseOrder.organizationId, supplierCreditUse.organizationId), eq(purchaseOrder.id, supplierCreditUse.orderId)))
      .where(
        and(
          eq(supplierCreditUse.organizationId, orgId),
          eq(supplierCreditUse.supplierId, order.supplierId),
          eq(supplierCreditUse.currency, order.currency),
          isNull(supplierCreditUse.voidedAt),
        ),
      )
      .orderBy(desc(supplierCreditUse.createdAt))
      .limit(3)
    const labels = [...new Set(users.map((row) => purchaseOrderLabel(Number(row.orderNumber))))]
    throw conflict(
      "SUPPLIER_CREDIT_USED",
      `Lo pagado de más en esta compra ya se usó para pagar ${labels.length > 0 ? labels.join(", ") : "otra compra"}: anula antes ese uso en el detalle de esa compra, en Inventario › Compras`,
    )
  }
}

export interface PayPurchaseOrderInput {
  orderId: string
  /** Lo que se paga con dinero (gasto de Materiales), en la moneda de la compra. Cero si todo va con lo que se tenía a favor. */
  amountCents: number
  /** Lo que se usa de lo que se tiene a favor con el proveedor. */
  creditCents?: number
  /**
   * El cruce: lo que salió, si se pagó en la otra moneda. USD 1,500 pagados con
   * S/ 5,640 dejan la compra al día; el cambio se calcula solo.
   */
  tenderCents?: number
  tenderCurrency?: string
  /** El cambio, si se paga en una moneda que no es la del negocio. */
  exchangeRate?: string
  spentAt?: string | null
  fromCash?: boolean
  receiptKind?: string
  receiptNumber?: string | null
  notes?: string | null
  /** Lo que la pantalla mostró por pagar: si cambió mientras tanto, no se paga sobre otra cifra. */
  expectedDueCents?: number
  /**
   * Lo pagado que mostró la pantalla. Si cambió, alguien pagó mientras tanto o
   * este mismo pago ya entró (un envío repetido): no se registra otra vez. No
   * es una clave de idempotencia (el gasto no tiene dónde guardarla): el
   * reintento recibe un aviso, no el pago que ya se hizo.
   */
  expectedPaidCents?: number
}

/**
 * Registra el pago de una compra (o una parte, o un adelanto): un gasto de
 * Materiales en la sede de su almacén, enlazado a la orden, y si se pide, lo
 * que se usa de lo que se tiene a favor con el proveedor. Pagar de más deja
 * saldo a favor cuando la compra cierra. No se paga una orden en borrador ni
 * una cancelada.
 */
export async function payPurchaseOrder(tx: Db, orgId: string, actorUserId: string, input: PayPurchaseOrderInput) {
  const order = await lockPurchaseOrder(tx, orgId, input.orderId)
  // Lo que es de la compra elegida se dice en `orderId` (la compra, en la pantalla que la elige).
  const orderConflict = (code: string, message: string) => new ServiceError(code, 409, message, { orderId: message })
  if (order.status === "borrador") throw orderConflict("PURCHASE_NOT_CONFIRMED", "Confirma la orden antes de pagarla")
  if (order.status === "cancelada") throw orderConflict("PURCHASE_CANCELLED", "La orden está cancelada: ya no se paga")
  await lockSupplier(tx, orgId, order.supplierId)
  const amountCents = input.amountCents ?? 0
  const creditCents = input.creditCents ?? 0
  if (!Number.isSafeInteger(amountCents) || amountCents < 0 || amountCents > 2147483647)
    throw invalidField("amountCents", "El pago debe ser un importe entero")
  if (!Number.isSafeInteger(creditCents) || creditCents < 0 || creditCents > 2147483647)
    throw invalidField("creditCents", "Lo que se usa a favor debe ser un importe entero")
  if (amountCents + creditCents <= 0) throw invalidField("amountCents", "El pago debe ser mayor que cero")
  if (input.tenderCents !== undefined && input.tenderCurrency === undefined)
    throw invalidField("tenderCurrency", "Di en qué moneda salió")
  if (input.tenderCurrency !== undefined && input.tenderCents === undefined)
    throw invalidField("tenderCents", "Escribe lo que salió")
  if (input.tenderCents !== undefined && amountCents === 0)
    throw invalidField("amountCents", "Escribe lo que cancelas")
  const [before] = await purchaseBalances(tx, orgId, { orderIds: [order.id] })
  if (!before) throw purchaseOrderNotFound()
  if (input.expectedPaidCents !== undefined && input.expectedPaidCents !== before.paidCents)
    throw orderConflict(
      "PURCHASE_PAID_CHANGED",
      "Esta compra tiene un pago nuevo desde que la abriste (puede ser este mismo, si se envió dos veces): vuelve a mirarla antes de pagar",
    )
  if (input.expectedDueCents !== undefined && input.expectedDueCents !== before.dueCents)
    throw orderConflict("PURCHASE_DUE_CHANGED", "Lo que falta pagar de esta compra cambió mientras lo revisabas: vuelve a mirarlo")
  if (creditCents > 0) {
    if (creditCents > (await creditWith(tx, orgId, order.supplierId, order.currency)))
      throw new ServiceError("SUPPLIER_CREDIT_SHORT", 409, "No tienes tanto a favor con este proveedor", {
        creditCents: "No tienes tanto a favor con este proveedor",
      })
    // Una compra cerrada ya no espera lo que falta: vale lo que llegó.
    const worth = isClosedPurchase(before.status) ? before.receivedCents : before.orderedCents
    if (creditCents > Math.max(0, worth - before.paidCents))
      throw new ServiceError(
        "SUPPLIER_CREDIT_TOO_MUCH",
        409,
        "Lo que usas a favor no puede pasar de lo que falta pagar de la orden",
        { creditCents: "Lo que usas a favor no puede pasar de lo que falta pagar de la orden" },
      )
  }
  const label = purchaseOrderLabel(before.orderNumber)
  // Sin nada recibido por pagar y con algo aún por llegar, lo que se paga es un adelanto
  // (también en una compra recibida en parte y al día).
  const kind = before.dueCents === 0 && !isClosedPurchase(before.status) ? "Adelanto de compra" : "Pago de compra"
  const part = before.dueCents > 0 && amountCents + creditCents < before.dueCents ? " (una parte)" : ""
  let paid: typeof expense.$inferSelect | null = null
  if (amountCents > 0) {
    paid = await createExpense(
      tx,
      orgId,
      actorUserId,
      {
        branchId: before.branchId,
        category: PURCHASE_EXPENSE_CATEGORY,
        concept: `${kind} ${label} · ${before.supplierName}${part}`,
        amountCents,
        currency: order.currency,
        ...(input.exchangeRate !== undefined ? { exchangeRate: input.exchangeRate } : {}),
        spentAt: input.spentAt ?? null,
        receiptKind: input.receiptKind,
        receiptNumber: input.receiptNumber,
        notes: input.notes,
        fromCash: input.fromCash ?? false,
      },
      {
        purchaseOrderId: order.id,
        ...(input.tenderCents !== undefined && input.tenderCurrency !== undefined
          ? { tender: { cents: input.tenderCents, currency: input.tenderCurrency } }
          : {}),
      },
    )
  }
  let used: typeof supplierCreditUse.$inferSelect | null = null
  if (creditCents > 0) {
    const [row] = await tx
      .insert(supplierCreditUse)
      .values({
        organizationId: orgId,
        supplierId: order.supplierId,
        orderId: order.id,
        amountCents: creditCents,
        currency: order.currency,
        createdBy: actorUserId,
      })
      .returning()
    used = row ?? null
    if (used) await audit(tx, orgId, actorUserId, "supplier_credit_use", used.id, "purchase_order.credit_used")
  }
  await audit(tx, orgId, actorUserId, "purchase_order", order.id, "purchase_order.paid")
  const [after] = await purchaseBalances(tx, orgId, { orderIds: [order.id] })
  return { expense: paid, creditUse: used, balance: after as PurchaseBalance }
}

/** Deshace un uso de lo que se tenía a favor: vuelve a estar a favor y la compra vuelve a deberlo. */
export async function voidSupplierCreditUse(tx: Db, orgId: string, actorUserId: string, id: string, input: { reason: string }) {
  const [found] = await tx
    .select({ orderId: supplierCreditUse.orderId })
    .from(supplierCreditUse)
    .where(and(eq(supplierCreditUse.organizationId, orgId), eq(supplierCreditUse.id, id)))
  if (!found) throw notFound("Uso del saldo a favor")
  // Orden y proveedor primero, como al pagar y al cancelar.
  const order = await lockPurchaseOrder(tx, orgId, found.orderId)
  await lockSupplier(tx, orgId, order.supplierId)
  const [current] = await tx
    .select()
    .from(supplierCreditUse)
    .where(and(eq(supplierCreditUse.organizationId, orgId), eq(supplierCreditUse.id, id)))
    .for("update")
  if (!current) throw notFound("Uso del saldo a favor")
  if (current.voidedAt) throw conflict("CREDIT_USE_VOIDED", "Ese uso del saldo a favor ya está anulado")
  const [row] = await tx
    .update(supplierCreditUse)
    .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason: reason(input.reason) })
    .where(and(eq(supplierCreditUse.organizationId, orgId), eq(supplierCreditUse.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, "supplier_credit_use", id, "purchase_order.credit_use_voided")
  return row
}

/**
 * Lo que hay que pagar de las compras: las recibidas sin pagar (el aviso de
 * Finanzas › Gastos) y lo que aún falta que llegue (se puede adelantar, también
 * de una compra recibida en parte y al día), con lo que se tiene a favor con
 * cada proveedor. De la clínica o de una sede. El aviso cuenta y suma en la
 * moneda de la clínica; otra moneda va aparte y nunca se suma.
 */
export async function getPurchasesToPay(tx: Db, orgId: string, query: { branchId?: string } = {}) {
  const { currency: unit } = await getOrgLocale(tx, orgId)
  const open = (await purchaseBalances(tx, orgId, { openOnly: true })).filter(
    (order) =>
      (!query.branchId || order.branchId === query.branchId) &&
      (order.dueCents > 0 || (!isClosedPurchase(order.status) && order.orderedCents > order.paidCents)),
  )
  const unpaid = open.filter((order) => order.dueCents > 0 && order.currency === unit)
  const oldest = unpaid.reduce<PurchaseBalance | null>(
    (first, order) =>
      order.firstReceivedAt && (!first?.firstReceivedAt || order.firstReceivedAt < first.firstReceivedAt) ? order : first,
    null,
  )
  const others = new Map<string, { currency: string; orders: number; cents: number }>()
  for (const order of open) {
    if (order.dueCents <= 0 || order.currency === unit) continue
    const entry = others.get(order.currency) ?? { currency: order.currency, orders: 0, cents: 0 }
    entry.orders += 1
    entry.cents = addCents(entry.cents, order.dueCents)
    others.set(order.currency, entry)
  }
  return {
    currency: unit,
    /** «3 compras recibidas sin pagar: S/ 2 300. La más antigua llegó hace 34 días.» */
    unpaid: {
      orders: unpaid.length,
      cents: unpaid.reduce((total, order) => addCents(total, order.dueCents), 0),
      oldest,
      /** Compras en otra moneda sin pagar, cada moneda por su lado. */
      otherCurrencies: [...others.values()],
    },
    /** Lo que se puede pagar ahora: primero lo que más tiempo lleva recibido sin pagar, después lo que aún no llega. */
    orders: [...open].sort(
      (a, b) =>
        Number(b.dueCents > 0) - Number(a.dueCents > 0) ||
        (a.firstReceivedAt?.getTime() ?? a.createdAt.getTime()) - (b.firstReceivedAt?.getTime() ?? b.createdAt.getTime()),
    ),
    credits: (await supplierCredits(tx, orgId)).filter((credit) => credit.cents > 0),
  }
}

/**
 * «No hubo ese gasto»: la clínica dice que ese mes no tuvo gastos de ese tipo y
 * Reportes deja de avisarlo. Repetirlo no hace nada.
 */
export async function dismissExpenseGap(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { category: string; month: string; branchId?: string | null },
) {
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(input.category)) throw validation("Tipo de gasto inválido")
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw validation("El mes debe tener formato AAAA-MM")
  const branchId = input.branchId ? (await requireBranch(tx, orgId, input.branchId)).id : null
  const [row] = await tx
    .insert(expenseGapDismissal)
    .values({ organizationId: orgId, category: input.category, month: input.month, branchId, createdBy: actorUserId })
    .onConflictDoNothing()
    .returning()
  if (row) await audit(tx, orgId, actorUserId, "expense_gap_dismissal", row.id, "finance.expense_gap_dismissed")
  return { category: input.category, month: input.month, branchId, dismissed: true }
}

// --- Cuentas por cobrar ------------------------------------------------------------

/**
 * Cuentas por cobrar por paciente y moneda: cargos vigentes menos aplicaciones
 * vigentes. Contrato para Reportes y Portal (saldo del paciente). Con
 * `outstandingOnly`, solo los cargos con saldo, filtrados en la consulta: las
 * deudas no recorren toda la historia de cobros de la clínica.
 */
export async function getReceivables(
  tx: Db,
  orgId: string,
  query: { patientId?: string; patientIds?: string[]; branchId?: string; outstandingOnly?: boolean } = {},
) {
  const chargeFilter = [eq(patientCharge.organizationId, orgId), isNull(patientCharge.voidedAt)]
  if (query.patientId) chargeFilter.push(eq(patientCharge.patientId, query.patientId))
  if (query.patientIds) chargeFilter.push(inArray(patientCharge.patientId, query.patientIds))
  if (query.branchId) chargeFilter.push(eq(patientCharge.branchId, query.branchId))
  if (query.outstandingOnly)
    chargeFilter.push(sql`${patientCharge.amountCents} > coalesce((
      select sum(a.amount_cents) from patient_payment_application a
      where a.organization_id = ${patientCharge.organizationId} and a.charge_id = ${patientCharge.id} and a.voided_at is null
    ), 0)`)
  const charges = await tx
    .select()
    .from(patientCharge)
    .where(and(...chargeFilter))
    .orderBy(asc(patientCharge.createdAt), asc(patientCharge.id))
  if (query.outstandingOnly && charges.length === 0) return []
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        isNull(patientPaymentApplication.voidedAt),
        ...(query.patientId ? [eq(patientPaymentApplication.patientId, query.patientId)] : []),
        ...(query.outstandingOnly
          ? [inArray(patientPaymentApplication.chargeId, charges.map((charge) => charge.id))]
          : []),
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
/**
 * La regla vigente de un profesional para algo cobrado en `at` (la general o la
 * de un servicio): la última versión que ya valía.
 */
async function latestRate(
  tx: Db,
  orgId: string,
  professionalUserId: string,
  serviceId: string | null,
  at: Date | "now" = "now",
) {
  const [row] = await tx
    .select()
    .from(commissionRate)
    .where(
      and(
        eq(commissionRate.organizationId, orgId),
        eq(commissionRate.professionalUserId, professionalUserId),
        serviceId ? eq(commissionRate.serviceId, serviceId) : isNull(commissionRate.serviceId),
        at === "now" ? sql`${commissionRate.effectiveFrom} <= now()` : lte(commissionRate.effectiveFrom, at),
      ),
    )
    .orderBy(desc(commissionRate.effectiveFrom))
    .limit(1)
  return row ?? null
}

/** «8 de noviembre», en la zona y el idioma de la clínica. */
function dayWords(at: Date, zone: { locale: string; timezone: string }): string {
  return new Intl.DateTimeFormat(zone.locale, { day: "numeric", month: "long", timeZone: zone.timezone }).format(at)
}

/**
 * Cambiar el porcentaje general (ADR 0151 y 0155): una versión nueva que vale para
 * lo que se atienda desde ahora; lo atendido antes conserva el de su día, aunque se
 * cobre después. La primera de alguien vale desde siempre, para que fijarlo tarde no
 * deje en cero lo ya cobrado. La auditoría guarda antes y después, y se le avisa al
 * profesional.
 */
export async function setCommissionRate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { professionalUserId: string; rateBps: number },
) {
  // Un porcentaje es de quien puede atender; volverlo a 0 se le puede hacer a cualquiera del equipo.
  // La persona llega en el cuerpo: si no es de la clínica, se dice junto a ella.
  if (input.rateBps === 0) {
    await requireProfessional(tx, orgId, input.professionalUserId).catch((error: unknown) => {
      if (error instanceof ServiceError && error.code === "NOT_FOUND")
        throw new ServiceError("NOT_FOUND", 404, error.message, { professionalUserId: error.message })
      throw error
    })
  } else {
    await requireCanAttend(tx, orgId, input.professionalUserId, "professionalUserId")
  }
  if (!Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 10000)
    throw invalidField("rateBps", "Escribe un porcentaje entre 0 y 100, con dos decimales como máximo.")
  // Dos cambios del mismo profesional a la vez no deben pisarse la versión.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`commission-rate:${orgId}:${input.professionalUserId}`}, 0))`,
  )
  const [anyGeneral] = await tx
    .select({ id: commissionRate.id })
    .from(commissionRate)
    .where(
      and(
        eq(commissionRate.organizationId, orgId),
        eq(commissionRate.professionalUserId, input.professionalUserId),
        isNull(commissionRate.serviceId),
      ),
    )
    .limit(1)
  const current = await latestRate(tx, orgId, input.professionalUserId, null)
  if (current && current.rateBps === input.rateBps) return current
  const [row] = await tx
    .insert(commissionRate)
    .values({
      organizationId: orgId,
      professionalUserId: input.professionalUserId,
      serviceId: null,
      // La hora de ahora, ya con el turno tomado: dos cambios seguidos quedan en el orden en que se guardaron.
      effectiveFrom: anyGeneral ? sql`clock_timestamp()` : sql`'-infinity'::timestamptz`,
      rateBps: input.rateBps,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "commission_rate", row.id, "finance.rule_updated", {
    professionalUserId: input.professionalUserId,
    before: current?.rateBps ?? null,
    after: input.rateBps,
  })
  // Al profesional se le dice, sin pedirle nada: es lo que va a ver en «Mis honorarios».
  if (anyGeneral && input.professionalUserId !== actorUserId) {
    const zone = await getOrgLocale(tx, orgId)
    await createWorkspaceNotification(tx, orgId, {
      userId: input.professionalUserId,
      dedupeKey: `commission-rate:${row.id}`,
      title: "Cambió tu porcentaje de comisión",
      body: `Pasó a ${percentWords(input.rateBps, zone.locale)} para lo que atiendas desde el ${dayWords(new Date(), zone)}. Lo atendido antes conserva el de su día, aunque se cobre después.`,
      href: "/commissions",
      permission: "commissions.read",
      actorUserId,
    })
  }
  return row
}

/** «40 %», «12,5 %». */
function percentWords(rateBps: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(rateBps / 100)} %`
}

export interface CommissionExceptionInput {
  professionalUserId: string
  serviceId: string
  /** Otro porcentaje para el servicio. */
  rateBps?: number | null
  /** O un monto fijo por cada procedimiento, en la moneda del precio del servicio. */
  fixedCents?: number | null
}

/**
 * Una excepción para un servicio: otro porcentaje, un monto fijo por cada uno o,
 * sin ninguno de los dos, quitarla (vuelve al general). Vale para lo que se atienda
 * desde ahora, como el porcentaje general; la primera de un servicio, sin porcentaje
 * general, vale también para lo ya cobrado de él que aún no se paga (un profesional
 * puede comisionar solo por servicio). El monto va en la moneda del precio del
 * servicio, porque la comisión va en la moneda de lo cobrado (ADR 0155).
 */
export async function setCommissionException(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CommissionExceptionInput,
) {
  const removing = (input.rateBps ?? null) === null && (input.fixedCents ?? null) === null
  // Quitar se le puede hacer a cualquiera del equipo (como volver a 0 el general); poner, a quien atiende.
  if (removing) await requireProfessional(tx, orgId, input.professionalUserId)
  else await requireCanAttend(tx, orgId, input.professionalUserId, "professionalUserId")
  if (!looksLikeId(input.serviceId)) throw invalidField("serviceId", "Elige el servicio.")
  const [service] = await tx
    .select({ id: serviceCatalog.id, name: serviceCatalog.name, currency: serviceCatalog.currency })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.id, input.serviceId)))
  if (!service) throw invalidField("serviceId", "Ese servicio no es de la clínica.")
  const fixedCurrency = (input.fixedCents ?? null) === null ? null : service.currency
  const rateBps = input.rateBps ?? null
  const fixedCents = input.fixedCents ?? null
  if (rateBps !== null && fixedCents !== null) throw invalidField("rateBps", "Elige un porcentaje o un monto, no los dos.")
  if (rateBps !== null && (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000))
    throw invalidField("rateBps", "Escribe un porcentaje entre 0 y 100, con dos decimales como máximo.")
  if (fixedCents !== null && (!Number.isSafeInteger(fixedCents) || fixedCents <= 0 || fixedCents > 2147483647))
    throw invalidField("fixedCents", "Escribe un monto mayor que cero.")
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`commission-rate:${orgId}:${input.professionalUserId}`}, 0))`,
  )
  const current = await latestRate(tx, orgId, input.professionalUserId, service.id)
  // Sin porcentaje general ni nada antes para este servicio, lo ya cobrado de él no tenía ninguna regla
  // (daba 0 y un pago no lo congelaba): la primera comisión del servicio vale también para eso, como el
  // primer porcentaje general. Con un general, lo de antes ya se calculó con él y el cambio vale desde ahora.
  const [anyBefore] = current
    ? [current]
    : await tx
        .select({ id: commissionRate.id })
        .from(commissionRate)
        .where(
          and(
            eq(commissionRate.organizationId, orgId),
            eq(commissionRate.professionalUserId, input.professionalUserId),
            or(isNull(commissionRate.serviceId), eq(commissionRate.serviceId, service.id)),
          ),
        )
        .limit(1)
  const zone = await getOrgLocale(tx, orgId)
  // Lo guardado sin moneda es del negocio: el mismo monto en otra moneda es otra regla.
  const currentCurrency = current?.fixedCents == null ? null : (current.fixedCurrency ?? zone.currency)
  const same =
    (current?.rateBps ?? null) === rateBps &&
    (current?.fixedCents ?? null) === fixedCents &&
    currentCurrency === fixedCurrency
  // Quitar lo que no había, o repetir lo mismo, no agrega una versión.
  if (same || (!current && rateBps === null && fixedCents === null)) return current
  // Comisionar solo por servicio es decidir que lo demás no comisiona: sin un porcentaje general, se
  // guarda uno de 0 desde siempre. Así lo demás se paga en 0 (y se congela al pagar) en vez de quedar
  // sin decidir, y un porcentaje que se ponga después vale desde ese día sin reabrir meses pagados.
  if (rateBps !== null || fixedCents !== null) {
    const general = await latestRate(tx, orgId, input.professionalUserId, null)
    if (!general)
      await tx.insert(commissionRate).values({
        organizationId: orgId,
        professionalUserId: input.professionalUserId,
        serviceId: null,
        effectiveFrom: sql`'-infinity'::timestamptz`,
        rateBps: 0,
        createdBy: actorUserId,
      })
  }
  const [row] = await tx
    .insert(commissionRate)
    .values({
      organizationId: orgId,
      professionalUserId: input.professionalUserId,
      serviceId: service.id,
      effectiveFrom: anyBefore ? sql`clock_timestamp()` : sql`'-infinity'::timestamptz`,
      rateBps,
      fixedCents,
      fixedCurrency,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "commission_rate", row.id, "finance.rule_exception", {
    professionalUserId: input.professionalUserId,
    serviceId: service.id,
    before: current ? { rateBps: current.rateBps, fixedCents: current.fixedCents, fixedCurrency: currentCurrency } : null,
    after: { rateBps, fixedCents, fixedCurrency },
  })
  return row
}

/** El porcentaje general de hoy de cada profesional que tiene uno. */
export async function listCommissionRates(
  tx: Db,
  orgId: string,
  query: { professionalUserId?: string } = {},
) {
  const rows = await tx.execute<{ professionalUserId: string; rateBps: number; effectiveFrom: Date }>(sql`
    select distinct on (r.professional_user_id) r.professional_user_id as "professionalUserId", r.rate_bps as "rateBps",
      r.effective_from as "effectiveFrom"
    from commission_rate r
    where r.organization_id = ${orgId} and r.service_id is null and r.effective_from <= now()
      ${query.professionalUserId ? sql`and r.professional_user_id = ${query.professionalUserId}` : sql``}
    order by r.professional_user_id, r.effective_from desc`)
  const names = await userNames(
    tx,
    rows.map((r) => r.professionalUserId),
  )
  return rows.map((r) => ({ ...r, professionalName: names.get(r.professionalUserId) ?? null }))
}

/**
 * La comisión de hoy de cada persona del equipo que puede atender, la tenga o no: su porcentaje
 * general (con desde cuándo y el anterior) y cada servicio con una comisión distinta. Es lo que se
 * fija en Configuración › Comisiones por profesional; el mes se calcula aparte, con lo que valía cada día.
 *
 * - Sin ningún porcentaje ni servicio: aún no se decidió (lo cobrado de lo que atiende da 0 hasta fijarla).
 * - Porcentaje 0 sin servicios: no cobra comisión (por ejemplo, solo tiene sueldo).
 * - Porcentaje 0 con servicios: comisiona solo por esos servicios (la primera comisión de un
 *   servicio, sin porcentaje general, guarda también el 0 general).
 */
export async function listCommissionAgreements(tx: Db, orgId: string) {
  const team = await tx
    .select({ userId: member.userId, role: member.role, name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, orgId))
  // Quien dejó de atender (cambió de rol) sigue si tiene una comisión: el mes lo lista y desde aquí se
  // deja en «no cobra comisión». Una comisión nueva solo se le pone a quien atiende.
  const withRules = new Set(
    (
      await tx
        .selectDistinct({ userId: commissionRate.professionalUserId })
        .from(commissionRate)
        .where(eq(commissionRate.organizationId, orgId))
    ).map((row) => row.userId),
  )
  const people = team
    .filter((row) => canAttend(row.role) || withRules.has(row.userId))
    .sort((a, b) => a.name.localeCompare(b.name, "es"))
  const out = []
  for (const person of people) {
    const rules = await commissionRulesOf(tx, orgId, person.userId)
    const attends = canAttend(person.role)
    // Quien ya no atiende y ya no cobra nada no tiene nada que decidir: no se lista.
    if (!attends && rules.rateBps === 0 && rules.exceptions.length === 0) continue
    out.push({
      professionalUserId: person.userId,
      professionalName: person.name,
      /** Puede atender: solo a él se le pone una comisión; a quien ya no, solo se le deja en 0. */
      attends,
      rateBps: rules.rateBps,
      hasRate: rules.hasRate,
      rateSince: rules.since,
      previousRateBps: rules.previousRateBps,
      exceptions: rules.exceptions,
    })
  }
  return out
}

async function commissionRateOf(tx: Db, orgId: string, professionalUserId: string): Promise<number> {
  return (await latestRate(tx, orgId, professionalUserId, null))?.rateBps ?? 0
}

/**
 * Lo que rige hoy para un profesional, para su detalle: el porcentaje general,
 * desde cuándo y el anterior, y cada excepción por servicio que sigue en pie.
 */
export async function commissionRulesOf(
  tx: Db,
  orgId: string,
  professionalUserId: string,
  /** Las que valían a ese momento (el fin de un mes pasado); sin él, las de hoy. */
  at?: Date,
) {
  const upTo = at ? sql`${at.toISOString()}::timestamptz` : sql`now()`
  const general = await tx
    .select({ rateBps: commissionRate.rateBps, effectiveFrom: commissionRate.effectiveFrom })
    .from(commissionRate)
    .where(
      and(
        eq(commissionRate.organizationId, orgId),
        eq(commissionRate.professionalUserId, professionalUserId),
        isNull(commissionRate.serviceId),
        sql`${commissionRate.effectiveFrom} <= ${upTo}`,
      ),
    )
    .orderBy(desc(commissionRate.effectiveFrom))
    .limit(2)
  const exceptions = await tx.execute<{
    serviceId: string
    serviceName: string
    rateBps: number | null
    fixedCents: number | null
    fixedCurrency: string | null
    servicePriceCents: number
    serviceCurrency: string
    billingMode: string
    effectiveFrom: Date
  }>(sql`
    select x.service_id as "serviceId", sc.name as "serviceName", x.rate_bps as "rateBps", x.fixed_cents as "fixedCents",
      -- Lo guardado sin moneda es del negocio.
      case when x.fixed_cents is not null then coalesce(x.fixed_currency, op.currency) end as "fixedCurrency",
      sc.price_cents as "servicePriceCents", sc.currency as "serviceCurrency", sc.billing_mode as "billingMode",
      x.effective_from as "effectiveFrom"
    from (
      select distinct on (r.service_id) r.service_id, r.rate_bps, r.fixed_cents, r.fixed_currency, r.effective_from
      from commission_rate r
      where r.organization_id = ${orgId} and r.professional_user_id = ${professionalUserId} and r.service_id is not null
        and r.effective_from <= ${upTo}
      order by r.service_id, r.effective_from desc
    ) x
    join service_catalog sc on sc.organization_id = ${orgId} and sc.id = x.service_id
    left join org_profile op on op.organization_id = ${orgId}
    where x.rate_bps is not null or x.fixed_cents is not null
    order by sc.name`)
  const [now, before] = general
  // Desde siempre (`-infinity`) no tiene día que decir.
  const since = now && Number.isFinite(now.effectiveFrom.getTime()) ? now.effectiveFrom : null
  return {
    rateBps: now?.rateBps ?? 0,
    /** Ya tiene un porcentaje general: cambiarlo vale desde ahora (el primero vale desde siempre). */
    hasRate: Boolean(now),
    since,
    previousRateBps: before?.rateBps ?? null,
    exceptions: [...exceptions].map((row) => ({
      ...row,
      effectiveFrom: Number.isFinite(new Date(row.effectiveFrom).getTime()) ? row.effectiveFrom : null,
    })),
  }
}

/**
 * Las líneas de `commission_live` de una clínica en un tramo, como subconsulta. Lo de una sola
 * parte (casi todo) cuenta el día del cobro y se filtra por `cobro_at`, que la base lleva hasta la
 * tabla; lo repartido por sesiones (pocos cargos, con su índice) se filtra aparte por `at`, el día
 * de la sesión. Filtrar todo por `at`, o con un `or`, calculaba la historia entera cada vez.
 */
export function commissionLiveIn(orgId: string, start: Date, end: Date, extra: SQL = sql``): SQL {
  const from = sql`${start.toISOString()}::timestamptz`
  const to = sql`${end.toISOString()}::timestamptz`
  return sql`(select * from commission_live
      where organization_id = ${orgId} and split_sessions is null and cobro_at >= ${from} and cobro_at < ${to} ${extra}
    union all
    select * from commission_live
      where organization_id = ${orgId} and split_sessions is not null and at >= ${from} and at < ${to} ${extra})`
}

/** Un decimal de la base («123.4500…») como fracción exacta, sin pasar por `number`. */
function fractionOfDecimal(text: string): MoneyFraction {
  const negative = text.startsWith("-")
  const [whole = "0", decimals = ""] = (negative ? text.slice(1) : text).split(".")
  const num = BigInt(`${whole}${decimals}` || "0")
  return { num: negative ? -num : num, den: 10n ** BigInt(decimals.length) }
}

/**
 * Una línea aún sin pagar, como la da `commission_live` (la misma cuenta de Reportes y Argos), en
 * la moneda de lo cobrado: lo cobrado y la comisión en `currency`.
 */
interface LiveCommissionLine {
  applicationId: string
  slice: number | null
  sessions: number
  chargeId: string
  paymentId: string
  patientId: string
  description: string
  promotionName: string | null
  at: Date
  currency: string
  value: MoneyFraction
  rateBps: number | null
  fixedCents: number | null
  forService: boolean
  /** Tuvo alguna regla (general o del servicio): sin ninguna da 0 y no se congela al pagar. */
  hasRule: boolean
  commissionCents: number
}

async function liveCommissionLines(
  tx: Db,
  orgId: string,
  query: { professionalUserId: string; start: Date; end: Date },
): Promise<LiveCommissionLine[]> {
  const rows = await tx.execute<{
    applicationId: string
    slice: number | null
    sessions: number
    chargeId: string
    paymentId: string
    patientId: string
    description: string
    promotionName: string | null
    at: Date
    currency: string
    value: string
    rateBps: number | null
    fixedCents: number | null
    forService: boolean
    hasRule: boolean
    commission: string
  }>(sql`
    select l.application_id as "applicationId", l.slice, l.sessions, l.charge_id as "chargeId", l.payment_id as "paymentId",
      l.patient_id as "patientId", l.description, l.promotion_name as "promotionName", l.at, l.currency,
      l.own_value::text as value, l.rate_bps as "rateBps", l.fixed_cents as "fixedCents", l.for_service as "forService",
      l.has_rule as "hasRule", l.own_commission::text as commission
    from ${commissionLiveIn(orgId, query.start, query.end, sql`and professional_user_id = ${query.professionalUserId}`)} l`)
  return [...rows].map((row) => ({
    ...row,
    at: new Date(row.at),
    value: fractionOfDecimal(row.value),
    commissionCents: Number(row.commission),
  }))
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
  /** Lo aplicado, en moneda del negocio, con el valor congelado de su pago. */
  appValue: MoneyFraction
  /** Lo necesario para valorar otra parte de ese pago (`money_value`). */
  paymentValueCents: number | null
  paymentCurrency: string
  paidAt: Date
  methodLabel: string
  cashMethod: boolean
  patientId: string
  professionalUserId: string
}

/** Una aplicación de un pago a un cargo: lo mínimo para repartir sus devoluciones (`allocateRefunds`). */
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
 * manuales sin atención y actos anulados o de atenciones no finalizadas. Cada
 * una con su valor en moneda del negocio; lo viejo en otra moneda, sin valor ni
 * factor, no entra.
 */
async function collectedApplications(
  tx: Db,
  orgId: string,
  start: Date,
  end: Date,
  money: OrgMoney,
  query: {
    professionalUserId?: string
    branchId?: string
    /**
     * `true`: solo lo que sigue en pie hoy (comisiones: lo anulado deja de
     * deberse). Por defecto, lo que estaba en pie al terminar el mes (reportes
     * de un mes ya cerrado, que no cambian por lo que pase después).
     */
    liveNow?: boolean
    /**
     * Como «Lo cobrado por tratamiento» (ADR 0068): lo que después se devolvió
     * cuenta el día que se cobró, y no su reemplazo. La diferencia devuelta se
     * resta aparte, el día de la devolución (`returnedApplications`).
     */
    returnsApart?: boolean
  } = {},
): Promise<CollectedApp[]> {
  const stillLive = (column: typeof patientPaymentApplication.voidedAt | typeof patientCharge.voidedAt | typeof patientPayment.voidedAt) =>
    query.liveNow ? isNull(column) : or(isNull(column), gte(column, end))
  // Con `returnsApart`, lo anulado por una devolución sigue contando: su diferencia se resta aparte.
  const keptOrReturned = (column: typeof patientPaymentApplication.voidedAt | typeof patientCharge.voidedAt) =>
    query.returnsApart ? or(stillLive(column), isNotNull(patientPaymentApplication.returnId))! : stillLive(column)
  const filters = [
    eq(patientPaymentApplication.organizationId, orgId),
    gte(patientPaymentApplication.createdAt, start),
    lt(patientPaymentApplication.createdAt, end),
    keptOrReturned(patientPaymentApplication.voidedAt),
    keptOrReturned(patientCharge.voidedAt),
    stillLive(patientPayment.voidedAt),
    isNull(encounterProcedure.voidedAt),
    eq(encounter.status, "finalizada"),
    isNull(encounter.voidedAt),
  ]
  if (query.professionalUserId) filters.push(eq(encounter.professionalUserId, query.professionalUserId))
  if (query.branchId) filters.push(eq(patientPayment.branchId, query.branchId))
  if (query.returnsApart) filters.push(isNull(patientPaymentApplication.replacesApplicationId))
  const rows = await tx
    .select({
      app: patientPaymentApplication,
      charge: patientCharge,
      payment: patientPayment,
      professionalUserId: encounter.professionalUserId,
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
  return rows.flatMap((r) => {
    const appValue = orgPartValue(r.app.amountCents, r.payment, money)
    if (!appValue) return []
    return [
      {
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
        appValue,
        paymentValueCents: r.payment.businessCents,
        paymentCurrency: r.payment.currency,
        paidAt: r.payment.paidAt,
        methodLabel: r.payment.methodName,
        cashMethod: methodCashOf(r.payment),
        patientId: r.app.patientId,
        professionalUserId: r.professionalUserId,
      },
    ]
  })
}

/**
 * Reparte las devoluciones del mes entre las aplicaciones incluidas: cada
 * devolución consume primero el saldo sin aplicar del pago y solo el
 * excedente reduce la base comisionable, a prorrata del importe aplicado.
 */
export async function allocateRefunds(
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
    // Lo que anuló esta misma devolución ya no estaba en pie: su reemplazo es lo que queda.
    // (Su `voidedAt` puede quedar unos milisegundos después de la devolución.)
    const liveAtRefund = allApps.filter(
      (a) =>
        a.paymentId === refund.paymentId &&
        a.createdAt <= refund.createdAt &&
        (a.voidedAt === null || a.voidedAt > refund.createdAt) &&
        !(refund.returnId !== null && a.returnId === refund.returnId),
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
  /** Lo cobrado de ese concepto en ese cobro (su parte, si se reparte por sesiones). */
  baseCents: number
  /** El porcentaje que usó; nulo si fue un monto fijo. */
  rateBps: number | null
  commissionCents: number
  occurredAt: Date
  promotionName: string | null
  /** La parte de un tratamiento de varias sesiones (sesión `slice` de `sessions`); nula si es una sola. */
  slice: number | null
  sessions: number | null
  /** El monto fijo por procedimiento que usó, si fue una excepción con monto. */
  fixedCents: number | null
  /** El porcentaje o el monto fue una excepción para el servicio. */
  forService: boolean
  /** Sin ninguna regla aún: da 0 y un pago no lo congela (cuando se fije, se calcula). */
  unruled?: boolean
  /** Ya entró en un pago registrado: su porcentaje e importe quedaron congelados. */
  settled: boolean
  /** Cuándo se pagó (nulo si aún no). */
  paidAt: Date | null
  /** El cobro se anuló después de pagada su comisión: se descuenta del siguiente pago. */
  voidedAfterPaid: boolean
  /** Anulado después de pagado: lo que de su comisión aún debe (0 si ya no debe nada). */
  owedLeftCents: number
  /**
   * Anulado después de pagado y ya sin deuda: cómo se cerró la última parte. `pago`, descontado de
   * un pago; `devuelto`, lo devolvió; `saldado`, la clínica lo dio por saldado. Nulo mientras deba.
   */
  owedClosedBy: "pago" | "devuelto" | "saldado" | null
  /** Lo devuelto o saldado cerró solo lo que quedaba: antes, una parte se descontó de un pago. */
  owedPartlyDiscounted: boolean
}

/** Comisión ya pagada por un cobro que después se anuló. */
export interface CommissionAdjustment {
  applicationId: string
  /** La parte del cobro, si era de un tratamiento de varias sesiones. */
  slice: number | null
  patientId: string
  patientName: string
  description: string
  commissionCents: number
  /** Cuándo se pagó la comisión que ahora se descuenta. */
  paidAt: Date | null
  /** Cuándo fue el cobro anulado: su mes es el del pago que lo pagó, donde se explica lo que cierre la deuda. */
  occurredAt: Date
}

/**
 * Lo que cerró, en un mes, la deuda de sus cobros anulados después de pagados: lo devolvió o la clínica lo
 * dio por saldado (ADR 0157). Explica por qué «Ya pagado» es mayor que la comisión del mes. `cents` es la
 * parte de los cobros de ese mes: una deuda de varios meses se explica en cada uno con la suya.
 */
export interface CommissionDebtClosure {
  settlementId: string
  kind: "devuelto" | "saldado"
  cents: number
  settledAt: Date | null
  /** De lo saldado, el motivo. */
  notes: string | null
}

export type CommissionStatus = "por_pagar" | "pagado" | "sin_cobros" | "por_descontar"

interface FrozenLine {
  line: typeof commissionSettlementLine.$inferSelect
  settledAt: Date | null
  /** La moneda de su pago: la de lo cobrado (lo pagado antes del cambio, la del negocio). */
  currency: string
  /** Un pago, o lo que cerró una deuda: devuelto o saldado (ADR 0157). */
  kind: string
  /** La nota del registro: de lo saldado, su motivo. */
  notes: string | null
  promotionName: string | null
}

/** Líneas ya pagadas del profesional (pagos vigentes), con la fecha del pago. */
async function frozenLines(tx: Db, orgId: string, professionalUserId: string): Promise<FrozenLine[]> {
  const rows = await tx
    .select({
      line: commissionSettlementLine,
      settledAt: commissionSettlement.settledAt,
      currency: commissionSettlement.currency,
      kind: commissionSettlement.kind,
      notes: commissionSettlement.notes,
      promotionName: patientCharge.promotionName,
    })
    .from(commissionSettlementLine)
    .innerJoin(
      commissionSettlement,
      and(
        eq(commissionSettlement.id, commissionSettlementLine.settlementId),
        eq(commissionSettlement.organizationId, orgId),
        isNull(commissionSettlement.voidedAt),
      ),
    )
    .leftJoin(
      patientCharge,
      and(eq(patientCharge.organizationId, orgId), eq(patientCharge.id, commissionSettlementLine.chargeId)),
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

/** La clave de una línea: el cobro y, si se reparte por sesiones, su parte. */
function lineKey(applicationId: string, slice: number | null | undefined): string {
  return slice ? `${applicationId}:${slice}` : applicationId
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
  /**
   * La moneda: la comisión va en la moneda de lo cobrado (ADR 0155), y cada una se mira y se
   * paga aparte. Sin ella, la del negocio, con las otras en `others`.
   */
  currency?: string
}

/**
 * Mes de un profesional en una moneda: cada cobro de lo que atendió, con su comisión.
 *
 * - Lo aún no pagado sale de `commission_live` (la misma cuenta de Reportes y
 *   Argos): la regla del día de la atención, la excepción del servicio si hay, y
 *   la parte de cada sesión en un tratamiento compartido. Solo cuenta mientras
 *   el cobro siga en pie: si se anula antes de pagar, deja de deberse.
 * - Cada moneda va aparte, con lo pagado y lo que se descuenta en esa moneda: un
 *   cobro en dólares se descuenta solo de comisiones en dólares.
 * - Lo ya pagado conserva el porcentaje y el importe con que se pagó, aunque
 *   el porcentaje cambie después.
 * - Un cobro anulado después de pagada su comisión queda como ajuste: se
 *   descuenta del siguiente pago al profesional, sea del mes que sea.
 */
interface MonthPreload {
  rules: Awaited<ReturnType<typeof commissionRulesOf>>
  allLive: LiveCommissionLine[]
  allFrozen: FrozenLine[]
}

/** Lo que un mes de un profesional lee, de todas sus monedas a la vez. */
async function loadMonth(tx: Db, orgId: string, query: MonthlyCommissionsQuery, timezone: string): Promise<MonthPreload> {
  const { start, end } = monthBounds(timezone, query.year, query.month)
  // Un mes ya cerrado dice las reglas con que terminó, no las de hoy (cada línea dice la suya).
  const closed = end.getTime() <= Date.now()
  return {
    rules: await commissionRulesOf(tx, orgId, query.professionalUserId, closed ? new Date(end.getTime() - 1) : undefined),
    allLive: await liveCommissionLines(tx, orgId, { professionalUserId: query.professionalUserId, start, end }),
    allFrozen: await frozenLines(tx, orgId, query.professionalUserId),
  }
}

async function monthView(
  tx: Db,
  orgId: string,
  query: MonthlyCommissionsQuery,
  /** La clínica, si quien llama ya la leyó. */
  known?: OrgLocale,
  /** Si sigue en el equipo, cuando quien llama ya lo sabe (la lista del mes). */
  knownInTeam?: boolean,
  /** Lo ya leído para otra moneda del mismo mes: no se vuelve a leer. */
  preload?: MonthPreload,
) {
  const { inTeam } =
    knownInTeam === undefined
      ? await requireCommissionPerson(tx, orgId, query.professionalUserId)
      : { inTeam: knownInTeam }
  const zone = known ?? (await getOrgLocale(tx, orgId))
  const { timezone, locale } = zone
  const business = zone.currency
  const unit = query.currency ?? business
  const money = orgMoneyOf(zone)
  const { start, end } = monthBounds(timezone, query.year, query.month)
  void money
  const loaded = preload ?? (await loadMonth(tx, orgId, query, timezone))
  const { rules, allLive, allFrozen } = loaded
  const rateBps = rules.rateBps
  const live = allLive.filter((app) => app.currency === unit)
  const frozen = allFrozen.filter((f) => f.currency === unit)
  const allFrozenCobros = allFrozen.filter((f) => f.line.kind === "cobro" && f.line.applicationId)
  const frozenCobros = allFrozenCobros.filter((f) => f.currency === unit)
  // Lo ya descontado de cada cobro anulado después de pagado: un descuento puede repartirse en varios pagos,
  // y lo que queda puede cerrarse porque lo devolvió o porque la clínica lo dio por saldado (ADR 0157).
  const discounted = new Map<string, number>()
  const closedBy = new Map<string, Set<string>>()
  for (const f of frozen)
    if (f.line.kind === "ajuste" && f.line.applicationId) {
      const key = lineKey(f.line.applicationId, f.line.slice)
      discounted.set(key, (discounted.get(key) ?? 0) + f.line.commissionCents)
      closedBy.set(key, (closedBy.get(key) ?? new Set<string>()).add(f.kind))
    }
  // Cobros pagados cuya aplicación ya no está en pie (cualquier mes y moneda).
  const paidIds = allFrozenCobros.map((f) => f.line.applicationId as string)
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
  // La base del mes se redondea una vez, sobre la suma; lo ya pagado quedó con su base.
  const baseValues: MoneyFraction[] = []
  for (const f of frozenCobros) {
    const appId = f.line.applicationId as string
    if (!inMonth(f.line.occurredAt)) continue
    const voidedAfterPaid = !stillLive.has(appId)
    const key = lineKey(appId, f.line.slice)
    const owedLeftCents = voidedAfterPaid ? Math.max(0, f.line.commissionCents - (discounted.get(key) ?? 0)) : 0
    // Cómo se cerró: lo devuelto o lo saldado manda; si además una parte se descontó de un pago, se dice.
    const kinds = closedBy.get(key) ?? new Set<string>()
    const closer = kinds.has("devuelto") ? "devuelto" : kinds.has("saldado") ? "saldado" : "pago"
    lines.push({
      applicationId: appId,
      chargeId: f.line.chargeId ?? "",
      paymentId: f.line.paymentId ?? "",
      patientId: f.line.patientId ?? "",
      patientName: f.line.patientId ? (names.get(f.line.patientId) ?? "") : "",
      description: f.line.description,
      baseCents: f.line.baseCents,
      rateBps: f.line.fixedCents !== null ? null : f.line.rateBps,
      commissionCents: f.line.commissionCents,
      occurredAt: f.line.occurredAt,
      promotionName: f.promotionName ?? null,
      slice: f.line.slice,
      sessions: f.line.sessions,
      fixedCents: f.line.fixedCents,
      forService: f.line.forService,
      settled: true,
      paidAt: f.settledAt,
      voidedAfterPaid,
      owedLeftCents,
      owedClosedBy: voidedAfterPaid && owedLeftCents === 0 && f.line.commissionCents > 0 ? closer : null,
      owedPartlyDiscounted: closer !== "pago" && kinds.has("pago"),
    })
    if (stillLive.has(appId)) baseValues.push({ num: BigInt(f.line.baseCents), den: 1n })
  }
  for (const app of live) {
    baseValues.push(app.value)
    lines.push({
      applicationId: app.applicationId,
      chargeId: app.chargeId,
      paymentId: app.paymentId,
      patientId: app.patientId,
      patientName: names.get(app.patientId) ?? "",
      description: app.description,
      baseCents: roundMoneyValue(app.value),
      rateBps: app.rateBps,
      commissionCents: app.commissionCents,
      occurredAt: app.at,
      promotionName: app.promotionName,
      slice: app.slice,
      sessions: app.slice ? app.sessions : null,
      fixedCents: app.fixedCents,
      forService: app.forService,
      ...(app.hasRule ? {} : { unruled: true }),
      settled: false,
      paidAt: null,
      voidedAfterPaid: false,
      owedLeftCents: 0,
      owedClosedBy: null,
      owedPartlyDiscounted: false,
    })
  }
  lines.sort(
    (a, b) =>
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      (a.applicationId < b.applicationId ? -1 : a.applicationId > b.applicationId ? 1 : (a.slice ?? 0) - (b.slice ?? 0)),
  )
  // Lo que queda por descontar es del profesional, no de un mes: se cuenta una sola vez, de cualquier
  // mes, y cada pago descuenta lo que alcance (el más antiguo primero).
  const adjustments: CommissionAdjustment[] = frozenCobros
    .filter((f) => !stillLive.has(f.line.applicationId as string) && f.line.commissionCents > 0)
    .map((f) => {
      const appId = f.line.applicationId as string
      return {
        applicationId: appId,
        slice: f.line.slice,
        patientId: f.line.patientId ?? "",
        patientName: f.line.patientId ? (names.get(f.line.patientId) ?? "") : "",
        description: f.line.description,
        commissionCents: f.line.commissionCents - (discounted.get(lineKey(appId, f.line.slice)) ?? 0),
        paidAt: f.settledAt,
        occurredAt: f.line.occurredAt,
      }
    })
    .filter((adjustment) => adjustment.commissionCents > 0)
    .sort((a, b) => (a.paidAt?.getTime() ?? 0) - (b.paidAt?.getTime() ?? 0) || (a.applicationId < b.applicationId ? -1 : 1))
  // Lo devuelto o saldado de los cobros anulados de este mes: por sus líneas, no por el mes en que se
  // archivó, así cada mes explica su parte aunque la deuda juntara cobros de varios meses.
  const monthCobroKeys = new Set(
    frozenCobros.filter((f) => inMonth(f.line.occurredAt)).map((f) => lineKey(f.line.applicationId as string, f.line.slice)),
  )
  const closures = new Map<string, CommissionDebtClosure>()
  for (const f of frozen) {
    if (f.line.kind !== "ajuste" || !f.line.applicationId || (f.kind !== "devuelto" && f.kind !== "saldado")) continue
    if (!monthCobroKeys.has(lineKey(f.line.applicationId, f.line.slice))) continue
    const closure = closures.get(f.line.settlementId) ?? {
      settlementId: f.line.settlementId,
      kind: f.kind,
      cents: 0,
      settledAt: f.settledAt,
      notes: f.notes,
    }
    closure.cents += f.line.commissionCents
    closures.set(f.line.settlementId, closure)
  }
  const debtClosures = [...closures.values()].sort(
    (a, b) => (a.settledAt?.getTime() ?? 0) - (b.settledAt?.getTime() ?? 0) || (a.settlementId < b.settlementId ? -1 : 1),
  )
  const counted = lines.filter((line) => !line.voidedAfterPaid)
  const fresh = lines.filter((line) => !line.settled)
  const paid = lines.filter((line) => line.settled)
  const adjustmentCents = sumCents(adjustments.map((a) => ({ amountCents: a.commissionCents })))
  const freshCents = sumCents(fresh.map((l) => ({ amountCents: l.commissionCents })))
  /** Lo que el próximo pago de este mes descuenta: nunca más de lo nuevo del mes. */
  const discountCents = Math.min(freshCents, adjustmentCents)
  const pendingCents = freshCents - discountCents
  // Lo pagado es el dinero que salió por los cobros de este mes: cada pago que congeló alguno, con lo
  // que descontó. Se buscan por sus líneas (no por su mes), así cuentan también los pagos históricos.
  const [settledMonth] = await tx.execute<{ paid: string; discounted: string }>(sql`
    select coalesce(sum(s.commission_cents), 0)::text as paid,
      coalesce(sum((select sum(a.commission_cents) from commission_settlement_line a
        where a.organization_id = s.organization_id and a.settlement_id = s.id and a.kind = 'ajuste' and a.voided_at is null)), 0)::text as discounted
    from commission_settlement s
    where s.organization_id = ${orgId} and s.professional_user_id = ${query.professionalUserId}
      and s.voided_at is null and s.currency = ${unit} and s.kind = 'pago'
      and exists (select 1 from commission_settlement_line l where l.organization_id = s.organization_id and l.settlement_id = s.id
        and l.kind = 'cobro' and l.voided_at is null and l.occurred_at >= ${start.toISOString()}::timestamptz and l.occurred_at < ${end.toISOString()}::timestamptz)`)
  const paidCents = Number(settledMonth?.paid ?? 0)
  const discountedCents = Number(settledMonth?.discounted ?? 0)
  const lastPaidAt = paid.reduce<Date | null>(
    (latest, line) => (line.paidAt && (!latest || line.paidAt > latest) ? line.paidAt : latest),
    null,
  )
  const status: CommissionStatus =
    pendingCents > 0
      ? "por_pagar"
      : discountCents > 0
        ? "por_descontar"
        : paid.length > 0
          ? "pagado"
          : "sin_cobros"
  const professionalNames = await userNames(tx, [query.professionalUserId])
  // El sueldo del mes (decisión 6): sus gastos que se repiten de ese mes, pagados o no. Va aparte de la
  // comisión: se paga en Gastos y la fila de la lista sigue diciendo solo la comisión. Va con la
  // moneda del negocio.
  const salary = unit === business ? await salaryOfMonth(tx, orgId, query.professionalUserId, query, money) : null
  // Las otras monedas con algo del mes, o con algo que descontar: cada una se mira aparte.
  const inMonthCurrencies = [
    ...allLive.map((app) => app.currency),
    ...allFrozenCobros
      .filter((f) => inMonth(f.line.occurredAt) || !stillLive.has(f.line.applicationId as string))
      .map((f) => f.currency),
  ]
  const otherCurrencies = [...new Set(inMonthCurrencies)].filter((c) => c !== unit).sort()
  const owedCents = adjustmentCents - discountCents
  // Lo que este mes no alcanza a descontar se descuenta del pago de otro mes con cobros por pagar en esta
  // moneda: se dice cuál (el más antiguo). Sin ninguno, espera cobros nuevos.
  const toPay = owedCents > 0 ? await otherMonthToPay(tx, orgId, query.professionalUserId, unit, timezone, { start, end }) : null
  // Lo que ese pago alcanza a descontar: si es menos de lo que debe, el resto espera a los siguientes.
  const discountFrom = toPay ? { year: toPay.year, month: toPay.month, cents: Math.min(owedCents, toPay.freshCents) } : null
  return {
    professionalUserId: query.professionalUserId,
    professionalName: professionalNames.get(query.professionalUserId) ?? null,
    /** Sigue en el equipo; si no, lo que ganó se le puede pagar igual. */
    inTeam,
    year: query.year,
    month: query.month,
    currency: unit,
    timezone,
    locale,
    /** Porcentaje general de hoy (cada línea dice el que usó). */
    rateBps,
    /** Desde cuándo vale (nulo si desde siempre) y el anterior. */
    rateSince: rules.since,
    hasRate: rules.hasRate,
    previousRateBps: rules.previousRateBps,
    /** Las excepciones por servicio que siguen en pie. */
    exceptions: rules.exceptions,
    lines,
    adjustments,
    /** Lo cobrado en el mes de lo que atendió (sin lo anulado), en moneda del negocio. */
    baseCents: roundMoneyValue(sumMoneyValues(baseValues)),
    /** Lo que le corresponde por el mes. */
    commissionCents: sumCents(counted.map((l) => ({ amountCents: l.commissionCents }))),
    paidCents,
    /** Lo que falta pagarle hoy: lo nuevo del mes menos lo que se descuenta en este pago. */
    pendingCents,
    /** Lo que queda por descontarle de cobros anulados después de pagados, de cualquier mes. */
    adjustmentCents,
    /** Lo que el próximo pago de este mes descuenta (lo demás queda para otro pago). */
    discountCents,
    /**
     * Lo que le debe a la clínica después de este pago: comisiones ya pagadas de cobros que después
     * se devolvieron, sin cobros nuevos en esta moneda de donde descontarlas. Se descuenta del
     * próximo pago en esta moneda.
     */
    owedCents,
    /**
     * Con algo que deber después de este mes: el mes más antiguo con cobros por pagar de donde se descuenta,
     * y cuánto alcanza a descontar ese pago (`cents`, menos que `owedCents` si no alcanza para todo).
     */
    discountFrom,
    /** Lo que los pagos de este mes ya descontaron de cobros anulados. */
    discountedCents,
    /** Lo devuelto o saldado de los cobros anulados de este mes: por qué «Ya pagado» supera la comisión. */
    debtClosures,
    lastPaidAt,
    status,
    /** Su sueldo del mes, si tiene uno anotado como gasto que se repite (`null` si no). */
    salary,
    /** Otras monedas con algo de este mes o por descontar. */
    otherCurrencies,
  }
}

/**
 * El mes más antiguo, fuera del que se mira, con cobros por pagar de un profesional en una moneda: el
 * pago de donde se descuenta lo que este mes no alcanza (con la regla de `commissionsOwedByMonth`).
 */
async function otherMonthToPay(
  tx: Db,
  orgId: string,
  professionalUserId: string,
  unit: string,
  timezone: string,
  skip: { start: Date; end: Date },
): Promise<{ year: number; month: number; freshCents: number } | null> {
  const [row] = await tx.execute<{ month: string; fresh: string }>(sql`
    select to_char(l.at at time zone ${timezone}, 'YYYY-MM') as month, round(sum(l.own_commission))::text as fresh
    from ${commissionLiveIn(orgId, new Date(Date.UTC(2000, 0, 1)), new Date(), sql`and professional_user_id = ${professionalUserId} and currency = ${unit}`)} l
    where l.has_rule and l.own_commission > 0
      and not (l.at >= ${skip.start.toISOString()}::timestamptz and l.at < ${skip.end.toISOString()}::timestamptz)
    group by 1 order by 1 limit 1`)
  return row
    ? { year: Number(row.month.slice(0, 4)), month: Number(row.month.slice(5, 7)), freshCents: Number(row.fresh) }
    : null
}

export type MonthCommissionsView = Awaited<ReturnType<typeof monthView>>

/** Hay algo que mirar en esa moneda: cobros del mes o algo por descontar. */
function hasActivity(view: MonthCommissionsView): boolean {
  return view.lines.length > 0 || view.adjustmentCents > 0
}

/**
 * El mes de un profesional: la moneda pedida o, sin ella, la del negocio con cada otra moneda
 * en `others` (vacío en una clínica de una sola moneda).
 */
export async function getMonthlyCommissions(
  tx: Db,
  orgId: string,
  query: MonthlyCommissionsQuery,
  known?: OrgLocale,
  knownInTeam?: boolean,
) {
  const zone = known ?? (await getOrgLocale(tx, orgId))
  // Se lee una vez y se arma cada moneda con lo mismo.
  const preload = await loadMonth(tx, orgId, query, zone.timezone)
  const view = await monthView(tx, orgId, query, zone, knownInTeam, preload)
  const others: MonthCommissionsView[] = []
  if (!query.currency)
    for (const currency of view.otherCurrencies) {
      const other = await monthView(tx, orgId, { ...query, currency }, zone, view.inTeam, preload)
      if (hasActivity(other)) others.push(other)
    }
  return { ...view, others }
}

export type MonthlyCommissions = Awaited<ReturnType<typeof getMonthlyCommissions>>

/** Resumen de un mes para listas: sin el detalle por cobro. */
function commissionSummary(view: MonthCommissionsView) {
  return {
    professionalUserId: view.professionalUserId,
    professionalName: view.professionalName,
    inTeam: view.inTeam,
    year: view.year,
    month: view.month,
    currency: view.currency,
    rateBps: view.rateBps,
    /** Ya tiene un porcentaje general, aunque sea 0 (no cobra comisión o solo por servicio). */
    hasRate: view.hasRate,
    /** Cuántos servicios tienen otro porcentaje o un monto fijo. */
    exceptionCount: view.exceptions.length,
    /**
     * Los porcentajes generales que usaron los cobros del mes (sin excepciones ni montos): uno solo
     * se dice; con más de uno, «varios porcentajes». El de hoy puede no ser el que se usó.
     */
    ratesUsed: [
      ...new Set(
        view.lines
          .filter((line) => !line.voidedAfterPaid && !line.forService && line.fixedCents === null && line.rateBps !== null)
          .map((line) => line.rateBps as number),
      ),
    ].sort((a, b) => b - a),
    collections: view.lines.filter((line) => !line.voidedAfterPaid).length,
    baseCents: view.baseCents,
    commissionCents: view.commissionCents,
    paidCents: view.paidCents,
    pendingCents: view.pendingCents,
    /** Lo que el próximo pago de este mes descuenta de comisiones ya pagadas de cobros anulados. */
    discountCents: view.discountCents,
    owedCents: view.owedCents,
    /** De qué pago se descuenta lo que debe después de este mes (el mismo dato del detalle). */
    discountFrom: view.discountFrom,
    lastPaidAt: view.lastPaidAt,
    status: view.status,
  }
}

/** El resumen de la moneda del negocio, con el de cada otra moneda. */
function summaryWithOthers(view: MonthlyCommissions) {
  return { ...commissionSummary(view), others: view.others.map(commissionSummary) }
}

export type CommissionSummary = ReturnType<typeof summaryWithOthers>

/**
 * El mes de toda la clínica: una fila por profesional con porcentaje fijado,
 * con cobros de lo que atendió ese mes o con algo que le debe a la clínica. Cada
 * fila va en la moneda del negocio, con las otras monedas en `others`.
 */
export async function listMonthCommissions(
  tx: Db,
  orgId: string,
  query: { year: number; month: number },
): Promise<CommissionSummary[]> {
  const zone = await getOrgLocale(tx, orgId)
  const { start, end } = monthBounds(zone.timezone, query.year, query.month)
  const withRate = await tx
    .selectDistinct({ userId: commissionRate.professionalUserId })
    .from(commissionRate)
    .where(and(eq(commissionRate.organizationId, orgId), isNull(commissionRate.serviceId)))
  // Quien tiene algo nuevo del mes (también la sesión de un tratamiento que empezó otro) o algo ya pagado.
  const active = await tx.execute<{ userId: string }>(sql`
    select distinct l.professional_user_id as "userId" from ${commissionLiveIn(orgId, start, end)} l
    union
    select distinct s.professional_user_id from commission_settlement_line l
    join commission_settlement s on s.organization_id = l.organization_id and s.id = l.settlement_id and s.voided_at is null
    where l.organization_id = ${orgId} and l.kind = 'cobro' and l.voided_at is null
      and l.occurred_at >= ${start.toISOString()}::timestamptz and l.occurred_at < ${end.toISOString()}::timestamptz`)
  // Quien tiene comisiones ya pagadas de cobros que después se devolvieron: puede deberle a la clínica.
  const owing = await tx.execute<{ userId: string }>(sql`
    select distinct s.professional_user_id as "userId" from commission_settlement_line l
    join commission_settlement s on s.organization_id = l.organization_id and s.id = l.settlement_id and s.voided_at is null
    join patient_payment_application a on a.organization_id = l.organization_id and a.id = l.application_id
    join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id
    join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id
    where l.organization_id = ${orgId} and l.kind = 'cobro' and l.voided_at is null and l.commission_cents > 0
      and (a.voided_at is not null or p.voided_at is not null or c.voided_at is not null)`)
  const candidates = [
    ...new Set([...withRate.map((r) => r.userId), ...[...active].map((a) => a.userId), ...[...owing].map((o) => o.userId)]),
  ]
  const team = new Set(
    candidates.length
      ? (
          await tx
            .select({ userId: member.userId })
            .from(member)
            .where(and(eq(member.organizationId, orgId), inArray(member.userId, candidates)))
        ).map((row) => row.userId)
      : [],
  )
  // Quien sigue en el equipo, y quien ya no está pero tiene cobros de ese mes (sin cobros del mes
  // no puede tener nada por pagar en él): lo que le corresponde se le paga igual.
  const exMembers = new Set(
    [...[...active].map((a) => a.userId), ...[...owing].map((o) => o.userId)].filter((id) => !team.has(id)),
  )
  const rows: CommissionSummary[] = []
  for (const userId of candidates) {
    if (!team.has(userId) && !exMembers.has(userId)) continue
    const view = await getMonthlyCommissions(tx, orgId, { ...query, professionalUserId: userId }, zone, team.has(userId))
    // Quien salió sin comisión en el mes (por ejemplo, sin porcentaje) ni nada que deber no se lista.
    const shows = (v: MonthCommissionsView) =>
      v.commissionCents > 0 || v.paidCents > 0 || v.pendingCents !== 0 || v.owedCents > 0
    // Quien no cobra comisión (porcentaje 0 y ningún servicio aparte) no tiene nada que pagar en el mes:
    // solo aparece si queda algo de antes, pagado o por descontar.
    const noCommission = view.hasRate && view.rateBps === 0 && view.exceptions.length === 0
    if ((view.inTeam && !noCommission) || shows(view) || view.others.some(shows)) rows.push(summaryWithOthers(view))
  }
  return rows.sort(
    (a, b) => b.commissionCents - a.commissionCents || (a.professionalName ?? "").localeCompare(b.professionalName ?? ""),
  )
}

/**
 * Lo cobrado de tratamientos de varias sesiones (o adelantado) cuyas sesiones aún nadie hizo: la
 * comisión de cada sesión es de quien la haga, así que hoy no es de nadie. En la moneda de lo
 * cobrado. `pendingCents`, de lo que sigue por hacer; `stoppedCents`, de tratamientos cancelados o
 * reemplazados, que ya no tendrán esas sesiones: no se le paga a nadie. Un tratamiento realizado
 * con menos sesiones le da lo que sobra a la última.
 */
export async function unassignedCommissionSessions(
  tx: Db,
  orgId: string,
): Promise<Array<{ currency: string; pendingCents: number; stoppedCents: number }>> {
  const rows = await tx.execute<{ currency: string; pending: string | null; stopped: string | null }>(sql`
    with apps as (
      select a.amount_cents::numeric as cents, c.currency::text as currency, c.commission_sessions as n, c.plan_item_id,
        ti.status
      from patient_payment_application a
      join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id and p.voided_at is null
      join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null
        and c.commission_sessions is not null and c.plan_item_id is not null
      left join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id
      left join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id
      left join treatment_plan_item ti on ti.organization_id = c.organization_id and ti.id = c.plan_item_id
      where a.organization_id = ${orgId} and a.voided_at is null
        and (c.encounter_procedure_id is null
          or (ep.voided_at is null and e.status = 'finalizada' and e.voided_at is null))
    ), done as (
      select ep.plan_item_id, count(distinct e.id) as k
      from encounter_procedure ep
      join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id
      where ep.organization_id = ${orgId} and ep.voided_at is null and e.status = 'finalizada' and e.voided_at is null
        and ep.plan_item_id in (select plan_item_id from apps)
      group by ep.plan_item_id
    ), left_over as (
      select apps.currency, apps.status,
        apps.cents * (apps.n - least(coalesce(done.k, 0), apps.n)) / apps.n as cents
      from apps left join done on done.plan_item_id = apps.plan_item_id
      where coalesce(apps.status, '') <> 'realizado'
    )
    select currency,
      round(sum(cents) filter (where coalesce(status, '') not in ('cancelado', 'reemplazado')))::text as pending,
      round(sum(cents) filter (where status in ('cancelado', 'reemplazado')))::text as stopped
    from left_over
    group by currency
    order by currency`)
  return [...rows]
    .map((row) => ({ currency: row.currency, pendingCents: Number(row.pending ?? 0), stoppedCents: Number(row.stopped ?? 0) }))
    .filter((row) => row.pendingCents > 0 || row.stoppedCents > 0)
}

/**
 * Lo propio de un profesional: el mes pedido con su detalle y los meses
 * anteriores resumidos, con la fecha en que se le pagó cada uno.
 */
export async function getMyCommissions(
  tx: Db,
  orgId: string,
  userId: string,
  query: { year: number; month: number },
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
    })
    if (view.lines.length > 0 || view.others.some((other) => other.lines.length > 0)) previous.push(summaryWithOthers(view))
  }
  return { ...current, previous }
}

export interface PayMonthCommissionInput {
  professionalUserId: string
  year: number
  month: number
  /** Sede a la que se imputa el gasto de Personal. */
  branchId: string
  /** La moneda que se paga (cada una aparte); sin ella, la del negocio. */
  currency?: string
  notes?: string | null
  /** Importe que la pantalla mostró al confirmar: si ya no es ese, no se paga otra cifra. */
  expectedCents?: number
  /**
   * Se pagó con el efectivo de la caja de esa sede: sale de la caja como cualquier
   * gasto, para que el cierre cuadre. Sin esto queda «fuera de la caja».
   */
  fromCash?: boolean
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
  // La sede llega en el cuerpo: si no existe, se dice junto a ella.
  const branchRow = await requireBranch(tx, orgId, input.branchId).catch((error: unknown) => {
    if (error instanceof ServiceError && error.code === "NOT_FOUND")
      throw new ServiceError("NOT_FOUND", 404, error.message, { branchId: error.message })
    throw error
  })
  const view = await monthView(tx, orgId, input)
  // Lo que aún no tiene ninguna regla no se congela: cuando se fije, se calcula con ella.
  const fresh = view.lines.filter((line) => !line.settled && !line.unruled)
  // Lo que hay que descontar no se paga solo: viaja con los cobros de un mes (de este o de otro).
  // Sin nada que pagar ni descontar (por ejemplo, sin porcentaje fijado) no se registra nada: congelar
  // esos cobros a 0 % los dejaría sin comisión aunque después se fije el porcentaje.
  if (fresh.length === 0 || (view.pendingCents === 0 && view.discountCents === 0))
    throw conflict("COMMISSION_NOTHING_TO_PAY", "No hay nada por pagar de ese mes")
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
      // Un solo porcentaje si todo el pago lo usó; si mezcla (un cambio, una excepción, un monto), nulo.
      rateBps: new Set(fresh.map((l) => l.rateBps)).size === 1 ? (fresh[0]?.rateBps ?? null) : null,
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
        // Una parte por sesión tiene su clave; lo de una sola parte, la de siempre.
        sourceKey: line.slice ? `app:${line.applicationId}:${line.slice}` : `app:${line.applicationId}`,
        applicationId: line.applicationId,
        chargeId: line.chargeId,
        paymentId: line.paymentId,
        patientId: line.patientId,
        description: line.description,
        baseCents: line.baseCents,
        commissionCents: line.commissionCents,
        rateBps: line.rateBps,
        slice: line.slice,
        sessions: line.sessions,
        fixedCents: line.fixedCents,
        forService: line.forService,
        occurredAt: line.occurredAt,
      })
    }
    // El descuento de este pago, del cobro anulado más antiguo al más nuevo; el último puede ir en parte.
    let left = view.discountCents
    for (const adjustment of view.adjustments) {
      if (left <= 0) break
      const cents = Math.min(left, adjustment.commissionCents)
      left -= cents
      await tx.insert(commissionSettlementLine).values({
        organizationId: orgId,
        settlementId: settlement.id,
        kind: "ajuste",
        sourceKey: `adj:${lineKey(adjustment.applicationId, adjustment.slice)}:${settlement.id}`,
        applicationId: adjustment.applicationId,
        slice: adjustment.slice,
        patientId: adjustment.patientId || null,
        description: adjustment.description,
        baseCents: 0,
        commissionCents: cents,
        occurredAt: paidAt,
      })
    }
  } catch (e) {
    // La unicidad por fuente respalda al bloqueo: un cobro nunca entra dos veces. Los descuentos sí
    // pueden ir en partes, y los ordena el turno por profesional (también al anular).
    if (isUniqueViolation(e))
      throw conflict("COMMISSION_ALREADY_PAID", "Parte de esos cobros ya está en otro pago registrado")
    throw e
  }
  const names = await userNames(tx, [input.professionalUserId])
  const professionalName = names.get(input.professionalUserId) ?? ""
  const monthLabel = new Intl.DateTimeFormat(view.locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(input.year, input.month - 1, 15)),
  )
  await audit(tx, orgId, actorUserId, "commission_settlement", settlement.id, "finance.commission_paid")
  // Si el descuento cubre todo lo del mes, no sale dinero: queda el registro, sin gasto, y se le avisa.
  if (view.pendingCents === 0) {
    if (view.inTeam)
      await createWorkspaceNotification(tx, orgId, {
        userId: input.professionalUserId,
        dedupeKey: `commission-paid:${settlement.id}`,
        title: "Se registró un descuento en tu comisión",
        body: `${monthLabel}: ${formatMoney(view.discountCents, view.currency, view.locale)} de comisiones ya pagadas de cobros que después se anularon.`,
        href: `/commissions?year=${input.year}&month=${input.month}`,
        permission: "commissions.read",
        actorUserId,
      })
    return { settlement, expense: null }
  }
  // Como un gasto de la caja (`createExpense`): la abre si hace falta y no la deja en negativo.
  const shift = input.fromCash
    ? await ensureOpenShift(tx, orgId, actorUserId, branchRow.id, view.currency)
    : null
  // En otra moneda, el gasto guarda su valor en la del negocio con el cambio de hoy, como cualquier gasto.
  const frozen = frozenExpense(await lockOrgMoney(tx, orgId), {
    amountCents: view.pendingCents,
    unit: view.currency,
    isPurchase: false,
  })
  const [paidExpense] = await tx
    .insert(expense)
    .values({
      organizationId: orgId,
      branchId: branchRow.id,
      shiftId: shift?.id ?? null,
      concept: `Comisión de ${monthLabel} — ${professionalName}`.slice(0, 500),
      amountCents: view.pendingCents,
      currency: view.currency,
      ...(frozen ? { exchangeRate: frozen.exchangeRate, businessCents: frozen.businessCents } : {}),
      category: COMMISSION_EXPENSE_CATEGORY,
      spentAt: paidAt,
      receiptKind: "ninguno",
      createdBy: actorUserId,
    })
    .returning()
  if (!paidExpense) throw new ServiceError("INTERNAL", 409, "No se pudo registrar el gasto")
  if (shift)
    await recordCashEgreso(tx, orgId, actorUserId, shift.id, {
      kind: "gasto",
      amountCents: view.pendingCents,
      currency: view.currency,
      // Caja ve los movimientos: sin a quién se pagó, como la fila de Gastos que ve caja.
      concept: COMMISSION_PAYMENTS_CONCEPT,
      expenseId: paidExpense.id,
      amountField: "fromCash",
    })
  if (shift) await notifyCash(tx, orgId)
  const [paid] = await tx
    .update(commissionSettlement)
    .set({ expenseId: paidExpense.id, updatedAt: paidAt })
    .where(and(eq(commissionSettlement.id, settlement.id), eq(commissionSettlement.organizationId, orgId)))
    .returning()
  await audit(tx, orgId, actorUserId, "expense", paidExpense.id, "finance.expense_created")
  // Quien ya no está en el equipo no entra a la clínica: no se le deja un aviso que no verá.
  if (view.inTeam)
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

/** Lo que se escribe al cerrar una deuda: el motivo de darla por saldada es corto (ADR 0157). */
export const COMMISSION_FORGIVE_REASON_MAX = 200

export interface SettleCommissionDebtInput {
  professionalUserId: string
  /**
   * El mes desde donde se mira: solo sirve para leer la deuda, que es del profesional y de cualquier mes. El
   * registro se archiva en el mes de los cobros anulados que la originaron, mire desde donde se mire.
   */
  year: number
  month: number
  /** La moneda de la deuda (cada una aparte); sin ella, la del negocio. */
  currency?: string
  /** `devuelto`: el profesional entregó ese dinero. `saldado`: la clínica lo perdona, sin mover dinero. */
  kind: "devuelto" | "saldado"
  /** Lo devuelto: su medio, UN/CEFACT 4461 (10 efectivo, 30 transferencia, 48 tarjeta). */
  methodTypeCode?: CommissionReturnTypeCode
  /** En efectivo: la sede de la caja donde entra. */
  branchId?: string
  /** Saldado: el motivo, obligatorio. Devuelto: una nota opcional. */
  notes?: string | null
  /** Lo que la pantalla mostró al confirmar: si ya no es eso, no se registra otra cifra. */
  expectedCents?: number
}

/**
 * Cierra lo que un profesional le debe a la clínica en una moneda (comisiones ya pagadas de cobros que
 * después se anularon), en un solo paso y sin esperar a descontarlo de un pago (ADR 0157):
 *
 * - `devuelto`: lo devolvió. En efectivo entra a la caja de la sede como «Devolución de comisiones»,
 *   sin su nombre (caja no ve a quién se le paga cada comisión); por transferencia o tarjeta no toca
 *   la caja.
 * - `saldado`: la clínica lo perdona, con su motivo. No mueve dinero.
 *
 * Las dos dejan una liquidación de su tipo con una línea `ajuste` por cobro anulado: todas las cuentas
 * (Finanzas, Mis honorarios, Reportes) ya restan los ajustes, así que la deuda queda en cero en todas a
 * la vez. Quién y cuándo quedan en la liquidación y en la auditoría. Se anula como un pago.
 */
export async function settleCommissionDebt(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: SettleCommissionDebtInput,
) {
  // El mismo turno que pagar y anular: un pago simultáneo no descuenta lo que esto ya cerró.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`commission:${orgId}:${input.professionalUserId}`}, 0))`,
  )
  if (input.kind !== "devuelto" && input.kind !== "saldado") throw invalidField("kind", "Elige qué pasó con lo que debe.")
  const notes = input.notes?.trim() ?? ""
  if (input.kind === "saldado") {
    if (!notes) throw invalidField("notes", "Escribe el motivo.")
    if (notes.length > COMMISSION_FORGIVE_REASON_MAX)
      throw invalidField("notes", `Escribe el motivo en ${COMMISSION_FORGIVE_REASON_MAX} caracteres como máximo.`)
  } else if (notes.length > 2000) throw invalidField("notes", "Escribe la nota en 2000 caracteres como máximo.")
  const method = input.kind === "devuelto" ? input.methodTypeCode : undefined
  if (input.kind === "devuelto" && !(COMMISSION_RETURN_TYPE_CODES as readonly string[]).includes(method ?? ""))
    throw invalidField("methodTypeCode", "Elige cómo lo devolvió.")
  const inCash = method === "10"
  const view = await monthView(tx, orgId, input)
  if (view.adjustmentCents <= 0)
    throw conflict("COMMISSION_NOTHING_OWED", "No debe nada en esa moneda: no hay nada que registrar")
  if (input.expectedCents !== undefined && input.expectedCents !== view.adjustmentCents)
    throw conflict(
      "COMMISSION_AMOUNT_CHANGED",
      "Lo que debe cambió mientras lo revisabas: vuelve a mirarlo antes de registrarlo",
    )
  const at = new Date()
  // Se archiva en el mes de los cobros anulados que originaron la deuda (el del pago que los pagó), no en
  // el que se tenía abierto: ahí se explica por qué «Ya pagado» supera la comisión. Si la deuda junta
  // cobros de varios meses, en el del más reciente; cada mes igual explica su parte (`debtClosures`).
  const period = debtPeriod(view.adjustments, view.timezone)
  // En efectivo, entra a la caja de la sede en su moneda: la abre si hace falta, como un cobro.
  let movementId: string | null = null
  if (inCash) {
    if (!input.branchId) throw invalidField("branchId", "Elige la sede de la caja.")
    const branchRow = await requireBranch(tx, orgId, input.branchId).catch((error: unknown) => {
      if (error instanceof ServiceError && error.code === "NOT_FOUND")
        throw new ServiceError("NOT_FOUND", 404, error.message, { branchId: error.message })
      throw error
    })
    const shift = await ensureOpenShift(tx, orgId, actorUserId, branchRow.id, view.currency)
    requireOpenShift(await lockShift(tx, orgId, shift.id))
    // Vuelve lo que salió como un gasto (el pago de la comisión): `gasto` de entrada, que el cierre resta
    // de los gastos, como la compensación de un gasto anulado. Sin a quién: caja lo ve.
    const [movement] = await tx
      .insert(cashMovement)
      .values({
        organizationId: orgId,
        shiftId: shift.id,
        direction: "ingreso",
        kind: "gasto",
        amountCents: assertCents(view.adjustmentCents),
        currency: view.currency,
        method: null,
        methodTypeCode: "10",
        concept: COMMISSION_RETURNS_CONCEPT,
        createdBy: actorUserId,
      })
      .returning()
    if (!movement) throw new ServiceError("INTERNAL", 409, "No se pudo registrar el ingreso a la caja")
    movementId = movement.id
    await audit(tx, orgId, actorUserId, "cash_movement", movement.id, "cash.commission_returned")
  }
  const [settlement] = await tx
    .insert(commissionSettlement)
    .values({
      organizationId: orgId,
      professionalUserId: input.professionalUserId,
      periodYear: period.year,
      periodMonth: period.month,
      base: "cobrado",
      currency: view.currency,
      rateBps: null,
      baseCents: 0,
      commissionCents: view.adjustmentCents,
      status: "liquidada",
      kind: input.kind,
      methodTypeCode: method ?? null,
      cashMovementId: movementId,
      notes: notes ? notes.slice(0, 2000) : null,
      settledBy: actorUserId,
      settledAt: at,
    })
    .returning()
  if (!settlement) throw new ServiceError("INTERNAL", 409, "No se pudo registrar")
  try {
    for (const adjustment of view.adjustments)
      await tx.insert(commissionSettlementLine).values({
        organizationId: orgId,
        settlementId: settlement.id,
        kind: "ajuste",
        sourceKey: `adj:${lineKey(adjustment.applicationId, adjustment.slice)}:${settlement.id}`,
        applicationId: adjustment.applicationId,
        slice: adjustment.slice,
        patientId: adjustment.patientId || null,
        description: adjustment.description,
        baseCents: 0,
        commissionCents: adjustment.commissionCents,
        occurredAt: at,
      })
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("COMMISSION_AMOUNT_CHANGED", "Eso ya se registró: vuelve a mirarlo")
    throw e
  }
  await audit(
    tx,
    orgId,
    actorUserId,
    "commission_settlement",
    settlement.id,
    input.kind === "devuelto" ? "finance.commission_debt_returned" : "finance.commission_debt_forgiven",
    { cents: view.adjustmentCents, currency: view.currency, ...(method ? { methodTypeCode: method } : {}) },
  )
  if (inCash) await notifyCash(tx, orgId)
  const amount = formatMoney(view.adjustmentCents, view.currency, view.locale)
  // Como al pagarle: se le avisa, salvo a quien ya no está en el equipo.
  if (view.inTeam)
    await createWorkspaceNotification(tx, orgId, {
      userId: input.professionalUserId,
      dedupeKey: `commission-debt:${settlement.id}`,
      title: input.kind === "devuelto" ? "Se registró lo que devolviste" : "Se dio por saldado lo que debías",
      body:
        input.kind === "devuelto"
          ? `${amount} de comisiones ya pagadas de cobros que después se anularon. Ya no debes nada en esa moneda.`
          : `${amount} de comisiones ya pagadas de cobros que después se anularon. Ya no debes nada en esa moneda. Motivo: ${notes}`.slice(0, 500),
      href: `/commissions?year=${period.year}&month=${period.month}`,
      permission: "commissions.read",
      actorUserId,
    })
  return { settlement, movementId }
}

/** El mes de los cobros anulados de una deuda, en la zona de la clínica: el del más reciente. */
function debtPeriod(adjustments: CommissionAdjustment[], timezone: string): { year: number; month: number } {
  const latest = adjustments.reduce<Date | null>(
    (last, adjustment) => (!last || adjustment.occurredAt > last ? adjustment.occurredAt : last),
    null,
  )
  const key = dayKeyIn(latest ?? new Date(), timezone)
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) }
}

/**
 * Revierte el efectivo que entró al registrar una devolución que se anula. Con la caja abierta se anula
 * el movimiento; cerrada (no se toca), sale lo mismo en la caja de hoy como «Compensación por
 * anulación», como al anular un cobro. Bloquea la caja antes que su fila, en el orden de siempre.
 */
async function reverseCommissionReturn(tx: Db, orgId: string, actorUserId: string, movementId: string, voidReason: string) {
  const [movement] = await tx
    .select()
    .from(cashMovement)
    .where(and(eq(cashMovement.organizationId, orgId), eq(cashMovement.id, movementId)))
  if (!movement || movement.voidedAt) return
  const [where] = await tx
    .select({ branchId: cashShift.branchId, currency: cashShift.currency })
    .from(cashShift)
    .where(and(eq(cashShift.organizationId, orgId), eq(cashShift.id, movement.shiftId)))
  if (where) await lockCashWindows(tx, orgId, [{ branchId: where.branchId, unit: where.currency }])
  const shift = await lockShift(tx, orgId, movement.shiftId)
  if (shift.status === "abierta") {
    await tx
      .update(cashMovement)
      .set({ voidedAt: new Date(), voidedBy: actorUserId, voidReason: reason(voidReason) })
      .where(and(eq(cashMovement.organizationId, orgId), eq(cashMovement.id, movement.id)))
    await audit(tx, orgId, actorUserId, "cash_movement", movement.id, "cash.movement_voided")
  } else {
    const today = await ensureOpenShift(tx, orgId, actorUserId, shift.branchId, movement.currency)
    await recordCashEgreso(tx, orgId, actorUserId, today.id, {
      kind: "gasto",
      amountCents: movement.amountCents,
      currency: movement.currency,
      methodTypeCode: movement.methodTypeCode,
      concept: "Compensación por anulación",
      // Lo cerrado no se reescribe: si ese efectivo ya no está, lo dirá el arqueo.
      allowNegative: true,
    })
  }
  await notifyCash(tx, orgId)
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
    ...rows.map((r) => r.settledBy).filter((id): id is string => !!id),
  ])
  return rows.map((r) => ({
    ...r,
    professionalName: names.get(r.professionalUserId) ?? null,
    /** Quién lo registró: de lo que se dio por saldado, quién lo decidió. */
    settledByName: r.settledBy ? (names.get(r.settledBy) ?? null) : null,
    voidedByName: r.voidedBy ? (names.get(r.voidedBy) ?? null) : null,
  }))
}

/** La comisión ya pagada de un cobro, por profesional y moneda: lo que quedaría por descontar si se anula. */
export interface TicketPaidCommission {
  professionalUserId: string
  professionalName: string | null
  currency: string
  cents: number
}

/**
 * Las comisiones ya pagadas de los cobros de un ticket que siguen en pie: si el ticket se anula, el
 * profesional las debe y se descuentan de su próximo pago (ADR 0157). Para el aviso de «Anular ticket»;
 * quién puede ver nombres e importes lo decide quien llama (solo administra comisiones).
 */
export async function paidCommissionsOfTicket(tx: Db, orgId: string, ticketId: string): Promise<TicketPaidCommission[]> {
  const rows = await tx.execute<{ userId: string; currency: string; cents: string }>(sql`
    select s.professional_user_id as "userId", s.currency::text as currency, sum(l.commission_cents)::text as cents
    from commission_settlement_line l
    join commission_settlement s on s.organization_id = l.organization_id and s.id = l.settlement_id
      and s.voided_at is null and s.kind = 'pago'
    join patient_payment_application a on a.organization_id = l.organization_id and a.id = l.application_id
      and a.voided_at is null
    join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id
      and p.voided_at is null
      -- Lo mismo que deshace anularlo: lo que el ticket aplicó (también con saldo a favor de otro) y lo que
      -- sus pagos cubrieron en otros tickets.
      and (a.ticket_id = ${ticketId} or p.ticket_id = ${ticketId})
    join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null
    where l.organization_id = ${orgId} and l.kind = 'cobro' and l.voided_at is null and l.commission_cents > 0
    group by 1, 2
    order by 1, 2`)
  const names = await userNames(tx, [...new Set([...rows].map((row) => row.userId))])
  return [...rows].map((row) => ({
    professionalUserId: row.userId,
    professionalName: names.get(row.userId) ?? null,
    currency: row.currency,
    cents: Number(row.cents),
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
  // El mismo turno que el pago: anular mientras se registra otro pago del profesional no debe dejar
  // un descuento hecho sobre un pago que se está anulando.
  const [owner] = await tx
    .select({ professionalUserId: commissionSettlement.professionalUserId })
    .from(commissionSettlement)
    .where(and(eq(commissionSettlement.id, settlementId), eq(commissionSettlement.organizationId, orgId)))
  if (owner)
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`commission:${orgId}:${owner.professionalUserId}`}, 0))`,
    )
  const [current] = await tx
    .select()
    .from(commissionSettlement)
    .where(
      and(eq(commissionSettlement.id, settlementId), eq(commissionSettlement.organizationId, orgId)),
    )
    .for("update")
  if (!current) throw notFound("Pago de comisión")
  if (current.voidedAt) throw conflict("SETTLEMENT_VOIDED", "Ese pago ya está anulado")
  const voidReason = input.reason?.trim() ?? ""
  if (!voidReason) throw invalidField("reason", "Indica el motivo de la anulación.")
  if (voidReason.length > 2000)
    throw invalidField("reason", "Escribe el motivo en 2000 caracteres como máximo.")
  // Si otro pago ya descontó un cobro de este (porque después se anuló), anular este primero
  // dejaría ese descuento sin el pago que lo respaldaba: se anula antes el que descontó.
  const [later] = await tx.execute<{ settledAt: Date | null }>(sql`
    select s2.settled_at as "settledAt"
    from commission_settlement_line l
    join commission_settlement_line a on a.organization_id = l.organization_id and a.kind = 'ajuste'
      and a.application_id = l.application_id and (l.slice is null or a.slice is null or a.slice = l.slice)
      and a.voided_at is null and a.settlement_id <> l.settlement_id
    join commission_settlement s2 on s2.organization_id = a.organization_id and s2.id = a.settlement_id and s2.voided_at is null
    where l.organization_id = ${orgId} and l.settlement_id = ${settlementId} and l.kind = 'cobro' and l.voided_at is null
    order by s2.settled_at desc limit 1`)
  if (later)
    throw conflict(
      "COMMISSION_DISCOUNTED_LATER",
      "Después se descontó, se devolvió o se dio por saldado un cobro de este pago: anula primero ese registro y después este",
    )
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
  // El gasto del pago se anula con él (misma transacción); lo devuelto en efectivo sale de la caja.
  if (current.expenseId)
    await voidExpense(tx, orgId, actorUserId, current.expenseId, { reason: input.reason }, { fromCommission: true })
  if (current.cashMovementId) await reverseCommissionReturn(tx, orgId, actorUserId, current.cashMovementId, voidReason)
  const debt = current.kind === "devuelto" || current.kind === "saldado"
  await audit(
    tx,
    orgId,
    actorUserId,
    "commission_settlement",
    settlementId,
    debt ? "finance.commission_debt_voided" : "finance.commission_payment_voided",
  )
  // Al profesional se le avisa, como al pagarle: si no, ve su mes «por pagar» otra vez sin saber por qué.
  const [inTeam] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, current.professionalUserId)))
  if (inTeam && current.periodYear && current.periodMonth) {
    const { locale } = await getOrgLocale(tx, orgId)
    const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(Date.UTC(current.periodYear, current.periodMonth - 1, 15)),
    )
    await createWorkspaceNotification(tx, orgId, {
      userId: current.professionalUserId,
      dedupeKey: `commission-voided:${settlementId}`,
      title:
        current.kind === "devuelto"
          ? "Se anuló el registro de lo que devolviste"
          : current.kind === "saldado"
            ? "Se anuló lo que se dio por saldado"
            : current.commissionCents > 0
              ? "Se anuló un pago de tu comisión"
              : "Se anuló un descuento de tu comisión",
      body: `${monthLabel}: ${formatMoney(current.commissionCents, current.currency, locale)}. Motivo: ${voidReason}`.slice(0, 500),
      href: `/commissions?year=${current.periodYear}&month=${current.periodMonth}`,
      permission: "commissions.read",
      actorUserId,
    })
  }
  return row
}

// --- Lo cobrado de un tramo (Reportes) -----------------------------------------------------

/**
 * Lo cobrado por profesional en un tramo: solo lo atendido, con la regla de
 * «Lo cobrado por tratamiento» (ADR 0068): lo cobrado cuenta el día del cobro
 * y lo devuelto se resta el día de la devolución. Comisiones cuenta lo que
 * sigue en pie: tras una devolución de otro mes, lo que queda pasa al mes de la
 * devolución. Por eso coinciden en el mismo mes y en la suma de los meses, no
 * mes a mes. Lo usan Finanzas y el Resumen de Reportes.
 */
export async function collectedByProfessional(
  tx: Db,
  orgId: string,
  range: { start: Date; end: Date; branchId?: string },
  /** La clínica, que quien llama ya leyó (`ReportScope.money`). */
  money: OrgMoney,
): Promise<
  Array<{ professionalUserId: string; name: string | null; currency: string; cobradoCents: number }>
> {
  // Como «Lo cobrado por tratamiento»: lo cobrado cuenta el día del cobro y lo
  // devuelto se resta el día de la devolución. Así un mes cerrado no cambia y la
  // suma de los meses es lo que de verdad quedó cobrado.
  const apps = await collectedApplications(tx, orgId, range.start, range.end, money, {
    branchId: range.branchId,
    returnsApart: true,
  })
  const totals = await paymentTotalsOf(
    tx,
    orgId,
    apps.map((a) => a.paymentId),
  )
  for (const app of apps) if (!totals.has(app.paymentId)) totals.set(app.paymentId, app.paymentCents)
  const refundByApp = await allocateRefunds(tx, orgId, apps, totals, range.start, range.end)
  // Lo neto de cada aplicación, con el valor de su pago: se redondea una vez, sobre la suma de cada uno.
  const profSums = new Map<string, Array<MoneyFraction | null>>()
  for (const a of apps) {
    const net = a.appCents - Math.min(a.appCents, refundByApp.get(a.appId) ?? 0)
    const value = orgPartValue(
      net,
      {
        amountCents: a.paymentCents,
        businessCents: a.paymentValueCents,
        currency: a.paymentCurrency,
      },
      money,
    )
    const list = profSums.get(a.professionalUserId) ?? []
    list.push(value)
    profSums.set(a.professionalUserId, list)
  }
  for (const returned of await returnedApplications(tx, orgId, range, money)) {
    const list = profSums.get(returned.professionalUserId) ?? []
    list.push(returned.value)
    profSums.set(returned.professionalUserId, list)
  }
  const names = await userNames(tx, [...profSums.keys()])
  return [...profSums].map(([professionalUserId, values]) => ({
    professionalUserId,
    name: names.get(professionalUserId) ?? null,
    currency: money.currency,
    cobradoCents: roundMoneyValue(sumMoneyValues(values)),
  }))
}

/**
 * Lo devuelto en el tramo de lo cobrado por lo que atendió cada profesional,
 * con signo negativo: de cada aplicación que anuló una devolución, la parte que
 * no pasó a su reemplazo. Con el valor congelado de su pago.
 */
async function returnedApplications(
  tx: Db,
  orgId: string,
  range: { start: Date; end: Date; branchId?: string },
  money: OrgMoney,
): Promise<Array<{ professionalUserId: string; value: MoneyFraction | null }>> {
  const kept = sql<number>`coalesce((select sum(n.amount_cents) from patient_payment_application n
    where n.organization_id = ${patientPaymentApplication.organizationId} and n.replaces_application_id = ${patientPaymentApplication.id}), 0)::int`
  const filters = [
    eq(patientPaymentApplication.organizationId, orgId),
    isNotNull(patientPaymentApplication.returnId),
    gte(patientPaymentApplication.voidedAt, range.start),
    lt(patientPaymentApplication.voidedAt, range.end),
    or(isNull(patientPayment.voidedAt), gte(patientPayment.voidedAt, range.end))!,
    isNull(encounterProcedure.voidedAt),
    eq(encounter.status, "finalizada"),
    isNull(encounter.voidedAt),
  ]
  if (range.branchId) filters.push(eq(patientPayment.branchId, range.branchId))
  const rows = await tx
    .select({
      appCents: patientPaymentApplication.amountCents,
      kept,
      payment: patientPayment,
      professionalUserId: encounter.professionalUserId,
    })
    .from(patientPaymentApplication)
    .innerJoin(patientPayment, and(eq(patientPayment.id, patientPaymentApplication.paymentId), eq(patientPayment.organizationId, orgId)))
    .innerJoin(patientCharge, and(eq(patientCharge.id, patientPaymentApplication.chargeId), eq(patientCharge.organizationId, orgId)))
    .innerJoin(
      encounterProcedure,
      and(eq(encounterProcedure.id, patientCharge.encounterProcedureId), eq(encounterProcedure.organizationId, orgId)),
    )
    .innerJoin(encounter, and(eq(encounter.id, encounterProcedure.encounterId), eq(encounter.organizationId, orgId)))
    .where(and(...filters))
  return rows.flatMap((row) => {
    const returned = row.appCents - Number(row.kept)
    if (returned <= 0) return []
    return [{ professionalUserId: row.professionalUserId, value: orgPartValue(-returned, row.payment, money) }]
  })
}

/**
 * Lo cobrado neto de varios tramos en una sola consulta: los cobros del tramo
 * que siguen en pie al cerrarlo, menos las anulaciones del tramo de cobros
 * anteriores y las devoluciones del tramo. Así el Resumen y Finanzas dibujan sus
 * 12 meses sin 12 idas. `taxCents` es la parte de eso que es impuesto (ADR 0083),
 * con la misma regla: lo que «lo que deja» resta.
 *
 * Todo con su valor congelado, en moneda del negocio: anular resta el valor
 * entero y una devolución su parte. Se redondea una vez, sobre la suma. Solo lo
 * viejo en otra moneda, sin valor ni factor, va aparte en su moneda: no se puede
 * sumar, igual que antes.
 */
export async function collectedNetMany(
  tx: Db,
  orgId: string,
  spans: Span[],
  options: { branchId?: string } = {},
): Promise<Array<Array<{ currency: string; cents: number; taxCents: number }>>> {
  const rows = await tx.execute<{ idx: number; currency: string; cents: string; tax: string }>(sql`
    select b.idx, case when v.cents is null then x.currency else op.currency end as currency,
      round(sum(coalesce(v.cents, x.cents)))::text as cents, round(sum(coalesce(v.tax, x.tax)))::text as tax
    from ${spansSql(spans)}
    cross join ${orgMoneySql(orgId)}
    join lateral (${paymentFlowSql(orgId, sql`b.start_at`, sql`b.end_at`, options.branchId)}) x on true
    cross join lateral (select ${paymentValueSql(sql`x.cents`, "x")} as cents, ${paymentValueSql(sql`x.tax`, "x")} as tax) v
    group by b.idx, 2`)
  return bySpan(
    spans,
    [...rows],
    (): Array<{ currency: string; cents: number; taxCents: number }> => [],
    (list, row) => {
      list.push({
        currency: row.currency,
        cents: safeCents(row.cents),
        taxCents: safeCents(row.tax),
      })
      return list
    },
  )
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
  /** Todo lo que debe, concepto por concepto, con su saldo y desde cuándo. */
  items: Array<{ description: string; outstandingCents: number; since: Date | null }>
  /** Última atención que dejó algo por cobrar: cuándo terminó y quién atendió. */
  lastAttended: { at: Date; professionalName: string | null } | null
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
  query: { branchId?: string; patientIds?: string[] } = {},
): Promise<DebtRow[]> {
  if (query.patientIds?.length === 0) return []
  const rows = await getReceivables(tx, orgId, {
    outstandingOnly: true,
    ...(query.patientIds ? { patientIds: query.patientIds } : {}),
  })
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
      items: [],
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
    entry.items.push({ description: row.charge.description, outstandingCents: row.outstandingCents, since: at })
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
  const attended = new Map<string, { at: Date; professionalUserId: string }>()
  if (procedureIds.length > 0) {
    const visits = await tx
      .select({
        procedureId: encounterProcedure.id,
        finalizedAt: encounter.finalizedAt,
        professionalUserId: encounter.professionalUserId,
      })
      .from(encounterProcedure)
      .innerJoin(
        encounter,
        and(eq(encounter.id, encounterProcedure.encounterId), eq(encounter.organizationId, orgId)),
      )
      .where(and(eq(encounterProcedure.organizationId, orgId), inArray(encounterProcedure.id, procedureIds)))
    for (const visit of visits)
      if (visit.finalizedAt) attended.set(visit.procedureId, { at: visit.finalizedAt, professionalUserId: visit.professionalUserId })
  }
  const professionals = await userNames(tx, [...attended.values()].map((visit) => visit.professionalUserId))
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
      let last: { at: Date; professionalUserId: string } | null = null
      for (const charge of chargesOf[key] ?? []) {
        const visit = charge.procedureId ? attended.get(charge.procedureId) : undefined
        if (visit && (!last || visit.at > last.at)) last = visit
      }
      return {
        ...row,
        displayName: names.get(row.patientId) ?? "",
        creditCents: credit.get(`${row.patientId}|${row.currency}`) ?? 0,
        lastAttended: last ? { at: last.at, professionalName: professionals.get(last.professionalUserId) ?? null } : null,
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
  const { currency: unit, secondCurrency: second = null } = await getOrgLocale(tx, orgId)
  const today = dayKeyIn(new Date(), timezone)
  // Sin otra moneda, solo la caja de la clínica; con ella, las dos cajas.
  const { movements } = await getDayMovements(tx, orgId, {
    branchId: branchRow.id,
    day: today,
    timezone,
    ...(second ? {} : { currency: unit }),
  })
  const cobros = movements.filter((m) => m.direction === "ingreso" && m.kind === "cobro")
  const collectedIn = (code: string) =>
    sumCents(cobros.filter((m) => m.currency === code).map((m) => ({ amountCents: m.amountCents })))
  const seen = new Set(cobros.map((m) => (m.ticketId ? `ticket:${m.ticketId}` : m.patientPaymentId ? `pago:${m.patientPaymentId}` : `mov:${m.id}`)))
  // Solo puede estar «atendido hoy» quien tiene un cargo de hoy o una atención
  // cerrada hoy: las deudas se calculan de esas personas, no de toda la clínica
  // (con años de cargos, Inicio los traía todos para quedarse con los de hoy).
  // Dos días de margen cubren cualquier zona horaria; el día lo decide `getDebts`.
  const recent = await tx.execute<{ patient_id: string }>(sql`
    select distinct c.patient_id from patient_charge c
      left join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id
      left join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id
    where c.organization_id = ${orgId} and c.voided_at is null
      and (c.created_at >= now() - interval '2 days' or e.finalized_at >= now() - interval '2 days')`)
  const toCollect = (await getDebts(tx, orgId, { branchId: branchRow.id, patientIds: recent.map((row) => row.patient_id) }))
    .filter((row): row is DebtRow & { attendedTodayAt: Date } => row.attendedTodayAt !== null)
    .sort((a, b) => a.attendedTodayAt.getTime() - b.attendedTodayAt.getTime())
  return {
    branchId: branchRow.id,
    branchName: branchRow.name,
    currency: unit,
    timezone,
    collectedCents: collectedIn(unit),
    /** Lo cobrado en la otra moneda: va aparte, nunca sumado. Solo si la clínica la tiene. */
    ...(second ? { secondCollected: { currency: second, cents: collectedIn(second) } } : {}),
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
export async function getDayMovements(
  tx: Db,
  orgId: string,
  query: DayMovementsQuery,
  /** Administra comisiones: ve el motivo con que se anuló lo devuelto, que puede nombrar al profesional. */
  options: { seesCommissions?: boolean } = {},
) {
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
    return { branchId: branchRow.id, day: query.day, timezone, movements: [], voidedTickets, voidedMovements: [] }
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
  return {
    branchId: branchRow.id,
    day: query.day,
    timezone,
    movements: await withTicketOrigin(tx, orgId, await withoutCommissionPayees(tx, orgId, movements)),
    voidedTickets,
    voidedMovements: await voidedCommissionReturnsOfDay(tx, orgId, shiftIds, start, end, options.seesCommissions ?? false),
  }
}

/**
 * Lo devuelto de comisiones en efectivo que entró ese día y después se anuló, con la caja aún abierta: como
 * un ticket anulado, sigue a la vista, tachado y con su motivo, sin sumar. Quien contó ese efectivo ve por
 * qué ya no está. Sin a quién (caja no lo ve): el concepto es el mismo de la caja.
 */
export interface VoidedMovementOfDay {
  id: string
  kind: string
  direction: string
  concept: string
  currency: string
  amountCents: number
  createdAt: Date
  voidedAt: Date
  voidReason: string | null
}

async function voidedCommissionReturnsOfDay(
  tx: Db,
  orgId: string,
  shiftIds: string[],
  start: Date,
  end: Date,
  seesCommissions: boolean,
): Promise<VoidedMovementOfDay[]> {
  if (shiftIds.length === 0) return []
  const rows = await tx
    .select({ movement: cashMovement })
    .from(cashMovement)
    .innerJoin(
      commissionSettlement,
      and(eq(commissionSettlement.organizationId, orgId), eq(commissionSettlement.cashMovementId, cashMovement.id)),
    )
    .where(
      and(
        eq(cashMovement.organizationId, orgId),
        inArray(cashMovement.shiftId, shiftIds),
        isNotNull(cashMovement.voidedAt),
        gte(cashMovement.createdAt, start),
        lte(cashMovement.createdAt, end),
      ),
    )
    .orderBy(asc(cashMovement.createdAt), asc(cashMovement.id))
  return rows.map(({ movement }) => ({
    id: movement.id,
    kind: movement.kind,
    direction: movement.direction,
    concept: COMMISSION_RETURNS_CONCEPT,
    currency: movement.currency,
    amountCents: movement.amountCents,
    createdAt: movement.createdAt,
    voidedAt: movement.voidedAt as Date,
    // El motivo es texto libre de Comisiones y puede nombrar a quién era: caja, que no lo ve, lee solo de
    // dónde se anuló, como en Gastos lee las comisiones sin su nota.
    voidReason: seesCommissions ? movement.voidReason : COMMISSION_RETURN_VOIDED_REASON,
  }))
}

/** Lo que caja lee como motivo de una devolución de comisiones anulada. */
export const COMMISSION_RETURN_VOIDED_REASON = "Se anuló en Comisiones"

/**
 * Ticket, número y persona de cada cobro: la pantalla muestra un renglón por
 * ticket (un cobro con dos medios es un solo cobro) con su nombre.
 */
async function withTicketOrigin(tx: Db, orgId: string, movements: Array<typeof cashMovement.$inferSelect>) {
  const paymentIds = [
    ...new Set(movements.map((m) => m.patientPaymentId).filter((id): id is string => id !== null)),
  ]
  const origin = new Map<
    string,
    {
      ticketId: string | null
      ticketNumber: number | null
      patientId: string
      patientName: string
      exchangeRate: string | null
      ticketCurrency: string | null
      ticketTotalCents: number | null
      cashReceivedCents: number | null
      changeCents: number | null
      changeCurrency: string | null
    }
  >()
  if (paymentIds.length > 0) {
    const rows = await tx
      .select({
        paymentId: patientPayment.id,
        ticketId: patientPayment.ticketId,
        ticketNumber: paymentTicket.ticketNumber,
        patientId: patientPayment.patientId,
        patientName: patientPerson.displayName,
        exchangeRate: patientPayment.exchangeRate,
        ticketCurrency: paymentTicket.currency,
        ticketTotalCents: paymentTicket.totalCents,
        cashReceivedCents: paymentTicket.cashReceivedCents,
        changeCents: paymentTicket.changeCents,
        changeCurrency: paymentTicket.changeCurrency,
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
  return movements.map((m) => {
    const from = m.patientPaymentId ? origin.get(m.patientPaymentId) : undefined
    return {
      ...m,
      ticketId: from?.ticketId ?? null,
      ticketNumber: from?.ticketNumber ?? null,
      patientId: from?.patientId ?? null,
      patientName: from?.patientName ?? null,
      /** Lo que canceló y con qué cambio; nulo si no hubo otra moneda. */
      cancels:
        from?.exchangeRate && from.ticketCurrency && from.ticketTotalCents !== null
          ? {
              currency: from.ticketCurrency,
              totalCents: from.ticketTotalCents,
              rate: from.exchangeRate,
              cashReceivedCents: from.cashReceivedCents,
              changeCents: from.changeCents,
              changeCurrency: from.changeCurrency,
            }
          : null,
    }
  })
}

/**
 * Lo que contó un cierre: los movimientos de su ventana que mueven el
 * efectivo (cobros con su ticket, gastos, ingresos, retiros y devoluciones),
 * del más antiguo al más nuevo. Lo electrónico no se cuenta en el cajón.
 */
async function countedMovements(tx: Db, orgId: string, shiftId: string) {
  const movements = await tx
    .select()
    .from(cashMovement)
    .where(and(eq(cashMovement.organizationId, orgId), eq(cashMovement.shiftId, shiftId), isNull(cashMovement.voidedAt)))
    .orderBy(asc(cashMovement.createdAt), asc(cashMovement.id))
  const counted = movements.filter((m) => !isElectronic(m) && (m.direction !== "egreso" || isCashEgreso(m)))
  return withTicketOrigin(tx, orgId, await withoutCommissionPayees(tx, orgId, counted))
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
  cashChangeCents: 0,
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
      ratesUsed: [] as CashRateUsed[],
      lastClosure,
    }
  const detail = await getShiftDetail(tx, orgId, open.id)
  const paymentsById = await paymentsOfMovements(tx, orgId, detail.movements)
  // Un ticket multimedio es un solo cobro: se deduplica por ticket (o pago si es histórico).
  const cobros = detail.movements.filter((m) => m.direction === "ingreso" && m.kind === "cobro")
  const seen = new Set<string>()
  for (const m of cobros) {
    const ticketId = m.patientPaymentId ? paymentsById.get(m.patientPaymentId)?.ticketId : null
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
    ratesUsed: await ratesUsedIn(tx, orgId, detail.movements, paymentsById),
    lastClosure,
  }
}

/** Un cambio con que se movió dinero en una caja: cuántas veces y quién. */
export interface CashRateUsed {
  rate: string
  cobros: number
  vueltos: number
  byName: string | null
}

/**
 * Los pagos de unos movimientos: su ticket (nulo = histórico) y el cambio con que
 * entraron. Una sola consulta para contar los cobros y revisar los cambios.
 */
async function paymentsOfMovements(tx: Db, orgId: string, movements: CashMove[]) {
  const ids = [
    ...new Set(movements.map((m) => m.patientPaymentId).filter((id): id is string => id !== null)),
  ]
  if (!ids.length)
    return new Map<
      string,
      { ticketId: string | null; rate: string | null; createdBy: string | null }
    >()
  const rows = await tx
    .select({
      id: patientPayment.id,
      ticketId: patientPayment.ticketId,
      rate: patientPayment.exchangeRate,
      createdBy: patientPayment.createdBy,
    })
    .from(patientPayment)
    .where(and(eq(patientPayment.organizationId, orgId), inArray(patientPayment.id, ids)))
  return new Map(rows.map((row) => [row.id, row]))
}

/**
 * Los cambios usados en una ventana, para revisarlos al cerrar. Sale de sus pagos, no
 * de la clínica: quien quitó su otra moneda con la caja abierta aún los revisa al cerrarla.
 */
async function ratesUsedIn(
  tx: Db,
  orgId: string,
  movements: CashMove[],
  payments: Awaited<ReturnType<typeof paymentsOfMovements>>,
): Promise<CashRateUsed[]> {
  const crossed = new Map([...payments].filter(([, payment]) => payment.rate))
  if (!crossed.size) return []
  const names = await userNames(
    tx,
    [...crossed.values()].map((p) => p.createdBy).filter((id): id is string => !!id),
  )
  const used = new Map<string, CashRateUsed>()
  for (const m of movements) {
    const payment = m.patientPaymentId ? crossed.get(m.patientPaymentId) : undefined
    if (!payment?.rate) continue
    const key = `${payment.rate}|${payment.createdBy ?? ""}`
    const row = used.get(key) ?? {
      rate: payment.rate,
      cobros: 0,
      vueltos: 0,
      byName: payment.createdBy ? (names.get(payment.createdBy) ?? null) : null,
    }
    if (m.kind === "cobro") row.cobros += 1
    if (m.kind === "vuelto") row.vueltos += 1
    used.set(key, row)
  }
  return [...used.values()]
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
  /** `descuadre`: solo los que no cuadraron (faltó o sobró). */
  query: { branchId?: string; limit?: number; before?: string; result?: "descuadre" } = {},
): Promise<ClosureListItem[]> {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100)
  // Página siguiente: lo cerrado antes del último cierre ya mostrado.
  const before = query.before ? instant(query.before) : null
  const closureFilters = [eq(cashClosure.organizationId, orgId)]
  if (before) closureFilters.push(lt(cashClosure.closedAt, before))
  if (query.branchId) closureFilters.push(eq(cashClosure.branchId, query.branchId))
  if (query.result === "descuadre") closureFilters.push(sql`${cashClosure.differenceCents} <> 0`)
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
  // Un turno anterior sin diferencia registrada no se sabe si cuadró: no entra.
  if (query.result === "descuadre") shiftFilters.push(sql`${cashShift.differenceCents} <> 0`)
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
  if (!looksLikeId(closureId)) throw notFound("Cierre de caja")
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
      counted: await countedMovements(tx, orgId, closure.shiftId),
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
    counted: await countedMovements(tx, orgId, shift.id),
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

// --- Cobros: todos los tickets de la sede ----------------------------------------------------

export const TICKET_SORTS = ["recientes", "antiguos", "monto"] as const
export type TicketSort = (typeof TICKET_SORTS)[number]
/** `devolucion`: los que tienen al menos una devolución. */
export const TICKET_STATES = ["vigentes", "anulados", "devolucion"] as const
export type TicketState = (typeof TICKET_STATES)[number]

export interface TicketListQuery {
  branchId: string
  /** Nombre, documento o número del ticket. Un número busca en todas las fechas. */
  q?: string
  /** Días `AAAA-MM-DD` de la sede, ambos incluidos. */
  from?: string
  to?: string
  methodIds?: string[]
  cashierIds?: string[]
  state?: TicketState
  sort?: TicketSort
  cursor?: string
  limit?: number
}

/** Un ticket como se lee en la lista: lo que congeló al cobrar y lo que pasó después. */
export interface TicketListRow {
  id: string
  number: number
  patientId: string
  displayName: string
  docType: string | null
  docNumber: string | null
  createdAt: Date
  currency: string
  totalCents: number
  creditAppliedCents: number
  lines: Array<{ description: string; appliedCents: number }>
  /** `tenderCents` y `tenderCurrency` solo si entró en otra moneda que la que canceló. */
  methods: Array<{
    name: string
    amountCents: number
    tenderCents?: number
    tenderCurrency?: string
  }>
  cashierName: string | null
  /** Lo que quedó por pagar de esos conceptos al cobrar. */
  remainingCents: number
  voided: { at: Date; reason: string | null; byName: string | null } | null
  /** Lo devuelto de este ticket (en dinero o a su saldo a favor). */
  returnedCents: number
}

/** Lo que suma la lista entera con sus filtros, por moneda: nunca se mezclan. */
export interface TicketTotals {
  currency: string
  /** Tickets vigentes: los anulados no suman. */
  tickets: number
  cobradoCents: number
  /** Devuelto en dinero de estos tickets. */
  refundedCents: number
  byMethod: Array<{ name: string; cents: number }>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface TicketCursor {
  /** `created_at` como lo escribe la base: conserva los microsegundos. */
  at: string
  id: string
  cents?: number
}

function decodeTicketCursor(raw: string): TicketCursor {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as TicketCursor
    const valid =
      typeof value.at === "string" &&
      typeof value.id === "string" &&
      UUID.test(value.id) &&
      (value.cents === undefined || Number.isInteger(value.cents))
    if (valid) return value
  } catch {
    // Cae al error de abajo: una página que no se entiende no se pide.
  }
  throw validation("La página pedida no es válida")
}

function bigintCents(value: unknown): number {
  return Number(value ?? 0)
}

/**
 * Todos los tickets de una sede, del más nuevo al más antiguo por defecto, por
 * páginas y con lo que suma la lista entera (`totals`). Un número escrito es
 * el de un ticket o un documento: se busca en todas las fechas (`allDates`).
 */
/** Lo que dice un ticket en lugar del nombre de una persona con la historia bloqueada. */
export const LOCKED_RECORD_NAME = "Historia bloqueada"

export async function listTickets(tx: Db, orgId: string, query: TicketListQuery) {
  const branchRow = await requireBranch(tx, orgId, query.branchId)
  const timezone = await branchTimezone(tx, orgId, branchRow)
  const limit = Math.min(Math.max(query.limit ?? 30, 1), 100)
  const sort: TicketSort = query.sort ?? "recientes"
  const q = query.q?.trim() ?? ""
  const number = q ? referenceNumber(q, ["ticket", "t"]) : null
  const digits = q ? searchDigits(q) : ""
  const allDates = number !== null || digits !== ""
  // El nombre y el documento como se congelaron en el ticket (un nombre cambiado después también encuentra).
  const frozenName = sql`${paymentTicket.snapshot}->'patient'->>'displayName'`
  const frozenDocument = sql`${paymentTicket.snapshot}->'patient'->>'docNumber'`

  const filters: SQL[] = [eq(paymentTicket.organizationId, orgId), eq(paymentTicket.branchId, branchRow.id)]
  // Una historia bloqueada (ADR 0080) guarda sus comprobantes, que siguen
  // sumando; pero su nombre y su documento quedan solo dentro de la historia:
  // no se buscan por ellos ni se muestran aquí.
  const unlocked = isNull(patientPerson.recordLockedAt)
  if (q)
    filters.push(
      allDates
        ? or(
            number !== null ? eq(paymentTicket.ticketNumber, number) : sql`false`,
            digits ? and(unlocked, digitsContain(patientPerson.docNumber, digits))! : sql`false`,
            digits ? and(unlocked, digitsContain(frozenDocument, digits))! : sql`false`,
          )!
        : and(unlocked, foldedWordsMatch([patientPerson.displayName, frozenName], q))!,
    )
  if (!allDates && query.from) filters.push(gte(paymentTicket.createdAt, dayBoundsUTC(day(query.from), timezone).start))
  if (!allDates && query.to) filters.push(lt(paymentTicket.createdAt, dayBoundsUTC(day(query.to), timezone).end))
  const methodIds = (query.methodIds ?? []).filter((id) => UUID.test(id))
  if (query.methodIds?.length) {
    filters.push(
      methodIds.length
        ? sql`exists (select 1 from ${patientPayment} where ${patientPayment.organizationId} = ${paymentTicket.organizationId}
            and ${patientPayment.ticketId} = ${paymentTicket.id}
            and ${patientPayment.paymentMethodId} in (${sql.join(methodIds.map((id) => sql`${id}::uuid`), sql`, `)}))`
        : sql`false`,
    )
  }
  if (query.cashierIds?.length) filters.push(inArray(paymentTicket.createdBy, query.cashierIds))
  if (query.state === "vigentes") filters.push(isNull(paymentTicket.voidedAt))
  if (query.state === "anulados") filters.push(sql`${paymentTicket.voidedAt} is not null`)
  if (query.state === "devolucion")
    filters.push(sql`exists (select 1 from ${paymentReturn} where ${paymentReturn.organizationId} = ${paymentTicket.organizationId}
      and ${paymentReturn.ticketId} = ${paymentTicket.id})`)
  const where = and(...filters)!

  const cursor = query.cursor ? decodeTicketCursor(query.cursor) : null
  const after = !cursor
    ? sql`true`
    : sort === "monto"
      ? sql`(${paymentTicket.totalCents}, ${paymentTicket.createdAt}, ${paymentTicket.id}) < (${cursor.cents ?? 0}::int, ${cursor.at}::timestamptz, ${cursor.id}::uuid)`
      : sort === "antiguos"
        ? sql`(${paymentTicket.createdAt}, ${paymentTicket.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
        : sql`(${paymentTicket.createdAt}, ${paymentTicket.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`
  const order =
    sort === "monto"
      ? [desc(paymentTicket.totalCents), desc(paymentTicket.createdAt), desc(paymentTicket.id)]
      : sort === "antiguos"
        ? [asc(paymentTicket.createdAt), asc(paymentTicket.id)]
        : [desc(paymentTicket.createdAt), desc(paymentTicket.id)]

  const page = await tx
    .select({
      ticket: paymentTicket,
      at: sql<string>`${paymentTicket.createdAt}::text`,
      displayName: patientPerson.displayName,
      docType: patientPerson.docType,
      docNumber: patientPerson.docNumber,
      lockedAt: patientPerson.recordLockedAt,
    })
    .from(paymentTicket)
    .innerJoin(patient, and(eq(patient.id, paymentTicket.patientId), eq(patient.organizationId, orgId)))
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(where, after))
    .orderBy(...order)
    .limit(limit + 1)
  const rows = page.slice(0, limit)
  const last = rows.at(-1)
  const nextCursor =
    page.length > limit && last
      ? Buffer.from(
          JSON.stringify({ at: last.at, id: last.ticket.id, ...(sort === "monto" ? { cents: last.ticket.totalCents } : {}) }),
          "utf8",
        ).toString("base64url")
      : null

  const ids = rows.map((row) => row.ticket.id)
  const returned = ids.length
    ? await tx
        .select({ ticketId: paymentReturn.ticketId, cents: sql<string>`sum(${paymentReturn.totalCents})::bigint` })
        .from(paymentReturn)
        .where(and(eq(paymentReturn.organizationId, orgId), inArray(paymentReturn.ticketId, ids)))
        .groupBy(paymentReturn.ticketId)
    : []
  const returnedOf = new Map(returned.map((row) => [row.ticketId, bigintCents(row.cents)]))
  const voiders = await userNames(
    tx,
    rows.map((row) => row.ticket.voidedBy).filter((id): id is string => !!id),
  )

  // Lo que suma la lista entera se pide solo con la primera página: las siguientes no lo cambian.
  const summary = cursor ? null : await ticketTotals(tx, orgId, where, methodIds)

  return {
    timezone,
    /** La búsqueda fue un número: se buscó en todas las fechas, sin la de los filtros. */
    allDates,
    /** Filas de la lista entera, anuladas incluidas (solo en la primera página). */
    total: summary?.total ?? null,
    /** Solo en la primera página. */
    totals: summary?.totals ?? null,
    nextCursor,
    /** Quiénes cobraron en esta sede: las opciones de «Cobró» (solo en la primera página). */
    cashiers: cursor ? null : await ticketCashiers(tx, orgId, branchRow.id),
    data: rows.map(({ ticket, displayName, docType, docNumber, lockedAt }): TicketListRow => {
      const frozen = ticket.snapshot as Partial<TicketFrozen> | null
      const locked = lockedAt !== null
      return {
        id: ticket.id,
        number: ticket.ticketNumber,
        patientId: ticket.patientId,
        displayName: locked ? LOCKED_RECORD_NAME : displayName,
        docType: locked ? null : (docType ?? frozen?.patient?.docType ?? null),
        docNumber: locked ? null : (docNumber ?? frozen?.patient?.docNumber ?? null),
        createdAt: ticket.createdAt,
        currency: ticket.currency,
        totalCents: ticket.totalCents,
        creditAppliedCents: ticket.creditAppliedCents,
        lines: (frozen?.lines ?? []).map((line) => ({ description: line.description, appliedCents: line.appliedCents })),
        methods: (frozen?.methods ?? []).map((method) => ({
          name: method.name,
          amountCents: method.amountCents,
          ...(method.tenderCents !== undefined && frozen?.tender
            ? { tenderCents: method.tenderCents, tenderCurrency: frozen.tender.currency }
            : {}),
        })),
        cashierName: frozen?.issuer?.name ?? null,
        remainingCents: frozen?.remainingCents ?? 0,
        voided: ticket.voidedAt
          ? { at: ticket.voidedAt, reason: ticket.voidReason, byName: ticket.voidedBy ? (voiders.get(ticket.voidedBy) ?? null) : null }
          : null,
        returnedCents: returnedOf.get(ticket.id) ?? 0,
      }
    }),
  }
}

/**
 * Cuántos tickets hay en la lista y lo que suma, por la moneda en que entró y por
 * medio: es lo que se cuadra con la caja y con el POS. Con medios elegidos, lo
 * cobrado es solo lo de esos medios, no el total de un ticket pagado con dos.
 */
async function ticketTotals(tx: Db, orgId: string, where: SQL, methodIds: string[]) {
  // Sin pagos (todo con saldo a favor), lo del ticket: su moneda y nada de dinero nuevo.
  const paid = sql`lateral (
    select min(coalesce(${patientPayment.tenderCurrency}, ${patientPayment.currency})::text) as currency,
      sum(coalesce(${patientPayment.tenderCents}, ${patientPayment.amountCents})) as cents
    from ${patientPayment}
    where ${patientPayment.organizationId} = ${paymentTicket.organizationId} and ${patientPayment.ticketId} = ${paymentTicket.id}
  ) as paid`
  const entered = sql<string>`coalesce(paid.currency, ${paymentTicket.currency}::text)`
  const enteredCents = sql`coalesce(paid.cents, ${paymentTicket.totalCents})`
  const counts = await tx
    .select({
      currency: entered,
      rows: sql<number>`count(*)::int`,
      tickets: sql<number>`(count(*) filter (where ${paymentTicket.voidedAt} is null))::int`,
      cents: sql<string>`coalesce(sum(${enteredCents}) filter (where ${paymentTicket.voidedAt} is null), 0)::bigint`,
    })
    .from(paymentTicket)
    .innerJoin(patient, and(eq(patient.id, paymentTicket.patientId), eq(patient.organizationId, orgId)))
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .innerJoin(paid, sql`true`)
    .where(where)
    .groupBy(entered)
  const methodCurrency = sql<string>`coalesce(${patientPayment.tenderCurrency}, ${patientPayment.currency})::text`
  const methods = await tx
    .select({
      currency: methodCurrency,
      name: patientPayment.methodName,
      cents: sql<string>`sum(coalesce(${patientPayment.tenderCents}, ${patientPayment.amountCents}))::bigint`,
    })
    .from(patientPayment)
    .innerJoin(
      paymentTicket,
      and(eq(paymentTicket.organizationId, patientPayment.organizationId), eq(paymentTicket.id, patientPayment.ticketId)),
    )
    .innerJoin(patient, and(eq(patient.id, paymentTicket.patientId), eq(patient.organizationId, orgId)))
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(
      and(
        where,
        isNull(paymentTicket.voidedAt),
        ...(methodIds.length ? [inArray(patientPayment.paymentMethodId, methodIds)] : []),
      ),
    )
    .groupBy(methodCurrency, patientPayment.methodName)
  // Lo devuelto en dinero sale en la moneda en que entró, de cada pago que se liberó.
  const refunds = await tx
    .select({
      currency: methodCurrency,
      cents: sql<string>`sum(coalesce(${patientPaymentRefund.tenderCents}, ${patientPaymentRefund.amountCents}))::bigint`,
    })
    .from(patientPaymentRefund)
    .innerJoin(
      patientPayment,
      and(
        eq(patientPayment.organizationId, patientPaymentRefund.organizationId),
        eq(patientPayment.id, patientPaymentRefund.paymentId),
      ),
    )
    .innerJoin(
      paymentReturn,
      and(
        eq(paymentReturn.organizationId, patientPaymentRefund.organizationId),
        eq(paymentReturn.id, patientPaymentRefund.returnId),
      ),
    )
    .innerJoin(
      paymentTicket,
      and(eq(paymentTicket.organizationId, paymentReturn.organizationId), eq(paymentTicket.id, paymentReturn.ticketId)),
    )
    .innerJoin(patient, and(eq(patient.id, paymentTicket.patientId), eq(patient.organizationId, orgId)))
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(where)
    .groupBy(methodCurrency)
  const totals: TicketTotals[] = counts.map((row) => {
    const byMethod = methods
      .filter((item) => item.currency === row.currency)
      .map((item) => ({ name: item.name, cents: bigintCents(item.cents) }))
      .sort((a, b) => b.cents - a.cents)
    return {
      currency: row.currency,
      tickets: row.tickets,
      cobradoCents: methodIds.length ? byMethod.reduce((sum, item) => sum + item.cents, 0) : bigintCents(row.cents),
      refundedCents: bigintCents(refunds.find((item) => item.currency === row.currency)?.cents),
      byMethod,
    }
  })
  return { total: counts.reduce((sum, row) => sum + row.rows, 0), totals }
}

/** Quiénes cobraron alguna vez en la sede, por nombre. */
async function ticketCashiers(tx: Db, orgId: string, branchId: string) {
  return tx
    .selectDistinct({ id: user.id, name: user.name })
    .from(paymentTicket)
    .innerJoin(user, eq(user.id, paymentTicket.createdBy))
    .where(and(eq(paymentTicket.organizationId, orgId), eq(paymentTicket.branchId, branchId)))
    .orderBy(asc(user.name))
}

// --- Deudas: la lista para cobrar lo pendiente ----------------------------------------------

/** `monto`: lo que debe, de mayor a menor; `antigua`: desde cuándo; `reciente`: lo último atendido. */
export const DEBT_SORTS = ["monto", "antigua", "reciente"] as const
export type DebtSort = (typeof DEBT_SORTS)[number]

export interface DebtListQuery {
  branchId: string
  /** Nombre o documento. */
  q?: string
  /** Debe desde hace más de 30 o de 90 días. */
  age?: "30" | "90"
  /** `hoy`: solo quienes salieron hoy de su atención (la Caja). */
  when?: "hoy"
  sort?: DebtSort
  cursor?: string
  limit?: number
}

export interface DebtListRow extends DebtRow {
  /** Lo que debe ya descontado su saldo a favor. */
  dueCents: number
  creditUsedCents: number
  /** Días de calendario, en la zona de la sede, desde lo más antiguo que debe. */
  ageDays: number | null
  docType: string | null
  docNumber: string | null
  /** Su próxima cita: a quien ya viene se le cobra entonces. */
  nextAppointmentAt: Date | null
}

function debtTotals(rows: DebtListRow[]) {
  const totals = new Map<string, number>()
  for (const row of rows) totals.set(row.currency, addCents(totals.get(row.currency) ?? 0, row.dueCents))
  return {
    people: new Set(rows.map((row) => row.patientId)).size,
    totals: [...totals.entries()].map(([currency, cents]) => ({ currency, cents })),
  }
}

function daysBetweenKeys(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000))
}

/**
 * Quién debe en una sede, por páginas, con lo que debe concepto por concepto,
 * su documento y su próxima cita. `summary` es de la sede entera (sin la
 * búsqueda ni la antigüedad): cuánto se debe, desde hace más de 30 y de 90
 * días, y lo que se debe de antes de hoy.
 */
export async function listDebts(tx: Db, orgId: string, query: DebtListQuery) {
  const branchRow = await requireBranch(tx, orgId, query.branchId)
  const timezone = await branchTimezone(tx, orgId, branchRow)
  const today = dayKeyIn(new Date(), timezone)
  const limit = Math.min(Math.max(query.limit ?? 30, 1), 100)
  const offset = query.cursor ? Number(query.cursor) : 0
  if (!Number.isInteger(offset) || offset < 0) throw validation("La página pedida no es válida")
  const debts = await getDebts(tx, orgId, { branchId: branchRow.id })
  const patientIds = [...new Set(debts.map((row) => row.patientId))]
  const docs = patientIds.length
    ? await tx
        .select({ id: patient.id, docType: patientPerson.docType, docNumber: patientPerson.docNumber })
        .from(patient)
        .innerJoin(patientPerson, joinPatientPerson(patientPerson))
        .where(and(eq(patient.organizationId, orgId), inArray(patient.id, patientIds)))
    : []
  const docOf = new Map(docs.map((row) => [row.id, row]))
  const rows: DebtListRow[] = debts.map((row) => {
    const creditUsedCents = Math.max(0, Math.min(row.creditCents, row.totalCents))
    return {
      ...row,
      dueCents: row.totalCents - creditUsedCents,
      creditUsedCents,
      ageDays: row.oldestSince ? daysBetweenKeys(dayKeyIn(row.oldestSince, timezone), today) : null,
      docType: docOf.get(row.patientId)?.docType ?? null,
      docNumber: docOf.get(row.patientId)?.docNumber ?? null,
      nextAppointmentAt: null,
    }
  })
  // Quien tiene a favor todo lo que debe, en todas las sedes, no debe (decisión 22, como Reportes y
  // «Deben»): no entra en la lista ni en la cuenta. El saldo a favor se resta entero en cada sede, así
  // que se mira lo de todas antes de dejar fuera a quien sí debe en otra.
  const covered = rows.filter((row) => row.dueCents <= 0)
  const owesSomewhere = new Set<string>()
  if (covered.length > 0) {
    const everywhere = await getDebts(tx, orgId, { patientIds: [...new Set(covered.map((row) => row.patientId))] })
    const sums = new Map<string, { total: number; credit: number }>()
    for (const row of everywhere) {
      const key = `${row.patientId}|${row.currency}`
      const sum = sums.get(key) ?? { total: 0, credit: row.creditCents }
      sum.total += row.totalCents
      sums.set(key, sum)
    }
    for (const [key, sum] of sums) if (sum.total > sum.credit) owesSomewhere.add(key)
  }
  const all = rows.filter((row) => row.dueCents > 0 || owesSomewhere.has(`${row.patientId}|${row.currency}`))
  const olderThan = (days: number) => all.filter((row) => (row.ageDays ?? 0) > days)

  const q = query.q?.trim() ?? ""
  const digits = q ? searchDigits(q) : ""
  // «Atendidos hoy» de la Caja sí muestra a quien paga con su saldo a favor: hay que tocar «Cobrar»
  // para aplicarlo, como cuenta Inicio («Por cobrar»).
  const listed = (query.when === "hoy" ? rows : all)
    .filter((row) => query.when !== "hoy" || row.attendedTodayAt !== null)
    .filter((row) => !query.age || (row.ageDays ?? 0) > Number(query.age))
    .filter((row) =>
      !q
        ? true
        : digits
          ? (row.docNumber ?? "").replace(/\D/g, "").includes(digits)
          : textMatchesWords([row.displayName, row.docNumber], q),
    )
  const time = (at: Date | null) => at?.getTime() ?? 0
  const sort: DebtSort = query.sort ?? "monto"
  listed.sort((a, b) =>
    query.when === "hoy"
      ? time(a.attendedTodayAt) - time(b.attendedTodayAt)
      : sort === "antigua"
        ? (a.oldestSince ? time(a.oldestSince) : Number.POSITIVE_INFINITY) -
          (b.oldestSince ? time(b.oldestSince) : Number.POSITIVE_INFINITY)
        : sort === "reciente"
          ? time(b.lastAttended?.at ?? b.latestSince) - time(a.lastAttended?.at ?? a.latestSince)
          : b.dueCents - a.dueCents,
  )
  const page = listed.slice(offset, offset + limit)
  const pageIds = [...new Set(page.map((row) => row.patientId))]
  const next = pageIds.length
    ? await tx
        .select({
          patientId: appointment.patientId,
          at: sql<Date>`min(${appointment.startsAt})`.mapWith(appointment.startsAt),
        })
        .from(appointment)
        .where(
          and(
            eq(appointment.organizationId, orgId),
            inArray(appointment.patientId, pageIds),
            gt(appointment.startsAt, new Date()),
            inArray(appointment.status, ["programada", "confirmada"]),
            eq(appointment.isTest, false),
          ),
        )
        .groupBy(appointment.patientId)
    : []
  const nextOf = new Map(next.map((row) => [row.patientId, row.at]))

  return {
    timezone,
    /** Filas: quien debe en dos monedas tiene una por moneda. */
    total: listed.length,
    /** Personas distintas de esas filas. */
    people: new Set(listed.map((row) => row.patientId)).size,
    nextCursor: offset + limit < listed.length ? String(offset + limit) : null,
    summary: {
      ...debtTotals(all),
      over30: debtTotals(olderThan(30)),
      over90: debtTotals(olderThan(90)),
      /** Lo que se debe de antes de hoy: la línea de la Caja. */
      earlier: debtTotals(all.filter((row) => row.attendedTodayAt === null)),
    },
    data: page.map((row) => ({ ...row, nextAppointmentAt: nextOf.get(row.patientId) ?? null })),
  }
}
