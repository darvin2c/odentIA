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
 * Lo que el agente Administrador hace por su cuenta cuando una persona lo
 * prende: ocho líneas, cada una con su estado por organización.
 *
 * - `automation_rule`: el estado de una línea (una fila por organización y
 *   línea): prendida o apagada, desde cuándo, y cuál de sus dos partes va («el
 *   agente le escribe», «tarea para el equipo»). Apagada nunca programa ni envía.
 * - `automation_job`: un caso de una línea (una persona, una cita, un
 *   presupuesto…) con lo que pasó: mensaje enviado, tarea dejada o por qué no
 *   se pudo. Dedupe por (organization_id, dedupe_key); el worker reclama con
 *   FOR UPDATE SKIP LOCKED. Sin cron en memoria ni setTimeout.
 * - `automation_consent`: lo que cada persona aceptó recibir sin haber escrito
 *   primero. Sin fila `granted` no hay mensaje automático.
 * - `automation_link_token`: enlaces seguros de confirmación/cancelación/baja.
 *   Solo guarda el hash (sha256); el token crudo viaja una vez, en el correo.
 */

/**
 * Las líneas. Las ocho primeras vienen armadas: cinco escriben a la persona
 * (el agente Recepción) y tres dejan trabajo a una persona del equipo. Las
 * de `CUSTOM_AUTOMATION_KINDS` son piezas que el sistema también sabe hacer y
 * que solo existen en una clínica cuando ella las crea pidiéndoselas al
 * Administrador.
 */
export const CUSTOM_AUTOMATION_KINDS = ["cita_cancelada"] as const

export const AUTOMATION_KINDS = [
  "recordatorio_cita",
  "recordatorio_control",
  "seguimiento_presupuesto",
  "seguimiento_comercial",
  "seguimiento_no_asistencia",
  "presupuestos_sin_cita",
  "atenciones_sin_firmar",
  "cobranza_vencida",
  ...CUSTOM_AUTOMATION_KINDS,
] as const
export type AutomationKind = (typeof AUTOMATION_KINDS)[number]

/**
 * Canales por los que sale un mensaje automático. El canal se decide por
 * persona al entregar (WhatsApp primero, correo de respaldo); el de la regla es
 * solo el preferido.
 */
export const AUTOMATION_CHANNELS = ["whatsapp", "telegram", "messenger", "instagram", "email"] as const
export type AutomationChannel = (typeof AUTOMATION_CHANNELS)[number]

/**
 * Qué aceptó recibir una persona sin haber escrito primero: `recordatorio`
 * (citas y controles) y `seguimiento` (inasistencias, presupuestos y oportunidades). Es un
 * permiso de la persona, no de un canal.
 */
export const CONSENT_PURPOSES = ["recordatorio", "seguimiento"] as const
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number]

/** Por dónde salió un mensaje automático. */
export const AUTOMATION_VIAS = ["respuesta", "plantilla", "correo"] as const
export type AutomationVia = (typeof AUTOMATION_VIAS)[number]

export const AUTOMATION_JOB_STATUSES = [
  "pendiente",
  "enviado",
  /** Quedó como tarea para una persona, sin mensaje. */
  "tarea",
  "fallido",
  "cancelado",
  "omitido",
] as const
export type AutomationJobStatus = (typeof AUTOMATION_JOB_STATUSES)[number]

/**
 * Motivos por los que un trabajo no llega a la persona. Cada uno tiene una
 * corrección distinta, y el aviso al equipo se agrupa por motivo.
 */
export const AUTOMATION_CAUSES = [
  /** La persona no aceptó ese tipo de mensaje. */
  "sin_permiso",
  /** No tiene WhatsApp ni correo registrados. */
  "sin_destino",
  /** Su correo ya tiene un hilo con otra persona de la clínica: hay que resolverlo a mano. */
  "correo_ajeno",
  /** La clínica no tiene un canal conectado por el que llegarle. */
  "sin_conexion",
  /** No escribió hace poco y WhatsApp aún no aprueba el mensaje. */
  "sin_plantilla",
  /** El canal aceptó el mensaje y después no lo entregó. */
  "no_entregado",
  /** El envío falló en el proveedor. */
  "proveedor",
] as const
export type AutomationCause = (typeof AUTOMATION_CAUSES)[number]

/** Pedido pendiente de decisión sobre una línea. */
export interface AutomationDraft {
  /** Lo que la persona escribió. */
  request: string
  /** El cambio que quedaría, en los mismos campos que una línea se ajusta. */
  changes: {
    enabled?: boolean
    agentPart?: boolean
    teamPart?: boolean
    days?: number
    hoursBefore?: number[]
    delayHours?: number
    hour?: number
    taskNote?: string
  }
  /** Lo que pidió y no se puede, con el motivo. */
  unsupported: string[]
  /** La línea no existía: descartar el borrador la quita. */
  creates: boolean
  by: string
  at: string
}

export const automationRule = pgTable(
  "automation_rule",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Las dos partes de una línea; apagar las dos es apagar la línea. */
    agentPart: boolean("agent_part").notNull().default(true),
    teamPart: boolean("team_part").notNull().default(true),
    /** «No recomendarla más»: sigue en la lista, pero no sale en Inicio. */
    noRecommend: boolean("no_recommend").notNull().default(false),
    /**
     * Desde cuándo está prendida (se fija en cada apagado→prendido). La regla
     * solo actúa sobre lo ocurrido después: prender nunca escribe por algo anterior.
     */
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
    /** Quién la prendió la última vez. */
    enabledBy: text("enabled_by"),
    /**
     * Lo que se puede ajustar de la línea: `days` (el plazo, en las que lo
     * tienen), `hoursBefore` (cuánto antes se recuerda una cita), `delayHours`
     * (las que esperan horas), `hour` (a qué hora del día sale) y `taskNote`
     * (una indicación de la clínica para quien reciba la tarea).
     */
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    /**
     * Un pedido hecho con palabras que todavía nadie decidió: lo que se pidió y
     * el cambio que quedaría. No hace nada hasta que una persona lo prende o lo
     * guarda; mientras tanto la línea sigue como estaba.
     */
    draft: jsonb("draft").$type<AutomationDraft>(),
    createdBy: text("created_by"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("automation_rule_org_id_uidx").on(table.organizationId, table.id),
    uniqueIndex("automation_rule_org_kind_uidx").on(table.organizationId, table.kind),
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
    /** Oportunidad del caso (seguimiento sin responsable); sin FK para no acoplar migraciones. */
    opportunityId: uuid("opportunity_id"),
    /** Tarea que quedó para una persona: el caso entero, o el respaldo si el agente no pudo escribir. */
    taskId: uuid("task_id"),
    /** Lo que el caso necesita recordar hasta que se atiende (zona de la sede, control, «solo esta vez»). */
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /**
     * Por qué no se pudo (clave de `AUTOMATION_CAUSES`), para avisar una vez por
     * causa y no una por mensaje. Nulo si se envió o si aún no se intenta.
     */
    cause: text("cause"),
    /** Por dónde salió (clave de `AUTOMATION_VIAS`); nulo mientras no sale. */
    via: text("via"),
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
    index("automation_job_org_message_idx").on(table.organizationId, table.sentMessageId),
  ],
)

export const automationConsent = pgTable(
  "automation_consent",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    contactId: uuid("contact_id").notNull(),
    purpose: text("purpose").notNull(),
    /** granted | revoked: solo `granted` habilita el envío automático. */
    status: text("status").notNull().default("granted"),
    /**
     * Cómo se supo (clave de `CONSENT_SOURCES`): al registrarse, en persona, por
     * la conversación, por su baja… La pantalla lo dice con la fecha.
     */
    source: text("source").notNull().default("presencial"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("automation_consent_org_contact_purpose_uidx").on(
      table.organizationId,
      table.contactId,
      table.purpose,
    ),
    index("automation_consent_org_contact_idx").on(table.organizationId, table.contactId),
  ],
)

/** Cómo quedó registrado un permiso de mensajes. */
export const CONSENT_SOURCES = [
  "registro",
  "presencial",
  "conversacion",
  "portal",
  "baja",
  "revocacion_datos",
] as const
export type ConsentSource = (typeof CONSENT_SOURCES)[number]

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
