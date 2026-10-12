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
 * el catálogo `supplier` de este dominio en vez de duplicarlo).
 */
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
  warehouse,
} from "@odentia/db/schema/inventory"
import { patient } from "@odentia/db/schema/clinical"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gte, ilike, isNotNull, lte, or, sql } from "drizzle-orm"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { requireOrgCurrency } from "./locale.js"
import { createWorkspaceNotification } from "./workspace.js"

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

function cents(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)
    throw validation("El importe debe ser centavos enteros entre 0 y 2147483647")
  return value
}

function currency(value: string): string {
  if (!/^[A-Z]{3}$/.test(value)) throw validation("La moneda debe ser ISO 4217 de tres letras")
  return value
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
  if (!row) throw notFound("Sucursal")
  return row
}

/** Paciente del tenant: el consumo clínico siempre queda vinculado y validado. */
async function requireTenantPatient(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select({ id: patient.id, displayName: patient.displayName })
    .from(patient)
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
  if (!row) throw notFound("Orden de compra")
  return row
}

async function orderLines(tx: Db, orgId: string, orderId: string) {
  return tx
    .select()
    .from(purchaseOrderLine)
    .where(and(eq(purchaseOrderLine.organizationId, orgId), eq(purchaseOrderLine.orderId, orderId)))
    .orderBy(asc(purchaseOrderLine.createdAt))
}

/** Aviso dirigido al actor cuando un movimiento deja stock bajo mínimo. */
async function notifyLowStock(
  tx: Db,
  orgId: string,
  actorUserId: string,
  productId: string,
  productName: string,
  onHand: number,
) {
  await createWorkspaceNotification(tx, orgId, {
    userId: actorUserId,
    dedupeKey: `inventory:low-stock:${productId}`,
    title: `Stock bajo: ${productName}`,
    body: `Quedan ${onHand} unidades. Revisa el inventario para reponer.`,
    href: `/inventory/${productId}`,
    permission: "inventory.read",
  })
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
  if (onHand < item.minStock) {
    await notifyLowStock(tx, orgId, actorUserId, productId, item.name, onHand)
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

export async function createSupplier(tx: Db, orgId: string, actorUserId: string, input: SupplierInput) {
  const name = textRequired(input.name, "El nombre del proveedor")
  const docNumber = textOptional(input.docNumber, "El documento", 50)
  const docType = docNumber ? textRequired(input.docType ?? "RUC", "El tipo de documento", 20) : textOptional(input.docType, "El tipo de documento", 20)
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
  if (patch.docNumber && !patch.docType && !current.docType) patch.docType = "RUC"
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
  if (q) conditions.push(or(ilike(supplier.name, `%${q}%`), ilike(supplier.docNumber, `%${q}%`))!)
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
  await requireWarehouse(tx, orgId, id)
  const patch: Partial<typeof warehouse.$inferInsert> = {}
  if (input.name !== undefined) patch.name = textRequired(input.name, "El nombre del almacén")
  if (input.branchId !== undefined) {
    await requireBranch(tx, orgId, input.branchId)
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
  await requireProduct(tx, orgId, id)
  try {
    const [row] = await tx
      .update(product)
      .set({ ...productPatch(input), updatedAt: new Date() })
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
  if (q) conditions.push(or(ilike(product.name, `%${q}%`), ilike(product.sku, `%${q}%`))!)
  const rows = await tx
    .select({
      id: product.id,
      sku: product.sku,
      name: product.name,
      kind: product.kind,
      unit: product.unit,
      minStock: product.minStock,
      isActive: product.isActive,
      onHand: sql<number>`coalesce(sum(${productLot.quantityOnHand}), 0)`,
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
    .orderBy(asc(product.name))
    .limit(500)
  const items = rows.map((row) => ({
    ...row,
    onHand: Number(row.onHand ?? 0),
    lowStock: Number(row.onHand ?? 0) < row.minStock,
  }))
  return options?.lowStock ? items.filter((item) => item.lowStock) : items
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
  const [order] = await tx
    .insert(purchaseOrder)
    .values({
      organizationId: orgId,
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
  return { ...order, supplierName: sup?.name ?? null, lines, totalCents }
}

export async function listPurchaseOrders(
  tx: Db,
  orgId: string,
  options?: { status?: string; supplierId?: string },
) {
  const conditions = [eq(purchaseOrder.organizationId, orgId)]
  if (options?.status) {
    if (!(PURCHASE_ORDER_STATUSES as readonly string[]).includes(options.status))
      throw validation("Estado de orden inválido")
    conditions.push(eq(purchaseOrder.status, options.status))
  }
  if (options?.supplierId) conditions.push(eq(purchaseOrder.supplierId, options.supplierId))
  return tx
    .select({
      id: purchaseOrder.id,
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
}

function requireEditableStatus(order: { status: string }, action: string) {
  if (order.status === "recibida" || order.status === "cancelada")
    throw conflict(`La orden ${order.status} ya no admite ${action}`)
}

export async function confirmPurchaseOrder(tx: Db, orgId: string, actorUserId: string, id: string) {
  const order = await requireOrder(tx, orgId, id)
  if (order.status !== "borrador") throw conflict("Solo se confirma una orden en borrador")
  const [row] = await tx
    .update(purchaseOrder)
    .set({ status: "confirmada", updatedAt: new Date() })
    .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, "purchase_order", id, "purchase_order.confirmed")
  return row
}

export async function cancelPurchaseOrder(tx: Db, orgId: string, actorUserId: string, id: string) {
  const order = await requireOrder(tx, orgId, id)
  requireEditableStatus(order, "cancelación")
  const lines = await orderLines(tx, orgId, id)
  if (lines.some((line) => line.receivedQuantity > 0))
    throw conflict("La orden ya tiene recepciones y no puede cancelarse")
  const [row] = await tx
    .update(purchaseOrder)
    .set({ status: "cancelada", updatedAt: new Date() })
    .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, "purchase_order", id, "purchase_order.cancelled")
  return row
}

export interface ReceptionLineInput {
  productId: string
  quantity: number
  lotCode?: string | null
  expiresAt?: string | null
}

/**
 * Recepción parcial o total: crea un lote por línea e ingresa el saldo con
 * su movimiento `ingreso` trazable a la orden.
 *
 * Idempotencia por clave del cliente: `idempotencyKey` es un UUID generado
 * por quien registra la recepción y persistente a reintentos. Dos entregas
 * legítimas con el mismo contenido usan claves distintas y ambas aplican;
 * reintentar la misma clave con otro contenido responde 409 sin efectos.
 * La orden y sus líneas se bloquean (FOR UPDATE): recepciones concurrentes
 * se serializan y el tope pedido se valida con datos frescos.
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
  if (!receptionKey || receptionKey.length > 200)
    throw validation("La recepción necesita una clave de idempotencia")
  const order = await requireOrder(tx, orgId, id)
  requireEditableStatus(order, "recepción")
  if (order.status !== "confirmada" && order.status !== "parcialmente_recibida")
    throw conflict("La orden debe estar confirmada para recibir mercadería")
  if (!lines?.length) throw validation("La recepción necesita al menos una línea")
  // Serializa recepciones concurrentes de la misma orden.
  await tx
    .select({ id: purchaseOrder.id })
    .from(purchaseOrder)
    .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.id, id)))
    .for("update")
    .limit(1)
  const expected = await tx
    .select()
    .from(purchaseOrderLine)
    .where(and(eq(purchaseOrderLine.organizationId, orgId), eq(purchaseOrderLine.orderId, id)))
    .for("update")
  const prefix = `po:${id}:${receptionKey}:`
  const prior = await tx
    .select({
      key: stockMovement.idempotencyKey,
      productId: stockMovement.productId,
      delta: stockMovement.quantityDelta,
    })
    .from(stockMovement)
    .where(
      and(
        eq(stockMovement.organizationId, orgId),
        sql`${stockMovement.idempotencyKey} LIKE ${`${prefix}%`}`,
      ),
    )
  if (prior.length > 0) {
    const priorMap = new Map(prior.map((row) => [row.productId, row.delta]))
    const incomingMap = new Map(lines.map((line) => [line.productId, line.quantity]))
    const same =
      priorMap.size === incomingMap.size &&
      [...incomingMap].every(([productId, qty]) => priorMap.get(productId) === qty)
    if (!same)
      throw conflict("La clave de idempotencia ya se usó con otra recepción")
  }
  const applied = new Set(prior.map((row) => row.productId))
  const byProduct = new Map(expected.map((line) => [line.productId, line]))
  // El replay prioriza: las líneas ya aplicadas bajo esta clave no se
  // revalidan contra el tope (su cantidad ya suma en receivedQuantity) y se
  // omiten abajo; solo las líneas nuevas validan cupo.
  for (const line of lines) {
    if (applied.has(line.productId)) continue
    const exp = byProduct.get(line.productId)
    if (!exp) throw validation("La recepción incluye un producto fuera de la orden")
    quantity(line.quantity, "La cantidad recibida")
    if (exp.receivedQuantity + line.quantity > exp.quantity)
      throw conflict("La recepción supera lo pedido en la orden")
    dateOnly(line.expiresAt, "El vencimiento")
  }
  for (const line of lines) {
    const lineKey = `${prefix}${line.productId}`
    if (applied.has(line.productId)) continue
    const lotCode = line.lotCode?.trim() || `OC-${id.slice(0, 8)}-${line.productId.slice(0, 8)}`
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
          expiresAt: dateOnly(line.expiresAt, "El vencimiento"),
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
      reason: `Recepción de orden de compra (${line.quantity} ${lotCode})`,
      actorUserId,
      purchaseOrderId: id,
      idempotencyKey: lineKey,
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
  idempotencyKey?: string | null
}

async function insertMovementOnce(
  tx: Db,
  orgId: string,
  values: typeof stockMovement.$inferInsert,
) {
  const [existing] = await tx
    .select()
    .from(stockMovement)
    .where(
      and(
        eq(stockMovement.organizationId, orgId),
        eq(stockMovement.idempotencyKey, values.idempotencyKey),
      ),
    )
    .limit(1)
  if (existing) return { row: existing, inserted: false }
  try {
    const [row] = await tx.insert(stockMovement).values(values).returning()
    return { row, inserted: true }
  } catch (e) {
    if (isUniqueViolation(e)) {
      const [retry] = await tx
        .select()
        .from(stockMovement)
        .where(
          and(
            eq(stockMovement.organizationId, orgId),
            eq(stockMovement.idempotencyKey, values.idempotencyKey),
          ),
        )
        .limit(1)
      if (retry) return { row: retry, inserted: false }
    }
    throw e
  }
}

/**
 * Movimiento manual de stock con motivo y actor obligatorios. Nunca deja
 * saldos negativos; el traslado mueve entre almacenes en una sola
 * transacción (dos filas del ledger: salida y entrada).
 */
export async function recordMovement(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: MovementInput,
) {
  if (!(STOCK_MOVEMENT_KINDS as readonly string[]).includes(input.kind))
    throw validation("Tipo de movimiento inválido")
  const reason = textRequired(input.reason ?? "", "El motivo", 2000)
  const item = await requireProduct(tx, orgId, input.productId)
  if (!item.isActive) throw conflict("El producto está desactivado")
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `manual:${input.kind}:${input.productId}:${Date.now()}:${Math.random().toString(36).slice(2)}`

  if (input.kind === "traslado") {
    if (!input.lotId) throw validation("El traslado necesita el lote origen")
    if (!input.destWarehouseId) throw validation("El traslado necesita el almacén destino")
    const qty = quantity(input.quantity)
    const source = await lockLot(tx, orgId, input.lotId)
    if (source.productId !== input.productId) throw validation("El lote no pertenece al producto")
    const dest = await requireWarehouse(tx, orgId, input.destWarehouseId)
    if (!dest.isActive) throw conflict("El almacén destino está desactivado")
    if (source.warehouseId === dest.id) throw validation("Origen y destino deben ser distintos")
    if (source.quantityOnHand < qty) throw conflict("Stock insuficiente en el lote origen")
    const out = await insertMovementOnce(tx, orgId, {
      organizationId: orgId,
      productId: input.productId,
      lotId: source.id,
      warehouseId: source.warehouseId,
      destWarehouseId: dest.id,
      kind: "traslado",
      quantityDelta: -qty,
      reason,
      actorUserId,
      idempotencyKey: `${idempotencyKey}:salida`,
    })
    if (!out.inserted) return out.row
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
    const entry = await insertMovementOnce(tx, orgId, {
      organizationId: orgId,
      productId: input.productId,
      lotId: destLot.id,
      warehouseId: dest.id,
      destWarehouseId: source.warehouseId,
      kind: "traslado",
      quantityDelta: qty,
      reason,
      actorUserId,
      idempotencyKey: `${idempotencyKey}:entrada`,
    })
    await audit(tx, orgId, actorUserId, "stock_movement", out.row.id, "stock.traslado")
    await checkLowStock(tx, orgId, actorUserId, input.productId)
    return entry.row
  }

  if (input.kind === "ajuste") {
    const qty = delta(input.quantity)
    if (!input.lotId) throw validation("El ajuste necesita el lote")
    const lot = await lockLot(tx, orgId, input.lotId)
    if (lot.productId !== input.productId) throw validation("El lote no pertenece al producto")
    if (lot.quantityOnHand + qty < 0) throw conflict("El ajuste dejaría stock negativo")
    const { row, inserted } = await insertMovementOnce(tx, orgId, {
      organizationId: orgId,
      productId: input.productId,
      lotId: lot.id,
      warehouseId: lot.warehouseId,
      kind: "ajuste",
      quantityDelta: qty,
      reason,
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
  let patientId: string | null = null
  if (input.kind === "consumo") {
    if (!input.patientId) throw validation("El consumo clínico necesita el paciente atendido")
    const linked = await requireTenantPatient(tx, orgId, input.patientId)
    patientId = linked.id
    if (lot.quantityOnHand < qty) throw conflict("Stock insuficiente en el lote")
  }
  const movementDelta = input.kind === "consumo" ? -qty : qty
  const { row, inserted } = await insertMovementOnce(tx, orgId, {
    organizationId: orgId,
    productId: input.productId,
    lotId: lot.id,
    warehouseId: lot.warehouseId,
    kind: input.kind,
    quantityDelta: movementDelta,
    reason,
    actorUserId,
    patientId,
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
  if (options?.warehouseId) conditions.push(eq(stockMovement.warehouseId, options.warehouseId))
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
  return tx
    .select({
      id: stockMovement.id,
      kind: stockMovement.kind,
      quantityDelta: stockMovement.quantityDelta,
      reason: stockMovement.reason,
      actorUserId: stockMovement.actorUserId,
      purchaseOrderId: stockMovement.purchaseOrderId,
      patientId: stockMovement.patientId,
      patientName: patient.displayName,
      productId: stockMovement.productId,
      productSku: product.sku,
      productName: product.name,
      productUnit: product.unit,
      lotId: stockMovement.lotId,
      lotCode: productLot.code,
      warehouseId: stockMovement.warehouseId,
      warehouseName: warehouse.name,
      destWarehouseId: stockMovement.destWarehouseId,
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
      patient,
      and(eq(patient.organizationId, orgId), eq(patient.id, stockMovement.patientId)),
    )
    .where(and(...conditions))
    .orderBy(desc(stockMovement.createdAt))
    .limit(limit)
    .offset(offset)
}

/* ---------------- alertas ---------------- */

export interface InventoryAlerts {
  lowStock: Array<{ productId: string; sku: string; name: string; unit: string; minStock: number; onHand: number }>
  expiring: Array<{ lotId: string; productName: string | null; sku: string | null; code: string; warehouseName: string | null; expiresAt: string | null; quantityOnHand: number }>
  expired: Array<{ lotId: string; productName: string | null; sku: string | null; code: string; warehouseName: string | null; expiresAt: string | null; quantityOnHand: number }>
}

/** Stock bajo mínimo, lotes por vencer (N días) y ya vencidos con saldo. */
export async function getAlerts(tx: Db, orgId: string, expiryDays = 30): Promise<InventoryAlerts> {
  const days = Number.isSafeInteger(expiryDays) && expiryDays >= 0 ? Math.min(expiryDays, 365) : 30
  const today = new Date().toISOString().slice(0, 10)
  const horizon = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  const products = await listProducts(tx, orgId, { onlyActive: true })
  const lowStock = products
    .filter((item) => item.lowStock)
    .map((item) => ({
      productId: item.id,
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      minStock: item.minStock,
      onHand: item.onHand,
    }))
  const lots = await tx
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
    .where(
      and(
        eq(productLot.organizationId, orgId),
        isNotNull(productLot.expiresAt),
        lte(productLot.expiresAt, horizon),
      ),
    )
    .orderBy(asc(productLot.expiresAt))
    .limit(500)
  return {
    lowStock,
    expiring: lots.filter(
      (lot) => lot.expiresAt != null && lot.expiresAt >= today && lot.quantityOnHand > 0,
    ),
    expired: lots.filter(
      (lot) => lot.expiresAt != null && lot.expiresAt < today && lot.quantityOnHand > 0,
    ),
  }
}
