import { sql } from "drizzle-orm"
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { authSchema } from "./schemas.js"

/**
 * Las apps del grupo que entran con la cuenta (ADR 0201). El nombre, el producto y la
 * marca de cada una los dice `@odentia/auth` (`apps.ts`); aquí solo la lista, para los
 * checks de la base.
 */
export const ACCOUNT_APPS = ["odentia", "latidia", "vistia", "gestoria"] as const

/** Lo que la cuenta avisa a las apps que son otro sistema (`account_event`). */
export const ACCOUNT_EVENT_TYPES = ["cuenta.cerrada"] as const

const appIn = (column: string) =>
  sql.raw(`${column} IN (${ACCOUNT_APPS.map((app) => `'${app}'`).join(",")})`)

export const user = authSchema.table("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  /** Bandera del plugin twoFactor de Better Auth (la gestiona Auth). */
  twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
  image: text("image"),
  /**
   * Versión (fecha ISO) de los términos, el aviso de privacidad y el contrato de
   * encargo que aceptó al crear la cuenta con correo, y cuándo. Nulos si entró
   * con Google o antes de que se pidieran.
   */
  termsVersion: text("terms_version"),
  termsAcceptedAt: timestamp("terms_accepted_at"),
  /**
   * Versión del Contrato de encargo de tratamiento que aceptó al abrir una
   * clínica, y cuándo. La clínica que crea la copia a
   * `processing_agreement_acceptance`; quien entra invitado no lo acepta.
   */
  processingAgreementVersion: text("processing_agreement_version"),
  processingAgreementAcceptedAt: timestamp("processing_agreement_accepted_at"),
  /**
   * La app en cuya entrada se registró (ADR 0201): de ella son los avisos de la cuenta
   * (completar la cuenta, crear su clínica). Nula: se registró antes de que se guardara,
   * o la creó la administración; vale la app base.
   */
  signupApp: text("signup_app"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
}, () => [check("user_signup_app_check", sql`signup_app IS NULL OR ${appIn("signup_app")}`)])

export const session = authSchema.table(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
)

export const account = authSchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
)

export const verification = authSchema.table(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
)

export const organization = pgTable(
  "organization",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    logo: text("logo"),
    createdAt: timestamp("created_at").notNull(),
    metadata: text("metadata"),
  },
  (table) => [uniqueIndex("organization_slug_uidx").on(table.slug)],
)

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").default("member").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
  ],
)

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
)







/**
 * Llaves del plugin `jwt` de Better Auth (ADR 0201): firman el token con que otra app
 * reconoce a quien entró, sin leer esta base. La privada va cifrada con el secreto de la
 * API; la pública se publica en `/api/auth/jwks`. La clave del export (`jwks`) es el
 * nombre de modelo que resuelve el drizzleAdapter.
 */
export const jwks = authSchema.table("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull(),
  expiresAt: timestamp("expires_at"),
  alg: text("alg"),
  crv: text("crv"),
})

/**
 * Lo que la cuenta avisa a cada app que es otro sistema (ADR 0201): una fila por aviso y
 * por app, escrita en la misma transacción que el cambio. Se manda firmada (Standard
 * Webhooks) y se reintenta hasta que la app responde que la recibió: la app reconoce un
 * repetido por su `id`, así que repetirla nunca duplica el efecto. `user_id` no es clave
 * foránea: el aviso es historia y no cuenta como relación de la cuenta.
 */
export const accountEvent = authSchema.table(
  "account_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    type: text("type").notNull(),
    app: text("app").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (table) => [
    index("account_event_pending_idx").on(table.app, table.nextAttemptAt).where(sql`delivered_at IS NULL`),
    check("account_event_app_check", appIn("app")),
    check(
      "account_event_type_check",
      sql.raw(`type IN (${ACCOUNT_EVENT_TYPES.map((type) => `'${type}'`).join(",")})`),
    ),
  ],
)
