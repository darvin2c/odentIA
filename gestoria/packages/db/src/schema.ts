import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
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
