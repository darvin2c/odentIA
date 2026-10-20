import { sql } from "drizzle-orm"
import {
  boolean,
  char,
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
import { encounter, patient, patientCharge, serviceCatalog } from "./clinical.js"
import { orgFk, timestamps } from "./crm.js"
import { branch } from "./org.js"

/**
 * Inventario por sede: productos que se usan en las atenciones o se venden,
 * almacenes de cada sede, proveedores propios, compras con recepción parcial,
 * lotes con vencimiento, faltantes y ledger inmutable de movimientos.
 *
 * Contrato con Finanzas: `supplier` vive aquí y es el ÚNICO catálogo de
 * proveedores (Finanzas lo reutiliza; no duplicar). La orden de compra
 * registra el compromiso comercial; su pago es un gasto de Materiales
 * enlazado (ADR 0061) y nunca escribe en el ledger de existencias.
 *
 * Unidades (ADR 0067): todo lo que hay, los mínimos, los descuentos y las
 * ventas se cuentan en la unidad de USO del producto (`unit`, entero); la
 * compra se escribe en su unidad de compra y se convierte al recibir con el
 * factor copiado en la línea. Lo que hay en una sede = sus lotes − su faltante.
 */

/** Movimientos del ledger. `cobertura`: el lote nuevo cubre lo que se usó sin haber. */
export const STOCK_MOVEMENT_KINDS = ["ingreso", "consumo", "ajuste", "traslado", "venta", "cobertura", "devolucion"] as const
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number]

export const PURCHASE_ORDER_STATUSES = [
  "borrador",
  "confirmada",
  "parcialmente_recibida",
  "recibida",
  /** Cerrada con lo recibido: el proveedor ya no manda lo que falta. */
  "cerrada",
  "cancelada",
] as const
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number]

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

/**
 * Almacén físico de una sede. Cada sede nace con su «Almacén principal»
 * (`is_default`, lo crea un disparador al insertar la sede): de ahí salen las
 * atenciones y las ventas y ahí llegan las compras si nadie elige otro.
 */
export const warehouse = pgTable(
  "warehouse",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branch.id),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("warehouse_org_id_uidx").on(table.organizationId, table.id),
    index("warehouse_org_branch_idx").on(table.organizationId, table.branchId),
    uniqueIndex("warehouse_branch_default_uidx")
      .on(table.organizationId, table.branchId)
      .where(sql`"is_default"`),
  ],
)

/**
 * Producto: se usa en las atenciones, se vende o las dos cosas, con unas
 * mismas existencias. `unit` es la unidad de uso; `purchase_unit` y
 * `purchase_factor`, cómo se compra («caja de 100 guantes»).
 */
export const product = pgTable(
  "product",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    /** «Se usa en las atenciones»: entra en los materiales de un servicio. */
    usedInCare: boolean("used_in_care").notNull().default(true),
    /** «Se vende»: aparece en «Cobrar» con su precio de venta. */
    forSale: boolean("for_sale").notNull().default(false),
    /** Unidad de uso, en palabras («guante», «cartucho»). */
    unit: text("unit").notNull().default("unidad"),
    /** Su código internacional (UN/CEFACT Rec 20 o UCUM); null = unidad con nombre propio. */
    unitCode: text("unit_code"),
    /** Unidad de compra («caja»); null = se compra igual que se usa. */
    purchaseUnit: text("purchase_unit"),
    purchaseUnitCode: text("purchase_unit_code"),
    /** Unidades de uso que trae una de compra. */
    purchaseFactor: integer("purchase_factor").notNull().default(1),
    /** La unidad de antes no se pudo leer: queda «Por revisar», sin tocar lo que hay. */
    unitReview: boolean("unit_review").notNull().default(false),
    /** Precio de venta por unidad de uso, en la moneda de la clínica. */
    salePriceCents: integer("sale_price_cents"),
    saleCurrency: char("sale_currency", { length: 3 }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("product_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("product_org_sku_uidx").on(table.organizationId, table.sku),
    check("product_use_check", sql`${table.usedInCare} OR ${table.forSale}`),
    check("product_purchase_factor_check", sql`${table.purchaseFactor} BETWEEN 1 AND 100000`),
    check(
      "product_sale_price_check",
      sql`(${table.salePriceCents} IS NULL) = (${table.saleCurrency} IS NULL) AND (${table.salePriceCents} IS NULL OR ${table.salePriceCents} >= 0)`,
    ),
    check("product_sale_currency_check", sql`${table.saleCurrency} IS NULL OR ${table.saleCurrency} ~ '^[A-Z]{3}$'`),
  ],
)

/** Mínimo de un producto en una sede, en su unidad de uso. Sin fila, el mínimo es 0. */
export const productMinimum = pgTable(
  "product_minimum",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    productId: uuid("product_id").notNull(),
    branchId: uuid("branch_id").notNull(),
    minQuantity: integer("min_quantity").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("product_minimum_org_product_branch_uidx").on(table.organizationId, table.productId, table.branchId),
    foreignKey({
      name: "product_minimum_product_fk",
      columns: [table.organizationId, table.productId],
      foreignColumns: [product.organizationId, product.id],
    }),
    foreignKey({
      name: "product_minimum_branch_fk",
      columns: [table.organizationId, table.branchId],
      foreignColumns: [branch.organizationId, branch.id],
    }),
    check("product_minimum_quantity_check", sql`${table.minQuantity} BETWEEN 0 AND 1000000000`),
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
    /**
     * Número de la orden en la clínica («OC-0012»), sin saltos. Lo pone
     * `createPurchaseOrder` con el contador de la clínica; la base lo exige
     * (`NOT NULL` en la migración de reglas).
     */
    orderNumber: integer("order_number"),
    status: text("status").notNull().default("borrador"),
    // ISO 4217, siempre explícita: sin moneda por defecto de ningún país.
    currency: text("currency").notNull(),
    notes: text("notes"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("purchase_order_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("purchase_order_org_number_uidx").on(table.organizationId, table.orderNumber),
    index("purchase_order_org_supplier_idx").on(table.organizationId, table.supplierId),
    index("purchase_order_org_status_idx").on(table.organizationId, table.status),
    check(
      "purchase_order_status_check",
      sql`${table.status} IN ('borrador','confirmada','parcialmente_recibida','recibida','cerrada','cancelada')`,
    ),
    check("purchase_order_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
)

/**
 * Línea de una compra, en unidades de COMPRA: `quantity` y `received_quantity`
 * cuentan cajas; el lote recibe `received × unit_factor` unidades de uso. El
 * factor y la unidad se copian al crear la línea: cambiar el producto después
 * no reescribe lo pedido.
 */
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
    /** Precio por unidad de compra en centavos enteros: el de la factura si se corrigió al recibir. */
    unitCostCents: integer("unit_cost_cents").notNull().default(0),
    /** Lo pedido, si la factura trajo otro precio; null = no cambió. */
    orderedUnitCostCents: integer("ordered_unit_cost_cents"),
    receivedQuantity: integer("received_quantity").notNull().default(0),
    /** Unidad de compra y factor copiados del producto al crear la línea. */
    purchaseUnit: text("purchase_unit"),
    unitFactor: integer("unit_factor").notNull().default(1),
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
    check(
      "purchase_order_line_ordered_cost_check",
      sql`${table.orderedUnitCostCents} IS NULL OR ${table.orderedUnitCostCents} >= 0`,
    ),
    check("purchase_order_line_received_check", sql`${table.receivedQuantity} >= 0`),
    check("purchase_order_line_factor_check", sql`${table.unitFactor} BETWEEN 1 AND 100000`),
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
 * Lo que se usó o se vendió sin haber, por producto y almacén (#144). La
 * atención y la venta nunca se bloquean: el lote no baja de cero y lo que
 * faltó queda aquí hasta que una compra, un ingreso o un conteo lo cubra.
 */
export const stockShortage = pgTable(
  "stock_shortage",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    productId: uuid("product_id").notNull(),
    warehouseId: uuid("warehouse_id").notNull(),
    quantity: integer("quantity").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("stock_shortage_org_product_warehouse_uidx").on(table.organizationId, table.productId, table.warehouseId),
    foreignKey({
      name: "stock_shortage_product_fk",
      columns: [table.organizationId, table.productId],
      foreignColumns: [product.organizationId, product.id],
    }),
    foreignKey({
      name: "stock_shortage_warehouse_fk",
      columns: [table.organizationId, table.warehouseId],
      foreignColumns: [warehouse.organizationId, warehouse.id],
    }),
    check("stock_shortage_quantity_check", sql`${table.quantity} >= 0`),
  ],
)

/**
 * Ledger inmutable de movimientos. Sin updatedAt: las filas NUNCA se
 * editan ni borran (el rol app solo lee e inserta); los errores se
 * corrigen con otro movimiento con su motivo. Sin lote (`lot_id` nulo) el
 * movimiento es del faltante: lo usado sin haber o el ajuste que lo cubre.
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
    /** Delta con signo, en unidades de uso. */
    quantityDelta: integer("quantity_delta").notNull(),
    reason: text("reason").notNull(),
    actorUserId: text("actor_user_id").references(() => user.id),
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrder.id),
    /** Uso o venta para un paciente de la clínica. */
    patientId: uuid("patient_id"),
    /** La atención que lo usó (descuento al cerrarla o su corrección). */
    encounterId: uuid("encounter_id"),
    /** El concepto de «Cobrar» que lo vendió (o su devolución). */
    chargeId: uuid("charge_id"),
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
    index("stock_movement_org_encounter_idx")
      .on(table.organizationId, table.encounterId)
      .where(sql`${table.encounterId} is not null`),
    index("stock_movement_org_charge_idx")
      .on(table.organizationId, table.chargeId)
      .where(sql`${table.chargeId} is not null`),
    // Lo recibido de cada compra (saldo con el proveedor), sin recorrer los consumos clínicos.
    index("stock_movement_org_purchase_idx")
      .on(table.organizationId, table.purchaseOrderId)
      .where(sql`${table.purchaseOrderId} is not null`),
    foreignKey({
      columns: [table.organizationId, table.patientId],
      foreignColumns: [patient.organizationId, patient.id],
    }),
    // La atención es del mismo paciente y de la misma clínica.
    foreignKey({
      name: "stock_movement_encounter_fk",
      columns: [table.organizationId, table.patientId, table.encounterId],
      foreignColumns: [encounter.organizationId, encounter.patientId, encounter.id],
    }),
    foreignKey({
      name: "stock_movement_charge_fk",
      columns: [table.organizationId, table.chargeId],
      foreignColumns: [patientCharge.organizationId, patientCharge.id],
    }),
    check(
      "stock_movement_kind_check",
      sql`${table.kind} IN ('ingreso','consumo','ajuste','traslado','venta','cobertura','devolucion')`,
    ),
    check("stock_movement_delta_check", sql`${table.quantityDelta} <> 0`),
    check("stock_movement_encounter_patient_check", sql`${table.encounterId} IS NULL OR ${table.patientId} IS NOT NULL`),
  ],
)

/**
 * Materiales de siempre de un servicio, por cada vez que se hace (#144):
 * tres sellantes descuentan tres veces. Solo productos que se usan en las
 * atenciones; la cantidad va en la unidad de uso del producto.
 */
export const serviceMaterial = pgTable(
  "service_material",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    serviceId: uuid("service_id").notNull(),
    productId: uuid("product_id").notNull(),
    quantity: integer("quantity").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("service_material_org_service_product_uidx").on(table.organizationId, table.serviceId, table.productId),
    index("service_material_org_product_idx").on(table.organizationId, table.productId),
    foreignKey({
      name: "service_material_service_fk",
      columns: [table.organizationId, table.serviceId],
      foreignColumns: [serviceCatalog.organizationId, serviceCatalog.id],
    }),
    foreignKey({
      name: "service_material_product_fk",
      columns: [table.organizationId, table.productId],
      foreignColumns: [product.organizationId, product.id],
    }),
    check("service_material_quantity_check", sql`${table.quantity} BETWEEN 1 AND 9999`),
  ],
)

/**
 * Lo que se tenía a favor con un proveedor (una compra pagada de más que ya
 * llegó, o una cancelada con sus pagos dejados a favor) usado para pagar otra
 * compra suya. No es un gasto: el dinero ya salió con el pago original. Lo
 * pagado de una compra es su gasto más lo usado a favor (ADR 0061). Solo se anula.
 */
export const supplierCreditUse = pgTable(
  "supplier_credit_use",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    supplierId: uuid("supplier_id").notNull(),
    /** La compra que se paga con lo que se tenía a favor. */
    orderId: uuid("order_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
  },
  (table) => [
    index("supplier_credit_use_org_supplier_idx").on(table.organizationId, table.supplierId),
    index("supplier_credit_use_org_order_idx").on(table.organizationId, table.orderId),
    foreignKey({
      columns: [table.organizationId, table.supplierId],
      foreignColumns: [supplier.organizationId, supplier.id],
    }),
    foreignKey({
      columns: [table.organizationId, table.orderId],
      foreignColumns: [purchaseOrder.organizationId, purchaseOrder.id],
    }),
    check("supplier_credit_use_amount_check", sql`${table.amountCents} > 0`),
    check("supplier_credit_use_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
)
