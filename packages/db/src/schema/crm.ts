import { sql } from "drizzle-orm"
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
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

/**
 * Persona que la clínica conoce: quien escribe, paga, representa o se atiende.
 * Todo paciente es exactamente una persona (su vínculo `self`); la identidad
 * (nombre, documento, nacimiento, sexo, teléfono, correo) se mantiene igual en
 * ambos registros por triggers de la migración de persona única.
 */
/**
 * Medio preferido de la persona para avisos y documentos (Fase 7 Finanzas).
 * Solo entre canales conectables; la UI ofrece únicamente los canales con
 * conexión activa. No crea identidades ni conversaciones por sí solo.
 */
export const PREFERRED_CHANNELS = ["email", "whatsapp", "telegram", "messenger", "instagram"] as const
export type PreferredChannel = (typeof PREFERRED_CHANNELS)[number]

export const contact = pgTable("contact", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  organizationId: orgFk("organization_id"),
  displayName: text("display_name").notNull(),
  /** Nombre separado (ADR 0004); display_name se deriva de él en la base. */
  givenNames: text("given_names"),
  paternalSurname: text("paternal_surname"),
  maternalSurname: text("maternal_surname"),
  /** País emisor del documento (ISO 3166-1 alfa-2). */
  docCountry: char("doc_country", { length: 2 }),
  phone: text("phone"),
  email: text("email"),
  /** Medio preferido para avisos y documentos; nulo = sin preferencia. */
  preferredChannel: text("preferred_channel"),
  docType: text("doc_type"),
  docNumber: text("doc_number"),
  birthDate: date("birth_date"),
  sex: text("sex"),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  tags: text("tags").array().notNull().default(sql`'{}'`),
  customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),
  assignedUserId: text("assigned_user_id").references(() => user.id),
  lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
  ...timestamps,
}, table => [
  uniqueIndex("contact_org_id_uidx").on(table.organizationId, table.id),
  // El documento identifica a una sola persona por organización.
  uniqueIndex("contact_org_doc_uidx")
    .on(table.organizationId, table.docType, table.docNumber)
    .where(sql`"doc_number" IS NOT NULL`),
  check(
    "contact_preferred_channel_check",
    sql`${table.preferredChannel} IS NULL OR ${table.preferredChannel} IN ('email','whatsapp','telegram','messenger','instagram')`,
  ),
  check(
    "contact_doc_type_check",
    sql`${table.docType} IS NULL OR ${table.docType} IN ('DNI','CE','PASAPORTE','CNV','DIE','OTRO')`,
  ),
  // ISO/IEC 5218: M=1, F=2, I(indeterminado)=9, D(desconocido)=0.
  check("contact_sex_check", sql`${table.sex} IS NULL OR ${table.sex} IN ('M','F','I','D')`),
])

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
    uniqueIndex("contact_identity_org_id_uidx").on(table.organizationId, table.id),
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
    contactIdentityId: uuid("contact_identity_id"),
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
    uniqueIndex("conversation_org_id_uidx").on(table.organizationId, table.id),
    foreignKey({ columns: [table.organizationId, table.contactIdentityId], foreignColumns: [contactIdentity.organizationId, contactIdentity.id] }),
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
    // Instante en que el proveedor aceptó el envío real (outbound). Lo registra
    // el worker al aceptar el proveedor y applyStatus al primer sent/delivered/read
    // si sigue nulo. Histórico sin timestamp queda nulo (sin backfill inventado).
    sentAt: timestamp("sent_at", { withTimezone: true }),
    // Invocación de plantilla (solo content_type 'template'): lo necesario
    // para que el worker reenvíe sin acoplar el body.
    templateName: text("template_name"),
    templateLanguage: text("template_language"),
    templateParams: jsonb("template_params"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("message_conversation_external_uidx")
      .on(table.conversationId, table.externalId)
      .where(sql`"external_id" is not null`),
    index("message_conversation_created_idx").on(table.conversationId, table.createdAt),
  ],
)

/** Clases de tarea: manual o seguimiento comercial sincronizado con la próxima acción. */
export const TASK_KINDS = ["manual", "opportunity_follow_up"] as const
export type TaskKind = (typeof TASK_KINDS)[number]
export const crmTask = pgTable(
  "task",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    contactId: uuid("contact_id").references(() => contact.id),
    conversationId: uuid("conversation_id").references(() => conversation.id),
    // Oportunidad vinculada. Sin FK en TS para evitar el ciclo con opportunities.ts;
    // la migración del coordinador añade la FK con ON DELETE SET NULL.
    opportunityId: uuid("opportunity_id"),
    // Paciente al que se refiere la tarea. Sin FK en TS para evitar el ciclo con
    // clinical.ts; la migración añade la FK compuesta por organización.
    patientId: uuid("patient_id"),
    assigneeUserId: text("assignee_user_id").references(() => user.id),
    title: text("title").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    status: text("status").notNull().default("open"),
    kind: text("kind").notNull().default("manual"),
    createdBy: text("created_by").notNull(),
    /** Clave estable por trigger del agente: la reentrega no duplica la tarea. */
    idempotencyKey: text("idempotency_key"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("task_org_id_uidx").on(table.organizationId, table.id),
    // Un solo seguimiento abierto por oportunidad (índice único parcial en migración).
    uniqueIndex("task_org_opp_open_uidx")
      .on(table.organizationId, table.opportunityId)
      .where(sql`"opportunity_id" IS NOT NULL AND "kind" = 'opportunity_follow_up' AND "status" = 'open'`),
    uniqueIndex("task_org_idempotency_uidx")
      .on(table.organizationId, table.idempotencyKey)
      .where(sql`"idempotency_key" IS NOT NULL`),
    index("task_org_contact_idx").on(table.organizationId, table.contactId),
    index("task_org_conversation_idx").on(table.organizationId, table.conversationId),
    index("task_org_opportunity_idx").on(table.organizationId, table.opportunityId),
    index("task_org_patient_idx").on(table.organizationId, table.patientId),
    index("task_org_status_due_idx").on(table.organizationId, table.status, table.dueAt),
  ],
)

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

/**
 * Configuración del agente por organización. El proveedor LLM propio es un
 * par atómico (URL base + clave cifrada): nunca se combina una URL de la
 * organización con la clave de la plataforma.
 */
/** Ajustes del asesor por organización; ver `agent_config.advisor`. */
export interface AgentAdvisorSettings {
  enabled?: boolean
  detections?: Record<string, { off?: boolean; days?: number; snoozedUntil?: string }>
}

export const agentConfig = pgTable(
  "agent_config",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id),
    enabled: boolean("enabled").notNull().default(false),
    model: text("model"),
    /** URL base de un endpoint compatible con OpenAI propio de la organización. */
    llmBaseUrl: text("llm_base_url"),
    /** Clave del proveedor propio, cifrada con AES-256-GCM (nunca sale a la UI). */
    llmApiKeyEncrypted: text("llm_api_key_encrypted"),
    /** Corridas con llamada al modelo permitidas por día (zona de la organización). */
    dailyRunLimit: integer("daily_run_limit").notNull().default(500),
    /** Modelo de decisión (none | baseline | jev | openai_decisions). */
    decisionProvider: text("decision_provider").notNull().default("none"),
    /**
     * Con modelo de decisión: elige el camino del turno antes de llamar al
     * modelo que escribe. Apagado, el modelo de decisión solo elige
     * conocimiento y opina en sombra.
     */
    decisionRoutingEnabled: boolean("decision_routing_enabled").notNull().default(true),
    /**
     * Asesor: si está encendido y, por detección, si se apagó, hasta cuándo
     * se pospuso y con qué umbral de días. Vacío = apagado, todo por defecto.
     */
    advisor: jsonb("advisor").$type<AgentAdvisorSettings>().notNull().default(sql`'{}'::jsonb`),
    /** Asistente clínico: dictado en la atención. Apagado hasta que la clínica lo encienda. */
    clinicalAssistantEnabled: boolean("clinical_assistant_enabled").notNull().default(false),
    systemPrompt: text("system_prompt").notNull().default(""),
    handoffKeywords: text("handoff_keywords").array().notNull().default(sql`'{}'`),
    maxTurns: integer("max_turns").notNull().default(10),
    /** Comprueba precios, fechas y horas de cada respuesta contra lo consultado antes de enviarla. */
    replyCheckEnabled: boolean("reply_check_enabled").notNull().default(true),
    /**
     * La voz de la clínica (la base que comparten sus agentes): cómo se
     * presenta, el trato, el tono y unas líneas sobre quiénes son. Nulo o vacío
     * = sin indicación propia.
     */
    personaName: text("persona_name"),
    treatment: text("treatment"),
    tone: text("tone").notNull().default("cercano"),
    about: text("about").notNull().default(""),
    /** Funciones de Recepción que la clínica apagó (ver la ficha del agente). */
    disabledFunctions: text("disabled_functions").array().notNull().default(sql`'{}'`),
    /** Indicación de la clínica para una función concreta, por id de función. */
    functionNotes: jsonb("function_notes").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    /**
     * Límites que aplica el sistema: franja del día en que responde (minutos
     * desde medianoche en la zona de la clínica; nulos = a toda hora) y canales
     * donde atiende (nulo = todos los conectados).
     */
    activeFromMin: integer("active_from_min"),
    activeUntilMin: integer("active_until_min"),
    channels: text("channels").array(),
    /** Mensajes de prueba enviados desde «Probar»: solo para saber si la clínica ya lo probó. */
    sandboxTurns: integer("sandbox_turns").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "agent_config_llm_pair_check",
      sql`(${table.llmBaseUrl} is null) = (${table.llmApiKeyEncrypted} is null)`,
    ),
    check("agent_config_daily_run_limit_check", sql`${table.dailyRunLimit} between 1 and 100000`),
    check(
      "agent_config_decision_provider_check",
      sql`${table.decisionProvider} in ('none','baseline','jev','openai_decisions')`,
    ),
    check("agent_config_treatment_check", sql`${table.treatment} is null or ${table.treatment} in ('tu','usted')`),
    check("agent_config_tone_check", sql`${table.tone} in ('cercano','neutro','formal')`),
    check(
      "agent_config_active_hours_check",
      sql`(${table.activeFromMin} is null) = (${table.activeUntilMin} is null) and (${table.activeFromMin} is null or (${table.activeFromMin} between 0 and 1439 and ${table.activeUntilMin} between 1 and 1440 and ${table.activeFromMin} <> ${table.activeUntilMin}))`,
    ),
  ],
)

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
