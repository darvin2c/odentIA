import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { organization } from "./auth.js"
import { contact, conversation, orgFk } from "./crm.js"
import { branch } from "./org.js"

/** Tipos de conocimiento que el agente puede citar (FAQs versionadas e info de sede/política). */
export const KNOWLEDGE_KINDS = ["faq", "info_sede", "politica"] as const
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]

export const KNOWLEDGE_STATUSES = ["borrador", "publicada"] as const
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number]

/**
 * Entradas de conocimiento de la clínica. Solo las `publicada` alimentan el
 * prompt del agente; cada edición versiona (ver agentKnowledgeRevision).
 */
export const agentKnowledgeEntry = pgTable(
  "agent_knowledge_entry",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    branchId: uuid("branch_id").references(() => branch.id),
    status: text("status").notNull().default("borrador"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_knowledge_entry_org_idx").on(table.organizationId, table.status, table.kind),
    check("agent_knowledge_entry_kind_check", sql`${table.kind} in ('faq','info_sede','politica')`),
    check("agent_knowledge_entry_status_check", sql`${table.status} in ('borrador','publicada')`),
    check("agent_knowledge_entry_version_check", sql`${table.version} >= 1`),
  ],
)

/** Historial append-only de versiones de cada entrada (audita qué respondió el agente). */
export const agentKnowledgeRevision = pgTable(
  "agent_knowledge_revision",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => agentKnowledgeEntry.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_knowledge_revision_entry_idx").on(table.entryId, table.version),
    uniqueIndex("agent_knowledge_revision_entry_version_uidx").on(table.entryId, table.version),
  ],
)

export const AUTONOMY_ACTIONS = [
  "reservar_cita",
  "reprogramar_cita",
  "cancelar_cita",
  "enviar_mensaje",
  "mover_oportunidad",
] as const
export type AutonomyAction = (typeof AUTONOMY_ACTIONS)[number]

export const AUTONOMY_MODES = ["directo", "confirmar_usuario", "aprobar_equipo"] as const
export type AutonomyMode = (typeof AUTONOMY_MODES)[number]

export const agentPolicy = pgTable("agent_policy", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id),
  modes: jsonb("modes").$type<Partial<Record<AutonomyAction, AutonomyMode>>>().notNull().default({}),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
})

export const PROPOSAL_ACTIONS = [
  "reservar_cita",
  "reprogramar_cita",
  "cancelar_cita",
] as const
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number]

export const PROPOSAL_STATUSES = [
  "propuesta",
  "aprobada",
  "rechazada",
  "ejecutada",
  "fallida",
  "expirada",
] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

/**
 * Propuestas de actos del agente. La ejecución es idempotente por
 * (organización, idempotencyKey): aprobar dos veces no ejecuta dos veces.
 */
export const agentProposal = pgTable(
  "agent_proposal",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    conversationId: uuid("conversation_id").references(() => conversation.id),
    contactId: uuid("contact_id").references(() => contact.id),
    action: text("action").notNull(),
    status: text("status").notNull().default("propuesta"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    reason: text("reason"),
    idempotencyKey: text("idempotency_key").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    proposedBy: text("proposed_by").notNull().default("agent"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_proposal_org_idx").on(table.organizationId, table.status, table.createdAt),
    index("agent_proposal_conversation_idx").on(table.conversationId),
    uniqueIndex("agent_proposal_org_key_uidx").on(table.organizationId, table.idempotencyKey),
    check(
      "agent_proposal_action_check",
      sql`${table.action} in ('reservar_cita','reprogramar_cita','cancelar_cita')`,
    ),
    check(
      "agent_proposal_status_check",
      sql`${table.status} in ('propuesta','aprobada','rechazada','ejecutada','fallida','expirada')`,
    ),
  ],
)

export const HANDOFF_PRIORITIES = ["alta", "media", "baja"] as const
export type HandoffPriority = (typeof HANDOFF_PRIORITIES)[number]

/**
 * Derivaciones a humano con resumen factual, motivo, prioridad, responsable y
 * tarea de seguimiento (la tarea vive en `task`).
 */
export const agentHandoff = pgTable(
  "agent_handoff",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    conversationId: uuid("conversation_id").references(() => conversation.id),
    contactId: uuid("contact_id").references(() => contact.id),
    reason: text("reason").notNull(),
    summary: text("summary").notNull(),
    priority: text("priority").notNull().default("media"),
    assigneeUserId: text("assignee_user_id"),
    taskId: uuid("task_id"),
    createdBy: text("created_by").notNull().default("agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_handoff_org_idx").on(table.organizationId, table.createdAt),
    index("agent_handoff_conversation_idx").on(table.conversationId),
    check("agent_handoff_priority_check", sql`${table.priority} in ('alta','media','baja')`),
  ],
)

export const AGENT_RUN_STATUSES = ["ok", "handoff", "error", "omitida"] as const
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number]

/**
 * Libro de corridas reales del agente (supervisión). Tokens y coste solo se
 * registran si el proveedor los entrega; coste en micro-unidades enteras.
 */
export const agentRunLedger = pgTable(
  "agent_run_ledger",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    conversationId: uuid("conversation_id").references(() => conversation.id),
    triggerMessageId: uuid("trigger_message_id"),
    model: text("model").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicros: integer("cost_micros"),
    toolsUsed: text("tools_used").array().notNull().default(sql`'{}'`),
    error: text("error"),
  },
  (table) => [
    index("agent_run_ledger_org_idx").on(table.organizationId, table.startedAt),
    index("agent_run_ledger_conversation_idx").on(table.conversationId),
    check(
      "agent_run_ledger_status_check",
      sql`${table.status} in ('ok','handoff','error','omitida')`,
    ),
  ],
)

/** El agente nunca lee historia clínica completa: solo este contexto mínimo verificado. */
export interface AgentPatientContext {
  patientId: string
  patientNumber: number | null
  displayName: string
  /** Vínculo paciente↔interlocutor verificado (patient_contact). */
  relationship: string
  /** Autorización del interlocutor: self | representante_legal | autorizado_informacion. */
  authorization: "self" | "representante_legal" | "autorizado_informacion"
}

export const DEFAULT_AUTONOMY_MODES: Record<AutonomyAction, AutonomyMode> = {
  reservar_cita: "confirmar_usuario",
  reprogramar_cita: "confirmar_usuario",
  cancelar_cita: "aprobar_equipo",
  enviar_mensaje: "directo",
  mover_oportunidad: "directo",
}
