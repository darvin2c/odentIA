import { sql } from "drizzle-orm"
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { contact, conversation, orgFk } from "./crm.js"
import { opportunity } from "./opportunities.js"

/**
 * Nota operativa del CRM (actividad unificada, paso P1).
 *
 * Texto de trabajo sobre un contacto, NO historia clínica ni documento
 * económico. Tabla propia para no mezclar `contact.notes` con el timeline.
 * Inmutable: sin `updated_at`; la migración revoca UPDATE/DELETE al rol app.
 */
export const crmNote = pgTable(
  "crm_note",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    opportunityId: uuid("opportunity_id").references(() => opportunity.id, {
      onDelete: "set null",
    }),
    authorUserId: text("author_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("crm_note_org_id_uidx").on(table.organizationId, table.id),
    index("crm_note_org_contact_created_idx").on(
      table.organizationId,
      table.contactId,
      table.createdAt.desc(),
    ),
    index("crm_note_org_conversation_idx").on(table.organizationId, table.conversationId),
    index("crm_note_org_opportunity_idx").on(table.organizationId, table.opportunityId),
  ],
)
