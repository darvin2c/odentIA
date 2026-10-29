/**
 * Materiales de siempre de cada servicio (ADR 0067, issue 144) y lo que se
 * usó en cada atención.
 *
 * - La clínica dice una vez qué usa un servicio, por cada vez que se hace
 *   («Limpieza dental: 2 guantes, 1 sobre de pasta»). Tres sellantes
 *   descuentan tres veces. Solo productos que se usan en las atenciones.
 * - Al firmar la atención se descuenta solo (`discountEncounterMaterials`,
 *   desde `finalizeEncounter`) del almacén principal de la sede de la
 *   atención, del lote que vence primero; si no alcanza queda como faltante.
 *   La atención nunca se bloquea por esto. Sin sede no se descuenta nada.
 * - Lo que se dice usado a Clío («usé una mascarilla», ADR 0105) y se confirma
 *   es el total de ese producto en la atención: reemplaza lo de sus servicios,
 *   nunca se suma, y sale al firmar con lo demás.
 * - Lo usado se corrige desde la atención firmada («Fueron 4, no 2») con un
 *   movimiento enlazado a ella; lo firmado no cambia. Lo escrito es el total.
 * - El costo por vez sale de los últimos precios de compra y solo lo recibe
 *   quien ve precios (`inventory.read`).
 *
 * Todo movimiento de saldo pasa por `inventory-stock.ts`.
 */
import { quantityWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { encounter, encounterDictationSuggestion, serviceCatalog } from "@odentia/db/schema/clinical"
import { product, serviceMaterial, stockMovement } from "@odentia/db/schema/inventory"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import {
  clinicToday,
  consumeFefo,
  defaultWarehouse,
  type MovementRow,
  movementsWithPrefix,
  restoreUnits,
} from "./inventory-stock.js"
import { findOrgCurrency, findOrgLocale } from "./locale.js"
import { foldedWordsMatch } from "./search-text.js"

/** Cuántos materiales puede tener un servicio. */
export const SERVICE_MATERIALS_MAX = 50
/** Lo más que se usa de un material cada vez (y lo más que se corrige en una atención). */
export const MATERIAL_QUANTITY_MAX = 9999

type Can = (permission: string) => boolean

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

function forbidden(message: string): ServiceError {
  return new ServiceError("FORBIDDEN", 403, message)
}

/* ---------------- últimos precios de compra ---------------- */

interface UnitCost {
  /** Centavos por unidad de uso (puede tener decimales: 1250 ÷ 100 guantes). */
  perUse: number
  currency: string
}

/**
 * El último precio de compra de cada producto, por unidad de uso: el de la
 * línea de la última compra recibida ÷ el factor que copió esa línea. Una
 * línea sin precio (0) no cuenta: es una compra a la que nadie le puso precio.
 */
async function lastUnitCosts(tx: Db, orgId: string, productIds: string[]): Promise<Map<string, UnitCost>> {
  if (productIds.length === 0) return new Map()
  const ids = sql.join(
    [...new Set(productIds)].map((id) => sql`${id}::uuid`),
    sql`, `,
  )
  const rows = await tx.execute<{ productId: string; unitCostCents: number; unitFactor: number; currency: string }>(sql`
    select distinct on (m.product_id)
      m.product_id as "productId", l.unit_cost_cents as "unitCostCents", l.unit_factor as "unitFactor", o.currency
    from stock_movement m
    join purchase_order_line l
      on l.organization_id = m.organization_id and l.order_id = m.purchase_order_id and l.product_id = m.product_id
    join purchase_order o on o.organization_id = m.organization_id and o.id = m.purchase_order_id
    where m.organization_id = ${orgId}
      and m.kind = 'ingreso'
      and m.purchase_order_id is not null
      and m.product_id in (${ids})
    order by m.product_id, m.created_at desc, m.id desc`)
  const out = new Map<string, UnitCost>()
  for (const row of rows) {
    const cents = Number(row.unitCostCents)
    const factor = Math.max(1, Number(row.unitFactor))
    if (cents > 0) out.set(row.productId, { perUse: cents / factor, currency: row.currency })
  }
  return out
}

/* ---------------- materiales de un servicio ---------------- */

export interface ServiceMaterialInput {
  productId: string
  /** En la unidad de uso del producto, por cada vez que se hace el servicio. */
  quantity: number
}

export interface ServiceMaterialLine {
  productId: string
  name: string
  /** Unidad de uso, en singular («guante»). */
  unit: string
  quantity: number
  /** «2 guantes». */
  quantityText: string
  /**
   * Se descuenta al cerrar la atención. Falso si el producto se desactivó o
   * ya no se usa en las atenciones: queda en la lista, pero no se descuenta.
   */
  discounted: boolean
  /** Solo para quien ve precios: lo que cuesta este material cada vez; null si nunca se compró con precio. */
  costCents: number | null
}

export interface ServiceMaterialsCost {
  /** Lo que cuestan los materiales cada vez, con los últimos precios de compra (centavos enteros). */
  cents: number
  currency: string
  /** Materiales sin una compra con precio: no entran en la suma. */
  unpriced: number
  /** Qué parte del precio del servicio son (0.018 = 1,8 %); null sin precio del servicio o con otra moneda. */
  shareOfPrice: number | null
}

export interface ServiceMaterials {
  serviceId: string
  serviceName: string
  items: ServiceMaterialLine[]
  /** Solo para quien ve precios; null sin precios o si ningún material tiene compra con precio. */
  cost: ServiceMaterialsCost | null
}

async function requireServiceRow(tx: Db, orgId: string, serviceId: string) {
  const [row] = await tx
    .select({
      id: serviceCatalog.id,
      name: serviceCatalog.name,
      priceCents: serviceCatalog.priceCents,
      currency: serviceCatalog.currency,
    })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.id, serviceId)))
    .limit(1)
  if (!row) throw notFound("Servicio")
  return row
}

/** Los materiales de un servicio, con su costo por vez si quien pide ve precios. */
export async function listServiceMaterials(
  tx: Db,
  orgId: string,
  serviceId: string,
  options: { prices: boolean },
): Promise<ServiceMaterials> {
  const service = await requireServiceRow(tx, orgId, serviceId)
  const rows = await tx
    .select({
      productId: serviceMaterial.productId,
      quantity: serviceMaterial.quantity,
      name: product.name,
      unit: product.unit,
      isActive: product.isActive,
      usedInCare: product.usedInCare,
    })
    .from(serviceMaterial)
    .innerJoin(product, and(eq(product.organizationId, serviceMaterial.organizationId), eq(product.id, serviceMaterial.productId)))
    .where(and(eq(serviceMaterial.organizationId, orgId), eq(serviceMaterial.serviceId, serviceId)))
    .orderBy(asc(product.name), asc(product.id))
  const { locale } = await findOrgLocale(tx, orgId)
  const costs = options.prices ? await lastUnitCosts(tx, orgId, rows.map((row) => row.productId)) : new Map<string, UnitCost>()
  const currency = options.prices ? await findOrgCurrency(tx, orgId) : null
  let total = 0
  let priced = 0
  const items: ServiceMaterialLine[] = rows.map((row) => {
    const cost = costs.get(row.productId)
    const own = cost && currency && cost.currency === currency ? cost.perUse * row.quantity : null
    if (own !== null) {
      total += own
      priced += 1
    }
    return {
      productId: row.productId,
      name: row.name,
      unit: row.unit,
      quantity: row.quantity,
      quantityText: quantityWords(row.quantity, row.unit, locale),
      discounted: row.isActive && row.usedInCare,
      costCents: options.prices && own !== null ? Math.round(own) : null,
    }
  })
  let cost: ServiceMaterialsCost | null = null
  if (options.prices && currency && priced > 0) {
    const cents = Math.round(total)
    cost = {
      cents,
      currency,
      unpriced: rows.length - priced,
      shareOfPrice: service.priceCents > 0 && service.currency === currency ? cents / service.priceCents : null,
    }
  }
  return { serviceId: service.id, serviceName: service.name, items, cost }
}

/**
 * Reemplaza los materiales de un servicio («Guardar» de la lista entera;
 * «Copiar de otro servicio» es leer la lista de otro y guardarla). Un producto
 * va una sola vez. Lo que se agrega tiene que estar activo y usarse en las
 * atenciones; uno que ya estaba y después se desactivó puede quedarse (no se
 * descuenta) para no obligar a quitarlo al cambiar otro. Cambiarlos no toca
 * las atenciones ya cerradas.
 */
export async function setServiceMaterials(
  tx: Db,
  orgId: string,
  actorUserId: string,
  serviceId: string,
  items: ServiceMaterialInput[],
  options: { prices: boolean },
): Promise<ServiceMaterials> {
  const service = await requireServiceRow(tx, orgId, serviceId)
  if (!Array.isArray(items)) throw validation("Indica los materiales del servicio")
  if (items.length > SERVICE_MATERIALS_MAX)
    throw validation(`Un servicio admite hasta ${SERVICE_MATERIALS_MAX} materiales`)
  const seen = new Set<string>()
  for (const item of items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > MATERIAL_QUANTITY_MAX)
      throw validation(`La cantidad de cada material va de 1 a ${MATERIAL_QUANTITY_MAX}`)
    if (seen.has(item.productId)) throw validation("Un producto va una sola vez en los materiales: suma las cantidades")
    seen.add(item.productId)
  }
  // Serializa dos guardados del mismo servicio.
  await tx
    .select({ id: serviceCatalog.id })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.id, serviceId)))
    .for("update")
  const current = await tx
    .select({ productId: serviceMaterial.productId, quantity: serviceMaterial.quantity })
    .from(serviceMaterial)
    .where(and(eq(serviceMaterial.organizationId, orgId), eq(serviceMaterial.serviceId, serviceId)))
  const before = new Map(current.map((row) => [row.productId, row.quantity]))
  const ids = items.map((item) => item.productId)
  const products = ids.length
    ? await tx
        .select({ id: product.id, name: product.name, isActive: product.isActive, usedInCare: product.usedInCare })
        .from(product)
        .where(and(eq(product.organizationId, orgId), inArray(product.id, ids)))
    : []
  const byId = new Map(products.map((row) => [row.id, row]))
  for (const item of items) {
    const found = byId.get(item.productId)
    if (!found) throw notFound("Producto")
    if (before.has(item.productId)) continue
    if (!found.isActive)
      throw conflict("PRODUCT_INACTIVE", `«${found.name}» está desactivado: actívalo en Inventario para usarlo en un servicio`)
    if (!found.usedInCare)
      throw conflict(
        "PRODUCT_NOT_FOR_CARE",
        `«${found.name}» no se usa en las atenciones: márcalo así en Inventario para agregarlo a un servicio`,
      )
  }
  const gone = current.filter((row) => !seen.has(row.productId)).map((row) => row.productId)
  if (gone.length)
    await tx
      .delete(serviceMaterial)
      .where(
        and(
          eq(serviceMaterial.organizationId, orgId),
          eq(serviceMaterial.serviceId, serviceId),
          inArray(serviceMaterial.productId, gone),
        ),
      )
  for (const item of items) {
    if (before.get(item.productId) === item.quantity) continue
    await tx
      .insert(serviceMaterial)
      .values({ organizationId: orgId, serviceId, productId: item.productId, quantity: item.quantity })
      .onConflictDoUpdate({
        target: [serviceMaterial.organizationId, serviceMaterial.serviceId, serviceMaterial.productId],
        set: { quantity: item.quantity, updatedAt: new Date() },
      })
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "stock.service_materials_set",
    entity: "service_catalog",
    entityId: service.id,
    metadata: { materials: items.length, removed: gone.length },
  })
  return listServiceMaterials(tx, orgId, serviceId, options)
}

export interface ServiceMaterialSummary {
  /** Cuántos materiales tiene. */
  count: number
  /** Solo para quien ve precios: lo que cuestan cada vez (null sin precios o sin compras con precio). */
  cost: { cents: number; currency: string; unpriced: number } | null
}

/**
 * Para la lista de servicios: cuántos materiales tiene cada uno y, para quien
 * ve precios, lo que cuestan cada vez. Un servicio sin materiales no viene.
 */
export async function serviceMaterialSummaries(
  tx: Db,
  orgId: string,
  serviceIds: string[],
  options: { prices: boolean },
): Promise<Map<string, ServiceMaterialSummary>> {
  if (serviceIds.length === 0) return new Map()
  const rows = await tx
    .select({ serviceId: serviceMaterial.serviceId, productId: serviceMaterial.productId, quantity: serviceMaterial.quantity })
    .from(serviceMaterial)
    .where(and(eq(serviceMaterial.organizationId, orgId), inArray(serviceMaterial.serviceId, [...new Set(serviceIds)])))
  const costs = options.prices ? await lastUnitCosts(tx, orgId, rows.map((row) => row.productId)) : new Map<string, UnitCost>()
  const currency = options.prices && rows.length ? await findOrgCurrency(tx, orgId) : null
  const acc = new Map<string, { count: number; total: number; priced: number }>()
  for (const row of rows) {
    const entry = acc.get(row.serviceId) ?? { count: 0, total: 0, priced: 0 }
    entry.count += 1
    const cost = costs.get(row.productId)
    if (cost && currency && cost.currency === currency) {
      entry.total += cost.perUse * row.quantity
      entry.priced += 1
    }
    acc.set(row.serviceId, entry)
  }
  const out = new Map<string, ServiceMaterialSummary>()
  for (const [serviceId, entry] of acc) {
    out.set(serviceId, {
      count: entry.count,
      cost:
        options.prices && currency && entry.priced > 0
          ? { cents: Math.round(entry.total), currency, unpriced: entry.count - entry.priced }
          : null,
    })
  }
  return out
}

export interface MaterialProductOption {
  productId: string
  name: string
  /** Unidad de uso, en singular: la cantidad se escribe en ella. */
  unit: string
}

/** Para «+ Agregar material»: productos activos que se usan en las atenciones, por nombre o código. */
export async function listMaterialProducts(
  tx: Db,
  orgId: string,
  input: { q?: string; limit?: number } = {},
): Promise<MaterialProductOption[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50)
  const conditions = [eq(product.organizationId, orgId), eq(product.isActive, true), eq(product.usedInCare, true)]
  const q = input.q?.trim()
  if (q) conditions.push(foldedWordsMatch([product.name, product.sku], q))
  const rows = await tx
    .select({ productId: product.id, name: product.name, unit: product.unit })
    .from(product)
    .where(and(...conditions))
    .orderBy(asc(product.name), asc(product.id))
    .limit(limit)
  return rows
}

export interface ServicesWithoutMaterials {
  days: number
  /** Los servicios más hechos sin materiales, con cuántas veces (suma de las cantidades de cada acto). */
  services: Array<{ serviceId: string; name: string; times: number }>
  /** Atenciones firmadas en esos días. */
  totalEncounters: number
  /** Cuántas de ellas tienen alguno de esos servicios. */
  coveredEncounters: number
  /** coveredEncounters ÷ totalEncounters (0.72 = «Son el 72 % de tus atenciones»); null sin atenciones. */
  share: number | null
}

/**
 * «Empieza por estos 5»: los servicios activos más hechos en los últimos
 * días (procedimientos no anulados de atenciones firmadas) que todavía no
 * tienen materiales, y qué parte de las atenciones de esos días cubren.
 */
export async function topServicesWithoutMaterials(
  tx: Db,
  orgId: string,
  input: { days?: number; limit?: number } = {},
): Promise<ServicesWithoutMaterials> {
  const days = Math.min(Math.max(Math.trunc(input.days ?? 30), 1), 365)
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 5), 1), 20)
  const top = await tx.execute<{ serviceId: string; name: string; times: number }>(sql`
    select s.id as "serviceId", s.name, sum(ep.quantity)::int as times
    from encounter_procedure ep
    join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id
    join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
    where ep.organization_id = ${orgId}
      and ep.voided_at is null
      and e.status = 'finalizada'
      and e.finalized_at >= now() - make_interval(days => ${days})
      and s.is_active
      and not exists (
        select 1 from service_material sm where sm.organization_id = ${orgId} and sm.service_id = s.id
      )
    group by s.id, s.name
    order by times desc, s.name asc
    limit ${limit}`)
  const services = top.map((row) => ({ serviceId: row.serviceId, name: row.name, times: Number(row.times) }))
  const [totals] = await tx.execute<{ total: number }>(sql`
    select count(*)::int as total from encounter e
    where e.organization_id = ${orgId} and e.status = 'finalizada'
      and e.finalized_at >= now() - make_interval(days => ${days})`)
  const totalEncounters = Number(totals?.total ?? 0)
  let coveredEncounters = 0
  if (services.length) {
    const ids = sql.join(services.map((row) => sql`${row.serviceId}::uuid`), sql`, `)
    const [covered] = await tx.execute<{ covered: number }>(sql`
      select count(distinct e.id)::int as covered
      from encounter e
      join encounter_procedure ep on ep.organization_id = e.organization_id and ep.encounter_id = e.id
      where e.organization_id = ${orgId} and e.status = 'finalizada'
        and e.finalized_at >= now() - make_interval(days => ${days})
        and ep.voided_at is null and ep.service_id in (${ids})`)
    coveredEncounters = Number(covered?.covered ?? 0)
  }
  return {
    days,
    services,
    totalEncounters,
    coveredEncounters,
    share: totalEncounters > 0 ? coveredEncounters / totalEncounters : null,
  }
}

/* ---------------- materiales de una atención ---------------- */

interface MaterialPlanLine {
  productId: string
  name: string
  unit: string
  quantity: number
  /** Los servicios de la atención que lo usan, para el motivo del movimiento. */
  services: string[]
}

/** Lo que dice el dictado de los materiales de la atención: el último total confirmado de cada producto. */
async function dictatedMaterials(tx: Db, orgId: string, encounterId: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({ payload: encounterDictationSuggestion.payload })
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.encounterId, encounterId),
        eq(encounterDictationSuggestion.kind, "material"),
        eq(encounterDictationSuggestion.status, "confirmada"),
      ),
    )
    .orderBy(asc(encounterDictationSuggestion.decidedAt), asc(encounterDictationSuggestion.createdAt))
  const out = new Map<string, number>()
  for (const { payload } of rows) {
    const quantity = Number(payload["quantity"])
    if (typeof payload["productId"] === "string" && Number.isSafeInteger(quantity) && quantity > 0) out.set(payload["productId"], quantity)
  }
  return out
}

/** Lo dicho reemplaza lo que traían sus servicios: así lo dice el motivo del movimiento. */
const DICTATED = "lo que se dictó"

/**
 * Lo que descuenta una atención: sus procedimientos no anulados con servicio
 * × su cantidad × los materiales de ese servicio, por producto. Un material
 * dicho y confirmado (ADR 0105) es el total de ese producto: reemplaza lo de
 * sus servicios, nunca se suma. Un producto desactivado o que ya no se usa en
 * las atenciones no se descuenta.
 */
async function encounterMaterialPlan(tx: Db, orgId: string, encounterId: string): Promise<MaterialPlanLine[]> {
  const fromServices = await serviceMaterialPlan(tx, orgId, encounterId)
  const dictated = await dictatedMaterials(tx, orgId, encounterId)
  if (dictated.size === 0) return fromServices
  const lines = new Map(fromServices.map((line) => [line.productId, line]))
  const missing = [...dictated.keys()].filter((id) => !lines.has(id))
  const extra = missing.length
    ? await tx
        .select({ productId: product.id, name: product.name, unit: product.unit })
        .from(product)
        .where(and(eq(product.organizationId, orgId), inArray(product.id, missing), eq(product.isActive, true), eq(product.usedInCare, true)))
    : []
  for (const row of extra) lines.set(row.productId, { ...row, quantity: 0, services: [] })
  for (const [productId, quantity] of dictated) {
    const line = lines.get(productId)
    if (line) lines.set(productId, { ...line, quantity, services: [...line.services, DICTATED] })
  }
  return [...lines.values()].sort((a, b) => a.name.localeCompare(b.name) || a.productId.localeCompare(b.productId))
}

/**
 * Cuánto de cada producto traen los servicios de la atención, y cuáles: con
 * esto Clío dice que un material dicho ya venía y no se suma.
 */
export async function materialsFromServices(tx: Db, orgId: string, encounterId: string): Promise<Map<string, { quantity: number; services: string[] }>> {
  const plan = await serviceMaterialPlan(tx, orgId, encounterId)
  return new Map(plan.map((line) => [line.productId, { quantity: line.quantity, services: line.services }]))
}

async function serviceMaterialPlan(tx: Db, orgId: string, encounterId: string): Promise<MaterialPlanLine[]> {
  const rows = await tx.execute<{ productId: string; name: string; unit: string; quantity: number; services: string[] }>(sql`
    select sm.product_id as "productId", p.name, p.unit,
      sum(ep.quantity * sm.quantity)::int as quantity,
      array_agg(distinct s.name) as services
    from encounter_procedure ep
    join service_material sm on sm.organization_id = ep.organization_id and sm.service_id = ep.service_id
    join product p on p.organization_id = sm.organization_id and p.id = sm.product_id
    join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
    where ep.organization_id = ${orgId}
      and ep.encounter_id = ${encounterId}
      and ep.voided_at is null
      and ep.service_id is not null
      and p.is_active and p.used_in_care
    group by sm.product_id, p.name, p.unit
    order by p.name, sm.product_id`)
  return rows.map((row) => ({
    productId: row.productId,
    name: row.name,
    unit: row.unit,
    quantity: Number(row.quantity),
    services: Array.isArray(row.services) ? row.services : [],
  }))
}

async function branchOf(tx: Db, orgId: string, branchId: string) {
  const [row] = await tx
    .select({ id: branch.id, name: branch.name, timezone: branch.timezone })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.id, branchId)))
    .limit(1)
  return row ?? null
}

export interface MaterialQuantity {
  productId: string
  name: string
  /** Unidad de uso, en singular. */
  unit: string
  quantity: number
  /** «2 guantes». */
  quantityText: string
}

/** Lo que el cierre anuncia que se descontará (`ClosingCheck.materials`). */
export interface ClosingMaterials {
  /** La sede de la atención: de su almacén principal sale todo. */
  branch: { id: string; name: string }
  items: MaterialQuantity[]
}

/**
 * Lo que se descontará al cerrar, con la sede. Null si la atención no tiene
 * sede (no se descuenta nada y el cierre no lo anuncia) o si no hay nada que
 * descontar.
 */
export async function closingMaterialsOf(
  tx: Db,
  orgId: string,
  row: Pick<typeof encounter.$inferSelect, "id" | "branchId">,
): Promise<ClosingMaterials | null> {
  if (!row.branchId) return null
  const plan = await encounterMaterialPlan(tx, orgId, row.id)
  if (plan.length === 0) return null
  const site = await branchOf(tx, orgId, row.branchId)
  if (!site) return null
  const { locale } = await findOrgLocale(tx, orgId)
  return {
    branch: { id: site.id, name: site.name },
    items: plan.map((line) => ({
      productId: line.productId,
      name: line.name,
      unit: line.unit,
      quantity: line.quantity,
      quantityText: quantityWords(line.quantity, line.unit, locale),
    })),
  }
}

/** Lo que descontó el cierre, con lo que quedó como faltante. */
export interface DiscountedMaterials {
  branch: { id: string; name: string }
  items: Array<MaterialQuantity & { /** Lo que no había: quedó como faltante. */ shortage: number }>
  /**
   * No se pudo descontar (un error inesperado): la atención se firmó igual y
   * lo usado se registra con «Corregir» desde la atención.
   */
  failed: boolean
}

/** «19 oct» en la zona de la sede (o de la clínica). */
function visitDay(date: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone }).format(date).replace(".", "")
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`
}

/**
 * Descuenta los materiales de una atención recién firmada. Lo llama
 * `finalizeEncounter` dentro de su transacción, en un punto de guardado:
 * lo que no alcanza queda como faltante y un error inesperado no deshace el
 * cierre (se dice con `failed`). Cada producto lleva su clave por atención,
 * así un reintento no descuenta dos veces.
 */
export async function discountEncounterMaterials(
  tx: Db,
  orgId: string,
  actorUserId: string,
  row: Pick<typeof encounter.$inferSelect, "id" | "patientId" | "branchId" | "startedAt">,
): Promise<DiscountedMaterials | null> {
  if (!row.branchId) return null
  const plan = await encounterMaterialPlan(tx, orgId, row.id)
  if (plan.length === 0) return null
  const site = await branchOf(tx, orgId, row.branchId)
  if (!site) return null
  const zone = await findOrgLocale(tx, orgId)
  const items = plan.map((line) => ({
    productId: line.productId,
    name: line.name,
    unit: line.unit,
    quantity: line.quantity,
    quantityText: quantityWords(line.quantity, line.unit, zone.locale),
    shortage: 0,
  }))
  try {
    // Punto de guardado (transacción anidada de postgres.js): si algo falla,
    // se deshace solo el descuento y el cierre sigue.
    await tx.transaction(async (savepoint) => {
      const sp = savepoint as Db
      const store = await defaultWarehouse(sp, orgId, site.id)
      // Lo vencido no se usa en una atención: sale de los lotes vigentes y, si no alcanzan, queda faltante.
      const usableOn = await clinicToday(sp, orgId)
      const day = visitDay(row.startedAt, zone.locale, site.timezone || zone.timezone)
      for (const [index, line] of plan.entries()) {
        const result = await consumeFefo(sp, orgId, {
          productId: line.productId,
          warehouseId: store.id,
          quantity: line.quantity,
          allowShortage: true,
          usableOn,
          base: {
            kind: "consumo",
            reason: `Atención del ${day} · ${listWords(line.services)}`,
            actorUserId,
            keyPrefix: `atencion:${row.id}:${line.productId}`,
            patientId: row.patientId,
            encounterId: row.id,
          },
        })
        items[index].shortage = result.shortage
      }
    })
  } catch (error) {
    // La atención nunca se bloquea por sus materiales: el cierre sigue y la
    // pantalla dice que hay que registrarlos con «Corregir».
    console.warn(
      `[materiales] no se pudieron descontar los de la atención ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { branch: { id: site.id, name: site.name }, items: items.map((item) => ({ ...item, shortage: 0 })), failed: true }
  }
  return { branch: { id: site.id, name: site.name }, items, failed: false }
}

export interface EncounterMaterials {
  /** La sede de la atención (de su almacén salen los materiales); null sin sede. */
  branch: { id: string; name: string } | null
  /** Lo usado, neto de lo devuelto, por producto. */
  items: MaterialQuantity[]
  /** Quien atendió, o quien lleva el inventario, con la atención firmada y con sede. */
  canCorrect: boolean
  /**
   * Puede corregir y la clínica tiene algún producto activo que se usa en las
   * atenciones: «Agregar otro producto» (la mascarilla que no estaba). Sin
   * productos así no hay nada que agregar y la pantalla no lo ofrece.
   */
  canAddProducts: boolean
}

async function encounterRowOf(tx: Db, orgId: string, patientId: string, encounterId: string, lock = false) {
  const query = tx
    .select({
      id: encounter.id,
      patientId: encounter.patientId,
      branchId: encounter.branchId,
      professionalUserId: encounter.professionalUserId,
      status: encounter.status,
      startedAt: encounter.startedAt,
    })
    .from(encounter)
    .where(and(eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId), eq(encounter.id, encounterId)))
    .limit(1)
  const [row] = lock ? await query.for("update") : await query
  if (!row) throw notFound("Atención")
  return row
}

/** Lo usado por producto en una atención: lo que salió menos lo que volvió. */
async function usedByProduct(tx: Db, orgId: string, encounterId: string) {
  const rows = await tx
    .select({
      productId: stockMovement.productId,
      name: product.name,
      unit: product.unit,
      used: sql<number>`(-sum(${stockMovement.quantityDelta}))::int`,
    })
    .from(stockMovement)
    .innerJoin(product, and(eq(product.organizationId, stockMovement.organizationId), eq(product.id, stockMovement.productId)))
    .where(and(eq(stockMovement.organizationId, orgId), eq(stockMovement.encounterId, encounterId)))
    .groupBy(stockMovement.productId, product.name, product.unit)
    .orderBy(asc(product.name), asc(stockMovement.productId))
  return rows.map((row) => ({ ...row, used: Number(row.used) }))
}

function mayCorrect(
  row: { status: string; branchId: string | null; professionalUserId: string },
  actorUserId: string,
  can: Can,
): boolean {
  return row.status === "finalizada" && row.branchId !== null && (row.professionalUserId === actorUserId || can("inventory.write"))
}

/** ¿La clínica tiene algún producto activo que se usa en las atenciones? */
async function hasCareProducts(tx: Db, orgId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: product.id })
    .from(product)
    .where(and(eq(product.organizationId, orgId), eq(product.isActive, true), eq(product.usedInCare, true)))
    .limit(1)
  return row !== undefined
}

/** «Materiales usados» de una atención (quien lee la atención). */
export async function getEncounterMaterials(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  can: Can,
): Promise<EncounterMaterials> {
  const row = await encounterRowOf(tx, orgId, patientId, encounterId)
  const site = row.branchId ? await branchOf(tx, orgId, row.branchId) : null
  const { locale } = await findOrgLocale(tx, orgId)
  const used = await usedByProduct(tx, orgId, encounterId)
  const canCorrect = mayCorrect(row, actorUserId, can)
  return {
    branch: site ? { id: site.id, name: site.name } : null,
    items: used
      .filter((line) => line.used > 0)
      .map((line) => ({
        productId: line.productId,
        name: line.name,
        unit: line.unit,
        quantity: line.used,
        quantityText: quantityWords(line.used, line.unit, locale),
      })),
    canCorrect,
    canAddProducts: canCorrect && (await hasCareProducts(tx, orgId)),
  }
}

export interface CorrectEncounterMaterialInput {
  productId: string
  /** Lo que de verdad se usó, en la unidad de uso («Fueron 4, no 2»). 0 = no se usó. */
  quantity: number
  /** La clave del formulario: el reintento devuelve lo hecho. */
  idempotencyKey: string
}

/**
 * «Fueron 4, no 2»: deja lo usado de un producto en una atención firmada en la
 * cantidad real. Si se usó más, descuenta del lote que vence primero (con
 * faltante si no alcanza); si se usó menos, devuelve al almacén de donde
 * salió (primero baja su faltante). Siempre enlazado a la atención; lo
 * firmado no cambia. Lo hace quien atendió o quien tiene `inventory.write`.
 */
export async function correctEncounterMaterial(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: CorrectEncounterMaterialInput,
  can: Can,
): Promise<EncounterMaterials & { changed: number; replayed: boolean }> {
  const quantity = input.quantity
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > MATERIAL_QUANTITY_MAX)
    throw validation(`Lo usado va de 0 a ${MATERIAL_QUANTITY_MAX}`)
  const key = input.idempotencyKey?.trim()
  if (!key || key.length > 120) throw validation("Falta la clave del formulario: vuelve a abrirlo")
  const row = await encounterRowOf(tx, orgId, patientId, encounterId, true)
  if (row.status !== "finalizada")
    throw conflict("ENCOUNTER_NOT_FINALIZED", "Los materiales se corrigen cuando la atención ya está firmada")
  if (row.professionalUserId !== actorUserId && !can("inventory.write"))
    throw forbidden("Corrigen los materiales quien atendió, el dueño y la administración")
  if (!row.branchId)
    throw conflict("ENCOUNTER_WITHOUT_BRANCH", "Esta atención no tiene sede: sus materiales no salieron de ningún almacén")
  const prefix = `atencion-correccion:${encounterId}:${input.productId}:${key}`
  const done = async (changed: number, replayed: boolean) => ({
    ...(await getEncounterMaterials(tx, orgId, actorUserId, patientId, encounterId, can)),
    changed,
    replayed,
  })
  const prior = await movementsWithPrefix(tx, orgId, prefix)
  const used = (await usedByProduct(tx, orgId, encounterId)).find((line) => line.productId === input.productId)?.used ?? 0
  if (prior.length > 0) {
    // El mismo formulario otra vez: si ya quedó en lo pedido, es el reintento.
    if (used !== quantity)
      throw conflict("CONFLICT", "Esto ya se registró con otros datos. Cierra y vuelve a abrir para registrarlo de nuevo.")
    return done(-prior.reduce((sum, movement) => sum + movement.quantityDelta, 0), true)
  }
  const [item] = await tx
    .select({ id: product.id, name: product.name, unit: product.unit, isActive: product.isActive, usedInCare: product.usedInCare })
    .from(product)
    .where(and(eq(product.organizationId, orgId), eq(product.id, input.productId)))
    .limit(1)
  if (!item) throw notFound("Producto")
  const delta = quantity - used
  if (delta === 0) return done(0, false)
  const zone = await findOrgLocale(tx, orgId)
  const site = await branchOf(tx, orgId, row.branchId)
  const day = visitDay(row.startedAt, zone.locale, site?.timezone || zone.timezone)
  const reason = `Corrección de la atención del ${day}: fueron ${quantityWords(quantity, item.unit, zone.locale)}, no ${quantityWords(used, item.unit, zone.locale)}`
  const base = {
    actorUserId,
    patientId: row.patientId,
    encounterId,
    reason,
  }
  if (delta > 0) {
    if (!item.isActive)
      throw conflict("PRODUCT_INACTIVE", `«${item.name}» está desactivado: actívalo en Inventario para registrar más`)
    if (!item.usedInCare)
      throw conflict("PRODUCT_NOT_FOR_CARE", `«${item.name}» no se usa en las atenciones: márcalo así en Inventario para registrarlo`)
    const store = await defaultWarehouse(tx, orgId, row.branchId)
    await consumeFefo(tx, orgId, {
      productId: item.id,
      warehouseId: store.id,
      quantity: delta,
      allowShortage: true,
      usableOn: await clinicToday(tx, orgId),
      base: { ...base, kind: "consumo", keyPrefix: `${prefix}:mas` },
    })
  } else {
    // Vuelve a cada almacén lo que salió de él, empezando por el principal de
    // la sede; dentro del almacén, al último lote del que salió.
    const movements = await tx
      .select()
      .from(stockMovement)
      .where(
        and(
          eq(stockMovement.organizationId, orgId),
          eq(stockMovement.encounterId, encounterId),
          eq(stockMovement.productId, item.id),
        ),
      )
      .orderBy(asc(stockMovement.createdAt), asc(stockMovement.idempotencyKey))
    const out = new Map<string, { net: number; lastLot: string | null }>()
    for (const movement of movements as MovementRow[]) {
      const entry = out.get(movement.warehouseId) ?? { net: 0, lastLot: null }
      entry.net -= movement.quantityDelta
      if (movement.quantityDelta < 0 && movement.lotId) entry.lastLot = movement.lotId
      out.set(movement.warehouseId, entry)
    }
    const store = await defaultWarehouse(tx, orgId, row.branchId)
    const order = [...out.keys()].sort((a, b) => (a === store.id ? -1 : b === store.id ? 1 : 0))
    let left = -delta
    let step = 0
    for (const warehouseId of order) {
      if (left === 0) break
      const entry = out.get(warehouseId)
      if (!entry || entry.net <= 0) continue
      const back = Math.min(entry.net, left)
      await restoreUnits(tx, orgId, {
        productId: item.id,
        warehouseId,
        quantity: back,
        preferLotId: entry.lastLot,
        base: { ...base, kind: "devolucion", keyPrefix: `${prefix}:menos:${step++}` },
      })
      left -= back
    }
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "stock.encounter_materials_corrected",
    entity: "encounter",
    entityId: encounterId,
    metadata: { patientId, productId: item.id, from: used, to: quantity },
  })
  return done(delta, false)
}
