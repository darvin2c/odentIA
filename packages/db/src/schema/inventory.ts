import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { patient } from "./clinical.js"
import { orgFk, timestamps } from "./crm.js"
import { branch } from "./org.js"

/**
 * Inventario por sede: productos/insumos, almacenes, proveedores propios,
 * órdenes de compra con recepción parcial, lotes con vencimiento y ledger
 * inmutable de movimientos (ingreso/consumo/ajuste/traslado).
 *
 * Contrato con Finanzas: `supplier` vive aquí y es el ÚNICO catálogo de
 * proveedores (Finanzas lo reutiliza; no duplicar). La orden de compra
 * registra el compromiso comercial (totalCents referencial en centavos
 * enteros); NUNCA equivale a un pago ni escribe en el ledger financiero.
 * Trazabilidad: compra → lote → consumo mediante purchaseOrderId/lotId.
 * Unidades declaradas tal cual (`unit` texto libre, p.ej. "caja x 100"):
 * el sistema NO convierte unidades.
 */

export const PRODUCT_KINDS = ["insumo", "producto"] as const
export type ProductKind = (typeof PRODUCT_KINDS)[number]

export const PURCHASE_ORDER_STATUSES = [
  "borrador",
  "confirmada",
  "parcialmente_recibida",
  "recibida",
  "cancelada",
] as const
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number]

export const STOCK_MOVEMENT_KINDS = ["ingreso", "consumo", "ajuste", "traslado"] as const
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number]

/** Catálogo único de proveedores (compartido con Finanzas, no duplicar). */
export const supplier = pgTable(
  "supplier",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    name: text("name").notNull(),
    docType: text("doc_type"),
    docNumber: text("doc_number"),
    email: text("email"),
    phone: text("phone"),
    address: text("address"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("supplier_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("supplier_org_doc_uidx")
      .on(table.organizationId, table.docType, table.docNumber)
      .where(sql`"doc_number" IS NOT NULL`),
  ],
)

/** Almacén físico atado a una sede (sucursal) del tenant. */
export const warehouse = pgTable(
  "warehouse",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("warehouse_org_id_uidx").on(table.organizationId, table.id),
    index("warehouse_org_branch_idx").on(table.organizationId, table.branchId),
  ],
)

/** Producto o insumo con unidad declarada (sin conversiones) y mínimo. */
export const product = pgTable(
  "product",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("insumo"),
    /** Unidad declarada tal cual ("caja x 100", "frasco 500 ml", "unidad"). */
    unit: text("unit").notNull().default("unidad"),
    minStock: integer("min_stock").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("product_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("product_org_sku_uidx").on(table.organizationId, table.sku),
    check("product_kind_check", sql`${table.kind} IN ('insumo','producto')`),
    check("product_min_stock_check", sql`${table.minStock} >= 0`),
  ],
)

/** Orden de compra: compromiso comercial, NO pago (ver contrato superior). */
export const purchaseOrder = pgTable(
  "purchase_order",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => supplier.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouse.id),
    status: text("status").notNull().default("borrador"),
    currency: text("currency").notNull().default("PEN"),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("purchase_order_org_id_uidx").on(table.organizationId, table.id),
    index("purchase_order_org_supplier_idx").on(table.organizationId, table.supplierId),
    index("purchase_order_org_status_idx").on(table.organizationId, table.status),
    check(
      "purchase_order_status_check",
      sql`${table.status} IN ('borrador','confirmada','parcialmente_recibida','recibida','cancelada')`,
    ),
    check("purchase_order_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
)

export const purchaseOrderLine = pgTable(
  "purchase_order_line",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    orderId: uuid("order_id")
      .notNull()
      .references(() => purchaseOrder.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    quantity: integer("quantity").notNull(),
    /** Costo unitario referencial en centavos enteros (dinero sin floats). */
    unitCostCents: integer("unit_cost_cents").notNull().default(0),
    receivedQuantity: integer("received_quantity").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("purchase_order_line_org_order_product_uidx").on(
      table.organizationId,
      table.orderId,
      table.productId,
    ),
    check("purchase_order_line_quantity_check", sql`${table.quantity} > 0`),
    check("purchase_order_line_cost_check", sql`${table.unitCostCents} >= 0`),
    check("purchase_order_line_received_check", sql`${table.receivedQuantity} >= 0`),
  ],
)

/** Lote de un producto en un almacén; el saldo vive aquí y el ledger lo explica. */
export const productLot = pgTable(
  "product_lot",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouse.id),
    supplierId: uuid("supplier_id").references(() => supplier.id),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrder.id),
    code: text("code").notNull(),
    expiresAt: date("expires_at"),
    quantityOnHand: integer("quantity_on_hand").notNull().default(0),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("product_lot_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("product_lot_org_product_warehouse_code_uidx").on(
      table.organizationId,
      table.productId,
      table.warehouseId,
      table.code,
    ),
    index("product_lot_org_product_idx").on(table.organizationId, table.productId),
    index("product_lot_org_expires_idx").on(table.organizationId, table.expiresAt),
    check("product_lot_onhand_check", sql`${table.quantityOnHand} >= 0`),
  ],
)

/**
 * Ledger inmutable de movimientos. Sin updatedAt: las filas NUNCA se
 * editan ni borran (el padre revoca UPDATE/DELETE al rol app); los errores
 * se corrigen con un movimiento inverso de ajuste con su motivo.
 */
export const stockMovement = pgTable(
  "stock_movement",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id),
    lotId: uuid("lot_id").references(() => productLot.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouse.id),
    /** Solo traslado: almacén destino (el origen va en warehouseId). */
    destWarehouseId: uuid("dest_warehouse_id").references(() => warehouse.id),
    kind: text("kind").notNull(),
    /** Delta con signo: ingreso/ajuste positivo o negativo, consumo negativo. */
    quantityDelta: integer("quantity_delta").notNull(),
    reason: text("reason").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrder.id),
    /** Consumo clínico: paciente del tenant (validado en servicio). */
    patientId: uuid("patient_id"),
    /** Idempotencia por tenant: reintentos no duplican el ledger. */
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stock_movement_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("stock_movement_org_idempotency_uidx").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("stock_movement_org_product_idx").on(table.organizationId, table.productId),
    index("stock_movement_org_warehouse_idx").on(table.organizationId, table.warehouseId),
    index("stock_movement_org_patient_idx").on(table.organizationId, table.patientId),
    foreignKey({
      columns: [table.organizationId, table.patientId],
      foreignColumns: [patient.organizationId, patient.id],
    }),
    check(
      "stock_movement_kind_check",
      sql`${table.kind} IN ('ingreso','consumo','ajuste','traslado')`,
    ),
    check("stock_movement_delta_check", sql`${table.quantityDelta} <> 0`),
  ],
)
