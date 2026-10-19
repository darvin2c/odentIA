/**
 * Inventario por sede: proveedores, almacenes, productos, compras con
 * recepción parcial, lotes con vencimiento y ledger inmutable de stock.
 *
 * Toda función recibe `tx: Db` ya contextualizado (`withOrgContext`).
 * Concurrencia: cada mutación de saldo bloquea la fila del lote con
 * `FOR UPDATE`; el chequeo de no-negativo se valida en servicio Y en
 * constraint SQL (`product_lot_onhand_check`). El ledger (`stock_movement`)
 * nunca se edita ni borra: los errores se corrigen con un ajuste inverso.
 * Compras ≠ pagos: la orden registra compromiso comercial referencial y no
 * toca el ledger financiero (contrato coordinado con Finanzas, que reutiliza
 * el catálogo `supplier` de este dominio en vez de duplicarlo). Su pago es un
 * gasto de Materiales enlazado a la orden (`payPurchaseOrder` de Finanzas;
 * ADR 0061) y lo que se debe de cada una sale de `purchase-balance.ts`.
 */
import { canAccess, ORG_ROLES } from "@odentia/auth/permissions"
import type { Db } from "@odentia/db"
import {
  PRODUCT_KINDS,
  PURCHASE_ORDER_STATUSES,
  product,
  productLot,
  purchaseOrder,
  purchaseOrderLine,
  STOCK_MOVEMENT_KINDS,
  type StockMovementKind,
  stockMovement,
  supplier,
  supplierCreditUse,
  warehouse,
} from "@odentia/db/schema/inventory"
import { orgCounter, patient } from "@odentia/db/schema/clinical"
import { expense } from "@odentia/db/schema/finance"
import { member, user } from "@odentia/db/schema/auth"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte, type SQL, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { foldedWordsMatch } from "./search-text.js"
import {
  branchNotFound,
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
import { findOrgLocale, requireOrgCurrency } from "./locale.js"
import { type PurchaseBalance, purchaseBalances, supplierCredits } from "./purchase-balance.js"
import { createWorkspaceNotification, settleWorkspaceNotifications } from "./workspace.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"

/* ---------------- validaciones ---------------- */

function textRequired(value: string | null | undefined, field: string, max = 200): string {
  const text = value?.trim() ?? ""
  if (!text || text.length > max) throw validation(`${field} debe tener 1–${max} caracteres`)
  return text
}

function textOptional(value: string | null | undefined, field: string, max = 500): string | null {
  if (value == null) return null
  const text = value.trim()
  if (!text) return null
  if (text.length > max) throw validation(`${field} admite hasta ${max} caracteres`)
  return text
}

function quantity(value: number, field = "La cantidad"): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000_000)
    throw validation(`${field} debe ser un entero positivo`)
  return value
}

function delta(value: number): number {
  if (!Number.isSafeInteger(value) || value === 0 || Math.abs(value) > 1_000_000_000)
    throw validation("El ajuste debe ser un entero distinto de cero")
  return value
}

/** Importe en la unidad menor de la moneda; el tope es el de la columna (`integer`). */
function cents(value: number, field = "El costo por unidad"): number {
  if (!Number.isSafeInteger(value) || value < 0) throw validation(`${field} no es un importe válido`)
  if (value > 2_147_483_647) throw validation(`${field} es demasiado alto`)
  return value
}

function currency(value: string): string {
  if (!/^[A-Z]{3}$/.test(value)) throw validation("La moneda de la orden no es válida")
  return value
}

/** Un día `AAAA-MM-DD` dicho como lo lee la clínica («30 jun 2028»). */
function dayWords(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`))
}

/** «Hoy» en la zona de la clínica, como `AAAA-MM-DD`: un lote vence a medianoche de su sede, no de UTC. */
function localToday(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

function dateOnly(value: string | null | undefined, field: string): string | null {
  if (value == null || value === "") return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw validation(`${field} debe ser AAAA-MM-DD`)
  const time = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(time)) throw validation(`${field} no es una fecha válida`)
  return value
}

function conflict(message: string): ServiceError {
  return new ServiceError("CONFLICT", 409, message)
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  entity: string,
  id: string,
  action: string,
) {
  await tx
    .insert(auditEvent)
    .values({ organizationId: orgId, actorUserId, entity, entityId: id, action })
}

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

async function requireProduct(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(product)
    .where(and(eq(product.organizationId, orgId), eq(product.id, id)))
    .limit(1)
  if (!row) throw notFound("Producto")
  return row
}

async function requireBranch(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select({ id: branch.id })
    .from(branch)
    .where(
      and(eq(branch.organizationId, orgId), eq(branch.id, id), eq(branch.isActive, true)),
    )
    .limit(1)
  if (!row) throw branchNotFound()
  return row
}

/** Paciente del tenant: el consumo clínico siempre queda vinculado y validado. */
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

/** Bloquea el lote para mutar su saldo de forma concurrente y segura. */
async function lockLot(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(productLot)
    .where(and(eq(productLot.organizationId, orgId), eq(productLot.id, id)))
    .for("update")
    .limit(1)
  if (!row) throw notFound("Lote")
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
    .orderBy(asc(purchaseOrderLine.createdAt))
}

/** Los roles que leen el inventario: a ellos llega el aviso de stock bajo. */
const INVENTORY_READERS = ORG_ROLES.filter((role) => canAccess(role, "inventory.read"))

/**
 * Aviso de stock bajo mínimo para todo el equipo que lee el inventario, con la
 * unidad del producto. Quien hizo el movimiento no lo recibe: ya lo vio
 * (`actorUserId`, regla de la campana).
 */
async function notifyLowStock(
  tx: Db,
  orgId: string,
  actorUserId: string,
  item: { id: string; name: string; unit: string; minStock: number },
  onHand: number,
) {
  const readers = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, INVENTORY_READERS)))
  for (const userId of new Set(readers.map((row) => row.userId))) {
    await createWorkspaceNotification(tx, orgId, {
      userId,
      dedupeKey: `inventory:low-stock:${item.id}`,
      title: `Stock bajo: ${item.name}`,
      body: `Quedan ${onHand} (${item.unit}) y el mínimo es ${item.minStock}. Revisa el inventario para reponer.`,
      href: `/inventory/${item.id}`,
      permission: "inventory.read",
      // Se retira al reponerse; si vuelve a bajar, avisa otra vez.
      subject: `producto:${item.id}`,
      actorUserId,
    })
  }
}

async function productOnHand(tx: Db, orgId: string, productId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${productLot.quantityOnHand}), 0)` })
    .from(productLot)
    .where(and(eq(productLot.organizationId, orgId), eq(productLot.productId, productId)))
  return Number(row?.total ?? 0)
}

async function checkLowStock(
  tx: Db,
  orgId: string,
  actorUserId: string,
  productId: string,
): Promise<void> {
  const item = await requireProduct(tx, orgId, productId)
  const onHand = await productOnHand(tx, orgId, productId)
  // Un producto desactivado no avisa: su aviso se retira solo (`settleWorkspaceNotifications`).
  if (item.isActive && onHand < item.minStock) {
    await notifyLowStock(tx, orgId, actorUserId, item, onHand)
  } else {
    // Repuesto: el aviso anterior se retira ya, para que una nueva bajada vuelva a avisar.
    await settleWorkspaceNotifications(tx, orgId, { subject: `producto:${productId}` })
  }
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
 * El tipo de documento tributario es el del país del proveedor: lo escribe
 * quien registra y aquí no se asume ninguno. Un número sin su tipo no se
 * guarda, porque el tipo es parte de lo que lo hace único.
 */
function assertSupplierDocument(docType: string | null, docNumber: string | null): void {
  if (docNumber && !docType) throw validation("Indica el tipo de documento del proveedor junto con su número")
}

export async function createSupplier(tx: Db, orgId: string, actorUserId: string, input: SupplierInput) {
  const name = textRequired(input.name, "El nombre del proveedor")
  const docNumber = textOptional(input.docNumber, "El documento", 50)
  const docType = textOptional(input.docType, "El tipo de documento", 20)
  assertSupplierDocument(docType, docNumber)
  try {
    const [row] = await tx
      .insert(supplier)
      .values({
        organizationId: orgId,
        name,
        docType,
        docNumber,
        email: textOptional(input.email, "El correo", 200),
        phone: textOptional(input.phone, "El teléfono", 50),
        address: textOptional(input.address, "La dirección"),
      })
      .returning()
    await audit(tx, orgId, actorUserId, "supplier", row.id, "supplier.created")
    return row
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("Ya existe un proveedor con ese documento")
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
  if (input.name !== undefined) patch.name = textRequired(input.name, "El nombre del proveedor")
  if (input.docNumber !== undefined) patch.docNumber = textOptional(input.docNumber, "El documento", 50)
  if (input.docType !== undefined) patch.docType = textOptional(input.docType, "El tipo de documento", 20)
  if (input.email !== undefined) patch.email = textOptional(input.email, "El correo", 200)
  if (input.phone !== undefined) patch.phone = textOptional(input.phone, "El teléfono", 50)
  if (input.address !== undefined) patch.address = textOptional(input.address, "La dirección")
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
    if (isUniqueViolation(e)) throw conflict("Ya existe un proveedor con ese documento")
    throw e
  }
}

export async function setSupplierActive(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  isActive: boolean,
) {
  await requireSupplier(tx, orgId, id)
  const [row] = await tx
    .update(supplier)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(supplier.organizationId, orgId), eq(supplier.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, "supplier", id, isActive ? "supplier.reactivated" : "supplier.deactivated")
  return row
}

export async function listSuppliers(tx: Db, orgId: string, options?: { q?: string; onlyActive?: boolean }) {
  const conditions = [eq(supplier.organizationId, orgId)]
  if (options?.onlyActive) conditions.push(eq(supplier.isActive, true))
  const q = options?.q?.trim()
  if (q) conditions.push(foldedWordsMatch([supplier.name, supplier.docNumber], q))
  return tx.select().from(supplier).where(and(...conditions)).orderBy(asc(supplier.name)).limit(200)
}

/* ---------------- almacenes ---------------- */

export async function createWarehouse(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { branchId: string; name: string },
) {
  await requireBranch(tx, orgId, input.branchId)
  const [row] = await tx
    .insert(warehouse)
    .values({ organizationId: orgId, branchId: input.branchId, name: textRequired(input.name, "El nombre del almacén") })
    .returning()
  await audit(tx, orgId, actorUserId, "warehouse", row.id, "warehouse.created")
  return row
}

export async function setWarehouseActive(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  isActive: boolean,
) {
  await requireWarehouse(tx, orgId, id)
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

export async function listWarehouses(tx: Db, orgId: string, onlyActive = false) {
  const conditions = [eq(warehouse.organizationId, orgId)]
  if (onlyActive) conditions.push(eq(warehouse.isActive, true))
  return tx
    .select({
      id: warehouse.id,
      branchId: warehouse.branchId,
      branchName: branch.name,
      name: warehouse.name,
      isActive: warehouse.isActive,
      createdAt: warehouse.createdAt,
    })
    .from(warehouse)
    .leftJoin(branch, eq(branch.id, warehouse.branchId))
    .where(and(...conditions))
    .orderBy(asc(warehouse.name))
    .limit(200)
}

/* ---------------- productos ---------------- */

export interface ProductInput {
  sku: string
  name: string
  kind?: string
  unit?: string
  minStock?: number
}

function productKind(value: string | undefined): string {
  const kind = (value ?? "insumo").trim()
  if (!(PRODUCT_KINDS as readonly string[]).includes(kind))
    throw validation("El tipo debe ser insumo o producto")
  return kind
}

function productMinStock(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0)
    throw validation("El stock mínimo debe ser un entero mayor o igual a cero")
  return value
}

function productPatch(input: Partial<ProductInput>) {
  const patch: Partial<typeof product.$inferInsert> = {}
  if (input.sku !== undefined) patch.sku = textRequired(input.sku, "El SKU", 60)
  if (input.name !== undefined) patch.name = textRequired(input.name, "El nombre del producto")
  if (input.kind !== undefined) patch.kind = productKind(input.kind)
  // Unidad declarada tal cual: el sistema jamás convierte unidades.
  if (input.unit !== undefined) patch.unit = textRequired(input.unit, "La unidad", 60)
  if (input.minStock !== undefined) patch.minStock = productMinStock(input.minStock)
  return patch
}

async function productHasHistory(tx: Db, orgId: string, id: string): Promise<boolean> {
  const [row] = await tx.execute<{ used: boolean }>(sql`
    select exists (select 1 from stock_movement where organization_id = ${orgId} and product_id = ${id})
      or exists (select 1 from purchase_order_line where organization_id = ${orgId} and product_id = ${id}) as used`)
  return row?.used === true
}

export async function createProduct(tx: Db, orgId: string, actorUserId: string, input: ProductInput) {
  try {
    const [row] = await tx
      .insert(product)
      .values({
        organizationId: orgId,
        sku: textRequired(input.sku, "El SKU", 60),
        name: textRequired(input.name, "El nombre del producto"),
        kind: productKind(input.kind),
        unit: textRequired(input.unit ?? "unidad", "La unidad", 60),
        minStock: productMinStock(input.minStock) ?? 0,
      })
      .returning()
    await audit(tx, orgId, actorUserId, "product", row.id, "product.created")
    return row
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("Ya existe un producto con ese SKU")
    throw e
  }
}

export async function updateProduct(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: Partial<ProductInput>,
) {
  const current = await requireProduct(tx, orgId, id)
  const patch = productPatch(input)
  const changesUnit = patch.unit !== undefined && patch.unit !== current.unit
  const changesKind = patch.kind !== undefined && patch.kind !== current.kind
  // Lo ya movido o comprado se contó en su unidad y con su tipo: cambiarlos
  // reescribiría la historia sin convertirla (el sistema no convierte unidades).
  if ((changesUnit || changesKind) && (await productHasHistory(tx, orgId, id)))
    throw conflict(
      changesUnit
        ? `La unidad no se puede cambiar: este producto ya tiene movimientos o compras en «${current.unit}». Si cambió la presentación, crea otro producto.`
        : "El tipo no se puede cambiar: este producto ya tiene movimientos o compras.",
    )
  try {
    const [row] = await tx
      .update(product)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(product.organizationId, orgId), eq(product.id, id)))
      .returning()
    await audit(tx, orgId, actorUserId, "product", id, "product.updated")
    return row
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("Ya existe un producto con ese SKU")
    throw e
  }
}

export async function setProductActive(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  isActive: boolean,
) {
  await requireProduct(tx, orgId, id)
  const [row] = await tx
    .update(product)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(product.organizationId, orgId), eq(product.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, "product", id, isActive ? "product.reactivated" : "product.deactivated")
  return row
}

export interface ProductListItem {
  id: string
  sku: string
  name: string
  kind: string
  unit: string
  minStock: number
  isActive: boolean
  onHand: number
  lowStock: boolean
}

export async function listProducts(
  tx: Db,
  orgId: string,
  options?: { q?: string; kind?: string; lowStock?: boolean; onlyActive?: boolean },
): Promise<ProductListItem[]> {
  const conditions = [eq(product.organizationId, orgId)]
  if (options?.onlyActive) conditions.push(eq(product.isActive, true))
  if (options?.kind) {
    if (!(PRODUCT_KINDS as readonly string[]).includes(options.kind))
      throw validation("El tipo debe ser insumo o producto")
    conditions.push(eq(product.kind, options.kind))
  }
  const q = options?.q?.trim()
  if (q) conditions.push(foldedWordsMatch([product.name, product.sku], q))
  const onHand = sql<number>`coalesce(sum(${productLot.quantityOnHand}), 0)`
  const rows = await tx
    .select({
      id: product.id,
      sku: product.sku,
      name: product.name,
      kind: product.kind,
      unit: product.unit,
      minStock: product.minStock,
      isActive: product.isActive,
      onHand,
    })
    .from(product)
    .leftJoin(
      productLot,
      and(
        eq(productLot.organizationId, orgId),
        eq(productLot.productId, product.id),
      ),
    )
    .where(and(...conditions))
    .groupBy(product.id, product.sku, product.name, product.kind, product.unit, product.minStock, product.isActive)
    // «Bajo mínimo» va en la consulta, antes del tope: uno que quedaría más allá del 500 también sale.
    .having(options?.lowStock ? sql`${onHand} < ${product.minStock}` : undefined)
    .orderBy(asc(product.name))
    .limit(500)
  return rows.map((row) => ({
    ...row,
    onHand: Number(row.onHand ?? 0),
    lowStock: Number(row.onHand ?? 0) < row.minStock,
  }))
}

export async function getProductDetail(tx: Db, orgId: string, id: string) {
  const item = await requireProduct(tx, orgId, id)
  const lots = await tx
    .select({
      id: productLot.id,
      code: productLot.code,
      warehouseId: productLot.warehouseId,
      warehouseName: warehouse.name,
      supplierId: productLot.supplierId,
      purchaseOrderId: productLot.purchaseOrderId,
      expiresAt: productLot.expiresAt,
      quantityOnHand: productLot.quantityOnHand,
      createdAt: productLot.createdAt,
    })
    .from(productLot)
    .leftJoin(
      warehouse,
      and(eq(warehouse.organizationId, orgId), eq(warehouse.id, productLot.warehouseId)),
    )
    .where(and(eq(productLot.organizationId, orgId), eq(productLot.productId, id)))
    .orderBy(asc(productLot.expiresAt), asc(productLot.createdAt))
    .limit(200)
  const movements = await listMovements(tx, orgId, { productId: id, limit: 100 })
  const onHand = lots.reduce((sum, lot) => sum + lot.quantityOnHand, 0)
  return { ...item, onHand, lowStock: onHand < item.minStock, lots, movements }
}

/* ---------------- órdenes de compra ---------------- */

export interface PurchaseOrderLineInput {
  productId: string
  quantity: number
  unitCostCents?: number
}

export async function createPurchaseOrder(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: {
    supplierId: string
    warehouseId: string
    currency?: string
    notes?: string | null
    lines: PurchaseOrderLineInput[]
  },
) {
  const dest = await requireWarehouse(tx, orgId, input.warehouseId)
  if (!dest.isActive) throw conflict("El almacén destino está desactivado")
  const sup = await requireSupplier(tx, orgId, input.supplierId)
  if (!sup.isActive) throw conflict("El proveedor está desactivado")
  if (!input.lines?.length) throw validation("La orden necesita al menos una línea")
  if (input.lines.length > 200) throw validation("La orden admite hasta 200 líneas")
  const seen = new Set<string>()
  for (const line of input.lines) {
    if (seen.has(line.productId)) throw validation("La orden no admite el mismo producto dos veces")
    seen.add(line.productId)
    const item = await requireProduct(tx, orgId, line.productId)
    if (!item.isActive) throw conflict(`El producto ${item.sku} está desactivado`)
    quantity(line.quantity)
    cents(line.unitCostCents ?? 0)
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
      warehouseId: input.warehouseId,
      currency: currency(input.currency ?? (await requireOrgCurrency(tx, orgId))),
      notes: textOptional(input.notes, "Las notas", 2000),
      createdBy: actorUserId,
    })
    .returning()
  for (const line of input.lines) {
    await tx.insert(purchaseOrderLine).values({
      organizationId: orgId,
      orderId: order.id,
      productId: line.productId,
      quantity: line.quantity,
      unitCostCents: line.unitCostCents ?? 0,
    })
  }
  await audit(tx, orgId, actorUserId, "purchase_order", order.id, "purchase_order.created")
  return { ...order, lines: await orderLines(tx, orgId, order.id) }
}

export async function getPurchaseOrder(tx: Db, orgId: string, id: string) {
  const order = await requireOrder(tx, orgId, id)
  const lines = await tx
    .select({
      id: purchaseOrderLine.id,
      productId: purchaseOrderLine.productId,
      productSku: product.sku,
      productName: product.name,
      productUnit: product.unit,
      quantity: purchaseOrderLine.quantity,
      unitCostCents: purchaseOrderLine.unitCostCents,
      receivedQuantity: purchaseOrderLine.receivedQuantity,
    })
    .from(purchaseOrderLine)
    .leftJoin(
      product,
      and(eq(product.organizationId, orgId), eq(product.id, purchaseOrderLine.productId)),
    )
    .where(
      and(eq(purchaseOrderLine.organizationId, orgId), eq(purchaseOrderLine.orderId, id)),
    )
  const [sup] = await tx
    .select({ name: supplier.name })
    .from(supplier)
    .where(and(eq(supplier.organizationId, orgId), eq(supplier.id, order.supplierId)))
    .limit(1)
  const totalCents = lines.reduce((sum, line) => sum + line.quantity * line.unitCostCents, 0)
  const [balance] = await purchaseBalances(tx, orgId, { orderIds: [id] })
  return {
    ...order,
    supplierName: sup?.name ?? null,
    lines,
    totalCents,
    /** Recibido, pagado y por pagar (ADR 0061). */
    balance: balance ?? null,
    payments: await purchasePayments(tx, orgId, id),
    /** Lo que se tiene a favor con este proveedor, en la moneda de la orden. */
    supplierCreditCents: (await supplierCredits(tx, orgId, { supplierId: order.supplierId })).find((item) => item.currency === order.currency)?.cents ?? 0,
  }
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

/** «Por pagar»: recibidas con algo sin pagar. */
export const PURCHASE_PAYMENT_FILTERS = ["por_pagar"] as const

export async function listPurchaseOrders(
  tx: Db,
  orgId: string,
  options?: { status?: string; supplierId?: string; payment?: (typeof PURCHASE_PAYMENT_FILTERS)[number] },
) {
  const conditions = [eq(purchaseOrder.organizationId, orgId)]
  if (options?.status) {
    if (!(PURCHASE_ORDER_STATUSES as readonly string[]).includes(options.status))
      throw validation("Estado de orden inválido")
    conditions.push(eq(purchaseOrder.status, options.status))
  }
  if (options?.supplierId) conditions.push(eq(purchaseOrder.supplierId, options.supplierId))
  if (options?.payment === "por_pagar") {
    // El filtro va en la consulta, antes del tope: una compra vieja por pagar no queda fuera.
    const due = await purchaseBalances(tx, orgId, { dueOnly: true, supplierId: options.supplierId })
    if (due.length === 0) return []
    conditions.push(inArray(purchaseOrder.id, due.map((row) => row.orderId)))
  }
  const rows = await tx
    .select({
      id: purchaseOrder.id,
      orderNumber: purchaseOrder.orderNumber,
      status: purchaseOrder.status,
      currency: purchaseOrder.currency,
      notes: purchaseOrder.notes,
      supplierId: purchaseOrder.supplierId,
      supplierName: supplier.name,
      warehouseId: purchaseOrder.warehouseId,
      warehouseName: warehouse.name,
      createdAt: purchaseOrder.createdAt,
    })
    .from(purchaseOrder)
    .leftJoin(
      supplier,
      and(eq(supplier.organizationId, orgId), eq(supplier.id, purchaseOrder.supplierId)),
    )
    .leftJoin(
      warehouse,
      and(eq(warehouse.organizationId, orgId), eq(warehouse.id, purchaseOrder.warehouseId)),
    )
    .where(and(...conditions))
    .orderBy(desc(purchaseOrder.createdAt))
    .limit(200)
  const balances = new Map(
    (await purchaseBalances(tx, orgId, { orderIds: rows.map((row) => row.id) })).map((balance) => [balance.orderId, balance]),
  )
  return rows.map((row) => ({ ...row, balance: balances.get(row.id) ?? null }))
}

/** Cómo se dice el estado de una orden en un mensaje: nunca con su código. */
const ORDER_STATUS_WORDS: Record<string, string> = {
  borrador: "está en borrador",
  confirmada: "ya está confirmada",
  parcialmente_recibida: "ya se recibió en parte",
  recibida: "ya se recibió entera",
  cancelada: "está cancelada",
}

function requireEditableStatus(order: { status: string }, action: string) {
  if (order.status === "recibida" || order.status === "cancelada")
    throw conflict(`La orden ${ORDER_STATUS_WORDS[order.status]} y ya no admite ${action}`)
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
    throw conflict("La orden ya tiene recepciones y no puede cancelarse")
  const [balance] = await purchaseBalances(tx, orgId, { orderIds: [id] })
  if (balance && balance.paidCents > 0) {
    if (!input.payments)
      throw new ServiceError(
        "PURCHASE_HAS_PAYMENTS",
        409,
        "La orden ya tiene pagos: elige si se anulan o quedan a favor con el proveedor",
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

export type { PurchaseBalance }

export interface ReceptionLineInput {
  productId: string
  quantity: number
  lotCode?: string | null
  expiresAt?: string | null
}

/**
 * Recepción parcial o total: ingresa el saldo en un lote por línea con su
 * movimiento `ingreso` trazable a la orden.
 *
 * Idempotencia por clave del cliente: `idempotencyKey` es un UUID generado
 * por quien registra la recepción y persistente a reintentos. Dos entregas
 * legítimas con el mismo contenido usan claves distintas y ambas aplican;
 * reintentar la misma clave devuelve lo ya aplicado aunque esa recepción haya
 * completado la orden (la clave se mira antes que el estado), y con otro
 * contenido responde un conflicto sin efectos. La orden y sus líneas se
 * bloquean (FOR UPDATE): recepciones concurrentes se serializan y el tope
 * pedido se valida con datos frescos.
 *
 * Sin código de lote, el lote lleva el número de la orden («OC-0012»). Un lote
 * que ya existe con ese código se reutiliza, pero no con otro vencimiento: el
 * dato no se ignora en silencio.
 */
export async function receivePurchaseOrder(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  lines: ReceptionLineInput[],
  idempotencyKey: string,
) {
  const receptionKey = idempotencyKey?.trim() ?? ""
  // La pone la pantalla al abrir la orden: sin ella no se distingue un reintento de otra entrega.
  if (!receptionKey || receptionKey.length > 200)
    throw validation("No se pudo identificar esta recepción: vuelve a abrir la orden e inténtalo de nuevo")
  if (!lines?.length) throw validation("La recepción necesita al menos una línea")
  const incoming = new Map<string, ReceptionLineInput>()
  for (const line of lines) {
    if (incoming.has(line.productId))
      throw validation("La recepción repite un producto: suma sus cantidades en una sola línea")
    incoming.set(line.productId, line)
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
  const keyOf = (productId: string) => `po:${id}:${receptionKey}:${productId}`
  const prior = await tx
    .select({
      productId: stockMovement.productId,
      delta: stockMovement.quantityDelta,
      lotCode: productLot.code,
      expiresAt: productLot.expiresAt,
    })
    .from(stockMovement)
    .leftJoin(productLot, and(eq(productLot.organizationId, orgId), eq(productLot.id, stockMovement.lotId)))
    .where(
      and(
        eq(stockMovement.organizationId, orgId),
        inArray(stockMovement.idempotencyKey, expected.map((line) => keyOf(line.productId))),
      ),
    )
  if (prior.length > 0) {
    // Un reintento trae lo mismo que ya se aplicó: se devuelve sin tocar nada.
    const same =
      prior.length === incoming.size &&
      prior.every((row) => {
        const line = incoming.get(row.productId)
        return (
          line !== undefined &&
          line.quantity === row.delta &&
          (line.lotCode?.trim() || label) === row.lotCode &&
          (!line.expiresAt || line.expiresAt === row.expiresAt)
        )
      })
    if (!same)
      throw conflict("Esta recepción ya se registró con otros datos. Cierra la orden y vuelve a abrirla para ver lo que llegó.")
    return { ...order, lines: await orderLines(tx, orgId, id) }
  }
  requireEditableStatus(order, "recepción")
  if (order.status !== "confirmada" && order.status !== "parcialmente_recibida")
    throw conflict("Confirma la orden antes de recibir la mercadería")
  const byProduct = new Map(expected.map((line) => [line.productId, line]))
  for (const line of lines) {
    const exp = byProduct.get(line.productId)
    if (!exp) throw validation("La recepción incluye un producto que no está en la orden")
    quantity(line.quantity, "La cantidad recibida")
    if (exp.receivedQuantity + line.quantity > exp.quantity)
      throw conflict(`La recepción supera lo pedido: de ese producto faltan ${exp.quantity - exp.receivedQuantity}`)
    dateOnly(line.expiresAt, "El vencimiento")
  }
  for (const line of lines) {
    const lotCode = line.lotCode?.trim() || label
    const expiresAt = dateOnly(line.expiresAt, "El vencimiento")
    let [lot] = await tx
      .select()
      .from(productLot)
      .where(
        and(
          eq(productLot.organizationId, orgId),
          eq(productLot.productId, line.productId),
          eq(productLot.warehouseId, order.warehouseId),
          eq(productLot.code, lotCode),
        ),
      )
      .limit(1)
    if (lot && expiresAt && lot.expiresAt !== expiresAt) {
      const { locale } = await findOrgLocale(tx, orgId)
      const item = await requireProduct(tx, orgId, line.productId)
      throw conflict(
        lot.expiresAt
          ? `El lote ${lotCode} de ${item.name} ya existe y vence el ${dayWords(lot.expiresAt, locale)}: escribe el código del lote que vence el ${dayWords(expiresAt, locale)}.`
          : `El lote ${lotCode} de ${item.name} ya existe sin vencimiento: escribe el código del lote que vence el ${dayWords(expiresAt, locale)}.`,
      )
    }
    if (!lot) {
      const [created] = await tx
        .insert(productLot)
        .values({
          organizationId: orgId,
          productId: line.productId,
          warehouseId: order.warehouseId,
          supplierId: order.supplierId,
          purchaseOrderId: id,
          code: lotCode,
          expiresAt,
          quantityOnHand: 0,
          createdBy: actorUserId,
        })
        .returning()
      lot = created
    }
    const locked = await lockLot(tx, orgId, lot.id)
    await tx
      .update(productLot)
      .set({ quantityOnHand: locked.quantityOnHand + line.quantity, updatedAt: new Date() })
      .where(and(eq(productLot.organizationId, orgId), eq(productLot.id, lot.id)))
    await tx.insert(stockMovement).values({
      organizationId: orgId,
      productId: line.productId,
      lotId: lot.id,
      warehouseId: order.warehouseId,
      kind: "ingreso",
      quantityDelta: line.quantity,
      reason: `Recepción de ${label} · lote ${lotCode}`,
      actorUserId,
      purchaseOrderId: id,
      idempotencyKey: keyOf(line.productId),
    })
    await tx
      .update(purchaseOrderLine)
      .set({
        receivedQuantity: sql`${purchaseOrderLine.receivedQuantity} + ${line.quantity}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(purchaseOrderLine.organizationId, orgId),
          eq(purchaseOrderLine.orderId, id),
          eq(purchaseOrderLine.productId, line.productId),
        ),
      )
  }
  const refreshed = await orderLines(tx, orgId, id)
  const complete = refreshed.every((line) => line.receivedQuantity >= line.quantity)
  const [row] = await tx
    .update(purchaseOrder)
    .set({ status: complete ? "recibida" : "parcialmente_recibida", updatedAt: new Date() })
    .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, "purchase_order", id, "purchase_order.received")
  for (const line of lines) await checkLowStock(tx, orgId, actorUserId, line.productId)
  return { ...row, lines: refreshed }
}

/* ---------------- movimientos ---------------- */

export interface MovementInput {
  productId: string
  kind: StockMovementKind
  /** ingreso/consumo/traslado: cantidad positiva; ajuste: delta con signo. */
  quantity: number
  lotId?: string | null
  warehouseId?: string | null
  destWarehouseId?: string | null
  reason?: string | null
  patientId?: string | null
  /**
   * Una por formulario abierto, que se conserva en los reintentos y cambia solo
   * después de guardar: así un reintento no duplica el movimiento.
   */
  idempotencyKey: string
}

/** Lo que dice un movimiento: un reintento con la misma clave trae exactamente esto. */
type MovementContent = Pick<
  typeof stockMovement.$inferSelect,
  "productId" | "kind" | "lotId" | "warehouseId" | "destWarehouseId" | "quantityDelta" | "reason" | "patientId"
>

const REUSED_MOVEMENT_KEY =
  "Este movimiento ya se registró con otros datos. Cierra el formulario y vuelve a abrirlo para registrar uno nuevo."

function sameMovement(row: MovementContent, expected: MovementContent): boolean {
  return (
    row.productId === expected.productId &&
    row.kind === expected.kind &&
    row.lotId === expected.lotId &&
    row.warehouseId === expected.warehouseId &&
    (row.destWarehouseId ?? null) === (expected.destWarehouseId ?? null) &&
    row.quantityDelta === expected.quantityDelta &&
    row.reason === expected.reason &&
    (row.patientId ?? null) === (expected.patientId ?? null)
  )
}

async function movementWithKey(tx: Db, orgId: string, key: string) {
  const [row] = await tx
    .select()
    .from(stockMovement)
    .where(and(eq(stockMovement.organizationId, orgId), eq(stockMovement.idempotencyKey, key)))
    .limit(1)
  return row ?? null
}

/**
 * El movimiento que ya quedó con esta clave. El mismo contenido es un
 * reintento y se devuelve sin tocar saldos; otro contenido es un conflicto.
 */
async function priorMovement(tx: Db, orgId: string, key: string, expected: MovementContent) {
  const row = await movementWithKey(tx, orgId, key)
  if (row && !sameMovement(row, expected)) throw conflict(REUSED_MOVEMENT_KEY)
  return row
}

/**
 * Inserta el movimiento. Si otra transacción con la misma clave ganó la
 * carrera, `ON CONFLICT DO NOTHING` espera a que confirme sin abortar esta, y
 * lo suyo se lee después: un reintento idéntico lo devuelve, otro contenido es
 * un conflicto.
 */
async function insertMovement(tx: Db, orgId: string, values: typeof stockMovement.$inferInsert & MovementContent) {
  const [row] = await tx
    .insert(stockMovement)
    .values(values)
    .onConflictDoNothing({ target: [stockMovement.organizationId, stockMovement.idempotencyKey] })
    .returning()
  if (row) return { row, inserted: true }
  const prior = await priorMovement(tx, orgId, values.idempotencyKey, values)
  if (!prior) throw conflict(REUSED_MOVEMENT_KEY)
  return { row: prior, inserted: false }
}

/**
 * Movimiento manual de stock con motivo y actor obligatorios. Nunca deja
 * saldos negativos; el traslado mueve entre almacenes en una sola
 * transacción (dos filas del ledger: salida y entrada).
 *
 * La clave se mira antes que el estado y el saldo: el reintento de un
 * movimiento ya hecho lo devuelve aunque después el saldo ya no alcance.
 */
export async function recordMovement(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: MovementInput,
) {
  if (!(STOCK_MOVEMENT_KINDS as readonly string[]).includes(input.kind))
    throw validation("Tipo de movimiento inválido")
  const idempotencyKey = input.idempotencyKey?.trim() ?? ""
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw validation("No se pudo identificar este movimiento: cierra el formulario y vuelve a abrirlo")
  const reason = textRequired(input.reason ?? "", "El motivo", 2000)
  const item = await requireProduct(tx, orgId, input.productId)

  if (input.kind === "traslado") {
    if (!input.lotId) throw validation("El traslado necesita el lote de origen")
    if (!input.destWarehouseId) throw validation("El traslado necesita el almacén de destino")
    const qty = quantity(input.quantity)
    const source = await lockLot(tx, orgId, input.lotId)
    if (source.productId !== input.productId) throw validation("El lote no pertenece al producto")
    const dest = await requireWarehouse(tx, orgId, input.destWarehouseId)
    if (source.warehouseId === dest.id) throw validation("El almacén de destino debe ser otro que el del lote")
    // Las dos filas guardan el origen en `warehouseId` y el destino en
    // `destWarehouseId`, como dice el esquema; el lote de cada una dice dónde quedó.
    const transfer = {
      productId: input.productId,
      kind: "traslado",
      warehouseId: source.warehouseId,
      destWarehouseId: dest.id,
      reason,
      patientId: null,
    }
    const outKey = `${idempotencyKey}:salida`
    const entryKey = `${idempotencyKey}:entrada`
    if (await priorMovement(tx, orgId, outKey, { ...transfer, lotId: source.id, quantityDelta: -qty })) {
      const entry = await movementWithKey(tx, orgId, entryKey)
      if (entry) return entry
    }
    if (!item.isActive) throw conflict("El producto está desactivado")
    if (!dest.isActive) throw conflict("El almacén de destino está desactivado")
    if (source.quantityOnHand < qty)
      throw conflict(`No alcanza el stock del lote de origen: quedan ${source.quantityOnHand} (${item.unit})`)
    const out = await insertMovement(tx, orgId, {
      organizationId: orgId,
      ...transfer,
      lotId: source.id,
      quantityDelta: -qty,
      actorUserId,
      idempotencyKey: outKey,
    })
    if (!out.inserted) {
      const entry = await movementWithKey(tx, orgId, entryKey)
      if (entry) return entry
      throw conflict(REUSED_MOVEMENT_KEY)
    }
    await tx
      .update(productLot)
      .set({ quantityOnHand: source.quantityOnHand - qty, updatedAt: new Date() })
      .where(and(eq(productLot.organizationId, orgId), eq(productLot.id, source.id)))
    let [destLot] = await tx
      .select()
      .from(productLot)
      .where(
        and(
          eq(productLot.organizationId, orgId),
          eq(productLot.productId, input.productId),
          eq(productLot.warehouseId, dest.id),
          eq(productLot.code, source.code),
        ),
      )
      .limit(1)
    if (!destLot) {
      const [created] = await tx
        .insert(productLot)
        .values({
          organizationId: orgId,
          productId: input.productId,
          warehouseId: dest.id,
          supplierId: source.supplierId,
          purchaseOrderId: source.purchaseOrderId,
          code: source.code,
          expiresAt: source.expiresAt,
          quantityOnHand: 0,
          createdBy: actorUserId,
        })
        .returning()
      destLot = created
    }
    const lockedDest = await lockLot(tx, orgId, destLot.id)
    await tx
      .update(productLot)
      .set({ quantityOnHand: lockedDest.quantityOnHand + qty, updatedAt: new Date() })
      .where(and(eq(productLot.organizationId, orgId), eq(productLot.id, destLot.id)))
    const entry = await insertMovement(tx, orgId, {
      organizationId: orgId,
      ...transfer,
      lotId: destLot.id,
      quantityDelta: qty,
      actorUserId,
      idempotencyKey: entryKey,
    })
    // La salida acaba de entrar con esta clave: una llegada ya escrita con ella no es de este traslado.
    if (!entry.inserted) throw conflict(REUSED_MOVEMENT_KEY)
    await audit(tx, orgId, actorUserId, "stock_movement", out.row.id, "stock.traslado")
    await checkLowStock(tx, orgId, actorUserId, input.productId)
    return entry.row
  }

  if (input.kind === "ajuste") {
    const qty = delta(input.quantity)
    if (!input.lotId) throw validation("El ajuste necesita el lote")
    const lot = await lockLot(tx, orgId, input.lotId)
    if (lot.productId !== input.productId) throw validation("El lote no pertenece al producto")
    const content = {
      productId: input.productId,
      kind: "ajuste",
      lotId: lot.id,
      warehouseId: lot.warehouseId,
      destWarehouseId: null,
      quantityDelta: qty,
      reason,
      patientId: null,
    }
    const prior = await priorMovement(tx, orgId, idempotencyKey, content)
    if (prior) return prior
    if (!item.isActive) throw conflict("El producto está desactivado")
    if (lot.quantityOnHand + qty < 0)
      throw conflict(`El ajuste dejaría el lote en negativo: quedan ${lot.quantityOnHand} (${item.unit})`)
    const { row, inserted } = await insertMovement(tx, orgId, {
      organizationId: orgId,
      ...content,
      actorUserId,
      idempotencyKey,
    })
    if (!inserted) return row
    await tx
      .update(productLot)
      .set({ quantityOnHand: lot.quantityOnHand + qty, updatedAt: new Date() })
      .where(and(eq(productLot.organizationId, orgId), eq(productLot.id, lot.id)))
    await audit(tx, orgId, actorUserId, "stock_movement", row.id, "stock.ajuste")
    await checkLowStock(tx, orgId, actorUserId, input.productId)
    return row
  }

  // ingreso directo o consumo clínico
  const qty = quantity(input.quantity)
  if (!input.lotId) throw validation(input.kind === "consumo" ? "El consumo necesita el lote" : "El ingreso necesita el lote")
  const lot = await lockLot(tx, orgId, input.lotId)
  if (lot.productId !== input.productId) throw validation("El lote no pertenece al producto")
  if (input.kind === "consumo" && !input.patientId)
    throw validation("El consumo clínico necesita el paciente atendido")
  const movementDelta = input.kind === "consumo" ? -qty : qty
  const content = {
    productId: input.productId,
    kind: input.kind,
    lotId: lot.id,
    warehouseId: lot.warehouseId,
    destWarehouseId: null,
    quantityDelta: movementDelta,
    reason,
    patientId: input.kind === "consumo" ? (input.patientId ?? null) : null,
  }
  const prior = await priorMovement(tx, orgId, idempotencyKey, content)
  if (prior) return prior
  if (!item.isActive) throw conflict("El producto está desactivado")
  if (input.kind === "consumo") {
    // Paciente de la clínica: el consumo clínico siempre queda vinculado y validado.
    await requireTenantPatient(tx, orgId, input.patientId ?? "")
    if (lot.quantityOnHand < qty)
      throw conflict(`No alcanza el stock del lote: quedan ${lot.quantityOnHand} (${item.unit})`)
  }
  const { row, inserted } = await insertMovement(tx, orgId, {
    organizationId: orgId,
    ...content,
    actorUserId,
    idempotencyKey,
  })
  if (!inserted) return row
  await tx
    .update(productLot)
    .set({ quantityOnHand: lot.quantityOnHand + movementDelta, updatedAt: new Date() })
    .where(and(eq(productLot.organizationId, orgId), eq(productLot.id, lot.id)))
  await audit(tx, orgId, actorUserId, "stock_movement", row.id, `stock.${input.kind}`)
  await checkLowStock(tx, orgId, actorUserId, input.productId)
  return row
}

export async function listMovements(
  tx: Db,
  orgId: string,
  options?: {
    productId?: string
    warehouseId?: string
    kind?: string
    patientId?: string
    from?: string
    to?: string
    limit?: number
    offset?: number
  },
) {
  const conditions = [eq(stockMovement.organizationId, orgId)]
  if (options?.productId) conditions.push(eq(stockMovement.productId, options.productId))
  // El almacén donde cambió el saldo: la llegada de un traslado es del destino.
  if (options?.warehouseId)
    conditions.push(
      sql`(case when ${stockMovement.kind} = 'traslado' and ${stockMovement.quantityDelta} > 0
        then ${stockMovement.destWarehouseId} else ${stockMovement.warehouseId} end) = ${options.warehouseId}`,
    )
  if (options?.patientId) conditions.push(eq(stockMovement.patientId, options.patientId))
  if (options?.kind) {
    if (!(STOCK_MOVEMENT_KINDS as readonly string[]).includes(options.kind))
      throw validation("Tipo de movimiento inválido")
    conditions.push(eq(stockMovement.kind, options.kind))
  }
  if (options?.from) {
    const from = new Date(options.from)
    if (!Number.isFinite(from.getTime())) throw validation("Fecha desde inválida")
    conditions.push(gte(stockMovement.createdAt, from))
  }
  if (options?.to) {
    const to = new Date(options.to)
    if (!Number.isFinite(to.getTime())) throw validation("Fecha hasta inválida")
    conditions.push(lte(stockMovement.createdAt, to))
  }
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500)
  const offset = Math.max(options?.offset ?? 0, 0)
  const destWarehouse = alias(warehouse, "dest_warehouse")
  return tx
    .select({
      id: stockMovement.id,
      kind: stockMovement.kind,
      quantityDelta: stockMovement.quantityDelta,
      reason: stockMovement.reason,
      actorUserId: stockMovement.actorUserId,
      purchaseOrderId: stockMovement.purchaseOrderId,
      patientId: stockMovement.patientId,
      patientName: patientPerson.displayName,
      productId: stockMovement.productId,
      productSku: product.sku,
      productName: product.name,
      productUnit: product.unit,
      lotId: stockMovement.lotId,
      lotCode: productLot.code,
      warehouseId: stockMovement.warehouseId,
      warehouseName: warehouse.name,
      destWarehouseId: stockMovement.destWarehouseId,
      destWarehouseName: destWarehouse.name,
      createdAt: stockMovement.createdAt,
    })
    .from(stockMovement)
    .leftJoin(
      product,
      and(eq(product.organizationId, orgId), eq(product.id, stockMovement.productId)),
    )
    .leftJoin(
      productLot,
      and(eq(productLot.organizationId, orgId), eq(productLot.id, stockMovement.lotId)),
    )
    .leftJoin(
      warehouse,
      and(eq(warehouse.organizationId, orgId), eq(warehouse.id, stockMovement.warehouseId)),
    )
    .leftJoin(
      destWarehouse,
      and(eq(destWarehouse.organizationId, orgId), eq(destWarehouse.id, stockMovement.destWarehouseId)),
    )
    .leftJoin(
      patient,
      and(eq(patient.organizationId, orgId), eq(patient.id, stockMovement.patientId)),
    )
    .leftJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(...conditions))
    .orderBy(desc(stockMovement.createdAt))
    .limit(limit)
    .offset(offset)
}

/* ---------------- alertas ---------------- */

type LotAlert = {
  lotId: string
  productName: string | null
  sku: string | null
  code: string
  warehouseName: string | null
  expiresAt: string | null
  quantityOnHand: number
}

export interface InventoryAlerts {
  lowStock: Array<{ productId: string; sku: string; name: string; unit: string; minStock: number; onHand: number }>
  expiring: LotAlert[]
  expired: LotAlert[]
}

/**
 * Stock bajo mínimo, lotes por vencer (N días) y ya vencidos con saldo. «Hoy»
 * es el día de la clínica, no el de UTC, y los lotes sin saldo se quitan en la
 * consulta, antes del tope.
 */
export async function getAlerts(tx: Db, orgId: string, expiryDays = 30, now = new Date()): Promise<InventoryAlerts> {
  const days = Number.isSafeInteger(expiryDays) && expiryDays >= 0 ? Math.min(expiryDays, 365) : 30
  const { timezone } = await findOrgLocale(tx, orgId)
  const today = localToday(timezone, now)
  const horizon = addDays(today, days)
  const products = await listProducts(tx, orgId, { onlyActive: true, lowStock: true })
  const lowStock = products.map((item) => ({
    productId: item.id,
    sku: item.sku,
    name: item.name,
    unit: item.unit,
    minStock: item.minStock,
    onHand: item.onHand,
  }))
  const lots = (window: SQL) =>
    tx
      .select({
        lotId: productLot.id,
        productName: product.name,
        sku: product.sku,
        code: productLot.code,
        warehouseName: warehouse.name,
        expiresAt: productLot.expiresAt,
        quantityOnHand: productLot.quantityOnHand,
      })
      .from(productLot)
      .leftJoin(
        product,
        and(eq(product.organizationId, orgId), eq(product.id, productLot.productId)),
      )
      .leftJoin(
        warehouse,
        and(eq(warehouse.organizationId, orgId), eq(warehouse.id, productLot.warehouseId)),
      )
      .where(and(eq(productLot.organizationId, orgId), isNotNull(productLot.expiresAt), gt(productLot.quantityOnHand, 0), window))
      .orderBy(asc(productLot.expiresAt), asc(productLot.code))
      .limit(500)
  return {
    lowStock,
    expiring: await lots(and(gte(productLot.expiresAt, today), lte(productLot.expiresAt, horizon)) as SQL),
    expired: await lots(lt(productLot.expiresAt, today)),
  }
}
