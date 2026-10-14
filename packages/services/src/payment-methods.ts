import type { Db } from "@odentia/db"
import { organizationPaymentMethod } from "@odentia/db/schema/org-payments"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, eq, max } from "drizzle-orm"
import { notFound, validation } from "./errors.js"

export type PaymentMethodRow = typeof organizationPaymentMethod.$inferSelect

/** Tipos UN/CEFACT 4461 (UBL 2.1 / EN 16931) admitidos por la clínica. */
export const PAYMENT_TYPE_CODES = ["10", "48", "30", "68", "20", "1"] as const
export type PaymentTypeCode = (typeof PAYMENT_TYPE_CODES)[number]

/** Solo el efectivo se cuenta al cerrar caja; los demás piden número de operación. */
export function isCashLike(typeCode: string): boolean {
  return typeCode === "10"
}

function assertName(name: string | null | undefined): string {
  const value = name?.trim() ?? ""
  if (!value || value.length > 120) throw validation("name debe tener 1–120 caracteres")
  return value
}

function assertTypeCode(typeCode: string | null | undefined): PaymentTypeCode {
  const value = (typeCode ?? "1").trim()
  if (!(PAYMENT_TYPE_CODES as readonly string[]).includes(value)) {
    throw validation("typeCode inválido: usa la lista UN/CEFACT 4461 (10|48|30|68|20|1)")
  }
  return value as PaymentTypeCode
}

function assertSortOrder(sortOrder: number | null | undefined): number {
  if (sortOrder === null || sortOrder === undefined) return 0
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 9999) {
    throw validation("sortOrder debe ser un entero entre 0 y 9999")
  }
  return sortOrder
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  action: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "organization_payment_method",
    entityId,
    metadata: metadata ?? null,
  })
}

/**
 * Medios que ofrece caja al cobrar (solo activos, en orden de la clínica).
 * El agente responde con esta misma lista. Apagar un medio no altera el
 * snapshot congelado en cobros anteriores.
 */
export async function listPaymentMethods(
  tx: Db,
  orgId: string,
  options: { activeOnly?: boolean } = {},
): Promise<PaymentMethodRow[]> {
  const conditions = [eq(organizationPaymentMethod.organizationId, orgId)]
  if (options.activeOnly ?? true) {
    conditions.push(eq(organizationPaymentMethod.isActive, true))
  }
  return tx
    .select()
    .from(organizationPaymentMethod)
    .where(and(...conditions))
    .orderBy(asc(organizationPaymentMethod.sortOrder), asc(organizationPaymentMethod.name))
}

/** Medio exigible para un cobro nuevo: existe y está activo. */
export async function requirePaymentMethod(
  tx: Db,
  orgId: string,
  id: string,
): Promise<PaymentMethodRow> {
  const [row] = await tx
    .select()
    .from(organizationPaymentMethod)
    .where(
      and(
        eq(organizationPaymentMethod.id, id),
        eq(organizationPaymentMethod.organizationId, orgId),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Medio de pago")
  if (!row.isActive) throw validation("El medio de pago no está activo")
  return row
}

export interface CreatePaymentMethodInput {
  name: string
  typeCode?: string | null
  sortOrder?: number | null
  /** Sin puesto indicado, va al final de la lista de la clínica (lo que hace la pantalla). */
  atEnd?: boolean
}

/** Separación entre puestos: deja sitio y hace legible el orden guardado. */
const SORT_STEP = 10
const SORT_MAX = 9999

/** Puesto siguiente al último medio de la clínica. */
async function lastSortOrder(tx: Db, orgId: string): Promise<number> {
  const [row] = await tx
    .select({ last: max(organizationPaymentMethod.sortOrder) })
    .from(organizationPaymentMethod)
    .where(eq(organizationPaymentMethod.organizationId, orgId))
  return row?.last === null || row?.last === undefined ? 0 : Math.min(row.last + SORT_STEP, SORT_MAX)
}

export async function createPaymentMethod(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreatePaymentMethodInput,
): Promise<PaymentMethodRow> {
  const sortOrder =
    input.atEnd && (input.sortOrder === null || input.sortOrder === undefined)
      ? await lastSortOrder(tx, orgId)
      : assertSortOrder(input.sortOrder)
  const [row] = await tx
    .insert(organizationPaymentMethod)
    .values({
      organizationId: orgId,
      name: assertName(input.name),
      typeCode: assertTypeCode(input.typeCode),
      sortOrder,
      isActive: true,
    })
    .returning()
  if (!row) throw new Error("No se pudo crear el medio de pago")
  await audit(tx, orgId, actorUserId, "settings.payment_method_created", row.id, {
    name: row.name,
    typeCode: row.typeCode,
  })
  return row
}

export interface UpdatePaymentMethodPatch {
  name?: string
  typeCode?: string
  sortOrder?: number | null
  isActive?: boolean
}

export async function updatePaymentMethod(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  patch: UpdatePaymentMethodPatch,
): Promise<PaymentMethodRow> {
  const current = await requirePaymentMethodAll(tx, orgId, id)
  const set: Partial<typeof organizationPaymentMethod.$inferInsert> = {}
  const fields: string[] = []
  if (patch.name !== undefined) {
    set.name = assertName(patch.name)
    fields.push("name")
  }
  if (patch.typeCode !== undefined) {
    set.typeCode = assertTypeCode(patch.typeCode)
    fields.push("typeCode")
  }
  if (patch.sortOrder !== undefined) {
    set.sortOrder = assertSortOrder(patch.sortOrder)
    fields.push("sortOrder")
  }
  if (patch.isActive !== undefined) {
    set.isActive = patch.isActive
    fields.push("isActive")
  }
  if (fields.length === 0) throw validation("Sin cambios: patch vacío")
  const [updated] = await tx
    .update(organizationPaymentMethod)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(
        eq(organizationPaymentMethod.id, id),
        eq(organizationPaymentMethod.organizationId, orgId),
      ),
    )
    .returning()
  if (!updated) throw notFound("Medio de pago")
  await audit(tx, orgId, actorUserId, "settings.payment_method_updated", id, {
    fields,
    wasActive: current.isActive,
  })
  return updated
}

export type PaymentMethodMove = "up" | "down"

/**
 * Sube o baja un medio un puesto en la lista de la clínica: la que caja ofrece
 * al cobrar y la que responde el agente, en ese orden. Los puestos se
 * renumeran enteros para que el orden no dependa de empates por nombre. En un
 * extremo de la lista no cambia nada. Devuelve la lista como queda.
 */
export async function movePaymentMethod(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  direction: PaymentMethodMove,
): Promise<PaymentMethodRow[]> {
  if (direction !== "up" && direction !== "down") throw validation("direction debe ser up|down")
  // Se bloquea la lista entera: dos cambios de orden a la vez no se pisan.
  const rows = await tx
    .select()
    .from(organizationPaymentMethod)
    .where(eq(organizationPaymentMethod.organizationId, orgId))
    .orderBy(asc(organizationPaymentMethod.sortOrder), asc(organizationPaymentMethod.name))
    .for("update")
  const from = rows.findIndex((row) => row.id === id)
  const moved = rows[from]
  if (!moved) throw notFound("Medio de pago")
  const to = direction === "up" ? from - 1 : from + 1
  const neighbor = rows[to]
  if (!neighbor) return rows
  const ordered = [...rows]
  ordered[from] = neighbor
  ordered[to] = moved
  if ((ordered.length - 1) * SORT_STEP > SORT_MAX) {
    throw validation("Hay demasiados medios de pago para reordenarlos")
  }
  for (const [position, row] of ordered.entries()) {
    const sortOrder = position * SORT_STEP
    if (row.sortOrder === sortOrder) continue
    await tx
      .update(organizationPaymentMethod)
      .set({ sortOrder, updatedAt: new Date() })
      .where(
        and(
          eq(organizationPaymentMethod.id, row.id),
          eq(organizationPaymentMethod.organizationId, orgId),
        ),
      )
  }
  await audit(tx, orgId, actorUserId, "settings.payment_method_moved", id, { direction })
  return listPaymentMethods(tx, orgId, { activeOnly: false })
}

async function requirePaymentMethodAll(
  tx: Db,
  orgId: string,
  id: string,
): Promise<PaymentMethodRow> {
  const [row] = await tx
    .select()
    .from(organizationPaymentMethod)
    .where(
      and(
        eq(organizationPaymentMethod.id, id),
        eq(organizationPaymentMethod.organizationId, orgId),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Medio de pago")
  return row
}

export interface CountryPaymentPreset {
  name: string
  typeCode: PaymentTypeCode
  sortOrder: number
}

/** Lista inicial según el país de la clínica (datos, no código de cobro). */
export function paymentPresetsForCountry(countryCode: string): CountryPaymentPreset[] {
  const common: CountryPaymentPreset[] = [
    { name: "Efectivo", typeCode: "10", sortOrder: 0 },
    { name: "Tarjeta", typeCode: "48", sortOrder: 30 },
    { name: "Transferencia", typeCode: "30", sortOrder: 40 },
  ]
  if (countryCode.trim().toUpperCase() === "PE") {
    return [
      { name: "Efectivo", typeCode: "10", sortOrder: 0 },
      { name: "Yape", typeCode: "68", sortOrder: 10 },
      { name: "Plin", typeCode: "68", sortOrder: 20 },
      { name: "Tarjeta", typeCode: "48", sortOrder: 30 },
      { name: "Transferencia", typeCode: "30", sortOrder: 40 },
    ]
  }
  return common
}

/**
 * Inicializa los medios al crear la organización y como backfill: solo si la
 * clínica aún no tiene ninguno. Idempotente y segura ante concurrencia.
 */
export async function ensureDefaultPaymentMethods(
  tx: Db,
  orgId: string,
  actorUserId: string,
  countryCode: string,
): Promise<PaymentMethodRow[]> {
  const [profile] = await tx
    .select({ id: orgProfile.organizationId })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .for("update")
  if (!profile) throw notFound("Perfil de organización")
  const existing = await listPaymentMethods(tx, orgId, { activeOnly: false })
  if (existing.length > 0) return existing
  const presets = paymentPresetsForCountry(countryCode)
  for (const preset of presets) {
    await createPaymentMethod(tx, orgId, actorUserId, preset)
  }
  return listPaymentMethods(tx, orgId, { activeOnly: false })
}
