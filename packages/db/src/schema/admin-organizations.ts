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
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth.js"

/**
 * Administración de organizaciones y cuentas.
 *
 * Tablas globales internas: solo el rol owner las toca (`0001_base_reglas.sql`
 * revoca el acceso del rol app). Los servicios de admin reciben un tx
 * owner explícito tras el guard de staff; jamás se entrega al cliente.
 *
 * - `userGlobalBlock`: bloqueo global de acceso con motivo (admin-only). No
 *   borra la fila de `user`: la autoría (auditoría, clínica, comisiones) se
 *   conserva. Bloquear corta todas las sesiones en la misma transacción.
 * - `accountRecoveryCase`: recuperación de correo/propiedad con doble
 *   control. Un adjunto nunca basta: el caso exige evidencia verificada
 *   explícita y dos aprobaciones de admin distinto antes de ejecutar. Nunca
 *   se autoasigna por coincidir el correo.
 * - `accountLifecycleNotice`: claim durable del recordatorio de alta (3
 *   días). El claim se reserva ANTES del envío (status claimed); tras el
 *   SMTP se marca sent, y si el envío falla, uncertain SIN reintento
 *   automático. Así dos workers nunca envían dos veces y un fallo ambiguo
 *   no repite el correo.
 */
// Las claves foráneas llevan el nombre que les dio PostgreSQL al crear estas
// tablas a mano (`<tabla>_<columna>_fkey`).
export const userGlobalBlock = pgTable("user_global_block", {
  userId: text("user_id").primaryKey(),
  reason: text("reason").notNull(),
  blockedBy: text("blocked_by"),
  blockedAt: timestamp("blocked_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  unblockedBy: text("unblocked_by"),
  unblockedAt: timestamp("unblocked_at", { withTimezone: true }),
}, (table) => [
  foreignKey({ name: "user_global_block_user_id_fkey", columns: [table.userId], foreignColumns: [user.id] })
    .onDelete("cascade"),
  foreignKey({ name: "user_global_block_blocked_by_fkey", columns: [table.blockedBy], foreignColumns: [user.id] }),
  foreignKey({
    name: "user_global_block_unblocked_by_fkey",
    columns: [table.unblockedBy],
    foreignColumns: [user.id],
  }),
])

export const accountRecoveryCase = pgTable(
  "account_recovery_case",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    subjectUserId: text("subject_user_id"),
    email: text("email").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pendiente"),
    evidence: jsonb("evidence").notNull().default({}),
    requestedBy: text("requested_by"),
    approvals: jsonb("approvals").notNull().default([]),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("account_recovery_case_email_idx").on(table.email),
    index("account_recovery_case_status_idx").on(table.status),
    foreignKey({
      name: "account_recovery_case_subject_user_id_fkey",
      columns: [table.subjectUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    foreignKey({
      name: "account_recovery_case_requested_by_fkey",
      columns: [table.requestedBy],
      foreignColumns: [user.id],
    }),
    foreignKey({
      name: "account_recovery_case_decided_by_fkey",
      columns: [table.decidedBy],
      foreignColumns: [user.id],
    }),
  ],
)

export const accountLifecycleNotice = pgTable("account_lifecycle_notice", {
  userId: text("user_id").primaryKey(),
  kind: text("kind").notNull().default("recordatorio_3d"),
  status: text("status").notNull().default("claimed"),
  attempts: integer("attempts").notNull().default(0),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "account_lifecycle_notice_user_id_fkey",
    columns: [table.userId],
    foreignColumns: [user.id],
  }).onDelete("cascade"),
])
