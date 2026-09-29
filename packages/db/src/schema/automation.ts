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
import { orgFk, timestamps } from "./crm.js"

/**
 * Automatizaciones: recordatorios de citas, seguimientos (presupuesto, cita,
 * no asistencia, inactivo, controles) y campañas segmentadas.
 *
 * - `automation_rule`: configuración por organización (qué, cuándo, por qué
 *   canal y con qué plantilla). `enabled=false` nunca programa ni envía.
 * - `automation_job`: trabajo durable en DB. Dedupe por
 *   (organization_id, dedupe_key); el worker reclama con FOR UPDATE SKIP
 *   LOCKED. Sin cron en memoria ni setTimeout.
 * - `automation_consent`: opt-in explícito por contacto, finalidad y canal.
 *   Sin fila `granted` vigente NO hay envío automático (tampoco marketing).
 * - `automation_link_token`: enlaces seguros de confirmación/cancelación/baja.
 *   Solo guarda el hash (sha256); el token crudo se entrega una vez al
 *   programar el mensaje y nunca expone el paciente.
 */

export const AUTOMATION_KINDS = [
  "recordatorio_cita",
  "seguimiento_presupuesto",
  "seguimiento_cita",
  "seguimiento_no_asistencia",
  "recuperacion_inactivo",
  "recordatorio_control",
  "campana",
] as const
export type AutomationKind = (typeof AUTOMATION_KINDS)[number]

/** Canales con adaptador registrado (whatsapp/telegram núcleo, messenger/instagram Meta). Sin SMS ni email. */
export const AUTOMATION_CHANNELS = ["whatsapp", "telegram", "messenger", "instagram"] as const
export type AutomationChannel = (typeof AUTOMATION_CHANNELS)[number]

/** Finalidades de consentimiento: el marketing exige opt-in de `marketing`. */
export const CONSENT_PURPOSES = ["recordatorio", "seguimiento", "marketing"] as const
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number]

export const AUTOMATION_JOB_STATUSES = [
  "pendiente",
  "enviado",
  "fallido",
  "cancelado",
  "omitido",
] as const
export type AutomationJobStatus = (typeof AUTOMATION_JOB_STATUSES)[number]

export const automationRule = pgTable(
  "automation_rule",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    channel: text("channel").notNull().default("whatsapp"),
    enabled: boolean("enabled").notNull().default(true),
    /** Plantilla del canal (nombre/idioma aprobados por el proveedor). */
    templateName: text("template_name"),
    templateLanguage: text("template_language").notNull().default("es_PE"),
    /**
     * Configuración por kind:
     * - recordatorio_cita: { hoursBefore: number[], quietStart, quietEnd }
     * - seguimiento_*: { delayHours, quietStart, quietEnd, segment? }
     * - campana: { segment: { tags?, opportunityStageIds?, inactiveDays? }, quietStart, quietEnd }
     * Horas locales de la sucursal/organización; quiet* "HH:MM".
     */
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    createdBy: text("created_by"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("automation_rule_org_id_uidx").on(table.organizationId, table.id),
    index("automation_rule_org_kind_idx").on(table.organizationId, table.kind),
  ],
)

export const automationJob = pgTable(
  "automation_job",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    ruleId: uuid("rule_id").references(() => automationRule.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    channel: text("channel").notNull().default("whatsapp"),
    status: text("status").notNull().default("pendiente"),
    /** Dedupe: p.ej. `recordatorio_cita:<appointmentId>:<hoursBefore>`. */
    dedupeKey: text("dedupe_key").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    contactId: uuid("contact_id"),
    appointmentId: uuid("appointment_id"),
    patientId: uuid("patient_id"),
    budgetId: uuid("budget_id"),
    /** Oportunidad origen (segmentos de campaña y cierres); sin FK para no acoplar migraciones. */
    opportunityId: uuid("opportunity_id"),
    /** Snapshot del texto/plantilla resuelto al programar (trazabilidad). */
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    sentMessageId: uuid("sent_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("automation_job_org_dedupe_uidx").on(table.organizationId, table.dedupeKey),
    index("automation_job_org_status_scheduled_idx").on(
      table.organizationId,
      table.status,
      table.scheduledFor,
    ),
    index("automation_job_org_appointment_idx").on(table.organizationId, table.appointmentId),
    index("automation_job_org_contact_idx").on(table.organizationId, table.contactId),
    index("automation_job_org_opportunity_idx").on(table.organizationId, table.opportunityId),
  ],
)

export const automationConsent = pgTable(
  "automation_consent",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    contactId: uuid("contact_id").notNull(),
    purpose: text("purpose").notNull(),
    channel: text("channel").notNull(),
    /** granted | revoked: solo `granted` habilita el envío automático. */
    status: text("status").notNull().default("granted"),
    /** Evidencia del opt-in: origen (recepción, enlace, campaña) y actor. */
    source: text("source").notNull().default("recepcion"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("automation_consent_org_contact_purpose_channel_uidx").on(
      table.organizationId,
      table.contactId,
      table.purpose,
      table.channel,
    ),
    index("automation_consent_org_contact_idx").on(table.organizationId, table.contactId),
  ],
)

export const automationLinkToken = pgTable(
  "automation_link_token",
  {
    /** Hash sha256 hex del token crudo (el crudo nunca se persiste). */
    tokenHash: text("token_hash").primaryKey(),
    organizationId: orgFk("organization_id"),
    /** confirm | cancel (cita) | baja (unsuscribe de todos los envíos) */
    purpose: text("purpose").notNull(),
    jobId: uuid("job_id").references(() => automationJob.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id"),
    contactId: uuid("contact_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("automation_link_token_org_expires_idx").on(table.organizationId, table.expiresAt)],
)
