import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

/**
 * La base de gestorIA (ADR 0203): otra base en el mismo servidor de PostgreSQL, con sus
 * propios usuarios. Nada aquí apunta a la base de las clínicas: la persona llega por la
 * cuenta única (un token firmado) y se guarda su copia (`account_copy`).
 *
 * Las reglas de cada tienda (RLS) y lo que puede el rol de la aplicación están en la
 * migración de reglas (`drizzle/0001_reglas.sql`); toda tabla nueva nace cerrada a ese rol.
 */

/** Los roles de una tienda (decisión 7 del lienzo B). Qué puede cada uno: `permisos.ts` de la API. */
export const STORE_ROLES = ["owner", "admin", "sales"] as const
export type StoreRole = (typeof STORE_ROLES)[number]

/** El estado de la copia de una cuenta. */
export const ACCOUNT_COPY_STATES = ["activa", "bloqueada", "cerrada"] as const
export type AccountCopyState = (typeof ACCOUNT_COPY_STATES)[number]

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((value) => `'${value}'`).join(",")})`)

/**
 * La copia de una cuenta (decisión 11 del lienzo A): nombre, correo y foto de quien usa
 * gestorIA. La original es la cuenta; nadie edita esta copia. Se pone al día con cada token
 * que llega, con los avisos firmados de la cuenta y con la revisión diaria. Una cerrada no se
 * borra: la historia de la tienda la sigue nombrando.
 */
export const accountCopy = pgTable(
  "account_copy",
  {
    /** El id de la cuenta (el `sub` del token). */
    userId: text("user_id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    image: text("image"),
    state: text("state").$type<AccountCopyState>().notNull().default("activa"),
    /** Cuándo cambió el estado: un token emitido después prueba que la cuenta volvió a abrirse. */
    stateChangedAt: timestamp("state_changed_at", { withTimezone: true }).notNull().defaultNow(),
    /** El último token visto (se anota cada pocos minutos, no en cada pedido). */
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** La última vez que la revisión diaria la comparó con la cuenta. */
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("account_copy_state_check", inList("state", ACCOUNT_COPY_STATES)),
    index("account_copy_email_idx").on(sql`lower(${table.email})`),
    index("account_copy_reviewed_idx").on(table.reviewedAt),
  ],
)

/**
 * Una tienda (decisión 8: una persona puede tener o atender varias y elige al entrar). Vende
 * en una sola moneda, la que elige al crearla (decisión 9), con su código ISO 4217.
 */
export const store = pgTable(
  "store",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("store_name_check", sql`char_length(btrim(${table.name})) between 1 and 80`),
    check("store_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    foreignKey({
      name: "store_created_by_fkey",
      columns: [table.createdBy],
      foreignColumns: [accountCopy.userId],
    }),
  ],
)

/** Quién es parte del equipo de una tienda y con qué rol. Quién lo sumó queda anotado. */
export const storeMember = pgTable(
  "store_member",
  {
    storeId: uuid("store_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").$type<StoreRole>().notNull(),
    /** Quién lo sumó: nulo en quien creó la tienda. */
    addedBy: text("added_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "store_member_pkey", columns: [table.storeId, table.userId] }),
    check("store_member_role_check", inList("role", STORE_ROLES)),
    foreignKey({
      name: "store_member_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "store_member_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [accountCopy.userId],
    }),
    foreignKey({
      name: "store_member_added_by_fkey",
      columns: [table.addedBy],
      foreignColumns: [accountCopy.userId],
    }),
    index("store_member_user_idx").on(table.userId),
  ],
)

/**
 * Una invitación al equipo, para un correo. Se acepta entrando con la cuenta de ese correo
 * (verificado por la cuenta); el enlace no basta. Una sola pendiente por correo y tienda.
 */
export const storeInvitation = pgTable(
  "store_invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    /** En minúsculas. */
    email: text("email").notNull(),
    role: text("role").$type<StoreRole>().notNull(),
    invitedBy: text("invited_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: text("accepted_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
  },
  (table) => [
    check("store_invitation_role_check", inList("role", STORE_ROLES)),
    check(
      "store_invitation_email_check",
      sql`${table.email} = lower(${table.email}) and position('@' in ${table.email}) > 1`,
    ),
    check(
      "store_invitation_closed_check",
      sql`(${table.acceptedAt} is null or ${table.acceptedBy} is not null) and (${table.revokedAt} is null or ${table.revokedBy} is not null) and (${table.acceptedAt} is null or ${table.revokedAt} is null)`,
    ),
    foreignKey({
      name: "store_invitation_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "store_invitation_invited_by_fkey",
      columns: [table.invitedBy],
      foreignColumns: [accountCopy.userId],
    }),
    uniqueIndex("store_invitation_pending_idx")
      .on(table.storeId, table.email)
      .where(sql`accepted_at is null and revoked_at is null`),
    index("store_invitation_email_idx").on(table.email),
  ],
)

/** Lo que se anota de cada tienda: quién hizo qué en su equipo (crear, invitar, cambiar un rol). */
export const STORE_EVENT_ACTIONS = [
  "tienda.creada",
  "invitacion.creada",
  "invitacion.anulada",
  "invitacion.aceptada",
  "equipo.rol",
  "equipo.quitado",
  "cuenta.cerrada",
  "configuracion.pago",
  "configuracion.entrega",
  "catalogo.producto",
  "catalogo.hoja",
] as const
export type StoreEventAction = (typeof STORE_EVENT_ACTIONS)[number]

export const storeEvent = pgTable(
  "store_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    /** Quién lo hizo; nulo si fue la cuenta (un aviso de cierre). */
    actorUserId: text("actor_user_id"),
    action: text("action").$type<StoreEventAction>().notNull(),
    /** A quién o a qué: la cuenta, el correo invitado. */
    subject: text("subject"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("store_event_action_check", inList("action", STORE_EVENT_ACTIONS)),
    foreignKey({
      name: "store_event_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    index("store_event_store_idx").on(table.storeId, table.createdAt),
  ],
)

/**
 * Los avisos de la cuenta ya recibidos, por su `webhook-id` (Standard Webhooks): la cuenta
 * reintenta, y un repetido no vuelve a aplicarse.
 */
export const accountEventReceipt = pgTable("account_event_receipt", {
  webhookId: text("webhook_id").primaryKey(),
  type: text("type").notNull(),
  userId: text("user_id").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
})

/*
 * La configuración de la tienda (paso B3 del lienzo B, tableros 6, 7 y 14): con qué le pagan,
 * cómo entrega y qué vende. Todo importe va en la unidad menor de la moneda de la tienda
 * (ISO 4217: céntimos en PEN, pesos enteros en CLP), como `price_cents` de odentIA.
 */

/**
 * Los tipos de medio de pago, de la lista UN/CEFACT 4461 (la misma de odentIA): 68 billetera
 * o pago en línea (Yape, Plin, un link de pago), 30 transferencia, 48 tarjeta, 10 efectivo y
 * 1 otro. El cheque (20) no se ofrece: no se usa para vender con envío.
 */
export const PAYMENT_TYPE_CODES = ["68", "30", "48", "10", "1"] as const
export type PaymentTypeCode = (typeof PAYMENT_TYPE_CODES)[number]

/**
 * Cómo se confirma que pagó, en el orden en que cobrará Sofi (tablero 14): primero el link de
 * pago (se confirma solo, con el proveedor que se conecta en B4), después la captura que
 * confirma una persona, y al final el pago al recibir, si la forma de entrega lo acepta.
 * UN/CEFACT 4461 dice con qué se paga, no cómo se confirma: por eso va aparte.
 */
export const PAYMENT_COLLECTIONS = ["link", "comprobante", "al_recibir"] as const
export type PaymentCollection = (typeof PAYMENT_COLLECTIONS)[number]

export const storePaymentMethod = pgTable(
  "store_payment_method",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    /** Como lo dirá Sofi al cliente («Yape», «Transferencia BCP»). */
    name: text("name").notNull(),
    typeCode: text("type_code").$type<PaymentTypeCode>().notNull(),
    collection: text("collection").$type<PaymentCollection>().notNull(),
    /** Lo que Sofi le envía al cliente para pagar: el número, la cuenta, a nombre de quién. */
    details: text("details").notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "store_payment_method_name_check",
      sql`char_length(btrim(${table.name})) between 1 and 80`,
    ),
    check("store_payment_method_type_check", inList("type_code", PAYMENT_TYPE_CODES)),
    check("store_payment_method_collection_check", inList("collection", PAYMENT_COLLECTIONS)),
    // El efectivo solo se cobra al recibir.
    check(
      "store_payment_method_cash_check",
      sql`${table.typeCode} <> '10' or ${table.collection} = 'al_recibir'`,
    ),
    check("store_payment_method_details_check", sql`char_length(${table.details}) <= 500`),
    foreignKey({
      name: "store_payment_method_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    index("store_payment_method_store_idx").on(table.storeId),
  ],
)

/**
 * Las formas de entrega, de la lista `DeliveryMethod` de Schema.org (decisión 1): reparto
 * propio, recojo en tienda, agencia o courier, correo y casillero o punto de recojo.
 */
export const DELIVERY_TYPES = [
  "DeliveryModeOwnFleet",
  "OnSitePickup",
  "ParcelService",
  "DeliveryModeMail",
  "LockerDelivery",
] as const
export type DeliveryType = (typeof DELIVERY_TYPES)[number]

/** Cuánto cuesta el envío: gratis, un precio fijo, por zona o se acuerda en el chat. */
export const DELIVERY_COSTS = ["gratis", "fijo", "por_zona", "se_acuerda"] as const
export type DeliveryCost = (typeof DELIVERY_COSTS)[number]

export interface DeliveryZone {
  name: string
  priceCents: number
}

export const storeDeliveryMethod = pgTable(
  "store_delivery_method",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    name: text("name").notNull(),
    type: text("type").$type<DeliveryType>().notNull(),
    /** Lo que ayuda a elegirla: la dirección del recojo, «Shalom u Olva, a elección». */
    details: text("details").notNull().default(""),
    cost: text("cost").$type<DeliveryCost>().notNull(),
    /** Con costo fijo. */
    priceCents: integer("price_cents"),
    /** Con costo por zona: cada zona con su precio. */
    zones: jsonb("zones").$type<DeliveryZone[]>().notNull().default([]),
    /** «Cuándo llega», como lo dirá Sofi: «Al día siguiente», «De 2 a 4 días». */
    eta: text("eta").notNull().default(""),
    acceptsPayOnDelivery: boolean("accepts_pay_on_delivery").notNull().default(false),
    /**
     * Lo que Sofi puede negociar del envío (tablero 14): rebajarlo hasta este monto (nulo, no
     * se rebaja; igual o más que el costo, puede regalarlo) y gratis desde un monto de compra.
     */
    maxDiscountCents: integer("max_discount_cents"),
    freeFromCents: integer("free_from_cents"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "store_delivery_method_name_check",
      sql`char_length(btrim(${table.name})) between 1 and 80`,
    ),
    check("store_delivery_method_type_check", inList("type", DELIVERY_TYPES)),
    check("store_delivery_method_cost_check", inList("cost", DELIVERY_COSTS)),
    check(
      "store_delivery_method_price_check",
      sql`(${table.cost} = 'fijo') = (${table.priceCents} is not null) and (${table.priceCents} is null or ${table.priceCents} >= 0)`,
    ),
    check(
      "store_delivery_method_zones_check",
      sql`jsonb_typeof(${table.zones}) = 'array' and ((${table.cost} = 'por_zona') = (jsonb_array_length(${table.zones}) > 0))`,
    ),
    // Lo negociable es de un envío que cuesta: fijo o por zona.
    check(
      "store_delivery_method_deal_check",
      sql`(${table.maxDiscountCents} is null and ${table.freeFromCents} is null) or ${table.cost} in ('fijo','por_zona')`,
    ),
    check(
      "store_delivery_method_deal_amounts_check",
      sql`(${table.maxDiscountCents} is null or ${table.maxDiscountCents} > 0) and (${table.freeFromCents} is null or ${table.freeFromCents} > 0)`,
    ),
    check(
      "store_delivery_method_texts_check",
      sql`char_length(${table.details}) <= 300 and char_length(${table.eta}) <= 120`,
    ),
    foreignKey({
      name: "store_delivery_method_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    index("store_delivery_method_store_idx").on(table.storeId),
  ],
)

/** Una opción de un producto (Schema.org `variesBy`): «Color» con «blanca» y «negra». */
export interface ProductOption {
  name: string
  values: string[]
}

/** Hasta tres opciones por producto, como el catálogo de Meta (talla, color, material). */
export const MAX_PRODUCT_OPTIONS = 3

/**
 * Un producto: agrupa sus variantes (Schema.org `ProductGroup`). Tiene su precio de lista y,
 * si se negocia, su precio mínimo de venta (tablero 14): sin mínimo, no se negocia.
 */
export const product = pgTable(
  "product",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    name: text("name").notNull(),
    category: text("category"),
    /** «Lo que Sofi puede contar»: material, horma, cuidados. */
    description: text("description").notNull().default(""),
    listPriceCents: integer("list_price_cents").notNull(),
    minPriceCents: integer("min_price_cents"),
    options: jsonb("options").$type<ProductOption[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("product_name_check", sql`char_length(btrim(${table.name})) between 1 and 120`),
    check(
      "product_category_check",
      sql`${table.category} is null or char_length(btrim(${table.category})) between 1 and 60`,
    ),
    check("product_description_check", sql`char_length(${table.description}) <= 2000`),
    check("product_price_check", sql`${table.listPriceCents} > 0`),
    check(
      "product_min_price_check",
      sql`${table.minPriceCents} is null or (${table.minPriceCents} > 0 and ${table.minPriceCents} <= ${table.listPriceCents})`,
    ),
    check(
      "product_options_check",
      sql`jsonb_typeof(${table.options}) = 'array' and jsonb_array_length(${table.options}) <= 3`,
    ),
    foreignKey({
      name: "product_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    unique("product_store_id_key").on(table.storeId, table.id),
    uniqueIndex("product_store_name_uidx").on(table.storeId, sql`lower(${table.name})`),
  ],
)

/** El contenido de una foto: se guarda en la base tal como llegó (la pantalla ya la achicó). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
export type PhotoType = (typeof PHOTO_TYPES)[number]
/** Lo más que pesa una foto (la pantalla la achica antes de subirla) y cuántas lleva un producto. */
export const MAX_PHOTO_BYTES = 1_500_000
export const MAX_PRODUCT_PHOTOS = 8

export const productPhoto = pgTable(
  "product_photo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    productId: uuid("product_id").notNull(),
    position: smallint("position").notNull().default(0),
    contentType: text("content_type").$type<PhotoType>().notNull(),
    content: bytea("content").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("product_photo_type_check", inList("content_type", PHOTO_TYPES)),
    check(
      "product_photo_size_check",
      sql`octet_length(${table.content}) between 1 and ${sql.raw(String(MAX_PHOTO_BYTES))}`,
    ),
    foreignKey({
      name: "product_photo_product_fkey",
      columns: [table.storeId, table.productId],
      foreignColumns: [product.storeId, product.id],
    }).onDelete("cascade"),
    unique("product_photo_store_id_key").on(table.storeId, table.id),
    index("product_photo_product_idx").on(table.productId, table.position),
  ],
)

/**
 * Una variante: una combinación de las opciones del producto, con su código, su stock y, si
 * quiere, su propio precio y su foto (si no, los del producto). El stock no se escribe: solo
 * cambia con un movimiento del kardex (`stock_movement`), que lo pone al día en la base.
 * Una variante que se deja de vender se quita (`removed_at`) y su kardex se conserva.
 */
export const productVariant = pgTable(
  "product_variant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    productId: uuid("product_id").notNull(),
    /** Un valor por cada opción del producto, en su orden. Vacío: el producto no tiene opciones. */
    optionValues: text("option_values").array().notNull().default(sql`'{}'::text[]`),
    /** El código (SKU) de la variante, único en la tienda. */
    sku: text("sku").notNull(),
    priceCents: integer("price_cents"),
    /** Una de las fotos del producto; al borrarla, la variante vuelve a la del producto. */
    photoId: uuid("photo_id"),
    stock: integer("stock").notNull().default(0),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("product_variant_sku_check", sql`${table.sku} ~ '^[A-Za-z0-9._/-]{1,40}$'`),
    check(
      "product_variant_price_check",
      sql`${table.priceCents} is null or ${table.priceCents} > 0`,
    ),
    check("product_variant_stock_check", sql`${table.stock} >= 0`),
    check("product_variant_values_check", sql`cardinality(${table.optionValues}) <= 3`),
    foreignKey({
      name: "product_variant_product_fkey",
      columns: [table.storeId, table.productId],
      foreignColumns: [product.storeId, product.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "product_variant_photo_fkey",
      columns: [table.storeId, table.photoId],
      foreignColumns: [productPhoto.storeId, productPhoto.id],
    }),
    unique("product_variant_store_id_key").on(table.storeId, table.id),
    uniqueIndex("product_variant_sku_uidx")
      .on(table.storeId, sql`lower(${table.sku})`)
      .where(sql`removed_at is null`),
    uniqueIndex("product_variant_values_uidx")
      .on(table.productId, table.optionValues)
      .where(sql`removed_at is null`),
    index("product_variant_product_idx").on(table.productId),
  ],
)

/** Lo que mueve el stock (decisión 3): una entrada, una venta, su anulación o un ajuste a mano. */
export const STOCK_MOVEMENT_KINDS = ["entrada", "venta", "anulacion", "ajuste"] as const
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number]

/**
 * El kardex de cada variante: cada movimiento con quién, cuándo, la cantidad y el saldo que
 * dejó. Solo se agrega: no se cambia ni se borra. Al agregarlo, la base pone al día el stock
 * de la variante y anota el saldo (`stock_movement_apply`, en la migración de reglas), y
 * rechaza un saldo negativo.
 */
export const stockMovement = pgTable(
  "stock_movement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    kind: text("kind").$type<StockMovementKind>().notNull(),
    /** Con signo: lo que entra suma y lo que sale resta. */
    quantity: integer("quantity").notNull(),
    /** El stock que quedó; lo pone la base. */
    balance: integer("balance").notNull().default(0),
    /** En una entrada, lo que costó cada unidad (opcional): con él se avisa si el mínimo queda cerca. */
    unitCostCents: integer("unit_cost_cents"),
    /** En un ajuste, el motivo escrito; en una entrada, una nota opcional. */
    reason: text("reason"),
    /** En una venta o su anulación, el pedido (B4). */
    reference: text("reference"),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("stock_movement_kind_check", inList("kind", STOCK_MOVEMENT_KINDS)),
    check(
      "stock_movement_sign_check",
      sql`case ${table.kind} when 'entrada' then ${table.quantity} > 0 when 'anulacion' then ${table.quantity} > 0 when 'venta' then ${table.quantity} < 0 else ${table.quantity} <> 0 end`,
    ),
    check(
      "stock_movement_reason_check",
      sql`(${table.kind} <> 'ajuste' or char_length(btrim(coalesce(${table.reason}, ''))) >= 3) and (${table.reason} is null or char_length(${table.reason}) <= 300)`,
    ),
    check(
      "stock_movement_cost_check",
      sql`${table.unitCostCents} is null or (${table.kind} = 'entrada' and ${table.unitCostCents} >= 0)`,
    ),
    check(
      "stock_movement_reference_check",
      sql`(${table.kind} in ('venta','anulacion')) = (${table.reference} is not null) and (${table.reference} is null or char_length(${table.reference}) between 1 and 80)`,
    ),
    check("stock_movement_balance_check", sql`${table.balance} >= 0`),
    foreignKey({
      name: "stock_movement_variant_fkey",
      columns: [table.storeId, table.variantId],
      foreignColumns: [productVariant.storeId, productVariant.id],
    }).onDelete("cascade"),
    index("stock_movement_variant_idx").on(table.variantId, table.createdAt),
    // Un pedido descuenta una sola vez y se devuelve una sola vez: repetirlo no duplica.
    uniqueIndex("stock_movement_reference_uidx")
      .on(table.storeId, table.variantId, table.reference, table.kind)
      .where(sql`reference is not null`),
  ],
)

/** El precio por cantidad (Schema.org `eligibleQuantity`): desde N unidades, cada una a X. */
export const productQuantityPrice = pgTable(
  "product_quantity_price",
  {
    storeId: uuid("store_id").notNull(),
    productId: uuid("product_id").notNull(),
    minQuantity: smallint("min_quantity").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
  },
  (table) => [
    primaryKey({
      name: "product_quantity_price_pkey",
      columns: [table.productId, table.minQuantity],
    }),
    check("product_quantity_price_quantity_check", sql`${table.minQuantity} between 2 and 1000`),
    check("product_quantity_price_price_check", sql`${table.unitPriceCents} > 0`),
    foreignKey({
      name: "product_quantity_price_product_fkey",
      columns: [table.storeId, table.productId],
      foreignColumns: [product.storeId, product.id],
    }).onDelete("cascade"),
  ],
)

/**
 * Una promoción con fecha: un porcentaje menos, de un día a otro (inclusive). No se suma con
 * otra ni con el precio por cantidad: va la mejor para el cliente (tablero 14). En un mismo
 * producto no se pisan.
 */
export const productPromotion = pgTable(
  "product_promotion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    productId: uuid("product_id").notNull(),
    name: text("name").notNull(),
    percentOff: smallint("percent_off").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("product_promotion_name_check", sql`char_length(btrim(${table.name})) between 1 and 60`),
    check("product_promotion_percent_check", sql`${table.percentOff} between 1 and 90`),
    check("product_promotion_dates_check", sql`${table.endsOn} >= ${table.startsOn}`),
    foreignKey({
      name: "product_promotion_product_fkey",
      columns: [table.storeId, table.productId],
      foreignColumns: [product.storeId, product.id],
    }).onDelete("cascade"),
    index("product_promotion_product_idx").on(table.productId, table.startsOn),
  ],
)

/** Lo que Sofi puede recomendar junto a un producto: algo parecido o algo que combina. */
export const PRODUCT_RELATIONS = ["parecido", "combina"] as const
export type ProductRelation = (typeof PRODUCT_RELATIONS)[number]

/** Una relación entre dos productos; vale para los dos, así que se guarda una vez (el menor primero). */
export const productLink = pgTable(
  "product_link",
  {
    storeId: uuid("store_id").notNull(),
    productA: uuid("product_a").notNull(),
    productB: uuid("product_b").notNull(),
    kind: text("kind").$type<ProductRelation>().notNull(),
  },
  (table) => [
    primaryKey({
      name: "product_link_pkey",
      columns: [table.productA, table.productB, table.kind],
    }),
    check("product_link_kind_check", inList("kind", PRODUCT_RELATIONS)),
    check("product_link_order_check", sql`${table.productA} < ${table.productB}`),
    foreignKey({
      name: "product_link_a_fkey",
      columns: [table.storeId, table.productA],
      foreignColumns: [product.storeId, product.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "product_link_b_fkey",
      columns: [table.storeId, table.productB],
      foreignColumns: [product.storeId, product.id],
    }).onDelete("cascade"),
    index("product_link_b_idx").on(table.productB),
  ],
)

/*
 * Los pedidos (paso B4 del lienzo B, tableros 2, 5 y 14): lo que se vendió, cómo se cobra y
 * cómo se entrega. Un pedido guarda una copia de lo que se acordó (nombres, precios, la forma
 * de entrega y el medio de pago): lo que cambie después en la configuración no lo toca.
 */

/**
 * Los estados de un pedido (tablero 2). «Pago por confirmar» nunca se muestra como pagado.
 * Uno que se paga al recibir empieza en `por_salir`: se cobra en la puerta.
 */
export const ORDER_STATES = [
  "por_pagar",
  "por_confirmar",
  "por_salir",
  "en_camino",
  "entregado",
  "anulado",
] as const
export type OrderState = (typeof ORDER_STATES)[number]

/** Por dónde llegó la venta. «otro» es la que llega por otro lado: una llamada o la tienda. */
export const ORDER_CHANNELS = ["whatsapp", "instagram", "messenger", "otro"] as const
export type OrderChannel = (typeof ORDER_CHANNELS)[number]

export const saleOrder = pgTable(
  "sale_order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    /** El número que ve la persona («0142»), seguido en cada tienda. */
    number: integer("number").notNull(),
    state: text("state").$type<OrderState>().notNull(),
    channel: text("channel").$type<OrderChannel>().notNull(),
    /** La conversación de la que salió (B2); nulo si se anotó a mano. */
    conversationId: text("conversation_id"),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone"),
    address: text("address").notNull().default(""),
    notes: text("notes").notNull().default(""),
    /** La forma de entrega, copiada al armar el pedido. */
    deliveryMethodId: uuid("delivery_method_id"),
    deliveryName: text("delivery_name").notNull(),
    deliveryType: text("delivery_type").$type<DeliveryType>().notNull(),
    deliveryZone: text("delivery_zone"),
    /** Lo que costaba el envío y lo que paga el cliente: la diferencia la pone la tienda. */
    deliveryListCents: integer("delivery_list_cents").notNull(),
    deliveryCents: integer("delivery_cents").notNull(),
    /** El envío es gratis por la compra mínima de la forma de entrega, no por negociar. */
    deliveryFreeByPolicy: boolean("delivery_free_by_policy").notNull().default(false),
    /** El medio de pago, copiado al armar el pedido. */
    paymentMethodId: uuid("payment_method_id"),
    paymentName: text("payment_name").notNull(),
    paymentCollection: text("payment_collection").$type<PaymentCollection>().notNull(),
    paymentDetails: text("payment_details").notNull().default(""),
    /** Lo de los productos sin negociar (con su promoción), lo que paga y lo que cedió. */
    itemsAutoCents: integer("items_auto_cents").notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),
    discountCents: integer("discount_cents").notNull().default(0),
    giftCents: integer("gift_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull(),
    /** El margen que había hasta los mínimos y cuánto se usó (tablero 14: todo queda escrito). */
    marginCents: integer("margin_cents").notNull().default(0),
    marginUsedCents: integer("margin_used_cents").notNull().default(0),
    /** Un precio negociado vale 24 horas: si no paga antes, vence. Nulo sin negociar. */
    priceExpiresAt: timestamp("price_expires_at", { withTimezone: true }),
    deliverOn: date("deliver_on"),
    /** El número de envío de la agencia, si lo hay. */
    tracking: text("tracking"),
    /** El link de pago vigente: su dirección, su referencia en el proveedor y cuándo vence. */
    linkUrl: text("link_url"),
    linkRef: text("link_ref"),
    linkExpiresAt: timestamp("link_expires_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("sale_order_state_check", inList("state", ORDER_STATES)),
    check("sale_order_channel_check", inList("channel", ORDER_CHANNELS)),
    check("sale_order_number_check", sql`${table.number} > 0`),
    check(
      "sale_order_customer_check",
      sql`char_length(btrim(${table.customerName})) between 1 and 120 and (${table.customerPhone} is null or char_length(${table.customerPhone}) <= 30) and char_length(${table.address}) <= 300 and char_length(${table.notes}) <= 500`,
    ),
    check(
      "sale_order_payment_collection_check",
      inList("payment_collection", PAYMENT_COLLECTIONS),
    ),
    check(
      "sale_order_amounts_check",
      sql`${table.deliveryCents} between 0 and ${table.deliveryListCents} and ${table.subtotalCents} >= 0 and ${table.discountCents} >= 0 and ${table.giftCents} >= 0 and ${table.totalCents} = ${table.subtotalCents} + ${table.deliveryCents} and ${table.marginUsedCents} between 0 and ${table.marginCents}`,
    ),
    check(
      "sale_order_cancel_check",
      sql`(${table.state} = 'anulado') = (${table.cancelReason} is not null) and (${table.cancelReason} is null or char_length(btrim(${table.cancelReason})) between 3 and 300)`,
    ),
    check(
      "sale_order_tracking_check",
      sql`${table.tracking} is null or char_length(${table.tracking}) between 1 and 80`,
    ),
    foreignKey({
      name: "sale_order_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    unique("sale_order_store_id_key").on(table.storeId, table.id),
    unique("sale_order_number_key").on(table.storeId, table.number),
    index("sale_order_state_idx").on(table.storeId, table.state, table.createdAt),
  ],
)

/** Una línea del pedido: una variante, con su precio de lista, el sin negociar, el mínimo y el acordado. */
export const saleOrderLine = pgTable(
  "sale_order_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    orderId: uuid("order_id").notNull(),
    position: smallint("position").notNull(),
    productId: uuid("product_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    productName: text("product_name").notNull(),
    variantName: text("variant_name").notNull(),
    sku: text("sku").notNull(),
    quantity: integer("quantity").notNull(),
    /** El precio de lista de la variante. */
    listUnitCents: integer("list_unit_cents").notNull(),
    /** El mejor precio sin negociar: la promoción o el precio por cantidad, sin sumarlos. */
    autoUnitCents: integer("auto_unit_cents").notNull(),
    /** Lo más bajo a lo que se puede vender: el mínimo del producto, o el sin negociar si no hay. */
    floorUnitCents: integer("floor_unit_cents").notNull(),
    /** El acordado; 0 si va de regalo. */
    unitCents: integer("unit_cents").notNull(),
    gift: boolean("gift").notNull().default(false),
  },
  (table) => [
    check("sale_order_line_quantity_check", sql`${table.quantity} between 1 and 1000`),
    check(
      "sale_order_line_price_check",
      sql`${table.floorUnitCents} <= ${table.autoUnitCents} and ${table.autoUnitCents} <= ${table.listUnitCents} and (case when ${table.gift} then ${table.unitCents} = 0 else ${table.unitCents} between ${table.floorUnitCents} and ${table.autoUnitCents} end)`,
    ),
    foreignKey({
      name: "sale_order_line_order_fkey",
      columns: [table.storeId, table.orderId],
      foreignColumns: [saleOrder.storeId, saleOrder.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "sale_order_line_variant_fkey",
      columns: [table.storeId, table.variantId],
      foreignColumns: [productVariant.storeId, productVariant.id],
    }),
    index("sale_order_line_order_idx").on(table.orderId, table.position),
    index("sale_order_line_variant_idx").on(table.variantId),
  ],
)

/** Cómo va un pago anotado: espera a una persona, confirmado o no coincide. */
export const ORDER_PAYMENT_STATES = ["por_confirmar", "confirmado", "no_coincide"] as const
export type OrderPaymentState = (typeof ORDER_PAYMENT_STATES)[number]

/** Un pago de un pedido: por el link (lo confirma el proveedor), una captura o al recibir. */
export const orderPayment = pgTable(
  "order_payment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    orderId: uuid("order_id").notNull(),
    kind: text("kind").$type<PaymentCollection>().notNull(),
    status: text("status").$type<OrderPaymentState>().notNull(),
    amountCents: integer("amount_cents").notNull(),
    /** El número de operación que se ve en la captura. */
    operation: text("operation"),
    /** El proveedor del link y su número de pago: un mismo pago no se anota dos veces. */
    provider: text("provider"),
    providerRef: text("provider_ref"),
    /** La captura, guardada como las fotos del catálogo (ADR 0206). */
    photoType: text("photo_type").$type<PhotoType>(),
    photo: bytea("photo"),
    /** Por qué no coincide, o lo que anotó el sistema. */
    note: text("note"),
    /** Quién lo anotó; nulo si llegó del proveedor del link. */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [
    check("order_payment_kind_check", inList("kind", PAYMENT_COLLECTIONS)),
    check("order_payment_status_check", inList("status", ORDER_PAYMENT_STATES)),
    check("order_payment_amount_check", sql`${table.amountCents} >= 0`),
    check(
      "order_payment_texts_check",
      sql`(${table.operation} is null or char_length(${table.operation}) between 1 and 60) and (${table.note} is null or char_length(${table.note}) <= 300)`,
    ),
    check(
      "order_payment_photo_check",
      sql`(${table.photo} is null) = (${table.photoType} is null) and (${table.photoType} is null or ${inList("photo_type", PHOTO_TYPES)}) and (${table.photo} is null or octet_length(${table.photo}) between 1 and ${sql.raw(String(MAX_PHOTO_BYTES))})`,
    ),
    check(
      "order_payment_reviewed_check",
      sql`(${table.status} = 'por_confirmar') = (${table.reviewedAt} is null) and (${table.status} <> 'no_coincide' or char_length(btrim(coalesce(${table.note}, ''))) >= 3)`,
    ),
    foreignKey({
      name: "order_payment_order_fkey",
      columns: [table.storeId, table.orderId],
      foreignColumns: [saleOrder.storeId, saleOrder.id],
    }).onDelete("cascade"),
    unique("order_payment_store_id_key").on(table.storeId, table.id),
    uniqueIndex("order_payment_provider_uidx")
      .on(table.storeId, table.provider, table.providerRef)
      .where(sql`provider_ref is not null`),
    index("order_payment_order_idx").on(table.orderId, table.createdAt),
  ],
)

/**
 * Lo que pasó con cada pedido, con quién y cuándo (tablero 2: «cada estado dice quién lo
 * cambió y cuándo»). También los avisos al cliente: hoy no salen (WhatsApp llega con B2) y
 * quedan aquí con lo que dirían. Solo se agrega.
 */
export const ORDER_EVENT_ACTIONS = [
  "creado",
  "link",
  "comprobante",
  "pago_confirmado",
  "pago_no_coincide",
  "pago_link",
  "salio",
  "entregado",
  "anulado",
  "aviso",
] as const
export type OrderEventAction = (typeof ORDER_EVENT_ACTIONS)[number]

export const orderEvent = pgTable(
  "order_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    orderId: uuid("order_id").notNull(),
    /** Quién lo hizo; nulo si fue el proveedor del link. */
    actorUserId: text("actor_user_id"),
    action: text("action").$type<OrderEventAction>().notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("order_event_action_check", inList("action", ORDER_EVENT_ACTIONS)),
    foreignKey({
      name: "order_event_order_fkey",
      columns: [table.storeId, table.orderId],
      foreignColumns: [saleOrder.storeId, saleOrder.id],
    }).onDelete("cascade"),
    index("order_event_order_idx").on(table.orderId, table.createdAt),
  ],
)

/** Los proveedores de link de pago que se pueden conectar (adaptadores intercambiables). */
export const PAYMENT_LINK_PROVIDERS = ["mercadopago"] as const
export type PaymentLinkProvider = (typeof PAYMENT_LINK_PROVIDERS)[number]

/**
 * La cuenta del proveedor del link de pago de la tienda, con sus credenciales cifradas
 * (`secretos.ts` de la API). Nunca vuelven al navegador: la pantalla solo sabe si está conectada.
 */
export const storePaymentLink = pgTable(
  "store_payment_link",
  {
    storeId: uuid("store_id").primaryKey(),
    provider: text("provider").$type<PaymentLinkProvider>().notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    webhookSecretEnc: text("webhook_secret_enc"),
    /** Los últimos caracteres del token, para reconocer la cuenta sin mostrarla. */
    hint: text("hint").notNull(),
    connectedBy: text("connected_by").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("store_payment_link_provider_check", inList("provider", PAYMENT_LINK_PROVIDERS)),
    check("store_payment_link_hint_check", sql`char_length(${table.hint}) between 1 and 8`),
    foreignKey({
      name: "store_payment_link_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
  ],
)
