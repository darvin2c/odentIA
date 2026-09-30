import { sql } from "drizzle-orm"
import {
  char,
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
 * Oportunidad comercial del CRM: la tarjeta real del embudo.
 *
 * Una persona (contacto) puede tener VARIAS oportunidades abiertas a la vez
 * (p. ej. ortodoncia + limpieza); por eso el embudo NO son los contactos.
 * `contact.stageId` se conserva solo como compatibilidad legacy (primera
 * etapa al crear el contacto) y ya no representa el pipeline.
 *
 * Dinero sin floats: `amountCents` entero >= 0 con `currency` ISO-3.
 * `status` se sincroniza con el `kind` de la etapa al mover/cerrar.
 */
export const OPPORTUNITY_STATUSES = ["open", "won", "lost"] as const
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number]

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
    currency: char("currency", { length: 3 }).notNull().default("PEN"),
    assignedUserId: text("assigned_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    nextActionNote: text("next_action_note"),
    status: text("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"),
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
    index("opportunity_org_next_action_idx").on(table.organizationId, table.nextActionAt),
    index("opportunity_org_conversation_idx").on(table.organizationId, table.conversationId),
  ],
)

/**
 * Historial de movimientos de la oportunidad (quién la movió, de qué etapa
 * a cuál, cierres y reaperturas). Lo lee el detalle y lo puede suscribir
 * Automatizaciones para disparadores por cambio de estado.
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
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("opportunity_event_org_opp_idx").on(table.organizationId, table.opportunityId),
  ],
)
