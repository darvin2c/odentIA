/**
 * Inventario por sede (ADR 0067): proveedores, almacenes, productos con su
 * unidad de uso y de compra, compras con varios productos y recepción por
 * lotes, lo que hace falta y lo que vence, conteos, bajas, traslados y el uso
 * fuera de una atención.
 *
 * Toda función recibe `tx: Db` ya contextualizado (`withOrgContext`).
 * Ningún saldo se escribe aquí: todo movimiento pasa por las primitivas de
 * `inventory-stock.ts` (lote que vence primero, faltante, cobertura, conteo,
 * traslado), que bloquean los lotes y dejan cada fila del ledger con su clave.
 * El ledger (`stock_movement`) nunca se edita ni borra: los errores se
 * corrigen con otro movimiento que dice por qué.
 *
 * Lo que hay en una sede = sus lotes − su faltante, en la unidad de uso. Las
 * compras se escriben en unidades de compra y su línea copia el factor del
 * producto: al recibir, el lote suma `recibido × factor`.
 *
 * Compras ≠ pagos: la orden registra el compromiso comercial y su pago es un
 * gasto de Materiales enlazado (`payPurchaseOrder` de Finanzas; ADR 0061). Lo
 * que se debe de cada una sale de `purchase-balance.ts`.
 *
 * Precios (`prices`): costos, último precio y precio de venta viajan solo a
 * quien los ve (`inventory.read`, lo decide la ruta). Sin precios la respuesta
 * no los trae: no basta con esconderlos en la pantalla.
 */
import { canAccess, ORG_ROLES } from "@odentia/auth/permissions"
import {
  documentTypeLabel,
  findInventoryUnit,
  INVENTORY_UNITS,
  inventoryUnitByCode,
  quantityWords,
  supplierDocumentTypes,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  PURCHASE_ORDER_STATUSES,
  product,
  productLot,
  productMinimum,
  purchaseOrder,
  purchaseOrderLine,
  STOCK_MOVEMENT_KINDS,
  supplier,
  supplierCreditUse,
  warehouse,
} from "@odentia/db/schema/inventory"
import { orgCounter, patient } from "@odentia/db/schema/clinical"
import { expense } from "@odentia/db/schema/finance"
import { member, user } from "@odentia/db/schema/auth"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm"
import { foldedWordsMatch } from "./search-text.js"
import {
  branchNotFound,
  invalidField,
  isUniqueViolation,
  notFound,
  purchaseOrderNotFound,
  ServiceError,
  validation,
} from "./errors.js"
import {
  assertSupplierCreditCovered,
  lockPurchaseOrder,
  lockSupplier,
  purchaseOrderLabel,
  voidExpense,
  voidSupplierCreditUse,
} from "./finance.js"
import {
  clinicToday,
  consumeFefo,
  defaultWarehouse,
  fefoLots,
  lotFor,
  type MovementRow,
  movementsWithPrefix,
  NO_LOT_CODE,
  receiveIntoLot,
  sedeWarehouseIds,
  setLotQuantity,
  setSedeStock,
  stockBySede,
  transferUnits,
} from "./inventory-stock.js"
import { findOrgCurrency, findOrgLocale, formatOrgMoney, orgClinicalProfile, requireOrgCurrency } from "./locale.js"
import { type PurchaseBalance, purchaseBalances, supplierCredits } from "./purchase-balance.js"
import { createWorkspaceNotification } from "./workspace.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import type { WaitingInventory } from "./workspace-home.js"

/* ---------------- validaciones ---------------- */

/**
 * El rechazo de un dato: con `path` (su nombre en el cuerpo, `lines[2].quantity`)
 * la pantalla lo dice junto a ese campo; sin él, junto a los botones.
 */
function invalid(message: string, path?: string): ServiceError {
  return path ? invalidField(path, message) : validation(message)
}

function textRequired(value: string | null | undefined, field: string, max = 200, path?: string): string {
  const text = value?.trim() ?? ""
  if (!text || text.length > max) throw invalid(`${field} debe tener 1–${max} caracteres`, path)
  return text
}

function textOptional(value: string | null | undefined, field: string, max = 500, path?: string): string | null {
  if (value == null) return null
  const text = value.trim()
  if (!text) return null
  if (text.length > max) throw invalid(`${field} admite hasta ${max} caracteres`, path)
  return text
}

function quantity(value: number, field = "La cantidad", path?: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000_000)
    throw invalid(`${field} debe ser un entero positivo`, path)
  return value
}

/** Lo que hay, contado: un entero desde 0. */
function counted(value: number, field = "Lo que hay", path?: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000)
    throw invalid(`${field} debe ser un número entero desde 0`, path)
  return value
}

/** Importe en la unidad menor de la moneda; el tope es el de la columna (`integer`). */
function cents(value: number, field = "El costo por unidad", path?: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${field} no es un importe válido`, path)
  if (value > 2_147_483_647) throw invalid(`${field} es demasiado alto`, path)
  return value
}

function currency(value: string): string {
  if (!/^[A-Z]{3}$/.test(value)) throw validation("La moneda de la orden no es válida")
  return value
}

/** La clave del formulario abierto: sin ella un reintento no se distingue de otra operación. */
function formKey(value: string | null | undefined, message: string): string {
  const key = value?.trim() ?? ""
  if (!key || key.length > 200) throw validation(message)
  return key
}

const RETRY_KEY = "No se pudo identificar esta operación: cierra el formulario y vuelve a abrirlo"

/** Un día `AAAA-MM-DD` dicho como lo lee la clínica («30 jun 2028»). */
function dayWords(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`))
}

/** «Hoy» en la zona de la clínica, como `AAAA-MM-DD`: un lote vence a medianoche de la clínica, no de UTC. */
function localToday(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

function dateOnly(value: string | null | undefined, field: string, path?: string): string | null {
  if (value == null || value === "") return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid(`${field} debe ser AAAA-MM-DD`, path)
  const time = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(time)) throw invalid(`${field} no es una fecha válida`, path)
  return value
}

/** Un conflicto con el estado actual; con `path`, del dato que hay que cambiar. */
function conflict(message: string, path?: string): ServiceError {
  return new ServiceError("CONFLICT", 409, message, path ? { [path]: message } : undefined)
}

/** Texto sin tildes ni mayúsculas, para comparar nombres. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "es", { sensitivity: "base" })

/** Instante como texto ISO en UTC: la pantalla lo dice en la zona de la clínica. */
const iso = (column: SQL) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

async function audit(tx: Db, orgId: string, actorUserId: string, entity: string, id: string, action: string) {
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, entity, entityId: id, action })
}

/** Lo que vence en estos días cuenta como «Por vencer». */
export const INVENTORY_EXPIRY_DAYS = 30

/* ---------------- búsquedas comunes ---------------- */

async function requireSupplier(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(supplier)
    .where(and(eq(supplier.organizationId, orgId), eq(supplier.id, id)))
    .limit(1)
  if (!row) throw notFound("Proveedor")
  return row
}

async function requireWarehouse(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(warehouse)
    .where(and(eq(warehouse.organizationId, orgId), eq(warehouse.id, id)))
    .limit(1)
  if (!row) throw notFound("Almacén")
  return row
}

type ProductRow = typeof product.$inferSelect

async function requireProduct(tx: Db, orgId: string, id: string): Promise<ProductRow> {
  const [row] = await tx
    .select()
    .from(product)
    .where(and(eq(product.organizationId, orgId), eq(product.id, id)))
    .limit(1)
  if (!row) throw notFound("Producto")
  return row
}

/** Una sede activa de la clínica: donde se escribe algo nuevo. */
async function requireBranch(tx: Db, orgId: string, id: string): Promise<{ id: string; name: string }> {
  const [row] = await tx
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.id, id), eq(branch.isActive, true)))
    .limit(1)
  if (!row) throw branchNotFound()
  return row
}

/**
 * La sede que se lee: la pedida (activa o no, lo que tiene sigue a la vista)
 * o, sin ella, la primera activa.
 */
async function sedeOf(tx: Db, orgId: string, branchId?: string | null): Promise<{ id: string; name: string }> {
  const rows = await tx
    .select({ id: branch.id, name: branch.name, isActive: branch.isActive })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), branchId ? eq(branch.id, branchId) : eq(branch.isActive, true)))
    .orderBy(asc(branch.createdAt), asc(branch.id))
    .limit(1)
  const row = rows[0]
  if (!row) throw branchNotFound()
  return { id: row.id, name: row.name }
}

/** Paciente de la clínica, con su persona: el uso queda unido a él. */
async function requireTenantPatient(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select({ id: patient.id, displayName: patientPerson.displayName })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, id)))
    .limit(1)
  if (!row) throw notFound("Paciente")
  return row
}

async function requireOrder(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(purchaseOrder)
    .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.id, id)))
    .limit(1)
  if (!row) throw purchaseOrderNotFound()
  return row
}

async function orderLines(tx: Db, orgId: string, orderId: string) {
  return tx
    .select()
    .from(purchaseOrderLine)
    .where(and(eq(purchaseOrderLine.organizationId, orgId), eq(purchaseOrderLine.orderId, orderId)))
    .orderBy(asc(purchaseOrderLine.createdAt), asc(purchaseOrderLine.id))
}

/** Lo que hay de un producto dicho en su unidad («3 cartuchos»), para los mensajes. */
function unitWordsOf(item: { unit: string }, locale: string) {
  return (value: number) => quantityWords(value, item.unit, locale)
}

/* ---------------- proveedores ---------------- */

export interface SupplierInput {
  name: string
  docType?: string | null
  docNumber?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
}

/**
 * Un número sin su tipo no se guarda, porque el tipo es parte de lo que lo
 * hace único.
 */
function assertSupplierDocument(docType: string | null, docNumber: string | null): void {
  if (docNumber && !docType) throw invalidField("docType", "Indica el tipo de documento del proveedor junto con su número")
}

/**
 * El tipo de documento es un código de la lista del país de la clínica
 * (`supplierDocumentTypes`: tributarios, de persona y «Otro»), nunca texto
 * libre: se guarda el código y la pantalla dice su etiqueta. Solo se mira lo
 * que llega; un tipo antiguo que nadie cambia se conserva.
 */
async function supplierDocType(tx: Db, orgId: string, raw: string | null | undefined): Promise<string | null> {
  const docType = textOptional(raw, "El tipo de documento", 20, "docType")?.toUpperCase() ?? null
  if (!docType) return null
  const allowed = supplierDocumentTypes(await orgClinicalProfile(tx, orgId))
  if (!(allowed as readonly string[]).includes(docType)) {
    const list = new Intl.ListFormat("es", { type: "disjunction" }).format(allowed.map(documentTypeLabel))
    throw invalidField("docType", `El tipo de documento del proveedor tiene que ser uno de la lista: ${list}`)
  }
  return docType
}

export async function createSupplier(tx: Db, orgId: string, actorUserId: string, input: SupplierInput) {
  const name = textRequired(input.name, "El nombre del proveedor", 200, "name")
  const docNumber = textOptional(input.docNumber, "El documento", 50, "docNumber")
  const docType = await supplierDocType(tx, orgId, input.docType)
  assertSupplierDocument(docType, docNumber)
  try {
    const [row] = await tx
      .insert(supplier)
      .values({
        organizationId: orgId,
        name,
        docType,
        docNumber,
        email: textOptional(input.email, "El correo", 200, "email"),
        phone: textOptional(input.phone, "El teléfono", 50, "phone"),
        address: textOptional(input.address, "La dirección", 500, "address"),
      })
      .returning()
    if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo guardar el proveedor")
    await audit(tx, orgId, actorUserId, "supplier", row.id, "supplier.created")
    return row
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("Ya existe un proveedor con ese documento", "docNumber")
    throw e
  }
}

export async function updateSupplier(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: Partial<SupplierInput>,
) {
  const current = await requireSupplier(tx, orgId, id)
  const patch: Partial<typeof supplier.$inferInsert> = {}
  if (input.name !== undefined) patch.name = textRequired(input.name, "El nombre del proveedor", 200, "name")
  if (input.docNumber !== undefined) patch.docNumber = textOptional(input.docNumber, "El documento", 50, "docNumber")
  if (input.docType !== undefined) patch.docType = await supplierDocType(tx, orgId, input.docType)
  if (input.email !== undefined) patch.email = textOptional(input.email, "El correo", 200, "email")
  if (input.phone !== undefined) patch.phone = textOptional(input.phone, "El teléfono", 50, "phone")
  if (input.address !== undefined) patch.address = textOptional(input.address, "La dirección", 500, "address")
  assertSupplierDocument(
    patch.docType !== undefined ? patch.docType : current.docType,
    patch.docNumber !== undefined ? patch.docNumber : current.docNumber,
  )
  try {
    const [row] = await tx
      .update(supplier)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(supplier.organizationId, orgId), eq(supplier.id, id)))
      .returning()
    await audit(tx, orgId, actorUserId, "supplier", id, "supplier.updated")
    return row
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("Ya existe un proveedor con ese documento", "docNumber")
    throw e
  }
}

export async function setSupplierActive(tx: Db, orgId: string, actorUserId: string, id: string, isActive: boolean) {
  await requireSupplier(tx, orgId, id)
  const [row] = await tx
    .update(supplier)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(supplier.organizationId, orgId), eq(supplier.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, "supplier", id, isActive ? "supplier.reactivated" : "supplier.deactivated")
  return row
}

export type SupplierListItem = typeof supplier.$inferSelect & {
  /** Compras pedidas o recibidas (sin borradores ni canceladas). */
  orders: number
  /** Solo con precios: lo que se le debe y lo que se tiene a favor, en la moneda de la clínica. */
  currency?: string | null
  dueCents?: number
  creditCents?: number
}

/**
 * Proveedores con cuántas compras tienen y, para quien ve precios, su saldo:
 * «Por pagar» (lo recibido sin pagar) y «A favor» (lo pagado de más de las
 * compras cerradas), con la misma regla del pago de compras (ADR 0061).
 */
export async function listSuppliers(
  tx: Db,
  orgId: string,
  options: { q?: string; onlyActive?: boolean; prices?: boolean } = {},
): Promise<SupplierListItem[]> {
  const conditions = [eq(supplier.organizationId, orgId)]
  if (options.onlyActive) conditions.push(eq(supplier.isActive, true))
  const q = options.q?.trim()
  if (q) conditions.push(foldedWordsMatch([supplier.name, supplier.docNumber], q))
  const rows = await tx
    .select()
    .from(supplier)
    .where(and(...conditions))
    .orderBy(sql`${supplier.isActive} desc`, asc(supplier.name))
    .limit(500)
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const counts = await tx.execute<{ supplierId: string; orders: number }>(sql`
    select supplier_id as "supplierId", count(*)::int as orders from purchase_order
    where organization_id = ${orgId} and status not in ('borrador', 'cancelada')
      and supplier_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    group by supplier_id`)
  const ordersOf = new Map(counts.map((row) => [row.supplierId, row.orders]))
  if (!options.prices) return rows.map((row) => ({ ...row, orders: ordersOf.get(row.id) ?? 0 }))
  const unit = await findOrgCurrency(tx, orgId)
  const due = new Map<string, number>()
  for (const balance of await purchaseBalances(tx, orgId, { dueOnly: true })) {
    if (balance.currency !== unit) continue
    due.set(balance.supplierId, (due.get(balance.supplierId) ?? 0) + balance.dueCents)
  }
  const credit = new Map(
    (await supplierCredits(tx, orgId)).filter((row) => row.currency === unit).map((row) => [row.supplierId, Math.max(0, row.cents)]),
  )
  return rows.map((row) => ({
    ...row,
    orders: ordersOf.get(row.id) ?? 0,
    currency: unit,
    dueCents: due.get(row.id) ?? 0,
    creditCents: credit.get(row.id) ?? 0,
  }))
}

/* ---------------- almacenes ---------------- */

/** Un almacén más en una sede (el principal lo crea la base al crear la sede). */
export async function createWarehouse(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { branchId: string; name: string },
) {
  await requireBranch(tx, orgId, input.branchId)
  // Una sede vieja sin su principal lo recibe antes: el nuevo nunca pasa a serlo.
  await defaultWarehouse(tx, orgId, input.branchId)
  const [row] = await tx
    .insert(warehouse)
    .values({ organizationId: orgId, branchId: input.branchId, name: textRequired(input.name, "El nombre del almacén") })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo guardar el almacén")
  await audit(tx, orgId, actorUserId, "warehouse", row.id, "warehouse.created")
  return row
}

export async function setWarehouseActive(tx: Db, orgId: string, actorUserId: string, id: string, isActive: boolean) {
  const current = await requireWarehouse(tx, orgId, id)
  // Ahí llegan las compras y de ahí salen las atenciones de la sede.
  if (!isActive && current.isDefault)
    throw conflict("El almacén principal de la sede no se desactiva: ahí llegan las compras y de ahí salen las atenciones.")
  const [row] = await tx
    .update(warehouse)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(warehouse.organizationId, orgId), eq(warehouse.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, "warehouse", id, isActive ? "warehouse.reactivated" : "warehouse.deactivated")
  return row
}

export async function updateWarehouse(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: { name?: string; branchId?: string },
) {
  const current = await requireWarehouse(tx, orgId, id)
  const patch: Partial<typeof warehouse.$inferInsert> = {}
  if (input.name !== undefined) patch.name = textRequired(input.name, "El nombre del almacén")
  if (input.branchId !== undefined && input.branchId !== current.branchId) {
    await requireBranch(tx, orgId, input.branchId)
    if (current.isDefault) throw conflict("El almacén principal es de su sede: no se pasa a otra.")
    // Lo pagado de sus compras y sus existencias se cuentan en la sede del
    // almacén (ADR 0061): moverlo reescribiría la historia de la otra sede.
    if (await warehouseHasHistory(tx, orgId, id))
      throw conflict(
        "Este almacén ya tiene existencias, movimientos o compras en su sede y no se puede pasar a otra. Crea un almacén en la otra sede y traslada lo que haga falta.",
      )
    patch.branchId = input.branchId
  }
  const [row] = await tx
    .update(warehouse)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(warehouse.organizationId, orgId), eq(warehouse.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, "warehouse", id, "warehouse.updated")
  return row
}

/** Un lote, un movimiento (de salida o de llegada) o una compra: el almacén ya tiene historia. */
async function warehouseHasHistory(tx: Db, orgId: string, id: string): Promise<boolean> {
  const [row] = await tx.execute<{ used: boolean }>(sql`
    select exists (select 1 from product_lot where organization_id = ${orgId} and warehouse_id = ${id})
      or exists (select 1 from stock_movement where organization_id = ${orgId} and (warehouse_id = ${id} or dest_warehouse_id = ${id}))
      or exists (select 1 from purchase_order where organization_id = ${orgId} and warehouse_id = ${id}) as used`)
  return row?.used === true
}

/** Los almacenes de cada sede, el principal primero (Configuración › Sedes). */
export async function listWarehouses(tx: Db, orgId: string, options: { onlyActive?: boolean; branchId?: string } | boolean = {}) {
  const opts = typeof options === "boolean" ? { onlyActive: options } : options
  const conditions = [eq(warehouse.organizationId, orgId)]
  if (opts.onlyActive) conditions.push(eq(warehouse.isActive, true))
  if (opts.branchId) conditions.push(eq(warehouse.branchId, opts.branchId))
  return tx
    .select({
      id: warehouse.id,
      branchId: warehouse.branchId,
      branchName: branch.name,
      name: warehouse.name,
      isDefault: warehouse.isDefault,
      isActive: warehouse.isActive,
      createdAt: warehouse.createdAt,
    })
    .from(warehouse)
    .leftJoin(branch, and(eq(branch.organizationId, warehouse.organizationId), eq(branch.id, warehouse.branchId)))
    .where(and(...conditions))
    .orderBy(asc(branch.name), sql`${warehouse.isDefault} desc`, asc(warehouse.name))
    .limit(500)
}

/* ---------------- productos ---------------- */

export interface ProductMinimumInput {
  branchId: string
  minQuantity: number
}

export interface ProductInput {
  name: string
  /** Opcional: vacío, se arma desde el nombre («GUA-NIT»). */
  sku?: string | null
  /** «Se usa en las atenciones». */
  usedInCare?: boolean
  /** «Se vende»: aparece en «Cobrar» con su precio de venta. */
  forSale?: boolean
  /** Unidad de uso, en palabras («guante»). */
  unit?: string
  /** Su código de la lista (`INVENTORY_UNITS`), si viene. */
  unitCode?: string | null
  /** Unidad de compra («caja»); null = se compra igual que se usa. */
  purchaseUnit?: string | null
  purchaseUnitCode?: string | null
  /** Unidades de uso que trae una de compra. */
  purchaseFactor?: number
  /** Mínimo de cada sede, en la unidad de uso. */
  minimums?: ProductMinimumInput[]
  /** Precio de venta por unidad de uso, en la moneda de la clínica (solo si se vende). */
  salePriceCents?: number | null
}

const PLURAL_TO_UNIT = new Map(INVENTORY_UNITS.map((unit) => [unit.plural, unit]))

/** Una palabra de unidad en singular: «cajas» → «caja», «cartuchos» → «cartucho». */
function singularUnit(word: string): string {
  const lower = word.trim().toLowerCase()
  const listed = findInventoryUnit(lower) ?? PLURAL_TO_UNIT.get(lower)
  if (listed) return listed.word
  if (/[dlrnj]es$/.test(lower)) return lower.slice(0, -2)
  if (/ces$/.test(lower)) return `${lower.slice(0, -3)}z`
  if (/s$/.test(lower) && lower.length > 3) return lower.slice(0, -1)
  return lower
}

/**
 * La unidad en palabras y su código. Con código, sale de la lista (y la
 * palabra, si viene, tiene que ser la suya); sin él, la palabra se toma tal
 * cual y lleva el código de la lista si lo tiene. Lo que no tiene código
 * («guante») queda como unidad con su nombre.
 */
function unitOf(
  word: string | null | undefined,
  code: string | null | undefined,
  label: string,
  path: string,
): { word: string; code: string | null } | null {
  if (code) {
    const listed = inventoryUnitByCode(code)
    if (!listed) throw invalidField(path, `La unidad ${label} no está en la lista`)
    if (word?.trim() && singularUnit(word) !== listed.word)
      throw invalidField(path, `La unidad ${label} no coincide con la elegida en la lista`)
    return { word: listed.word, code: listed.code }
  }
  if (word == null || !word.trim()) return null
  const text = word.trim()
  if (text.length > 60) throw invalidField(path, `La unidad ${label} admite hasta 60 caracteres`)
  const singular = singularUnit(text)
  return { word: singular, code: findInventoryUnit(singular)?.code ?? null }
}

function purchaseFactorOf(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000)
    throw invalidField("purchaseFactor", "Cuántas trae cada unidad de compra debe ser un número entero de 1 a 100000")
  return value
}

/** Lo que queda del producto después de aplicar el cambio, ya revisado. */
function resolveProduct(input: Partial<ProductInput>, current: ProductRow | null, unitCurrency: string | null) {
  const usedInCare = input.usedInCare ?? current?.usedInCare ?? true
  const forSale = input.forSale ?? current?.forSale ?? false
  if (!usedInCare && !forSale) throw invalidField("usedInCare", "Marca si se usa en las atenciones, si se vende o las dos")

  let unit = current?.unit ?? "unidad"
  let unitCode = current?.unitCode ?? (current ? null : "C62")
  if (input.unit !== undefined || input.unitCode !== undefined) {
    const resolved = unitOf(input.unit, input.unitCode, "de uso", "unit")
    if (!resolved) throw invalidField("unit", "Escribe la unidad en que se usa")
    unit = resolved.word
    unitCode = resolved.code
  }

  let purchaseUnit = current?.purchaseUnit ?? null
  let purchaseUnitCode = current?.purchaseUnitCode ?? null
  let purchaseFactor = current?.purchaseFactor ?? 1
  if (input.purchaseUnit !== undefined || input.purchaseUnitCode !== undefined) {
    const resolved = unitOf(input.purchaseUnit, input.purchaseUnitCode, "de compra", "purchaseUnit")
    purchaseUnit = resolved?.word ?? null
    purchaseUnitCode = resolved?.code ?? null
  }
  if (input.purchaseFactor !== undefined) purchaseFactor = purchaseFactorOf(input.purchaseFactor)
  if (!purchaseUnit || purchaseUnit === unit) {
    // Se compra igual que se usa: cada una trae una.
    if (input.purchaseFactor !== undefined && input.purchaseFactor > 1)
      throw purchaseUnit
        ? invalidField("purchaseFactor", "Si se compra igual que se usa, cada una trae 1")
        : invalidField("purchaseUnit", "Escribe en qué unidad se compra")
    purchaseUnit = null
    purchaseUnitCode = null
    purchaseFactor = 1
  }

  let salePriceCents = current?.salePriceCents ?? null
  let saleCurrency = current?.saleCurrency ?? null
  if (input.salePriceCents !== undefined) {
    if (input.salePriceCents === null) salePriceCents = null
    else {
      if (!forSale) throw invalidField("salePriceCents", "El precio de venta es solo para lo que se vende")
      salePriceCents = cents(input.salePriceCents, "El precio de venta", "salePriceCents")
      if (!unitCurrency) throw invalidField("salePriceCents", "Configura la moneda de la clínica antes de ponerle precio de venta")
      saleCurrency = unitCurrency
    }
  }
  if (!forSale || salePriceCents === null) {
    salePriceCents = null
    saleCurrency = null
  }
  return { usedInCare, forSale, unit, unitCode, purchaseUnit, purchaseUnitCode, purchaseFactor, salePriceCents, saleCurrency }
}

const SKU_SKIP = new Set(["DE", "DEL", "LA", "LAS", "EL", "LOS", "CON", "Y", "E", "PARA", "POR", "EN", "A", "AL", "SIN", "O", "U"])

/** El código que odentIA pone desde el nombre: mayúsculas sin tildes, 3 letras por palabra. */
export function skuFromName(name: string): string {
  const words = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((word) => word && !SKU_SKIP.has(word))
  const base = words
    .slice(0, 4)
    .map((word) => (/^\d+$/.test(word) ? word.slice(0, 6) : word.slice(0, 3)))
    .join("-")
  return base || "PROD"
}

/**
 * El código del producto: el escrito, si nadie más lo usa; vacío, el que se
 * arma desde el nombre, con un número al final si ya existe («GUA-NIT-2»).
 */
async function skuFor(tx: Db, orgId: string, written: string | null | undefined, name: string, ownId?: string): Promise<string> {
  const text = written?.trim() ?? ""
  if (text) {
    if (text.length > 60) throw invalidField("sku", "El código admite hasta 60 caracteres")
    const [taken] = await tx
      .select({ id: product.id, name: product.name })
      .from(product)
      .where(and(eq(product.organizationId, orgId), eq(product.sku, text)))
      .limit(1)
    if (taken && taken.id !== ownId) throw conflict(`Ese código ya lo usa «${taken.name}». Elige otro.`, "sku")
    return text
  }
  const base = skuFromName(name)
  const used = await tx.execute<{ sku: string }>(sql`
    select sku from product where organization_id = ${orgId} and (sku = ${base} or sku like ${`${base}-%`})`)
  const taken = new Set(used.map((row) => row.sku))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}

/** Pone el mínimo de cada sede indicada (sin fila, el mínimo es 0; nada se borra). */
async function setMinimums(tx: Db, orgId: string, productId: string, minimums: ProductMinimumInput[]) {
  const seen = new Set<string>()
  for (const [index, item] of minimums.entries()) {
    if (seen.has(item.branchId)) throw invalidField(`minimums[${index}].branchId`, "El mínimo de una sede va una sola vez")
    seen.add(item.branchId)
    counted(item.minQuantity, "El mínimo", `minimums[${index}].minQuantity`)
    await requireBranch(tx, orgId, item.branchId)
    await tx
      .insert(productMinimum)
      .values({ organizationId: orgId, productId, branchId: item.branchId, minQuantity: item.minQuantity })
      .onConflictDoUpdate({
        target: [productMinimum.organizationId, productMinimum.productId, productMinimum.branchId],
        set: { minQuantity: item.minQuantity, updatedAt: new Date() },
      })
  }
}

async function minimumsOf(tx: Db, orgId: string, productId: string) {
  return tx
    .select({ branchId: productMinimum.branchId, minQuantity: productMinimum.minQuantity })
    .from(productMinimum)
    .where(and(eq(productMinimum.organizationId, orgId), eq(productMinimum.productId, productId)))
}

async function productHasHistory(tx: Db, orgId: string, id: string): Promise<boolean> {
  const [row] = await tx.execute<{ used: boolean }>(sql`
    select exists (select 1 from stock_movement where organization_id = ${orgId} and product_id = ${id})
      or exists (select 1 from purchase_order_line where organization_id = ${orgId} and product_id = ${id}) as used`)
  return row?.used === true
}

export async function createProduct(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: ProductInput & { unitReview?: boolean },
) {
  const name = textRequired(input.name, "El nombre del producto", 200, "name")
  const unitCurrency = input.salePriceCents != null ? await requireOrgCurrency(tx, orgId) : null
  const values = resolveProduct(input, null, unitCurrency)
  const sku = await skuFor(tx, orgId, input.sku, name)
  try {
    const [row] = await tx
      .insert(product)
      .values({ organizationId: orgId, sku, name, ...values, unitReview: input.unitReview ?? false })
      .returning()
    if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo guardar el producto")
    if (input.minimums?.length) await setMinimums(tx, orgId, row.id, input.minimums)
    await audit(tx, orgId, actorUserId, "product", row.id, "product.created")
    return { ...row, minimums: await minimumsOf(tx, orgId, row.id) }
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("Ese código ya lo usa otro producto. Elige otro.", "sku")
    throw e
  }
}

/**
 * Cambia un producto. Lo ya movido o comprado se contó en su unidad de uso:
 * cambiarla reescribiría la historia, así que con movimientos o compras no
 * cambia (salvo la que quedó «Por revisar» al leer la de antes: la clínica
 * dice cuál era). La unidad de compra y su factor sí cambian: cada línea de
 * compra guarda los suyos.
 */
export async function updateProduct(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: Partial<ProductInput>,
) {
  const current = await requireProduct(tx, orgId, id)
  const name = input.name !== undefined ? textRequired(input.name, "El nombre del producto", 200, "name") : current.name
  const unitCurrency = input.salePriceCents != null ? await requireOrgCurrency(tx, orgId) : null
  const values = resolveProduct(input, current, unitCurrency)
  const changesUnit = values.unit !== current.unit
  if (changesUnit && !current.unitReview && (await productHasHistory(tx, orgId, id)))
    throw conflict(
      `La unidad de uso no se puede cambiar: este producto ya tiene movimientos o compras en «${current.unit}». Si cambió la presentación, crea otro producto.`,
      "unit",
    )
  // Vacío al editar, se queda el que tenía: el código no cambia solo.
  const sku = input.sku?.trim() ? await skuFor(tx, orgId, input.sku, name, id) : current.sku
  const unitTouched = input.unit !== undefined || input.unitCode !== undefined
  try {
    const [row] = await tx
      .update(product)
      .set({ ...values, name, sku, unitReview: unitTouched ? false : current.unitReview, updatedAt: new Date() })
      .where(and(eq(product.organizationId, orgId), eq(product.id, id)))
      .returning()
    if (!row) throw notFound("Producto")
    if (input.minimums?.length) await setMinimums(tx, orgId, id, input.minimums)
    await audit(tx, orgId, actorUserId, "product", id, "product.updated")
    return { ...row, minimums: await minimumsOf(tx, orgId, id) }
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("Ese código ya lo usa otro producto. Elige otro.", "sku")
    throw e
  }
}

/** Desactivar: ya no se pide ni se usa; lo que queda sigue a la vista hasta llegar a 0. */
export async function setProductActive(tx: Db, orgId: string, actorUserId: string, id: string, isActive: boolean) {
  await requireProduct(tx, orgId, id)
  const [row] = await tx
    .update(product)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(product.organizationId, orgId), eq(product.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, "product", id, isActive ? "product.reactivated" : "product.deactivated")
  return row
}

/* ---------------- lo que hay en cada sede ---------------- */

/**
 * Cómo está un producto en una sede, de lo más urgente a lo que está bien:
 * se usó sin haber, tiene lotes vencidos, está bajo el mínimo, no hay nada
 * (con mínimo), vence en 30 días u ok.
 */
export const PRODUCT_STATES = ["faltante", "vencido", "hace_falta", "no_hay", "por_vencer", "ok"] as const
export type ProductState = (typeof PRODUCT_STATES)[number]

/** Los dos filtros de Productos: «Hacen falta» y «Por vencer». */
export const PRODUCT_NEEDS = ["hacen_falta", "por_vencer"] as const
export type ProductNeed = (typeof PRODUCT_NEEDS)[number]

export interface SedeProductStatus {
  /** Lo que hay: lotes − faltante, en la unidad de uso (negativo si se usó sin haber). */
  onHand: number
  /** Lo usado o vendido sin haber. */
  shortage: number
  /** Mínimo de la sede (0 sin fila). */
  minQuantity: number
  /** Para llegar al mínimo, en la unidad de uso. */
  missing: number
  /** Lotes vencidos con saldo: cuánto y el primer día en que venció uno. */
  expired: { quantity: number; firstDate: string } | null
  /** Lo que vence en 30 días: cuánto en total, el primer día y cuánto vence ese día. */
  expiring: { quantity: number; date: string; firstQuantity: number } | null
  state: ProductState
  /** Cuenta en «Hacen falta»: se usó sin haber o está bajo el mínimo. */
  needs: boolean
  /** Cuenta en «Por vencer»: tiene lotes vencidos o que vencen en 30 días. */
  expires: boolean
}

function statusOf(input: {
  lots: number
  shortage: number
  minQuantity: number
  isActive: boolean
  expired: SedeProductStatus["expired"]
  expiring: SedeProductStatus["expiring"]
}): SedeProductStatus {
  const onHand = input.lots - input.shortage
  // Un producto desactivado ya no se pide: no tiene mínimo que cumplir.
  const min = input.isActive ? input.minQuantity : 0
  const below = min > 0 && onHand < min
  const state: ProductState =
    input.shortage > 0
      ? "faltante"
      : input.expired
        ? "vencido"
        : min > 0 && onHand <= 0
          ? "no_hay"
          : below
            ? "hace_falta"
            : input.expiring
              ? "por_vencer"
              : "ok"
  return {
    onHand,
    shortage: input.shortage,
    minQuantity: input.minQuantity,
    missing: below ? min - onHand : 0,
    expired: input.expired,
    expiring: input.expiring,
    state,
    needs: input.isActive && (input.shortage > 0 || below),
    expires: Boolean(input.expired || input.expiring),
  }
}

const STATE_RANK: Record<ProductState, number> = Object.fromEntries(PRODUCT_STATES.map((state, index) => [state, index])) as Record<
  ProductState,
  number
>

const key = (branchId: string, productId: string) => `${branchId}:${productId}`

/**
 * Lo que hay de cada producto en cada sede pedida, con su mínimo, su faltante
 * y lo que vence. Solo vienen los pares con algo (lotes, faltante, mínimo):
 * los demás valen cero.
 */
async function sedeFigures(tx: Db, orgId: string, branchIds: string[], today: string, horizon: string) {
  const sedes = sql.join(branchIds.map((id) => sql`${id}::uuid`), sql`, `)
  const lots = await tx.execute<{ branchId: string; productId: string; lots: string; expired: string; expiredFirst: string | null }>(sql`
    select w.branch_id as "branchId", l.product_id as "productId", sum(l.quantity_on_hand)::text as lots,
      coalesce(sum(l.quantity_on_hand) filter (where l.expires_at < ${today}::date), 0)::text as expired,
      (min(l.expires_at) filter (where l.expires_at < ${today}::date))::text as "expiredFirst"
    from product_lot l join warehouse w on w.organization_id = l.organization_id and w.id = l.warehouse_id
    where l.organization_id = ${orgId} and l.quantity_on_hand > 0 and w.branch_id in (${sedes})
    group by w.branch_id, l.product_id`)
  const dated = await tx.execute<{ branchId: string; productId: string; date: string; quantity: string }>(sql`
    select w.branch_id as "branchId", l.product_id as "productId", l.expires_at::text as date, sum(l.quantity_on_hand)::text as quantity
    from product_lot l join warehouse w on w.organization_id = l.organization_id and w.id = l.warehouse_id
    where l.organization_id = ${orgId} and l.quantity_on_hand > 0 and w.branch_id in (${sedes})
      and l.expires_at >= ${today}::date and l.expires_at <= ${horizon}::date
    group by w.branch_id, l.product_id, l.expires_at
    order by l.expires_at`)
  const shortages = await tx.execute<{ branchId: string; productId: string; quantity: string }>(sql`
    select w.branch_id as "branchId", s.product_id as "productId", sum(s.quantity)::text as quantity
    from stock_shortage s join warehouse w on w.organization_id = s.organization_id and w.id = s.warehouse_id
    where s.organization_id = ${orgId} and s.quantity > 0 and w.branch_id in (${sedes})
    group by w.branch_id, s.product_id`)
  const minimums = await tx.execute<{ branchId: string; productId: string; minQuantity: number }>(sql`
    select branch_id as "branchId", product_id as "productId", min_quantity as "minQuantity"
    from product_minimum where organization_id = ${orgId} and branch_id in (${sedes})`)
  type Figures = {
    lots: number
    shortage: number
    minQuantity: number
    expired: SedeProductStatus["expired"]
    expiring: SedeProductStatus["expiring"]
  }
  const figures = new Map<string, Figures>()
  const at = (branchId: string, productId: string): Figures => {
    const id = key(branchId, productId)
    let found = figures.get(id)
    if (!found) {
      found = { lots: 0, shortage: 0, minQuantity: 0, expired: null, expiring: null }
      figures.set(id, found)
    }
    return found
  }
  for (const row of lots) {
    const entry = at(row.branchId, row.productId)
    entry.lots = Number(row.lots)
    const expired = Number(row.expired)
    if (expired > 0 && row.expiredFirst) entry.expired = { quantity: expired, firstDate: row.expiredFirst }
  }
  for (const row of dated) {
    const entry = at(row.branchId, row.productId)
    const amount = Number(row.quantity)
    if (!entry.expiring) entry.expiring = { quantity: amount, date: row.date, firstQuantity: amount }
    else entry.expiring.quantity += amount
  }
  for (const row of shortages) at(row.branchId, row.productId).shortage = Number(row.quantity)
  for (const row of minimums) at(row.branchId, row.productId).minQuantity = row.minQuantity
  return (branchId: string, item: { id: string; isActive: boolean }): SedeProductStatus => {
    const found = figures.get(key(branchId, item.id))
    return statusOf({
      lots: found?.lots ?? 0,
      shortage: found?.shortage ?? 0,
      minQuantity: found?.minQuantity ?? 0,
      isActive: item.isActive,
      expired: found?.expired ?? null,
      expiring: found?.expiring ?? null,
    })
  }
}

async function todayOf(tx: Db, orgId: string, now: Date) {
  const { timezone, locale } = await findOrgLocale(tx, orgId)
  const today = localToday(timezone, now)
  return { timezone, locale, today, horizon: addDays(today, INVENTORY_EXPIRY_DAYS) }
}

/** Los campos de un producto que se leen siempre; el precio de venta, solo con precios. */
function productFields(row: ProductRow, prices: boolean) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    usedInCare: row.usedInCare,
    forSale: row.forSale,
    unit: row.unit,
    unitCode: row.unitCode,
    purchaseUnit: row.purchaseUnit,
    purchaseUnitCode: row.purchaseUnitCode,
    purchaseFactor: row.purchaseFactor,
    unitReview: row.unitReview,
    isActive: row.isActive,
    ...(prices ? { salePriceCents: row.salePriceCents, saleCurrency: row.saleCurrency } : {}),
  }
}

export type ProductListItem = ReturnType<typeof productFields> & SedeProductStatus

export interface ProductList {
  branch: { id: string; name: string }
  /** El día de la clínica con que se midió lo vencido. */
  today: string
  items: ProductListItem[]
  /** Con la búsqueda y sin el filtro: «Todos», «Hacen falta» y «Por vencer». */
  counts: { todos: number; hacen_falta: number; por_vencer: number }
}

/**
 * Productos de una sede: lo que hay, su mínimo, lo que falta y lo que vence,
 * ordenados por urgencia y después por nombre. Los desactivados salen solo
 * mientras les quede algo en la sede.
 */
export async function listProducts(
  tx: Db,
  orgId: string,
  options: { branchId?: string | null; q?: string; need?: ProductNeed; prices?: boolean; now?: Date } = {},
): Promise<ProductList> {
  if (options.need && !(PRODUCT_NEEDS as readonly string[]).includes(options.need))
    throw validation("El filtro de productos no es válido")
  const sede = await sedeOf(tx, orgId, options.branchId)
  const { today, horizon } = await todayOf(tx, orgId, options.now ?? new Date())
  const conditions = [eq(product.organizationId, orgId)]
  const q = options.q?.trim()
  if (q) conditions.push(foldedWordsMatch([product.name, product.sku], q))
  const rows = await tx.select().from(product).where(and(...conditions)).limit(5000)
  const statusAt = await sedeFigures(tx, orgId, [sede.id], today, horizon)
  const items = rows
    .map((row) => ({ ...productFields(row, options.prices === true), ...statusAt(sede.id, row) }))
    .filter((item) => item.isActive || item.onHand !== 0 || item.shortage > 0 || item.expired !== null)
    .sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || byName(a, b))
  const counts = {
    todos: items.length,
    hacen_falta: items.filter((item) => item.needs).length,
    por_vencer: items.filter((item) => item.expires).length,
  }
  const shown =
    options.need === "hacen_falta"
      ? items.filter((item) => item.needs)
      : options.need === "por_vencer"
        ? items.filter((item) => item.expires)
        : items
  return { branch: sede, today, items: shown, counts }
}

/**
 * Lo usado de cada producto desde `since`: lo que salió en atenciones, ventas
 * y usos, menos lo devuelto, y las correcciones de una atención.
 */
async function usedSince(tx: Db, orgId: string, options: { branchId?: string | null; productIds: string[]; since: Date }) {
  if (options.productIds.length === 0) return new Map<string, number>()
  const rows = await tx.execute<{ productId: string; used: string }>(sql`
    select m.product_id as "productId", coalesce(sum(-m.quantity_delta), 0)::text as used
    from stock_movement m
    join warehouse w on w.organization_id = m.organization_id and w.id = m.warehouse_id
    where m.organization_id = ${orgId} and m.created_at >= ${options.since.toISOString()}::timestamptz
      and (m.kind in ('consumo', 'venta', 'devolucion') or (m.kind = 'ajuste' and m.encounter_id is not null))
      and m.product_id in (${sql.join(options.productIds.map((id) => sql`${id}::uuid`), sql`, `)})
      ${options.branchId ? sql`and w.branch_id = ${options.branchId}` : sql``}
    group by m.product_id`)
  return new Map(rows.map((row) => [row.productId, Math.max(0, Number(row.used))]))
}

const DAY_MS = 86_400_000

/** La última compra recibida de cada producto: proveedor, número, cuándo llegó, cuánto y a qué precio. */
async function lastPurchases(tx: Db, orgId: string, productIds: string[]) {
  if (productIds.length === 0) return new Map<string, LastPurchaseRow>()
  const rows = await tx.execute<LastPurchaseRow>(sql`
    select distinct on (pl.product_id)
      pl.product_id as "productId", o.id as "orderId", o.order_number as "orderNumber", o.currency,
      s.id as "supplierId", s.name as "supplierName", s.is_active as "supplierActive",
      pl.received_quantity as "quantity", pl.purchase_unit as "purchaseUnit", pl.unit_factor as "unitFactor",
      pl.unit_cost_cents as "unitCostCents", ${iso(sql`coalesce(r.last_at, o.created_at)`)} as "at"
    from purchase_order_line pl
    join purchase_order o on o.organization_id = pl.organization_id and o.id = pl.order_id
    join supplier s on s.organization_id = o.organization_id and s.id = o.supplier_id
    left join lateral (
      select max(m.created_at) as last_at from stock_movement m
      where m.organization_id = pl.organization_id and m.purchase_order_id = o.id and m.product_id = pl.product_id and m.kind = 'ingreso'
    ) r on true
    where pl.organization_id = ${orgId} and pl.received_quantity > 0
      and pl.product_id in (${sql.join(productIds.map((id) => sql`${id}::uuid`), sql`, `)})
    order by pl.product_id, coalesce(r.last_at, o.created_at) desc, o.order_number desc`)
  return new Map(rows.map((row) => [row.productId, { ...row, orderNumber: Number(row.orderNumber) }]))
}

type LastPurchaseRow = {
  productId: string
  orderId: string
  orderNumber: number
  currency: string
  supplierId: string
  supplierName: string
  supplierActive: boolean
  quantity: number
  purchaseUnit: string | null
  unitFactor: number
  unitCostCents: number
  at: string
}

/** La última compra para la pantalla: el precio, solo con precios. */
function lastPurchaseView(row: LastPurchaseRow | undefined, prices: boolean) {
  if (!row) return null
  return {
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    label: purchaseOrderLabel(row.orderNumber),
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    supplierActive: row.supplierActive,
    at: row.at,
    /** En unidades de compra de esa línea. */
    quantity: row.quantity,
    purchaseUnit: row.purchaseUnit,
    unitFactor: row.unitFactor,
    ...(prices ? { unitCostCents: row.unitCostCents, currency: row.currency } : {}),
  }
}

/**
 * Un producto al lado de la lista: cómo está en cada sede, sus lotes y
 * últimos movimientos en la sede elegida, la última compra, lo usado en 30
 * días y los servicios que lo usan. Los precios, solo con `prices`.
 */
export async function getProductDetail(
  tx: Db,
  orgId: string,
  id: string,
  options: { branchId?: string | null; prices?: boolean; now?: Date } = {},
) {
  const item = await requireProduct(tx, orgId, id)
  const prices = options.prices === true
  const now = options.now ?? new Date()
  const sede = await sedeOf(tx, orgId, options.branchId)
  const { today, horizon } = await todayOf(tx, orgId, now)
  const branches = await tx
    .select({ id: branch.id, name: branch.name, isActive: branch.isActive })
    .from(branch)
    .where(eq(branch.organizationId, orgId))
    .orderBy(asc(branch.createdAt), asc(branch.id))
  const statusAt = await sedeFigures(tx, orgId, branches.map((row) => row.id), today, horizon)
  const bySede = branches
    .map((row) => ({ branchId: row.id, branchName: row.name, branchActive: row.isActive, ...statusAt(row.id, item) }))
    .filter((row) => row.branchActive || row.onHand !== 0 || row.shortage > 0)
  const here = statusAt(sede.id, item)
  const lots = await tx.execute<{
    id: string
    code: string
    warehouseId: string
    warehouseName: string
    warehouseIsDefault: boolean
    expiresAt: string | null
    quantityOnHand: number
    purchaseOrderId: string | null
    purchaseOrderNumber: number | null
    supplierName: string | null
    createdAt: string
  }>(sql`
    select l.id, l.code, l.warehouse_id as "warehouseId", w.name as "warehouseName", w.is_default as "warehouseIsDefault",
      l.expires_at::text as "expiresAt", l.quantity_on_hand as "quantityOnHand",
      l.purchase_order_id as "purchaseOrderId", o.order_number as "purchaseOrderNumber", s.name as "supplierName",
      ${iso(sql`l.created_at`)} as "createdAt"
    from product_lot l
    join warehouse w on w.organization_id = l.organization_id and w.id = l.warehouse_id
    left join purchase_order o on o.organization_id = l.organization_id and o.id = l.purchase_order_id
    left join supplier s on s.organization_id = l.organization_id and s.id = l.supplier_id
    where l.organization_id = ${orgId} and l.product_id = ${id} and w.branch_id = ${sede.id} and l.quantity_on_hand > 0
    order by l.expires_at asc nulls last, l.created_at, l.id`)
  const movements = await listMovements(tx, orgId, { productId: id, branchId: sede.id, limit: 10 })
  const last = (await lastPurchases(tx, orgId, [id])).get(id)
  const used = (await usedSince(tx, orgId, { branchId: sede.id, productIds: [id], since: new Date(now.getTime() - 30 * DAY_MS) })).get(id) ?? 0
  const services = await tx.execute<{ serviceId: string; serviceName: string; quantity: number }>(sql`
    select sm.service_id as "serviceId", sc.name as "serviceName", sm.quantity
    from service_material sm
    join service_catalog sc on sc.organization_id = sm.organization_id and sc.id = sm.service_id
    where sm.organization_id = ${orgId} and sm.product_id = ${id}
    order by sc.name`)
  return {
    ...productFields(item, prices),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    /** Con movimientos o compras, la unidad de uso ya no cambia. */
    hasHistory: await productHasHistory(tx, orgId, id),
    minimums: await minimumsOf(tx, orgId, id),
    branch: sede,
    today,
    ...here,
    /** Cómo está en cada sede (las desactivadas, solo si les queda algo). */
    branches: bySede,
    /** Lotes con saldo en la sede elegida, del que vence primero al último. Código vacío = «Sin código». */
    lots: lots.map((lot) => ({
      ...lot,
      purchaseOrderNumber: lot.purchaseOrderNumber == null ? null : Number(lot.purchaseOrderNumber),
      purchaseOrderLabel: lot.purchaseOrderNumber == null ? null : purchaseOrderLabel(Number(lot.purchaseOrderNumber)),
      expired: lot.expiresAt !== null && lot.expiresAt < today,
      expiring: lot.expiresAt !== null && lot.expiresAt >= today && lot.expiresAt <= horizon,
    })),
    /** Los últimos 10 movimientos en la sede elegida. */
    movements: movements.items,
    movementsTotal: movements.total,
    lastPurchase: lastPurchaseView(last, prices),
    /** Usado en la sede elegida en los últimos 30 días, en la unidad de uso. */
    usedLast30Days: used,
    /** Servicios que lo usan cada vez que se hacen. */
    services,
  }
}

/* ---------------- pegar tu lista ---------------- */

export const IMPORT_MAX_ROWS = 500

export interface ImportRowInput {
  name?: string | null
  /** «caja de 100», «cartucho»… */
  unit?: string | null
  /** «Hay»: obligatorio. Llega tal cual se pegó. */
  onHand?: string | number | null
  minQuantity?: string | number | null
  /** El número de la fila en la hoja pegada (desde 1), para nombrarla en los mensajes. */
  line?: number | null
}

export type ImportRowStatus = "nuevo" | "existe" | "parecido" | "invalido"

export interface ImportPreviewRow {
  index: number
  name: string
  status: ImportRowStatus
  /** Por qué no es válida, en palabras. */
  reason: string | null
  unit: string
  unitCode: string | null
  purchaseUnit: string | null
  purchaseUnitCode: string | null
  purchaseFactor: number
  /** La unidad no se entendió: el producto queda «Por revisar», sin frenar el resto. */
  unitReview: boolean
  /** Lo que hay y el mínimo, ya en la unidad de uso. */
  onHand: number | null
  minQuantity: number | null
  /** `existe`: el producto con ese nombre. */
  productId: string | null
  /** `parecido`: el producto que se le parece. */
  similarTo: { id: string; name: string } | null
}

/** Un número entero escrito en una hoja: «1,100», «1.100» o «1100»; null si está vacío; NaN si no se lee. */
function wholeFromSheet(value: string | number | null | undefined): number | null {
  if (value == null) return null
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : Number.NaN
  const text = value.trim().replace(/\s+/g, "")
  if (!text || text === "-" || text === "—") return null
  const plain = /^\d{1,3}([.,]\d{3})+$/.test(text) ? text.replace(/[.,]/g, "") : text
  if (!/^\d{1,10}$/.test(plain)) return Number.NaN
  const parsed = Number(plain)
  return parsed <= 1_000_000_000 ? parsed : Number.NaN
}

/**
 * La unidad escrita en la hoja. «caja de 100» o «caja x 50 cartuchos» se leen
 * como unidad de compra con su factor (los números de esa fila van en cajas);
 * una palabra sola es la unidad de uso. Lo que no se entiende queda «Por
 * revisar» con el texto tal cual, como la unidad de antes (migración 0038).
 */
function unitFromSheet(text: string | null | undefined) {
  const plain = { unit: "unidad", unitCode: "C62", purchaseUnit: null, purchaseUnitCode: null, purchaseFactor: 1, unitReview: false }
  const value = text?.trim().toLowerCase() ?? ""
  if (!value) return plain
  const packed = /^([a-záéíóúüñ]+)\s*(?:x|de|por)\s*(\d{1,6})\s*([a-záéíóúüñ ]*)$/.exec(value)
  if (packed) {
    const factor = Number(packed[2])
    const purchase = singularUnit(packed[1] ?? "")
    const rest = (packed[3] ?? "").trim().split(/\s+/)[0] ?? ""
    const use = rest ? singularUnit(rest) : "unidad"
    if (factor >= 2 && factor <= 100_000 && purchase !== use)
      return {
        unit: use,
        unitCode: findInventoryUnit(use)?.code ?? null,
        purchaseUnit: purchase,
        purchaseUnitCode: findInventoryUnit(purchase)?.code ?? null,
        purchaseFactor: factor,
        unitReview: false,
      }
  }
  if (/^[a-záéíóúüñ]+$/.test(value)) {
    const use = singularUnit(value)
    return { ...plain, unit: use, unitCode: findInventoryUnit(use)?.code ?? null }
  }
  return { ...plain, unit: value.slice(0, 60), unitCode: null, unitReview: true }
}

const NAME_SKIP = new Set(["de", "del", "la", "las", "el", "los", "con", "y", "para", "por", "en", "a", "al", "c", "x"])

function nameTokens(name: string): string[] {
  return fold(name)
    .split(/[^a-z0-9%]+/)
    .filter((word) => word && !NAME_SKIP.has(word))
}

/** Pares de letras de un texto, para medir cuánto se parecen dos nombres (coeficiente de Dice). */
function bigrams(text: string): Map<string, number> {
  const compact = text.replace(/\s+/g, " ")
  const out = new Map<string, number>()
  for (let i = 0; i < compact.length - 1; i++) {
    const pair = compact.slice(i, i + 2)
    out.set(pair, (out.get(pair) ?? 0) + 1)
  }
  return out
}

function similarity(a: string, b: string): number {
  const left = bigrams(a)
  const right = bigrams(b)
  let shared = 0
  let total = 0
  for (const count of left.values()) total += count
  for (const count of right.values()) total += count
  for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0)
  return total === 0 ? 0 : (2 * shared) / total
}

/** ¿Se parece a otro nombre? Las mismas palabras importantes, una contenida en la otra o casi las mismas letras. */
function looksLike(name: string, other: string): boolean {
  const mine = nameTokens(name)
  const theirs = nameTokens(other)
  if (mine.length === 0 || theirs.length === 0) return false
  const a = new Set(mine)
  const b = new Set(theirs)
  const contained = [...a].every((word) => b.has(word)) || [...b].every((word) => a.has(word))
  return contained || similarity(mine.join(" "), theirs.join(" ")) >= 0.75
}

interface CatalogEntry {
  id: string
  name: string
  folded: string
}

/** Revisa una fila pegada: lo que se lee de ella y si es nueva, ya existe, se parece a otra o no sirve. */
function reviewRow(row: ImportRowInput, index: number, catalog: CatalogEntry[], seen: Map<string, number>): ImportPreviewRow {
  const name = row.name?.trim() ?? ""
  const unit = unitFromSheet(row.unit)
  const base = { index, name, ...unit, onHand: null, minQuantity: null, productId: null, similarTo: null }
  const invalid = (reason: string): ImportPreviewRow => ({ ...base, status: "invalido", reason })
  if (!name) return invalid("Falta el nombre")
  if (name.length > 200) return invalid("El nombre admite hasta 200 caracteres")
  const folded = fold(name)
  const repeated = seen.get(folded)
  if (repeated !== undefined) return invalid(`Está repetido en la lista (fila ${repeated})`)
  seen.set(folded, row.line ?? index + 1)
  const onHand = wholeFromSheet(row.onHand)
  if (onHand === null) return invalid("Falta lo que hay")
  if (Number.isNaN(onHand)) return invalid("«Hay» no es un número entero desde 0")
  const min = wholeFromSheet(row.minQuantity)
  if (min !== null && Number.isNaN(min)) return invalid("«Mínimo» no es un número entero desde 0")
  const factor = unit.purchaseFactor
  const read = { ...base, onHand: onHand * factor, minQuantity: min === null ? null : min * factor, reason: null }
  if (read.onHand > 1_000_000_000 || (read.minQuantity ?? 0) > 1_000_000_000) return invalid("El número es demasiado grande")
  const same = catalog.find((entry) => entry.folded === folded)
  if (same) return { ...read, status: "existe", productId: same.id }
  const like = catalog.find((entry) => looksLike(name, entry.name))
  if (like) return { ...read, status: "parecido", similarTo: { id: like.id, name: like.name } }
  return { ...read, status: "nuevo" }
}

async function catalogOf(tx: Db, orgId: string): Promise<CatalogEntry[]> {
  const rows = await tx
    .select({ id: product.id, name: product.name, isActive: product.isActive })
    .from(product)
    .where(eq(product.organizationId, orgId))
    .orderBy(sql`${product.isActive} desc`, asc(product.name))
  return rows.map((row) => ({ id: row.id, name: row.name, folded: fold(row.name) }))
}

function checkImportSize(rows: unknown[]) {
  if (!Array.isArray(rows) || rows.length === 0) throw validation("Pega al menos una fila")
  if (rows.length > IMPORT_MAX_ROWS) throw validation(`Se pegan hasta ${IMPORT_MAX_ROWS} filas por vez: divide la lista`)
}

/**
 * «Pegar tu lista»: lo que se leyó de cada fila y qué pasará con ella, sin
 * guardar nada. `existe` si el nombre coincide sin tildes ni mayúsculas;
 * `parecido` si se parece a uno que ya está (la pantalla pregunta si es el
 * mismo); `invalido` con su motivo.
 */
export async function previewProductImport(tx: Db, orgId: string, branchId: string, rows: ImportRowInput[]) {
  checkImportSize(rows)
  const sede = await requireBranch(tx, orgId, branchId)
  const catalog = await catalogOf(tx, orgId)
  const seen = new Map<string, number>()
  const reviewed = rows.map((row, index) => reviewRow(row, index, catalog, seen))
  const counts = { nuevo: 0, existe: 0, parecido: 0, invalido: 0 }
  for (const row of reviewed) counts[row.status] += 1
  return { branch: sede, rows: reviewed, counts }
}

export type ImportRow = ImportRowInput & {
  /** El producto que ya existe (lo eligió la pantalla para una fila «existe» o «parecido»). */
  productId?: string | null
}

/**
 * Agrega la lista: lo nuevo se crea y lo que hay entra como «Inventario
 * inicial» al almacén principal de la sede, en un lote sin código; con
 * `productId` (o un nombre que ya existe) se pone lo que hay con un conteo.
 * Aplica los mínimos de la sede. Reintentar con la misma clave no duplica:
 * lo creado se reconoce por su nombre y cada fila conserva su clave.
 */
export async function importProducts(
  tx: Db,
  orgId: string,
  actorUserId: string,
  branchId: string,
  rows: ImportRow[],
  idempotencyKey: string,
) {
  const importKey = formKey(idempotencyKey, RETRY_KEY)
  checkImportSize(rows)
  const sede = await requireBranch(tx, orgId, branchId)
  const main = await defaultWarehouse(tx, orgId, sede.id)
  const catalog = await catalogOf(tx, orgId)
  const seen = new Map<string, number>()
  const reviewed = rows.map((row, index) => {
    const result = reviewRow(row, index, catalog, seen)
    // La fila se nombra como está en la hoja pegada, no por su lugar entre las enviadas.
    if (result.status === "invalido") {
      const reason = result.reason ?? "No sirve"
      throw validation(`Fila ${row.line ?? index + 1}: ${reason}`, { [`rows[${index}]`]: reason })
    }
    return result
  })
  const items: Array<{ index: number; productId: string; name: string; status: "creado" | "actualizado" | "sin_cambio" }> = []
  for (const [index, row] of reviewed.entries()) {
    const chosen = rows[index]?.productId ?? null
    const keyPrefix = `lista:${importKey}:${index}`
    const minimums = row.minQuantity === null ? [] : [{ branchId: sede.id, minQuantity: row.minQuantity }]
    const existing = chosen
      ? await requireProduct(tx, orgId, chosen)
      : row.productId
        ? await requireProduct(tx, orgId, row.productId)
        : null
    if (existing) {
      const result = await setSedeStock(tx, orgId, {
        productId: existing.id,
        branchId: sede.id,
        counted: row.onHand ?? 0,
        base: { kind: "ajuste", reason: "Inventario inicial", actorUserId, keyPrefix },
      })
      if (minimums.length) await setMinimums(tx, orgId, existing.id, minimums)
      items.push({ index, productId: existing.id, name: existing.name, status: result.delta !== 0 ? "actualizado" : "sin_cambio" })
      continue
    }
    const created = await createProduct(tx, orgId, actorUserId, {
      name: row.name,
      unit: row.unit,
      purchaseUnit: row.purchaseUnit,
      purchaseFactor: row.purchaseFactor,
      unitReview: row.unitReview,
      minimums,
    })
    // El que sigue en la lista con el mismo nombre ya lo encuentra.
    catalog.push({ id: created.id, name: created.name, folded: fold(created.name) })
    if ((row.onHand ?? 0) > 0) {
      const lot = await lotFor(tx, orgId, { productId: created.id, warehouseId: main.id, code: NO_LOT_CODE, actorUserId })
      await receiveIntoLot(tx, orgId, {
        lot,
        quantity: row.onHand ?? 0,
        base: { kind: "ingreso", reason: "Inventario inicial", actorUserId, keyPrefix },
      })
    }
    items.push({ index, productId: created.id, name: created.name, status: "creado" })
  }
  await audit(tx, orgId, actorUserId, "stock", sede.id, "product.imported")
  return {
    branch: sede,
    created: items.filter((item) => item.status === "creado").length,
    updated: items.filter((item) => item.status === "actualizado").length,
    unchanged: items.filter((item) => item.status === "sin_cambio").length,
    items,
  }
}

/* ---------------- contar y dar de baja ---------------- */

/**
 * «Contar»: se escribe lo que hay de cada producto en la sede y odentIA
 * ajusta la diferencia con el motivo «Conteo» (lo que falta sale del lote que
 * vence primero; lo que sobra baja primero el faltante y después entra al
 * lote más nuevo). Lo que no se cuenta no cambia. Devuelve lo que cambió.
 */
export async function countStock(
  tx: Db,
  orgId: string,
  actorUserId: string,
  branchId: string,
  items: Array<{ productId: string; counted: number }>,
  idempotencyKey: string,
) {
  const countKey = formKey(idempotencyKey, RETRY_KEY)
  if (!Array.isArray(items) || items.length === 0) throw validation("Escribe lo que hay de al menos un producto")
  if (items.length > 2000) throw validation("Se cuentan hasta 2000 productos por vez")
  const sede = await requireBranch(tx, orgId, branchId)
  const seen = new Set<string>()
  for (const [index, item] of items.entries()) {
    if (seen.has(item.productId)) throw invalidField(`items[${index}].productId`, "Un producto va una sola vez en el conteo")
    seen.add(item.productId)
    counted(item.counted, "Lo que hay", `items[${index}].counted`)
  }
  const ids = [...seen]
  const products = await tx
    .select({ id: product.id, name: product.name, unit: product.unit })
    .from(product)
    .where(and(eq(product.organizationId, orgId), inArray(product.id, ids)))
  const byId = new Map(products.map((row) => [row.id, row]))
  const missing = items.findIndex((item) => !byId.has(item.productId))
  if (missing >= 0)
    throw new ServiceError("NOT_FOUND", 404, "Producto no encontrado", { [`items[${missing}].productId`]: "Este producto ya no está en el inventario" })
  const before = await stockBySede(tx, orgId, { branchId: sede.id, productIds: ids })
  const changed: Array<{ productId: string; name: string; unit: string; before: number; after: number; delta: number }> = []
  let fresh = false
  for (const item of items) {
    const info = byId.get(item.productId)
    if (!info) continue
    const had = before.get(item.productId)?.onHand ?? 0
    const result = await setSedeStock(tx, orgId, {
      productId: item.productId,
      branchId: sede.id,
      counted: item.counted,
      base: { kind: "ajuste", reason: `Conteo: había ${had}, hay ${item.counted}`, actorUserId, keyPrefix: `conteo:${countKey}:${item.productId}` },
    })
    if (!result.replayed) fresh = true
    if (result.delta !== 0)
      changed.push({ productId: item.productId, name: info.name, unit: info.unit, before: result.before, after: result.after, delta: result.delta })
  }
  if (fresh && changed.length > 0) await audit(tx, orgId, actorUserId, "stock", sede.id, "stock.conteo")
  return { branch: sede, counted: items.length, changed, unchanged: items.length - changed.length }
}

/**
 * «Dar de baja» lo vencido de un producto en una sede, sin formulario: cada
 * lote vencido con saldo queda en 0 con el motivo «Venció». Los vencidos son
 * los que vencen primero, así que salen del lote que vence primero.
 */
export async function writeOffExpired(
  tx: Db,
  orgId: string,
  actorUserId: string,
  productId: string,
  branchId: string,
  idempotencyKey: string,
  now = new Date(),
) {
  const writeKey = formKey(idempotencyKey, RETRY_KEY)
  const item = await requireProduct(tx, orgId, productId)
  const sede = await sedeOf(tx, orgId, branchId)
  const prefix = `baja:${writeKey}`
  const lotsOf = async (rows: MovementRow[]) => {
    const ids = [...new Set(rows.map((row) => row.lotId).filter((id): id is string => id !== null))]
    const codes = ids.length
      ? await tx
          .select({ id: productLot.id, code: productLot.code, expiresAt: productLot.expiresAt })
          .from(productLot)
          .where(and(eq(productLot.organizationId, orgId), inArray(productLot.id, ids)))
      : []
    const byLot = new Map(codes.map((row) => [row.id, row]))
    return rows
      .filter((row) => row.lotId !== null)
      .map((row) => ({
        lotId: row.lotId as string,
        code: byLot.get(row.lotId as string)?.code ?? "",
        expiresAt: byLot.get(row.lotId as string)?.expiresAt ?? null,
        quantity: -row.quantityDelta,
      }))
  }
  const prior = await movementsWithPrefix(tx, orgId, prefix)
  if (prior.length > 0) {
    if (prior.some((row) => row.productId !== productId))
      throw conflict("Esto ya se registró con otros datos. Cierra y vuelve a abrir para registrarlo de nuevo.")
    const lots = await lotsOf(prior)
    return { productId, branch: sede, quantity: lots.reduce((sum, lot) => sum + lot.quantity, 0), lots, replayed: true }
  }
  const { today } = await todayOf(tx, orgId, now)
  const written: MovementRow[] = []
  for (const warehouseId of await sedeWarehouseIds(tx, orgId, sede.id)) {
    const lots = await fefoLots(tx, orgId, productId, warehouseId)
    const expired = lots.filter((lot) => lot.expiresAt !== null && lot.expiresAt < today).reduce((sum, lot) => sum + lot.quantityOnHand, 0)
    if (expired === 0) continue
    const result = await consumeFefo(tx, orgId, {
      productId,
      warehouseId,
      quantity: expired,
      allowShortage: false,
      base: { kind: "ajuste", reason: "Venció", actorUserId, keyPrefix: `${prefix}:${warehouseId}` },
    })
    written.push(...result.movements)
  }
  if (written.length === 0) throw conflict(`No hay lotes vencidos de ${item.name} en ${sede.name}.`)
  await audit(tx, orgId, actorUserId, "stock", productId, "stock.baja")
  const lots = await lotsOf(written)
  return { productId, branch: sede, quantity: lots.reduce((sum, lot) => sum + lot.quantity, 0), lots, replayed: false }
}

/* ---------------- movimientos sueltos ---------------- */

/** Por qué se ajusta un lote: una lista corta, «Otro» con su texto. */
export const ADJUST_REASONS = { conteo: "Conteo", se_dano: "Se dañó", vencio: "Venció", otro: "Otro" } as const
export type AdjustReason = keyof typeof ADJUST_REASONS

/** Por qué entra algo sin compra. */
export const ADD_REASONS = { muestra: "Muestra o regalo", otro: "Otro" } as const
export type AddReason = keyof typeof ADD_REASONS

function reasonText<T extends string>(words: Record<T, string>, reason: T, note: string | null | undefined): string {
  if (!(reason in words)) throw invalidField("reason", "Elige el motivo")
  const detail = textOptional(note, "El detalle", 500, "note")
  if (reason === "otro") {
    if (!detail) throw invalidField("note", "Escribe el motivo")
    return `Otro: ${detail}`
  }
  return detail ? `${words[reason]} · ${detail}` : words[reason]
}

/**
 * «Ajustar» un lote en particular: se escribe cuántos hay y el servidor
 * calcula la diferencia, con un motivo de la lista. Para el fin de mes está
 * «Contar», por producto.
 */
export async function adjustLot(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { lotId: string; counted: number; reason: AdjustReason; note?: string | null; idempotencyKey: string },
) {
  const adjustKey = formKey(input.idempotencyKey, RETRY_KEY)
  counted(input.counted, "Cuántos hay", "counted")
  const reason = reasonText(ADJUST_REASONS, input.reason, input.note)
  const result = await setLotQuantity(tx, orgId, {
    lotId: input.lotId,
    counted: input.counted,
    base: { kind: "ajuste", reason, actorUserId, keyPrefix: `ajuste:${adjustKey}` },
  })
  if (!result.replayed && result.delta !== 0) await audit(tx, orgId, actorUserId, "stock", input.lotId, "stock.ajuste")
  return {
    lotId: result.lot.id,
    productId: result.lot.productId,
    before: result.before,
    after: result.after,
    delta: result.delta,
    movement: result.movements[0] ?? null,
    replayed: result.replayed,
  }
}

/** La atención en borrador de hoy del paciente (en el día de la clínica), si tiene una. */
async function openEncounterToday(tx: Db, orgId: string, patientId: string, timezone: string, today: string): Promise<string | null> {
  const [row] = await tx.execute<{ id: string }>(sql`
    select id from encounter
    where organization_id = ${orgId} and patient_id = ${patientId} and status = 'borrador' and voided_at is null
      and started_at >= (${today}::date::timestamp at time zone ${timezone})
      and started_at < ((${today}::date + 1)::timestamp at time zone ${timezone})
    order by started_at desc limit 1`)
  return row?.id ?? null
}

/**
 * Lo que hay en los lotes de cada almacén de una sede, el principal primero.
 * Con `usableOn` (el día de la clínica) no cuenta lo vencido: no se usa ni se traslada.
 */
async function sedeLots(tx: Db, orgId: string, branchId: string, productId: string, usableOn?: string | null) {
  const main = await defaultWarehouse(tx, orgId, branchId)
  const ids = await sedeWarehouseIds(tx, orgId, branchId)
  const ordered = [main.id, ...ids.filter((id) => id !== main.id)]
  const out: Array<{ warehouseId: string; available: number }> = []
  for (const warehouseId of ordered) {
    const lots = await fefoLots(tx, orgId, productId, warehouseId, usableOn)
    out.push({ warehouseId, available: lots.reduce((sum, lot) => sum + lot.quantityOnHand, 0) })
  }
  return { main, warehouses: out, available: out.reduce((sum, row) => sum + row.available, 0) }
}

/** El lote elegido, si es del producto y de la sede. */
async function lotInSede(tx: Db, orgId: string, lotId: string, productId: string, branchId: string) {
  const [lot] = await tx.execute<{ id: string; warehouseId: string; productId: string }>(sql`
    select l.id, l.warehouse_id as "warehouseId", l.product_id as "productId" from product_lot l
    join warehouse w on w.organization_id = l.organization_id and w.id = l.warehouse_id
    where l.organization_id = ${orgId} and l.id = ${lotId} and w.branch_id = ${branchId}`)
  if (!lot || lot.productId !== productId)
    throw new ServiceError("NOT_FOUND", 404, "Lote no encontrado", { lotId: "Ese lote ya no está en la sede: elige otro" })
  return lot
}

/** Lo que dejó una operación con prefijo, si ya se hizo: el reintento lo devuelve. */
async function replayOf(tx: Db, orgId: string, prefix: string, productId: string) {
  const prior = await movementsWithPrefix(tx, orgId, prefix)
  if (prior.length === 0) return null
  if (prior.some((row) => row.productId !== productId))
    throw conflict("Esto ya se registró con otros datos. Cierra y vuelve a abrir para registrarlo de nuevo.")
  return prior
}

/**
 * «Registrar uso»: lo que se usó o se regaló fuera de una atención. Sale del
 * lote elegido o del que vence primero, sin faltante (si no alcanza, lo dice).
 * Con paciente, queda unido a él y, si tiene su atención en borrador de hoy,
 * a ella. Lo vendido se descuenta desde «Cobrar».
 */
export async function registerUse(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: {
    productId: string
    branchId: string
    quantity: number
    lotId?: string | null
    patientId?: string | null
    note?: string | null
    idempotencyKey: string
  },
  now = new Date(),
) {
  const useKey = formKey(input.idempotencyKey, RETRY_KEY)
  quantity(input.quantity, "La cantidad", "quantity")
  const item = await requireProduct(tx, orgId, input.productId)
  const prefix = `uso:${useKey}`
  const prior = await replayOf(tx, orgId, prefix, item.id)
  if (prior) {
    const used = prior.reduce((sum, row) => sum - row.quantityDelta, 0)
    if (used !== input.quantity)
      throw conflict("Esto ya se registró con otros datos. Cierra y vuelve a abrir para registrarlo de nuevo.")
    return {
      productId: item.id,
      quantity: used,
      patientId: prior[0]?.patientId ?? null,
      encounterId: prior[0]?.encounterId ?? null,
      movements: prior,
      replayed: true,
    }
  }
  if (!item.isActive) throw conflict("El producto está desactivado", "productId")
  const sede = await requireBranch(tx, orgId, input.branchId)
  const { timezone, locale, today } = await todayOf(tx, orgId, now)
  const reason = textOptional(input.note, "El detalle", 500, "note") ?? "Uso fuera de una atención"
  let patientId: string | null = null
  let encounterId: string | null = null
  if (input.patientId) {
    patientId = (await requireTenantPatient(tx, orgId, input.patientId)).id
    encounterId = await openEncounterToday(tx, orgId, patientId, timezone, today)
  }
  const base = { kind: "consumo" as const, reason, actorUserId, patientId, encounterId }
  const words = unitWordsOf(item, locale)
  const movements: MovementRow[] = []
  if (input.lotId) {
    const lot = await lotInSede(tx, orgId, input.lotId, item.id, sede.id)
    const result = await consumeFefo(tx, orgId, {
      productId: item.id,
      warehouseId: lot.warehouseId,
      lotId: lot.id,
      quantity: input.quantity,
      allowShortage: false,
      usableOn: today,
      unitWords: words,
      base: { ...base, keyPrefix: `${prefix}:0` },
    })
    movements.push(...result.movements)
  } else {
    const stock = await sedeLots(tx, orgId, sede.id, item.id, today)
    if (stock.available < input.quantity) throw conflict(`No alcanza: en ${sede.name} hay ${words(stock.available)}.`, "quantity")
    let left = input.quantity
    for (const [step, row] of stock.warehouses.entries()) {
      if (left === 0) break
      const take = Math.min(left, row.available)
      if (take === 0) continue
      const result = await consumeFefo(tx, orgId, {
        productId: item.id,
        warehouseId: row.warehouseId,
        quantity: take,
        allowShortage: false,
        usableOn: today,
        unitWords: words,
        base: { ...base, keyPrefix: `${prefix}:${step}` },
      })
      movements.push(...result.movements)
      left -= take
    }
  }
  await audit(tx, orgId, actorUserId, "stock", item.id, "stock.uso")
  return { productId: item.id, quantity: input.quantity, patientId, encounterId, movements, replayed: false }
}

/**
 * «Trasladar a otra sede»: sale del lote elegido o de los que vencen primero
 * y llega al almacén principal de la otra sede, en parejas por lote. Lo que
 * llega cubre primero lo que allá se usó sin haber.
 */
export async function transferStock(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: {
    productId: string
    fromBranchId: string
    toBranchId: string
    quantity: number
    lotId?: string | null
    note?: string | null
    idempotencyKey: string
  },
) {
  const transferKey = formKey(input.idempotencyKey, RETRY_KEY)
  quantity(input.quantity, "La cantidad", "quantity")
  const item = await requireProduct(tx, orgId, input.productId)
  const prefix = `traslado:${transferKey}`
  const from = await sedeOf(tx, orgId, input.fromBranchId)
  if (input.fromBranchId === input.toBranchId) throw invalidField("toBranchId", "Elige otra sede de destino")
  const to = await requireBranch(tx, orgId, input.toBranchId)
  const prior = await replayOf(tx, orgId, prefix, item.id)
  if (prior) {
    const moved = prior.filter((row) => row.kind === "traslado" && row.quantityDelta < 0).reduce((sum, row) => sum - row.quantityDelta, 0)
    if (moved !== input.quantity)
      throw conflict("Esto ya se registró con otros datos. Cierra y vuelve a abrir para registrarlo de nuevo.")
    return { productId: item.id, from, to, quantity: moved, covered: 0, movements: prior, replayed: true }
  }
  if (!item.isActive) throw conflict("El producto está desactivado", "productId")
  const { locale } = await findOrgLocale(tx, orgId)
  // Lo vencido no se traslada: se da de baja donde está.
  const today = await clinicToday(tx, orgId)
  const words = unitWordsOf(item, locale)
  const dest = await defaultWarehouse(tx, orgId, to.id)
  const reason = textOptional(input.note, "El detalle", 500, "note") ?? `De ${from.name} a ${to.name}`
  const base = { kind: "traslado" as const, reason, actorUserId }
  const movements: MovementRow[] = []
  let covered = 0
  if (input.lotId) {
    const lot = await lotInSede(tx, orgId, input.lotId, item.id, from.id)
    const result = await transferUnits(tx, orgId, {
      productId: item.id,
      fromWarehouseId: lot.warehouseId,
      toWarehouseId: dest.id,
      lotId: lot.id,
      quantity: input.quantity,
      usableOn: today,
      unitWords: words,
      base: { ...base, keyPrefix: `${prefix}:0` },
    })
    movements.push(...result.movements)
    covered += result.covered
  } else {
    const stock = await sedeLots(tx, orgId, from.id, item.id, today)
    if (stock.available < input.quantity) throw conflict(`No alcanza: en ${from.name} hay ${words(stock.available)}.`, "quantity")
    let left = input.quantity
    for (const [step, row] of stock.warehouses.entries()) {
      if (left === 0) break
      const take = Math.min(left, row.available)
      if (take === 0) continue
      const result = await transferUnits(tx, orgId, {
        productId: item.id,
        fromWarehouseId: row.warehouseId,
        toWarehouseId: dest.id,
        quantity: take,
        usableOn: today,
        unitWords: words,
        base: { ...base, keyPrefix: `${prefix}:${step}` },
      })
      movements.push(...result.movements)
      covered += result.covered
      left -= take
    }
  }
  await audit(tx, orgId, actorUserId, "stock", item.id, "stock.traslado")
  return { productId: item.id, from, to, quantity: input.quantity, covered, movements, replayed: false }
}

/**
 * «Agregar sin compra»: una muestra, un regalo del proveedor o algo que
 * apareció. Entra al almacén principal de la sede en un lote con su código y
 * vencimiento (opcionales) y cubre primero lo que se usó sin haber.
 */
export async function addStock(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: {
    productId: string
    branchId: string
    quantity: number
    lotCode?: string | null
    expiresAt?: string | null
    reason: AddReason
    note?: string | null
    idempotencyKey: string
  },
) {
  const addKey = formKey(input.idempotencyKey, RETRY_KEY)
  quantity(input.quantity, "La cantidad", "quantity")
  const item = await requireProduct(tx, orgId, input.productId)
  const sede = await requireBranch(tx, orgId, input.branchId)
  const reason = reasonText(ADD_REASONS, input.reason, input.note)
  const code = textOptional(input.lotCode, "El código de lote", 120, "lotCode") ?? NO_LOT_CODE
  const expiresAt = dateOnly(input.expiresAt, "El vencimiento", "expiresAt")
  const prefix = `agregado:${addKey}`
  const prior = await replayOf(tx, orgId, prefix, item.id)
  if (!prior && !item.isActive) throw conflict("El producto está desactivado", "productId")
  const main = await defaultWarehouse(tx, orgId, sede.id)
  if (!prior)
    await assertLotExpiry(tx, orgId, { productId: item.id, warehouseId: main.id, code, expiresAt, productName: item.name, path: "lotCode" })
  const lot = await lotFor(tx, orgId, { productId: item.id, warehouseId: main.id, code, expiresAt, actorUserId })
  const result = await receiveIntoLot(tx, orgId, {
    lot,
    quantity: input.quantity,
    base: { kind: "ingreso", reason, actorUserId, keyPrefix: prefix },
  })
  if (!result.replayed) await audit(tx, orgId, actorUserId, "stock", item.id, "stock.agregado")
  return {
    productId: item.id,
    branch: sede,
    lotId: lot.id,
    quantity: input.quantity,
    covered: result.covered,
    movements: result.movements,
    replayed: result.replayed,
  }
}

/**
 * Un lote que ya existe con ese código no se usa con otro vencimiento: el
 * dato no se ignora en silencio. Lo dice con palabras y pide el código.
 */
async function assertLotExpiry(
  tx: Db,
  orgId: string,
  input: { productId: string; warehouseId: string; code: string; expiresAt: string | null; productName: string; path?: string },
) {
  if (!input.expiresAt) return
  const [lot] = await tx
    .select({ expiresAt: productLot.expiresAt })
    .from(productLot)
    .where(
      and(
        eq(productLot.organizationId, orgId),
        eq(productLot.productId, input.productId),
        eq(productLot.warehouseId, input.warehouseId),
        eq(productLot.code, input.code),
      ),
    )
    .limit(1)
  if (!lot || lot.expiresAt === input.expiresAt) return
  const { locale } = await findOrgLocale(tx, orgId)
  const was = lot.expiresAt ? `vence el ${dayWords(lot.expiresAt, locale)}` : "no tiene vencimiento"
  const ask = `escribe el código del lote que vence el ${dayWords(input.expiresAt, locale)}.`
  throw conflict(
    input.code
      ? `El lote ${input.code} de ${input.productName} ya existe y ${was}: ${ask}`
      : `Ya hay un lote sin código de ${input.productName} que ${was}: ${ask}`,
    input.path,
  )
}

/* ---------------- compras ---------------- */

/** Cómo se dice el estado de una compra en un mensaje: nunca con su código. */
const ORDER_STATUS_WORDS: Record<string, string> = {
  borrador: "está en borrador",
  confirmada: "ya está confirmada",
  parcialmente_recibida: "ya se recibió en parte",
  recibida: "ya se recibió entera",
  cerrada: "está cerrada con lo recibido",
  cancelada: "está cancelada",
}

function requireEditableStatus(order: { status: string }, action: string) {
  if (order.status === "recibida" || order.status === "cerrada" || order.status === "cancelada")
    throw conflict(`La orden ${ORDER_STATUS_WORDS[order.status]} y ya no admite ${action}`)
}

/** Cómo se registra una compra nueva: guardarla, pedirla o registrar una que ya llegó. */
export const PURCHASE_MODES = ["borrador", "pedir", "ya_la_tengo"] as const
export type PurchaseMode = (typeof PURCHASE_MODES)[number]

/** Las vistas de Compras. */
export const PURCHASE_VIEWS = ["por_llegar", "por_pagar", "borradores", "todas"] as const
export type PurchaseView = (typeof PURCHASE_VIEWS)[number]

/** Un lote de lo que llegó, en unidades de compra. */
export interface ReceptionLotInput {
  quantity: number
  lotCode?: string | null
  expiresAt?: string | null
}

export interface PurchaseOrderLineInput {
  productId: string
  /** En unidades de compra («8 cajas»). */
  quantity: number
  /** Por unidad de compra. */
  unitCostCents?: number
  /** «Ya la tengo»: en qué lotes llegó (opcional; sin ellos, un lote con el número de la orden). */
  lots?: ReceptionLotInput[]
}

/** A dónde llega una compra: el almacén elegido o el principal de la sede. */
async function destinationOf(tx: Db, orgId: string, input: { branchId?: string | null; warehouseId?: string | null }) {
  if (input.warehouseId) {
    const dest = await requireWarehouse(tx, orgId, input.warehouseId)
    if (!dest.isActive) throw conflict("El almacén destino está desactivado", "warehouseId")
    return dest
  }
  if (input.branchId) {
    const sede = await requireBranch(tx, orgId, input.branchId)
    return defaultWarehouse(tx, orgId, sede.id)
  }
  throw invalidField("branchId", "Elige la sede a la que llega la compra")
}

/** Revisa las líneas y les copia la unidad y el factor de compra del producto. */
async function lineValues(tx: Db, orgId: string, lines: PurchaseOrderLineInput[]) {
  if (!lines?.length) throw validation("La orden necesita al menos una línea")
  if (lines.length > 200) throw validation("La orden admite hasta 200 líneas")
  const seen = new Set<string>()
  const out: Array<{ productId: string; quantity: number; unitCostCents: number; purchaseUnit: string | null; unitFactor: number; name: string }> = []
  for (const [index, line] of lines.entries()) {
    const at = `lines[${index}]`
    if (seen.has(line.productId))
      throw invalidField(`${at}.productId`, "La orden no admite el mismo producto dos veces: suma sus cantidades en una fila")
    seen.add(line.productId)
    const item = await requireProduct(tx, orgId, line.productId)
    if (!item.isActive) throw conflict(`El producto ${item.name} está desactivado`, `${at}.productId`)
    out.push({
      productId: item.id,
      quantity: quantity(line.quantity, "La cantidad", `${at}.quantity`),
      unitCostCents: cents(line.unitCostCents ?? 0, "El costo por unidad", `${at}.unitCostCents`),
      purchaseUnit: item.purchaseUnit,
      unitFactor: item.purchaseFactor,
      name: item.name,
    })
  }
  return out
}

/**
 * Crea una compra con varios productos, en unidades de compra. `borrador` la
 * guarda para pedirla después; `pedir` la deja pedida; `ya_la_tengo` la
 * registra como llegada en la misma transacción, con sus lotes (lo que se
 * trae de la tienda dental en un paso). Cada línea copia la unidad de compra
 * y el factor del producto: cambiar el producto después no reescribe lo pedido.
 */
export async function createPurchaseOrder(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: {
    supplierId: string
    branchId?: string | null
    warehouseId?: string | null
    mode?: PurchaseMode
    currency?: string
    notes?: string | null
    lines: PurchaseOrderLineInput[]
  },
) {
  const mode = input.mode ?? "borrador"
  if (!(PURCHASE_MODES as readonly string[]).includes(mode)) throw validation("Elige si la compra se pide o ya la tienes")
  const dest = await destinationOf(tx, orgId, input)
  const sup = await requireSupplier(tx, orgId, input.supplierId)
  if (!sup.isActive) throw conflict("El proveedor está desactivado", "supplierId")
  const lines = await lineValues(tx, orgId, input.lines)
  if (mode === "ya_la_tengo")
    for (const [index, line] of input.lines.entries()) {
      if (!line.lots?.length) continue
      const total = line.lots.reduce(
        (sum, lot, at) => sum + quantity(lot.quantity, "Lo que llegó en cada lote", `lines[${index}].lots[${at}].quantity`),
        0,
      )
      const planned = lines[index]
      if (planned && total !== planned.quantity)
        throw invalidField(`lines[${index}].lots`, `Los lotes de ${planned.name} suman ${total}: deben sumar lo que llegó (${planned.quantity})`)
    }
  // Número sin saltos por clínica: el contador se bloquea al sumarle uno.
  const [counter] = await tx
    .insert(orgCounter)
    .values({ organizationId: orgId, key: "purchase_order", value: 1 })
    .onConflictDoUpdate({ target: [orgCounter.organizationId, orgCounter.key], set: { value: sql`"org_counter"."value" + 1` } })
    .returning({ value: orgCounter.value })
  if (!counter) throw new ServiceError("INTERNAL", 500, "No se pudo numerar la orden")
  const [order] = await tx
    .insert(purchaseOrder)
    .values({
      organizationId: orgId,
      orderNumber: Number(counter.value),
      supplierId: input.supplierId,
      warehouseId: dest.id,
      status: mode === "borrador" ? "borrador" : "confirmada",
      currency: currency(input.currency ?? (await requireOrgCurrency(tx, orgId))),
      notes: textOptional(input.notes, "Las notas", 2000, "notes"),
      createdBy: actorUserId,
    })
    .returning()
  if (!order) throw new ServiceError("INTERNAL", 500, "No se pudo guardar la compra")
  for (const line of lines) {
    await tx.insert(purchaseOrderLine).values({
      organizationId: orgId,
      orderId: order.id,
      productId: line.productId,
      quantity: line.quantity,
      unitCostCents: line.unitCostCents,
      purchaseUnit: line.purchaseUnit,
      unitFactor: line.unitFactor,
    })
  }
  await audit(tx, orgId, actorUserId, "purchase_order", order.id, "purchase_order.created")
  if (mode !== "borrador") await audit(tx, orgId, actorUserId, "purchase_order", order.id, "purchase_order.confirmed")
  if (mode === "ya_la_tengo") {
    // Quien la trajo ya sabe lo que llegó: no se avisa a la campana.
    await receivePurchaseOrder(
      tx,
      orgId,
      actorUserId,
      order.id,
      input.lines.map((line) => ({ productId: line.productId, lots: line.lots?.length ? line.lots : [{ quantity: line.quantity }] })),
      `ya-la-tengo:${order.id}`,
      { notify: false },
    )
  }
  return getPurchaseOrder(tx, orgId, order.id, { prices: true })
}

/**
 * Cambia una compra en borrador: proveedor, sede, notas y sus productos (las
 * líneas se reemplazan; la base solo deja quitar líneas de un borrador).
 */
export async function updatePurchaseOrder(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: {
    supplierId?: string
    branchId?: string | null
    warehouseId?: string | null
    notes?: string | null
    lines?: PurchaseOrderLineInput[]
  },
) {
  const order = await lockPurchaseOrder(tx, orgId, id)
  if (order.status !== "borrador")
    throw conflict(`La compra ${ORDER_STATUS_WORDS[order.status] ?? "no está en borrador"}: solo se cambia una compra en borrador`)
  const patch: Partial<typeof purchaseOrder.$inferInsert> = {}
  if (input.supplierId !== undefined && input.supplierId !== order.supplierId) {
    const sup = await requireSupplier(tx, orgId, input.supplierId)
    if (!sup.isActive) throw conflict("El proveedor está desactivado", "supplierId")
    patch.supplierId = sup.id
  }
  if (input.warehouseId || input.branchId) patch.warehouseId = (await destinationOf(tx, orgId, input)).id
  if (input.notes !== undefined) patch.notes = textOptional(input.notes, "Las notas", 2000, "notes")
  if (input.lines !== undefined) {
    const lines = await lineValues(tx, orgId, input.lines)
    const current = await orderLines(tx, orgId, id)
    const keep = new Set(lines.map((line) => line.productId))
    for (const line of current)
      if (!keep.has(line.productId))
        await tx
          .delete(purchaseOrderLine)
          .where(and(eq(purchaseOrderLine.organizationId, orgId), eq(purchaseOrderLine.id, line.id)))
    const byProduct = new Map(current.map((line) => [line.productId, line]))
    for (const line of lines) {
      const values = {
        quantity: line.quantity,
        unitCostCents: line.unitCostCents,
        purchaseUnit: line.purchaseUnit,
        unitFactor: line.unitFactor,
      }
      const existing = byProduct.get(line.productId)
      if (existing)
        await tx
          .update(purchaseOrderLine)
          .set({ ...values, updatedAt: new Date() })
          .where(and(eq(purchaseOrderLine.organizationId, orgId), eq(purchaseOrderLine.id, existing.id)))
      else await tx.insert(purchaseOrderLine).values({ organizationId: orgId, orderId: id, productId: line.productId, ...values })
    }
  }
  await tx
    .update(purchaseOrder)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.id, id)))
  await audit(tx, orgId, actorUserId, "purchase_order", id, "purchase_order.updated")
  return getPurchaseOrder(tx, orgId, id, { prices: true })
}

/**
 * Una compra al lado de la lista: proveedor, sede, quién la pidió y sus
 * productos en unidades de compra. Con precios, además el precio de cada
 * línea (y el pedido si la factura trajo otro), el total, lo recibido, pagado
 * y por pagar, sus pagos y lo que se tiene a favor con el proveedor.
 */
export async function getPurchaseOrder(tx: Db, orgId: string, id: string, options: { prices?: boolean } = { prices: true }) {
  const prices = options.prices !== false
  const order = await requireOrder(tx, orgId, id)
  const [info] = await tx.execute<{
    supplierName: string
    supplierPhone: string | null
    supplierEmail: string | null
    warehouseName: string
    warehouseIsDefault: boolean
    branchId: string
    branchName: string
    createdByName: string | null
  }>(sql`
    select s.name as "supplierName", s.phone as "supplierPhone", s.email as "supplierEmail",
      w.name as "warehouseName", w.is_default as "warehouseIsDefault", w.branch_id as "branchId", b.name as "branchName",
      u.name as "createdByName"
    from purchase_order o
    join supplier s on s.organization_id = o.organization_id and s.id = o.supplier_id
    join warehouse w on w.organization_id = o.organization_id and w.id = o.warehouse_id
    join branch b on b.organization_id = w.organization_id and b.id = w.branch_id
    left join "user" u on u.id = o.created_by
    where o.organization_id = ${orgId} and o.id = ${id}`)
  const lines = await tx.execute<{
    id: string
    productId: string
    productName: string
    productSku: string
    unit: string
    purchaseUnit: string | null
    unitFactor: number
    quantity: number
    receivedQuantity: number
    unitCostCents: number
    orderedUnitCostCents: number | null
    tracksLots: boolean
  }>(sql`
    select pl.id, pl.product_id as "productId", p.name as "productName", p.sku as "productSku", p.unit,
      pl.purchase_unit as "purchaseUnit", pl.unit_factor as "unitFactor", pl.quantity, pl.received_quantity as "receivedQuantity",
      pl.unit_cost_cents as "unitCostCents", pl.ordered_unit_cost_cents as "orderedUnitCostCents",
      exists (select 1 from product_lot l where l.organization_id = pl.organization_id and l.product_id = pl.product_id
        and l.expires_at is not null) as "tracksLots"
    from purchase_order_line pl
    join product p on p.organization_id = pl.organization_id and p.id = pl.product_id
    where pl.organization_id = ${orgId} and pl.order_id = ${id}
    order by pl.created_at, pl.id`)
  const [arrival] = await tx.execute<{ lastReceivedAt: string | null }>(sql`
    select ${iso(sql`max(created_at)`)} as "lastReceivedAt" from stock_movement
    where organization_id = ${orgId} and purchase_order_id = ${id} and kind = 'ingreso'`)
  const base = {
    id: order.id,
    orderNumber: Number(order.orderNumber ?? 0),
    label: purchaseOrderLabel(Number(order.orderNumber ?? 0)),
    status: order.status,
    currency: order.currency,
    notes: order.notes,
    supplierId: order.supplierId,
    supplierName: info?.supplierName ?? null,
    supplierPhone: info?.supplierPhone ?? null,
    supplierEmail: info?.supplierEmail ?? null,
    warehouseId: order.warehouseId,
    warehouseName: info?.warehouseName ?? null,
    warehouseIsDefault: info?.warehouseIsDefault ?? true,
    branchId: info?.branchId ?? null,
    branchName: info?.branchName ?? null,
    createdBy: order.createdBy,
    createdByName: info?.createdByName ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    lastReceivedAt: arrival?.lastReceivedAt ?? null,
    received: lines.some((line) => line.receivedQuantity > 0),
    complete: lines.length > 0 && lines.every((line) => line.receivedQuantity >= line.quantity),
    lines: lines.map(({ unitCostCents, orderedUnitCostCents, ...line }) => ({
      ...line,
      pendingQuantity: Math.max(0, line.quantity - line.receivedQuantity),
      ...(prices
        ? {
            unitCostCents,
            orderedUnitCostCents,
            subtotalCents: line.quantity * unitCostCents,
            receivedCents: line.receivedQuantity * unitCostCents,
          }
        : {}),
    })),
  }
  if (!prices) return base as typeof base & Partial<PurchasePricing>
  const [balance] = await purchaseBalances(tx, orgId, { orderIds: [id] })
  const pricing: PurchasePricing = {
    totalCents: lines.reduce((sum, line) => sum + line.quantity * line.unitCostCents, 0),
    balance: balance ?? null,
    payments: await purchasePayments(tx, orgId, id),
    supplierCreditCents:
      (await supplierCredits(tx, orgId, { supplierId: order.supplierId })).find((item) => item.currency === order.currency)?.cents ?? 0,
  }
  return { ...base, ...pricing }
}

/** Lo que solo ve quien ve precios de una compra. */
interface PurchasePricing {
  totalCents: number
  /** Recibido, pagado y por pagar (ADR 0061). */
  balance: PurchaseBalance | null
  payments: Awaited<ReturnType<typeof purchasePayments>>
  /** Lo que se tiene a favor con este proveedor, en la moneda de la orden. */
  supplierCreditCents: number
}

/** Los pagos de una compra: sus gastos y lo usado a favor, con quién y cuándo; los anulados al final. */
export async function purchasePayments(tx: Db, orgId: string, orderId: string) {
  const expenses = await tx
    .select({
      id: expense.id,
      amountCents: expense.amountCents,
      paidAt: expense.spentAt,
      concept: expense.concept,
      fromCash: sql<boolean>`${expense.shiftId} is not null`,
      receiptKind: expense.receiptKind,
      receiptNumber: expense.receiptNumber,
      byName: user.name,
      voidedAt: expense.voidedAt,
      voidReason: expense.voidReason,
    })
    .from(expense)
    .leftJoin(user, eq(user.id, expense.createdBy))
    .where(and(eq(expense.organizationId, orgId), eq(expense.purchaseOrderId, orderId)))
  const credits = await tx
    .select({
      id: supplierCreditUse.id,
      amountCents: supplierCreditUse.amountCents,
      paidAt: supplierCreditUse.createdAt,
      byName: user.name,
      voidedAt: supplierCreditUse.voidedAt,
      voidReason: supplierCreditUse.voidReason,
    })
    .from(supplierCreditUse)
    .leftJoin(user, eq(user.id, supplierCreditUse.createdBy))
    .where(and(eq(supplierCreditUse.organizationId, orgId), eq(supplierCreditUse.orderId, orderId)))
  return [
    ...expenses.map((row) => ({ ...row, kind: "pago" as const })),
    ...credits.map((row) => ({ ...row, kind: "a_favor" as const, concept: null, fromCash: false, receiptKind: null, receiptNumber: null })),
  ].sort((a, b) => Number(a.voidedAt !== null) - Number(b.voidedAt !== null) || b.paidAt.getTime() - a.paidAt.getTime())
}

/** «Por pagar»: recibidas con algo sin pagar (nombre de la fase 1, igual a la vista `por_pagar`). */
export const PURCHASE_PAYMENT_FILTERS = ["por_pagar"] as const

/**
 * Compras de una sede (o de toda la clínica) por vista: «Por llegar» (pedidas
 * que aún esperan algo), «Por pagar» (lo recibido sin pagar; solo con
 * precios), «Borradores» y «Todas», con los conteos de cada una y el total de
 * la vista para paginar.
 */
export async function listPurchaseOrders(
  tx: Db,
  orgId: string,
  options: {
    branchId?: string | null
    view?: PurchaseView
    status?: string
    supplierId?: string
    payment?: (typeof PURCHASE_PAYMENT_FILTERS)[number]
    q?: string
    prices?: boolean
    limit?: number
    offset?: number
  } = {},
) {
  const prices = options.prices !== false
  const view: PurchaseView = options.payment === "por_pagar" ? "por_pagar" : (options.view ?? "todas")
  if (!(PURCHASE_VIEWS as readonly string[]).includes(view)) throw validation("La vista de compras no es válida")
  if (view === "por_pagar" && !prices) throw new ServiceError("FORBIDDEN", 403, "Lo que falta pagar de las compras lo ve quien lleva las compras")
  if (options.status && !(PURCHASE_ORDER_STATUSES as readonly string[]).includes(options.status)) throw validation("Estado de orden inválido")
  const scope: SQL[] = [sql`o.organization_id = ${orgId}`]
  if (options.branchId) scope.push(sql`w.branch_id = ${options.branchId}`)
  if (options.supplierId) scope.push(sql`o.supplier_id = ${options.supplierId}`)
  if (options.status) scope.push(sql`o.status = ${options.status}`)
  const q = options.q?.trim()
  if (q) {
    const number = /^(?:oc-?)?0*(\d{1,9})$/i.exec(q)
    scope.push(
      number
        ? sql`(o.order_number = ${Number(number[1])} or ${foldedWordsMatch([sql`s.name`], q)})`
        : foldedWordsMatch([sql`s.name`, sql`o.notes`], q),
    )
  }
  // «Por pagar» va en la consulta, antes del tope: una compra vieja por pagar no queda fuera.
  const due = prices
    ? (await purchaseBalances(tx, orgId, { dueOnly: true, supplierId: options.supplierId })).map((row) => row.orderId)
    : []
  const dueSql = due.length ? sql`o.id in (${sql.join(due.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`
  const views: Record<PurchaseView, SQL> = {
    por_llegar: sql`o.status in ('confirmada', 'parcialmente_recibida')`,
    por_pagar: dueSql,
    borradores: sql`o.status = 'borrador'`,
    todas: sql`true`,
  }
  const from = sql`
    from purchase_order o
    join supplier s on s.organization_id = o.organization_id and s.id = o.supplier_id
    join warehouse w on w.organization_id = o.organization_id and w.id = o.warehouse_id
    join branch b on b.organization_id = w.organization_id and b.id = w.branch_id
    left join "user" u on u.id = o.created_by`
  const where = sql.join(scope, sql` and `)
  const [count] = await tx.execute<{ por_llegar: number; por_pagar: number; borradores: number; todas: number }>(sql`
    select count(*) filter (where ${views.por_llegar})::int as por_llegar,
      count(*) filter (where ${views.por_pagar})::int as por_pagar,
      count(*) filter (where ${views.borradores})::int as borradores,
      count(*)::int as todas
    ${from} where ${where}`)
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200)
  const offset = Math.max(options.offset ?? 0, 0)
  const rows = await tx.execute<{
    id: string
    orderNumber: number
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
  }>(sql`
    select o.id, o.order_number as "orderNumber", o.status, o.currency, o.notes, o.supplier_id as "supplierId", s.name as "supplierName",
      o.warehouse_id as "warehouseId", w.name as "warehouseName", w.branch_id as "branchId", b.name as "branchName",
      ${iso(sql`o.created_at`)} as "createdAt", u.name as "createdByName",
      (select count(*)::int from purchase_order_line pl where pl.organization_id = o.organization_id and pl.order_id = o.id) as lines,
      (select count(*)::int from purchase_order_line pl where pl.organization_id = o.organization_id and pl.order_id = o.id
        and pl.received_quantity < pl.quantity) as "pendingLines"
    ${from} where ${where} and ${views[view]}
    order by o.created_at desc, o.order_number desc
    limit ${limit} offset ${offset}`)
  const balances = prices
    ? new Map((await purchaseBalances(tx, orgId, { orderIds: rows.map((row) => row.id) })).map((balance) => [balance.orderId, balance]))
    : new Map<string, PurchaseBalance>()
  const items = rows.map((row) => {
    const orderNumber = Number(row.orderNumber)
    const base = { ...row, orderNumber, label: purchaseOrderLabel(orderNumber) }
    const balance = balances.get(row.id) ?? null
    const pricing: { totalCents?: number; balance?: PurchaseBalance | null } = prices
      ? { totalCents: balance?.orderedCents ?? 0, balance }
      : {}
    return { ...base, ...pricing }
  })
  const counts = {
    por_llegar: count?.por_llegar ?? 0,
    borradores: count?.borradores ?? 0,
    todas: count?.todas ?? 0,
    ...(prices ? { por_pagar: count?.por_pagar ?? 0 } : {}),
  }
  return { view, items, total: count?.[view] ?? 0, counts }
}

export async function confirmPurchaseOrder(tx: Db, orgId: string, actorUserId: string, id: string) {
  // Bloqueada: una cancelación al mismo tiempo no queda deshecha por esta confirmación.
  const order = await lockPurchaseOrder(tx, orgId, id)
  if (order.status !== "borrador")
    throw conflict(`La orden ${ORDER_STATUS_WORDS[order.status] ?? "no está en borrador"}: solo se confirma una orden en borrador`)
  const [row] = await tx
    .update(purchaseOrder)
    .set({ status: "confirmada", updatedAt: new Date() })
    .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, "purchase_order", id, "purchase_order.confirmed")
  return row
}

/**
 * Cancela una orden sin recepciones. Si ya tiene pagos (adelantos), hay que
 * decir qué pasa con ellos: anularlos (el proveedor devolvió el dinero) o
 * dejarlos a favor con el proveedor para la próxima compra; nunca quedan
 * sueltos (ADR 0061). La orden y su proveedor se bloquean al empezar, en el
 * mismo orden que al pagar (`payPurchaseOrder`) y al anular un pago: un pago o
 * una anulación al mismo tiempo esperan, y el estado se lee ya bloqueado.
 */
export async function cancelPurchaseOrder(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: { payments?: "anular" | "a_favor"; reason?: string } = {},
) {
  const order = await lockPurchaseOrder(tx, orgId, id)
  await lockSupplier(tx, orgId, order.supplierId)
  requireEditableStatus(order, "cancelación")
  const lines = await orderLines(tx, orgId, id)
  if (lines.some((line) => line.receivedQuantity > 0))
    throw conflict("La orden ya tiene recepciones y no puede cancelarse: ciérrala con lo recibido")
  const [balance] = await purchaseBalances(tx, orgId, { orderIds: [id] })
  if (balance && balance.paidCents > 0) {
    if (!input.payments)
      throw new ServiceError(
        "PURCHASE_HAS_PAYMENTS",
        409,
        "La orden ya tiene pagos: elige si se anulan o quedan a favor con el proveedor",
        { payments: "Elige si los pagos se anulan o quedan a favor con el proveedor" },
      )
    if (input.payments === "anular") {
      const voidReason = input.reason?.trim() || "Se canceló la compra"
      const live = (await purchasePayments(tx, orgId, id)).filter((payment) => payment.voidedAt === null)
      for (const payment of live) {
        if (payment.kind === "pago") await voidExpense(tx, orgId, actorUserId, payment.id, { reason: voidReason })
        else await voidSupplierCreditUse(tx, orgId, actorUserId, payment.id, { reason: voidReason })
      }
    }
  }
  const [row] = await tx
    .update(purchaseOrder)
    .set({ status: "cancelada", updatedAt: new Date() })
    .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.id, id)))
    .returning()
  await audit(
    tx,
    orgId,
    actorUserId,
    "purchase_order",
    id,
    balance && balance.paidCents > 0 && input.payments === "a_favor" ? "purchase_order.cancelled_to_credit" : "purchase_order.cancelled",
  )
  // Lo dejado a favor ya cuenta; si se anularon pagos, lo usado a favor debe seguir cubierto.
  if (balance && balance.paidCents > 0) await assertSupplierCreditCovered(tx, orgId, id)
  return row
}

/**
 * «Cerrar con lo recibido»: el proveedor ya no manda lo que falta. Lo que no
 * llegó deja de esperarse y, si se pagó por adelantado más de lo recibido, la
 * diferencia queda a favor con el proveedor (ADR 0061). Exige algo recibido:
 * lo que no llegó nunca se cancela.
 */
export async function closePurchaseOrder(tx: Db, orgId: string, actorUserId: string, id: string) {
  const order = await lockPurchaseOrder(tx, orgId, id)
  await lockSupplier(tx, orgId, order.supplierId)
  if (order.status === "recibida") throw conflict("La compra ya llegó completa: no hay nada que cerrar")
  if (order.status !== "confirmada" && order.status !== "parcialmente_recibida")
    throw conflict(`La orden ${ORDER_STATUS_WORDS[order.status] ?? "no está pedida"}: solo se cierra una compra pedida`)
  const lines = await orderLines(tx, orgId, id)
  if (!lines.some((line) => line.receivedQuantity > 0))
    throw conflict("Todavía no llegó nada de esta compra: si ya no va a llegar, cancélala.")
  await tx
    .update(purchaseOrder)
    .set({ status: "cerrada", updatedAt: new Date() })
    .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.id, id)))
  await audit(tx, orgId, actorUserId, "purchase_order", id, "purchase_order.closed")
  return getPurchaseOrder(tx, orgId, id, { prices: true })
}

export type { PurchaseBalance }

export interface ReceptionLineInput {
  productId: string
  /** Un solo lote: cuántas unidades de compra llegaron. */
  quantity?: number
  lotCode?: string | null
  expiresAt?: string | null
  /** Varios lotes del mismo producto («+ Llegó en otro lote»), en unidades de compra. */
  lots?: ReceptionLotInput[]
  /** Precio de la factura por unidad de compra, si trajo otro (la ruta lo admite solo a quien lleva las compras). */
  unitCostCents?: number
}

/** Los roles que llevan las compras: a ellos llega el aviso de lo que llegó. */
const INVENTORY_WRITERS = ORG_ROLES.filter((role) => canAccess(role, "inventory.write"))

/**
 * «Rosa registró lo que llegó de OC-0014: falta pagar S/ 666.00»: para
 * enterarse quien lleva las compras, no quien lo registró.
 */
async function noticeReception(tx: Db, orgId: string, actorUserId: string, orderId: string, receptionKey: string) {
  const [balance] = await purchaseBalances(tx, orgId, { orderIds: [orderId] })
  if (!balance) return
  const [actor] = await tx.select({ name: user.name }).from(user).where(eq(user.id, actorUserId)).limit(1)
  const { locale } = await findOrgLocale(tx, orgId)
  const label = purchaseOrderLabel(balance.orderNumber)
  const owed = balance.dueCents > 0 ? `: falta pagar ${formatOrgMoney(balance.dueCents, balance.currency, { locale })}` : ""
  const title = `${actor?.name?.trim() || "Alguien del equipo"} registró lo que llegó de ${label}${owed}`.slice(0, 200)
  const writers = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, INVENTORY_WRITERS)))
  for (const userId of new Set(writers.map((row) => row.userId))) {
    await createWorkspaceNotification(tx, orgId, {
      userId,
      dedupeKey: `inventory:received:${orderId}:${receptionKey}`.slice(0, 300),
      title,
      body: `${balance.supplierName} · ${balance.branchName}`,
      href: `/inventory?tab=compras&orden=${orderId}`,
      permission: "inventory.write",
      actorUserId,
    })
  }
}

/**
 * «Registrar lo que llegó»: cantidades en unidades de compra, uno o varios
 * lotes por producto; cada lote recibe `llegó × factor` unidades de uso y, si
 * la sede tenía faltante, lo cubre primero. El precio de la factura corrige
 * el de la línea y guarda lo pedido.
 *
 * Idempotencia por clave del formulario (una por formulario abierto, rota
 * tras guardar): dos entregas con el mismo contenido usan claves distintas y
 * ambas aplican; reintentar la misma clave devuelve lo ya aplicado aunque esa
 * recepción haya completado la orden (la clave se mira antes que el estado),
 * y con otro contenido responde un conflicto sin efectos. La orden y sus
 * líneas se bloquean: recepciones concurrentes se serializan.
 *
 * Sin código de lote, el lote lleva el número de la orden («OC-0012»). Un lote
 * que ya existe con ese código se reutiliza, pero no con otro vencimiento.
 */
export async function receivePurchaseOrder(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  lines: ReceptionLineInput[],
  idempotencyKey: string,
  options: { notify?: boolean } = {},
) {
  // La pone la pantalla al abrir la orden: sin ella no se distingue un reintento de otra entrega.
  const receptionKey = formKey(idempotencyKey, "No se pudo identificar esta recepción: vuelve a abrir la orden e inténtalo de nuevo")
  if (!lines?.length) throw validation("La recepción necesita al menos una línea")
  // `at` dice cómo se llama cada dato en el cuerpo: la pantalla lo marca en su fila (y en su lote).
  const incoming = new Map<string, { parts: ReceptionLotInput[]; unitCostCents?: number; at: string; partAt: (n: number) => string }>()
  for (const [index, line] of lines.entries()) {
    const at = `lines[${index}]`
    if (incoming.has(line.productId))
      throw invalidField(`${at}.productId`, "La recepción repite un producto: suma sus cantidades en una sola línea")
    const parts = line.lots?.length
      ? line.lots
      : [{ quantity: line.quantity as number, lotCode: line.lotCode ?? null, expiresAt: line.expiresAt ?? null }]
    if (parts.length > 50) throw invalidField(`${at}.lots`, "Un producto admite hasta 50 lotes por recepción")
    const partAt = line.lots?.length ? (n: number) => `${at}.lots[${n}]` : () => at
    incoming.set(line.productId, { parts, unitCostCents: line.unitCostCents, at, partAt })
  }
  // Serializa recepciones concurrentes de la misma orden, y el estado se lee ya
  // bloqueado: una orden que se canceló mientras tanto no recibe mercadería.
  const order = await lockPurchaseOrder(tx, orgId, id)
  const label = purchaseOrderLabel(order.orderNumber ?? 0)
  const expected = await tx
    .select()
    .from(purchaseOrderLine)
    .where(and(eq(purchaseOrderLine.organizationId, orgId), eq(purchaseOrderLine.orderId, id)))
    .for("update")
  const byProduct = new Map(expected.map((line) => [line.productId, line]))
  const keyPrefix = `po:${id}:${receptionKey}`
  const prior = await tx.execute<{ productId: string; delta: number; lotCode: string | null; expiresAt: string | null }>(sql`
    select m.product_id as "productId", m.quantity_delta as delta, l.code as "lotCode", l.expires_at::text as "expiresAt"
    from stock_movement m
    left join product_lot l on l.organization_id = m.organization_id and l.id = m.lot_id
    where m.organization_id = ${orgId} and m.kind = 'ingreso'
      and (m.idempotency_key like ${`${keyPrefix.replace(/[\\%_]/g, (char) => `\\${char}`)}:%`})`)
  if (prior.length > 0) {
    // Un reintento trae lo mismo que ya se aplicó: se devuelve sin tocar nada.
    const wanted = [...incoming.entries()].flatMap(([productId, entry]) =>
      entry.parts.map((part) => ({
        productId,
        delta: part.quantity * (byProduct.get(productId)?.unitFactor ?? 1),
        lotCode: part.lotCode?.trim() || label,
        expiresAt: part.expiresAt || null,
      })),
    )
    const sortKey = (row: { productId: string; lotCode: string | null; delta: number }) => `${row.productId}|${row.lotCode}|${row.delta}`
    const left = [...prior].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    const right = [...wanted].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
    const same =
      left.length === right.length &&
      left.every((row, index) => {
        const other = right[index]
        return (
          other !== undefined &&
          row.productId === other.productId &&
          row.delta === other.delta &&
          row.lotCode === other.lotCode &&
          (!other.expiresAt || other.expiresAt === row.expiresAt)
        )
      })
    if (!same) throw conflict("Esta recepción ya se registró con otros datos. Cierra la orden y vuelve a abrirla para ver lo que llegó.")
    return { ...order, lines: await orderLines(tx, orgId, id), covered: 0, replayed: true }
  }
  requireEditableStatus(order, "recepción")
  if (order.status !== "confirmada" && order.status !== "parcialmente_recibida")
    throw conflict("Confirma la orden antes de recibir la mercadería")
  for (const [productId, entry] of incoming) {
    const line = byProduct.get(productId)
    if (!line) throw invalidField(`${entry.at}.productId`, "La recepción incluye un producto que no está en la orden")
    let total = 0
    for (const [n, part] of entry.parts.entries()) {
      total += quantity(part.quantity, "La cantidad recibida", `${entry.partAt(n)}.quantity`)
      dateOnly(part.expiresAt, "El vencimiento", `${entry.partAt(n)}.expiresAt`)
      textOptional(part.lotCode, "El código de lote", 120, `${entry.partAt(n)}.lotCode`)
    }
    if (line.receivedQuantity + total > line.quantity) {
      const item = await requireProduct(tx, orgId, productId)
      const message = `La recepción supera lo pedido: de ${item.name} faltan ${line.quantity - line.receivedQuantity}`
      throw conflict(message, entry.parts.length > 1 ? `${entry.at}.lots` : `${entry.partAt(0)}.quantity`)
    }
    if (entry.unitCostCents !== undefined) cents(entry.unitCostCents, "El precio de la factura", `${entry.at}.unitCostCents`)
  }
  let covered = 0
  for (const [productId, entry] of incoming) {
    const line = byProduct.get(productId)
    if (!line) continue
    // El precio de la factura: «Por pagar» se calcula con él y lo pedido queda como referencia.
    if (entry.unitCostCents !== undefined && entry.unitCostCents !== line.unitCostCents) {
      const ordered = line.orderedUnitCostCents ?? line.unitCostCents
      await tx
        .update(purchaseOrderLine)
        .set({ unitCostCents: entry.unitCostCents, orderedUnitCostCents: entry.unitCostCents === ordered ? null : ordered, updatedAt: new Date() })
        .where(and(eq(purchaseOrderLine.organizationId, orgId), eq(purchaseOrderLine.id, line.id)))
    }
    let received = 0
    for (const [n, part] of entry.parts.entries()) {
      const code = part.lotCode?.trim() || label
      const expiresAt = dateOnly(part.expiresAt, "El vencimiento")
      const item = await requireProduct(tx, orgId, productId)
      await assertLotExpiry(tx, orgId, {
        productId,
        warehouseId: order.warehouseId,
        code,
        expiresAt,
        productName: item.name,
        path: `${entry.partAt(n)}.lotCode`,
      })
      const lot = await lotFor(tx, orgId, {
        productId,
        warehouseId: order.warehouseId,
        code,
        expiresAt,
        supplierId: order.supplierId,
        purchaseOrderId: id,
        actorUserId,
      })
      const result = await receiveIntoLot(tx, orgId, {
        lot,
        quantity: part.quantity * line.unitFactor,
        base: { kind: "ingreso", reason: `Recepción de ${label} · lote ${code || "sin código"}`, actorUserId, purchaseOrderId: id, keyPrefix: `${keyPrefix}:${productId}:${n}` },
      })
      covered += result.covered
      received += part.quantity
    }
    await tx
      .update(purchaseOrderLine)
      .set({ receivedQuantity: sql`${purchaseOrderLine.receivedQuantity} + ${received}`, updatedAt: new Date() })
      .where(and(eq(purchaseOrderLine.organizationId, orgId), eq(purchaseOrderLine.id, line.id)))
  }
  const refreshed = await orderLines(tx, orgId, id)
  const complete = refreshed.every((line) => line.receivedQuantity >= line.quantity)
  const [row] = await tx
    .update(purchaseOrder)
    .set({ status: complete ? "recibida" : "parcialmente_recibida", updatedAt: new Date() })
    .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, "purchase_order", id, "purchase_order.received")
  if (options.notify !== false) await noticeReception(tx, orgId, actorUserId, id, receptionKey)
  return { ...(row ?? order), lines: refreshed, covered, replayed: false }
}

/* ---------------- pedir lo que falta ---------------- */

/**
 * «Pedir lo que falta» de una sede: cada producto que hace falta, cuánto
 * pedir en unidades de compra para llegar al mínimo (redondeado hacia arriba,
 * descontando lo que ya viene en compras pedidas), a quién se le compró la
 * última vez y a qué precio, y lo usado en 30 días. odentIA no decide: da los
 * datos. El precio, solo con precios.
 */
export async function getReorderSuggestions(
  tx: Db,
  orgId: string,
  branchId: string | null | undefined,
  options: { prices?: boolean; now?: Date } = {},
) {
  const prices = options.prices !== false
  const now = options.now ?? new Date()
  const sede = await sedeOf(tx, orgId, branchId)
  const { today, horizon } = await todayOf(tx, orgId, now)
  const products = await tx
    .select()
    .from(product)
    .where(and(eq(product.organizationId, orgId), eq(product.isActive, true)))
  const statusAt = await sedeFigures(tx, orgId, [sede.id], today, horizon)
  const needing = products.map((row) => ({ row, status: statusAt(sede.id, row) })).filter((item) => item.status.needs)
  const ids = needing.map((item) => item.row.id)
  const onTheWay = new Map<string, number>()
  const inDraft = new Map<string, { orderId: string; orderNumber: number; label: string }>()
  if (ids.length > 0) {
    const pending = await tx.execute<{ productId: string; pending: string; status: string; orderId: string; orderNumber: number }>(sql`
      select pl.product_id as "productId", ((pl.quantity - pl.received_quantity)::bigint * pl.unit_factor)::text as pending,
        o.status, o.id as "orderId", o.order_number as "orderNumber"
      from purchase_order_line pl
      join purchase_order o on o.organization_id = pl.organization_id and o.id = pl.order_id
      join warehouse w on w.organization_id = o.organization_id and w.id = o.warehouse_id
      where pl.organization_id = ${orgId} and w.branch_id = ${sede.id}
        and o.status in ('borrador', 'confirmada', 'parcialmente_recibida')
        and pl.product_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
      order by o.order_number`)
    for (const row of pending) {
      if (row.status === "borrador") {
        if (!inDraft.has(row.productId)) {
          const orderNumber = Number(row.orderNumber)
          inDraft.set(row.productId, { orderId: row.orderId, orderNumber, label: purchaseOrderLabel(orderNumber) })
        }
      } else onTheWay.set(row.productId, (onTheWay.get(row.productId) ?? 0) + Number(row.pending))
    }
  }
  const last = await lastPurchases(tx, orgId, ids)
  const used = await usedSince(tx, orgId, { branchId: sede.id, productIds: ids, since: new Date(now.getTime() - 30 * DAY_MS) })
  const items = needing
    .map(({ row, status }) => {
      const coming = onTheWay.get(row.id) ?? 0
      const missing = Math.max(status.minQuantity, 0) - status.onHand - coming
      const factor = row.purchaseFactor
      const purchase = last.get(row.id)
      const view = lastPurchaseView(purchase, prices)
      // El precio de la última compra, por la unidad de compra de hoy.
      const lastPrice =
        purchase === undefined ? null : purchase.unitFactor === factor ? purchase.unitCostCents : Math.round((purchase.unitCostCents / purchase.unitFactor) * factor)
      return {
        productId: row.id,
        name: row.name,
        sku: row.sku,
        unit: row.unit,
        purchaseUnit: row.purchaseUnit,
        purchaseFactor: factor,
        onHand: status.onHand,
        shortage: status.shortage,
        minQuantity: status.minQuantity,
        state: status.state,
        /** Lo que ya viene en compras pedidas a esta sede, en la unidad de uso. */
        onTheWay: coming,
        /** Para llegar al mínimo, descontado lo que viene, en la unidad de uso. */
        missing: Math.max(0, missing),
        /** Cuánto pedir, en unidades de compra (redondeado hacia arriba). */
        quantity: Math.max(0, Math.ceil(missing / factor)),
        usedLast30Days: used.get(row.id) ?? 0,
        /** Ya está en un borrador de compra a esta sede. */
        inDraft: inDraft.get(row.id) ?? null,
        lastPurchase: view ? { ...view, ...(prices && lastPrice !== null ? { unitCostCents: lastPrice } : {}) } : null,
      }
    })
    .filter((item) => item.quantity > 0)
    .sort(byName)
  return { branch: sede, currency: prices ? await findOrgCurrency(tx, orgId) : null, items }
}

/**
 * Arma un borrador por proveedor con lo que falta en la sede: a quien se le
 * compró la última vez y a ese precio. Lo que ya está en un borrador no se
 * repite; lo que nunca se compró (o cuyo proveedor está desactivado) vuelve
 * aparte para preguntar a quién pedirlo.
 */
export async function createReorderDrafts(tx: Db, orgId: string, actorUserId: string, branchId: string) {
  const sede = await requireBranch(tx, orgId, branchId)
  const suggestions = await getReorderSuggestions(tx, orgId, sede.id, { prices: true })
  const alreadyInDraft = suggestions.items.filter((item) => item.inDraft)
  const open = suggestions.items.filter((item) => !item.inDraft)
  const withoutSupplier = open.filter((item) => !item.lastPurchase || !item.lastPurchase.supplierActive)
  const groups = new Map<string, typeof open>()
  for (const item of open) {
    if (!item.lastPurchase || !item.lastPurchase.supplierActive) continue
    const list = groups.get(item.lastPurchase.supplierId) ?? []
    list.push(item)
    groups.set(item.lastPurchase.supplierId, list)
  }
  const drafts: Array<{ id: string; orderNumber: number; label: string; supplierId: string; supplierName: string | null; lines: number }> = []
  for (const [supplierId, items] of groups) {
    const order = await createPurchaseOrder(tx, orgId, actorUserId, {
      supplierId,
      branchId: sede.id,
      mode: "borrador",
      lines: items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitCostCents: (item.lastPurchase as { unitCostCents?: number } | null)?.unitCostCents ?? 0,
      })),
    })
    drafts.push({
      id: order.id,
      orderNumber: order.orderNumber,
      label: order.label,
      supplierId,
      supplierName: order.supplierName,
      lines: items.length,
    })
  }
  return { branch: sede, drafts, withoutSupplier, alreadyInDraft }
}

/* ---------------- movimientos ---------------- */

export interface MovementListItem {
  id: string
  createdAt: string
  kind: string
  /** Cambio con signo en el lote (o en el faltante, sin lote), en la unidad de uso. */
  quantityDelta: number
  quantity: number
  /** Una cobertura no cambia lo que hay: el lote nuevo cubre lo que se usó sin haber. */
  affectsStock: boolean
  reason: string
  productId: string
  productName: string
  productSku: string
  unit: string
  purchaseUnit: string | null
  purchaseFactor: number
  lotId: string | null
  /** Vacío = «Sin código». */
  lotCode: string | null
  lotExpiresAt: string | null
  /** Donde cambió el saldo (la llegada de un traslado es del destino). */
  branchId: string
  branchName: string
  warehouseId: string
  warehouseName: string
  /** Traslado: de dónde sale y a dónde llega. */
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
  /** La persona del paciente: el enlace a su página. */
  personId: string | null
  encounterId: string | null
  purchaseOrderId: string | null
  purchaseOrderNumber: number | null
  purchaseOrderLabel: string | null
  chargeId: string | null
  chargeDescription: string | null
}

/**
 * El historial de lo que entra y sale, de lo más reciente a lo más antiguo,
 * con quién, cuándo, el paciente, la atención, la compra y el concepto de
 * cobro. Por sede (donde cambió el saldo), producto, búsqueda, tipo y rango
 * de días de la clínica; las páginas las hace el servidor, con su total. Las
 * dos filas de una cobertura se entregan como una.
 */
export async function listMovements(
  tx: Db,
  orgId: string,
  options: {
    branchId?: string | null
    productId?: string
    warehouseId?: string
    patientId?: string
    q?: string
    kind?: string
    from?: string
    to?: string
    limit?: number
    offset?: number
  } = {},
): Promise<{ items: MovementListItem[]; total: number }> {
  const where: SQL[] = [sql`m.organization_id = ${orgId}`, sql`not (m.kind = 'cobertura' and m.lot_id is null)`]
  const at = sql`(case when m.kind = 'traslado' and m.quantity_delta > 0 then m.dest_warehouse_id else m.warehouse_id end)`
  if (options.branchId) where.push(sql`aw.branch_id = ${options.branchId}`)
  if (options.warehouseId) where.push(sql`${at} = ${options.warehouseId}`)
  if (options.productId) where.push(sql`m.product_id = ${options.productId}`)
  if (options.patientId) where.push(sql`m.patient_id = ${options.patientId}`)
  if (options.kind) {
    if (!(STOCK_MOVEMENT_KINDS as readonly string[]).includes(options.kind)) throw validation("Tipo de movimiento inválido")
    where.push(sql`m.kind = ${options.kind}`)
  }
  const q = options.q?.trim()
  if (q) where.push(foldedWordsMatch([sql`p.name`, sql`p.sku`], q))
  if (options.from || options.to) {
    const { timezone } = await findOrgLocale(tx, orgId)
    const bound = (value: string, end: boolean, field: string): SQL => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        dateOnly(value, field)
        return end
          ? sql`((${value}::date + 1)::timestamp at time zone ${timezone})`
          : sql`(${value}::date::timestamp at time zone ${timezone})`
      }
      const instant = new Date(value)
      if (!Number.isFinite(instant.getTime())) throw validation(`${field} no es una fecha válida`)
      return sql`${instant.toISOString()}::timestamptz`
    }
    if (options.from) where.push(sql`m.created_at >= ${bound(options.from, false, "La fecha desde")}`)
    if (options.to) where.push(sql`m.created_at ${/^\d{4}-\d{2}-\d{2}$/.test(options.to) ? sql`<` : sql`<=`} ${bound(options.to, true, "La fecha hasta")}`)
  }
  const from = sql`
    from stock_movement m
    join product p on p.organization_id = m.organization_id and p.id = m.product_id
    join warehouse aw on aw.organization_id = m.organization_id and aw.id = ${at}`
  const condition = sql.join(where, sql` and `)
  const [count] = await tx.execute<{ total: number }>(sql`select count(*)::int as total ${from} where ${condition}`)
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const offset = Math.max(options.offset ?? 0, 0)
  const rows = await tx.execute<Omit<MovementListItem, "quantity" | "affectsStock" | "purchaseOrderLabel"> & { purchaseOrderNumber: number | null }>(sql`
    select m.id, ${iso(sql`m.created_at`)} as "createdAt", m.kind, m.quantity_delta as "quantityDelta", m.reason,
      m.product_id as "productId", p.name as "productName", p.sku as "productSku", p.unit, p.purchase_unit as "purchaseUnit",
      p.purchase_factor as "purchaseFactor",
      m.lot_id as "lotId", l.code as "lotCode", l.expires_at::text as "lotExpiresAt",
      aw.branch_id as "branchId", ab.name as "branchName", m.warehouse_id as "warehouseId", w.name as "warehouseName",
      case when m.kind = 'traslado' then w.branch_id end as "fromBranchId", case when m.kind = 'traslado' then wb.name end as "fromBranchName",
      case when m.kind = 'traslado' then dw.branch_id end as "toBranchId", case when m.kind = 'traslado' then db.name end as "toBranchName",
      m.dest_warehouse_id as "destWarehouseId", dw.name as "destWarehouseName",
      m.actor_user_id as "actorUserId", u.name as "actorName",
      m.patient_id as "patientId", pp.display_name as "patientName", pa.person_id as "personId",
      m.encounter_id as "encounterId",
      m.purchase_order_id as "purchaseOrderId", o.order_number as "purchaseOrderNumber",
      m.charge_id as "chargeId", ch.description as "chargeDescription"
    ${from}
    join branch ab on ab.organization_id = aw.organization_id and ab.id = aw.branch_id
    join warehouse w on w.organization_id = m.organization_id and w.id = m.warehouse_id
    join branch wb on wb.organization_id = w.organization_id and wb.id = w.branch_id
    left join warehouse dw on dw.organization_id = m.organization_id and dw.id = m.dest_warehouse_id
    left join branch db on db.organization_id = dw.organization_id and db.id = dw.branch_id
    left join product_lot l on l.organization_id = m.organization_id and l.id = m.lot_id
    left join "user" u on u.id = m.actor_user_id
    left join patient pa on pa.organization_id = m.organization_id and pa.id = m.patient_id
    left join contact pp on pp.organization_id = pa.organization_id and pp.id = pa.person_id
    left join purchase_order o on o.organization_id = m.organization_id and o.id = m.purchase_order_id
    left join patient_charge ch on ch.organization_id = m.organization_id and ch.id = m.charge_id
    where ${condition}
    -- Las filas de una misma operación comparten el instante: la clave dice su orden.
    order by m.created_at desc, m.idempotency_key desc, m.id desc
    limit ${limit} offset ${offset}`)
  return {
    total: count?.total ?? 0,
    items: rows.map((row) => {
      const orderNumber = row.purchaseOrderNumber == null ? null : Number(row.purchaseOrderNumber)
      return {
        ...row,
        quantity: Math.abs(row.quantityDelta),
        affectsStock: row.kind !== "cobertura",
        purchaseOrderNumber: orderNumber,
        purchaseOrderLabel: orderNumber == null ? null : purchaseOrderLabel(orderNumber),
      }
    }),
  }
}

/* ---------------- Inicio ---------------- */

/**
 * La fila de «Te espera» de cada sede para quien pide las compras: «Inventario
 * de Miraflores: 3 productos hacen falta y 1 lote venció», con nombres de
 * ejemplo (hasta tres de lo que hace falta, de lo más urgente; hasta dos
 * vencidos, del que venció primero). Sale del estado: se va sola cuando ya no
 * falta nada.
 */
export async function inventoryWaiting(tx: Db, orgId: string, now = new Date()): Promise<WaitingInventory[]> {
  const sedes = await tx
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .orderBy(asc(branch.createdAt), asc(branch.id))
  if (sedes.length === 0) return []
  const { today, horizon } = await todayOf(tx, orgId, now)
  const products = await tx
    .select({ id: product.id, name: product.name, isActive: product.isActive })
    .from(product)
    .where(and(eq(product.organizationId, orgId), eq(product.isActive, true)))
  const statusAt = await sedeFigures(tx, orgId, sedes.map((sede) => sede.id), today, horizon)
  const expired = await tx.execute<{ branchId: string; productName: string; expiresAt: string }>(sql`
    select w.branch_id as "branchId", p.name as "productName", l.expires_at::text as "expiresAt"
    from product_lot l
    join warehouse w on w.organization_id = l.organization_id and w.id = l.warehouse_id
    join product p on p.organization_id = l.organization_id and p.id = l.product_id
    where l.organization_id = ${orgId} and l.quantity_on_hand > 0 and l.expires_at < ${today}::date
    order by l.expires_at, p.name`)
  const out: WaitingInventory[] = []
  for (const sede of sedes) {
    const needing = products
      .map((item) => ({ name: item.name, status: statusAt(sede.id, item) }))
      .filter((item) => item.status.needs)
      .sort((a, b) => STATE_RANK[a.status.state] - STATE_RANK[b.status.state] || byName(a, b))
    const lots = expired.filter((row) => row.branchId === sede.id)
    if (needing.length === 0 && lots.length === 0) continue
    const examples: WaitingInventory["expired"] = []
    for (const lot of lots) {
      if (examples.length === 2) break
      if (!examples.some((row) => row.productName === lot.productName)) examples.push({ productName: lot.productName, expiresAt: lot.expiresAt })
    }
    out.push({
      branchId: sede.id,
      branchName: sede.name,
      needed: needing.length,
      neededNames: needing.slice(0, 3).map((item) => item.name),
      expiredLots: lots.length,
      expired: examples,
    })
  }
  return out
}
