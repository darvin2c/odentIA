/**
 * Inventario por sede (ADR 0067): las formas que entrega `/api/inventory/*`,
 * sus llamadas y cómo se dice cada cosa en pantalla. La API es la fuente de
 * verdad: sin `inventory.read` no viajan precios, y lo que no viaja no se
 * supone (los campos de precio son opcionales).
 */
import { formatMoney, quantityWords } from "@odentia/clinical"
import { ApiError, apiFetch } from "./api"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"
import { isAmbiguousMutationError } from "./query-error"
import type { PurchaseBalance } from "./reports"

/* ---------------- formas de la API ---------------- */

export type ProductState = "faltante" | "vencido" | "hace_falta" | "no_hay" | "por_vencer" | "ok"
export type ProductNeed = "hacen_falta" | "por_vencer"

/** La unidad de uso y la de compra de un producto. */
export interface ProductUnits {
  unit: string
  purchaseUnit: string | null
  purchaseFactor: number
}

/** Cómo está un producto en una sede (lo calcula el servidor). */
export interface SedeStatus {
  /** Lotes − faltante, en la unidad de uso (negativo si se usó sin haber). */
  onHand: number
  shortage: number
  minQuantity: number
  /** Para llegar al mínimo, en la unidad de uso. */
  missing: number
  expired: { quantity: number; firstDate: string } | null
  expiring: { quantity: number; date: string; firstQuantity: number } | null
  state: ProductState
  needs: boolean
  expires: boolean
}

export interface ProductListItem extends ProductUnits, SedeStatus {
  id: string
  sku: string
  name: string
  usedInCare: boolean
  forSale: boolean
  unitCode: string | null
  purchaseUnitCode: string | null
  /** La unidad de antes no se entendió: queda «Por revisar». */
  unitReview: boolean
  isActive: boolean
  /** Solo con precios. */
  salePriceCents?: number | null
  saleCurrency?: string | null
}

export interface ProductList {
  branch: { id: string; name: string }
  today: string
  items: ProductListItem[]
  counts: { todos: number; hacen_falta: number; por_vencer: number }
}

export interface ProductLot {
  id: string
  /** Vacío = «Sin código». */
  code: string
  warehouseId: string
  warehouseName: string
  warehouseIsDefault: boolean
  expiresAt: string | null
  quantityOnHand: number
  purchaseOrderId: string | null
  purchaseOrderNumber: number | null
  purchaseOrderLabel: string | null
  supplierName: string | null
  createdAt: string
  expired: boolean
  expiring: boolean
}

export interface LastPurchase {
  orderId: string
  orderNumber: number
  label: string
  supplierId: string
  supplierName: string
  supplierActive: boolean
  at: string
  /** En unidades de compra de esa línea. */
  quantity: number
  purchaseUnit: string | null
  unitFactor: number
  /** Solo con precios: por unidad de compra de esa línea. */
  unitCostCents?: number
  currency?: string
}

export interface ProductDetail extends ProductListItem {
  createdAt: string
  updatedAt: string
  hasHistory: boolean
  minimums: Array<{ branchId: string; minQuantity: number }>
  branch: { id: string; name: string }
  today: string
  branches: Array<SedeStatus & { branchId: string; branchName: string; branchActive: boolean }>
  lots: ProductLot[]
  movements: MovementItem[]
  movementsTotal: number
  lastPurchase: LastPurchase | null
  usedLast30Days: number
  services: Array<{ serviceId: string; serviceName: string; quantity: number }>
}

export interface MovementItem {
  id: string
  createdAt: string
  kind: string
  quantityDelta: number
  quantity: number
  affectsStock: boolean
  reason: string
  productId: string
  productName: string
  productSku: string
  unit: string
  purchaseUnit: string | null
  purchaseFactor: number
  lotId: string | null
  lotCode: string | null
  lotExpiresAt: string | null
  branchId: string
  branchName: string
  warehouseId: string
  warehouseName: string
  fromBranchId: string | null
  fromBranchName: string | null
  toBranchId: string | null
  toBranchName: string | null
  destWarehouseId: string | null
  destWarehouseName: string | null
  actorUserId: string | null
  actorName: string | null
  patientId: string | null
  patientName: string | null
  personId: string | null
  encounterId: string | null
  purchaseOrderId: string | null
  purchaseOrderNumber: number | null
  purchaseOrderLabel: string | null
  chargeId: string | null
  chargeDescription: string | null
}

export interface SupplierItem {
  id: string
  name: string
  docType: string | null
  docNumber: string | null
  email: string | null
  phone: string | null
  address: string | null
  isActive: boolean
  /** Compras pedidas o recibidas. */
  orders: number
  /** Solo con precios. */
  currency?: string | null
  dueCents?: number
  creditCents?: number
}

export interface WarehouseItem {
  id: string
  branchId: string
  branchName: string | null
  name: string
  isDefault: boolean
  isActive: boolean
}

export type PurchaseView = "por_llegar" | "por_pagar" | "borradores" | "todas"

export interface PurchaseListItem {
  id: string
  orderNumber: number
  label: string
  status: string
  currency: string
  notes: string | null
  supplierId: string
  supplierName: string
  warehouseId: string
  warehouseName: string
  branchId: string
  branchName: string
  createdAt: string
  createdByName: string | null
  lines: number
  pendingLines: number
  /** Solo con precios. */
  totalCents?: number
  balance?: PurchaseBalance | null
}

export interface PurchaseList {
  view: PurchaseView
  items: PurchaseListItem[]
  total: number
  counts: { por_llegar: number; borradores: number; todas: number; por_pagar?: number }
}

export interface PurchaseLine {
  id: string
  productId: string
  productName: string
  productSku: string
  unit: string
  purchaseUnit: string | null
  unitFactor: number
  /** En unidades de compra. */
  quantity: number
  receivedQuantity: number
  pendingQuantity: number
  /** El producto ya tuvo lotes con vencimiento: al recibir se piden lote y vencimiento. */
  tracksLots: boolean
  /** Solo con precios, por unidad de compra. */
  unitCostCents?: number
  orderedUnitCostCents?: number | null
  subtotalCents?: number
  receivedCents?: number
}

/** Un pago de una compra: su gasto de Materiales o lo usado de lo que se tenía a favor. */
export interface PurchasePayment {
  id: string
  kind: "pago" | "a_favor"
  amountCents: number
  paidAt: string
  concept: string | null
  fromCash: boolean
  receiptKind: string | null
  receiptNumber: string | null
  byName: string | null
  voidedAt: string | null
  voidReason: string | null
}

/** Una compra tal como llega (con o sin precios). */
export interface PurchaseOrderView {
  id: string
  orderNumber: number
  label: string
  status: string
  currency: string
  notes: string | null
  supplierId: string
  supplierName: string | null
  supplierPhone: string | null
  supplierEmail: string | null
  warehouseId: string
  warehouseName: string | null
  warehouseIsDefault: boolean
  branchId: string | null
  branchName: string | null
  createdBy: string | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
  lastReceivedAt: string | null
  received: boolean
  complete: boolean
  lines: PurchaseLine[]
  totalCents?: number
  balance?: PurchaseBalance | null
  payments?: PurchasePayment[]
  supplierCreditCents?: number
}

/** Una compra con sus precios: la que paga «Registrar pago». */
export interface PurchaseOrderDetail extends PurchaseOrderView {
  totalCents: number
  balance: PurchaseBalance | null
  payments: PurchasePayment[]
  supplierCreditCents: number
}

export function hasPrices(order: PurchaseOrderView): order is PurchaseOrderDetail {
  return typeof order.totalCents === "number" && Array.isArray(order.payments)
}

export interface ReorderItem extends ProductUnits {
  productId: string
  name: string
  sku: string
  onHand: number
  shortage: number
  minQuantity: number
  state: ProductState
  onTheWay: number
  missing: number
  /** Cuánto pedir, en unidades de compra. */
  quantity: number
  usedLast30Days: number
  inDraft: { orderId: string; orderNumber: number; label: string } | null
  lastPurchase: LastPurchase | null
}

export interface ReorderSuggestions {
  branch: { id: string; name: string }
  currency: string | null
  items: ReorderItem[]
}

export interface ReorderDrafts {
  branch: { id: string; name: string }
  drafts: Array<{ id: string; orderNumber: number; label: string; supplierId: string; supplierName: string | null; lines: number }>
  withoutSupplier: ReorderItem[]
  alreadyInDraft: ReorderItem[]
}

export type ImportRowStatus = "nuevo" | "existe" | "parecido" | "invalido"

export interface ImportPreviewRow {
  index: number
  name: string
  status: ImportRowStatus
  reason: string | null
  unit: string
  unitCode: string | null
  purchaseUnit: string | null
  purchaseUnitCode: string | null
  purchaseFactor: number
  unitReview: boolean
  onHand: number | null
  minQuantity: number | null
  productId: string | null
  similarTo: { id: string; name: string } | null
}

export interface ImportPreview {
  branch: { id: string; name: string }
  rows: ImportPreviewRow[]
  counts: Record<ImportRowStatus, number>
}

export interface ImportRowInput {
  name: string | null
  unit: string | null
  onHand: string | null
  minQuantity: string | null
  productId?: string | null
}

export interface ImportResult {
  branch: { id: string; name: string }
  created: number
  updated: number
  unchanged: number
}

export interface CountResult {
  branch: { id: string; name: string }
  counted: number
  changed: Array<{ productId: string; name: string; unit: string; before: number; after: number; delta: number }>
  unchanged: number
}

/* ---------------- llamadas ---------------- */

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) })
const params = (values: Record<string, string | number | undefined | null>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}
const data = <T>(promise: Promise<{ data: T }>) => promise.then((result) => result.data)

/** Claves de React Query: todo cuelga de `["inventory"]` para invalidar de una vez. */
export const inventoryKeys = {
  all: ["inventory"] as const,
  products: (branchId: string, q = "", need = "") => ["inventory", "products", branchId, q, need] as const,
  product: (id: string, branchId: string) => ["inventory", "product", id, branchId] as const,
  orders: (branchId: string, view: PurchaseView, supplierId = "") => ["inventory", "orders", branchId, view, supplierId] as const,
  order: (id: string) => ["inventory", "order", id] as const,
  movements: (filters: Record<string, string>) => ["inventory", "movements", filters] as const,
  suppliers: (q = "") => ["inventory", "suppliers", q] as const,
  warehouses: (branchId: string) => ["inventory", "warehouses", branchId] as const,
  reorder: (branchId: string) => ["inventory", "reorder", branchId] as const,
}

export const fetchProducts = (branchId: string, q?: string, need?: ProductNeed | null) =>
  data(apiFetch<{ data: ProductList }>(`/api/inventory/products${params({ branchId, q: q?.trim(), need })}`))

export const fetchProduct = (id: string, branchId: string) =>
  data(apiFetch<{ data: ProductDetail }>(`/api/inventory/products/${id}${params({ branchId })}`))

export interface ProductInputBody {
  name?: string
  sku?: string | null
  usedInCare?: boolean
  forSale?: boolean
  unit?: string
  unitCode?: string | null
  purchaseUnit?: string | null
  purchaseUnitCode?: string | null
  purchaseFactor?: number
  minimums?: Array<{ branchId: string; minQuantity: number }>
  salePriceCents?: number | null
}

export const createProduct = (body: ProductInputBody) =>
  data(apiFetch<{ data: { id: string; name: string } }>("/api/inventory/products", json(body)))

export const updateProduct = (id: string, body: ProductInputBody) =>
  data(apiFetch<{ data: { id: string; name: string } }>(`/api/inventory/products/${id}`, { method: "PATCH", body: JSON.stringify(body) }))

export const setProductActive = (id: string, isActive: boolean) =>
  data(apiFetch<{ data: unknown }>(`/api/inventory/products/${id}/activation`, json({ isActive })))

export const writeOffExpired = (id: string, branchId: string, idempotencyKey: string) =>
  data(apiFetch<{ data: { quantity: number; lots: Array<{ code: string; quantity: number }> } }>(`/api/inventory/products/${id}/write-off`, json({ branchId, idempotencyKey })))

export const previewImport = (branchId: string, rows: ImportRowInput[]) =>
  data(apiFetch<{ data: ImportPreview }>("/api/inventory/products/import/preview", json({ branchId, rows })))

export const importProducts = (branchId: string, rows: ImportRowInput[], idempotencyKey: string) =>
  data(apiFetch<{ data: ImportResult }>("/api/inventory/products/import", json({ branchId, rows, idempotencyKey })))

export const countStock = (branchId: string, items: Array<{ productId: string; counted: number }>, idempotencyKey: string) =>
  data(apiFetch<{ data: CountResult }>("/api/inventory/count", json({ branchId, items, idempotencyKey })))

export const adjustLot = (lotId: string, body: { counted: number; reason: AdjustReason; note: string | null; idempotencyKey: string }) =>
  data(apiFetch<{ data: { delta: number } }>(`/api/inventory/lots/${lotId}/adjust`, json(body)))

export const registerUse = (body: {
  productId: string
  branchId: string
  quantity: number
  lotId: string | null
  patientId: string | null
  note: string | null
  idempotencyKey: string
}) => data(apiFetch<{ data: { encounterId: string | null } }>("/api/inventory/usage", json(body)))

export const transferStock = (body: {
  productId: string
  fromBranchId: string
  toBranchId: string
  quantity: number
  lotId: string | null
  note: string | null
  idempotencyKey: string
}) => data(apiFetch<{ data: { covered: number } }>("/api/inventory/transfers", json(body)))

export const addStock = (body: {
  productId: string
  branchId: string
  quantity: number
  lotCode: string | null
  expiresAt: string | null
  reason: AddReason
  note: string | null
  idempotencyKey: string
}) => data(apiFetch<{ data: { covered: number } }>("/api/inventory/additions", json(body)))

export const MOVEMENTS_PAGE = 50

export const fetchMovements = (filters: {
  branchId: string
  q?: string
  kind?: string
  productId?: string
  from?: string
  offset: number
}) =>
  data(
    apiFetch<{ data: { items: MovementItem[]; total: number } }>(
      `/api/inventory/movements${params({ ...filters, limit: MOVEMENTS_PAGE })}`,
    ),
  )

export const fetchSuppliers = (q?: string) =>
  data(apiFetch<{ data: SupplierItem[] }>(`/api/inventory/suppliers${params({ q: q?.trim() })}`))

export interface SupplierBody {
  name?: string
  docType?: string | null
  docNumber?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
}

export const createSupplier = (body: SupplierBody) =>
  data(apiFetch<{ data: SupplierItem }>("/api/inventory/suppliers", json(body)))

export const updateSupplier = (id: string, body: SupplierBody) =>
  data(apiFetch<{ data: SupplierItem }>(`/api/inventory/suppliers/${id}`, { method: "PATCH", body: JSON.stringify(body) }))

export const setSupplierActive = (id: string, isActive: boolean) =>
  data(apiFetch<{ data: unknown }>(`/api/inventory/suppliers/${id}/activation`, json({ isActive })))

export const fetchWarehouses = (branchId: string) =>
  data(apiFetch<{ data: WarehouseItem[] }>(`/api/inventory/warehouses${params({ branchId, onlyActive: "true" })}`))

export const ORDERS_PAGE = 100

export const fetchOrders = (branchId: string, view: PurchaseView, supplierId: string | undefined, offset: number) =>
  data(
    apiFetch<{ data: PurchaseList }>(
      `/api/inventory/purchase-orders${params({ branchId, view, supplierId, offset, limit: ORDERS_PAGE })}`,
    ),
  )

export const fetchOrder = (id: string) => data(apiFetch<{ data: PurchaseOrderView }>(`/api/inventory/purchase-orders/${id}`))

export interface PurchaseLineBody {
  productId: string
  quantity: number
  unitCostCents?: number
  lots?: Array<{ quantity: number; lotCode: string | null; expiresAt: string | null }>
}

export const createOrder = (body: {
  supplierId: string
  branchId: string
  warehouseId?: string | null
  mode: "borrador" | "pedir" | "ya_la_tengo"
  notes: string | null
  lines: PurchaseLineBody[]
}) => data(apiFetch<{ data: PurchaseOrderView }>("/api/inventory/purchase-orders", json(body)))

export const updateOrder = (
  id: string,
  body: { supplierId: string; branchId: string; warehouseId?: string | null; notes: string | null; lines: PurchaseLineBody[] },
) => data(apiFetch<{ data: PurchaseOrderView }>(`/api/inventory/purchase-orders/${id}`, { method: "PATCH", body: JSON.stringify(body) }))

export const confirmOrder = (id: string) => data(apiFetch<{ data: unknown }>(`/api/inventory/purchase-orders/${id}/confirm`, { method: "POST" }))

export const receiveOrder = (
  id: string,
  body: {
    idempotencyKey: string
    lines: Array<{
      productId: string
      lots: Array<{ quantity: number; lotCode: string | null; expiresAt: string | null }>
      unitCostCents?: number
    }>
  },
) => data(apiFetch<{ data: PurchaseOrderView }>(`/api/inventory/purchase-orders/${id}/receive`, json(body)))

export const closeOrder = (id: string) => data(apiFetch<{ data: PurchaseOrderView }>(`/api/inventory/purchase-orders/${id}/close`, { method: "POST" }))

export const cancelOrder = (id: string, payments?: "anular" | "a_favor") =>
  data(
    apiFetch<{ data: unknown }>(
      `/api/inventory/purchase-orders/${id}/cancel`,
      json(payments ? { payments, ...(payments === "anular" ? { reason: "Se canceló la compra" } : {}) } : {}),
    ),
  )

export const fetchReorder = (branchId: string) => data(apiFetch<{ data: ReorderSuggestions }>(`/api/inventory/reorder${params({ branchId })}`))

export const createReorderDrafts = (branchId: string) => data(apiFetch<{ data: ReorderDrafts }>("/api/inventory/reorder/drafts", json({ branchId })))

/* ---------------- motivos ---------------- */

export type AdjustReason = "conteo" | "se_dano" | "vencio" | "otro"
export const ADJUST_REASON_OPTIONS: ReadonlyArray<{ value: AdjustReason; label: string }> = [
  { value: "conteo", label: "Conteo" },
  { value: "se_dano", label: "Se dañó" },
  { value: "vencio", label: "Venció" },
  { value: "otro", label: "Otro" },
]

export type AddReason = "muestra" | "otro"
export const ADD_REASON_OPTIONS: ReadonlyArray<{ value: AddReason; label: string }> = [
  { value: "muestra", label: "Muestra o regalo" },
  { value: "otro", label: "Otro" },
]

/** Los tipos de movimiento, con las palabras del filtro «Qué pasó». */
export const MOVEMENT_KIND_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "ingreso", label: "Llegó o se agregó" },
  { value: "consumo", label: "Usado" },
  { value: "venta", label: "Vendido" },
  { value: "ajuste", label: "Conteo, ajuste o baja" },
  { value: "traslado", label: "Trasladado" },
  { value: "devolucion", label: "Devuelto" },
  { value: "cobertura", label: "Cubrió lo usado sin haber" },
]

/* ---------------- números y fechas en palabras de la clínica ---------------- */

const locale = () => activeOrgLocale() ?? "es"

/**
 * Un número entero escrito por la clínica: «1,050», «1.050» o «1050». En un
 * entero no hay decimales, así que punto, coma y espacios son separadores de
 * miles. `null` si está vacío; `NaN` si no es un entero desde 0.
 */
export function parseWhole(text: string): number | null {
  const value = text.trim().replace(/[\s  ]/g, "")
  if (!value) return null
  if (!/^\d{1,3}([.,]\d{3})*$/.test(value) && !/^\d+$/.test(value)) return Number.NaN
  const parsed = Number(value.replace(/[.,]/g, ""))
  return Number.isSafeInteger(parsed) && parsed <= 1_000_000_000 ? parsed : Number.NaN
}

/** Un entero con el separador de miles de la clínica: «1,100». */
export function formatWhole(value: number, at = locale()): string {
  return new Intl.NumberFormat(at, { maximumFractionDigits: 0 }).format(value).replace(/^-/, "−")
}

/** «1,100 guantes», con el signo menos tipográfico. */
export function unitsText(quantity: number, unit: string, at = locale()): string {
  return quantityWords(quantity, unit, at).replace(/^-/, "−")
}

/** Lo que hay: «1,100 guantes · 11 cajas» cuando es exacto en cajas. */
export function stockText(quantity: number, product: ProductUnits, at = locale()): string {
  const use = unitsText(quantity, product.unit, at)
  if (!product.purchaseUnit || product.purchaseFactor <= 1 || quantity <= 0 || quantity % product.purchaseFactor !== 0) return use
  return `${use} · ${quantityWords(quantity / product.purchaseFactor, product.purchaseUnit, at)}`
}

/** Cantidad en unidades de compra: «8 cajas», «1 caja de 50». */
export function purchaseQuantityText(
  quantity: number,
  line: { purchaseUnit: string | null; unit: string; unitFactor?: number; purchaseFactor?: number },
  at = locale(),
): string {
  const factor = line.unitFactor ?? line.purchaseFactor ?? 1
  if (!line.purchaseUnit || factor <= 1) return unitsText(quantity, line.unit, at)
  return `${unitsText(quantity, line.purchaseUnit, at)} de ${formatWhole(factor, at)}`
}

/** «por guante, se compra por caja de 100»: las unidades de un producto en una línea. */
export function unitsLine(product: { purchaseUnit: string | null; unit: string; purchaseFactor: number }, at = locale()): string {
  if (!product.purchaseUnit || product.purchaseFactor <= 1) return `por ${product.unit}`
  return `por ${product.unit}, se compra por ${product.purchaseUnit} de ${formatWhole(product.purchaseFactor, at)}`
}

/**
 * «la caja», «el frasco»: el artículo de una unidad para «S/ 36.50 la caja».
 * Las palabras en -a, -dad o -ión son femeninas; las demás de la lista, masculinas.
 */
export function withArticle(word: string): string {
  const lower = word.trim().toLocaleLowerCase("es")
  return `${/(a|dad|i[oó]n)$/.test(lower) ? "la" : "el"} ${word.trim()}`
}

/** Cómo se usa un producto: «Se usa en las atenciones · se vende». */
export function usageText(product: { usedInCare: boolean; forSale: boolean }): string {
  if (product.usedInCare && product.forSale) return "Se usa en las atenciones y se vende"
  return product.forSale ? "Se vende" : "Se usa en las atenciones"
}

export function moneyText(cents: number, currency: string, at = locale()): string {
  return formatMoney(cents, currency, at)
}

/** El símbolo de la moneda en el formato de la clínica («S/», «$»). */
export function currencySymbol(currency: string, at = locale()): string {
  try {
    const part = new Intl.NumberFormat(at, { style: "currency", currency }).formatToParts(1).find((item) => item.type === "currency")
    return part?.value ?? currency
  } catch {
    return currency
  }
}

const noDots = (text: string) => text.replace(/\./g, "")

/** Un día de calendario («2026-11-12») como lo lee la clínica: «12 nov», o «12 nov 2027» si es de otro año. */
export function dayText(day: string, today = clinicToday()): string {
  const date = new Date(`${day}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  const sameYear = day.slice(0, 4) === today.slice(0, 4)
  return noDots(
    new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(date),
  )
}

/** Un vencimiento: «12 nov» este año; «mar 2027» si es de otro. */
export function expiryText(day: string, today = clinicToday()): string {
  if (day.slice(0, 4) === today.slice(0, 4)) return dayText(day, today)
  const date = new Date(`${day}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return day
  return noDots(new Intl.DateTimeFormat(locale(), { month: "short", year: "numeric", timeZone: "UTC" }).format(date))
}

/** «Hoy» en la zona de la clínica, como `AAAA-MM-DD`. */
/** El día de la clínica de un instante del servidor (ISO en UTC); una fecha sola queda igual. */
export function clinicDayOf(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : clinicToday(new Date(value))
}

export function clinicToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: activeOrgTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** Cuándo pasó algo, en la zona y el formato de la clínica: «Hoy 10:58», «Ayer 09:10», «17 oct 16:05». */
export function whenText(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  const timeZone = activeOrgTimeZone()
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
  const today = clinicToday(now)
  const time = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone }).format(date)
  if (day === today) return `Hoy ${time}`
  if (day === shiftDay(today, -1)) return `Ayer ${time}`
  return `${dayText(day, today)} ${time}`
}

/* ---------------- estados en palabras ---------------- */

export type Tone = "bad" | "warn" | "soft" | "ok" | "muted"

/** Las clases de cada tono: siempre con texto, nunca solo color. */
export const TONE_CLASS: Record<Tone, string> = {
  bad: "bg-danger-soft text-destructive",
  warn: "bg-warning-soft text-warning",
  soft: "bg-primary-soft text-primary-soft-foreground",
  ok: "bg-success-soft text-success",
  muted: "bg-secondary text-foreground/80",
}

/** El verbo que concuerda con la cantidad: «falta 1», «faltan 3». */
export function byCount(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural
}

/** El estado de un producto en una sede, con palabras y su tono; `null` si está bien. */
export function stateBadge(item: SedeStatus, today = clinicToday()): { label: string; tone: Tone } | null {
  switch (item.state) {
    case "faltante":
      return { label: `${byCount(item.shortage, "Falta", "Faltan")} ${formatWhole(item.shortage)} · ${byCount(item.shortage, "se usó", "se usaron")} sin haber`, tone: "bad" }
    case "vencido":
      return item.expired
        ? { label: `Venció el ${dayText(item.expired.firstDate, today)} · ${formatWhole(item.expired.quantity)}`, tone: "bad" }
        : { label: "Venció", tone: "bad" }
    case "hace_falta":
      return { label: `${byCount(item.missing, "Hace", "Hacen")} falta ${formatWhole(item.missing)}`, tone: "warn" }
    case "no_hay":
      return { label: "No hay", tone: "warn" }
    case "por_vencer": {
      const soon = item.expiring
      if (!soon) return { label: "Por vencer", tone: "soft" }
      const verb = soon.firstQuantity === 1 ? "Vence" : "Vencen"
      return { label: `${verb} ${formatWhole(soon.firstQuantity)} el ${dayText(soon.date, today)}`, tone: "soft" }
    }
    default:
      return null
  }
}

/** Cómo se dice el estado de una compra. */
export const ORDER_STATUS_WORDS: Record<string, string> = {
  borrador: "Borrador",
  confirmada: "Pedida",
  parcialmente_recibida: "Llegó en parte",
  recibida: "Llegó completa",
  cerrada: "Cerrada con lo recibido",
  cancelada: "Cancelada",
}

/** «Llegó» de una compra en la lista. */
export function arrivalBadge(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "borrador":
      return { label: "Borrador", tone: "muted" }
    case "confirmada":
      return { label: "Aún no llega", tone: "muted" }
    case "parcialmente_recibida":
      return { label: "En parte", tone: "warn" }
    case "recibida":
      return { label: "Completa", tone: "ok" }
    case "cerrada":
      return { label: "Cerrada con lo recibido", tone: "muted" }
    default:
      return { label: "Cancelada", tone: "muted" }
  }
}

export type PurchasePaymentTone = "warning" | "info" | "success" | "muted"

/** Cómo va el pago de una compra, en palabras y con su tono (nunca solo con color). */
export function purchasePaymentState(
  order: { status: string },
  balance: PurchaseBalance | null,
  money: (cents: number) => string,
): { label: string; tone: PurchasePaymentTone } {
  if (order.status === "borrador") return { label: "Sin confirmar", tone: "muted" }
  if (!balance) return { label: "—", tone: "muted" }
  if (order.status === "cancelada") return balance.paidCents > 0 ? { label: `A favor ${money(balance.paidCents)}`, tone: "info" } : { label: "Cancelada", tone: "muted" }
  if (balance.receivedCents === 0)
    return balance.paidCents > 0 ? { label: `Adelanto ${money(balance.paidCents)}`, tone: "info" } : { label: "Aún no llega", tone: "muted" }
  if (balance.dueCents > 0)
    return balance.paidCents > 0 ? { label: `Pagada en parte · falta ${money(balance.dueCents)}`, tone: "warning" } : { label: `Por pagar ${money(balance.dueCents)}`, tone: "warning" }
  if (balance.aheadCents > 0)
    return order.status === "recibida" || order.status === "cerrada"
      ? { label: `✓ Pagada · a favor ${money(balance.aheadCents)}`, tone: "success" }
      : { label: `✓ Pagada · adelanto ${money(balance.aheadCents)}`, tone: "success" }
  return { label: "✓ Pagada", tone: "success" }
}

export const PAYMENT_TONE: Record<PurchasePaymentTone, Tone> = { warning: "warn", info: "soft", success: "ok", muted: "muted" }

/* ---------------- copiar el pedido ---------------- */

/** El nombre del proveedor sin su forma societaria: «Dental Andina SAC» → «Dental Andina». */
export function supplierShortName(name: string): string {
  const short = name.replace(/[\s,]+(s\.?\s?a\.?\s?c\.?|s\.?\s?r\.?\s?l\.?|e\.?\s?i\.?\s?r\.?\s?l\.?|s\.?\s?a\.?\s?a\.?|s\.?\s?a\.?|ltda\.?|s\.?\s?l\.?|s\.?\s?a\.?\s?s\.?)$/i, "").trim()
  return short || name
}

/**
 * El texto de «Copiar el pedido», listo para pegar en WhatsApp o en un
 * correo. odentIA no envía nada: el mensaje lo manda quien pide.
 */
export function orderMessage(order: {
  supplierName: string | null
  branchName: string | null
  notes: string | null
  lines: Array<{ productName: string; quantity: number; purchaseUnit: string | null; unit: string; unitFactor: number }>
}, clinicName: string, at = locale()): string {
  const greeting = order.supplierName ? `Hola, ${supplierShortName(order.supplierName)}.` : "Hola."
  const who = [clinicName.trim(), order.branchName?.trim()].filter(Boolean).join(", ")
  const lines = order.lines.map((line) => `· ${purchaseQuantityText(line.quantity, line, at)} de ${line.productName}`)
  const notes = order.notes?.trim()
  return [
    `${greeting}${who ? ` Somos ${who}.` : ""} Quisiéramos pedir:`,
    ...lines,
    `${notes ? `${notes.replace(/[.\s]+$/, "")}. ` : ""}Gracias.`,
  ].join("\n")
}

/* ---------------- errores ---------------- */

/** Validador de la librería en inglés: nunca llega a la pantalla. */
const LIBRARY_TEXT = /^(invalid|expected|required|too )/i

/**
 * El error de una operación en palabras de la clínica. Los rechazos del
 * servidor ya vienen en español («Ese código ya lo usa…»): se muestran tal
 * cual. Sin respuesta del servidor no se sabe si se aplicó: se dice así.
 */
export function inventoryErrorMessage(error: unknown, options: { repeatable?: boolean } = {}): string {
  if (error == null) return ""
  if (isAmbiguousMutationError(error)) {
    // Lo que lleva la clave del formulario se puede reintentar; crear algo sin clave, no.
    return options.repeatable === false
      ? "No pudimos confirmar si se guardó. Mira la lista antes de volver a guardar, para no repetirlo."
      : "No pudimos confirmar si se guardó. Vuelve a intentarlo sin cambiar nada: si ya se guardó, no se repite."
  }
  if (error instanceof ApiError) {
    if (error.status === 401) return "Tu sesión venció. Vuelve a iniciar sesión para continuar; lo escrito se conserva."
    const message = error.shape.message?.trim()
    if (message && !LIBRARY_TEXT.test(message)) return message
    if (error.status === 403) return "Tu rol no tiene permiso para hacer esto. Pídeselo a quien lleva el inventario."
    if (error.status === 404) return "Ya no está disponible. Cierra y vuelve a abrir la lista."
  }
  return "No se pudo guardar. Revisa los datos y vuelve a intentarlo."
}

/** Una clave nueva por formulario abierto: el reintento no duplica. */
export function newKey(): string {
  return crypto.randomUUID()
}
