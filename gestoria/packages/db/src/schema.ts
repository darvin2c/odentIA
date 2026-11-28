import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  pgTable,
  pgView,
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

/** Una franja de entrega: de `start` a `end`, en minutos desde las 00:00 de la tienda. */
export interface DeliverySlot {
  start: number
  end: number
}

/** Lo más que una tienda configura: tres o cuatro es lo de una tienda real (tablero 6). */
export const MAX_DELIVERY_SLOTS = 8

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
    /**
     * El país de la tienda (ISO 3166-1 alfa-2): la administración cobra con su impuesto (ADR
     * 0211). Nulo en las tiendas de antes o si no lo eligió.
     */
    country: text("country"),
    /**
     * La hora de la tienda: su zona horaria de la base de datos de zonas horarias de IANA
     * («America/Lima»). Con ella se cuenta qué es «hoy», «mañana», los periodos de Reportes y las
     * promociones (ADR 0222). La aplicación comprueba que exista; aquí, solo su forma.
     */
    timeZone: text("time_zone").notNull().default("America/Lima"),
    /**
     * «Tu marca» (lienzo «gestorIA como odentIA», tablero 10): el nombre que ve el cliente, si no
     * es el de la tienda, y el color de marca (seis cifras hexadecimales en minúsculas; de él se
     * calcula todo lo demás al mostrarlo, ADR 0162). Nulos: el nombre de la tienda y el color de
     * gestorIA. El logo y la portada van en `store_image`; el nombre del link, en `store_link`.
     */
    publicName: text("public_name"),
    brandColor: text("brand_color"),
    /**
     * Las franjas de entrega (Despachos, tablero 6): opcionales, hasta `MAX_DELIVERY_SLOTS`, cada
     * una con su hora de inicio y de fin en minutos desde las 00:00 de la tienda («9–13 h» es
     * 540–780). Un pedido sin franja sale igual. El pedido copia la suya: cambiarlas no lo toca.
     */
    deliverySlots: jsonb("delivery_slots").$type<DeliverySlot[]>().notNull().default([]),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("store_name_check", sql`char_length(btrim(${table.name})) between 1 and 80`),
    check("store_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("store_country_check", sql`${table.country} is null or ${table.country} ~ '^[A-Z]{2}$'`),
    check(
      "store_public_name_check",
      sql`${table.publicName} is null or char_length(btrim(${table.publicName})) between 1 and 80`,
    ),
    check(
      "store_brand_color_check",
      sql`${table.brandColor} is null or ${table.brandColor} ~ '^#[0-9a-f]{6}$'`,
    ),
    check(
      "store_delivery_slots_check",
      sql`jsonb_typeof(${table.deliverySlots}) = 'array' and jsonb_array_length(${table.deliverySlots}) <= ${sql.raw(String(MAX_DELIVERY_SLOTS))}`,
    ),
    check(
      "store_time_zone_check",
      sql`char_length(${table.timeZone}) <= 64 and ${table.timeZone} ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$'`,
    ),
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
  "configuracion.sofi",
  // Lo que pidió la administración (ADR 0214) y la entrada de soporte.
  "soporte.pedido",
  "soporte.aceptado",
  "soporte.rechazado",
  "soporte.quitado",
  "soporte.entro",
  // Soporte terminó su mirada con «Salir» (ADR 0219).
  "soporte.salio",
  // Los datos de la tienda: su nombre, su país y su hora (ADR 0222).
  "configuracion.tienda",
  // «Tu marca»: el nombre que ve el cliente, el color, el logo, la portada y el nombre del link.
  "configuracion.marca",
  // La plantilla de un rubro que ajustó la tienda (lienzo «La ficha del producto», decisión 1).
  "catalogo.plantilla",
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

/**
 * Qué forma de cobro es, para pedir sus datos (lienzo «gestorIA · Configuración, de nuevo»,
 * tablero 6): Yape y Plin con su celular, su titular y su QR; la transferencia con su banco, su
 * cuenta y su CCI; el efectivo y el POS al recibir; el link (la pasarela) y «otro», con texto
 * libre. El tipo de UN/CEFACT 4461 (`type_code`) sigue diciendo con qué se paga: cada forma lleva
 * el suyo fijo, menos «otro».
 */
export const PAYMENT_KINDS = [
  "yape",
  "plin",
  "transferencia",
  "efectivo",
  "pos",
  "link",
  "otro",
] as const
export type PaymentKind = (typeof PAYMENT_KINDS)[number]

export const storePaymentMethod = pgTable(
  "store_payment_method",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    /** Como lo dirá Sofi al cliente («Yape», «Transferencia BCP»). */
    name: text("name").notNull(),
    typeCode: text("type_code").$type<PaymentTypeCode>().notNull(),
    collection: text("collection").$type<PaymentCollection>().notNull(),
    kind: text("kind").$type<PaymentKind>().notNull().default("otro"),
    /**
     * Lo que Sofi le envía al cliente para pagar: el número, la cuenta, a nombre de quién. En Yape,
     * Plin y la transferencia lo arma el servidor con sus datos; en lo demás, lo escribe la tienda.
     */
    details: text("details").notNull().default(""),
    /** El celular de Yape o Plin, en E.164 (`+51987654321`). */
    phone: text("phone"),
    /** A nombre de quién está: la clienta lo compara antes de pagar. */
    holder: text("holder"),
    /** El banco de la transferencia: su código de entidad, los tres primeros números del CCI. */
    bankCode: text("bank_code"),
    accountNumber: text("account_number"),
    /** El Código de Cuenta Interbancario: 20 números, con sus dígitos de control revisados. */
    cci: text("cci"),
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
    check("store_payment_method_kind_check", inList("kind", PAYMENT_KINDS)),
    // Cada forma con su tipo de 4461 y su manera de confirmarse; «otro» elige los suyos.
    check(
      "store_payment_method_kind_type_check",
      sql`case ${table.kind}
        when 'yape' then ${table.typeCode} = '68' and ${table.collection} = 'comprobante'
        when 'plin' then ${table.typeCode} = '68' and ${table.collection} = 'comprobante'
        when 'transferencia' then ${table.typeCode} = '30' and ${table.collection} = 'comprobante'
        when 'efectivo' then ${table.typeCode} = '10' and ${table.collection} = 'al_recibir'
        when 'pos' then ${table.typeCode} = '48' and ${table.collection} = 'al_recibir'
        when 'link' then ${table.collection} = 'link'
        else ${table.collection} <> 'link' end`,
    ),
    // Yape y Plin, con su celular y su titular; la transferencia, con su banco, cuenta y titular.
    check(
      "store_payment_method_kind_data_check",
      sql`(${table.kind} not in ('yape', 'plin') or (${table.phone} is not null and ${table.holder} is not null))
        and (${table.kind} <> 'transferencia' or (${table.bankCode} is not null and ${table.accountNumber} is not null and ${table.holder} is not null))`,
    ),
    check("store_payment_method_phone_check", sql`${table.phone} ~ '^[+][1-9][0-9]{7,14}$'`),
    check(
      "store_payment_method_holder_check",
      sql`char_length(btrim(${table.holder})) between 1 and 80`,
    ),
    check("store_payment_method_bank_check", sql`${table.bankCode} ~ '^[0-9]{3}$'`),
    check(
      "store_payment_method_account_check",
      sql`${table.accountNumber} ~ '^[0-9][0-9 -]{4,28}[0-9]$'`,
    ),
    check("store_payment_method_cci_check", sql`${table.cci} ~ '^[0-9]{20}$'`),
    unique("store_payment_method_store_id_key").on(table.storeId, table.id),
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
 * Los rubros de la ficha del producto (lienzo «La ficha del producto», tablero 10; decisión 1):
 * cada uno con su plantilla fija en `apps/api/src/rubros.ts`, que cada tienda ajusta en
 * `store_template_field`.
 */
export const PRODUCT_RUBROS = ["calzado", "ropa", "cosmetica", "tecnologia", "hogar"] as const
export type ProductRubro = (typeof PRODUCT_RUBROS)[number]

/**
 * Lo que la tienda dice del producto (decisión 8). «Disponible» y «agotado» no se guardan: salen
 * del stock. Por encargo lleva en cuántos días; con cupo, cuántos por día; preventa, cuándo llega.
 * En liquidación el mínimo es el precio: no se negocia. «Ya no se vende» no entra a un pedido.
 */
export const PRODUCT_STATUSES = [
  "encargo",
  "cupo",
  "preventa",
  "liquidacion",
  "no_se_vende",
] as const
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]

/**
 * El valor de un dato del rubro: una opción o un texto (`string`), un número (en la unidad de la
 * plantilla), uno por cada talla (`{ "38": 24 }`), una tabla por talla (`{ "M": [50, 68] }`, en
 * el orden de sus columnas), una fecha ISO 8601 (`2028-06` o `2028-06-15`) o «No aplica».
 */
export type RubroValue =
  | string
  | number
  | Record<string, number>
  | Record<string, (number | null)[]>
  | { noAplica: true }

/** Lo más que una ficha guarda de palabras con que la buscan. */
export const MAX_PRODUCT_KEYWORDS = 30

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
    /** «Lo que Sofi puede contar»: el texto libre de la ficha (material, horma, cuidados). */
    description: text("description").notNull().default(""),
    listPriceCents: integer("list_price_cents").notNull(),
    minPriceCents: integer("min_price_cents"),
    options: jsonb("options").$type<ProductOption[]>().notNull().default([]),
    /**
     * Cuál de sus opciones es el color (o el tono, o el acabado): su índice en `options`. Los
     * colores existen por los valores de esa opción, en su orden; `product_color` guarda solo
     * cómo se ven (hex) y su foto. Nulo: el producto no tiene color.
     */
    colorOption: smallint("color_option"),
    /** El rubro de su plantilla; nulo: sin datos del rubro. */
    rubro: text("rubro").$type<ProductRubro>(),
    /** Los datos del rubro, por la clave de cada dato de la plantilla (`RubroValue`). */
    rubroData: jsonb("rubro_data").$type<Record<string, RubroValue>>().notNull().default({}),
    /** El código del producto («ZAP-LONA»), único en la tienda; cada variante tiene el suyo (SKU). */
    code: text("code"),
    status: text("status").$type<ProductStatus>(),
    /** Por encargo: en cuántos días se consigue. */
    statusDays: smallint("status_days"),
    /** Con cupo: cuántos se hacen por día. */
    statusPerDay: smallint("status_per_day"),
    /** Preventa: el día que llega. */
    statusDate: date("status_date"),
    /**
     * El paquete para la agencia (decisión 10), opcional: el peso en gramos y las medidas en
     * milímetros, enteros en unidades del SI (ISO 80000), como los pide GS1 para el envío. La
     * pantalla los muestra en kg y cm. Las tres medidas van juntas.
     */
    packageWeightG: integer("package_weight_g"),
    packageLengthMm: integer("package_length_mm"),
    packageWidthMm: integer("package_width_mm"),
    packageHeightMm: integer("package_height_mm"),
    /** Las palabras con que lo buscan las clientas («zapa», «tenis»). */
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    /** Si se muestra en la web de la tienda y su nombre en el link, único en la tienda. */
    webVisible: boolean("web_visible").notNull().default(true),
    webSlug: text("web_slug"),
    /**
     * El precio para revendedoras («por mayor»): desde tantas unidades del producto, cada una a
     * tanto. Es un precio por cantidad más, con su nombre: no se suma con otro (va el mejor).
     */
    wholesaleMinQuantity: smallint("wholesale_min_quantity"),
    wholesalePriceCents: integer("wholesale_price_cents"),
    /** El combo: cuánto menos cuesta lo que combina con este (`product_link` «combina») si va junto. */
    comboPercentOff: smallint("combo_percent_off"),
    /**
     * Lo que Sofi puede ofrecer de este producto (tablero 21 del lienzo «gestorIA como odentIA»),
     * siempre del mismo margen y una sola vez (ADR 0224): poner el envío, unos soles menos, el
     * precio de la 2.ª unidad y un regalo (lo que regala, en palabras; nulo: no regala).
     */
    offerDelivery: boolean("offer_delivery").notNull().default(true),
    offerDiscount: boolean("offer_discount").notNull().default(true),
    offerSecondUnit: boolean("offer_second_unit").notNull().default(false),
    offerGift: text("offer_gift"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "product_wholesale_check",
      sql`(${table.wholesaleMinQuantity} is null) = (${table.wholesalePriceCents} is null) and (${table.wholesaleMinQuantity} is null or (${table.wholesaleMinQuantity} between 2 and 10000 and ${table.wholesalePriceCents} > 0 and ${table.wholesalePriceCents} < ${table.listPriceCents}))`,
    ),
    check(
      "product_offers_check",
      sql`(${table.comboPercentOff} is null or ${table.comboPercentOff} between 1 and 90) and (${table.offerGift} is null or char_length(btrim(${table.offerGift})) between 1 and 80)`,
    ),
    check(
      "product_color_option_check",
      sql`${table.colorOption} is null or ${table.colorOption} between 0 and 2`,
    ),
    check("product_rubro_check", sql`${table.rubro} is null or ${inList("rubro", PRODUCT_RUBROS)}`),
    check("product_rubro_data_check", sql`jsonb_typeof(${table.rubroData}) = 'object'`),
    check(
      "product_code_check",
      sql`${table.code} is null or ${table.code} ~ '^[A-Za-z0-9._/-]{1,40}$'`,
    ),
    check(
      "product_status_check",
      sql`(${table.status} is null or ${inList("status", PRODUCT_STATUSES)}) and coalesce(${table.status} = 'encargo', false) = (${table.statusDays} is not null) and coalesce(${table.status} = 'cupo', false) = (${table.statusPerDay} is not null) and coalesce(${table.status} = 'preventa', false) = (${table.statusDate} is not null) and (${table.statusDays} is null or ${table.statusDays} between 1 and 365) and (${table.statusPerDay} is null or ${table.statusPerDay} between 1 and 1000)`,
    ),
    check(
      "product_package_check",
      sql`(${table.packageWeightG} is null or ${table.packageWeightG} between 1 and 1000000) and ((${table.packageLengthMm} is null and ${table.packageWidthMm} is null and ${table.packageHeightMm} is null) or (${table.packageLengthMm} is not null and ${table.packageWidthMm} is not null and ${table.packageHeightMm} is not null and ${table.packageLengthMm} between 1 and 10000 and ${table.packageWidthMm} between 1 and 10000 and ${table.packageHeightMm} between 1 and 10000))`,
    ),
    check(
      "product_keywords_check",
      sql`cardinality(${table.keywords}) <= ${sql.raw(String(MAX_PRODUCT_KEYWORDS))}`,
    ),
    check(
      "product_web_slug_check",
      sql`${table.webSlug} is null or (${table.webSlug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(${table.webSlug}) <= 80)`,
    ),
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
    uniqueIndex("product_store_code_uidx")
      .on(table.storeId, sql`lower(${table.code})`)
      .where(sql`code is not null`),
    uniqueIndex("product_store_web_slug_uidx")
      .on(table.storeId, table.webSlug)
      .where(sql`web_slug is not null`),
  ],
)

/** El contenido de una foto: se guarda en la base tal como llegó (la pantalla ya la achicó). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" })

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
export type PhotoType = (typeof PHOTO_TYPES)[number]
/** Lo más que pesa una foto (la pantalla la achica antes de subirla) y cuántas lleva un producto. */
export const MAX_PHOTO_BYTES = 1_500_000
export const MAX_PRODUCT_PHOTOS = 8

/** Las imágenes de «Tu marca»: el logo y la foto de portada, una de cada una por tienda. */
export const STORE_IMAGE_KINDS = ["logo", "portada"] as const
export type StoreImageKind = (typeof STORE_IMAGE_KINDS)[number]

export const storeImage = pgTable(
  "store_image",
  {
    storeId: uuid("store_id").notNull(),
    kind: text("kind").$type<StoreImageKind>().notNull(),
    contentType: text("content_type").$type<PhotoType>().notNull(),
    content: bytea("content").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "store_image_pkey", columns: [table.storeId, table.kind] }),
    check("store_image_kind_check", inList("kind", STORE_IMAGE_KINDS)),
    check("store_image_type_check", inList("content_type", PHOTO_TYPES)),
    check(
      "store_image_size_check",
      sql`octet_length(${table.content}) between 1 and ${sql.raw(String(MAX_PHOTO_BYTES))}`,
    ),
    foreignKey({
      name: "store_image_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
  ],
)

/**
 * El QR de Yape o Plin de un medio de pago (tablero 6): la imagen tal como la baja la tienda de
 * su app, en la base y mirada por su contenido (JPEG, PNG o WebP), una por medio. Se borra con él.
 */
export const storePaymentQr = pgTable(
  "store_payment_qr",
  {
    storeId: uuid("store_id").notNull(),
    methodId: uuid("method_id").notNull(),
    contentType: text("content_type").$type<PhotoType>().notNull(),
    content: bytea("content").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "store_payment_qr_pkey", columns: [table.methodId] }),
    check("store_payment_qr_type_check", inList("content_type", PHOTO_TYPES)),
    check(
      "store_payment_qr_size_check",
      sql`octet_length(${table.content}) between 1 and ${sql.raw(String(MAX_PHOTO_BYTES))}`,
    ),
    foreignKey({
      name: "store_payment_qr_method_fkey",
      columns: [table.storeId, table.methodId],
      foreignColumns: [storePaymentMethod.storeId, storePaymentMethod.id],
    }).onDelete("cascade"),
  ],
)

/**
 * El nombre del link de la tienda (`calzadosrosa.gestoria24.com`, tableros 10 y 21): uno vigente
 * por tienda. El que se cambia se queda con ella (`current` falso): nadie más lo toma y el
 * catálogo lo llevará al nuevo. La clave es el nombre: dos tiendas nunca tienen el mismo, aunque
 * cada una vea solo los suyos. Qué nombres valen (los reservados) lo decide la API; aquí, su forma:
 * letras sin tilde, números y guiones sueltos, de 3 a 63 (lo que cabe en un nombre de dominio).
 */
export const storeLink = pgTable(
  "store_link",
  {
    name: text("name").primaryKey(),
    storeId: uuid("store_id").notNull(),
    current: boolean("current").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "store_link_name_check",
      sql`${table.name} ~ '^[a-z0-9](-?[a-z0-9]){2,62}$' and char_length(${table.name}) <= 63`,
    ),
    foreignKey({
      name: "store_link_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    uniqueIndex("store_link_current_uidx").on(table.storeId).where(sql`${table.current}`),
  ],
)

export const productPhoto = pgTable(
  "product_photo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    productId: uuid("product_id").notNull(),
    position: smallint("position").notNull().default(0),
    contentType: text("content_type").$type<PhotoType>().notNull(),
    content: bytea("content").notNull(),
    /** El color al que pertenece (decisión 9); nulo: vale para todos. */
    colorId: uuid("color_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check("product_photo_type_check", inList("content_type", PHOTO_TYPES)),
    foreignKey({
      name: "product_photo_color_fkey",
      columns: [table.storeId, table.colorId],
      foreignColumns: [productColor.storeId, productColor.id],
    }),
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
 * Cómo se ve un color de un producto (decisiones 6 y 9): su hex (`#rrggbb`, en minúsculas), el
 * segundo si es bicolor y la foto que manda Sofi cuando piden ese color. Qué colores hay y en qué
 * orden no se guarda aquí: son los valores de la opción del color (`product.color_option`), y
 * `value` es uno de ellos. Un valor sin fila es un color sin hex ni foto todavía.
 */
export const productColor = pgTable(
  "product_color",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    productId: uuid("product_id").notNull(),
    value: text("value").notNull(),
    hex: text("hex"),
    hex2: text("hex2"),
    photoId: uuid("photo_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    check("product_color_value_check", sql`char_length(btrim(${table.value})) between 1 and 30`),
    check(
      "product_color_hex_check",
      sql`(${table.hex} is null or ${table.hex} ~ '^#[0-9a-f]{6}$') and (${table.hex2} is null or (${table.hex} is not null and ${table.hex2} ~ '^#[0-9a-f]{6}$'))`,
    ),
    foreignKey({
      name: "product_color_product_fkey",
      columns: [table.storeId, table.productId],
      foreignColumns: [product.storeId, product.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "product_color_photo_fkey",
      columns: [table.storeId, table.photoId],
      foreignColumns: [productPhoto.storeId, productPhoto.id],
    }),
    unique("product_color_store_id_key").on(table.storeId, table.id),
    uniqueIndex("product_color_value_uidx").on(table.productId, sql`lower(${table.value})`),
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
    /**
     * Su código de barras: un GTIN de GS1 (EAN-13, UPC-A de 12, EAN-8 o GTIN-14), el que usan los
     * catálogos de Meta y Google (`gtin`). La API comprueba su dígito verificador; aquí, su forma.
     */
    barcode: text("barcode"),
    stock: integer("stock").notNull().default(0),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("product_variant_sku_check", sql`${table.sku} ~ '^[A-Za-z0-9._/-]{1,40}$'`),
    check(
      "product_variant_barcode_check",
      sql`${table.barcode} is null or ${table.barcode} ~ '^([0-9]{8}|[0-9]{12,14})$'`,
    ),
    uniqueIndex("product_variant_barcode_uidx")
      .on(table.storeId, table.barcode)
      .where(sql`removed_at is null and barcode is not null`),
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

/**
 * Lo que mueve el stock (decisión 3): una entrada, una venta, su anulación, un ajuste a mano o una
 * devolución (lo que vuelve de un pedido entregado con un cambio, con su motivo; tablero 17).
 */
export const STOCK_MOVEMENT_KINDS = [
  "entrada",
  "venta",
  "anulacion",
  "ajuste",
  "devolucion",
] as const
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
    /** En un ajuste o una devolución, el motivo; en una entrada, una nota opcional. */
    reason: text("reason"),
    /** En una venta, su anulación o una devolución, el pedido (B4). */
    reference: text("reference"),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("stock_movement_kind_check", inList("kind", STOCK_MOVEMENT_KINDS)),
    check(
      "stock_movement_sign_check",
      sql`case ${table.kind} when 'entrada' then ${table.quantity} > 0 when 'anulacion' then ${table.quantity} > 0 when 'devolucion' then ${table.quantity} > 0 when 'venta' then ${table.quantity} < 0 else ${table.quantity} <> 0 end`,
    ),
    check(
      "stock_movement_reason_check",
      sql`(${table.kind} not in ('ajuste','devolucion') or char_length(btrim(coalesce(${table.reason}, ''))) >= 3) and (${table.reason} is null or char_length(${table.reason}) <= 300)`,
    ),
    check(
      "stock_movement_cost_check",
      sql`${table.unitCostCents} is null or (${table.kind} = 'entrada' and ${table.unitCostCents} >= 0)`,
    ),
    check(
      "stock_movement_reference_check",
      sql`(${table.kind} in ('venta','anulacion','devolucion')) = (${table.reference} is not null) and (${table.reference} is null or char_length(${table.reference}) between 1 and 80)`,
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
 * Una promoción con fecha: un porcentaje menos, de un día a otro (inclusive), para todo el
 * producto o solo para un color o una talla (un valor de una de sus opciones). No se suma con
 * otra ni con el precio por cantidad: va la mejor para el cliente (tablero 14). Dos del mismo
 * alcance no se pisan.
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
    /** Su alcance: la opción (su índice en `product.options`) y su valor; nulos: todo el producto. */
    optionIndex: smallint("option_index"),
    optionValue: text("option_value"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("product_promotion_name_check", sql`char_length(btrim(${table.name})) between 1 and 60`),
    check("product_promotion_percent_check", sql`${table.percentOff} between 1 and 90`),
    check("product_promotion_dates_check", sql`${table.endsOn} >= ${table.startsOn}`),
    check(
      "product_promotion_scope_check",
      sql`(${table.optionIndex} is null) = (${table.optionValue} is null) and (${table.optionIndex} is null or (${table.optionIndex} between 0 and 2 and char_length(btrim(${table.optionValue})) between 1 and 30))`,
    ),
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
 * La ficha del producto (lienzo «La ficha del producto»): la plantilla de cada rubro que ajusta la
 * tienda, lo que Sofi no supo y el historial de cada cambio.
 */

/** Los tipos de un dato del rubro: una opción, un número con su unidad, un texto, uno por talla, una tabla por talla o una fecha. */
export const TEMPLATE_FIELD_TYPES = [
  "opcion",
  "numero",
  "texto",
  "por_talla",
  "tabla",
  "fecha",
] as const
export type TemplateFieldType = (typeof TEMPLATE_FIELD_TYPES)[number]

/**
 * Lo que la tienda ajustó de la plantilla de un rubro (decisión 1). La plantilla fija vive en el
 * código (`apps/api/src/rubros.ts`); sin filas, la tienda usa esa. Con filas, la plantilla de la
 * tienda es esta lista, en su orden: un dato fijo guarda solo si Sofi lo necesita, su lugar y si se
 * quitó (`hidden`), y su nombre, tipo y valores siguen saliendo del código; uno propio de la tienda
 * guarda también su nombre, su tipo y sus valores.
 */
export const storeTemplateField = pgTable(
  "store_template_field",
  {
    storeId: uuid("store_id").notNull(),
    rubro: text("rubro").$type<ProductRubro>().notNull(),
    key: text("key").notNull(),
    position: smallint("position").notNull(),
    needed: boolean("needed").notNull(),
    hidden: boolean("hidden").notNull().default(false),
    /** Solo en un dato propio de la tienda. */
    label: text("label"),
    type: text("type").$type<TemplateFieldType>(),
    options: text("options").array(),
    columns: text("columns").array(),
    unit: text("unit"),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "store_template_field_pkey",
      columns: [table.storeId, table.rubro, table.key],
    }),
    check("store_template_field_rubro_check", inList("rubro", PRODUCT_RUBROS)),
    check("store_template_field_key_check", sql`${table.key} ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check(
      "store_template_field_own_check",
      sql`(${table.label} is null) = (${table.type} is null) and (${table.type} is null or ${inList("type", TEMPLATE_FIELD_TYPES)}) and (${table.label} is null or char_length(btrim(${table.label})) between 1 and 60) and (${table.label} is not null or (${table.options} is null and ${table.columns} is null and ${table.unit} is null))`,
    ),
    check(
      "store_template_field_values_check",
      sql`(${table.options} is null or cardinality(${table.options}) between 1 and 20) and (${table.columns} is null or cardinality(${table.columns}) between 1 and 6) and (${table.unit} is null or char_length(btrim(${table.unit})) between 1 and 12)`,
    ),
    foreignKey({
      name: "store_template_field_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
  ],
)

/**
 * Lo que Sofi no supo de un producto (decisión 11): la pregunta de la clienta y su conversación, y
 * la respuesta de la tienda. Sofi solo la anota (`0035_reglas_la_ficha_del_producto.sql`). Ventas
 * responde y puede pedir que se guarde en la ficha (`save_requested`); el Dueño o el Administrador
 * la guardan (`saved_at`), y desde ahí Sofi la usa. Una persona también anota en la ficha una
 * pregunta ya respondida, sin conversación.
 */
export const productQuestion = pgTable(
  "product_question",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    productId: uuid("product_id").notNull(),
    conversationId: uuid("conversation_id"),
    question: text("question").notNull(),
    askedBy: text("asked_by").notNull(),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    answer: text("answer"),
    answeredBy: text("answered_by"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /** Ventas respondió y propone guardarla en la ficha: espera a quien cambia el catálogo. */
    saveRequested: boolean("save_requested").notNull().default(false),
    savedBy: text("saved_by"),
    savedAt: timestamp("saved_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "product_question_texts_check",
      sql`char_length(btrim(${table.question})) between 3 and 500 and (${table.answer} is null or char_length(btrim(${table.answer})) between 1 and 1000)`,
    ),
    check(
      "product_question_answer_check",
      sql`(${table.answer} is null) = (${table.answeredBy} is null) and (${table.answer} is null) = (${table.answeredAt} is null) and (${table.savedAt} is null) = (${table.savedBy} is null) and (${table.savedAt} is null or ${table.answer} is not null) and (not ${table.saveRequested} or (${table.answer} is not null and ${table.savedAt} is null))`,
    ),
    foreignKey({
      name: "product_question_product_fkey",
      columns: [table.storeId, table.productId],
      foreignColumns: [product.storeId, product.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "product_question_conversation_fkey",
      columns: [table.storeId, table.conversationId],
      foreignColumns: [conversation.storeId, conversation.id],
    }),
    index("product_question_product_idx").on(table.productId, table.askedAt),
    index("product_question_open_idx")
      .on(table.storeId, table.askedAt)
      .where(sql`answer is null or save_requested`),
  ],
)

/** Lo que se anota de cada cambio de la ficha. */
export const PRODUCT_EVENT_ACTIONS = [
  "creado",
  "cambiado",
  "cuadricula",
  "foto",
  "pregunta",
] as const
export type ProductEventAction = (typeof PRODUCT_EVENT_ACTIONS)[number]

/** Un cambio de un campo: cómo estaba y cómo quedó (lo que usa «Deshacer»). */
export interface ProductChange {
  field: string
  from: unknown
  to: unknown
}

/**
 * El historial de la ficha: cada cambio con quién y cuándo, campo por campo, para «Quién cambió
 * qué» y para deshacer (que es otro cambio, con los valores de antes). Solo se agrega.
 */
export const productEvent = pgTable(
  "product_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    productId: uuid("product_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").$type<ProductEventAction>().notNull(),
    changes: jsonb("changes").$type<ProductChange[]>().notNull().default([]),
    /** El motivo que escribió, si bajó stock. */
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("product_event_action_check", inList("action", PRODUCT_EVENT_ACTIONS)),
    check(
      "product_event_changes_check",
      sql`jsonb_typeof(${table.changes}) = 'array' and (${table.reason} is null or char_length(${table.reason}) <= 300)`,
    ),
    foreignKey({
      name: "product_event_product_fkey",
      columns: [table.storeId, table.productId],
      foreignColumns: [product.storeId, product.id],
    }).onDelete("cascade"),
    index("product_event_product_idx").on(table.productId, table.createdAt),
  ],
)

/*
 * Despachos (entrega 3 del lienzo «gestorIA como odentIA», tableros 6, 17, 23 y 24): qué sale,
 * cuándo y quién lo lleva, y el efectivo que cobró cada repartidor hasta que la tienda lo recibe.
 */

/**
 * Quien lleva los pedidos de la tienda: una persona del equipo (`user_id`) o un nombre externo
 * sencillo («Kevin»). Es de la tienda y no se borra: lo que llevó y lo que cobró siguen con su
 * nombre. Cuando llegue gestorIA Reparto, el repartidor externo que acepte su invitación queda
 * enlazado a su cuenta en este mismo `user_id`, sin cambiar sus pedidos ni su efectivo (ADR 0228).
 */
export const storeCourier = pgTable(
  "store_courier",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    /** Como lo ve la tienda; con `user_id`, el de su cuenta al elegirlo. */
    name: text("name").notNull(),
    /** Su cuenta: la de una persona del equipo y, más adelante, la del repartidor que se unió. */
    userId: text("user_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("store_courier_name_check", sql`char_length(btrim(${table.name})) between 1 and 80`),
    foreignKey({
      name: "store_courier_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "store_courier_user_fkey",
      columns: [table.userId],
      foreignColumns: [accountCopy.userId],
    }),
    unique("store_courier_store_id_key").on(table.storeId, table.id),
    // Una cuenta es un solo repartidor en cada tienda; un nombre externo, también.
    uniqueIndex("store_courier_user_uidx")
      .on(table.storeId, table.userId)
      .where(sql`user_id is not null`),
    uniqueIndex("store_courier_name_uidx")
      .on(table.storeId, sql`lower(btrim(${table.name}))`)
      .where(sql`user_id is null`),
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
    conversationId: uuid("conversation_id"),
    /**
     * La ficha de la clienta (entrega 4, tablero 8). Nula en los pedidos de antes de Clientes, que
     * no se unen solos por el teléfono, y en los de «Probar a Sofi». El nombre y el teléfono de
     * abajo son la copia de lo que se acordó: corregir la ficha no los cambia.
     */
    customerId: uuid("customer_id"),
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
    /**
     * La franja del día en que sale (Despachos), copiada de las de la tienda: de `slot_start` a
     * `slot_end`, en minutos desde las 00:00 de la tienda. Nulas: «Sin franja», sale igual.
     */
    slotStart: smallint("slot_start"),
    slotEnd: smallint("slot_end"),
    /** Quién lo lleva; nulo mientras nadie lo tiene asignado o si se recoge en la tienda. */
    courierId: uuid("courier_id"),
    /** Por agencia (tablero 17): con cuál va («Shalom», «Olva», «Marvisur» u otra escrita). */
    agency: text("agency"),
    /**
     * Un cambio o una devolución después de entregar (tablero 17, decisión 7): el pedido entregado
     * del que sale. Ese pedido no se toca; este lleva lo que se lleva (sus líneas), lo que vuelve
     * (`sale_order_return`), su entrega y su cobro.
     */
    exchangeOfId: uuid("exchange_of_id"),
    /**
     * Lo que vale lo que vuelve, a lo que se pagó: se descuenta del total. Un total bajo cero es lo
     * que la tienda devuelve (el saldo lo dice como «sobra» hasta que se anota la devolución).
     */
    returnCreditCents: integer("return_credit_cents").notNull().default(0),
    /** El número de envío de la agencia, si lo hay: se puede anotar después de salir. */
    tracking: text("tracking"),
    /** El link de pago vigente: su dirección, su referencia en el proveedor y cuándo vence. */
    linkUrl: text("link_url"),
    linkRef: text("link_ref"),
    linkExpiresAt: timestamp("link_expires_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    /**
     * Salió de «Probar a Sofi» (B5): es un pedido de verdad para ver el recorrido, pero no mueve
     * el stock, no crea un link de pago real y no cuenta en Reportes ni en Argos.
     */
    test: boolean("test").notNull().default(false),
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
    check("sale_order_payment_collection_check", inList("payment_collection", PAYMENT_COLLECTIONS)),
    check(
      "sale_order_amounts_check",
      sql`${table.deliveryCents} between 0 and ${table.deliveryListCents} and ${table.subtotalCents} >= 0 and ${table.discountCents} >= 0 and ${table.giftCents} >= 0 and ${table.totalCents} = ${table.subtotalCents} + ${table.deliveryCents} - ${table.returnCreditCents} and ${table.marginUsedCents} between 0 and ${table.marginCents}`,
    ),
    // Solo un cambio descuenta lo que vuelve, y nunca sale de sí mismo.
    check(
      "sale_order_exchange_check",
      sql`${table.returnCreditCents} >= 0 and (${table.exchangeOfId} is not null or ${table.returnCreditCents} = 0) and (${table.exchangeOfId} is null or ${table.exchangeOfId} <> ${table.id})`,
    ),
    check(
      "sale_order_cancel_check",
      sql`(${table.state} = 'anulado') = (${table.cancelReason} is not null) and (${table.cancelReason} is null or char_length(btrim(${table.cancelReason})) between 3 and 300)`,
    ),
    check(
      "sale_order_tracking_check",
      sql`${table.tracking} is null or char_length(${table.tracking}) between 1 and 80`,
    ),
    check(
      "sale_order_slot_check",
      sql`(${table.slotStart} is null) = (${table.slotEnd} is null) and (${table.slotStart} is null or (${table.slotStart} >= 0 and ${table.slotStart} < ${table.slotEnd} and ${table.slotEnd} <= 1440))`,
    ),
    check(
      "sale_order_agency_check",
      sql`${table.agency} is null or char_length(btrim(${table.agency})) between 1 and 60`,
    ),
    // El repartidor, de la misma tienda.
    foreignKey({
      name: "sale_order_courier_fkey",
      columns: [table.storeId, table.courierId],
      foreignColumns: [storeCourier.storeId, storeCourier.id],
    }),
    index("sale_order_deliver_on_idx").on(table.storeId, table.deliverOn),
    foreignKey({
      name: "sale_order_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    unique("sale_order_store_id_key").on(table.storeId, table.id),
    unique("sale_order_number_key").on(table.storeId, table.number),
    // La conversación de la que salió, de la misma tienda (B5).
    foreignKey({
      name: "sale_order_conversation_fkey",
      columns: [table.storeId, table.conversationId],
      foreignColumns: [conversation.storeId, conversation.id],
    }),
    index("sale_order_conversation_idx").on(table.conversationId),
    index("sale_order_state_idx").on(table.storeId, table.state, table.createdAt),
    // La ficha de la misma tienda (entrega 4).
    foreignKey({
      name: "sale_order_customer_fkey",
      columns: [table.storeId, table.customerId],
      foreignColumns: [customer.storeId, customer.id],
    }),
    index("sale_order_customer_idx").on(table.customerId, table.createdAt),
    // El pedido entregado del que sale un cambio, de la misma tienda (tablero 17).
    foreignKey({
      name: "sale_order_exchange_fkey",
      columns: [table.storeId, table.exchangeOfId],
      foreignColumns: [table.storeId, table.id],
    }),
    index("sale_order_exchange_idx").on(table.exchangeOfId),
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

/**
 * Lo que vuelve en un cambio o una devolución (tablero 17): una variante del pedido entregado, con
 * cuánto vuelve, a cuánto se pagó cada una (lo que se descuenta) y por qué. Entra al stock como
 * «devolución» cuando llega a la tienda: al marcar «Entregado» el cambio (`returned_at`).
 */
export const saleOrderReturn = pgTable(
  "sale_order_return",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    /** El pedido del cambio (el nuevo), no el entregado. */
    orderId: uuid("order_id").notNull(),
    position: smallint("position").notNull(),
    productId: uuid("product_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    productName: text("product_name").notNull(),
    variantName: text("variant_name").notNull(),
    sku: text("sku").notNull(),
    quantity: integer("quantity").notNull(),
    /** Lo que pagó por cada una en el pedido entregado (0 si fue de regalo). */
    unitCents: integer("unit_cents").notNull(),
    /** Por qué vuelve: «Le quedó chica», «Llegó fallado» u otro motivo escrito. */
    reason: text("reason").notNull(),
    /** Cuándo volvió a la tienda; nulo mientras no llega. */
    returnedAt: timestamp("returned_at", { withTimezone: true }),
  },
  (table) => [
    check("sale_order_return_quantity_check", sql`${table.quantity} between 1 and 1000`),
    check("sale_order_return_price_check", sql`${table.unitCents} >= 0`),
    check(
      "sale_order_return_reason_check",
      sql`char_length(btrim(${table.reason})) between 3 and 120`,
    ),
    foreignKey({
      name: "sale_order_return_order_fkey",
      columns: [table.storeId, table.orderId],
      foreignColumns: [saleOrder.storeId, saleOrder.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "sale_order_return_variant_fkey",
      columns: [table.storeId, table.variantId],
      foreignColumns: [productVariant.storeId, productVariant.id],
    }),
    // Cada variante vuelve en una sola línea del cambio (como en el pedido).
    uniqueIndex("sale_order_return_variant_uidx").on(table.orderId, table.variantId),
    index("sale_order_return_variant_idx").on(table.variantId),
  ],
)

/** Cómo va un pago anotado: espera a una persona, confirmado o no coincide. */
export const ORDER_PAYMENT_STATES = ["por_confirmar", "confirmado", "no_coincide"] as const
export type OrderPaymentState = (typeof ORDER_PAYMENT_STATES)[number]

/**
 * Un pago de un pedido: por el link (lo confirma el proveedor), una captura o al recibir. Un
 * pedido acepta varios (el pago en partes, ADR 0222): cada uno con su medio y su estado.
 */
export const orderPayment = pgTable(
  "order_payment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    orderId: uuid("order_id").notNull(),
    kind: text("kind").$type<PaymentCollection>().notNull(),
    status: text("status").$type<OrderPaymentState>().notNull(),
    amountCents: integer("amount_cents").notNull(),
    /**
     * Con qué pagó: el medio de pago de la tienda, copiado al anotarlo como se copia en el pedido
     * («Yape», «Efectivo al recibir»), y su tipo de UN/CEFACT 4461 («1», otro, si ya no se sabe).
     */
    methodName: text("method_name").notNull(),
    methodType: text("method_type").$type<PaymentTypeCode>().notNull(),
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
    /**
     * Lo cobrado en la puerta queda a nombre de quien llevó el pedido, no de quien tocó el botón
     * (tablero 6): su efectivo es el que entrega en Caja. Nulo si no lo llevaba nadie (un recojo).
     */
    courierId: uuid("courier_id"),
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
      "order_payment_method_check",
      sql`char_length(btrim(${table.methodName})) between 1 and 80 and ${inList("method_type", PAYMENT_TYPE_CODES)}`,
    ),
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
    foreignKey({
      name: "order_payment_courier_fkey",
      columns: [table.storeId, table.courierId],
      foreignColumns: [storeCourier.storeId, storeCourier.id],
    }),
    uniqueIndex("order_payment_provider_uidx")
      .on(table.storeId, table.provider, table.providerRef)
      .where(sql`provider_ref is not null`),
    index("order_payment_order_idx").on(table.orderId, table.createdAt),
  ],
)

/**
 * El dinero que la tienda devolvió (tablero 17): lo que sobra de un pedido (un cambio que cuesta
 * menos, una devolución o un pago doble), con su medio, quién lo devolvió y cuándo. gestorIA no
 * mueve el dinero: anota lo que la persona devolvió desde su app. Solo se agrega.
 */
export const orderRefund = pgTable(
  "order_refund",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    orderId: uuid("order_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    /** Con qué lo devolvió: el medio de pago de la tienda, copiado («Plin»), y su tipo de UN/CEFACT 4461. */
    methodName: text("method_name").notNull(),
    methodType: text("method_type").$type<PaymentTypeCode>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("order_refund_amount_check", sql`${table.amountCents} > 0`),
    check(
      "order_refund_method_check",
      sql`char_length(btrim(${table.methodName})) between 1 and 80 and ${inList("method_type", PAYMENT_TYPE_CODES)}`,
    ),
    foreignKey({
      name: "order_refund_order_fkey",
      columns: [table.storeId, table.orderId],
      foreignColumns: [saleOrder.storeId, saleOrder.id],
    }).onDelete("cascade"),
    index("order_refund_order_idx").on(table.orderId, table.createdAt),
    index("order_refund_store_idx").on(table.storeId, table.createdAt),
  ],
)

/**
 * «Recibí» en Caja (tableros 6 y 23): una persona de la tienda recibe el efectivo que cobró un
 * repartidor (o el que se cobró en la tienda, sin repartidor). Queda lo que debía entregar, lo
 * que recibió y, si no cuadra, por qué. Solo se agrega: no se corrige ni se borra.
 */
export const cashHandover = pgTable(
  "cash_handover",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    /** De quién lo recibe; nulo: lo cobrado en la tienda, sin repartidor. */
    courierId: uuid("courier_id"),
    /** La suma de lo que cobró en efectivo: los pagos de `cash_handover_payment`. */
    expectedCents: integer("expected_cents").notNull(),
    receivedCents: integer("received_cents").notNull(),
    /** Por qué no cuadra; obligatorio si lo recibido no es lo esperado. */
    note: text("note"),
    receivedBy: text("received_by").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "cash_handover_amounts_check",
      sql`${table.expectedCents} > 0 and ${table.receivedCents} >= 0`,
    ),
    check(
      "cash_handover_note_check",
      sql`(${table.note} is null or char_length(btrim(${table.note})) between 3 and 300) and (${table.receivedCents} = ${table.expectedCents} or ${table.note} is not null)`,
    ),
    foreignKey({
      name: "cash_handover_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "cash_handover_courier_fkey",
      columns: [table.storeId, table.courierId],
      foreignColumns: [storeCourier.storeId, storeCourier.id],
    }),
    unique("cash_handover_store_id_key").on(table.storeId, table.id),
    index("cash_handover_store_idx").on(table.storeId, table.receivedAt),
  ],
)

/** Qué pagos en efectivo entraron en cada «Recibí»: cada uno, una sola vez. */
export const cashHandoverPayment = pgTable(
  "cash_handover_payment",
  {
    storeId: uuid("store_id").notNull(),
    handoverId: uuid("handover_id").notNull(),
    paymentId: uuid("payment_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.paymentId] }),
    foreignKey({
      name: "cash_handover_payment_handover_fkey",
      columns: [table.storeId, table.handoverId],
      foreignColumns: [cashHandover.storeId, cashHandover.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "cash_handover_payment_payment_fkey",
      columns: [table.storeId, table.paymentId],
      foreignColumns: [orderPayment.storeId, orderPayment.id],
    }).onDelete("cascade"),
    index("cash_handover_payment_handover_idx").on(table.handoverId),
  ],
)

/**
 * El saldo de cada pedido (ADR 0222), calculado en un solo lugar: esta vista, que leen el pedido,
 * las listas, Reportes, Argos y Sofi. Lo pagado es lo confirmado menos lo devuelto
 * (`order_refund`). Falta cobrar = total − pagado − por confirmar (nunca menos de 0, y 0 si se
 * anuló). «Pagado» es no deber nada con todo confirmado; lo pagado que pasa del total sobra: un
 * pago doble, o lo que la tienda devuelve de un cambio o una devolución (tablero 17). La vista
 * corre con los permisos de quien la lee (`security_invoker`): cada tienda ve solo lo suyo, con
 * las reglas de sus tablas. Se crea a mano en `0016_el_saldo_y_el_pago_en_partes.sql` y suma lo
 * devuelto en `0032_el_dinero_devuelto.sql`.
 */
export const orderBalance = pgView("order_balance", {
  orderId: uuid("order_id").notNull(),
  storeId: uuid("store_id").notNull(),
  totalCents: integer("total_cents").notNull(),
  confirmedCents: integer("confirmed_cents").notNull(),
  pendingCents: integer("pending_cents").notNull(),
  dueCents: integer("due_cents").notNull(),
  overCents: integer("over_cents").notNull(),
  paid: boolean("paid").notNull(),
  /** Lo que la tienda devolvió. */
  refundedCents: integer("refunded_cents").notNull(),
}).existing()

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
  // Corregir sin anular (entrega 2 del lienzo «gestorIA como odentIA»): cambiar el pedido, que
  // volvió sin entregar, pasarlo a otro día y deshacer la confirmación de un pago.
  "cambiado",
  "no_entregado",
  "reprogramado",
  "pago_deshecho",
  // Despachos (entrega 3): quién lo lleva, y con qué agencia y número de envío.
  "repartidor",
  "envio",
  // Cambios y devoluciones (entrega 8, tablero 17): en el pedido entregado, el cambio que salió de él;
  // y el dinero que la tienda devolvió de lo que sobra.
  "cambio",
  "dinero_devuelto",
] as const
export type OrderEventAction = (typeof ORDER_EVENT_ACTIONS)[number]

export const orderEvent = pgTable(
  "order_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    orderId: uuid("order_id").notNull(),
    /** El orden en que pasó: varias cosas en un mismo paso comparten la hora. */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
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
 * El modo de la pasarela (tablero 6): «prueba» cobra con dinero de prueba (las credenciales de
 * prueba del proveedor) y solo el link de S/ 1 de la tienda; «real» cobra los pedidos.
 */
export const PAYMENT_LINK_MODES = ["prueba", "real"] as const
export type PaymentLinkMode = (typeof PAYMENT_LINK_MODES)[number]

/**
 * La cuenta del proveedor del link de pago de la tienda, con sus credenciales cifradas
 * (`secretos.ts` de la API). Nunca vuelven al navegador: la pantalla solo sabe si está conectada,
 * en qué modo y con qué cuenta (su correo a medias).
 *
 * Se conecta entrando a la cuenta del proveedor (OAuth): el token dura lo que dice el proveedor
 * (`expires_at`; Mercado Pago, 180 días) y se renueva antes con el `refresh_token`. Si el
 * proveedor avisa que la tienda quitó el permiso (y se comprueba), queda `revoked_at`.
 */
export const storePaymentLink = pgTable(
  "store_payment_link",
  {
    storeId: uuid("store_id").primaryKey(),
    provider: text("provider").$type<PaymentLinkProvider>().notNull(),
    accessTokenEnc: text("access_token_enc").notNull(),
    webhookSecretEnc: text("webhook_secret_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    mode: text("mode").$type<PaymentLinkMode>().notNull().default("real"),
    /** La cuenta en el proveedor (su número), para reconocer el aviso de que se desvinculó. */
    providerUserId: text("provider_user_id"),
    /** Cómo se reconoce la cuenta sin mostrarla entera: «ro…@gmail.com». */
    accountLabel: text("account_label"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Los últimos caracteres del token, para reconocer la cuenta sin mostrarla. */
    hint: text("hint").notNull(),
    connectedBy: text("connected_by").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("store_payment_link_provider_check", inList("provider", PAYMENT_LINK_PROVIDERS)),
    check("store_payment_link_mode_check", inList("mode", PAYMENT_LINK_MODES)),
    check("store_payment_link_hint_check", sql`char_length(${table.hint}) between 1 and 8`),
    check(
      "store_payment_link_label_check",
      sql`char_length(${table.accountLabel}) between 1 and 120`,
    ),
    index("store_payment_link_user_idx").on(table.provider, table.providerUserId),
    foreignKey({
      name: "store_payment_link_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
  ],
)

/**
 * Un intento de conectar la pasarela entrando a la cuenta (OAuth): el `state` que viaja al
 * proveedor (aquí solo su resumen SHA-256), quién lo empezó, en qué modo y el `code_verifier` de
 * PKCE (RFC 7636). Vale 10 minutos, lo que vale el código del proveedor, y se usa una sola vez.
 */
export const storePaymentLinkAttempt = pgTable(
  "store_payment_link_attempt",
  {
    stateHash: text("state_hash").primaryKey(),
    storeId: uuid("store_id").notNull(),
    provider: text("provider").$type<PaymentLinkProvider>().notNull(),
    mode: text("mode").$type<PaymentLinkMode>().notNull(),
    verifier: text("verifier").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [
    check("store_payment_link_attempt_provider_check", inList("provider", PAYMENT_LINK_PROVIDERS)),
    check("store_payment_link_attempt_mode_check", inList("mode", PAYMENT_LINK_MODES)),
    check("store_payment_link_attempt_hash_check", sql`${table.stateHash} ~ '^[0-9a-f]{64}$'`),
    foreignKey({
      name: "store_payment_link_attempt_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    index("store_payment_link_attempt_store_idx").on(table.storeId, table.createdAt),
  ],
)

/**
 * El link de prueba de S/ 1 (tablero 6): se paga con la tarjeta de prueba del proveedor y, como un
 * pedido, se da por pagado solo cuando el proveedor avisa y se le pregunta. No es un pedido: no
 * mueve stock ni cuenta en Reportes.
 */
export const storePaymentLinkTrial = pgTable(
  "store_payment_link_trial",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    provider: text("provider").$type<PaymentLinkProvider>().notNull(),
    amountCents: integer("amount_cents").notNull(),
    url: text("url").notNull(),
    ref: text("ref").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Lo que el proveedor dijo al preguntarle: cuándo entró, cuánto y con qué pago. */
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidCents: integer("paid_cents"),
    paymentRef: text("payment_ref"),
  },
  (table) => [
    check("store_payment_link_trial_provider_check", inList("provider", PAYMENT_LINK_PROVIDERS)),
    check("store_payment_link_trial_amount_check", sql`${table.amountCents} > 0`),
    check("store_payment_link_trial_url_check", sql`${table.url} ~ '^https://'`),
    foreignKey({
      name: "store_payment_link_trial_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    index("store_payment_link_trial_store_idx").on(table.storeId, table.createdAt),
  ],
)

/*
 * Las clientas (entrega 4 de «gestorIA como odentIA», tablero 8): cada clienta es una ficha con
 * sus compras. La clienta es la persona: un pedido se suma a su ficha y nunca se abre otra a
 * sabiendas. Que dos fichas sean la misma lo decide una persona («¿Es la misma clienta?»), nunca
 * el teléfono ni el nombre: la base guarda lo que decidió y quién (ADR 0223).
 */

/**
 * Una clienta de la tienda: su nombre y su teléfono, como los anotó el equipo o los dio en el
 * chat, y «Lo que sabemos», una nota del equipo que la clienta no ve.
 *
 * Cuando una persona dice que dos fichas son la misma, la más nueva queda dentro de la más
 * antigua (`merged_into`): nada se mueve ni se borra, y «Separar» la deja sola otra vez. Una
 * ficha solo queda dentro de otra que no está dentro de una tercera (lo cuida la regla de la
 * base), así la clienta se lee de un solo paso.
 */
export const customer = pgTable(
  "customer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    name: text("name").notNull(),
    /** Tal como se escribió («+51 987 654 321»). */
    phone: text("phone"),
    /** Solo sus dígitos: para buscarla y para sugerir «¿Es la misma clienta?»; nunca une solo. */
    phoneDigits: text("phone_digits").generatedAlwaysAs(
      sql`nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '')`,
    ),
    /** «Lo que sabemos»: la nota del equipo, con quién la escribió y cuándo. */
    note: text("note").notNull().default(""),
    noteBy: text("note_by"),
    noteAt: timestamp("note_at", { withTimezone: true }),
    /** La ficha dentro de la que quedó porque una persona dijo que es la misma clienta. */
    mergedInto: uuid("merged_into"),
    /** Quién la abrió: una persona al anotar un pedido, o Sofi al armarlo en el chat. */
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "customer_texts_check",
      sql`char_length(btrim(${table.name})) between 1 and 120 and (${table.phone} is null or char_length(${table.phone}) between 1 and 30) and char_length(${table.note}) <= 1000`,
    ),
    check("customer_note_check", sql`(${table.noteAt} is null) = (${table.noteBy} is null)`),
    check(
      "customer_merged_check",
      sql`${table.mergedInto} is null or ${table.mergedInto} <> ${table.id}`,
    ),
    foreignKey({
      name: "customer_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    unique("customer_store_id_key").on(table.storeId, table.id),
    foreignKey({
      name: "customer_merged_into_fkey",
      columns: [table.storeId, table.mergedInto],
      foreignColumns: [table.storeId, table.id],
    }),
    index("customer_merged_idx").on(table.storeId, table.mergedInto),
    index("customer_phone_idx").on(table.storeId, table.phoneDigits),
    index("customer_name_idx").on(table.storeId, sql`lower(${table.name})`),
  ],
)

/**
 * Lo que una persona decidió sobre dos fichas (tablero 8): que son la misma («unida»: la otra
 * quedó dentro de esta), que ya no («separada») o que son dos clientas («distintas»). Con esto la
 * ficha cuenta su historia y «¿Es la misma clienta?» no vuelve a preguntar lo ya contestado.
 */
export const CUSTOMER_EVENT_ACTIONS = ["unida", "separada", "distintas"] as const
export type CustomerEventAction = (typeof CUSTOMER_EVENT_ACTIONS)[number]

export const customerEvent = pgTable(
  "customer_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    /** La ficha que queda (unida), de la que salió la otra (separada) o una de las dos (distintas). */
    customerId: uuid("customer_id").notNull(),
    otherId: uuid("other_id").notNull(),
    action: text("action").$type<CustomerEventAction>().notNull(),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("customer_event_action_check", inList("action", CUSTOMER_EVENT_ACTIONS)),
    check("customer_event_pair_check", sql`${table.customerId} <> ${table.otherId}`),
    foreignKey({
      name: "customer_event_customer_fkey",
      columns: [table.storeId, table.customerId],
      foreignColumns: [customer.storeId, customer.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "customer_event_other_fkey",
      columns: [table.storeId, table.otherId],
      foreignColumns: [customer.storeId, customer.id],
    }).onDelete("cascade"),
    index("customer_event_customer_idx").on(table.storeId, table.customerId, table.createdAt),
    index("customer_event_other_idx").on(table.storeId, table.otherId),
  ],
)

/*
 * Sofi, la vendedora, y Argos, el administrador (paso B5 del lienzo B, tableros 8, 13 y 14).
 * El núcleo conoce conversaciones y mensajes; el canal (WhatsApp en B2, Instagram y Messenger en
 * B6) es un adaptador que solo los trae y los lleva. Mientras no hay canal, el equipo prueba a
 * Sofi con una conversación de prueba («Probar a Sofi») y lo que Argos le encarga queda escrito
 * sin enviarse.
 *
 * Sofi y Argos entran a la base como el rol de la aplicación con un remitente propio
 * (`agente:sofi`, `agente:argos`): las mismas reglas de cada tienda, y además la base les niega
 * lo que nunca hacen (confirmar un pago, mover stock, tocar la configuración), en la migración
 * de reglas de B5.
 */

/** Lo que el dueño deja escrito para Sofi (tablero 8, «Lo que pone el dueño»). */
export const storeAgent = pgTable(
  "store_agent",
  {
    storeId: uuid("store_id").primaryKey(),
    /** Apagada, todas las conversaciones esperan a una persona. */
    enabled: boolean("enabled").notNull().default(false),
    /** El nombre con que saluda; nulo: «Sofi, de <tienda>». */
    displayName: text("display_name"),
    /** «Lo que debe saber»: horario, cambios de talla, cuidados. Lo cuenta tal cual. */
    knowledge: text("knowledge").notNull().default(""),
    /** Los seguimientos que Argos le encarga (decisión 5); cada uno se apaga aparte. */
    followPayment: boolean("follow_payment").notNull().default(true),
    followThanks: boolean("follow_thanks").notNull().default(true),
    followRestock: boolean("follow_restock").notNull().default(true),
    followReturn: boolean("follow_return").notNull().default(true),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "store_agent_texts_check",
      sql`(${table.displayName} is null or char_length(btrim(${table.displayName})) between 1 and 60) and char_length(${table.knowledge}) <= 2000`,
    ),
    foreignKey({
      name: "store_agent_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
  ],
)

/** Por dónde llega una conversación. «prueba»: la del equipo en «Probar a Sofi». */
export const CONVERSATION_CHANNELS = ["whatsapp", "instagram", "messenger", "prueba"] as const
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number]

/** Quién atiende: Sofi, o una persona que la tomó («Atender yo») o a quien Sofi se la pasó. */
export const CONVERSATION_HANDLERS = ["sofi", "persona"] as const
export type ConversationHandler = (typeof CONVERSATION_HANDLERS)[number]

export const conversation = pgTable(
  "conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    channel: text("channel").$type<ConversationChannel>().notNull(),
    /** El nombre que dio el cliente (o el del canal). */
    customerName: text("customer_name"),
    handler: text("handler").$type<ConversationHandler>().notNull().default("sofi"),
    /** Por qué espera a una persona («El cliente lo pidió», «Un reclamo»); nulo si no espera. */
    waitingReason: text("waiting_reason"),
    /** El último mensaje del cliente: pasadas 24 horas, solo sale una plantilla aprobada. */
    lastCustomerAt: timestamp("last_customer_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("conversation_channel_check", inList("channel", CONVERSATION_CHANNELS)),
    check("conversation_handler_check", inList("handler", CONVERSATION_HANDLERS)),
    check(
      "conversation_texts_check",
      sql`(${table.customerName} is null or char_length(btrim(${table.customerName})) between 1 and 120) and (${table.waitingReason} is null or char_length(btrim(${table.waitingReason})) between 3 and 200)`,
    ),
    foreignKey({
      name: "conversation_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    unique("conversation_store_id_key").on(table.storeId, table.id),
    index("conversation_store_idx").on(table.storeId, table.updatedAt),
  ],
)

/** Quién escribió: el cliente, Sofi o una persona del equipo. */
export const MESSAGE_AUTHORS = ["cliente", "sofi", "persona"] as const
export type MessageAuthor = (typeof MESSAGE_AUTHORS)[number]

/**
 * Cómo salió un mensaje al cliente: «prueba» (la conversación de prueba: no hay a quién
 * enviarlo) o «sin_enviar» (no hay canal todavía; B2 lo enviará). Nulo en lo que escribe el
 * cliente. Ninguna pantalla dice que se envió.
 */
export const MESSAGE_DELIVERIES = ["prueba", "sin_enviar"] as const
export type MessageDelivery = (typeof MESSAGE_DELIVERIES)[number]

/** Los seguimientos que Argos le encarga a Sofi (decisión 5 y tablero 13). */
export const FOLLOW_UPS = ["pago", "gracias", "volvio", "volver"] as const
export type FollowUp = (typeof FOLLOW_UPS)[number]

export const conversationMessage = pgTable(
  "conversation_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    author: text("author").$type<MessageAuthor>().notNull(),
    text: text("text").notNull(),
    delivery: text("delivery").$type<MessageDelivery>(),
    /** Pasadas 24 horas del último mensaje del cliente: sale solo con plantilla aprobada (B2). */
    needsTemplate: boolean("needs_template").notNull().default(false),
    /** Un seguimiento de Argos y sobre qué (el pedido o la variante): cada uno sale una vez. */
    followUp: text("follow_up").$type<FollowUp>(),
    followUpRef: text("follow_up_ref"),
    /**
     * Lo que hizo Sofi para responder: las herramientas que usó, lo que la comprobación frenó,
     * el modelo, los tokens y el costo (en millonésimas de USD).
     */
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    /** Quién lo escribió: la persona del equipo (también al probar como cliente) o el agente. */
    actorUserId: text("actor_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("conversation_message_author_check", inList("author", MESSAGE_AUTHORS)),
    check(
      "conversation_message_text_check",
      sql`char_length(btrim(${table.text})) between 1 and 4000`,
    ),
    check(
      "conversation_message_delivery_check",
      sql`(${table.delivery} is null or ${inList("delivery", MESSAGE_DELIVERIES)}) and ((${table.author} = 'cliente') = (${table.delivery} is null))`,
    ),
    check(
      "conversation_message_follow_check",
      sql`(${table.followUp} is null) = (${table.followUpRef} is null) and (${table.followUp} is null or (${inList("follow_up", FOLLOW_UPS)} and ${table.author} = 'sofi'))`,
    ),
    foreignKey({
      name: "conversation_message_conversation_fkey",
      columns: [table.storeId, table.conversationId],
      foreignColumns: [conversation.storeId, conversation.id],
    }).onDelete("cascade"),
    index("conversation_message_conversation_idx").on(table.conversationId, table.seq),
    // Un seguimiento sale una sola vez por motivo y por pedido (o variante): Argos puede correr
    // dos veces sin duplicarlo.
    uniqueIndex("conversation_message_follow_uidx")
      .on(table.storeId, table.conversationId, table.followUp, table.followUpRef)
      .where(sql`follow_up is not null`),
  ],
)

/**
 * Alguien pidió una variante agotada y Sofi quedó en avisarle (tablero 8: «avisar que volvió una
 * talla»). Argos lo cuenta en «Te toca: reponer» y, cuando entra stock, Sofi avisa sola.
 */
export const stockRequest = pgTable(
  "stock_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Cuándo Sofi le avisó que volvió; nulo mientras espera. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "stock_request_variant_fkey",
      columns: [table.storeId, table.variantId],
      foreignColumns: [productVariant.storeId, productVariant.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "stock_request_conversation_fkey",
      columns: [table.storeId, table.conversationId],
      foreignColumns: [conversation.storeId, conversation.id],
    }).onDelete("cascade"),
    uniqueIndex("stock_request_open_uidx")
      .on(table.variantId, table.conversationId)
      .where(sql`notified_at is null`),
    index("stock_request_store_idx").on(table.storeId, table.variantId),
  ],
)

/*
 * El perfil de la clienta (lienzo «Clientas bien perfiladas y Argos que hace el marketing solo»,
 * decisiones 1 a 3). Argos anota solo lo que sabe de cada clienta, de sus chats, sus pedidos y cómo
 * responde, y cada dato dice de dónde salió y cuándo. Lo que corrige la tienda queda «Lo puso la
 * tienda» y Argos no lo vuelve a pisar: la base se lo niega. Nada se edita ni se borra: el
 * historial de un dato son sus filas, y el valor de hoy es la última (o la última de la tienda).
 */

/**
 * Lo que se sabe de ella. «medida» es la talla o el tono, según cómo llame la tienda a la primera
 * opción de su catálogo (Talla, Tono, Medida): no hay columnas por rubro. «cumpleanos» es día y
 * mes en ISO 8601 sin año (`--MM-DD`): el año no se pide.
 */
export const CUSTOMER_FACT_KEYS = [
  "medida",
  "distrito",
  "cumpleanos",
  "canal",
  "instagram",
  "gustos",
] as const
export type CustomerFactKey = (typeof CUSTOMER_FACT_KEYS)[number]

/** De dónde salió: lo que dijo en un chat, sus pedidos, cómo responde o la tienda que lo corrigió. */
export const CUSTOMER_FACT_SOURCES = ["chat", "pedido", "respuesta", "tienda"] as const
export type CustomerFactSource = (typeof CUSTOMER_FACT_SOURCES)[number]

export const customerFact = pgTable(
  "customer_fact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    key: text("key").$type<CustomerFactKey>().notNull(),
    value: text("value").notNull(),
    source: text("source").$type<CustomerFactSource>().notNull(),
    /** El mensaje de ella de donde salió (chat): su cita está en `quote`, tal cual. */
    messageId: uuid("message_id"),
    /** El pedido de donde salió (pedido): la talla que lleva, la dirección de la entrega. */
    orderId: uuid("order_id"),
    /** Lo que dijo, tal cual (chat) o el texto del pedido de donde salió (la dirección). */
    quote: text("quote"),
    /**
     * Lo que Argos no tiene claro: usa `value` y estas son las otras posibilidades («Por
     * confirmar»). No frena nada; se resuelve cuando la tienda elige una o ella lo dice.
     */
    alternatives: text("alternatives").array().notNull().default(sql`'{}'::text[]`),
    /** Quien lo anotó: `agente:argos`, o la persona del equipo que lo corrigió. */
    actorUserId: text("actor_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("customer_fact_key_check", inList("key", CUSTOMER_FACT_KEYS)),
    check("customer_fact_source_check", inList("source", CUSTOMER_FACT_SOURCES)),
    check(
      "customer_fact_value_check",
      sql`char_length(btrim(${table.value})) between 1 and 120 and (${table.quote} is null or char_length(${table.quote}) between 1 and 300) and cardinality(${table.alternatives}) <= 4`,
    ),
    // Del chat, siempre con su mensaje y su cita; de un pedido, con su pedido.
    check(
      "customer_fact_origin_check",
      sql`(${table.source} <> 'chat' or (${table.messageId} is not null and ${table.quote} is not null)) and (${table.source} <> 'pedido' or ${table.orderId} is not null)`,
    ),
    check(
      "customer_fact_birthday_check",
      sql`${table.key} <> 'cumpleanos' or ${table.value} ~ '^--(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'`,
    ),
    foreignKey({
      name: "customer_fact_customer_fkey",
      columns: [table.storeId, table.customerId],
      foreignColumns: [customer.storeId, customer.id],
    }).onDelete("cascade"),
    index("customer_fact_customer_idx").on(
      table.storeId,
      table.customerId,
      table.key,
      table.createdAt,
    ),
  ],
)

/**
 * Si se le pueden escribir promociones (decisión del dueño: nunca a quien no aceptó o pidió la
 * baja). Solo se agrega; el estado vigente es la última fila. Cada fila sale de un mensaje de
 * ella, con su cita: Sofi pide el permiso en la primera compra («si» o «no») y anota la baja
 * cuando dice «ya no me mandes». Una baja solo la deshace otro mensaje de ella.
 */
export const CONSENT_STATES = ["si", "no", "baja"] as const
export type ConsentState = (typeof CONSENT_STATES)[number]

export const customerConsent = pgTable(
  "customer_consent",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    /** Nula si todavía no tiene ficha (escribió, pero no compró): vale para su conversación. */
    customerId: uuid("customer_id"),
    conversationId: uuid("conversation_id").notNull(),
    /** Por dónde se le pueden escribir promociones: WhatsApp (Meta no deja escribir primero por otro). */
    channel: text("channel").$type<ConversationChannel>().notNull(),
    state: text("state").$type<ConsentState>().notNull(),
    /** El mensaje de ella y lo que dijo, tal cual. */
    messageId: uuid("message_id").notNull(),
    quote: text("quote").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("customer_consent_state_check", inList("state", CONSENT_STATES)),
    check("customer_consent_channel_check", inList("channel", CONVERSATION_CHANNELS)),
    check("customer_consent_quote_check", sql`char_length(btrim(${table.quote})) between 1 and 300`),
    foreignKey({
      name: "customer_consent_customer_fkey",
      columns: [table.storeId, table.customerId],
      foreignColumns: [customer.storeId, customer.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "customer_consent_conversation_fkey",
      columns: [table.storeId, table.conversationId],
      foreignColumns: [conversation.storeId, conversation.id],
    }).onDelete("cascade"),
    index("customer_consent_customer_idx").on(table.storeId, table.customerId, table.createdAt),
    index("customer_consent_conversation_idx").on(
      table.storeId,
      table.conversationId,
      table.createdAt,
    ),
  ],
)

/**
 * Hasta dónde leyó Argos cada conversación para anotar lo que dijo la clienta: así no vuelve a
 * leer (ni a pagar) lo mismo. Lo escribe solo Argos.
 */
export const argosReading = pgTable(
  "argos_reading",
  {
    storeId: uuid("store_id").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    /** El último mensaje leído (`conversation_message.seq`). */
    seq: bigint("seq", { mode: "number" }).notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.conversationId] }),
    foreignKey({
      name: "argos_reading_conversation_fkey",
      columns: [table.storeId, table.conversationId],
      foreignColumns: [conversation.storeId, conversation.id],
    }).onDelete("cascade"),
  ],
)

/*
 * El acuerdo con la administración (paso B7 del lienzo B; ADR 0211 y 0212): gestorIA le avisa
 * lo que pasó y le pregunta el estado de cada tienda, firmando con su secreto.
 */

/** Lo que gestorIA le avisa a la administración (los `type` de `@odentia/contract`). */
export const CONTRACT_EVENT_TYPES = [
  "cuenta.abierta",
  "uso.contado",
  "soporte.pedido",
  "pago.comprobante",
  "equipo.cambiado",
] as const
export type ContractEventType = (typeof CONTRACT_EVENT_TYPES)[number]

/**
 * La bandeja de salida: cada aviso se guarda en la misma transacción que lo que lo causó (la
 * tienda creada, la respuesta de Sofi, el pedido) y un trabajo lo envía. Su `id` es su clave
 * (`webhook-id`) y no cambia al reintentar: la administración reconoce un repetido y nunca lo
 * cuenta dos veces. Nada se borra al fallar: se reintenta más tarde con la misma clave.
 */
export const contractOutbox = pgTable(
  "contract_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    type: text("type").$type<ContractEventType>().notNull(),
    /** El aviso tal cual se envía (su cuerpo firmado), con la hora en que pasó. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** Lo que no se avisa dos veces en la tienda (una conversación en su ventana y su resultado). */
    dedupe: text("dedupe"),
    /** La conversación de un aviso de uso: con ella se busca su ventana. */
    conversationId: uuid("conversation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    /**
     * La administración lo rechazó por lo que dice (un comprobante de un cargo ya pagado): no se
     * reintenta, porque repetirlo no lo arregla, y `last_error` dice por qué. Solo un comprobante.
     */
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  },
  (table) => [
    check("contract_outbox_type_check", inList("type", CONTRACT_EVENT_TYPES)),
    check(
      "contract_outbox_rejected_check",
      sql`${table.rejectedAt} is null or (${table.sentAt} is null and ${table.type} = 'pago.comprobante')`,
    ),
    foreignKey({
      name: "contract_outbox_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    uniqueIndex("contract_outbox_dedupe_uidx").on(table.storeId, table.dedupe),
    index("contract_outbox_pending_idx")
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`sent_at is null and rejected_at is null`),
    // Lo enviado se borra tras un plazo (`purgeOutbox`).
    index("contract_outbox_sent_idx").on(table.sentAt).where(sql`sent_at is not null`),
    index("contract_outbox_store_idx").on(table.storeId, table.type, table.createdAt),
    index("contract_outbox_conversation_idx").on(table.conversationId, table.createdAt),
  ],
)

/**
 * Lo último que la administración dijo de cada tienda (`AccountState` de `@odentia/contract`):
 * si puede seguir, su plan, cargos, pagos, avisos y soporte. Si la administración no responde,
 * gestorIA sigue con esto; sin nada guardado, deja trabajar.
 */
export const contractState = pgTable(
  "contract_state",
  {
    storeId: uuid("store_id").primaryKey(),
    /** La última respuesta; nula si nunca respondió. */
    state: jsonb("state").$type<Record<string, unknown>>(),
    /** Cuándo llegó esa respuesta. */
    receivedAt: timestamp("received_at", { withTimezone: true }),
    /** La última vez que se preguntó, respondiera o no. */
    triedAt: timestamp("tried_at", { withTimezone: true }).notNull().defaultNow(),
    /** Por qué falló la última pregunta; nulo si respondió. */
    lastError: text("last_error"),
  },
  (table) => [
    foreignKey({
      name: "contract_state_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
  ],
)

/**
 * Los pedidos de la administración ya recibidos (ADR 0214), por su `webhook-id`: el efecto y esta
 * fila van en la misma transacción, así que un pedido repetido devuelve la misma respuesta sin
 * hacer nada otra vez. Sin clave foránea a la tienda: el de abrir una que no se pudo abrir no la
 * tiene. Solo el dueño de la base la escribe.
 */
export const contractRequestReceipt = pgTable("contract_request_receipt", {
  webhookId: text("webhook_id").primaryKey(),
  type: text("type").notNull(),
  storeId: uuid("store_id"),
  status: text("status").$type<"hecho" | "fallo">().notNull(),
  message: text("message"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Cómo va la entrada de soporte: la pidió la administración, la aceptó o la rechazó el Dueño o
 * un Administrador, o la quitaron. Aceptada vale hasta `expires_at`; después ya no entra.
 */
export const SUPPORT_ACCESS_STATES = ["pedido", "aceptado", "rechazado", "quitado"] as const
export type SupportAccessState = (typeof SUPPORT_ACCESS_STATES)[number]

/**
 * La entrada de soporte a una tienda (ADR 0214): la pide la administración por el acuerdo, a nombre
 * de una persona del equipo de gestorIA, por un rato y para algo. Entra solo si el Dueño o un
 * Administrador la acepta, solo a mirar (`permisos.ts`) y hasta que vence o la quitan. Su id en
 * la cuenta única es el de su token: entra con su propia cuenta. Lo que pasa queda en
 * `store_event`.
 */
export const storeSupportAccess = pgTable(
  "store_support_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id").notNull(),
    /** La persona de soporte, por su id en la cuenta única (sin clave: quizá aún no entró aquí). */
    staffUserId: text("staff_user_id").notNull(),
    staffName: text("staff_name").notNull(),
    minutes: smallint("minutes").notNull(),
    reason: text("reason").notNull(),
    state: text("state").$type<SupportAccessState>().notNull().default("pedido"),
    /** Hasta cuándo se puede aceptar el pedido. */
    requestExpiresAt: timestamp("request_expires_at", { withTimezone: true }).notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredBy: text("answered_by"),
    /** Aceptada: hasta cuándo entra. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** La primera vez que entró (queda también en `store_event`). */
    usedAt: timestamp("used_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: text("ended_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("store_support_access_state_check", inList("state", SUPPORT_ACCESS_STATES)),
    check("store_support_access_minutes_check", sql`${table.minutes} between 5 and 60`),
    check(
      "store_support_access_texts_check",
      sql`char_length(btrim(${table.reason})) between 3 and 500 and char_length(btrim(${table.staffName})) between 1 and 200`,
    ),
    check(
      "store_support_access_answer_check",
      sql`(${table.state} = 'pedido') = (${table.answeredAt} is null) and (${table.answeredAt} is null) = (${table.answeredBy} is null) and (${table.expiresAt} is not null) = (${table.state} in ('aceptado','quitado') and ${table.answeredAt} is not null) and (${table.state} = 'quitado') = (${table.endedAt} is not null)`,
    ),
    foreignKey({
      name: "store_support_access_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
    index("store_support_access_store_idx").on(table.storeId, table.createdAt),
    index("store_support_access_staff_idx").on(table.staffUserId, table.expiresAt),
  ],
)

/**
 * Los primeros pasos de una tienda nueva (lienzo «gestorIA como odentIA», tablero 16; ADR 0227):
 * «Tu tienda está casi lista», en Inicio. Cada paso se marca solo con lo que ya está guardado en
 * su apartado: aquí va solo lo que no se ve en otra tabla, los pasos que la tienda saltó porque no
 * le aplican («No lo necesito») y cuándo quedó lista, para que la lista no vuelva.
 */
export const SETUP_STEPS = [
  "datos",
  "catalogo",
  "pagos",
  "entregas",
  "chats",
  "sofi",
  "equipo",
] as const
export type SetupStep = (typeof SETUP_STEPS)[number]

export const storeSetup = pgTable(
  "store_setup",
  {
    storeId: uuid("store_id").primaryKey(),
    skipped: text("skipped").array().$type<SetupStep[]>().notNull().default(sql`'{}'::text[]`),
    /** Con todos los pasos hechos o saltados: desde entonces, la lista no vuelve. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Quién saltó el último paso; nulo si lo anotó el sistema (al quedar lista). */
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "store_setup_skipped_check",
      sql.raw(`skipped <@ ARRAY[${SETUP_STEPS.map((step) => `'${step}'`).join(",")}]::text[]`),
    ),
    foreignKey({
      name: "store_setup_store_id_fkey",
      columns: [table.storeId],
      foreignColumns: [store.id],
    }).onDelete("cascade"),
  ],
)

/**
 * Los avisos al celular (lienzo «gestorIA como odentIA», tablero 15): de qué avisa gestorIA con la
 * app cerrada. Cada uno lo recibe quien puede resolverlo (`permisos.ts` de la API) y abre la
 * pantalla que lo resuelve.
 *
 * - `pagos`: un pago por confirmar (una captura, o un link que no coincide).
 * - `chats`: un chat que Sofi pasó a una persona.
 * - `no_entregado`: una entrega que volvió sin entregarse.
 * - `sofi_pedido`: un pedido que armó Sofi.
 * - `dinero`: lo de dinero de toda la tienda (un pago por link que entró).
 */
export const PUSH_KINDS = ["pagos", "chats", "no_entregado", "sofi_pedido", "dinero"] as const
export type PushKind = (typeof PUSH_KINDS)[number]

/**
 * Un celular (o una compu) que recibe los avisos de una persona: su suscripción del navegador
 * (push web, RFC 8030 y 8291). Es de la persona, no de una tienda: la app es un solo origen, así
 * que cada celular se activa una vez y le llega lo de todas sus tiendas. La dirección es única:
 * un navegador recibe los de una sola persona.
 */
export const pushDevice = pgTable(
  "push_device",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    /** Las claves del navegador para cifrar cada aviso (RFC 8291), en base64url. */
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** Cuándo salió «Listo» a este celular, para que se vea que funciona. Lo anota el sistema. */
    welcomedAt: timestamp("welcomed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("push_device_endpoint_key").on(table.endpoint),
    check(
      "push_device_keys_check",
      sql`char_length(${table.endpoint}) between 10 and 1000 and char_length(${table.p256dh}) between 1 and 200 and char_length(${table.auth}) between 1 and 100`,
    ),
    foreignKey({
      name: "push_device_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [accountCopy.userId],
    }).onDelete("cascade"),
    index("push_device_user_idx").on(table.userId, table.createdAt),
  ],
)

/**
 * Qué le llega a cada persona de cada tienda: lo que eligió en Configuración › Avisos al
 * celular, que vale en todos sus celulares, y hasta dónde ya miró el sistema para no avisar dos
 * veces lo mismo. Va unido a su lugar en el equipo: quien deja la tienda deja de recibirlos.
 */
export const pushChoice = pgTable(
  "push_choice",
  {
    storeId: uuid("store_id").notNull(),
    userId: text("user_id").notNull(),
    /** Lo que eligió, entre lo que su rol puede resolver. Nulo: lo de su rol por omisión. */
    kinds: text("kinds").array().$type<PushKind[]>(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Lo escribe el sistema, antes de enviar: el último paso de los pedidos (`order_event.seq`)
     * ya mirado y los chats que ya esperaban. Nulos: todavía no miró; la primera vez no avisa lo
     * que ya estaba.
     */
    lastEventSeq: bigint("last_event_seq", { mode: "number" }),
    chatsSeen: uuid("chats_seen").array(),
  },
  (table) => [
    primaryKey({ name: "push_choice_pkey", columns: [table.storeId, table.userId] }),
    check(
      "push_choice_kinds_check",
      sql`${table.kinds} is null or ${table.kinds} <@ ${sql.raw(`array[${PUSH_KINDS.map((kind) => `'${kind}'`).join(",")}]::text[]`)}`,
    ),
    foreignKey({
      name: "push_choice_member_fkey",
      columns: [table.storeId, table.userId],
      foreignColumns: [storeMember.storeId, storeMember.userId],
    }).onDelete("cascade"),
  ],
)
