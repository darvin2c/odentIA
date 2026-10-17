import { sql } from "drizzle-orm"
import { boolean, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
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
  /**
   * El asunto del aviso (`<clase>:<id>`), cuando tiene uno que se resuelve: el
   * aviso se retira solo al resolverse (`settleWorkspaceNotifications`). Nulo en
   * los avisos que solo informan.
   */
  subject: text("subject"),
  /** Cuándo se retiró por resolverse su asunto: deja de mostrarse (el aviso no se borra). */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, table => [
  uniqueIndex("workspace_notification_recipient_key_uidx").on(table.organizationId, table.userId, table.dedupeKey),
  index("workspace_notification_recipient_date_idx").on(table.organizationId, table.userId, table.createdAt),
  index("workspace_notification_subject_idx").on(table.organizationId, table.subject),
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
 * Última vez que cada persona miró Inicio en una clínica, para «Mientras no
 * estabas»: la primera visita de cada día (en la zona de la clínica) cuenta lo
 * que hicieron los agentes desde la visita anterior. `greetedOn` es el día en
 * que ya se le mostró; una vez al día.
 */
export const homeVisit = pgTable("home_visit", {
  organizationId: orgFk("organization_id"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  greetedOn: date("greeted_on", { mode: "string" }),
}, table => [
  uniqueIndex("home_visit_user_uidx").on(table.organizationId, table.userId),
])
