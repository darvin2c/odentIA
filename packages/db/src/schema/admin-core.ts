import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { adminSchema, authSchema } from "./schemas.js"

/**
 * Lo que nunca es la dirección de una persona del equipo: los buzones de cada
 * dominio y los nombres que un remitente usa para parecer oficial. La misma
 * lista vive en el check de la base y en `admin_staff_mail_local_for`.
 */
export const STAFF_MAIL_RESERVED = [
  "soporte",
  "hola",
  "contacto",
  "fundadores",
  "privacidad",
  "reclamaciones",
  "redes",
  "reply",
  "no-reply",
  "noreply",
  "postmaster",
  "abuse",
  "admin",
  "administracion",
  "ventas",
  "info",
  "webmaster",
  "hostmaster",
  "mailer-daemon",
  "security",
  "seguridad",
] as const
/** La parte local de la dirección de una persona: minúsculas y números, con «.», «_» o «-» entre ellos. */
export const STAFF_MAIL_LOCAL_PATTERN = "^[a-z0-9]+([._-][a-z0-9]+)*$"

/**
 * Personal interno de odentIA (administración global). Separado de
 * `member`/OrgRole: el staff NO hereda membresía de ningún tenant y ningún
 * cliente accede a endpoints globales. Solo roles `admin` y `support`.
 *
 * Cada persona tiene su dirección en los dominios de las marcas
 * (`mail_local`@odentia32.com, @latidia72.com, @vistia20.com): la base la pone
 * sola al crear la fila (`admin_staff_mail_local`) y Administración la corrige
 * mientras no haya salido nada con ella (`mail_first_sent_at`); después queda
 * fija (`admin_staff_mail_guard`). `mail_copy_to` es el buzón donde le llega la
 * copia de lo que le escriben.
 */
// Las claves foráneas de las tablas de administración llevan el nombre que les
// dio PostgreSQL al crearlas a mano (`<tabla>_<columna>_fkey`).
export const adminStaff = adminSchema.table("admin_staff", {
  userId: text("user_id").primaryKey(),
  role: text("role").notNull(),
  active: boolean("active").notNull().default(true),
  mailLocal: text("mail_local"),
  mailCopyTo: text("mail_copy_to"),
  mailFirstSentAt: timestamp("mail_first_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ name: "admin_staff_user_id_fkey", columns: [table.userId], foreignColumns: [user.id] })
    .onDelete("cascade"),
  uniqueIndex("admin_staff_mail_local_uidx").on(table.mailLocal),
  check(
    "admin_staff_mail_local_check",
    sql`${table.mailLocal} IS NULL OR (${table.mailLocal} ~ ${sql.raw(`'${STAFF_MAIL_LOCAL_PATTERN}'`)}
      AND length(${table.mailLocal}) BETWEEN 2 AND 64
      AND ${table.mailLocal} NOT IN (${sql.raw(STAFF_MAIL_RESERVED.map((name) => `'${name}'`).join(","))}))`,
  ),
  check(
    "admin_staff_mail_copy_check",
    sql`${table.mailCopyTo} IS NULL OR (${table.mailCopyTo} = lower(${table.mailCopyTo})
      AND length(${table.mailCopyTo}) BETWEEN 3 AND 254 AND ${table.mailCopyTo} LIKE '_%@_%._%'
      AND strpos(${table.mailCopyTo}, ' ') = 0)`,
  ),
])

/**
 * Auditoría administrativa append-only: solo INSERT/SELECT. Sin UPDATE ni
 * DELETE (reforzado con REVOKE en `0001_base_reglas.sql`).
 */
export const adminAudit = adminSchema.table(
  "admin_audit",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: text("actor_user_id"),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    organizationId: text("organization_id"),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  },
  (table) => [
    index("admin_audit_created_idx").on(table.createdAt),
    index("admin_audit_actor_idx").on(table.actorUserId),
    // Lo último de una clínica por acción: quién cargó, si ya se cargó, el relleno del alta.
    index("admin_audit_org_action_idx").on(
      table.organizationId,
      table.action,
      table.createdAt.desc(),
    ),
  ],
)

/**
 * Invitación de personal: nunca autoeleva por dominio. La aceptación exige
 * sesión con identidad verificada (mismo correo, email verificado) y no crea
 * cuenta: el usuario ya debe existir.
 */
export const adminInvitation = adminSchema.table(
  "admin_invitation",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    email: text("email").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    /** sha256 hex del token de aceptación (el crudo se entrega una sola vez al invitar). */
    tokenHash: text("token_hash").notNull(),
    /** Entrega del correo: pending|sent|uncertain (sin afirmar no-enviado; reenvío humano explícito). */
    deliveryStatus: text("delivery_status").notNull().default("pending"),
    invitedBy: text("invited_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedUserId: text("accepted_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("admin_invitation_email_idx").on(table.email),
    unique("admin_invitation_token_hash_key").on(table.tokenHash),
    foreignKey({ name: "admin_invitation_invited_by_fkey", columns: [table.invitedBy], foreignColumns: [user.id] })
      .onDelete("cascade"),
    foreignKey({
      name: "admin_invitation_accepted_user_id_fkey",
      columns: [table.acceptedUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
  ],
)

/**
 * Vincula el segundo factor verificado con la sesión que lo presentó.
 * El guard exige una fila viva (sin revocar, sin expirar) por sesión:
 * la sesión sola nunca basta cuando el usuario ya tiene factor.
 */
export const adminSessionVerification = adminSchema.table(
  "admin_session_verification",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    /** two_factor.id que superó la prueba: si el factor cambia, la prueba vieja muere. */
    factorId: text("factor_id").notNull(),
    /** totp | recovery (código de respaldo: caducidad corta) | device (equipo reconocido, ADR 0090). */
    method: text("method").notNull(),
    /** País de la visita al verificar (cabecera de Cloudflare); otro país vuelve a pedir el código. */
    country: text("country"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("admin_session_verification_session_idx").on(table.sessionId),
    index("admin_session_verification_user_idx").on(table.userId),
    foreignKey({
      name: "admin_session_verification_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
  ],
)

/**
 * Equipo reconocido del personal (ADR 0090): tras poner el código, el
 * navegador guarda un token y aquí queda solo su hash. Vuelve a pedirse con
 * otro país, 30 días sin uso, otra contraseña u otro factor.
 */
export const adminTrustedDevice = adminSchema.table(
  "admin_trusted_device",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    /** two_factor.id con que se reconoció: un factor nuevo lo deja sin valor. */
    factorId: text("factor_id").notNull(),
    /** SHA-256 del token del navegador; el token nunca se guarda. */
    tokenHash: text("token_hash").notNull(),
    /** País de la visita al reconocerlo; nulo sin cabecera (desarrollo). */
    country: text("country"),
    /** Huella de la contraseña al reconocerlo: cambiarla lo deja sin valor. Nula sin contraseña. */
    passwordFingerprint: text("password_fingerprint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("admin_trusted_device_token_uidx").on(table.tokenHash),
    index("admin_trusted_device_user_idx").on(table.userId),
    foreignKey({
      name: "admin_trusted_device_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
  ],
)

/**
 * Segundo factor TOTP de Better Auth (estándar, sin cripto propia).
 * La clave del export (`twoFactor`) es el nombre de modelo que el
 * drizzleAdapter resuelve en `db._.fullSchema`; el nombre SQL es libre.
 */
export const twoFactor = authSchema.table(
  "two_factor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (table) => [
    index("two_factor_user_idx").on(table.userId),
    foreignKey({ name: "two_factor_user_id_fkey", columns: [table.userId], foreignColumns: [user.id] })
      .onDelete("cascade"),
  ],
)
