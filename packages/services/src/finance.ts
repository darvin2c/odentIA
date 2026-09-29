/**
 * Finanzas: caja por sede/turno, gastos y proveedores, cuentas por cobrar con
 * planes de cuotas, comisiones por profesional y resúmenes para Home/Reportes
 * y Portal.
 *
 * Convención del repo: cada función recibe un `tx: Db` que YA corre dentro de
 * `withOrgContext(db, orgId, …)`; los servicios nunca abren el contexto.
 * Dinero siempre en centavos enteros con moneda ISO congelada por documento.
 * Sin emisor fiscal ni pasarela: no hay emisión de comprobantes ni cobro online.
 */
import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import {
  encounter,
  encounterProcedure,
  patientCharge,
  patientPayment,
  patientPaymentApplication,
  patientPaymentRefund,
} from "@odentia/db/schema/clinical"
import {
  cashMovement,
  cashShift,
  commissionRule,
  commissionSettlement,
  commissionSettlementLine,
  expense,
  installmentPlan,
  installmentQuota,
} from "@odentia/db/schema/finance"
import { supplier } from "@odentia/db/schema/inventory"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { createWorkspaceNotification } from "./workspace.js"
export const SHIFT_STATUSES = ["abierta", "cerrada"] as const
export const MOVEMENT_KINDS = [
  "apertura",
  "cobro",
  "gasto",
  "aporte",
  "retiro",
  "devolucion",
  "ajuste",
] as const
export const MOVEMENT_DIRECTIONS = ["ingreso", "egreso"] as const
export const COMMISSION_BASES = ["cobrado", "produccion"] as const
export const EXPENSE_RECEIPTS = ["boleta", "factura", "recibo", "nota", "ninguno"] as const

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

async function requireBranch(tx: Db, orgId: string, branchId: string) {
  const [row] = await tx
    .select()
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.organizationId, orgId)))
  if (!row) throw notFound("Sucursal")
  return row
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

export interface OpenShiftInput {
  branchId: string
  currency: string
  openingCents?: number
  notes?: string | null
}

/**
 * Abre un turno de caja en una sucursal. Solo un turno abierto por
 * sucursal+moneda; el segundo intento se rechaza (la constraint parcial lo
 * respalda en concurrencia).
 */
export async function openShift(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: OpenShiftInput,
) {
  await requireBranch(tx, orgId, input.branchId)
  const unit = currency(input.currency)
  const opening = input.openingCents ?? 0
  if (!Number.isSafeInteger(opening) || opening < 0 || opening > 2147483647)
    throw validation("La apertura debe ser un entero de centavos entre 0 y 2147483647")
  try {
    const [shift] = await tx
      .insert(cashShift)
      .values({
        organizationId: orgId,
        branchId: input.branchId,
        currency: unit,
        openingCents: opening,
        status: "abierta",
        openedBy: actorUserId,
        openNotes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
      })
      .returning()
    if (!shift) throw new ServiceError("INTERNAL", 409, "No se pudo abrir el turno")
    if (opening > 0) {
      await tx.insert(cashMovement).values({
        organizationId: orgId,
        shiftId: shift.id,
        direction: "ingreso",
        kind: "apertura",
        amountCents: opening,
        currency: unit,
        concept: "Apertura de turno",
        createdBy: actorUserId,
      })
    }
    await audit(tx, orgId, actorUserId, "cash_shift", shift.id, "cash.shift_opened")
    return shift
  } catch (e) {
    if (isUniqueViolation(e))
      throw conflict("SHIFT_ALREADY_OPEN", "Ya hay un turno abierto en esta sucursal y moneda")
    throw e
  }
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

/** Un cobro es electrónico cuando declara medio distinto de efectivo. */
function isElectronic(m: { kind: string; method: string | null }): boolean {
  return m.kind === "cobro" && m.method !== null && m.method !== "efectivo"
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
  kind: "aporte" | "retiro" | "ajuste" | "devolucion"
  amountCents: number
  concept: string
  method?: string | null
}

/** Aporte, retiro, ajuste o devolución manual sobre un turno abierto. */
export async function addShiftMovement(
  tx: Db,
  orgId: string,
  actorUserId: string,
  shiftId: string,
  input: AddMovementInput,
) {
  const shift = requireOpenShift(await requireShift(tx, orgId, shiftId))
  if (!MOVEMENT_DIRECTIONS.includes(input.direction)) throw validation("Dirección inválida")
  if (!["aporte", "retiro", "ajuste", "devolucion"].includes(input.kind))
    throw validation("Los cobros y gastos se registran por su propio flujo, no como movimiento manual")
  const [row] = await tx
    .insert(cashMovement)
    .values({
      organizationId: orgId,
      shiftId: shift.id,
      direction: input.direction,
      kind: input.kind,
      amountCents: assertCents(input.amountCents),
      currency: shift.currency,
      method: input.method?.trim() ? input.method.trim().slice(0, 60) : null,
      concept: concept(input.concept),
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "cash_movement", row.id, "cash.movement_added")
  return row
}

/**
 * Declara que un cobro real entró por un turno abierto, una sola vez y en la
 * misma moneda. El medio distingue el arqueo: efectivo suma al contado;
 * tarjeta/transferencia y billeteras quedan como electrónicas sin entrar al
 * contado. Núcleo compartido por el registro en caja y la creación del pago.
 */
export async function linkPaymentToShift(
  tx: Db,
  orgId: string,
  actorUserId: string,
  shiftId: string,
  payment: typeof patientPayment.$inferSelect,
) {
  const shift = requireOpenShift(await requireShift(tx, orgId, shiftId))
  if (payment.voidedAt) throw conflict("PAYMENT_VOIDED", "El pago está anulado")
  if (payment.currency !== shift.currency)
    throw conflict("CURRENCY_MISMATCH", "El pago es de otra moneda que el turno")
  try {
    const [row] = await tx
      .insert(cashMovement)
      .values({
        organizationId: orgId,
        shiftId: shift.id,
        direction: "ingreso",
        kind: "cobro",
        amountCents: payment.amountCents,
        currency: payment.currency,
        method: payment.method,
        concept: `Cobro ${payment.method} ${payment.reference ?? ""}`.trim(),
        patientPaymentId: payment.id,
        createdBy: actorUserId,
      })
      .returning()
    await audit(tx, orgId, actorUserId, "cash_movement", row.id, "cash.payment_registered")
    return row
  } catch (e) {
    if (isUniqueViolation(e))
      throw conflict("PAYMENT_ALREADY_IN_SHIFT", "Ese cobro ya ingresó a un turno de caja")
    throw e
  }
}

/**
 * Integra un cobro real existente al turno. El pago ya existe en
 * `patient_payment`; aquí solo se declara que ese dinero entró por esta
 * caja, una sola vez.
 */
export async function registerPaymentInShift(
  tx: Db,
  orgId: string,
  actorUserId: string,
  shiftId: string,
  paymentId: string,
) {
  const [payment] = await tx
    .select()
    .from(patientPayment)
    .where(
      and(eq(patientPayment.id, paymentId), eq(patientPayment.organizationId, orgId)),
    )
  if (!payment) throw notFound("Pago")
  return linkPaymentToShift(tx, orgId, actorUserId, shiftId, payment)
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
  notes?: string | null
}

/**
 * Cierra el turno con arqueo: congela esperado en efectivo, electrónico,
 * contado y diferencia (contado − esperado en efectivo). Toma la fila con
 * lock para serializar cierres concurrentes; reintentar un cierre ya hecho
 * devuelve la fila sin duplicar auditoría. El histórico queda preservado.
 * Permiso en ruta: solo dueño/admin (el cajero opera, el cierre lo supervisa).
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
  const detail = await getShiftDetail(tx, orgId, shiftId)
  const [row] = await tx
    .update(cashShift)
    .set({
      status: "cerrada",
      closedBy: actorUserId,
      closedAt: new Date(),
      expectedCents: detail.esperadoCents,
      electronicCents: detail.electronicosCents,
      countedCents: input.countedCents,
      differenceCents: input.countedCents - detail.esperadoCents,
      closeNotes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
    })
    .where(and(eq(cashShift.id, shiftId), eq(cashShift.organizationId, orgId)))
    .returning()
  await audit(tx, orgId, actorUserId, "cash_shift", shiftId, "cash.shift_closed")
  const difference = input.countedCents - detail.esperadoCents
  if (difference !== 0 && locked.openedBy && locked.openedBy !== actorUserId) {
    await createWorkspaceNotification(tx, orgId, {
      userId: locked.openedBy,
      dedupeKey: `cash-shift-diff:${shiftId}`,
      title: "Arqueo con diferencia",
      body: `El turno cerrado tiene una diferencia de ${difference} centavos (${locked.currency}).`,
      href: `/finance?turno=${shiftId}`,
      permission: "finance.read",
    })
  }
  return row
}

// --- Gastos (proveedores: catálogo único compartido con Inventario) -----------------
// Los proveedores viven en `services/inventory.ts` (createSupplier,
// updateSupplier, setSupplierActive, listSuppliers) sobre la tabla
// `schema/inventory.ts` (`supplier`). Los gastos solo referencian ese
// catálogo por `supplierId`; la orden de compra nunca equivale a un pago.

export interface CreateExpenseInput {
  branchId: string
  supplierId?: string | null
  concept: string
  amountCents: number
  currency: string
  spentAt?: string | null
  receiptKind?: string
  receiptNumber?: string | null
  notes?: string | null
  /** Si se informa, el gasto sale de la caja chica de ese turno abierto. */
  shiftId?: string | null
}

/**
 * Registra un gasto. Con `shiftId` el egreso sale de la caja chica del turno
 * (movimiento + gasto en la misma transacción); sin turno es gasto directo.
 */
export async function createExpense(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateExpenseInput,
) {
  await requireBranch(tx, orgId, input.branchId)
  if (input.supplierId) {
    const [found] = await tx
      .select({ id: supplier.id })
      .from(supplier)
      .where(and(eq(supplier.id, input.supplierId), eq(supplier.organizationId, orgId)))
    if (!found) throw notFound("Proveedor")
  }
  const receiptKind = input.receiptKind ?? "ninguno"
  if (!EXPENSE_RECEIPTS.includes(receiptKind as (typeof EXPENSE_RECEIPTS)[number]))
    throw validation("Tipo de comprobante inválido")
  let shift: typeof cashShift.$inferSelect | null = null
  if (input.shiftId) {
    shift = requireOpenShift(await requireShift(tx, orgId, input.shiftId))
    if (shift.branchId !== input.branchId)
      throw conflict("BRANCH_MISMATCH", "El turno pertenece a otra sucursal")
    if (shift.currency !== input.currency)
      throw conflict("CURRENCY_MISMATCH", "El gasto es de otra moneda que el turno")
  }
  const [row] = await tx
    .insert(expense)
    .values({
      organizationId: orgId,
      branchId: input.branchId,
      supplierId: input.supplierId ?? null,
      shiftId: shift?.id ?? null,
      concept: concept(input.concept),
      amountCents: assertCents(input.amountCents, "El gasto"),
      currency: currency(input.currency),
      spentAt: input.spentAt ? instant(input.spentAt) : new Date(),
      receiptKind,
      receiptNumber: input.receiptNumber?.trim() || null,
      notes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
      createdBy: actorUserId,
    })
    .returning()
  if (shift) {
    await tx.insert(cashMovement).values({
      organizationId: orgId,
      shiftId: shift.id,
      direction: "egreso",
      kind: "gasto",
      amountCents: row.amountCents,
      currency: row.currency,
      concept: row.concept,
      expenseId: row.id,
      createdBy: actorUserId,
    })
  }
  await audit(tx, orgId, actorUserId, "expense", row.id, "finance.expense_created")
  return row
}

export async function listExpenses(
  tx: Db,
  orgId: string,
  query: { branchId?: string; from?: string; to?: string; limit?: number },
) {
  const filters = [eq(expense.organizationId, orgId), isNull(expense.voidedAt)]
  if (query.branchId) filters.push(eq(expense.branchId, query.branchId))
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
  query: { patientId?: string } = {},
) {
  const chargeFilter = [eq(patientCharge.organizationId, orgId), isNull(patientCharge.voidedAt)]
  if (query.patientId) chargeFilter.push(eq(patientCharge.patientId, query.patientId))
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
  const plans = await tx
    .select()
    .from(installmentPlan)
    .where(
      and(
        eq(installmentPlan.organizationId, orgId),
        eq(installmentPlan.patientId, patientId),
        isNull(installmentPlan.voidedAt),
      ),
    )
  const quotas =
    plans.length === 0
      ? []
      : await tx
          .select()
          .from(installmentQuota)
          .where(
            and(
              eq(installmentQuota.organizationId, orgId),
              sql`${installmentQuota.planId} IN (${sql.join(
                plans.map((p) => sql`${p.id}`),
                sql`, `,
              )})`,
            ),
          )
          .orderBy(asc(installmentQuota.dueAt), asc(installmentQuota.nro))
  return {
    byCurrency: [...byCurrency.entries()].map(([unit, entry]) => ({ currency: unit, ...entry })),
    charges: rows,
    payments: livePayments,
    plans: plans.map((plan) => ({
      plan,
      quotas: quotas.filter((q) => q.planId === plan.id),
    })),
  }
}

// --- Planes de cuotas -----------------------------------------------------------------

export interface CreateInstallmentPlanInput {
  chargeId: string
  installments: number
  firstDueAt: string
  notes?: string | null
}

/**
 * Calendariza un cargo existente en cuotas. No crea deuda nueva: el total del
 * plan es el monto del cargo y las cuotas reparten ese mismo importe
 * (el resto del redondeo va a la última cuota).
 */
export async function createInstallmentPlan(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateInstallmentPlanInput,
) {
  const count = input.installments
  if (!Number.isSafeInteger(count) || count < 1 || count > 60)
    throw validation("Las cuotas deben ser entre 1 y 60")
  const first = day(input.firstDueAt)
  const [charge] = await tx
    .select()
    .from(patientCharge)
    .where(
      and(
        eq(patientCharge.id, input.chargeId),
        eq(patientCharge.organizationId, orgId),
        eq(patientCharge.patientId, patientId),
      ),
    )
  if (!charge) throw notFound("Cargo")
  if (charge.voidedAt) throw conflict("CHARGE_VOIDED", "El cargo está anulado")
  try {
    const [plan] = await tx
      .insert(installmentPlan)
      .values({
        organizationId: orgId,
        patientId,
        chargeId: charge.id,
        currency: charge.currency,
        totalCents: charge.amountCents,
        installments: count,
        status: "vigente",
        notes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
        createdBy: actorUserId,
      })
      .returning()
    if (!plan) throw new ServiceError("INTERNAL", 409, "No se pudo crear el plan de cuotas")
    const base = Math.floor(charge.amountCents / count)
    const start = new Date(`${first}T00:00:00.000Z`)
    const values = Array.from({ length: count }, (_, i) => {
      const due = new Date(start)
      due.setUTCMonth(due.getUTCMonth() + i)
      return {
        organizationId: orgId,
        planId: plan.id,
        nro: i + 1,
        dueAt: due.toISOString().slice(0, 10),
        amountCents: i === count - 1 ? charge.amountCents - base * (count - 1) : base,
        status: "pendiente",
      }
    })
    await tx.insert(installmentQuota).values(values)
    await audit(tx, orgId, actorUserId, "installment_plan", plan.id, "finance.plan_created")
    return plan
  } catch (e) {
    if (isUniqueViolation(e))
      throw conflict("PLAN_EXISTS", "Ese cargo ya tiene un plan de cuotas vigente")
    throw e
  }
}

export async function listInstallmentPlans(
  tx: Db,
  orgId: string,
  query: { patientId?: string } = {},
) {
  const filters = [eq(installmentPlan.organizationId, orgId), isNull(installmentPlan.voidedAt)]
  if (query.patientId) filters.push(eq(installmentPlan.patientId, query.patientId))
  const plans = await tx
    .select()
    .from(installmentPlan)
    .where(and(...filters))
    .orderBy(desc(installmentPlan.createdAt), desc(installmentPlan.id))
  const quotas =
    plans.length === 0
      ? []
      : await tx
          .select()
          .from(installmentQuota)
          .where(
            and(
              eq(installmentQuota.organizationId, orgId),
              sql`${installmentQuota.planId} IN (${sql.join(
                plans.map((p) => sql`${p.id}`),
                sql`, `,
              )})`,
            ),
          )
          .orderBy(asc(installmentQuota.nro), asc(installmentQuota.id))
  return plans.map((plan) => ({ plan, quotas: quotas.filter((q) => q.planId === plan.id) }))
}

async function recalcPlan(
  tx: Db,
  orgId: string,
  plan: typeof installmentPlan.$inferSelect,
): Promise<void> {
  const applications = await tx
    .select()
    .from(patientPaymentApplication)
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        eq(patientPaymentApplication.chargeId, plan.chargeId),
        isNull(patientPaymentApplication.voidedAt),
      ),
    )
  const applied = sumCents(applications.map((a) => ({ amountCents: a.amountCents })))
  const quotas = await tx
    .select()
    .from(installmentQuota)
    .where(
      and(eq(installmentQuota.organizationId, orgId), eq(installmentQuota.planId, plan.id)),
    )
    .orderBy(asc(installmentQuota.nro))
  const today = new Date().toISOString().slice(0, 10)
  let remaining = applied
  for (const quota of quotas) {
    const paid = Math.min(remaining, quota.amountCents)
    remaining -= paid
    const status =
      paid >= quota.amountCents ? "pagada" : paid > 0 ? "parcial" : quota.dueAt < today ? "vencida" : "pendiente"
    await tx
      .update(installmentQuota)
      .set({
        paidCents: paid,
        status,
        paidAt: paid >= quota.amountCents ? (quota.paidAt ?? new Date()) : null,
        updatedAt: new Date(),
      })
      .where(eq(installmentQuota.id, quota.id))
  }
  const saldada = applied >= plan.totalCents
  if ((saldada && plan.status !== "saldada") || (!saldada && plan.status === "saldada")) {
    await tx
      .update(installmentPlan)
      .set({ status: saldada ? "saldada" : "vigente", updatedAt: new Date() })
      .where(eq(installmentPlan.id, plan.id))
  }
}

/**
 * Recalcula el avance de un plan desde las aplicaciones reales del cargo:
 * reparte lo aplicado en orden de cuotas y marca pagadas/parciales/vencidas.
 * El cargo y sus aplicaciones no se tocan.
 */
export async function refreshInstallmentPlan(
  tx: Db,
  orgId: string,
  actorUserId: string,
  planId: string,
) {
  const [plan] = await tx
    .select()
    .from(installmentPlan)
    .where(and(eq(installmentPlan.id, planId), eq(installmentPlan.organizationId, orgId)))
  if (!plan) throw notFound("Plan de cuotas")
  if (plan.voidedAt) throw conflict("PLAN_VOIDED", "El plan está anulado")
  await recalcPlan(tx, orgId, plan)
  await audit(tx, orgId, actorUserId, "installment_plan", plan.id, "finance.plan_refreshed")
  return listInstallmentPlans(tx, orgId, {}).then((all) => all.find((p) => p.plan.id === plan.id))
}

/**
 * Recalcula el plan vigente de un cargo tras aplicar, anular o devolver pagos.
 * Lo invoca el dominio de pagos en la misma transacción: las cuotas nunca se
 * actualizan a mano. Sin plan vigente no hace nada.
 */
export async function refreshPlansForCharge(
  tx: Db,
  orgId: string,
  actorUserId: string,
  chargeId: string,
): Promise<void> {
  const [plan] = await tx
    .select()
    .from(installmentPlan)
    .where(
      and(
        eq(installmentPlan.organizationId, orgId),
        eq(installmentPlan.chargeId, chargeId),
        isNull(installmentPlan.voidedAt),
      ),
    )
  if (!plan) return
  await recalcPlan(tx, orgId, plan)
  await audit(tx, orgId, actorUserId, "installment_plan", plan.id, "finance.plan_auto_refreshed")
}

/**
 * Anula el plan vigente de un cargo anulado: sin cargo no hay calendarización.
 * Conserva el plan como histórico anulado (nunca se borra).
 */
export async function voidPlansForCharge(
  tx: Db,
  orgId: string,
  actorUserId: string,
  chargeId: string,
): Promise<void> {
  const [plan] = await tx
    .select()
    .from(installmentPlan)
    .where(
      and(
        eq(installmentPlan.organizationId, orgId),
        eq(installmentPlan.chargeId, chargeId),
        isNull(installmentPlan.voidedAt),
      ),
    )
  if (!plan) return
  await tx
    .update(installmentPlan)
    .set({
      status: "anulada",
      voidedAt: new Date(),
      voidedBy: actorUserId,
      voidReason: "Cargo anulado",
      updatedAt: new Date(),
    })
    .where(eq(installmentPlan.id, plan.id))
  await audit(tx, orgId, actorUserId, "installment_plan", plan.id, "finance.plan_voided")
}

export async function voidInstallmentPlan(
  tx: Db,
  orgId: string,
  actorUserId: string,
  planId: string,
  input: { reason: string },
) {
  const [current] = await tx
    .select()
    .from(installmentPlan)
    .where(and(eq(installmentPlan.id, planId), eq(installmentPlan.organizationId, orgId)))
  if (!current) throw notFound("Plan de cuotas")
  if (current.voidedAt) throw conflict("PLAN_VOIDED", "El plan ya está anulado")
  const [row] = await tx
    .update(installmentPlan)
    .set({
      status: "anulada",
      voidedAt: new Date(),
      voidedBy: actorUserId,
      voidReason: reason(input.reason),
      updatedAt: new Date(),
    })
    .where(and(eq(installmentPlan.id, planId), eq(installmentPlan.organizationId, orgId)))
    .returning()
  await audit(tx, orgId, actorUserId, "installment_plan", planId, "finance.plan_voided")
  return row
}

// --- Comisiones --------------------------------------------------------------------------

export interface UpsertCommissionRuleInput {
  professionalUserId: string
  base: "cobrado" | "produccion"
  rateBps: number
  serviceId?: string | null
  branchId?: string | null
  validFrom?: string | null
  validTo?: string | null
}

/** Crea o actualiza la regla general o específica de un profesional. */
export async function upsertCommissionRule(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: UpsertCommissionRuleInput,
) {
  await requireProfessional(tx, orgId, input.professionalUserId)
  if (!COMMISSION_BASES.includes(input.base)) throw validation("Base de comisión inválida")
  if (!Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 10000)
    throw validation("La tasa debe estar entre 0 y 10000 puntos básicos")
  if (input.branchId) await requireBranch(tx, orgId, input.branchId)
  if (input.validFrom) day(input.validFrom)
  if (input.validTo) day(input.validTo)
  if (input.validFrom && input.validTo && input.validTo < input.validFrom)
    throw validation("El fin de vigencia no puede ser anterior al inicio")
  const existing = await tx
    .select()
    .from(commissionRule)
    .where(
      and(
        eq(commissionRule.organizationId, orgId),
        eq(commissionRule.professionalUserId, input.professionalUserId),
        eq(commissionRule.base, input.base),
        input.serviceId
          ? eq(commissionRule.serviceId, input.serviceId)
          : isNull(commissionRule.serviceId),
        input.branchId
          ? eq(commissionRule.branchId, input.branchId)
          : isNull(commissionRule.branchId),
      ),
    )
  if (existing[0]) {
    const [row] = await tx
      .update(commissionRule)
      .set({
        rateBps: input.rateBps,
        isActive: true,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        updatedAt: new Date(),
      })
      .where(eq(commissionRule.id, existing[0].id))
      .returning()
    await audit(tx, orgId, actorUserId, "commission_rule", row.id, "finance.rule_updated")
    return row
  }
  const [row] = await tx
    .insert(commissionRule)
    .values({
      organizationId: orgId,
      professionalUserId: input.professionalUserId,
      base: input.base,
      rateBps: input.rateBps,
      serviceId: input.serviceId ?? null,
      branchId: input.branchId ?? null,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "commission_rule", row.id, "finance.rule_created")
  return row
}

export async function listCommissionRules(
  tx: Db,
  orgId: string,
  query: { professionalUserId?: string } = {},
) {
  const filters = [eq(commissionRule.organizationId, orgId)]
  if (query.professionalUserId)
    filters.push(eq(commissionRule.professionalUserId, query.professionalUserId))
  return tx
    .select()
    .from(commissionRule)
    .where(and(...filters))
    .orderBy(asc(commissionRule.professionalUserId), asc(commissionRule.id))
}

interface CommissionSource {
  applicationId: string | null
  chargeId: string | null
  paymentId: string | null
  patientId: string | null
  description: string
  baseCents: number
  occurredAt: Date
  serviceId: string | null
  branchId: string | null
}

/**
 * Clave única de la fuente: cada aplicación parcial es una fuente distinta en
 * cobrado; cada cargo lo es en producción. Respaldada por unique parcial.
 */
function sourceKeyOf(base: "cobrado" | "produccion", source: CommissionSource): string {
  return base === "cobrado" ? `app:${source.applicationId}` : `charge:${source.chargeId}`
}

/**
 * Hechos comisionables de un profesional en un periodo.
 * - Producción: cargos vigentes atribuidos por la atención
 *   (`encounter.dentist_user_id`; manuales sin procedimiento, a su creador).
 * - Cobrado: aplicaciones vigentes sobre esos mismos cargos.
 */
async function commissionSources(
  tx: Db,
  orgId: string,
  professionalUserId: string,
  base: "cobrado" | "produccion",
  from: string,
  to: string,
  unit: string,
): Promise<CommissionSource[]> {
  const fromAt = new Date(`${from}T00:00:00.000Z`)
  const toAt = new Date(`${to}T23:59:59.999Z`)
  const charges = await tx
    .select({
      charge: patientCharge,
      dentistUserId: encounter.dentistUserId,
      branchId: encounter.branchId,
      serviceId: encounterProcedure.serviceId,
    })
    .from(patientCharge)
    .leftJoin(
      encounterProcedure,
      and(
        eq(encounterProcedure.id, patientCharge.encounterProcedureId),
        eq(encounterProcedure.organizationId, orgId),
      ),
    )
    .leftJoin(
      encounter,
      and(eq(encounter.id, encounterProcedure.encounterId), eq(encounter.organizationId, orgId)),
    )
    .where(
      and(
        eq(patientCharge.organizationId, orgId),
        isNull(patientCharge.voidedAt),
        eq(patientCharge.currency, unit),
        gte(patientCharge.createdAt, fromAt),
        lte(patientCharge.createdAt, toAt),
      ),
    )
  const mine = charges.filter(
    (c) =>
      (c.dentistUserId ?? c.charge.createdBy) === professionalUserId,
  )
  if (base === "produccion") {
    return mine.map((c) => ({
      applicationId: null,
      chargeId: c.charge.id,
      paymentId: null,
      patientId: c.charge.patientId,
      description: c.charge.description,
      baseCents: c.charge.amountCents,
      occurredAt: c.charge.createdAt,
      serviceId: c.serviceId,
      branchId: c.branchId,
    }))
  }
  const mineIds = new Set(mine.map((c) => c.charge.id))
  if (mineIds.size === 0) return []
  const applications = await tx
    .select({ app: patientPaymentApplication, payment: patientPayment })
    .from(patientPaymentApplication)
    .innerJoin(
      patientPayment,
      and(
        eq(patientPayment.id, patientPaymentApplication.paymentId),
        eq(patientPayment.organizationId, orgId),
      ),
    )
    .where(
      and(
        eq(patientPaymentApplication.organizationId, orgId),
        isNull(patientPaymentApplication.voidedAt),
        isNull(patientPayment.voidedAt),
        gte(patientPaymentApplication.createdAt, fromAt),
        lte(patientPaymentApplication.createdAt, toAt),
      ),
    )
  const byCharge = new Map(mine.map((c) => [c.charge.id, c]))
  const sources: CommissionSource[] = []
  for (const { app } of applications) {
    const owner = byCharge.get(app.chargeId)
    if (!owner || !mineIds.has(app.chargeId)) continue
    sources.push({
      applicationId: app.id,
      chargeId: app.chargeId,
      paymentId: app.paymentId,
      patientId: app.patientId,
      description: owner.charge.description,
      baseCents: app.amountCents,
      occurredAt: app.createdAt,
      serviceId: owner.serviceId,
      branchId: owner.branchId,
    })
  }
  return sources
}

function pickRate(
  rules: Array<typeof commissionRule.$inferSelect>,
  source: CommissionSource,
  at: string,
): number {
  const valid = rules.filter(
    (r) =>
      r.isActive &&
      (!r.validFrom || r.validFrom <= at) &&
      (!r.validTo || at <= r.validTo),
  )
  const score = (r: (typeof valid)[number]): number =>
    (r.serviceId && r.serviceId === source.serviceId ? 2 : r.serviceId ? -1 : 0) +
    (r.branchId && r.branchId === source.branchId ? 1 : r.branchId ? -1 : 0)
  let best: (typeof valid)[number] | null = null
  let bestScore = -2
  for (const rule of valid) {
    const s = score(rule)
    if (s < 0) continue
    if (s > bestScore) {
      best = rule
      bestScore = s
    }
  }
  return best?.rateBps ?? 0
}

/** Vista previa trazable: cada línea muestra su origen y la tasa aplicada. */
export async function previewCommissions(
  tx: Db,
  orgId: string,
  query: {
    professionalUserId: string
    base: "cobrado" | "produccion"
    from: string
    to: string
    currency: string
  },
) {
  await requireProfessional(tx, orgId, query.professionalUserId)
  if (!COMMISSION_BASES.includes(query.base)) throw validation("Base de comisión inválida")
  const unit = currency(query.currency)
  const from = day(query.from)
  const to = day(query.to)
  if (to < from) throw validation("El fin del periodo no puede ser anterior al inicio")
  const rules = await tx
    .select()
    .from(commissionRule)
    .where(
      and(
        eq(commissionRule.organizationId, orgId),
        eq(commissionRule.professionalUserId, query.professionalUserId),
        eq(commissionRule.base, query.base),
      ),
    )
  const sources = await commissionSources(tx, orgId, query.professionalUserId, query.base, from, to, unit)
  // Fuentes ya liquidadas en liquidaciones vigentes: ni la vista previa ni la
  // liquidación las repiten (periodos solapados o reintentos no duplican).
  const settledRows = await tx
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
        eq(commissionSettlement.professionalUserId, query.professionalUserId),
        eq(commissionSettlement.base, query.base),
      ),
    )
  const settled = new Set(settledRows.map((r) => r.sourceKey))
  const fresh = sources.filter((source) => !settled.has(sourceKeyOf(query.base, source)))
  const lines = fresh.map((source) => {
    const at = source.occurredAt.toISOString().slice(0, 10)
    const rate = pickRate(rules, source, at)
    return {
      ...source,
      sourceKey: sourceKeyOf(query.base, source),
      rateBps: rate,
      commissionCents: Math.floor((source.baseCents * rate) / 10000),
    }
  })
  return {
    lines,
    baseCents: sumCents(lines.map((l) => ({ amountCents: l.baseCents }))),
    commissionCents: sumCents(lines.map((l) => ({ amountCents: l.commissionCents }))),
  }
}

export interface SettleCommissionsInput {
  professionalUserId: string
  base: "cobrado" | "produccion"
  from: string
  to: string
  currency: string
  notes?: string | null
}

/** Liquida el periodo: congela líneas trazables para consulta posterior. */
export async function settleCommissions(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: SettleCommissionsInput,
) {
  const preview = await previewCommissions(tx, orgId, input)
  if (preview.lines.length === 0)
    throw conflict("SETTLEMENT_EMPTY", "No hay fuentes pendientes de liquidar en ese periodo")
  const [settlement] = await tx
    .insert(commissionSettlement)
    .values({
      organizationId: orgId,
      professionalUserId: input.professionalUserId,
      periodFrom: day(input.from),
      periodTo: day(input.to),
      base: input.base,
      currency: currency(input.currency),
      baseCents: preview.baseCents,
      commissionCents: preview.commissionCents,
      status: "liquidada",
      notes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
      settledBy: actorUserId,
      settledAt: new Date(),
    })
    .returning()
  if (!settlement) throw new ServiceError("INTERNAL", 409, "No se pudo liquidar")
  try {
    for (const line of preview.lines) {
      await tx.insert(commissionSettlementLine).values({
        organizationId: orgId,
        settlementId: settlement.id,
        sourceKey: line.sourceKey,
        chargeId: line.chargeId,
        paymentId: line.paymentId,
        patientId: line.patientId,
        description: `${line.description} (${line.rateBps / 100} %)`,
        baseCents: line.baseCents,
        commissionCents: line.commissionCents,
        occurredAt: line.occurredAt,
      })
    }
  } catch (e) {
    // Carreras entre liquidaciones concurrentes: la unique parcial por fuente
    // deja pasar una sola; la otra recibe 409 sin comisionar dos veces.
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
    body: `Periodo ${input.from} al ${input.to}: ${preview.commissionCents} centavos (${input.currency}).`,
    href: `/finance?liquidacion=${settlement.id}`,
    permission: "finance.read",
  })
  return settlement
}

export async function listSettlements(
  tx: Db,
  orgId: string,
  query: { professionalUserId?: string } = {},
) {
  const filters = [eq(commissionSettlement.organizationId, orgId), isNull(commissionSettlement.voidedAt)]
  if (query.professionalUserId)
    filters.push(eq(commissionSettlement.professionalUserId, query.professionalUserId))
  return tx
    .select()
    .from(commissionSettlement)
    .where(and(...filters))
    .orderBy(desc(commissionSettlement.periodFrom), desc(commissionSettlement.id))
}

export async function getSettlementDetail(tx: Db, orgId: string, settlementId: string) {
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
  return { settlement, lines }
}

export async function voidSettlement(
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
  await audit(tx, orgId, actorUserId, "commission_settlement", settlementId, "finance.settlement_voided")
  return row
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
