import { sql } from "drizzle-orm"
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth.js"

/**
 * Personal interno de odentIA (administración global). Separado de
 * `member`/OrgRole: el staff NO hereda membresía de ningún tenant y ningún
 * cliente accede a endpoints globales. Solo roles `admin` y `support`.
 */
// Las claves foráneas de las tablas de administración llevan el nombre que les
// dio PostgreSQL al crearlas a mano (`<tabla>_<columna>_fkey`).
export const adminStaff = pgTable("admin_staff", {
  userId: text("user_id").primaryKey(),
  role: text("role").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({ name: "admin_staff_user_id_fkey", columns: [table.userId], foreignColumns: [user.id] })
    .onDelete("cascade"),
])

/**
 * Auditoría administrativa append-only: solo INSERT/SELECT. Sin UPDATE ni
 * DELETE (reforzado con REVOKE en `0001_base_reglas.sql`).
 */
export const adminAudit = pgTable(
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
  ],
)

/**
 * Invitación de personal: nunca autoeleva por dominio. La aceptación exige
 * sesión con identidad verificada (mismo correo, email verificado) y no crea
 * cuenta: el usuario ya debe existir.
 */
export const adminInvitation = pgTable(
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
export const adminSessionVerification = pgTable(
  "admin_session_verification",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    /** two_factor.id que superó la prueba: si el factor cambia, la prueba vieja muere. */
    factorId: text("factor_id").notNull(),
    /** totp | recovery (código de respaldo: caducidad corta). */
    method: text("method").notNull(),
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
 * Segundo factor TOTP de Better Auth (estándar, sin cripto propia).
 * La clave del export (`twoFactor`) es el nombre de modelo que el
 * drizzleAdapter resuelve en `db._.fullSchema`; el nombre SQL es libre.
 */
export const twoFactor = pgTable(
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
