import type { Db } from "@odentia/db"
import {
  PRICE_DISCLOSURES,
  type PriceDisclosure,
  patientCharge,
  patientPaymentApplication,
  serviceCatalog,
  treatmentBudget,
  treatmentBudgetItem,
} from "@odentia/db/schema/clinical"
import { promotion, promotionServicePrice } from "@odentia/db/schema/promotions"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"

/**
 * Promociones (fases 4–5): nombre, vigencia, precio por servicio (fijo o
 * «desde») y condiciones. Se ofrecen opt-in al presupuestar o al cobrar; la
 * persona decide. Lo cotizado/cobrado congela su snapshot en la línea del
 * presupuesto y jamás relee la promoción vigente.
 *
 * Convención: `tx` ya corre dentro de `withOrgContext`; nunca abrir contexto
 * aquí. Misma operación para pantalla, portal y agente (el agente solo lee
 * vigentes vía `listClinicPromotionSummaries`).
 */

export const PROMOTION_MODES = ["fixed", "from"] as const
export type PromotionMode = (typeof PROMOTION_MODES)[number]

export type PromotionRow = typeof promotion.$inferSelect
export type PromotionPriceRow = typeof promotionServicePrice.$inferSelect

export interface PromotionItemInput {
  serviceId: string
  mode: PromotionMode
  priceCents: number
  /** Cómo lo dice el agente; sin indicarlo sigue al modo («fijo» → exacto, «desde» → desde). */
  priceDisclosure?: PriceDisclosure | null
}

/** Lo que dice el agente de un precio de promoción cuando la clínica no lo eligió. */
function disclosureOf(item: PromotionItemInput): PriceDisclosure {
  if (item.priceDisclosure === undefined || item.priceDisclosure === null) return item.mode === "from" ? "desde" : "exacto"
  if (!(PRICE_DISCLOSURES as readonly string[]).includes(item.priceDisclosure)) {
    throw validation("Cómo dice el precio: exacto, desde o evaluacion")
  }
  return item.priceDisclosure
}

export interface CreatePromotionInput {
  name: string
  startsAt: string
  endsAt?: string | null
  conditions?: string | null
  items: PromotionItemInput[]
}

export interface UpdatePromotionInput {
  name?: string
  startsAt?: string
  endsAt?: string | null
  conditions?: string | null
  isActive?: boolean
  items?: PromotionItemInput[]
}

export interface PromotionWithItems extends PromotionRow {
  items: Array<
    PromotionPriceRow & { serviceName: string; tariffCents: number; tariffCurrency: string }
  >
}

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

function assertName(name: string | null | undefined): string {
  const value = name?.trim() ?? ""
  if (!value || value.length > 120) throw validation("name debe tener 1–120 caracteres")
  return value
}

function assertInstant(raw: string | null | undefined, field: string): Date {
  if (!raw?.trim()) throw validation(`${field} es obligatoria (ISO)`)
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) throw validation(`${field} debe ser una fecha ISO válida`)
  return at
}

function assertConditions(conditions: string | null | undefined): string | null {
  if (conditions === undefined || conditions === null) return null
  const value = conditions.trim()
  if (!value) return null
  if (value.length > 500) throw validation("conditions debe tener hasta 500 caracteres")
  return value
}

function assertMode(mode: string | null | undefined): PromotionMode {
  if (mode !== "fixed" && mode !== "from") throw validation("mode inválido: fixed|from")
  return mode
}

function assertPriceCents(priceCents: number | null | undefined): number {
  if (!Number.isSafeInteger(priceCents) || (priceCents as number) < 0 || (priceCents as number) > 2147483647)
    throw validation("priceCents debe ser un entero >= 0")
  return priceCents as number
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
    entity: "promotion",
    entityId,
    metadata: metadata ?? null,
  })
}

/** Servicio del tarifario de la org, activo; trae tarifa y moneda de referencia. */
async function requireCatalogService(tx: Db, orgId: string, serviceId: string) {
  const [row] = await tx
    .select({
      id: serviceCatalog.id,
      name: serviceCatalog.name,
      priceCents: serviceCatalog.priceCents,
      currency: serviceCatalog.currency,
      isActive: serviceCatalog.isActive,
    })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.id, serviceId), eq(serviceCatalog.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Servicio")
  if (!row.isActive) throw conflict("SERVICE_INACTIVE", "El servicio no está activo")
  return row
}
async function withItems(
  tx: Db,
  orgId: string,
  row: PromotionRow,
): Promise<PromotionWithItems> {
  const items = await tx
    .select({
      item: promotionServicePrice,
      serviceName: serviceCatalog.name,
      tariffCents: serviceCatalog.priceCents,
      tariffCurrency: serviceCatalog.currency,
    })
    .from(promotionServicePrice)
    .innerJoin(serviceCatalog, eq(serviceCatalog.id, promotionServicePrice.serviceId))
    .where(
      and(
        eq(promotionServicePrice.organizationId, orgId),
        eq(promotionServicePrice.promotionId, row.id),
        eq(promotionServicePrice.isActive, true),
      ),
    )
    .orderBy(asc(serviceCatalog.name))
  return {
    ...row,
    items: items.map((r) => ({ ...r.item, serviceName: r.serviceName, tariffCents: r.tariffCents, tariffCurrency: r.tariffCurrency })),
  }
}

function assertItems(items: PromotionItemInput[] | undefined, required: boolean): PromotionItemInput[] {
  if (items === undefined) {
    if (required) throw validation("items debe tener entre 1 y 100 servicios")
    return []
  }
  if (!Array.isArray(items) || items.length < 1 || items.length > 100)
    throw validation("items debe tener entre 1 y 100 servicios")
  const seen = new Set<string>()
  for (const item of items) {
    if (typeof item.serviceId !== "string" || !item.serviceId.trim())
      throw validation("Cada servicio necesita serviceId")
    if (seen.has(item.serviceId)) throw validation("Cada servicio aparece una sola vez")
    seen.add(item.serviceId)
    assertMode(item.mode)
    assertPriceCents(item.priceCents)
    disclosureOf(item)
  }
  return items
}

export async function createPromotion(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreatePromotionInput,
): Promise<PromotionWithItems> {
  const name = assertName(input.name)
  const startsAt = assertInstant(input.startsAt, "startsAt")
  const endsAt = input.endsAt === undefined || input.endsAt === null ? null : assertInstant(input.endsAt, "endsAt")
  if (endsAt && endsAt < startsAt) throw validation("endsAt no puede ser anterior a startsAt")
  const conditions = assertConditions(input.conditions)
  const items = assertItems(input.items, true)
  // Lock de serie: evita duplicar nombres en altas concurrentes.
  await tx
    .select({ id: promotion.id })
    .from(promotion)
    .where(and(eq(promotion.organizationId, orgId), eq(promotion.name, name)))
    .limit(1)
  const [row] = await tx
    .insert(promotion)
    .values({ organizationId: orgId, name, startsAt, endsAt, conditions, createdBy: actorUserId })
    .returning()
  if (!row) throw new Error("No se pudo crear la promoción")
  for (const item of items) {
    const service = await requireCatalogService(tx, orgId, item.serviceId)
    await tx.insert(promotionServicePrice).values({
      organizationId: orgId,
      promotionId: row.id,
      serviceId: service.id,
      mode: item.mode,
      priceDisclosure: disclosureOf(item),
      priceCents: item.priceCents,
      currency: service.currency,
      createdBy: actorUserId,
    })
  }
  await audit(tx, orgId, actorUserId, "promotion.created", row.id, { name, itemCount: items.length })
  return withItems(tx, orgId, row)
}

export async function updatePromotion(
  tx: Db,
  orgId: string,
  actorUserId: string,
  promotionId: string,
  input: UpdatePromotionInput,
): Promise<PromotionWithItems> {
  const [current] = await tx
    .select()
    .from(promotion)
    .where(and(eq(promotion.id, promotionId), eq(promotion.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!current) throw notFound("Promoción")
  const set: Partial<typeof promotion.$inferInsert> = {}
  const fields: string[] = []
  if (input.name !== undefined) {
    set.name = assertName(input.name)
    fields.push("name")
  }
  const startsAt = input.startsAt !== undefined ? assertInstant(input.startsAt, "startsAt") : current.startsAt
  const endsAt =
    input.endsAt !== undefined
      ? input.endsAt === null
        ? null
        : assertInstant(input.endsAt, "endsAt")
      : current.endsAt
  if (input.startsAt !== undefined || input.endsAt !== undefined) {
    // Una promoción terminada no vuelve a ofrecerse: se crea otra con sus fechas.
    const ended = current.endsAt !== null && current.endsAt.getTime() <= Date.now()
    const moved =
      startsAt.getTime() !== current.startsAt.getTime() ||
      (endsAt?.getTime() ?? null) !== (current.endsAt?.getTime() ?? null)
    if (ended && moved)
      throw conflict("PROMOTION_ENDED", "La promoción ya terminó: crea una nueva con sus fechas")
    if (endsAt && endsAt < startsAt) throw validation("endsAt no puede ser anterior a startsAt")
    set.startsAt = startsAt
    set.endsAt = endsAt
    fields.push("dates")
  }
  if (input.conditions !== undefined) {
    set.conditions = assertConditions(input.conditions)
    fields.push("conditions")
  }
  if (input.isActive !== undefined) {
    set.isActive = input.isActive
    fields.push("isActive")
  }
  const items = input.items !== undefined ? assertItems(input.items, true) : null
  if (fields.length === 0 && items === null) throw validation("Sin cambios: patch vacío")
  let row = current
  if (fields.length > 0) {
    const [updated] = await tx
      .update(promotion)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(promotion.id, promotionId), eq(promotion.organizationId, orgId)))
      .returning()
    if (!updated) throw notFound("Promoción")
    row = updated
  }
  // Los cambios valen desde ahora: lo ya cotizado/cobrado conserva su snapshot
  // en la línea del presupuesto y nunca se reescribe. Nada se borra: upsert
  // por (promoción, servicio) y desactivación de los retirados.
  if (items !== null) {
    const existing = await tx
      .select({ serviceId: promotionServicePrice.serviceId })
      .from(promotionServicePrice)
      .where(
        and(
          eq(promotionServicePrice.organizationId, orgId),
          eq(promotionServicePrice.promotionId, promotionId),
        ),
      )
    const wanted = new Set(items.map((item) => item.serviceId))
    for (const item of items) {
      const service = await requireCatalogService(tx, orgId, item.serviceId)
      await tx
        .insert(promotionServicePrice)
        .values({
          organizationId: orgId,
          promotionId,
          serviceId: service.id,
          mode: item.mode,
          priceDisclosure: disclosureOf(item),
          priceCents: item.priceCents,
          currency: service.currency,
          isActive: true,
          createdBy: actorUserId,
        })
        .onConflictDoUpdate({
          target: [promotionServicePrice.promotionId, promotionServicePrice.serviceId],
          set: {
            mode: item.mode,
            priceDisclosure: disclosureOf(item),
            priceCents: item.priceCents,
            currency: service.currency,
            isActive: true,
            updatedAt: new Date(),
          },
        })
    }
    for (const row of existing) {
      if (!wanted.has(row.serviceId)) {
        await tx
          .update(promotionServicePrice)
          .set({ isActive: false, updatedAt: new Date() })
          .where(
            and(
              eq(promotionServicePrice.organizationId, orgId),
              eq(promotionServicePrice.promotionId, promotionId),
              eq(promotionServicePrice.serviceId, row.serviceId),
            ),
          )
      }
    }
    fields.push("items")
  }
  await audit(tx, orgId, actorUserId, "promotion.updated", promotionId, { fields })
  return withItems(tx, orgId, row)
}

/** Terminar hoy: adelanta el fin a ahora; lo ya usado conserva su snapshot. */
export async function endPromotion(
  tx: Db,
  orgId: string,
  actorUserId: string,
  promotionId: string,
  now = new Date(),
): Promise<PromotionRow> {
  const [current] = await tx
    .select()
    .from(promotion)
    .where(and(eq(promotion.id, promotionId), eq(promotion.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!current) throw notFound("Promoción")
  const endsAt = current.startsAt > now ? current.startsAt : now
  const [updated] = await tx
    .update(promotion)
    .set({ endsAt, updatedAt: now })
    .where(and(eq(promotion.id, promotionId), eq(promotion.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Promoción")
  await audit(tx, orgId, actorUserId, "promotion.ended", promotionId, {})
  return updated
}

export interface ListPromotionsFilter {
  vigentesOnly?: boolean
  serviceId?: string
  at?: Date
}

/** Vigente = activa y hoy dentro de [startsAt, endsAt||∞]. Vencidas nunca se ofrecen. */
export function isPromotionLive(row: PromotionRow, at: Date): boolean {
  if (!row.isActive) return false
  if (row.startsAt > at) return false
  if (row.endsAt && row.endsAt < at) return false
  return true
}

export async function listPromotions(
  tx: Db,
  orgId: string,
  filter: ListPromotionsFilter = {},
): Promise<PromotionWithItems[]> {
  const at = filter.at ?? new Date()
  const conditions = [eq(promotion.organizationId, orgId)]
  if (filter.vigentesOnly) {
    conditions.push(eq(promotion.isActive, true))
    conditions.push(lte(promotion.startsAt, at))
    conditions.push(or(isNull(promotion.endsAt), gte(promotion.endsAt, at))!)
  }
  if (filter.serviceId) {
    const priced = tx
      .select({ promotionId: promotionServicePrice.promotionId })
      .from(promotionServicePrice)
      .where(
        and(
          eq(promotionServicePrice.organizationId, orgId),
          eq(promotionServicePrice.serviceId, filter.serviceId),
          eq(promotionServicePrice.isActive, true),
        ),
      )
    conditions.push(sql`${promotion.id} IN (${priced})`)
  }
  const rows = await tx
    .select()
    .from(promotion)
    .where(and(...conditions))
    .orderBy(desc(promotion.isActive), asc(promotion.endsAt), desc(promotion.startsAt))
  const result: PromotionWithItems[] = []
  for (const row of rows) result.push(await withItems(tx, orgId, row))
  return result
}

export async function getPromotion(
  tx: Db,
  orgId: string,
  promotionId: string,
): Promise<PromotionWithItems> {
  const [row] = await tx
    .select()
    .from(promotion)
    .where(and(eq(promotion.id, promotionId), eq(promotion.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Promoción")
  return withItems(tx, orgId, row)
}

export interface PromotionPriceSnapshot {
  promotionId: string
  promotionName: string
  mode: PromotionMode
  /** Precio final por unidad (fijo, o el final exigido en modo `from`). */
  priceCents: number
  /** Mínimo anunciado en modo `from` (referencia del motivo). */
  floorCents: number | null
  /** Tarifa original del servicio al resolver. */
  tariffCents: number
  currency: string
}

/**
 * Regla única de precio promocional (contrato §6): resuelve el snapshot
 * válido para un servicio. En modo `from` exige el precio final (nunca se da
 * «desde» como final); la cobranza y el presupuesto usan esta misma regla, la
 * UI jamás calcula descuentos.
 */
export async function requirePromotionPrice(
  tx: Db,
  orgId: string,
  promotionId: string,
  serviceId: string,
  finalPriceCents?: number | null,
  at = new Date(),
): Promise<PromotionPriceSnapshot> {
  const [promo] = await tx
    .select()
    .from(promotion)
    .where(and(eq(promotion.id, promotionId), eq(promotion.organizationId, orgId)))
    .limit(1)
  if (!promo) throw notFound("Promoción")
  if (!isPromotionLive(promo, at))
    throw conflict("PROMOTION_NOT_LIVE", "La promoción no está vigente")
  const [priced] = await tx
    .select()
    .from(promotionServicePrice)
    .where(
      and(
        eq(promotionServicePrice.organizationId, orgId),
        eq(promotionServicePrice.promotionId, promotionId),
        eq(promotionServicePrice.serviceId, serviceId),
        eq(promotionServicePrice.isActive, true),
      ),
    )
    .limit(1)
  if (!priced) throw conflict("PROMOTION_NO_SERVICE", "La promoción no incluye este servicio")
  const service = await requireCatalogService(tx, orgId, serviceId)
  if (priced.mode === "fixed") {
    return {
      promotionId: promo.id,
      promotionName: promo.name,
      mode: "fixed",
      priceCents: priced.priceCents,
      floorCents: null,
      tariffCents: service.priceCents,
      currency: priced.currency,
    }
  }
  if (finalPriceCents === undefined || finalPriceCents === null)
    throw validation("El precio «desde» exige el precio final del presupuesto")
  const final = assertPriceCents(finalPriceCents)
  return {
    promotionId: promo.id,
    promotionName: promo.name,
    mode: "from",
    priceCents: final,
    floorCents: priced.priceCents,
    tariffCents: service.priceCents,
    currency: priced.currency,
  }
}

export interface PromotionMetrics {
  promotionId: string
  /**
   * Veces que se usó: tratamientos aceptados en un presupuesto con la
   * promoción, más conceptos a los que se aplicó en caja.
   */
  uses: number
  /** Lo realmente cobrado de esos conceptos, por moneda. */
  chargedByCurrency: Array<{ currency: string; cents: number }>
  /** Precio promedio acordado (útil en «desde», donde cada uso tiene el suyo). */
  averageByCurrency: Array<{ currency: string; cents: number }>
}

/**
 * Uso y cobrado por promoción. Un uso es un tratamiento aceptado en un
 * presupuesto con la promoción, o un concepto al que se aplicó al cobrar (uno
 * sin costo también cuenta, aunque no deje nada que cobrar). Un presupuesto
 * en borrador, rechazado o sustituido no es un uso, y lo anulado no cuenta.
 * «Cobrado» suma solo el dinero que ya entró. Las vencidas conservan su histórico.
 */
export async function getPromotionMetrics(
  tx: Db,
  orgId: string,
  promotionId: string,
): Promise<PromotionMetrics> {
  const [promo] = await tx
    .select({ id: promotion.id })
    .from(promotion)
    .where(and(eq(promotion.id, promotionId), eq(promotion.organizationId, orgId)))
    .limit(1)
  if (!promo) throw notFound("Promoción")
  const accepted = await tx
    .select({
      planItemId: treatmentBudgetItem.planItemId,
      priceCents: treatmentBudgetItem.priceCents,
      currency: treatmentBudgetItem.currency,
    })
    .from(treatmentBudgetItem)
    .innerJoin(treatmentBudget, eq(treatmentBudget.id, treatmentBudgetItem.budgetId))
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.promotionId, promotionId),
        eq(treatmentBudgetItem.decision, "aceptado"),
        sql`${treatmentBudget.status} IN ('aceptado','parcial')`,
      ),
    )
  const fromBudget = new Set(accepted.map((line) => line.planItemId))
  const charges = await tx
    .select()
    .from(patientCharge)
    .where(and(eq(patientCharge.organizationId, orgId), eq(patientCharge.promotionId, promotionId)))
  const live = charges.filter((charge) => !charge.voidedAt)
  // Aplicada en caja: no viene de un tratamiento ya contado por su presupuesto.
  // La promoción sin costo retira el concepto con ella como motivo: sigue siendo un uso.
  const atDesk = charges.filter(
    (charge) =>
      !(charge.planItemId && fromBudget.has(charge.planItemId)) &&
      (!charge.voidedAt || (charge.voidReason !== null && charge.voidReason === charge.editReason)),
  )
  const collected = new Map<string, number>()
  if (live.length > 0) {
    const currencyOf = new Map(live.map((charge) => [charge.id, charge.currency]))
    const applications = await tx
      .select({ chargeId: patientPaymentApplication.chargeId, amountCents: patientPaymentApplication.amountCents })
      .from(patientPaymentApplication)
      .where(
        and(
          eq(patientPaymentApplication.organizationId, orgId),
          inArray(patientPaymentApplication.chargeId, [...currencyOf.keys()]),
          isNull(patientPaymentApplication.voidedAt),
        ),
      )
    for (const app of applications) {
      const unit = currencyOf.get(app.chargeId)
      if (!unit) continue
      collected.set(unit, (collected.get(unit) ?? 0) + app.amountCents)
    }
  }
  const prices = new Map<string, { total: number; count: number }>()
  const addPrice = (unit: string, cents: number | null) => {
    if (cents == null) return
    const entry = prices.get(unit) ?? { total: 0, count: 0 }
    entry.total += cents
    entry.count += 1
    prices.set(unit, entry)
  }
  for (const line of accepted) addPrice(line.currency, line.priceCents)
  for (const charge of atDesk) addPrice(charge.currency, charge.voidedAt ? 0 : charge.amountCents)
  return {
    promotionId,
    uses: accepted.length + atDesk.length,
    chargedByCurrency: [...collected.entries()].map(([currency, cents]) => ({ currency, cents })),
    averageByCurrency: [...prices.entries()].map(([currency, entry]) => ({
      currency,
      cents: Math.round(entry.total / entry.count),
    })),
  }
}

export interface ClinicPromotionSummary {
  id: string
  name: string
  endsAt: Date | null
  conditions: string | null
  items: Array<{
    serviceId: string
    serviceName: string
    mode: PromotionMode
    priceDisclosure: PriceDisclosure
    priceCents: number
    currency: string
    tariffCents: number
  }>
}

/** Dato vigente de la clínica para caja y agente: solo vigentes, sin históricos. */
export async function listClinicPromotionSummaries(
  tx: Db,
  orgId: string,
  at = new Date(),
): Promise<ClinicPromotionSummary[]> {
  const live = await listPromotions(tx, orgId, { vigentesOnly: true, at })
  return live.map((row) => ({
    id: row.id,
    name: row.name,
    endsAt: row.endsAt,
    conditions: row.conditions,
    items: row.items.map((item) => ({
      serviceId: item.serviceId,
      serviceName: item.serviceName,
      mode: item.mode as PromotionMode,
      priceDisclosure: item.priceDisclosure as PriceDisclosure,
      priceCents: item.priceCents,
      currency: item.currency,
      tariffCents: item.tariffCents,
    })),
  }))
}
