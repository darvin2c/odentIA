import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
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
