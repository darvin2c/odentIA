import { sql } from "drizzle-orm"
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { orgFk } from "./crm.js"

/** Avisos personales: el ámbito de organización no sustituye al destinatario. */
export const workspaceNotification = pgTable("workspace_notification", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  userId: text("user_id").notNull().references(() => user.id),
  dedupeKey: text("dedupe_key").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  href: text("href").notNull(),
  permission: text("permission").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, table => [
  uniqueIndex("workspace_notification_recipient_key_uidx").on(table.organizationId, table.userId, table.dedupeKey),
  index("workspace_notification_recipient_date_idx").on(table.organizationId, table.userId, table.createdAt),
])

/**
 * Consulta a la Ayuda de odentIA. No guarda lo que se preguntó: solo la
 * pantalla, el tema que respondió (o ninguno) y si sirvió. Con eso se sabe qué
 * falta en la guía sin leer lo que escribe el equipo, y se aplica el tope
 * diario por persona.
 */
export const helpAsk = pgTable("help_ask", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  userId: text("user_id").notNull().references(() => user.id),
  screen: text("screen").notNull(),
  topicId: text("topic_id"),
  helpful: boolean("helpful"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("help_ask_user_date_idx").on(table.organizationId, table.userId, table.createdAt),
])

/**
 * Lo que una persona decide enviar a odentIA cuando la Ayuda no supo
 * responder o algo falló. Aquí sí va su texto, porque ella lo envía. Las
 * preguntas iguales de distintas clínicas comparten `dedupe_key`: el equipo de
 * odentIA las atiende como un solo caso y la respuesta llega a todas.
 */
export const helpRequest = pgTable("help_request", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  userId: text("user_id").notNull().references(() => user.id),
  kind: text("kind").notNull().default("pregunta"),
  question: text("question").notNull(),
  /** Código del error o detalle técnico, cuando se reporta un problema. */
  detail: text("detail"),
  screen: text("screen").notNull(),
  role: text("role").notNull(),
  appVersion: text("app_version"),
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status").notNull().default("abierta"),
  answer: text("answer"),
  answeredAt: timestamp("answered_at", { withTimezone: true }),
  /** Cuándo vio la respuesta quien preguntó. */
  seenAt: timestamp("seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("help_request_user_idx").on(table.organizationId, table.userId, table.createdAt),
  index("help_request_case_idx").on(table.dedupeKey, table.status),
  check("help_request_kind_check", sql`${table.kind} in ('pregunta','problema')`),
  check("help_request_status_check", sql`${table.status} in ('abierta','respondida')`),
])
