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

/**
 * Salud de una cuenta según su proveedor (hoy, WhatsApp): calidad del número y
 * a cuántas personas puede escribirles primero en un día. Cada dato es nulo si
 * el proveedor no lo entregó: nunca se rellena con un valor supuesto.
 */
export interface ConnectionHealth {
  quality: "alta" | "media" | "baja" | null
  dailyLimit: number | null
  /** El proveedor no pone tope diario. */
  unlimited: boolean
  /** Número tal como lo muestra el proveedor. */
  number: string | null
  /** Nombre verificado de la cuenta. */
  name: string | null
  checkedAt: string
}

/**
 * «Conectar con Facebook» (hoy, WhatsApp): después de la ventana del proveedor,
 * odentIA suscribe su app a los avisos de la cuenta y registra el número. Cada
 * paso guarda cuándo quedó hecho; mientras falte uno, la conexión necesita
 * atención y dice qué respondió el proveedor en el último intento.
 */
export interface ConnectionSignup {
  /** Cuándo se entró con Facebook por última vez. */
  grantedAt: string
  /** Cuándo quedó suscrita la app de odentIA a los avisos de la cuenta. Nulo: falta. */
  subscribedAt: string | null
  /** Cuándo quedó registrado el número para enviar y recibir. Nulo: falta. */
  registeredAt: string | null
  /** Qué pasó en el último intento de cada paso que sigue pendiente, en palabras. */
  problems: { suscribir?: string; registrar?: string }
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
    /**
     * Cuándo el proveedor verificó la dirección de avisos (el reto de Meta al
     * darla de alta a mano). Nulo: aún no la verificó o el canal no lo necesita.
     */
    webhookVerifiedAt: timestamp("webhook_verified_at", { withTimezone: true }),
    /** Lo último que el proveedor dijo de la cuenta. Nulo: no lo entrega o aún no se leyó. */
    health: jsonb("health").$type<ConnectionHealth>(),
    /**
     * Cuenta del proveedor dueña del número (en WhatsApp, la cuenta de WhatsApp
     * Business) cuando la conexión se hizo con «Conectar con Facebook». Por ella
     * se reparten los avisos que llegan a la app de odentIA sin número (cambios
     * de plantilla). Nulo: la conexión se hizo a mano y avisa a su propia dirección.
     */
    accountExternalId: text("account_external_id"),
    /** Los pasos de «Conectar con Facebook» y cómo quedaron. Nulo: conexión hecha a mano. */
    signup: jsonb("signup").$type<ConnectionSignup>(),
    /**
     * Cuándo se leyeron por última vez sus plantillas en la cuenta del
     * proveedor: la revisión diaria pone al día estados y categorías por si se
     * perdió un aviso. Nulo: aún no se leyeron.
     */
    templatesSyncedAt: timestamp("templates_synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("channel_connection_provider_external_uidx")
      .on(table.provider, table.externalId)
      .where(sql`"external_id" is not null`),
    index("channel_connection_account_idx")
      .on(table.provider, table.accountExternalId)
      .where(sql`"account_external_id" is not null`),
  ],
)

/**
 * Plantillas de la conexión tal como las tiene el proveedor (hoy, WhatsApp):
 * nadie escribe nombres a mano. Se leen de la cuenta y se actualizan cuando el
 * proveedor avisa un cambio de estado. Solo una `aprobada` se puede enviar.
 * `messageKey` enlaza la plantilla con el mensaje del catálogo al que sirve; las
 * de un mensaje creado por la clínica se reconocen por su nombre en
 * `clinic_message_version`.
 */
export const channelTemplate = pgTable(
  "channel_template",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => channelConnection.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    language: text("language").notNull(),
    /** utility | marketing | authentication: la decide el proveedor. */
    category: text("category").notNull().default("utility"),
    /** en_revision | aprobada | rechazada | pausada | deshabilitada */
    status: text("status").notNull().default("en_revision"),
    /** Motivo del proveedor cuando la rechaza o la pausa. */
    reason: text("reason"),
    /**
     * Desde cuándo está en ese estado, según lo supo el sistema (al pedirla o
     * al llegar el cambio). Nulo si ya estaba así en la cuenta: no se supone una fecha.
     */
    statusSince: timestamp("status_since", { withTimezone: true }),
    /** Cuerpo con variables por posición (`{{1}}`). */
    body: text("body").notNull().default(""),
    variables: integer("variables").notNull().default(0),
    /** Títulos de los botones de respuesta rápida, en orden. */
    buttons: jsonb("buttons").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    externalId: text("external_id"),
    /** Mensaje del catálogo de odentIA al que sirve; nulo si es propio de la clínica o ya estaba en la cuenta. */
    messageKey: text("message_key"),
    /** Cuándo la pidió odentIA; nulo si ya existía en la cuenta. */
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    /**
     * Por qué odentIA no sabe enviarla: `encabezado` (lleva encabezado) o
     * `datos_por_nombre` (sus datos van por nombre). Se muestra y no se ofrece.
     * Nulo: se puede enviar.
     */
    unsupported: text("unsupported"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("channel_template_connection_name_language_uidx").on(
      table.connectionId,
      table.name,
      table.language,
    ),
    index("channel_template_org_message_idx").on(table.organizationId, table.messageKey),
  ],
)

/**
 * Un mensaje de WhatsApp de la organización. Los del catálogo (`key`: los que
 * envía el agente y «Retomar la conversación») vienen escritos por odentIA y
 * solo tienen fila cuando la clínica les cambia el texto; los que la clínica
 * crea para la Bandeja llevan `title` y, si quiere, un botón de respuesta.
 *
 * `currentVersion` es el texto vigente para todas las vías (0 es el de
 * odentIA) y `pendingVersion` el cambio que espera a WhatsApp: mientras está
 * en revisión, o si lo rechaza, sigue saliendo el vigente. El estado de cada
 * versión en cada conexión vive en `channel_template`, por su nombre.
 */
export const clinicMessage = pgTable(
  "clinic_message",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    /** Clave del catálogo; nulo en un mensaje creado por la clínica. */
    key: text("key"),
    /** «Para qué sirve»: solo en los creados por la clínica. */
    title: text("title"),
    /** Botón de respuesta de un mensaje creado por la clínica; nulo si no lleva. */
    buttonTitle: text("button_title"),
    currentVersion: integer("current_version").notNull().default(0),
    pendingVersion: integer("pending_version"),
    /** Un mensaje creado por la clínica se elimina archivándolo; uno del catálogo, nunca. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("clinic_message_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("clinic_message_org_key_uidx").on(table.organizationId, table.key).where(sql`"key" is not null`),
    // Del catálogo o propio, nunca las dos cosas ni ninguna.
    check("clinic_message_kind_check", sql`(${table.key} is null) <> (${table.title} is null)`),
    check("clinic_message_catalog_check", sql`${table.key} is null or (${table.buttonTitle} is null and ${table.archivedAt} is null)`),
    check("clinic_message_version_check", sql`${table.currentVersion} >= 0 and (${table.pendingVersion} is null or ${table.pendingVersion} >= 0)`),
  ],
)

/**
 * Un texto que la clínica guardó para un mensaje. Los datos van por nombre
 * (`{{persona}}`); cada versión se pide a WhatsApp con su propio nombre de
 * plantilla, así la anterior sigue sirviendo mientras revisan la nueva. No se
 * edita ni se borra: un texto nuevo es otra versión.
 */
export const clinicMessageVersion = pgTable(
  "clinic_message_version",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    messageId: uuid("message_id").notNull(),
    /** Desde 1: el 0 es el texto de odentIA y no tiene fila. */
    number: integer("number").notNull(),
    body: text("body").notNull(),
    templateName: text("template_name").notNull(),
    createdBy: text("created_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.messageId],
      foreignColumns: [clinicMessage.organizationId, clinicMessage.id],
    }).onDelete("cascade"),
    uniqueIndex("clinic_message_version_message_number_uidx").on(table.messageId, table.number),
    uniqueIndex("clinic_message_version_org_template_uidx").on(table.organizationId, table.templateName),
    check("clinic_message_version_number_check", sql`${table.number} >= 1`),
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
    /**
     * El paso fijo que es esta etapa (`SALE_MOMENTS`): de él depende que la
     * oportunidad avance sola. La clínica cambia el nombre, nunca el paso.
     */
    moment: text("moment").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("pipeline_stage_pipeline_position_uidx").on(table.pipelineId, table.position),
    uniqueIndex("pipeline_stage_pipeline_moment_uidx").on(table.pipelineId, table.moment),
    check(
      "pipeline_stage_moment_check",
      sql`${table.moment} IN ('interesado','evaluacion_agendada','presupuesto_enviado','decidio')`,
    ),
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
  /** El nombre se separó por heurística: guardar los datos de la persona lo confirma. */
  identityNeedsReview: boolean("identity_needs_review").notNull().default(false),
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
  /** Archivada entera, con su ficha si es paciente (`setPersonArchived`). */
  isActive: boolean("is_active").notNull().default(true),
  // Las notas de la persona son `crm_note` (con autor y fecha); el responsable,
  // el de su conversación u oportunidad (fase 4, «un dato, un lugar»).
  tags: text("tags").array().notNull().default(sql`'{}'`),
  customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),
  lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true }),
  ...timestamps,
}, table => [
  uniqueIndex("contact_org_id_uidx").on(table.organizationId, table.id),
  // El documento, junto con su país emisor, identifica a una sola persona por
  // organización (NULLS NOT DISTINCT en la migración 0095). Es el único índice
  // de documento: la ficha de paciente no lo guarda (ADR 0044).
  uniqueIndex("contact_org_doc_uidx")
    .on(table.organizationId, table.docCountry, table.docType, table.docNumber)
    .where(sql`"doc_number" IS NOT NULL`),
  check(
    "contact_preferred_channel_check",
    sql`${table.preferredChannel} IS NULL OR ${table.preferredChannel} IN ('email','whatsapp','telegram','messenger','instagram')`,
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
    /**
     * WhatsApp rechazó un mensaje porque el número no tiene WhatsApp (decisión
     * 23, caso 1): la ficha lo dice y no se le escribe por aquí. Vuelve a vacío
     * si la persona escribe desde ese número o el equipo lo vuelve a marcar.
     */
    noWhatsappAt: timestamp("no_whatsapp_at", { withTimezone: true }),
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
    /**
     * Cierre de la atención (ADR 0024): cuándo, quién (nulo = el agente o el
     * sistema) y por qué (`CONVERSATION_CLOSE_REASONS`). Solo con `status`
     * cerrada; reabrir los limpia.
     */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: text("closed_by_user_id").references(() => user.id),
    closeReason: text("close_reason"),
    /** Inicio de la atención actual: al crear la conversación y al reabrirla. */
    attentionStartedAt: timestamp("attention_started_at", { withTimezone: true }).notNull().defaultNow(),
    /** El agente ya insistió una vez en esta atención; se limpia con cada entrante y al reabrir. */
    nudgedAt: timestamp("nudged_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    check("conversation_status_check", sql`${table.status} in ('open','closed')`),
    check(
      "conversation_close_reason_check",
      sql`${table.closeReason} is null or ${table.closeReason} in ('resuelta','sin_respuesta','equipo','manual')`,
    ),
    // Abierta: sin cierre. Cerrada: con cuándo y por qué (quién puede faltar: el agente).
    check(
      "conversation_closed_coherence_check",
      sql`(${table.status} = 'open' and ${table.closedAt} is null and ${table.closeReason} is null and ${table.closedByUserId} is null)
        or (${table.status} = 'closed' and ${table.closedAt} is not null and ${table.closeReason} is not null)`,
    ),
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
    // Dato del botón que abre «Su enlace» (su token), si la plantilla lo lleva.
    templateLink: text("template_link"),
    // Botones de respuesta que acompañan al mensaje: `id` es lo que vuelve
    // cuando la persona toca uno. Nulo si no lleva.
    replyButtons: jsonb("reply_buttons").$type<{ id: string; title: string }[]>(),
    // Enlace de baja de un correo automático (RFC 2369): el adaptador de correo
    // lo envía como cabecera `List-Unsubscribe`. Nulo en lo demás.
    listUnsubscribe: text("list_unsubscribe"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("message_conversation_external_uidx")
      .on(table.conversationId, table.externalId)
      .where(sql`"external_id" is not null`),
    index("message_conversation_created_idx").on(table.conversationId, table.createdAt),
  ],
)

/** Partes del equipo a las que puede ir una tarea sin responsable. */
export const TASK_AREAS = ["recepcion", "caja", "clinico", "administracion"] as const
export type TaskArea = (typeof TASK_AREAS)[number]

/**
 * Pendientes que deja el sistema para recepción, cada uno con su fila en «Te
 * espera»: el documento escrito en «Su enlace» ya es de otra ficha
 * (`ficha_repetida`) y quien pide volver a entrar al portal (`volver_al_portal`).
 */
export const TASK_KINDS = ["ficha_repetida", "volver_al_portal"] as const
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
    // Quién la dejó: `user`, `agent` (Recepción, en una conversación) o `admin`
    // (el Administrador, por una línea prendida).
    createdBy: text("created_by").notNull(),
    // A qué parte del equipo va cuando no tiene responsable (clave de `TASK_AREAS`).
    area: text("area"),
    // Por qué se creó, en una frase, cuando la deja el Administrador.
    reason: text("reason"),
    /**
     * Por qué se cerró sola, cuando su motivo desapareció (la cita pasó, la
     * persona confirmó, la oportunidad se cerró…): «Rosa confirmó su cita».
     * Nulo si la cerró una persona.
     */
    settledReason: text("settled_reason"),
    /** Clave estable por trigger del agente: la reentrega no duplica la tarea. */
    idempotencyKey: text("idempotency_key"),
    /**
     * Pendientes que deja el sistema con su propia fila en «Te espera»
     * (`TASK_KINDS`, ADR 0037); nulo en una tarea cualquiera.
     */
    kind: text("kind"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("task_org_id_uidx").on(table.organizationId, table.id),
    // La próxima acción de una oportunidad es una tarea, y solo una abierta.
    uniqueIndex("task_org_opp_open_uidx")
      .on(table.organizationId, table.opportunityId)
      .where(sql`"opportunity_id" IS NOT NULL AND "status" = 'open'`),
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
/**
 * Ajustes del Administrador por organización; ver `agent_config.advisor` (la
 * columna conserva el nombre que tenía cuando el agente se llamaba «Asesor»).
 * El estado de cada línea vive en `automation_rule`, no aquí.
 */
export interface AgentAdvisorSettings {
  enabled?: boolean
}

/**
 * «Horario para escribir» (decisión 18 v3, ADR 0042): por día de la semana
 * (0 = domingo), los tramos en minutos locales en que odentIA escribe por su
 * cuenta; vacío = ese día no. Se lee con la hora de cada sede.
 */
export type AgentWritingHours = Array<Array<[number, number]>>

export const agentConfig = pgTable(
  "agent_config",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organization.id),
    enabled: boolean("enabled").notNull().default(false),
    /**
     * Modelo que escribe, uno de los que odentIA validó (`AGENT_LLMS` de los
     * servicios). La cuenta del proveedor es de odentIA, nunca de la clínica.
     */
    llm: text("llm").notNull().default("chatgpt_6"),
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
    /** Administrador: si está encendido. Vacío = apagado. */
    advisor: jsonb("advisor").$type<AgentAdvisorSettings>().notNull().default(sql`'{}'::jsonb`),
    /** «Horario para escribir»: vale para todo lo que odentIA envía por su cuenta. */
    writingHours: jsonb("writing_hours")
      .$type<AgentWritingHours>()
      .notNull()
      .default(sql`'[[],[[480,1200]],[[480,1200]],[[480,1200]],[[480,1200]],[[480,1200]],[[480,840]]]'::jsonb`),
    /** Asistente clínico: dictado en la atención. Apagado hasta que la clínica lo encienda. */
    clinicalAssistantEnabled: boolean("clinical_assistant_enabled").notNull().default(false),
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
    /** Emojis en lo que escribe: `no` (se quitan antes de enviar) o `pocos` (uno como mucho, nunca en lo delicado). */
    emojis: text("emojis").notNull().default("no"),
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
    /**
     * Horas de silencio del paciente tras las que el agente cierra la
     * conversación con una despedida (ADR 0024). Tope 23: después de 24 horas
     * WhatsApp ya no deja escribir sin un mensaje aprobado.
     */
    closeAfterHours: integer("close_after_hours").notNull().default(22),
    /** Mensajes de prueba enviados desde «Probar»: solo para saber si la clínica ya lo probó. */
    sandboxTurns: integer("sandbox_turns").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("agent_config_llm_check", sql`${table.llm} in ('chatgpt_6','claude_5_5')`),
    check("agent_config_daily_run_limit_check", sql`${table.dailyRunLimit} between 1 and 100000`),
    check("agent_config_close_after_hours_check", sql`${table.closeAfterHours} between 6 and 23`),
    check(
      "agent_config_writing_hours_check",
      sql`jsonb_typeof(${table.writingHours}) = 'array' and jsonb_array_length(${table.writingHours}) = 7`,
    ),
    check(
      "agent_config_decision_provider_check",
      sql`${table.decisionProvider} in ('none','baseline','jev','openai_decisions')`,
    ),
    check("agent_config_treatment_check", sql`${table.treatment} is null or ${table.treatment} in ('tu','usted')`),
    check("agent_config_tone_check", sql`${table.tone} in ('cercano','neutro','formal')`),
    check("agent_config_emojis_check", sql`${table.emojis} in ('no','pocos')`),
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
