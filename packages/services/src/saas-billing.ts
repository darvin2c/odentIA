/**
 * Facturación SaaS: planes por moneda, suscripción con
 * prueba/gracia/pausa, cobranza manual con comprobantes privados, pagos
 * parciales/reversos/devoluciones, comisiones de vendedor sobre cobro
 * confirmado y guard de restricción comercial.
 *
 * Convención del repo: cada función recibe un `tx: Db` que YA corre con
 * tenant (withOrgContext) o con rol owner (tick admin); los servicios nunca
 * abren el contexto. Dinero en enteros de la unidad menor, moneda ISO 4217.
 * Sin pasarela ni precios en código: los planes y métodos los configura admin.
 */
import type { Db } from "@odentia/db"
import type { MailTemplate } from "@odentia/mail"
import { agentRunLedger } from "@odentia/db/schema/agent"
import { invitation, member, organization, user } from "@odentia/db/schema/auth"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import {
  type SaasChargeStatus,
  type SaasSubscriptionStatus,
  saasCharge,
  saasCommissionAdjustment,
  saasCommissionSettlement,
  saasCommissionSettlementLine,
  saasNotice,
  saasPayment,
  saasPaymentMethod,
  saasPlan,
  saasSeller,
  saasSellerCommission,
  saasSubscription,
} from "@odentia/db/schema/saas-billing"
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { sniffFileContent } from "./file-content.js"
import { getOrgLocale } from "./locale.js"
import { assertActionPricingFloor } from "./saas-actions.js"
import { getSaasAlerts } from "./saas-terms.js"
import {
  saasAlertEmail,
  saasBillingUrl,
  saasChargeIssuedEmail,
  saasRestrictionSoonEmail,
  saasOverdueEmail,
  saasPlanStartedEmail,
  saasRestrictedEmail,
  saasSettlementEmail,
  saasTrialEndedEmail,
} from "./saas-emails.js"
import { clearExpiredDiscounts, endFounderGuarantees } from "./saas-founders.js"
import { addMonth, closeSaasPeriods, overdueChargeOrgs } from "./saas-invoicing.js"

/** Lo que se guarda en el aviso: el buzón de respuesta no aplica a Plan y pagos. */
const mailParts = (mail: MailTemplate) => ({ subject: mail.subject, text: mail.text, html: mail.html })

/** Días de prueba al crear la suscripción. */
/** Prueba cuando ningún plan dice la suya (ADR 0031: 30 días). */
export const SAAS_TRIAL_DAYS = 30
/** Días de gracia tras el vencimiento antes de restringir. */
export const SAAS_GRACE_DAYS = 7
/** Prórroga máxima (días) por comprobante pendiente; acotada, no aplaza sin límite. */
export const SAAS_PROOF_EXTENSION_DAYS = 3
/** Veces que se puede prorrogar un mismo cargo por comprobante pendiente. */
export const SAAS_PROOF_EXTENSION_MAX = 1

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

function currency(value: string): string {
  if (!/^[A-Z]{3}$/.test(value))
    throw validation("La moneda debe ser un código ISO 4217 de tres letras")
  return value
}

function assertCents(value: number, field: string, positive: boolean): number {
  if (!Number.isSafeInteger(value) || value > 2147483647 || (positive ? value <= 0 : value < 0))
    throw validation(
      positive
        ? `${field} debe ser un entero mayor que cero`
        : `${field} debe ser un entero entre 0 y 2147483647`,
    )
  return value
}

function reason(value: string, field = "El motivo"): string {
  const text = value?.trim() ?? ""
  if (!text || text.length > 2000) throw validation(`${field} debe tener 1–2000 caracteres`)
  return text
}

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
}
/** Ventana comisionable: los primeros 12 meses de la clínica (D5). */
export const SAAS_COMMISSION_MONTHS = 12

export function monthKeyUTC(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
}

export function monthStartUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

/** Fin del mes calendario (inicio del siguiente): sin deriva de 30 días. */
export function monthEndUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
}

export function addMonthsUTC(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1))
}

/**
 * Congela la atribución del vendedor en la suscripción (porcentaje, plazo e
 * inicio). Cambiar de vendedor cierra la anterior (`sellerEndedAt`) y abre
 * otra: lo futuro usa lo nuevo, lo pasado conserva lo suyo.
 */
export async function snapshotSaasSeller(
  tx: Db,
  orgId: string,
  sellerId: string,
  now = new Date(),
): Promise<void> {
  const [seller] = await tx.select().from(saasSeller).where(eq(saasSeller.id, sellerId)).limit(1)
  if (!seller) throw notFound("Vendedor")
  await tx
    .update(saasSubscription)
    .set({
      sellerId: seller.id,
      sellerRateBps: seller.rateBps,
      sellerWindowDays: seller.windowDays,
      sellerStartedAt: now,
      sellerEndedAt: null,
      updatedAt: now,
    })
    .where(eq(saasSubscription.organizationId, orgId))
}

/**
 * Asigna (o retira con null) el vendedor de la clínica. Solo admin (la ruta
 * lo exige; Organizations reserva sellerId de signup a admin con 403).
 */
export async function assignSaasSeller(
  tx: Db,
  orgId: string,
  actorUserId: string,
  sellerId: string | null,
  now = new Date(),
): Promise<SaasSubscriptionRow> {
  const current = await getSaasSubscription(tx, orgId)
  if (!current) throw notFound("Suscripción")
  if (sellerId) {
    await snapshotSaasSeller(tx, orgId, sellerId, now)
  } else {
    await tx
      .update(saasSubscription)
      .set({
        sellerId: null,
        sellerRateBps: null,
        sellerWindowDays: null,
        sellerEndedAt: now,
        updatedAt: now,
      })
      .where(eq(saasSubscription.organizationId, orgId))
  }
  await audit(tx, orgId, actorUserId, "saas_subscription", orgId, "saas.seller_assigned", {
    sellerId,
  })
  const updated = await getSaasSubscription(tx, orgId)
  if (!updated) throw new ServiceError("INTERNAL", 409, "No se pudo leer la suscripción")
  return updated
}

/** Fin de la ventana comisionable de la clínica (12 meses desde el alta). */
export function clinicCommissionCutoff(sub: {
  trialStartedAt: Date | null
  createdAt: Date
}): Date {
  const base = sub.trialStartedAt ?? sub.createdAt
  return addMonthsUTC(base, SAAS_COMMISSION_MONTHS)
}

/**
 * Asegura el cargo del mes (snapshot del plan vigente; el cambio de precio
 * rige el próximo cargo, jamás el pasado). Idempotente por
 * `periodo:AAAA-MM`: repetir devuelve el existente.
 */
export async function ensurePeriodCharge(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  monthKey: string,
  now = new Date(),
): Promise<SaasChargeRow | null> {
  const parts = monthKey.split("-")
  const year = Number(parts[0])
  const month = Number(parts[1])
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    parts.length !== 2
  )
    throw validation("Mes inválido (AAAA-MM)")
  const sub = await getSaasSubscription(tx, orgId)
  if (!sub || sub.isDemo || !sub.planId) return null
  const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
  if (!plan || !plan.isActive) return null
  const periodStart = new Date(Date.UTC(year, month - 1, 1))
  const periodEnd = new Date(Date.UTC(year, month, 1))
  const dedupeKey = `periodo:${monthKey}`
  const [row] = await tx
    .insert(saasCharge)
    .values({
      organizationId: orgId,
      planId: plan.id,
      planCode: plan.code,
      planName: plan.name,
      periodStart,
      periodEnd,
      amountCents: plan.priceCents,
      currency: plan.currency,
      dueAt: periodEnd,
      createdBy: actorUserId,
      dedupeKey,
    })
    .onConflictDoNothing({ target: [saasCharge.organizationId, saasCharge.dedupeKey] })
    .returning()
  if (row) {
    await audit(
      tx,
      orgId,
      actorUserId ?? "system",
      "saas_charge",
      row.id,
      "saas.charge_generated",
      {
        planCode: plan.code,
        month: monthKey,
      },
    )
    return toChargeRow(row)
  }
  const [existing] = await tx
    .select()
    .from(saasCharge)
    .where(and(eq(saasCharge.organizationId, orgId), eq(saasCharge.dedupeKey, dedupeKey)))
    .limit(1)
  return existing ? toChargeRow(existing) : null
}

/**
 * Genera el cargo del mes en curso a cada suscripción activa con plan (el
 * tick lo llama a diario; la cobranza sigue siendo manual: esto genera el
 * cargo, no el pago).
 */
export async function generateSaasPeriodCharges(tx: Db, now = new Date()): Promise<number> {
  const monthKey = monthKeyUTC(now)
  const subs = await tx
    .select({ organizationId: saasSubscription.organizationId })
    .from(saasSubscription)
    .where(
      and(
        eq(saasSubscription.status, "activa"),
        eq(saasSubscription.isDemo, false),
        isNotNull(saasSubscription.planId),
      ),
    )
  let ensured = 0
  for (const sub of subs) {
    const charge = await ensurePeriodCharge(tx, sub.organizationId, null, monthKey, now)
    if (charge) ensured += 1
  }
  return ensured
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
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    entity,
    entityId: id,
    action,
    ...(metadata ? { metadata } : {}),
  })
}

async function notifyOrg(tx: Db, orgId: string, kind: string): Promise<void> {
  const payload = { orgId, kind, at: new Date().toISOString() }
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

// --- Planes y métodos (admin; escritura con owner) -----------------------------

export interface SaasPlanInput {
  code: string
  name: string
  description?: string | null
  currency: string
  priceCents: number
  billingPeriod?: string | null
  maxBranches?: number | null
  maxSeats?: number | null
  sortOrder?: number
  /** Cobro por acción (ADR 0031). */
  creditCents?: number
  conversationMicros?: number | null
  consultationMicros?: number | null
  recoveryMicros?: number | null
  maxDiscountBps?: number
  sellerDiscountBps?: number
  trialCreditCents?: number
  trialDays?: number
  trialMaxCreditCents?: number
  trialMaxDays?: number
  isDefault?: boolean
  /** La web lo publica (Fundadores, decisión 14). */
  showOnWeb?: boolean
  /** Plan por invitación: lugares; null = sin tope. */
  seatLimit?: number | null
  /** Meses de condiciones garantizadas desde que la clínica entra. */
  guaranteeMonths?: number | null
}

export interface SaasPlanRow {
  id: string
  code: string
  name: string
  description: string | null
  currency: string
  priceCents: number
  billingPeriod: string
  maxBranches: number | null
  maxSeats: number | null
  isActive: boolean
  sortOrder: number
  creditCents: number
  conversationMicros: number | null
  consultationMicros: number | null
  recoveryMicros: number | null
  maxDiscountBps: number
  sellerDiscountBps: number
  trialCreditCents: number
  trialDays: number
  trialMaxCreditCents: number
  trialMaxDays: number
  isDefault: boolean
  showOnWeb: boolean
  seatLimit: number | null
  guaranteeMonths: number | null
  createdAt: Date
  updatedAt: Date
}

function toPlanRow(row: typeof saasPlan.$inferSelect): SaasPlanRow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    currency: row.currency,
    priceCents: row.priceCents,
    billingPeriod: row.billingPeriod,
    maxBranches: row.maxBranches,
    maxSeats: row.maxSeats,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    creditCents: row.creditCents,
    conversationMicros: row.conversationMicros,
    consultationMicros: row.consultationMicros,
    recoveryMicros: row.recoveryMicros,
    maxDiscountBps: row.maxDiscountBps,
    sellerDiscountBps: row.sellerDiscountBps,
    trialCreditCents: row.trialCreditCents,
    trialDays: row.trialDays,
    trialMaxCreditCents: row.trialMaxCreditCents,
    trialMaxDays: row.trialMaxDays,
    isDefault: row.isDefault,
    showOnWeb: row.showOnWeb,
    seatLimit: row.seatLimit,
    guaranteeMonths: row.guaranteeMonths,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function micros(value: number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 0) throw validation(`${field} debe ser un importe válido`)
  return value
}

function bps(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 9000) throw validation(`${field} debe estar entre 0 % y 90 %`)
  return value
}

/** Campos del cobro por acción de un plan, validados; los ausentes no se tocan. */
function actionTerms(value: Partial<SaasPlanInput>): Partial<typeof saasPlan.$inferInsert> {
  const terms: Partial<typeof saasPlan.$inferInsert> = {}
  if (value.creditCents !== undefined) terms.creditCents = assertCents(value.creditCents, "El crédito", false)
  if (value.conversationMicros !== undefined) terms.conversationMicros = micros(value.conversationMicros, "El precio de la conversación")
  if (value.consultationMicros !== undefined) terms.consultationMicros = micros(value.consultationMicros, "El precio de la consulta")
  if (value.recoveryMicros !== undefined) terms.recoveryMicros = micros(value.recoveryMicros, "El precio de la cita recuperada")
  if (value.maxDiscountBps !== undefined) terms.maxDiscountBps = bps(value.maxDiscountBps, "El descuento máximo")
  if (value.sellerDiscountBps !== undefined) terms.sellerDiscountBps = bps(value.sellerDiscountBps, "Lo que da el vendedor")
  if (value.trialCreditCents !== undefined) terms.trialCreditCents = assertCents(value.trialCreditCents, "El saldo de prueba", false)
  if (value.trialMaxCreditCents !== undefined) terms.trialMaxCreditCents = assertCents(value.trialMaxCreditCents, "El saldo máximo de prueba", false)
  if (value.trialDays !== undefined) terms.trialDays = value.trialDays
  if (value.trialMaxDays !== undefined) terms.trialMaxDays = value.trialMaxDays
  if (value.isDefault !== undefined) terms.isDefault = value.isDefault
  if (value.showOnWeb !== undefined) terms.showOnWeb = value.showOnWeb
  if (value.seatLimit !== undefined) {
    if (value.seatLimit !== null && (!Number.isInteger(value.seatLimit) || value.seatLimit < 1)) throw validation("Los lugares deben ser un número entero mayor que cero, o vacío")
    terms.seatLimit = value.seatLimit
  }
  if (value.guaranteeMonths !== undefined) {
    if (value.guaranteeMonths !== null && (!Number.isInteger(value.guaranteeMonths) || value.guaranteeMonths < 1 || value.guaranteeMonths > 120)) {
      throw validation("Los meses garantizados deben estar entre 1 y 120, o vacío")
    }
    terms.guaranteeMonths = value.guaranteeMonths
  }
  return terms
}

const PLAN_TERM_DEFAULTS = {
  creditCents: 0,
  conversationMicros: null,
  consultationMicros: null,
  recoveryMicros: null,
  maxDiscountBps: 6000,
  sellerDiscountBps: 1000,
  trialCreditCents: 0,
  trialDays: 30,
  trialMaxCreditCents: 0,
  trialMaxDays: 60,
}

/** Lo que la base no comprueba con un mensaje claro: límites coherentes y el precio mínimo. Antes de escribir. */
function assertPlanTerms(plan: Pick<typeof saasPlan.$inferSelect, keyof typeof PLAN_TERM_DEFAULTS | "currency">): void {
  if (plan.sellerDiscountBps > plan.maxDiscountBps) throw validation("El vendedor no puede dar más que el descuento máximo")
  if (plan.trialDays < 1 || plan.trialDays > 365) throw validation("La prueba debe durar entre 1 y 365 días")
  if (plan.trialMaxDays < plan.trialDays) throw validation("Los días máximos de prueba no pueden ser menos que los de siempre")
  if (plan.trialMaxCreditCents < plan.trialCreditCents) throw validation("El saldo máximo de prueba no puede ser menor que el de siempre")
  assertActionPricingFloor(plan)
}

/** Un solo plan por defecto: marcar uno desmarca el anterior. */
async function clearOtherDefaults(tx: Db, keepId: string | null): Promise<void> {
  await tx
    .update(saasPlan)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(keepId ? and(eq(saasPlan.isDefault, true), sql`${saasPlan.id} <> ${keepId}`) : eq(saasPlan.isDefault, true))
}

function planInput(value: SaasPlanInput): typeof saasPlan.$inferInsert {
  const code = value.code.trim()
  const name = value.name.trim()
  if (!code || code.length > 80) throw validation("El código del plan debe tener 1–80 caracteres")
  if (!name || name.length > 120) throw validation("El nombre del plan debe tener 1–120 caracteres")
  return {
    code,
    name,
    description: value.description?.trim() ? value.description.trim().slice(0, 2000) : null,
    currency: currency(value.currency),
    priceCents: assertCents(value.priceCents, "El precio", false),
    billingPeriod: value.billingPeriod?.trim() || "mensual",
    maxBranches: value.maxBranches ?? null,
    maxSeats: value.maxSeats ?? null,
    sortOrder: value.sortOrder ?? 0,
  }
}

/** Planes activos por moneda (lectura segura para panel y admin). */
export async function listSaasPlans(
  tx: Db,
  query: { currency?: string; includeInactive?: boolean; excludeInvitationOnly?: boolean } = {},
): Promise<SaasPlanRow[]> {
  const filters = []
  if (query.currency) filters.push(eq(saasPlan.currency, currency(query.currency)))
  if (!query.includeInactive) filters.push(eq(saasPlan.isActive, true))
  // Un plan con lugares (Fundadores) solo se entra por invitación: la clínica no lo elige.
  if (query.excludeInvitationOnly) filters.push(sql`${saasPlan.seatLimit} IS NULL`)
  const rows = await tx
    .select()
    .from(saasPlan)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(asc(saasPlan.sortOrder), asc(saasPlan.name))
  return rows.map(toPlanRow)
}

/**
 * Lo que recibe una clínica nueva al registrarse: el crédito y los días de
 * prueba del plan por defecto. Es lo único del catálogo que ve alguien sin
 * cuenta (el botón «Obtén USD 100 de crédito» del registro); sin plan por
 * defecto no hay oferta y la pantalla no promete un monto.
 */
export async function getPublicTrialOffer(
  tx: Db,
): Promise<{ currency: string; creditCents: number; days: number } | null> {
  const [plan] = await tx
    .select({ currency: saasPlan.currency, creditCents: saasPlan.trialCreditCents, days: saasPlan.trialDays })
    .from(saasPlan)
    .where(and(eq(saasPlan.isDefault, true), eq(saasPlan.isActive, true)))
    .limit(1)
  if (!plan) return null
  return { currency: plan.currency, creditCents: plan.creditCents, days: plan.days }
}

export async function createSaasPlan(
  tx: Db,
  actorUserId: string,
  input: SaasPlanInput,
): Promise<SaasPlanRow> {
  const values = { ...planInput(input), ...actionTerms(input) }
  assertPlanTerms({ ...PLAN_TERM_DEFAULTS, ...values, currency: values.currency })
  if (input.isDefault) await clearOtherDefaults(tx, null)
  const [row] = await tx.insert(saasPlan).values(values).returning()
  if (!row) throw new ServiceError("INTERNAL", 409, "No se pudo crear el plan")
  return toPlanRow(row)
}

export async function updateSaasPlan(
  tx: Db,
  actorUserId: string,
  planId: string,
  input: Partial<SaasPlanInput>,
): Promise<SaasPlanRow> {
  const patch: Partial<typeof saasPlan.$inferInsert> = {}
  if (input.code !== undefined) {
    const code = input.code.trim()
    if (!code || code.length > 80) throw validation("El código del plan debe tener 1–80 caracteres")
    patch.code = code
  }
  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name || name.length > 120)
      throw validation("El nombre del plan debe tener 1–120 caracteres")
    patch.name = name
  }
  if (input.description !== undefined)
    patch.description = input.description?.trim() ? input.description.trim().slice(0, 2000) : null
  if (input.currency !== undefined) patch.currency = currency(input.currency)
  if (input.priceCents !== undefined)
    patch.priceCents = assertCents(input.priceCents, "El precio", false)
  if (input.billingPeriod !== undefined)
    patch.billingPeriod = input.billingPeriod?.trim() || "mensual"
  if (input.maxBranches !== undefined) patch.maxBranches = input.maxBranches
  if (input.maxSeats !== undefined) patch.maxSeats = input.maxSeats
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder
  Object.assign(patch, actionTerms(input))
  const [current] = await tx.select().from(saasPlan).where(eq(saasPlan.id, planId)).limit(1)
  if (!current) throw notFound("Plan")
  assertPlanTerms({ ...current, ...patch })
  if (input.isDefault) await clearOtherDefaults(tx, planId)
  // Cambiar un precio rige lo que se cuenta desde ahora: lo ya contado y los cargos emitidos lo congelaron.
  const [row] = await tx
    .update(saasPlan)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(saasPlan.id, planId))
    .returning()
  if (!row) throw notFound("Plan")
  void actorUserId
  return toPlanRow(row)
}

/** Archiva un plan (no se borra: los cargos históricos conservan su snapshot). */
export async function archiveSaasPlan(
  tx: Db,
  actorUserId: string,
  planId: string,
): Promise<SaasPlanRow> {
  const [row] = await tx
    .update(saasPlan)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(saasPlan.id, planId))
    .returning()
  if (!row) throw notFound("Plan")
  void actorUserId
  return toPlanRow(row)
}

export interface SaasPaymentMethodRow {
  id: string
  code: string
  name: string
  instructions: string | null
  isActive: boolean
  sortOrder: number
}

export async function listSaasPaymentMethods(
  tx: Db,
  includeInactive = false,
): Promise<SaasPaymentMethodRow[]> {
  const rows = await tx
    .select()
    .from(saasPaymentMethod)
    .where(includeInactive ? undefined : eq(saasPaymentMethod.isActive, true))
    .orderBy(asc(saasPaymentMethod.sortOrder), asc(saasPaymentMethod.name))
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    instructions: row.instructions,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  }))
}

export async function upsertSaasPaymentMethod(
  tx: Db,
  actorUserId: string,
  input: {
    code: string
    name: string
    instructions?: string | null
    isActive?: boolean
    sortOrder?: number
  },
): Promise<SaasPaymentMethodRow> {
  const code = input.code.trim()
  const name = input.name.trim()
  if (!code || code.length > 80) throw validation("El código del medio debe tener 1–80 caracteres")
  if (!name || name.length > 120)
    throw validation("El nombre del medio debe tener 1–120 caracteres")
  const values = {
    code,
    name,
    instructions: input.instructions?.trim() ? input.instructions.trim().slice(0, 2000) : null,
    isActive: input.isActive ?? true,
    sortOrder: input.sortOrder ?? 0,
    updatedAt: new Date(),
  }
  const [row] = await tx
    .insert(saasPaymentMethod)
    .values(values)
    .onConflictDoUpdate({ target: saasPaymentMethod.code, set: values })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 409, "No se pudo guardar el medio de pago")
  void actorUserId
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    instructions: row.instructions,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  }
}

// --- Suscripción -----------------------------------------------------------------

export interface SaasSubscriptionRow {
  organizationId: string
  planId: string | null
  status: SaasSubscriptionStatus
  isDemo: boolean
  trialStartedAt: Date | null
  trialEndsAt: Date | null
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  graceEndsAt: Date | null
  restrictReason: string | null
  pauseReason: string | null
  proofExtensionUntil: Date | null
  proofExtensionCount: number
  sellerId: string | null
  sellerRateBps: number | null
  sellerWindowDays: number | null
  sellerStartedAt: Date | null
  sellerEndedAt: Date | null
  discountBps: number
  guaranteedUntil: Date | null
  trialCreditCents: number | null
  trialDays: number | null
  spendCapCents: number | null
  billingCycle: "mensual" | "quincenal"
  activatedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export async function getSaasSubscription(
  tx: Db,
  orgId: string,
): Promise<SaasSubscriptionRow | null> {
  const [row] = await tx
    .select()
    .from(saasSubscription)
    .where(eq(saasSubscription.organizationId, orgId))
    .limit(1)
  if (!row) return null
  return {
    organizationId: row.organizationId,
    planId: row.planId,
    status: row.status as SaasSubscriptionStatus,
    isDemo: row.isDemo,
    trialStartedAt: row.trialStartedAt,
    trialEndsAt: row.trialEndsAt,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    graceEndsAt: row.graceEndsAt,
    restrictReason: row.restrictReason,
    pauseReason: row.pauseReason,
    proofExtensionUntil: row.proofExtensionUntil,
    proofExtensionCount: row.proofExtensionCount,
    sellerId: row.sellerId,
    sellerRateBps: row.sellerRateBps,
    sellerWindowDays: row.sellerWindowDays,
    sellerStartedAt: row.sellerStartedAt,
    sellerEndedAt: row.sellerEndedAt,
    discountBps: row.discountBps,
    guaranteedUntil: row.guaranteedUntil,
    trialCreditCents: row.trialCreditCents,
    trialDays: row.trialDays,
    spendCapCents: row.spendCapCents,
    billingCycle: row.billingCycle as "mensual" | "quincenal",
    activatedAt: row.activatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function planByCode(tx: Db, code: string): Promise<SaasPlanRow> {
  const [row] = await tx.select().from(saasPlan).where(eq(saasPlan.code, code.trim())).limit(1)
  if (!row || !row.isActive) throw notFound("Plan")
  return toPlanRow(row)
}

/**
 * Alta de suscripción. `billingStart: "trial"` (14 días, trigger + relleno)
 * o `"now"` (activa desde hoy con el cargo del mes ya generado). La llama
 * Organizations en su transacción de alta; idempotente por organización.
 */
export type SaasBillingStart = "trial" | "now"
export async function startSaasTrial(
  tx: Db,
  orgId: string,
  input: {
    planCode?: string
    sellerId?: string
    isDemo?: boolean
    billingStart?: SaasBillingStart
  } = {},
  now = new Date(),
): Promise<SaasSubscriptionRow> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`saas:${orgId}`}, 0))`)
  const billingStart = input.billingStart ?? "trial"
  if (billingStart !== "trial" && billingStart !== "now")
    throw validation("Inicio de facturación inválido")
  let plan: SaasPlanRow | null = null
  if (input.planCode) plan = await planByCode(tx, input.planCode)
  let sellerSnapshot: { id: string; rateBps: number; windowDays: number } | null = null
  if (input.sellerId) {
    const [seller] = await tx
      .select()
      .from(saasSeller)
      .where(eq(saasSeller.id, input.sellerId))
      .limit(1)
    if (!seller) throw notFound("Vendedor")
    sellerSnapshot = { id: seller.id, rateBps: seller.rateBps, windowDays: seller.windowDays }
  }
  const existing = await getSaasSubscription(tx, orgId)
  if (existing) {
    const patch: Partial<typeof saasSubscription.$inferInsert> = {}
    if (plan && !existing.planId) patch.planId = plan.id
    if (sellerSnapshot && (!existing.sellerId || existing.sellerRateBps === null)) {
      patch.sellerId = sellerSnapshot.id
      patch.sellerRateBps = sellerSnapshot.rateBps
      patch.sellerWindowDays = sellerSnapshot.windowDays
      if (!existing.sellerStartedAt) patch.sellerStartedAt = now
      patch.sellerEndedAt = null
    }
    if (input.isDemo !== undefined && input.isDemo !== existing.isDemo) patch.isDemo = input.isDemo
    if (billingStart === "now" && existing.status === "prueba") {
      patch.status = "activa"
      patch.trialEndsAt = null
      patch.activatedAt = now
      patch.currentPeriodStart = now
      patch.currentPeriodEnd = addMonth(now)
    }
    if (Object.keys(patch).length === 0) return existing
    await tx
      .update(saasSubscription)
      .set({ ...patch, updatedAt: now })
      .where(eq(saasSubscription.organizationId, orgId))
    await audit(tx, orgId, "system", "saas_subscription", orgId, "saas.trial_completed", {
      planCode: input.planCode ?? null,
    })
    // El cargo del mes sale al cerrarlo, con lo que hicieron los agentes (ADR 0031).
    const completed = await getSaasSubscription(tx, orgId)
    if (!completed) throw new ServiceError("INTERNAL", 409, "No se pudo leer la suscripción")
    return completed
  }
  if (billingStart === "now") {
    const periodStart = now
    const periodEnd = addMonth(now)
    const [row] = await tx
      .insert(saasSubscription)
      .values({
        organizationId: orgId,
        planId: plan?.id ?? null,
        status: "activa",
        isDemo: input.isDemo ?? false,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        activatedAt: now,
        sellerId: sellerSnapshot?.id ?? null,
        sellerRateBps: sellerSnapshot?.rateBps ?? null,
        sellerWindowDays: sellerSnapshot?.windowDays ?? null,
        sellerStartedAt: sellerSnapshot ? now : null,
      })
      .returning()
    if (!row) throw new ServiceError("INTERNAL", 409, "No se pudo iniciar la suscripción")
    await audit(tx, orgId, "system", "saas_subscription", orgId, "saas.activated_now", {
      planCode: input.planCode ?? null,
    })
    const created = await getSaasSubscription(tx, orgId)
    if (!created) throw new ServiceError("INTERNAL", 409, "No se pudo leer la suscripción")
    return created
  }
  // La prueba dura lo que dice el plan (o el plan por defecto); sin ninguno, lo de siempre.
  const [trialPlan] = plan
    ? await tx.select({ trialDays: saasPlan.trialDays }).from(saasPlan).where(eq(saasPlan.id, plan.id)).limit(1)
    : await tx
        .select({ trialDays: saasPlan.trialDays })
        .from(saasPlan)
        .where(and(eq(saasPlan.isDefault, true), eq(saasPlan.isActive, true)))
        .limit(1)
  const trialEndsAt = addDays(now, trialPlan?.trialDays ?? SAAS_TRIAL_DAYS)
  const [row] = await tx
    .insert(saasSubscription)
    .values({
      organizationId: orgId,
      planId: plan?.id ?? null,
      status: "prueba",
      isDemo: input.isDemo ?? false,
      trialStartedAt: now,
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
      sellerId: sellerSnapshot?.id ?? null,
      sellerRateBps: sellerSnapshot?.rateBps ?? null,
      sellerWindowDays: sellerSnapshot?.windowDays ?? null,
      sellerStartedAt: sellerSnapshot ? now : null,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 409, "No se pudo iniciar la prueba")
  await audit(tx, orgId, "system", "saas_subscription", orgId, "saas.trial_started", {
    planCode: input.planCode ?? null,
    trialEndsAt: trialEndsAt.toISOString(),
  })
  const created = await getSaasSubscription(tx, orgId)
  if (!created) throw new ServiceError("INTERNAL", 409, "No se pudo leer la suscripción")
  return created
}

/** Marca o desmarca demo (exenta de cobro, restricción y comisiones). Solo staff. */
export async function setSaasDemo(
  tx: Db,
  orgId: string,
  actorUserId: string,
  isDemo: boolean,
): Promise<SaasSubscriptionRow> {
  const [row] = await tx
    .update(saasSubscription)
    .set({ isDemo, updatedAt: new Date() })
    .where(eq(saasSubscription.organizationId, orgId))
    .returning()
  if (!row) throw notFound("Suscripción")
  await audit(
    tx,
    orgId,
    actorUserId,
    "saas_subscription",
    orgId,
    isDemo ? "saas.demo_on" : "saas.demo_off",
  )
  const updated = await getSaasSubscription(tx, orgId)
  if (!updated) throw new ServiceError("INTERNAL", 409, "No se pudo leer la suscripción")
  return updated
}

/**
 * Cambio de moneda con saldo pendiente en otra moneda: se bloquea con el
 * motivo visible (primero se cobra lo debido). También valida contra la
 * moneda regional de la clínica cuando hay perfil.
 */
export async function assertSaasCurrencyChange(
  tx: Db,
  orgId: string,
  newCurrency: string,
): Promise<void> {
  currency(newCurrency)
  const balances = await outstandingByCurrency(tx, orgId)
  const foreign = balances.filter((entry) => entry.currency !== newCurrency)
  if (foreign.length > 0) {
    const detail = foreign.map((entry) => `${entry.cents} ${entry.currency}`).join(" · ")
    throw new ServiceError(
      "SAAS_CURRENCY_MISMATCH",
      409,
      `Hay saldo pendiente en otra moneda (${detail}): regularízalo antes de cambiar a ${newCurrency}`,
    )
  }
  // La moneda del plan es la de odentIA (ADR 0031: precios en dólares), no la
  // con que la clínica cobra a sus pacientes: no se exige que coincidan.
}
/**
 * Elige o cambia el plan (el cambio nunca reescribe cargos históricos; el
 * precio nuevo rige el próximo cargo generado, no el pasado). En prueba no
 * genera cargo aún (llega al fin de la prueba); en restricción no reactiva
 * por sí solo. Bloquea el cambio de moneda con saldo pendiente en otra
 * moneda: primero se cobra lo debido (sin ocultar el saldo).
 */
export async function chooseSaasPlan(
  tx: Db,
  orgId: string,
  actorUserId: string,
  planCode: string,
  now = new Date(),
): Promise<SaasSubscriptionRow> {
  const plan = await planByCode(tx, planCode)
  const current = await getSaasSubscription(tx, orgId)
  if (plan.seatLimit !== null && current?.planId !== plan.id) {
    throw new ServiceError("SAAS_PLAN_BY_INVITATION", 409, "Ese plan es solo por invitación")
  }
  // Una Fundadora no deja sus condiciones por error: mientras valgan, el plan no se cambia desde el panel.
  if (current?.guaranteedUntil && current.guaranteedUntil > now && current.planId !== plan.id) {
    throw new ServiceError(
      "SAAS_FOUNDER_GUARANTEED",
      409,
      "Tus condiciones de Fundador siguen vigentes: si quieres cambiar de plan, escríbenos desde Soporte",
    )
  }
  if (!current) return startSaasTrial(tx, orgId, { planCode }, now)
  await assertSaasCurrencyChange(tx, orgId, plan.currency)
  // Fuera de la prueba, elegir el primer plan lo activa: el mes empieza hoy.
  // En prueba, empieza cuando termina la prueba (ADR 0031). Si estaba en
  // solo lectura solo por no tener plan, vuelve a operar.
  const starts = current.status !== "prueba" && !current.activatedAt
  const [row] = await tx
    .update(saasSubscription)
    .set({
      planId: plan.id,
      ...(starts ? { activatedAt: now, currentPeriodStart: now, currentPeriodEnd: addMonth(now) } : {}),
      ...(current.status === "restringida" && current.restrictReason === "sin_plan" ? { status: "activa", restrictReason: null } : {}),
      // Cambiar de plan en restricción por deuda no reactiva por sí solo: el
      // tick o la confirmación de pago mueven el estado.
      updatedAt: now,
    })
    .where(eq(saasSubscription.organizationId, orgId))
    .returning()
  if (!row) throw notFound("Suscripción")
  await audit(tx, orgId, actorUserId, "saas_subscription", orgId, "saas.plan_changed", {
    planCode: plan.code,
  })
  await notifyOrg(tx, orgId, "saas.subscription.updated")
  const updated = await getSaasSubscription(tx, orgId)
  if (!updated) throw new ServiceError("INTERNAL", 409, "No se pudo leer la suscripción")
  return updated
}

/** Pausa comercial con motivo propio (separado del bloqueo de seguridad). */
export async function pauseSaasSubscription(
  tx: Db,
  orgId: string,
  actorUserId: string,
  pauseReason: string,
): Promise<SaasSubscriptionRow> {
  const current = await getSaasSubscription(tx, orgId)
  if (!current) throw notFound("Suscripción")
  const [row] = await tx
    .update(saasSubscription)
    .set({
      status: "pausada",
      pauseReason: reason(pauseReason, "El motivo de la pausa"),
      updatedAt: new Date(),
    })
    .where(eq(saasSubscription.organizationId, orgId))
    .returning()
  if (!row) throw notFound("Suscripción")
  await audit(tx, orgId, actorUserId, "saas_subscription", orgId, "saas.paused", {
    pauseReason: row.pauseReason,
  })
  await notifyOrg(tx, orgId, "saas.subscription.updated")
  const updated = await getSaasSubscription(tx, orgId)
  if (!updated) throw new ServiceError("INTERNAL", 409, "No se pudo leer la suscripción")
  return updated
}

/** Reanuda una pausa comercial (no toca bloqueos de seguridad: no existen aquí). */
export async function resumeSaasSubscription(
  tx: Db,
  orgId: string,
  actorUserId: string,
  now = new Date(),
): Promise<SaasSubscriptionRow> {
  const current = await getSaasSubscription(tx, orgId)
  if (!current) throw notFound("Suscripción")
  if (current.status !== "pausada")
    throw conflict("SAAS_NOT_PAUSED", "La suscripción no está en pausa")
  const status: SaasSubscriptionStatus =
    current.currentPeriodEnd && current.currentPeriodEnd > now ? "activa" : "gracia"
  const [row] = await tx
    .update(saasSubscription)
    .set({
      status,
      pauseReason: null,
      graceEndsAt: status === "gracia" ? addDays(now, SAAS_GRACE_DAYS) : current.graceEndsAt,
      updatedAt: now,
    })
    .where(eq(saasSubscription.organizationId, orgId))
    .returning()
  if (!row) throw notFound("Suscripción")
  await audit(tx, orgId, actorUserId, "saas_subscription", orgId, "saas.resumed")
  await notifyOrg(tx, orgId, "saas.subscription.updated")
  const updated = await getSaasSubscription(tx, orgId)
  if (!updated) throw new ServiceError("INTERNAL", 409, "No se pudo leer la suscripción")
  return updated
}
/**
 * Admin asigna plan a una clínica legada (sin fila: exenta hasta ahora).
 * Crea la suscripción en `activa` con período de 30 días, NUNCA prueba ni
 * deuda retroactiva: el pasado legado no se cobra ni se suspende solo.
 * Si ya hay fila, solo cambia el plan sin tocar estado ni fechas.
 */
export async function activateSaasSubscription(
  tx: Db,
  orgId: string,
  actorUserId: string,
  planCode: string,
  now = new Date(),
): Promise<SaasSubscriptionRow> {
  const plan = await planByCode(tx, planCode)
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`saas:${orgId}`}, 0))`)
  const existing = await getSaasSubscription(tx, orgId)
  if (existing) {
    await assertSaasCurrencyChange(tx, orgId, plan.currency)
    await tx
      .update(saasSubscription)
      .set({ planId: plan.id, updatedAt: now })
      .where(eq(saasSubscription.organizationId, orgId))
    await audit(tx, orgId, actorUserId, "saas_subscription", orgId, "saas.plan_changed", {
      planCode: plan.code,
    })
  } else {
    await assertSaasCurrencyChange(tx, orgId, plan.currency)
    await tx.insert(saasSubscription).values({
      organizationId: orgId,
      planId: plan.id,
      status: "activa",
      isDemo: false,
      activatedAt: now,
      currentPeriodStart: now,
      currentPeriodEnd: addMonth(now),
    })
    await audit(tx, orgId, actorUserId, "saas_subscription", orgId, "saas.activated", {
      planCode: plan.code,
    })
  }
  await notifyOrg(tx, orgId, "saas.subscription.updated")
  const updated = await getSaasSubscription(tx, orgId)
  if (!updated) throw new ServiceError("INTERNAL", 409, "No se pudo leer la suscripción")
  return updated
}

export interface SaasUnassignedOrg {
  organizationId: string
  organizationName: string | null
  createdAt: Date | null
}

/**
 * Clínicas legadas sin fila de suscripción (exentas hasta que admin asigne
 * plan). Para la sección "Sin plan" del admin. Con owner.
 */
export async function listSaasUnassigned(tx: Db, limit = 50): Promise<SaasUnassignedOrg[]> {
  const rows = await tx
    .select({
      organizationId: organization.id,
      organizationName: organization.name,
      createdAt: organization.createdAt,
    })
    .from(organization)
    .leftJoin(saasSubscription, eq(saasSubscription.organizationId, organization.id))
    .where(isNull(saasSubscription.organizationId))
    .orderBy(asc(organization.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200))
  return rows
}

// --- Guard de restricción ----------------------------------------------------------

export type SaasOperation = "leer" | "facturacion" | "soporte" | "operar" | "enviar"

export interface SaasAccessDecision {
  allowed: boolean
  restricted: boolean
  status: SaasSubscriptionStatus | "sin_suscripcion"
  reason: string | null
}

/**
 * Guard comercial central. Lo monta el padre como middleware de API y lo usan
 * worker/agente antes de operar o enviar; NUNCA solo la UI.
 *
 * - `leer`, `facturacion` y `soporte` siempre pasan (pagar, ver el plan y
 *   pedir ayuda están disponibles en restricción; las lecturas conservan los
 *   permisos que ya comprueba cada ruta).
 * - `operar` y `enviar` se deniegan en `restringida` o `pausada`.
 * - Demo exenta. Sin fila de suscripción: pasa (no rompe clínicas previas).
 * - La ingesta entrante jamás pasa por aquí (no se pierde ningún mensaje).
 * - Pagar no levanta bloqueos de seguridad: esos живут fuera de esta tabla y
 *   aquí ni se leen ni se escriben.
 */
export async function decideSaasAccess(
  tx: Db,
  orgId: string,
  operation: SaasOperation,
): Promise<SaasAccessDecision> {
  if (operation === "leer" || operation === "facturacion" || operation === "soporte") {
    const sub = await getSaasSubscription(tx, orgId)
    return {
      allowed: true,
      restricted:
        sub !== null &&
        !sub.isDemo &&
        (sub.status === "restringida" || sub.status === "pausada" || sub.status === "cancelada"),
      status: sub?.status ?? "sin_suscripcion",
      reason: sub?.restrictReason ?? sub?.pauseReason ?? null,
    }
  }
  const sub = await getSaasSubscription(tx, orgId)
  if (!sub || sub.isDemo) {
    return {
      allowed: true,
      restricted: false,
      status: sub?.status ?? "sin_suscripcion",
      reason: null,
    }
  }
  if (sub.status === "restringida" || sub.status === "cancelada") {
    return {
      allowed: false,
      restricted: true,
      status: sub.status,
      reason: sub.status === "cancelada" ? "cancelada" : (sub.restrictReason ?? "suspendida"),
    }
  }
  if (sub.status === "pausada") {
    return {
      allowed: false,
      restricted: true,
      status: sub.status,
      reason: sub.pauseReason ?? "pausada",
    }
  }
  return { allowed: true, restricted: false, status: sub.status, reason: null }
}

/** Lanza 403 si la operación comercial no pasa; para middleware y worker. */
export async function assertSaasAllowed(
  tx: Db,
  orgId: string,
  operation: SaasOperation,
): Promise<SaasAccessDecision> {
  const decision = await decideSaasAccess(tx, orgId, operation)
  if (!decision.allowed) {
    throw new ServiceError(
      "SAAS_RESTRICTED",
      403,
      decision.status === "pausada"
        ? "La suscripción está en pausa: revisa tu plan o contacta soporte"
        : "El acceso está restringido por falta de pago: regulariza tu plan o contacta soporte",
    )
  }
  return decision
}
/** true si la org no puede enviar/operar el agente (restringida, pausada o cancelada). Demo y sin fila envían. */
export async function isSaasSendBlocked(tx: Db, orgId: string): Promise<boolean> {
  const decision = await decideSaasAccess(tx, orgId, "enviar")
  return !decision.allowed
}

/** true si el tick de automatizaciones debe saltar la org (conserva lo encolado). */
export async function shouldSkipSaasOrg(tx: Db, orgId: string): Promise<boolean> {
  return isSaasSendBlocked(tx, orgId)
}

// --- Ficha para Organizations / panel / platform ------------------------------------

export interface SaasPlanSummary {
  code: string
  name: string
  currency: string
  priceCents: number
  billingPeriod: string
}

export interface SaasUsageSummary {
  agentRuns: number
  llmCalls: number
  /** null = ninguna corrida del mes lo informó (no afirmar 0). */
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  /**
   * Cobertura: cuántas corridas informaron tokens. El costo real de IA no
   * va aquí: es de odentIA y lo ve solo su administración
   * (`OrganizationDetail.aiCost`); la clínica verá lo que se le cobra por
   * acción (ADR 0031).
   */
  runsWithTokens: number
  /** Mes calendario evaluado (nunca "últimos 30 días"). */
  periodLabel: string
  periodStart: Date
  periodEnd: Date
}

function zonedMonthStartUtc(year: number, month: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, 1)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(guess))
  const part = (type: string): number =>
    Number(parts.find((item) => item.type === type)?.value ?? 0)
  const asUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour") % 24,
    part("minute"),
    part("second"),
  )
  return new Date(guess - (asUtc - guess))
}

/** Mes calendario de `now` en la zona de la clínica, con su etiqueta AAAA-MM. */
export function usageMonthBounds(timeZone: string, now: Date): { start: Date; end: Date; label: string } {
  const head = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
  }).formatToParts(now)
  const year = Number(head.find((item) => item.type === "year")?.value ?? 1970)
  const month = Number(head.find((item) => item.type === "month")?.value ?? 1)
  const start = zonedMonthStartUtc(year, month, timeZone)
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
  const end = zonedMonthStartUtc(next.year, next.month, timeZone)
  return { start, end, label: start.toISOString().slice(0, 7) }
}

/**
 * Uso agregado del MES calendario (zona de la clínica, UTC si no hay perfil)
 * desde el libro de corridas, con UNA consulta agregada. Tokens y costo solo
 * si el proveedor los entregó (con cobertura para no afirmar ceros).
 */
export async function getSaasUsage30d(
  tx: Db,
  orgId: string,
  now = new Date(),
): Promise<SaasUsageSummary> {
  let timeZone = "UTC"
  try {
    const region = await getOrgLocale(tx, orgId)
    if (region.timezone) timeZone = region.timezone
  } catch {
    timeZone = "UTC"
  }
  const bounds = usageMonthBounds(timeZone, now)
  const [row] = await tx
    .select({
      runs: sql<number>`count(*)`,
      calls: sql<number>`coalesce(sum(${agentRunLedger.llmCalls}), 0)`,
      input: sql<number | null>`sum(${agentRunLedger.inputTokens})`,
      output: sql<number | null>`sum(${agentRunLedger.outputTokens})`,
      cached: sql<number | null>`sum(${agentRunLedger.cachedInputTokens})`,
      withTokens: sql<number>`count(${agentRunLedger.inputTokens})`,
    })
    .from(agentRunLedger)
    .where(
      and(
        eq(agentRunLedger.organizationId, orgId),
        gte(agentRunLedger.startedAt, bounds.start),
        lt(agentRunLedger.startedAt, bounds.end),
      ),
    )
  const numberOrNull = (value: unknown): number | null => {
    if (value === null || value === undefined) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const runsWithTokens = Number(row?.withTokens ?? 0)
  return {
    agentRuns: Number(row?.runs ?? 0),
    llmCalls: Number(row?.calls ?? 0),
    inputTokens: runsWithTokens > 0 ? numberOrNull(row?.input) : null,
    outputTokens: runsWithTokens > 0 ? numberOrNull(row?.output) : null,
    cachedInputTokens: runsWithTokens > 0 ? numberOrNull(row?.cached) : null,
    runsWithTokens,
    periodLabel: bounds.label,
    periodStart: bounds.start,
    periodEnd: bounds.end,
  }
}

export interface OrganizationBillingSummary {
  plan: SaasPlanSummary | null
  status: SaasSubscriptionStatus | "sin_suscripcion"
  isDemo: boolean
  currency: string | null
  trialEndsAt: Date | null
  graceEndsAt: Date | null
  currentPeriodEnd: Date | null
  restricted: boolean
  restrictReason: string | null
  pauseReason: string | null
  outstandingByCurrency: SaasMoneyByCurrency[]
  proofExtensionUntil: Date | null
  usage30d: SaasUsageSummary
  /** Entró por invitación (Fundadores): hasta cuándo valen sus condiciones; null si no aplica o ya terminaron. */
  guaranteedUntil: Date | null
}

/** Resumen de suscripción + saldo + uso para ficha de clínica, panel y banner. */
export async function getOrganizationBillingSummary(
  tx: Db,
  organizationId: string,
): Promise<OrganizationBillingSummary> {
  const sub = await getSaasSubscription(tx, organizationId)
  let plan: SaasPlanSummary | null = null
  if (sub?.planId) {
    const [row] = await tx.select().from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
    if (row) {
      plan = {
        code: row.code,
        name: row.name,
        currency: row.currency,
        priceCents: row.priceCents,
        billingPeriod: row.billingPeriod,
      }
    }
  }
  const outstanding = await outstandingByCurrency(tx, organizationId)
  const usage30d = await getSaasUsage30d(tx, organizationId)
  return {
    plan,
    status: sub?.status ?? "sin_suscripcion",
    isDemo: sub?.isDemo ?? false,
    currency: plan?.currency ?? null,
    trialEndsAt: sub?.trialEndsAt ?? null,
    graceEndsAt: sub?.graceEndsAt ?? null,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    restricted:
      sub !== null &&
      !sub.isDemo &&
      (sub.status === "restringida" || sub.status === "pausada" || sub.status === "cancelada"),
    restrictReason: sub?.restrictReason ?? null,
    pauseReason: sub?.pauseReason ?? null,
    outstandingByCurrency: outstanding,
    proofExtensionUntil: sub?.proofExtensionUntil ?? null,
    usage30d,
    guaranteedUntil: sub?.guaranteedUntil && sub.guaranteedUntil > new Date() ? sub.guaranteedUntil : null,
  }
}

// --- Límites de sedes/personas -------------------------------------------------------

export interface SaasLimitCheck {
  withinLimits: boolean
  branches: { used: number; max: number | null }
  seats: { used: number; max: number | null }
}

/**
 * Compara altas reales contra el tope del plan. Solo orienta altas nuevas;
 * jamás recorta históricos. La imponen Organizations (sedes/miembros) al crear.
 */
export async function checkSaasLimits(tx: Db, orgId: string): Promise<SaasLimitCheck> {
  const sub = await getSaasSubscription(tx, orgId)
  let maxBranches: number | null = null
  let maxSeats: number | null = null
  if (sub?.planId) {
    const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
    maxBranches = plan?.maxBranches ?? null
    maxSeats = plan?.maxSeats ?? null
  }
  const branchRows = await tx
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
  const usedBranches = branchRows.length
  const usedSeats = await countSaasSeats(tx, orgId)
  return {
    withinLimits:
      (maxBranches === null || usedBranches <= maxBranches) &&
      (maxSeats === null || usedSeats <= maxSeats),
    branches: { used: usedBranches, max: maxBranches },
    seats: { used: usedSeats, max: maxSeats },
  }
}

/**
 * Asientos ocupados: UNIÓN por correo de miembros e invitaciones pendientes.
 * Aceptar una invitación no suma dos veces: el correo ya está reservado por
 * la invitación (o el miembro ya existe y la invitación dejó de estar
 * pendiente). `excludeEmail` quita el correo que se está sumando (el nuevo
 * invitado o quien acepta): el chequeo es "los demás + uno cabe en el plan".
 */
export async function countSaasSeats(
  tx: Db,
  orgId: string,
  excludeEmail?: string,
): Promise<number> {
  const excluded = excludeEmail?.trim().toLowerCase() ?? null
  const memberRows = await tx
    .select({ email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, orgId))
  const pendingRows = await tx
    .select({ email: invitation.email })
    .from(invitation)
    .where(and(eq(invitation.organizationId, orgId), eq(invitation.status, "pending")))
  const emails: Record<string, true> = {}
  for (const row of memberRows) {
    const email = row.email.trim().toLowerCase()
    if (email && email !== excluded) emails[email] = true
  }
  for (const row of pendingRows) {
    const email = row.email.trim().toLowerCase()
    if (email && email !== excluded) emails[email] = true
  }
  return Object.keys(emails).length
}

/**
 * Lanza 409 si el plan no admite un miembro más. `excludeEmail` es el correo
 * que se suma (invitado nuevo o quien acepta): aceptar al límite exacto pasa
 * porque su asiento ya está reservado por su invitación. La usan el pre-auth
 * de invitar/aceptar y Organizations al invitar.
 */
export async function assertSaasSeatAvailable(
  tx: Db,
  orgId: string,
  excludeEmail?: string,
): Promise<void> {
  const sub = await getSaasSubscription(tx, orgId)
  if (!sub || sub.isDemo || !sub.planId) return
  const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
  if (!plan || plan.maxSeats === null) return
  const used = await countSaasSeats(tx, orgId, excludeEmail)
  if (used >= plan.maxSeats) {
    throw new ServiceError(
      "SAAS_SEAT_LIMIT",
      409,
      `El plan ${plan.name} admite ${plan.maxSeats} personas: cambia de plan para invitar a más`,
    )
  }
}

/** Lanza 409 si el plan no admite una sede más. La usa quien crea sedes. */
export async function assertSaasBranchAvailable(tx: Db, orgId: string): Promise<void> {
  const sub = await getSaasSubscription(tx, orgId)
  if (!sub || sub.isDemo || !sub.planId) return
  const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
  if (!plan || plan.maxBranches === null) return
  const rows = await tx
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
  if (rows.length >= plan.maxBranches) {
    throw new ServiceError(
      "SAAS_BRANCH_LIMIT",
      409,
      `El plan ${plan.name} admite ${plan.maxBranches} sedes: cambia de plan para abrir otra`,
    )
  }
}

export type SaasPublicAction = "reservar" | "confirmar" | "cancelar"

/**
 * Política para superficie pública (reserva, confirmación y baja por enlace):
 * confirmar o cancelar una cita existente siempre pasa (autonomía del
 * paciente y menos carga); reservar nuevo pasa solo al día comercial.
 * Demo exenta. El padre la monta solo en esas rutas, nunca como bypass de
 * todo /public si la ruta muta otra cosa.
 */
export async function decideSaasPublicAccess(
  tx: Db,
  orgId: string,
  action: SaasPublicAction,
): Promise<{ allowed: boolean; reason: string | null }> {
  if (action === "confirmar" || action === "cancelar") return { allowed: true, reason: null }
  const decision = await decideSaasAccess(tx, orgId, "operar")
  return { allowed: decision.allowed, reason: decision.reason }
}

// --- Cargos (cobranza manual admin) ----------------------------------------------------

export interface SaasChargeRow {
  id: string
  organizationId: string
  planId: string | null
  planCode: string
  planName: string
  periodStart: Date
  periodEnd: Date
  amountCents: number
  currency: string
  paidCents: number
  status: SaasChargeStatus
  dueAt: Date | null
  createdAt: Date
}

function toChargeRow(row: typeof saasCharge.$inferSelect): SaasChargeRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    planId: row.planId,
    planCode: row.planCode,
    planName: row.planName,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    amountCents: row.amountCents,
    currency: row.currency,
    paidCents: row.paidCents,
    status: row.status as SaasChargeStatus,
    dueAt: row.dueAt,
    createdAt: row.createdAt,
  }
}

/** Crea el cargo del período desde el snapshot del plan (admin, con owner). */
export async function createSaasCharge(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { planCode: string; periodStart: Date; periodEnd: Date; dueAt?: Date },
): Promise<SaasChargeRow> {
  const plan = await planByCode(tx, input.planCode)
  if (input.periodEnd <= input.periodStart)
    throw validation("El período debe terminar después de empezar")
  const [row] = await tx
    .insert(saasCharge)
    .values({
      organizationId: orgId,
      planId: plan.id,
      planCode: plan.code,
      planName: plan.name,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      amountCents: plan.priceCents,
      currency: plan.currency,
      dueAt: input.dueAt ?? input.periodEnd,
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 409, "No se pudo crear el cargo")
  const sub = await getSaasSubscription(tx, orgId)
  if (sub && plan.id !== sub.planId) {
    await tx
      .update(saasSubscription)
      .set({ planId: plan.id, updatedAt: new Date() })
      .where(eq(saasSubscription.organizationId, orgId))
  }
  await audit(tx, orgId, actorUserId, "saas_charge", row.id, "saas.charge_created", {
    planCode: plan.code,
    amountCents: plan.priceCents,
  })
  await notifyOrg(tx, orgId, "saas.charge.updated")
  return toChargeRow(row)
}

export async function listSaasCharges(tx: Db, orgId: string, limit = 50): Promise<SaasChargeRow[]> {
  const rows = await tx
    .select()
    .from(saasCharge)
    .where(and(eq(saasCharge.organizationId, orgId), isNull(saasCharge.voidedAt)))
    .orderBy(desc(saasCharge.periodStart), desc(saasCharge.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200))
  return rows.map(toChargeRow)
}

// --- Comprobantes y pagos ---------------------------------------------------------------

export interface SaasPaymentRow {
  id: string
  organizationId: string
  chargeId: string | null
  amountCents: number
  currency: string
  methodCode: string
  status: "pendiente" | "confirmado" | "reversado" | "devuelto"
  receiptFilename: string | null
  receiptMime: string | null
  receiptSize: number | null
  hasReceipt: boolean
  notes: string | null
  confirmedAt: Date | null
  reversedAt: Date | null
  reverseReason: string | null
  createdAt: Date
}

function toPaymentRow(row: typeof saasPayment.$inferSelect): SaasPaymentRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    chargeId: row.chargeId,
    amountCents: row.amountCents,
    currency: row.currency,
    methodCode: row.methodCode,
    status: row.status as SaasPaymentRow["status"],
    receiptFilename: row.receiptFilename,
    receiptMime: row.receiptMime,
    receiptSize: row.receiptSize,
    hasReceipt: row.receiptObjectKey !== null,
    notes: row.notes,
    confirmedAt: row.confirmedAt,
    reversedAt: row.reversedAt,
    reverseReason: row.reverseReason,
    createdAt: row.createdAt,
  }
}

const RECEIPT_MAX_BYTES = 10 * 1024 * 1024

export interface VerifiedReceipt {
  ext: string
  mime: string
}

/**
 * Verifica el comprobante con el helper compartido de soporte
 * (`sniffFileContent`, dueño file-content.ts): firmas reales contra el MIME
 * declarado; SVG/HTML/ejecutables no pasan. Más el tope de tamaño.
 */
export async function verifyReceiptBytes(
  bytes: Uint8Array,
  claimedMime: string,
): Promise<VerifiedReceipt> {
  if (bytes.byteLength === 0) throw validation("El comprobante está vacío")
  if (bytes.byteLength > RECEIPT_MAX_BYTES)
    throw validation("El comprobante no puede superar 10 MB")
  const sniffed = sniffFileContent(bytes, claimedMime)
  return { ext: sniffed.ext, mime: sniffed.mimeType }
}

/** Nombre seguro para la descarga firmada: sin rutas ni caracteres activos. */
export function safeReceiptFilename(filename: string, fallback: string): string {
  const base = filename.split(/[\\/]/).pop() ?? ""
  const clean = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120)
  return clean || fallback
}

export interface ReceiptUpload {
  bytes: Uint8Array
  contentType: string
  filename: string
}

/**
 * La clínica registra su comprobante: queda `pendiente` de confirmación admin
 * y otorga prórroga acotada (una vez por cargo). Disponible en restricción.
 */
/**
 * Secuencia de bloqueo consistente por cargo (confirm/reverse/refund): lee el
 * pago, toma el advisory del cargo, bloquea cargo y pago por fila en ese
 * orden. Serializa confirmaciones concurrentes del mismo cargo y evita
 * interbloqueos entre operaciones del mismo cargo.
 */
async function lockChargePayment(
  tx: Db,
  orgId: string,
  paymentId: string,
): Promise<{
  payment: typeof saasPayment.$inferSelect
  charge: typeof saasCharge.$inferSelect | null
}> {
  const [found] = await tx
    .select()
    .from(saasPayment)
    .where(and(eq(saasPayment.id, paymentId), eq(saasPayment.organizationId, orgId)))
    .limit(1)
  if (!found) throw notFound("Pago")
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('saas-cargo:' || ${orgId} || ':' || ${found.chargeId ?? found.id}))`,
  )
  let charge: typeof saasCharge.$inferSelect | null = null
  if (found.chargeId) {
    const [lockedCharge] = await tx
      .select()
      .from(saasCharge)
      .where(and(eq(saasCharge.id, found.chargeId), eq(saasCharge.organizationId, orgId)))
      .for("update")
    if (!lockedCharge) throw notFound("Cargo")
    charge = lockedCharge
  }
  const [payment] = await tx
    .select()
    .from(saasPayment)
    .where(and(eq(saasPayment.id, paymentId), eq(saasPayment.organizationId, orgId)))
    .for("update")
  if (!payment) throw notFound("Pago")
  return { payment, charge }
}
export async function submitSaasReceipt(
  tx: Db,
  deps: { storage: Pick<Storage, "putAttachment"> },
  orgId: string,
  actorUserId: string,
  input: {
    chargeId: string
    methodCode: string
    amountCents: number
    receipt: ReceiptUpload
    idempotencyKey: string
    notes?: string
  },
  now = new Date(),
): Promise<SaasPaymentRow> {
  const [charge] = await tx
    .select()
    .from(saasCharge)
    .where(
      and(
        eq(saasCharge.id, input.chargeId),
        eq(saasCharge.organizationId, orgId),
        isNull(saasCharge.voidedAt),
      ),
    )
    .limit(1)
  if (!charge) throw notFound("Cargo")
  if (charge.status === "pagada") throw conflict("SAAS_CHARGE_PAID", "Ese cargo ya está pagado")
  const amount = assertCents(input.amountCents, "El importe", true)
  const outstanding = charge.amountCents - charge.paidCents
  if (amount > outstanding)
    throw validation(`El importe supera el saldo del cargo (${outstanding} en unidad menor)`)
  const [method] = await tx
    .select()
    .from(saasPaymentMethod)
    .where(
      and(
        eq(saasPaymentMethod.code, input.methodCode.trim()),
        eq(saasPaymentMethod.isActive, true),
      ),
    )
    .limit(1)
  if (!method) throw notFound("Medio de pago")
  // El contentType del cliente se comprueba contra los bytes (helper compartido).
  const verified = await verifyReceiptBytes(input.receipt.bytes, input.receipt.contentType)
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('saas-cargo:' || ${orgId} || ':' || ${charge.id}))`,
  )
  const [replay] = await tx
    .select()
    .from(saasPayment)
    .where(
      and(
        eq(saasPayment.organizationId, orgId),
        eq(saasPayment.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1)
  if (replay) return toPaymentRow(replay)
  // Un solo comprobante pendiente por cargo: el segundo espera a que admin
  // confirme o a que se anule el anterior. Evita prórrogas y pendientes infinitos.
  const [alreadyPending] = await tx
    .select({ id: saasPayment.id })
    .from(saasPayment)
    .where(
      and(
        eq(saasPayment.organizationId, orgId),
        eq(saasPayment.chargeId, charge.id),
        eq(saasPayment.status, "pendiente"),
      ),
    )
    .limit(1)
  if (alreadyPending)
    throw conflict(
      "SAAS_RECEIPT_PENDING",
      "Ese cargo ya tiene un comprobante pendiente de confirmación",
    )
  // Storage real, bucket privado: la URL firmada la entrega la ruta (nunca pública).
  const stored = await deps.storage.putAttachment({
    orgId,
    conversationId: `saas-${charge.id}`,
    bytes: Buffer.from(input.receipt.bytes),
    contentType: verified.mime,
    ext: verified.ext,
  })
  const [row] = await tx
    .insert(saasPayment)
    .values({
      organizationId: orgId,
      chargeId: charge.id,
      amountCents: amount,
      currency: charge.currency,
      methodCode: method.code,
      status: "pendiente",
      receiptObjectKey: stored.objectKey,
      receiptFilename: safeReceiptFilename(input.receipt.filename, stored.filename),
      receiptMime: stored.mimeType,
      receiptSize: stored.size,
      idempotencyKey: input.idempotencyKey,
      notes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 409, "No se pudo registrar el comprobante")
  // Prórroga acotada por comprobante pendiente (una vez por cargo).
  const sub = await getSaasSubscription(tx, orgId)
  // Prórroga acotada solo si el comprobante cubre TODO el saldo (un parcial no
  // aplaza) y una sola vez.
  if (
    sub &&
    !sub.isDemo &&
    amount === outstanding &&
    sub.proofExtensionCount < SAAS_PROOF_EXTENSION_MAX
  ) {
    await tx
      .update(saasSubscription)
      .set({
        proofExtensionUntil: addDays(now, SAAS_PROOF_EXTENSION_DAYS),
        proofExtensionCount: sub.proofExtensionCount + 1,
        updatedAt: now,
      })
      .where(eq(saasSubscription.organizationId, orgId))
  }
  await audit(tx, orgId, actorUserId, "saas_payment", row.id, "saas.receipt_submitted", {
    chargeId: charge.id,
    amountCents: amount,
  })
  await notifyOrg(tx, orgId, "saas.payment.updated")
  return toPaymentRow(row)
}

/** URL firmada de lectura del comprobante (privado; expira en 15 min). */
export async function getSaasReceiptUrl(
  tx: Db,
  deps: { storage: Pick<Storage, "attachmentUrl"> },
  orgId: string,
  paymentId: string,
): Promise<{ url: string; filename: string | null; mime: string | null }> {
  const [row] = await tx
    .select()
    .from(saasPayment)
    .where(and(eq(saasPayment.id, paymentId), eq(saasPayment.organizationId, orgId)))
    .limit(1)
  if (!row || !row.receiptObjectKey) throw notFound("Comprobante")
  const url = await deps.storage.attachmentUrl(row.receiptObjectKey, 900)
  return { url, filename: row.receiptFilename, mime: row.receiptMime }
}

async function refreshChargeStatus(tx: Db, orgId: string, chargeId: string): Promise<void> {
  const [charge] = await tx
    .select()
    .from(saasCharge)
    .where(and(eq(saasCharge.id, chargeId), eq(saasCharge.organizationId, orgId)))
    .limit(1)
  if (!charge || charge.voidedAt) return
  const confirmed = await tx
    .select()
    .from(saasPayment)
    .where(
      and(
        eq(saasPayment.organizationId, orgId),
        eq(saasPayment.chargeId, chargeId),
        eq(saasPayment.status, "confirmado"),
      ),
    )
  let paidCents = 0
  for (const payment of confirmed) paidCents += payment.amountCents
  let status: SaasChargeStatus = "pendiente"
  if (paidCents >= charge.amountCents && charge.amountCents > 0) status = "pagada"
  else if (paidCents > 0) status = "parcial"
  await tx
    .update(saasCharge)
    .set({ paidCents, status, updatedAt: new Date() })
    .where(and(eq(saasCharge.id, chargeId), eq(saasCharge.organizationId, orgId)))
}

/**
 * Admin confirma un comprobante: suma al cargo (parcial no salda) y, si lo
 * cubre, lo marca pagada. Crea la comisión del vendedor con porcentaje y
 * ventana congelados (salvo demo). Reactiva comercial, nunca seguridad.
 */
export async function confirmSaasPayment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  paymentId: string,
  now = new Date(),
): Promise<{ payment: SaasPaymentRow; charge: SaasChargeRow | null; commissionId: string | null }> {
  const { payment, charge: lockedCharge } = await lockChargePayment(tx, orgId, paymentId)
  if (payment.status === "confirmado") {
    const charge = payment.chargeId
      ? await tx
          .select()
          .from(saasCharge)
          .where(and(eq(saasCharge.id, payment.chargeId), eq(saasCharge.organizationId, orgId)))
          .limit(1)
          .then((rows) => (rows[0] ? toChargeRow(rows[0]) : null))
      : null
    const [existing] = await tx
      .select({ id: saasSellerCommission.id })
      .from(saasSellerCommission)
      .where(eq(saasSellerCommission.paymentId, payment.id))
      .limit(1)
    return { payment: toPaymentRow(payment), charge, commissionId: existing?.id ?? null }
  }
  if (payment.status !== "pendiente")
    throw conflict("SAAS_PAYMENT_STATE", "Solo se confirma un comprobante pendiente")
  // Sobrepago: lo ya confirmado para el cargo más este pago no supera el cargo.
  if (lockedCharge) {
    const confirmed = await tx
      .select({ amountCents: saasPayment.amountCents })
      .from(saasPayment)
      .where(
        and(
          eq(saasPayment.organizationId, orgId),
          eq(saasPayment.chargeId, lockedCharge.id),
          eq(saasPayment.status, "confirmado"),
        ),
      )
    let confirmedTotal = 0
    for (const row of confirmed) confirmedTotal += row.amountCents
    if (confirmedTotal + payment.amountCents > lockedCharge.amountCents) {
      throw conflict(
        "SAAS_OVERPAYMENT",
        "Confirmarlo supera el cargo: reversa primero el comprobante duplicado",
      )
    }
  }
  const [row] = await tx
    .update(saasPayment)
    .set({ status: "confirmado", confirmedAt: now, confirmedBy: actorUserId })
    .where(and(eq(saasPayment.id, paymentId), eq(saasPayment.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Pago")
  let charge: SaasChargeRow | null = null
  if (row.chargeId) {
    await refreshChargeStatus(tx, orgId, row.chargeId)
    const [updated] = await tx
      .select()
      .from(saasCharge)
      .where(and(eq(saasCharge.id, row.chargeId), eq(saasCharge.organizationId, orgId)))
      .limit(1)
    if (updated) charge = toChargeRow(updated)
  }
  // Comisión sobre cobro confirmado (nunca demo) con la atribución CONGELADA
  // de la suscripción (D5): el cambio de vendedor o de su % no toca lo
  // atribuido; solo comisionan los primeros 12 meses de la clínica y con
  // atribución abierta.
  let commissionId: string | null = null
  const sub = await getSaasSubscription(tx, orgId)
  if (sub && !sub.isDemo && sub.sellerId && sub.sellerRateBps !== null && !sub.sellerEndedAt) {
    if (now <= clinicCommissionCutoff(sub)) {
      const windowDays = sub.sellerWindowDays ?? 90
      // La comisión es sobre lo cobrado sin impuesto: el IGV no es ingreso de odentIA.
      const [taxed] = row.chargeId
        ? await tx
            .select({ amount: saasCharge.amountCents, tax: saasCharge.taxCents })
            .from(saasCharge)
            .where(and(eq(saasCharge.id, row.chargeId), eq(saasCharge.organizationId, orgId)))
            .limit(1)
        : []
      const base = taxed && taxed.tax > 0 && taxed.amount > 0 ? Math.round((row.amountCents * (taxed.amount - taxed.tax)) / taxed.amount) : row.amountCents
      const commissionCents = Math.floor((base * sub.sellerRateBps) / 10000)
      const [created] = await tx
        .insert(saasSellerCommission)
        .values({
          organizationId: orgId,
          paymentId: row.id,
          sellerId: sub.sellerId,
          rateBps: sub.sellerRateBps,
          windowDays,
          baseCents: base,
          commissionCents,
          currency: row.currency,
          adjustableUntil: addDays(now, windowDays),
          status: "pendiente",
        })
        .onConflictDoNothing({ target: saasSellerCommission.paymentId })
        .returning()
      commissionId = created?.id ?? null
    }
  }
  // Al día comercial: si ya no hay saldo, vuelve a activa (sin tocar seguridad).
  if (sub && !sub.isDemo && (sub.status === "restringida" || sub.status === "gracia")) {
    const summary = await outstandingCents(tx, orgId)
    if (summary === 0) {
      // El mes de la clínica sigue anclado al día en que activó: pagar no lo mueve.
      await tx
        .update(saasSubscription)
        .set({
          status: "activa",
          restrictReason: null,
          graceEndsAt: null,
          proofExtensionUntil: null,
          proofExtensionCount: 0,
          ...(sub.currentPeriodEnd ? {} : { currentPeriodStart: now, currentPeriodEnd: addMonth(now) }),
          updatedAt: now,
        })
        .where(eq(saasSubscription.organizationId, orgId))
    }
  }
  await audit(tx, orgId, actorUserId, "saas_payment", row.id, "saas.payment_confirmed", {
    amountCents: row.amountCents,
  })
  await notifyOrg(tx, orgId, "saas.payment.updated")
  return { payment: toPaymentRow(row), charge, commissionId }
}

async function outstandingCents(tx: Db, orgId: string): Promise<number> {
  const byCurrency = await outstandingByCurrency(tx, orgId)
  let total = 0
  for (const entry of byCurrency) total += entry.cents
  return total
}

/**
 * Saldo por moneda (los cargos congelan la suya): jamás se suman monedas
 * distintas en una sola cifra.
 */
export async function outstandingByCurrency(tx: Db, orgId: string): Promise<SaasMoneyByCurrency[]> {
  const charges = await tx
    .select()
    .from(saasCharge)
    .where(
      and(
        eq(saasCharge.organizationId, orgId),
        or(eq(saasCharge.status, "pendiente"), eq(saasCharge.status, "parcial")),
        isNull(saasCharge.voidedAt),
      ),
    )
  const byCurrency: Record<string, number> = {}
  for (const charge of charges) {
    const rest = charge.amountCents - charge.paidCents
    if (rest > 0) byCurrency[charge.currency] = (byCurrency[charge.currency] ?? 0) + rest
  }
  return Object.entries(byCurrency).map(([currencyCode, cents]) => ({
    currency: currencyCode,
    cents,
  }))
}

/**
 * Admin reversa un pago confirmado (cobro que no fue): resta del cargo y, si
 * la comisión ya se liquidó, deja un AJUSTE trazable para la próxima
 * liquidación (jamás muta la liquidación original).
 */
export async function reverseSaasPayment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  paymentId: string,
  reverseReason: string,
  now = new Date(),
): Promise<{ payment: SaasPaymentRow; adjustmentId: string | null }> {
  const motive = reason(reverseReason, "El motivo del reverso")
  const { payment } = await lockChargePayment(tx, orgId, paymentId)
  if (payment.status !== "confirmado")
    throw conflict("SAAS_PAYMENT_STATE", "Solo se reversa un pago confirmado")
  const [row] = await tx
    .update(saasPayment)
    .set({ status: "reversado", reversedAt: now, reversedBy: actorUserId, reverseReason: motive })
    .where(and(eq(saasPayment.id, paymentId), eq(saasPayment.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Pago")
  if (row.chargeId) await refreshChargeStatus(tx, orgId, row.chargeId)
  let adjustmentId: string | null = null
  const [commission] = await tx
    .select()
    .from(saasSellerCommission)
    .where(eq(saasSellerCommission.paymentId, payment.id))
    .limit(1)
  if (commission) {
    if (commission.status === "liquidada" && commission.commissionCents > 0) {
      const [adjustment] = await tx
        .insert(saasCommissionAdjustment)
        .values({
          organizationId: orgId,
          commissionId: commission.id,
          paymentId: payment.id,
          sellerId: commission.sellerId,
          amountCents: commission.commissionCents,
          currency: commission.currency,
          reason: `Reverso: ${motive}`.slice(0, 2000),
          createdBy: actorUserId,
        })
        .returning()
      adjustmentId = adjustment?.id ?? null
      await tx
        .update(saasSellerCommission)
        .set({ status: "ajustada" })
        .where(eq(saasSellerCommission.id, commission.id))
    } else if (commission.status === "liquidada") {
      // Comisión cero ya liquidada: se marca sin ajuste (no hay nada que descontar).
      await tx
        .update(saasSellerCommission)
        .set({ status: "ajustada" })
        .where(eq(saasSellerCommission.id, commission.id))
    } else {
      await tx.delete(saasSellerCommission).where(eq(saasSellerCommission.id, commission.id))
    }
  }
  await audit(tx, orgId, actorUserId, "saas_payment", row.id, "saas.payment_reversed", {
    reason: motive,
  })
  await notifyOrg(tx, orgId, "saas.payment.updated")
  return { payment: toPaymentRow(row), adjustmentId }
}

/** Admin registra una devolución (dinero que vuelve a la clínica): contabiliza igual que el reverso. */
export async function refundSaasPayment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  paymentId: string,
  refundReason: string,
  now = new Date(),
): Promise<{ payment: SaasPaymentRow; adjustmentId: string | null }> {
  const result = await reverseSaasPayment(tx, orgId, actorUserId, paymentId, refundReason, now)
  const [row] = await tx
    .update(saasPayment)
    .set({ status: "devuelto" })
    .where(and(eq(saasPayment.id, paymentId), eq(saasPayment.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Pago")
  await audit(tx, orgId, actorUserId, "saas_payment", row.id, "saas.payment_refunded")
  return { payment: toPaymentRow(row), adjustmentId: result.adjustmentId }
}

/**
 * Staff registra un pago recibido (D1, transferencia sin upload del cliente)
 * y lo confirma en la misma transacción: reutiliza comprobante pendiente +
 * confirmación con fecha de pago. El Storage va por deps, fuera de tx propia.
 */
export async function registerManualSaasPayment(
  tx: Db,
  deps: { storage: Pick<Storage, "putAttachment"> },
  orgId: string,
  actorUserId: string,
  input: {
    chargeId: string
    methodCode: string
    amountCents: number
    receipt: ReceiptUpload
    idempotencyKey: string
    notes?: string
    paidAt?: Date
  },
  now = new Date(),
): Promise<{ payment: SaasPaymentRow; charge: SaasChargeRow | null; commissionId: string | null }> {
  const submitted = await submitSaasReceipt(tx, deps, orgId, actorUserId, input, now)
  return confirmSaasPayment(tx, orgId, actorUserId, submitted.id, input.paidAt ?? now)
}

export async function listSaasPayments(
  tx: Db,
  orgId: string,
  limit = 50,
): Promise<SaasPaymentRow[]> {
  const rows = await tx
    .select()
    .from(saasPayment)
    .where(eq(saasPayment.organizationId, orgId))
    .orderBy(desc(saasPayment.createdAt), desc(saasPayment.id))
    .limit(Math.min(Math.max(limit, 1), 200))
  return rows.map(toPaymentRow)
}

export interface SaasPendingPaymentRow extends SaasPaymentRow {
  organizationName: string | null
}
/** Pagos pendientes de confirmación de todas las clínicas (admin, con owner). */
export async function listPendingSaasPayments(
  tx: Db,
  limit = 100,
): Promise<SaasPendingPaymentRow[]> {
  const rows = await tx
    .select({ payment: saasPayment, orgName: organization.name })
    .from(saasPayment)
    .leftJoin(organization, eq(organization.id, saasPayment.organizationId))
    .where(eq(saasPayment.status, "pendiente"))
    .orderBy(asc(saasPayment.createdAt), asc(saasPayment.id))
    .limit(Math.min(Math.max(limit, 1), 200))
  return rows.map((row) => ({ ...toPaymentRow(row.payment), organizationName: row.orgName }))
}

// --- Vendedores y comisiones -----------------------------------------------------------

export interface SaasSellerRow {
  id: string
  userId: string | null
  displayName: string
  rateBps: number
  windowDays: number
  isActive: boolean
}

export async function listSaasSellers(tx: Db, includeInactive = false): Promise<SaasSellerRow[]> {
  const rows = await tx
    .select()
    .from(saasSeller)
    .where(includeInactive ? undefined : eq(saasSeller.isActive, true))
    .orderBy(asc(saasSeller.displayName))
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    rateBps: row.rateBps,
    windowDays: row.windowDays,
    isActive: row.isActive,
  }))
}

export async function upsertSaasSeller(
  tx: Db,
  actorUserId: string,
  input: {
    userId?: string | null
    displayName: string
    rateBps: number
    windowDays?: number
    isActive?: boolean
  },
): Promise<SaasSellerRow> {
  const displayName = input.displayName.trim()
  if (!displayName || displayName.length > 120)
    throw validation("El nombre del vendedor debe tener 1–120 caracteres")
  if (!Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 10000)
    throw validation("El porcentaje debe estar entre 0 y 10000 puntos básicos")
  const windowDays = input.windowDays ?? 90
  if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > 730)
    throw validation("La ventana debe estar entre 0 y 730 días")
  if (input.userId) {
    const [existing] = await tx
      .select()
      .from(saasSeller)
      .where(eq(saasSeller.userId, input.userId))
      .limit(1)
    if (existing) {
      const [row] = await tx
        .update(saasSeller)
        .set({
          displayName,
          rateBps: input.rateBps,
          windowDays,
          isActive: input.isActive ?? true,
          updatedAt: new Date(),
        })
        .where(eq(saasSeller.id, existing.id))
        .returning()
      if (!row) throw notFound("Vendedor")
      void actorUserId
      return {
        id: row.id,
        userId: row.userId,
        displayName: row.displayName,
        rateBps: row.rateBps,
        windowDays: row.windowDays,
        isActive: row.isActive,
      }
    }
  }
  const [row] = await tx
    .insert(saasSeller)
    .values({
      userId: input.userId ?? null,
      displayName,
      rateBps: input.rateBps,
      windowDays,
      isActive: input.isActive ?? true,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 409, "No se pudo guardar el vendedor")
  void actorUserId
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    rateBps: row.rateBps,
    windowDays: row.windowDays,
    isActive: row.isActive,
  }
}

export interface SaasCommissionRow {
  id: string
  organizationId: string
  organizationName: string | null
  paymentId: string
  rateBps: number
  windowDays: number
  baseCents: number
  commissionCents: number
  currency: string
  status: "pendiente" | "liquidada" | "ajustada"
  occurredAt: Date
}

/** Comisiones pendientes de liquidar (admin, con owner). */
export async function listPendingSaasCommissions(
  tx: Db,
  sellerId?: string,
): Promise<SaasCommissionRow[]> {
  const filters = [eq(saasSellerCommission.status, "pendiente")]
  if (sellerId) filters.push(eq(saasSellerCommission.sellerId, sellerId))
  const rows = await tx
    .select({ commission: saasSellerCommission, orgName: organization.name })
    .from(saasSellerCommission)
    .leftJoin(organization, eq(organization.id, saasSellerCommission.organizationId))
    .where(and(...filters))
    .orderBy(asc(saasSellerCommission.createdAt))
  return rows.map((row) => ({
    id: row.commission.id,
    organizationId: row.commission.organizationId,
    organizationName: row.orgName,
    paymentId: row.commission.paymentId ?? "",
    rateBps: row.commission.rateBps,
    windowDays: row.commission.windowDays,
    baseCents: row.commission.baseCents,
    commissionCents: row.commission.commissionCents,
    currency: row.commission.currency,
    status: row.commission.status as SaasCommissionRow["status"],
    occurredAt: row.commission.createdAt,
  }))
}

export interface SaasSettlementRow {
  id: string
  sellerId: string
  periodYear: number
  periodMonth: number
  currency: string
  grossCents: number
  adjustmentCents: number
  totalCents: number
  status: "liquidada" | "anulada"
  settledAt: Date | null
  lineCount: number
}

export interface SaasSettlementEmail {
  to: string
  subject: string
  text: string
  html: string
  dedupeKey: string
  organizationId: string
}

/**
 * Liquida el mes de un vendedor: congela comisiones pendientes y ajustes no
 * aplicados en líneas inmutables. Idempotente por (vendedor, año, mes,
 * moneda): repetir devuelve la misma liquidación. Devuelve el resumen para
 * que la ruta/worker envíe UN correo vía mailer (dedupeKey único; el envío
 * ambiguo se concilia por `saas_notice`, no reintentando el envío).
 */
export async function settleSaasCommissions(
  tx: Db,
  actorUserId: string,
  input: { sellerId: string; year: number; month: number; currency: string; notes?: string | null },
  now = new Date(),
): Promise<{ settlement: SaasSettlementRow; email: SaasSettlementEmail | null }> {
  const unit = currency(input.currency)
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100)
    throw validation("El año debe estar entre 2000 y 2100")
  if (!Number.isInteger(input.month) || input.month < 1 || input.month > 12)
    throw validation("El mes debe estar entre 1 y 12")
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`saas-settle:${input.sellerId}:${input.year}:${input.month}:${unit}`}, 0))`,
  )
  const [seller] = await tx
    .select()
    .from(saasSeller)
    .where(eq(saasSeller.id, input.sellerId))
    .limit(1)
  if (!seller) throw notFound("Vendedor")
  const [replay] = await tx
    .select()
    .from(saasCommissionSettlement)
    .where(
      and(
        eq(saasCommissionSettlement.sellerId, input.sellerId),
        eq(saasCommissionSettlement.periodYear, input.year),
        eq(saasCommissionSettlement.periodMonth, input.month),
        eq(saasCommissionSettlement.currency, unit),
        isNull(saasCommissionSettlement.voidedAt),
      ),
    )
    .limit(1)
  if (replay) {
    const lines = await tx
      .select({ id: saasCommissionSettlementLine.id })
      .from(saasCommissionSettlementLine)
      .where(eq(saasCommissionSettlementLine.settlementId, replay.id))
    return {
      settlement: {
        id: replay.id,
        sellerId: replay.sellerId,
        periodYear: replay.periodYear,
        periodMonth: replay.periodMonth,
        currency: replay.currency,
        grossCents: replay.grossCents,
        adjustmentCents: replay.adjustmentCents,
        totalCents: replay.totalCents,
        status: replay.status as SaasSettlementRow["status"],
        settledAt: replay.settledAt,
        lineCount: lines.length,
      },
      email: null,
    }
  }
  const monthStart = new Date(Date.UTC(input.year, input.month - 1, 1))
  const monthEnd = new Date(Date.UTC(input.year, input.month, 1))
  const pending = await tx
    .select()
    .from(saasSellerCommission)
    .where(
      and(
        eq(saasSellerCommission.sellerId, input.sellerId),
        eq(saasSellerCommission.status, "pendiente"),
        eq(saasSellerCommission.currency, unit),
        gte(saasSellerCommission.createdAt, monthStart),
        lt(saasSellerCommission.createdAt, monthEnd),
      ),
    )
  const adjustments = await tx
    .select()
    .from(saasCommissionAdjustment)
    .where(
      and(
        eq(saasCommissionAdjustment.sellerId, input.sellerId),
        eq(saasCommissionAdjustment.currency, unit),
        isNull(saasCommissionAdjustment.appliedAt),
      ),
    )
  if (pending.length === 0 && adjustments.length === 0)
    throw conflict("SAAS_NOTHING_TO_SETTLE", "No hay comisiones ni ajustes por liquidar")
  let grossCents = 0
  for (const commission of pending) grossCents += commission.commissionCents
  let adjustmentCents = 0
  for (const adjustment of adjustments) adjustmentCents += adjustment.amountCents
  const totalCents = grossCents - adjustmentCents
  if (totalCents < 0)
    throw conflict(
      "SAAS_SETTLEMENT_NEGATIVE",
      "Los ajustes superan lo liquidable: revisa los reversos",
    )
  const [settlement] = await tx
    .insert(saasCommissionSettlement)
    .values({
      sellerId: input.sellerId,
      periodYear: input.year,
      periodMonth: input.month,
      currency: unit,
      grossCents,
      adjustmentCents,
      totalCents,
      status: "liquidada",
      notes: input.notes?.trim() ? input.notes.trim().slice(0, 2000) : null,
      settledBy: actorUserId,
      settledAt: now,
    })
    .returning()
  if (!settlement) throw new ServiceError("INTERNAL", 409, "No se pudo registrar la liquidación")
  // Filas congeladas tal como quedaron en BD: el correo se arma desde aquí, no de copias en memoria.
  const frozen: { kind: string; organizationId: string | null; description: string; amountCents: number }[] = []
  try {
    for (const commission of pending) {
      const [line] = await tx
        .insert(saasCommissionSettlementLine)
        .values({
          settlementId: settlement.id,
          kind: "cobro",
          sourceKey: `saas-comision:${commission.id}`,
          commissionId: commission.id,
          organizationId: commission.organizationId,
          description: `Cobro confirmado ${commission.baseCents} (${commission.rateBps} pb)`,
          amountCents: commission.commissionCents,
          currency: commission.currency,
          occurredAt: commission.createdAt,
        })
        .returning({
          kind: saasCommissionSettlementLine.kind,
          organizationId: saasCommissionSettlementLine.organizationId,
          description: saasCommissionSettlementLine.description,
          amountCents: saasCommissionSettlementLine.amountCents,
        })
      if (line) frozen.push(line)
      await tx
        .update(saasSellerCommission)
        .set({ status: "liquidada", settledAt: now })
        .where(eq(saasSellerCommission.id, commission.id))
    }
    for (const adjustment of adjustments) {
      const [line] = await tx
        .insert(saasCommissionSettlementLine)
        .values({
          settlementId: settlement.id,
          kind: "ajuste",
          sourceKey: `saas-ajuste:${adjustment.id}`,
          adjustmentId: adjustment.id,
          organizationId: adjustment.organizationId,
          description: adjustment.reason.slice(0, 500),
          amountCents: -adjustment.amountCents,
          currency: adjustment.currency,
          occurredAt: adjustment.createdAt,
        })
        .returning({
          kind: saasCommissionSettlementLine.kind,
          organizationId: saasCommissionSettlementLine.organizationId,
          description: saasCommissionSettlementLine.description,
          amountCents: saasCommissionSettlementLine.amountCents,
        })
      if (line) frozen.push(line)
      await tx
        .update(saasCommissionAdjustment)
        .set({ appliedAt: now })
        .where(eq(saasCommissionAdjustment.id, adjustment.id))
    }
  } catch (error) {
    if (isUniqueViolation(error))
      throw conflict(
        "SAAS_ALREADY_SETTLED",
        "Parte de esas comisiones ya entró en otra liquidación",
      )
    throw error
  }
  // Aviso persistido: el correo se envía una vez (dedupeKey por liquidación).
  const dedupeKey = `liquidacion:${settlement.id}`
  let sellerEmail: string | null = null
  if (seller.userId) {
    const [account] = await tx
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, seller.userId))
      .limit(1)
    sellerEmail = account?.email ?? null
  }
  let email: SaasSettlementEmail | null = null
  if (sellerEmail) {
    const noticeOrgId = pending[0]?.organizationId ?? adjustments[0]?.organizationId ?? null
    if (noticeOrgId) {
      const money = (cents: number) =>
        new Intl.NumberFormat("es", { style: "currency", currency: unit, currencyDisplay: "code" }).format(cents / 100)
      // Detalle desde las filas congeladas: una por clínica (comisión sumada) y una por ajuste (motivo).
      // Los nombres de clínica no están congelados: solo se leen; sin nombre, el id explícito, sin inventar.
      const cobros = frozen.filter((line) => line.kind === "cobro")
      const clinicIds = [...new Set(cobros.map((line) => line.organizationId).filter((id): id is string => Boolean(id)))]
      const orgNames = new Map<string, string>()
      if (clinicIds.length > 0) {
        const orgs = await tx
          .select({ id: organization.id, name: organization.name })
          .from(organization)
          .where(inArray(organization.id, clinicIds))
        for (const org of orgs) orgNames.set(org.id, org.name)
      }
      const grossByClinic = new Map<string, number>()
      for (const line of cobros) {
        if (!line.organizationId) continue
        grossByClinic.set(line.organizationId, (grossByClinic.get(line.organizationId) ?? 0) + line.amountCents)
      }
      const clinicLines = [...grossByClinic.entries()]
        .map(([orgId, cents]) => ({ label: orgNames.get(orgId) ?? orgId, amount: money(cents) }))
        .sort((a, b) => a.label.localeCompare(b.label, "es"))
      const adjustmentLines = frozen
        .filter((line) => line.kind === "ajuste")
        .map((line) => ({
          // La descripción congelada del ajuste es su motivo.
          label: `Ajuste: ${line.description}`,
          amount: money(line.amountCents),
        }))
      const { subject, text, html } = saasSettlementEmail({
        sellerName: seller.displayName,
        monthText: new Intl.DateTimeFormat("es", { month: "long", year: "numeric", timeZone: "UTC" }).format(
          new Date(Date.UTC(input.year, input.month - 1, 1)),
        ),
        clinics: new Set(pending.map((commission) => commission.organizationId)).size,
        gross: money(grossCents),
        // Los ajustes se descuentan del total: van con su signo.
        adjustments: money(-adjustmentCents),
        total: money(totalCents),
        lines: [...clinicLines, ...adjustmentLines],
      })
      await tx
        .insert(saasNotice)
        .values({
          organizationId: noticeOrgId,
          kind: "liquidacion_vendedor",
          dedupeKey,
          sentAt: now,
          emailTo: sellerEmail,
          metadata: JSON.stringify({
            to: sellerEmail,
            subject,
            text,
            html,
            settlementId: settlement.id,
          }),
        })
        .onConflictDoNothing({ target: [saasNotice.organizationId, saasNotice.dedupeKey] })
      email = { to: sellerEmail, subject, text, html, dedupeKey, organizationId: noticeOrgId }
    }
  }
  return {
    settlement: {
      id: settlement.id,
      sellerId: settlement.sellerId,
      periodYear: settlement.periodYear,
      periodMonth: settlement.periodMonth,
      currency: settlement.currency,
      grossCents: settlement.grossCents,
      adjustmentCents: settlement.adjustmentCents,
      totalCents: settlement.totalCents,
      status: "liquidada",
      settledAt: settlement.settledAt,
      lineCount: pending.length + adjustments.length,
    },
    email,
  }
}

/** Anula una liquidación por error (sus líneas quedan, marcadas por estado; no se borran). */
export async function voidSaasSettlement(
  tx: Db,
  actorUserId: string,
  settlementId: string,
  voidReason: string,
): Promise<void> {
  const motive = reason(voidReason, "El motivo de la anulación")
  const [current] = await tx
    .select()
    .from(saasCommissionSettlement)
    .where(eq(saasCommissionSettlement.id, settlementId))
    .for("update")
  if (!current) throw notFound("Liquidación")
  if (current.voidedAt) throw conflict("SAAS_SETTLEMENT_VOIDED", "Esa liquidación ya está anulada")
  await tx
    .update(saasCommissionSettlement)
    .set({ status: "anulada", voidedAt: new Date(), voidedBy: actorUserId, voidReason: motive })
    .where(eq(saasCommissionSettlement.id, settlementId))
  // Las comisiones vuelven a pendiente para una nueva liquidación correcta y
  // las líneas se marcan (liberan su sourceKey para reliquidar; no se borran).
  await tx
    .update(saasCommissionSettlementLine)
    .set({ voidedAt: new Date() })
    .where(
      and(
        eq(saasCommissionSettlementLine.settlementId, settlementId),
        isNull(saasCommissionSettlementLine.voidedAt),
      ),
    )
  const lines = await tx
    .select()
    .from(saasCommissionSettlementLine)
    .where(eq(saasCommissionSettlementLine.settlementId, settlementId))
  for (const line of lines) {
    if (line.kind === "cobro" && line.commissionId) {
      await tx
        .update(saasSellerCommission)
        .set({ status: "pendiente", settledAt: null })
        .where(eq(saasSellerCommission.id, line.commissionId))
    }
    if (line.kind === "ajuste" && line.adjustmentId) {
      await tx
        .update(saasCommissionAdjustment)
        .set({ appliedAt: null })
        .where(eq(saasCommissionAdjustment.id, line.adjustmentId))
    }
  }
}

export async function listSaasSettlements(
  tx: Db,
  sellerId?: string,
  limit = 50,
): Promise<SaasSettlementRow[]> {
  const rows = await tx
    .select()
    .from(saasCommissionSettlement)
    .where(
      and(
        sellerId ? eq(saasCommissionSettlement.sellerId, sellerId) : undefined,
        isNull(saasCommissionSettlement.voidedAt),
      ),
    )
    .orderBy(desc(saasCommissionSettlement.settledAt))
    .limit(Math.min(Math.max(limit, 1), 200))
  const result: SaasSettlementRow[] = []
  for (const row of rows) {
    const lines = await tx
      .select({ id: saasCommissionSettlementLine.id })
      .from(saasCommissionSettlementLine)
      .where(eq(saasCommissionSettlementLine.settlementId, row.id))
    result.push({
      id: row.id,
      sellerId: row.sellerId,
      periodYear: row.periodYear,
      periodMonth: row.periodMonth,
      currency: row.currency,
      grossCents: row.grossCents,
      adjustmentCents: row.adjustmentCents,
      totalCents: row.totalCents,
      status: row.status as SaasSettlementRow["status"],
      settledAt: row.settledAt,
      lineCount: lines.length,
    })
  }
  return result
}

// --- Tick: prueba 14d / gracia 7d / restricción ------------------------------------------

export interface SaasTickNotice {
  organizationId: string
  kind: string
  emailedTo: string | null
}

export interface SaasTickSummary {
  trialsEnding: number
  trialsEnded: number
  gracesEnded: number
  restricted: number
  notices: SaasTickNotice[]
  /** Cargos del mes asegurados (nuevos o ya existentes). */
  chargesEnsured: number
}

export interface SaasTickMail {
  to: string
  subject: string
  text: string
  html: string
  dedupeKey: string
  organizationId: string
  kind: string
}

/**
 * Automatización del ciclo (la invoca el worker con ownerDb, una vez al día):
 * avisa fin de prueba próximo, pasa a gracia al día 14, restringe al día 7
 * de gracia sin pago ni prórroga vigente. Todo con avisos persistidos
 * (idempotente). Demo exenta. No envía dentro de la transacción: devuelve los
 * correos y el worker los manda uno por uno (dedupeKey único).
 */
export async function tickSaasBilling(
  tx: Db,
  now = new Date(),
  /** Origen del panel para el botón a Plan y pagos; sin él, los avisos van sin botón. */
  links: { panelUrl?: string | undefined } = {},
): Promise<{ summary: SaasTickSummary; mails: SaasTickMail[] }> {
  const mails: SaasTickMail[] = []
  const mailedKeys: Record<string, true> = {}
  const notices: SaasTickNotice[] = []
  let trialsEnding = 0
  let trialsEnded = 0
  let gracesEnded = 0
  let restricted = 0

  async function orgEmail(orgId: string): Promise<string | null> {
    // Los avisos los reciben el propietario y el administrador (ADR 0031, decisión 9).
    const owners = await tx
      .select({ email: user.email })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
      .limit(5)
    return owners.length ? owners.map((owner) => owner.email).join(", ") : null
  }

  // El ciclo corre cada minuto y casi siempre el aviso ya existe: el nombre se lee una vez por clínica.
  const clinicNames = new Map<string, string>()
  async function clinicName(orgId: string): Promise<string> {
    const known = clinicNames.get(orgId)
    if (known) return known
    const [org] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId)).limit(1)
    const name = org?.name ?? "tu clínica"
    clinicNames.set(orgId, name)
    return name
  }
  const billingUrl = (orgId: string) => saasBillingUrl(links.panelUrl, orgId)

  /** El último día de la gracia y lo que se debe, como se leen en la clínica. */
  async function overdueEmail(orgId: string, lastDay: Date): Promise<MailTemplate> {
    const locale = await getOrgLocale(tx, orgId).catch(() => null)
    const day = new Intl.DateTimeFormat(locale?.locale ?? "es", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: locale?.timezone ?? "UTC",
    }).format(lastDay)
    const amounts = (await outstandingByCurrency(tx, orgId))
      .filter((entry) => entry.cents > 0)
      .map((entry) =>
        new Intl.NumberFormat(locale?.locale ?? "es", { style: "currency", currency: entry.currency }).format(entry.cents / 100),
      )
    return saasOverdueEmail({ clinic: await clinicName(orgId), lastDay: day, amounts, url: billingUrl(orgId) })
  }

  async function recordNotice(
    orgId: string,
    kind: string,
    dedupeKey: string,
    email: SaasTickMail | null,
  ): Promise<void> {
    const [row] = await tx
      .insert(saasNotice)
      .values({
        organizationId: orgId,
        kind,
        dedupeKey,
        sentAt: now,
        emailTo: email?.to ?? null,
        metadata: email
          ? JSON.stringify({
              to: email.to,
              subject: email.subject,
              text: email.text,
              html: email.html,
            })
          : null,
      })
      .onConflictDoNothing({ target: [saasNotice.organizationId, saasNotice.dedupeKey] })
      .returning()
    if (!row) return
    notices.push({ organizationId: orgId, kind, emailedTo: email?.to ?? null })
    if (email) {
      mails.push(email)
      mailedKeys[`${orgId}|${dedupeKey}`] = true
    }
  }

  // 1. Avisos de la prueba, del crédito y del tope (ADR 0031): una vez por
  // nivel y por tramo, en la plataforma (calculados al leer) y por correo.
  const watched = await tx
    .select({ organizationId: saasSubscription.organizationId })
    .from(saasSubscription)
    .where(and(eq(saasSubscription.isDemo, false), inArray(saasSubscription.status, ["prueba", "activa", "gracia"])))
  for (const sub of watched) {
    const alerts = await getSaasAlerts(tx, sub.organizationId, now)
    for (const alert of alerts) {
      if (alert.family === "dias_prueba") trialsEnding += 1
      const dedupeKey = `${alert.family}:${alert.level}:${alert.periodKey}`
      // Ni un correo más (ADR 0065): el crédito avisa por correo solo al
      // acabarse y el tope desde el 90 %; lo demás queda en la franja.
      const mailed = !(alert.family === "credito" && alert.level !== "limite") && !(alert.family === "tope" && alert.level === "aviso")
      const emailTo = mailed ? await orgEmail(sub.organizationId) : null
      await recordNotice(
        sub.organizationId,
        `${alert.family}_${alert.level}`,
        dedupeKey,
        emailTo
          ? {
              to: emailTo,
              ...mailParts(saasAlertEmail(alert, await clinicName(sub.organizationId), billingUrl(sub.organizationId))),
              dedupeKey: `${dedupeKey}:${sub.organizationId}`,
              organizationId: sub.organizationId,
              kind: `${alert.family}_${alert.level}`,
            }
          : null,
      )
    }
  }

  // 1b. Lo negociado que venció (issue 168) y las condiciones de Fundador que
  // terminaron (issue 165): a precio de lista desde el día siguiente. Los
  // avisos de antes ya salieron en el paso 1 (`precio_especial`, `condiciones`).
  await clearExpiredDiscounts(tx, now)
  for (const orgId of await endFounderGuarantees(tx, now)) await notifyOrg(tx, orgId, "saas.subscription.updated")

  // 1c. Llegó un cargo (ADR 0065): se avisa por correo el día que llega, con
  // el día en que vence (7 días después). Una vez por cargo.
  const issuedCharges = await tx
    .select()
    .from(saasCharge)
    .innerJoin(saasSubscription, eq(saasSubscription.organizationId, saasCharge.organizationId))
    .where(
      and(
        eq(saasSubscription.isDemo, false),
        inArray(saasCharge.status, ["pendiente", "parcial"]),
        isNull(saasCharge.voidedAt),
        gte(saasCharge.createdAt, new Date(now.getTime() - 2 * 86_400_000)),
        gt(saasCharge.dueAt, now),
      ),
    )
  for (const { saas_charge: charge } of issuedCharges) {
    if (!charge.dueAt) continue
    const orgId = charge.organizationId
    const emailTo = await orgEmail(orgId)
    const locale = await getOrgLocale(tx, orgId).catch(() => null)
    const lang = locale?.locale ?? "es"
    const dueDay = new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long", timeZone: locale?.timezone ?? "UTC" }).format(charge.dueAt)
    const monthText = new Intl.DateTimeFormat(lang, { month: "long", year: "numeric", timeZone: "UTC" }).format(charge.periodStart)
    const amount = new Intl.NumberFormat(lang, { style: "currency", currency: charge.currency, currencyDisplay: "code" }).format(
      (charge.amountCents - charge.paidCents) / 100,
    )
    await recordNotice(
      orgId,
      "cargo_emitido",
      `cargo:${charge.id}`,
      emailTo
        ? {
            to: emailTo,
            ...mailParts(saasChargeIssuedEmail({ clinic: await clinicName(orgId), monthText, amount, dueDay, url: billingUrl(orgId) })),
            dedupeKey: `cargo:${orgId}:${charge.id}`,
            organizationId: orgId,
            kind: "cargo_emitido",
          }
        : null,
    )
  }

  // 1d. Mañana termina la gracia (ADR 0065): último correo antes de solo
  // lectura. Con un comprobante en revisión no se avisa: el servidor espera.
  const gracesEndingTomorrow = await tx
    .select()
    .from(saasSubscription)
    .where(
      and(
        eq(saasSubscription.status, "gracia"),
        eq(saasSubscription.isDemo, false),
        gt(saasSubscription.graceEndsAt, now),
        lte(saasSubscription.graceEndsAt, new Date(now.getTime() + 86_400_000)),
      ),
    )
  for (const sub of gracesEndingTomorrow) {
    const [inReview] = await tx
      .select({ id: saasPayment.id })
      .from(saasPayment)
      .where(and(eq(saasPayment.organizationId, sub.organizationId), eq(saasPayment.status, "pendiente")))
      .limit(1)
    if (inReview || !sub.graceEndsAt) continue
    const emailTo = await orgEmail(sub.organizationId)
    const day = sub.graceEndsAt.toISOString().slice(0, 10)
    const locale = await getOrgLocale(tx, sub.organizationId).catch(() => null)
    const amounts = (await outstandingByCurrency(tx, sub.organizationId))
      .filter((entry) => entry.cents > 0)
      .map((entry) => new Intl.NumberFormat(locale?.locale ?? "es", { style: "currency", currency: entry.currency }).format(entry.cents / 100))
    await recordNotice(
      sub.organizationId,
      "restriccion_manana",
      `restriccion-manana:${day}`,
      emailTo
        ? {
            to: emailTo,
            ...mailParts(saasRestrictionSoonEmail({ clinic: await clinicName(sub.organizationId), amounts, url: billingUrl(sub.organizationId) })),
            dedupeKey: `restriccion-manana:${sub.organizationId}:${day}`,
            organizationId: sub.organizationId,
            kind: "restriccion_manana",
          }
        : null,
    )
  }

  // 2. Prueba vencida → gracia 7 días.
  const trialsOver = await tx
    .select()
    .from(saasSubscription)
    .where(
      and(
        eq(saasSubscription.status, "prueba"),
        eq(saasSubscription.isDemo, false),
        lt(saasSubscription.trialEndsAt, now),
      ),
    )
  for (const sub of trialsOver) {
    trialsEnded += 1
    // Sin plan no hay nada que cobrar ni período que abrir: se restringe con
    // motivo propio en vez de regalar gracia/activa. Elige plan y se reanuda.
    if (!sub.planId) {
      restricted += 1
      await tx
        .update(saasSubscription)
        .set({ status: "restringida", restrictReason: "sin_plan", updatedAt: now })
        .where(eq(saasSubscription.organizationId, sub.organizationId))
      await audit(
        tx,
        sub.organizationId,
        "system",
        "saas_subscription",
        sub.organizationId,
        "saas.restricted_no_plan",
      )
      await notifyOrg(tx, sub.organizationId, "saas.subscription.updated")
      // Antes pasaba a solo lectura sin decir nada: ahora se avisa una vez.
      const emailTo = await orgEmail(sub.organizationId)
      const day = now.toISOString().slice(0, 10)
      await recordNotice(
        sub.organizationId,
        "prueba_vencida_sin_plan",
        `prueba-vencida-sin-plan:${day}`,
        emailTo
          ? {
              to: emailTo,
              ...mailParts(saasTrialEndedEmail(await clinicName(sub.organizationId), billingUrl(sub.organizationId))),
              dedupeKey: `prueba-vencida-sin-plan:${sub.organizationId}:${day}`,
              organizationId: sub.organizationId,
              kind: "prueba_vencida_sin_plan",
            }
          : null,
      )
      continue
    }
    // Con plan elegido, la prueba deja paso al plan: el mes de la clínica
    // empieza hoy y su cargo sale al cerrarlo, con lo que hicieron los agentes
    // (ADR 0031). La gracia queda para los cargos que no se pagan.
    await tx
      .update(saasSubscription)
      .set({ status: "activa", activatedAt: now, currentPeriodStart: now, currentPeriodEnd: addMonth(now), updatedAt: now })
      .where(eq(saasSubscription.organizationId, sub.organizationId))
    await audit(
      tx,
      sub.organizationId,
      "system",
      "saas_subscription",
      sub.organizationId,
      "saas.trial_ended",
    )
    await notifyOrg(tx, sub.organizationId, "saas.subscription.updated")
    const emailTo = await orgEmail(sub.organizationId)
    const day = now.toISOString().slice(0, 10)
    await recordNotice(
      sub.organizationId,
      "plan_activo",
      `plan-activo:${day}`,
      emailTo
        ? {
            to: emailTo,
            ...mailParts(saasPlanStartedEmail(await clinicName(sub.organizationId), billingUrl(sub.organizationId))),
            dedupeKey: `plan-activo:${sub.organizationId}:${day}`,
            organizationId: sub.organizationId,
            kind: "plan_activo",
          }
        : null,
    )
  }

  // 3. Gracia vencida sin pago ni prórroga → restringida.
  const gracesOver = await tx
    .select()
    .from(saasSubscription)
    .where(
      and(
        eq(saasSubscription.status, "gracia"),
        eq(saasSubscription.isDemo, false),
        lt(saasSubscription.graceEndsAt, now),
      ),
    )
  for (const sub of gracesOver) {
    gracesEnded += 1
    if (sub.proofExtensionUntil && sub.proofExtensionUntil > now) continue
    // Con comprobante pendiente reciente se espera la confirmación admin.
    const [pendingProof] = await tx
      .select({ id: saasPayment.id })
      .from(saasPayment)
      .where(
        and(
          eq(saasPayment.organizationId, sub.organizationId),
          eq(saasPayment.status, "pendiente"),
          gte(saasPayment.createdAt, addDays(now, -SAAS_PROOF_EXTENSION_DAYS)),
        ),
      )
      .limit(1)
    if (pendingProof) continue
    const due = await outstandingCents(tx, sub.organizationId)
    // Sin plan no se reactiva gratis aunque no haya saldo: falta elegir plan.
    if (due <= 0 && sub.planId) {
      await tx
        .update(saasSubscription)
        .set({
          status: "activa",
          graceEndsAt: null,
          ...(sub.currentPeriodEnd ? {} : { currentPeriodStart: now, currentPeriodEnd: addMonth(now) }),
          updatedAt: now,
        })
        .where(eq(saasSubscription.organizationId, sub.organizationId))
      continue
    }
    restricted += 1
    await tx
      .update(saasSubscription)
      .set({ status: "restringida", restrictReason: "gracia_vencida", updatedAt: now })
      .where(eq(saasSubscription.organizationId, sub.organizationId))
    await audit(
      tx,
      sub.organizationId,
      "system",
      "saas_subscription",
      sub.organizationId,
      "saas.restricted",
    )
    await notifyOrg(tx, sub.organizationId, "saas.subscription.updated")
    const emailTo = await orgEmail(sub.organizationId)
    await recordNotice(
      sub.organizationId,
      "restriccion_inicio",
      `restriccion:${now.toISOString().slice(0, 10)}`,
      emailTo
        ? {
            to: emailTo,
            ...mailParts(saasRestrictedEmail(await clinicName(sub.organizationId), billingUrl(sub.organizationId))),
            dedupeKey: `restriccion:${sub.organizationId}:${now.toISOString().slice(0, 10)}`,
            organizationId: sub.organizationId,
            kind: "restriccion_inicio",
          }
        : null,
    )
  }

  // 4. Cobro por acción (ADR 0031): al cerrar cada tramo, el cargo con sus
  // líneas; con ciclo quincenal, también a mitad de tramo. La cobranza sigue
  // siendo manual con comprobante.
  const { issued: chargesEnsured } = await closeSaasPeriods(tx, now)

  // 5. Cargo vencido sin pagar → gracia de 7 días antes de restringir.
  for (const orgId of await overdueChargeOrgs(tx, now)) {
    const graceEndsAt = addDays(now, SAAS_GRACE_DAYS)
    await tx
      .update(saasSubscription)
      .set({ status: "gracia", graceEndsAt, updatedAt: now })
      .where(eq(saasSubscription.organizationId, orgId))
    await audit(tx, orgId, "system", "saas_subscription", orgId, "saas.period_over")
    await notifyOrg(tx, orgId, "saas.subscription.updated")
    const emailTo = await orgEmail(orgId)
    const day = now.toISOString().slice(0, 10)
    await recordNotice(
      orgId,
      "gracia_inicio",
      `gracia-inicio:${day}`,
      emailTo
        ? {
            to: emailTo,
            ...mailParts(await overdueEmail(orgId, graceEndsAt)),
            dedupeKey: `gracia-inicio:${orgId}:${day}`,
            organizationId: orgId,
            kind: "gracia_inicio",
          }
        : null,
    )
  }

  // Correos huérfanos (aviso creado pero worker caído antes de reclamar):
  // se devuelven para reclamar; los ya listados no se duplican.
  const pendingNotices = await tx
    .select({
      organizationId: saasNotice.organizationId,
      kind: saasNotice.kind,
      dedupeKey: saasNotice.dedupeKey,
      metadata: saasNotice.metadata,
    })
    .from(saasNotice)
    .where(
      and(
        eq(saasNotice.emailState, "pendiente"),
        isNull(saasNotice.emailedAt),
        isNotNull(saasNotice.emailTo),
      ),
    )
    .limit(200)
  for (const pending of pendingNotices) {
    if (mailedKeys[`${pending.organizationId}|${pending.dedupeKey}`]) continue
    const mail = parseNoticeMail(pending.metadata)
    if (!mail) continue
    mails.push({
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      dedupeKey: pending.dedupeKey,
      organizationId: pending.organizationId,
      kind: pending.kind,
    })
  }
  return {
    summary: { trialsEnding, trialsEnded, gracesEnded, restricted, notices, chargesEnsured },
    mails,
  }
}

// --- Lecturas admin agregadas ------------------------------------------------------------

export interface SaasAdminOverview {
  organizationId: string
  organizationName: string | null
  status: SaasSubscriptionStatus
  isDemo: boolean
  planCode: string | null
  planName: string | null
  currency: string | null
  outstandingByCurrency: SaasMoneyByCurrency[]
  trialEndsAt: Date | null
  graceEndsAt: Date | null
}

/** Tablero admin: suscripciones con saldo (con owner; paginado simple). */
export async function listSaasOverview(
  tx: Db,
  query: { status?: string; limit?: number } = {},
): Promise<SaasAdminOverview[]> {
  const filters = []
  if (query.status) {
    if (
      !(["prueba", "activa", "gracia", "restringida", "pausada", "cancelada"] as string[]).includes(
        query.status,
      )
    )
      throw validation("Estado inválido")
    filters.push(eq(saasSubscription.status, query.status))
  }
  const subs = await tx
    .select({
      sub: saasSubscription,
      orgName: organization.name,
      planCode: saasPlan.code,
      planName: saasPlan.name,
      currency: saasPlan.currency,
    })
    .from(saasSubscription)
    .leftJoin(organization, eq(organization.id, saasSubscription.organizationId))
    .leftJoin(saasPlan, eq(saasPlan.id, saasSubscription.planId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(saasSubscription.updatedAt))
    .limit(Math.min(Math.max(query.limit ?? 50, 1), 200))
  const result: SaasAdminOverview[] = []
  for (const row of subs) {
    const byCurrency = await outstandingByCurrency(tx, row.sub.organizationId)
    result.push({
      organizationId: row.sub.organizationId,
      organizationName: row.orgName,
      status: row.sub.status as SaasSubscriptionStatus,
      isDemo: row.sub.isDemo,
      planCode: row.planCode,
      planName: row.planName,
      currency: row.currency,
      outstandingByCurrency: byCurrency,
      trialEndsAt: row.sub.trialEndsAt,
      graceEndsAt: row.sub.graceEndsAt,
    })
  }
  return result
}

/**
 * Correo guardado en un aviso (lo escribe `recordNotice`/liquidación).
 * Frontera validada por narrowing: sin forma válida no hay envío.
 */
export interface SaasNoticeMail {
  to: string
  subject: string
  text: string
  html: string
}
export function parseNoticeMail(metadata: string | null): SaasNoticeMail | null {
  if (!metadata) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(metadata)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  if (!("to" in parsed) || !("subject" in parsed) || !("text" in parsed) || !("html" in parsed))
    return null
  const to: unknown = parsed.to
  const subject: unknown = parsed.subject
  const text: unknown = parsed.text
  const html: unknown = parsed.html
  if (
    typeof to !== "string" ||
    typeof subject !== "string" ||
    typeof text !== "string" ||
    typeof html !== "string"
  )
    return null
  if (!to || !subject) return null
  return { to, subject, text, html }
}
export interface ClaimedSaasMail extends SaasNoticeMail {
  organizationId: string
  dedupeKey: string
}
/**
 * Reclamo durable ANTES del SMTP: pendiente→reclamado en una sola
 * actualización atómica. Solo quien reclama envía; el resto salta.
 * El efecto está separado del negocio por dedupeKey.
 */
export async function claimSaasNoticeMail(
  tx: Db,
  organizationId: string,
  dedupeKey: string,
): Promise<ClaimedSaasMail | null> {
  const [row] = await tx
    .update(saasNotice)
    .set({ emailState: "reclamado" })
    .where(
      and(
        eq(saasNotice.organizationId, organizationId),
        eq(saasNotice.dedupeKey, dedupeKey),
        eq(saasNotice.emailState, "pendiente"),
      ),
    )
    .returning({
      organizationId: saasNotice.organizationId,
      dedupeKey: saasNotice.dedupeKey,
      metadata: saasNotice.metadata,
    })
  if (!row) return null
  const mail = parseNoticeMail(row.metadata)
  if (!mail) {
    await tx
      .update(saasNotice)
      .set({
        emailState: "incierto",
        metadata: JSON.stringify({ send: "uncertain", reason: "contenido inválido" }),
      })
      .where(
        and(eq(saasNotice.organizationId, organizationId), eq(saasNotice.dedupeKey, dedupeKey)),
      )
    return null
  }
  return { organizationId: row.organizationId, dedupeKey: row.dedupeKey, ...mail }
}
/**
 * Cierra el reclamo: enviado (con fecha) o incierto (con motivo, sin
 * reintento ciego: incierto jamás vuelve a pendiente).
 */
export async function completeSaasNoticeMail(
  tx: Db,
  organizationId: string,
  dedupeKey: string,
  ok: boolean,
  error?: string,
  now = new Date(),
): Promise<void> {
  if (ok) {
    await tx
      .update(saasNotice)
      .set({ emailState: "enviado", emailedAt: now })
      .where(
        and(eq(saasNotice.organizationId, organizationId), eq(saasNotice.dedupeKey, dedupeKey)),
      )
    return
  }
  await tx
    .update(saasNotice)
    .set({
      emailState: "incierto",
      metadata: JSON.stringify({
        send: "uncertain",
        error: error?.slice(0, 500) ?? "fallo de envío",
        at: now.toISOString(),
      }),
    })
    .where(and(eq(saasNotice.organizationId, organizationId), eq(saasNotice.dedupeKey, dedupeKey)))
}

export interface SaasMoneyByCurrency {
  currency: string
  cents: number
}

export interface SaasAdminAttention {
  pendingPaymentCount: number
  pendingPaymentCentsByCurrency: SaasMoneyByCurrency[]
  overdueCount: number
  overdueCentsByCurrency: SaasMoneyByCurrency[]
  trialCount: number
  trialEndingCount: number
  graceCount: number
  restrictedCount: number
  pausedCount: number
  pendingCommissionCount: number
  pendingCommissionCentsByCurrency: SaasMoneyByCurrency[]
}

/**
 * Totales agregados para el Inicio admin (conteos y sumas SQL, sin traer
 * filas). Las listas con `limit` son para la tabla de detalle, nunca para
 * derivar estos totales.
 */
export async function getSaasAdminAttention(tx: Db, now = new Date()): Promise<SaasAdminAttention> {
  const pendingPayments = await tx
    .select({ currency: saasPayment.currency, total: sql<number>`count(*)` })
    .from(saasPayment)
    .where(eq(saasPayment.status, "pendiente"))
    .groupBy(saasPayment.currency)
  let pendingPaymentCount = 0
  const pendingPaymentCentsByCurrency: SaasMoneyByCurrency[] = []
  for (const row of pendingPayments) {
    const count = Number(row.total)
    pendingPaymentCount += count
  }
  const pendingAmounts = await tx
    .select({
      currency: saasPayment.currency,
      total: sql<number>`coalesce(sum(${saasPayment.amountCents}), 0)`,
    })
    .from(saasPayment)
    .where(eq(saasPayment.status, "pendiente"))
    .groupBy(saasPayment.currency)
  for (const row of pendingAmounts) {
    pendingPaymentCentsByCurrency.push({ currency: row.currency, cents: Number(row.total) })
  }
  const overdueCharges = await tx
    .select({
      id: saasCharge.id,
      currency: saasCharge.currency,
      outstanding: sql<number>`${saasCharge.amountCents} - ${saasCharge.paidCents}`,
    })
    .from(saasCharge)
    .where(
      and(
        or(eq(saasCharge.status, "pendiente"), eq(saasCharge.status, "parcial")),
        isNull(saasCharge.voidedAt),
        lt(saasCharge.dueAt, now),
      ),
    )
  const overdueByCurrency: Record<string, number> = {}
  for (const row of overdueCharges) {
    const rest = Number(row.outstanding)
    if (rest > 0) overdueByCurrency[row.currency] = (overdueByCurrency[row.currency] ?? 0) + rest
  }
  const overdueCentsByCurrency: SaasMoneyByCurrency[] = Object.entries(overdueByCurrency).map(
    ([currencyCode, centsValue]) => ({ currency: currencyCode, cents: centsValue }),
  )
  const overdueCount = overdueCharges.filter((row) => Number(row.outstanding) > 0).length
  const statusCounts = await tx
    .select({ status: saasSubscription.status, total: sql<number>`count(*)` })
    .from(saasSubscription)
    .where(eq(saasSubscription.isDemo, false))
    .groupBy(saasSubscription.status)
  const statusOf = (name: string): number => {
    for (const row of statusCounts) {
      if (row.status === name) return Number(row.total)
    }
    return 0
  }
  const trialEndingRows = await tx
    .select({ total: sql<number>`count(*)` })
    .from(saasSubscription)
    .where(
      and(
        eq(saasSubscription.status, "prueba"),
        eq(saasSubscription.isDemo, false),
        lte(saasSubscription.trialEndsAt, addDays(now, 3)),
        gte(saasSubscription.trialEndsAt, now),
      ),
    )
  const pendingCommissions = await tx
    .select({
      currency: saasSellerCommission.currency,
      count: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${saasSellerCommission.commissionCents}), 0)`,
    })
    .from(saasSellerCommission)
    .where(eq(saasSellerCommission.status, "pendiente"))
    .groupBy(saasSellerCommission.currency)
  let pendingCommissionCount = 0
  const pendingCommissionCentsByCurrency: SaasMoneyByCurrency[] = []
  for (const row of pendingCommissions) {
    pendingCommissionCount += Number(row.count)
    pendingCommissionCentsByCurrency.push({ currency: row.currency, cents: Number(row.total) })
  }
  const trialEndingCount = trialEndingRows.length > 0 ? Number(trialEndingRows[0]?.total ?? 0) : 0
  return {
    pendingPaymentCount,
    pendingPaymentCentsByCurrency,
    overdueCount,
    overdueCentsByCurrency,
    trialCount: statusOf("prueba"),
    trialEndingCount,
    graceCount: statusOf("gracia"),
    restrictedCount: statusOf("restringida"),
    pausedCount: statusOf("pausada"),
    pendingCommissionCount,
    pendingCommissionCentsByCurrency,
  }
}
