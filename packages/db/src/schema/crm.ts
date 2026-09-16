import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { organization, user } from "./auth.js"

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}

export function orgFk(target: Parameters<typeof text>[0]) {
  return text(target)
    .notNull()
    .references(() => organization.id)
}

export const channelConnection = pgTable(
  "channel_connection",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    channel: text("channel").notNull(),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    externalId: text("external_id"),
    configEncrypted: text("config_encrypted").notNull(),
    webhookSecret: text("webhook_secret").notNull(),
    status: text("status").notNull().default("active"),
    pollingOffset: text("polling_offset"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("channel_connection_provider_external_uidx")
      .on(table.provider, table.externalId)
      .where(sql`"external_id" is not null`),
  ],
)

export const pipeline = pgTable(
  "pipeline",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Un solo default por org (las carreras en ensureDefaultPipeline reintentan).
    uniqueIndex("pipeline_org_default_uidx").on(table.organizationId).where(sql`"is_default"`),
  ],
)

export const pipelineStage = pgTable(
  "pipeline_stage",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipeline.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pipeline_stage_pipeline_position_uidx").on(table.pipelineId, table.position),
  ],
)

export const contact = pgTable("contact", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  displayName: text("display_name").notNull(),
  notes: text("notes"),
  tags: text("tags").array().notNull().default(sql`'{}'`),
  customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),
  stageId: uuid("stage_id").references(() => pipelineStage.id),
  assignedUserId: text("assigned_user_id").references(() => user.id),
  lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
  ...timestamps,
})

export const contactIdentity = pgTable(
  "contact_identity",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    externalUserId: text("external_user_id").notNull(),
    displayName: text("display_name"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Invariante: teléfono compartido ≠ paciente único. La identidad apunta a
    // un contacto y nunca se fusiona automáticamente por teléfono.
    uniqueIndex("contact_identity_org_channel_user_uidx").on(
      table.organizationId,
      table.channel,
      table.externalUserId,
    ),
  ],
)

export const conversation = pgTable(
  "conversation",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id),
    channelConnectionId: uuid("channel_connection_id")
      .notNull()
      .references(() => channelConnection.id),
    externalThreadId: text("external_thread_id").notNull(),
    status: text("status").notNull().default("open"),
    assignedUserId: text("assigned_user_id").references(() => user.id),
    agentStatus: text("agent_status").notNull().default("on"),
    unreadCount: integer("unread_count").notNull().default(0),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("conversation_connection_thread_uidx").on(
      table.channelConnectionId,
      table.externalThreadId,
    ),
    index("conversation_org_last_message_idx").on(table.organizationId, table.lastMessageAt.desc()),
  ],
)

export const message = pgTable(
  "message",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    senderKind: text("sender_kind").notNull(),
    senderUserId: text("sender_user_id"),
    contentType: text("content_type").notNull().default("text"),
    body: text("body"),
    attachments: jsonb("attachments").notNull().default(sql`'[]'::jsonb`),
    externalId: text("external_id"),
    status: text("status").notNull().default("received"),
    error: text("error"),
    // Invocación de plantilla (solo content_type 'template'): lo necesario
    // para que el worker reenvíe sin acoplar el body.
    templateName: text("template_name"),
    templateLanguage: text("template_language"),
    templateParams: jsonb("template_params"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Dedupe de ingesta: mismo evento del proveedor → un solo mensaje.
    uniqueIndex("message_conversation_external_uidx")
      .on(table.conversationId, table.externalId)
      .where(sql`"external_id" is not null`),
    index("message_conversation_created_idx").on(table.conversationId, table.createdAt),
  ],
)

export const crmTask = pgTable("task", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  contactId: uuid("contact_id").references(() => contact.id),
  conversationId: uuid("conversation_id").references(() => conversation.id),
  assigneeUserId: text("assignee_user_id").references(() => user.id),
  title: text("title").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  status: text("status").notNull().default("open"),
  createdBy: text("created_by").notNull(),
  ...timestamps,
})

export const customFieldDef = pgTable(
  "custom_field_def",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: text("type").notNull(),
    options: jsonb("options"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("custom_field_def_org_key_uidx").on(table.organizationId, table.key)],
)

export const agentConfig = pgTable("agent_config", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id),
  enabled: boolean("enabled").notNull().default(false),
  model: text("model"),
  systemPrompt: text("system_prompt").notNull().default(""),
  handoffKeywords: text("handoff_keywords").array().notNull().default(sql`'{}'`),
  maxTurns: integer("max_turns").notNull().default(10),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Ledger de dedupe de eventos inbound. SIN org_id y SIN RLS: el webhook aún
 * no ha resuelto el tenant y el externalEventId no contiene datos de tenant.
 */
export const inboundEvent = pgTable(
  "inbound_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    provider: text("provider").notNull(),
    externalEventId: text("external_event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("inbound_event_provider_event_uidx").on(table.provider, table.externalEventId),
  ],
)
