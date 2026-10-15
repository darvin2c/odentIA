import { sql } from "drizzle-orm"
import {
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { user } from "./auth.js"
import { patient, serviceCatalog, treatmentBudget } from "./clinical.js"
import { contact, conversation, orgFk, pipeline, pipelineStage, timestamps } from "./crm.js"

/**
 * Oportunidad comercial del CRM: un interés concreto de una persona (un
 * precio, un tratamiento, una evaluación), la tarjeta del tablero.
 *
 * Una persona (contacto) puede tener VARIAS oportunidades abiertas a la vez
 * (p. ej. ortodoncia + limpieza); por eso el tablero NO son los contactos.
 * Avanza por cuatro pasos fijos (`pipeline_stage.moment`) y su próxima acción
 * es su tarea abierta (una sola), no un campo propio.
 *
 * Dinero sin floats: `amountCents` entero >= 0 con `currency` ISO-3.
 * `status` es `open` en los tres primeros pasos y `won`/`lost` en «Decidió».
 */
export const OPPORTUNITY_STATUSES = ["open", "won", "lost"] as const
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number]

/**
 * Motivos de cierre, de una lista. Los cinco primeros de perder los elige una
 * persona o el agente; «Rechazó el presupuesto» y «Aceptó el presupuesto» los
 * pone el sistema cuando la persona decide su presupuesto.
 */
export const OPPORTUNITY_LOST_REASONS = ["precio", "otra_clinica", "no_responde", "no_lo_necesita", "otro", "rechazo_presupuesto"] as const
export const OPPORTUNITY_WON_REASONS = ["acepto", "acepto_presupuesto"] as const
export type OpportunityCloseReason =
  | (typeof OPPORTUNITY_LOST_REASONS)[number]
  | (typeof OPPORTUNITY_WON_REASONS)[number]

/** Quién hizo un movimiento: una persona del equipo, el agente o el sistema por algo que pasó. */
export const OPPORTUNITY_EVENT_ORIGINS = ["persona", "agente", "automatico"] as const
export type OpportunityEventOrigin = (typeof OPPORTUNITY_EVENT_ORIGINS)[number]

export const opportunity = pgTable(
  "opportunity",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    // Interlocutor dueño de la negociación (obligatorio, varias por contacto).
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id, { onDelete: "cascade" }),
    // Paciente relacionado explícito (quien recibiría el tratamiento).
    patientId: uuid("patient_id").references(() => patient.id, { onDelete: "set null" }),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipeline.id),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => pipelineStage.id),
    title: text("title").notNull(),
    // Interés o servicio de catálogo que motiva la oportunidad.
    serviceId: uuid("service_id").references(() => serviceCatalog.id, {
      onDelete: "set null",
    }),
    interestText: text("interest_text"),
    // Valor estimado en moneda (entero de céntimos, nunca float).
    amountCents: integer("amount_cents"),
    // ISO 4217, siempre explícita: sin moneda por defecto de ningún país.
    currency: char("currency", { length: 3 }).notNull(),
    // Sin responsable, la oportunidad es de Recepción hasta que alguien la toma.
    assignedUserId: text("assigned_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** Clave del motivo (`OPPORTUNITY_LOST_REASONS` / `OPPORTUNITY_WON_REASONS`). */
    closeReason: text("close_reason"),
    /** Lo que se añadió al motivo, en palabras de quien cerró (opcional). */
    closeNote: text("close_note"),
    // Hilo origen de la negociación (conversación del mismo contacto).
    conversationId: uuid("conversation_id").references(() => conversation.id, {
      onDelete: "set null",
    }),
    // Presupuesto clínico vinculado (evidencia económica, no duplica cifras).
    budgetId: uuid("budget_id").references(() => treatmentBudget.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("opportunity_org_id_uidx").on(table.organizationId, table.id),
    index("opportunity_org_contact_idx").on(table.organizationId, table.contactId),
    index("opportunity_org_patient_idx").on(table.organizationId, table.patientId),
    index("opportunity_org_stage_idx").on(table.organizationId, table.stageId),
    index("opportunity_org_status_idx").on(table.organizationId, table.status),
    index("opportunity_org_assigned_idx").on(table.organizationId, table.assignedUserId),
    index("opportunity_org_conversation_idx").on(table.organizationId, table.conversationId),
    check(
      "opportunity_close_reason_check",
      sql`${table.closeReason} IS NULL OR ${table.closeReason} IN ('precio','otra_clinica','no_responde','no_lo_necesita','otro','rechazo_presupuesto','acepto','acepto_presupuesto')`,
    ),
  ],
)

/**
 * Historial de la oportunidad (de qué paso a cuál, cierres y reaperturas) con
 * quién lo hizo (`origin`) y, cuando pasó sola, por qué (`cause`, `causeAt`):
 * «Pasó sola: agendó su evaluación para el jue 17».
 */
export const opportunityEvent = pgTable(
  "opportunity_event",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunity.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    fromStageId: uuid("from_stage_id").references(() => pipelineStage.id, {
      onDelete: "set null",
    }),
    toStageId: uuid("to_stage_id").references(() => pipelineStage.id, {
      onDelete: "set null",
    }),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** `persona`, `agente` o `automatico` (`OPPORTUNITY_EVENT_ORIGINS`). */
    origin: text("origin").notNull().default("persona"),
    /**
     * Lo que pasó de verdad cuando avanzó sola: `cita_agendada`,
     * `presupuesto_presentado`, `presupuesto_aceptado`, `presupuesto_rechazado`.
     */
    cause: text("cause"),
    /** Cuándo es lo que la movió (la cita), para decirlo con su fecha. */
    causeAt: timestamp("cause_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("opportunity_event_org_opp_idx").on(table.organizationId, table.opportunityId),
    check("opportunity_event_origin_check", sql`${table.origin} IN ('persona','agente','automatico')`),
  ],
)
