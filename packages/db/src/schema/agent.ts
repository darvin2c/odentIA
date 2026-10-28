import { sql } from "drizzle-orm"
import {
  bigint,
  check,
  customType,
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
import { contact, conversation, message, orgFk } from "./crm.js"
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
    /**
     * Vigencia en fechas de la clínica (inclusive). Fuera de ella la respuesta
     * no llega al agente aunque siga publicada: una promoción vencida deja de
     * usarse sola.
     */
    validFrom: date("valid_from"),
    validUntil: date("valid_until"),
    /** Otras formas en que la gente pregunta lo mismo; ayudan a encontrarla. */
    askForms: text("ask_forms").array().notNull().default(sql`'{}'`),
    /** Pregunta de «lo básico de una clínica» que esta respuesta cubre. */
    basicKey: text("basic_key"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_knowledge_entry_org_idx").on(table.organizationId, table.status, table.kind),
    check(
      "agent_knowledge_entry_validity_check",
      sql`${table.validFrom} is null or ${table.validUntil} is null or ${table.validUntil} >= ${table.validFrom}`,
    ),
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

export const KNOWLEDGE_GAP_STATUSES = ["abierta", "resuelta", "descartada"] as const
export type KnowledgeGapStatus = (typeof KNOWLEDGE_GAP_STATUSES)[number]

/**
 * Lo que el agente no supo responder: buscó en el conocimiento y no encontró
 * nada. Queda abierto hasta que alguien lo convierte en respuesta oficial, lo
 * enlaza a una que ya existía o lo descarta.
 */
export const agentKnowledgeGap = pgTable(
  "agent_knowledge_gap",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id),
    triggerMessageId: uuid("trigger_message_id"),
    agent: text("agent").notNull().default("recepcion"),
    /** Lo que escribió el interlocutor. */
    question: text("question").notNull(),
    /** Lo que el agente buscó sin resultado. */
    query: text("query").notNull(),
    status: text("status").notNull().default("abierta"),
    resolvedEntryId: uuid("resolved_entry_id").references(() => agentKnowledgeEntry.id),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_knowledge_gap_org_idx").on(table.organizationId, table.status, table.createdAt),
    index("agent_knowledge_gap_conversation_idx").on(table.conversationId),
    check("agent_knowledge_gap_status_check", sql`${table.status} in ('abierta','resuelta','descartada')`),
  ],
)

export const AUTONOMY_ACTIONS = [
  "reservar_cita",
  "reprogramar_cita",
  "cancelar_cita",
  "enviar_mensaje",
  "mover_oportunidad",
  "crear_oportunidad",
  "actualizar_seguimiento",
  "cerrar_oportunidad",
  "decidir_presupuesto",
] as const
export type AutonomyAction = (typeof AUTONOMY_ACTIONS)[number]

/** Quién dice que sí: nadie (va directo) o el interlocutor en el hilo. Ningún acto espera al equipo (ADR 0023). */
export const AUTONOMY_MODES = ["directo", "confirmar_usuario"] as const
export type AutonomyMode = (typeof AUTONOMY_MODES)[number]

export const PROPOSAL_ACTIONS = [
  "reservar_cita",
  "reprogramar_cita",
  "cancelar_cita",
  "enviar_mensaje",
  "mover_oportunidad",
  "crear_oportunidad",
  "actualizar_seguimiento",
  "cerrar_oportunidad",
  // La respuesta de la persona a su presupuesto, anotada con su sí (fase 3, decisión 5).
  "decidir_presupuesto",
] as const
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number]

/**
 * `aprobada` es el paso entre el sí (del interlocutor, o el directo) y la
 * ejecución. Nadie rechaza una propuesta: la que nadie confirma, expira.
 */
export const PROPOSAL_STATUSES = [
  "propuesta",
  "aprobada",
  "ejecutada",
  "fallida",
  "expirada",
] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

/**
 * Propuestas de actos del agente, siempre en una conversación: el agente no
 * abre hilos por su cuenta (ADR 0023). La ejecución es idempotente por
 * (organización, idempotencyKey): aprobar dos veces no ejecuta dos veces.
 */
export const agentProposal = pgTable(
  "agent_proposal",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id),
    contactId: uuid("contact_id").references(() => contact.id),
    /**
     * Paciente sobre el que actúa la propuesta (nulo en actos comerciales sin
     * ficha). Columna propia para listarlas en la ficha; la FK compuesta por
     * organización vive en la migración (evita el ciclo con clinical.ts).
     */
    patientId: uuid("patient_id"),
    action: text("action").notNull(),
    status: text("status").notNull().default("propuesta"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    reason: text("reason"),
    /** Evidencia de lo aprobado: estado previo al acto (nulo si no aplica). */
    beforeSummary: text("before_summary"),
    /** Evidencia de lo aprobado: cambio previsto/ejecutado (nunca nulo en lectura). */
    afterSummary: text("after_summary"),
    /**
     * Estado vivo congelado al crear para el control de obsolescencia al
     * ejecutar (etapa/versión de oportunidad o cita). Nulo si el acto no pisa
     * estado previo o si el legado no lo trae (entonces nunca es stale).
     */
    expectedState: jsonb("expected_state").$type<Record<string, unknown>>(),
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
    index("agent_proposal_org_patient_idx").on(table.organizationId, table.patientId, table.status),
    uniqueIndex("agent_proposal_org_key_uidx").on(table.organizationId, table.idempotencyKey),
    check(
      "agent_proposal_action_check",
      sql`${table.action} in ('reservar_cita','reprogramar_cita','cancelar_cita','enviar_mensaje','mover_oportunidad','crear_oportunidad','actualizar_seguimiento','cerrar_oportunidad','decidir_presupuesto')`,
    ),
    check(
      "agent_proposal_status_check",
      sql`${table.status} in ('propuesta','aprobada','ejecutada','fallida','expirada')`,
    ),
  ],
)

export const HANDOFF_PRIORITIES = ["alta", "media", "baja"] as const
export type HandoffPriority = (typeof HANDOFF_PRIORITIES)[number]

/**
 * Temas para el equipo (ADR 0050): lo que el agente no puede responder, o lo
 * que una persona del equipo atiende, con resumen factual, motivo, prioridad,
 * responsable y tarea de seguimiento (la tarea vive en `task` y da el estado y
 * el plazo). Un tema abierto no apaga al agente: el agente sigue con lo demás.
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
    /** Qué pide la persona, en una frase, cuando quien deriva lo deja escrito. */
    asks: text("asks"),
    /** Lo que aún no se le preguntó o falta hacer para atenderla. */
    pending: text("pending"),
    /** El aviso que recibió la persona al pasar su caso. */
    notice: text("notice"),
    assigneeUserId: text("assignee_user_id"),
    taskId: uuid("task_id"),
    createdBy: text("created_by").notNull().default("agent"),
    /** El mensaje de la persona que originó el tema: se cita al responder. */
    sourceMessageId: uuid("source_message_id"),
    /** Mensajes en que la persona volvió a preguntar por el tema. */
    askedMessageIds: jsonb("asked_message_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Última vez que la persona volvió a preguntar por el tema. */
    askedAgainAt: timestamp("asked_again_at", { withTimezone: true }),
    /**
     * De qué trata, para saber a quién le llega (R3 de la Bandeja): una cita,
     * un precio, una duda clínica (al odontólogo que la atiende), un pago (a
     * caja) u otra cosa (a recepción). También dice qué puede retomar Sofi.
     */
    kind: text("kind").notNull().default("otro"),
    /**
     * Cuándo pasa a «Ahora»: dos horas de clínica abierta desde que espera una
     * respuesta del equipo (decisión 1 del pulido). Vuelve a contar si el equipo
     * responde con «Enviar, sigue pendiente». Una sola regla para la Bandeja,
     * Inicio y el panel del agente.
     */
    urgentAt: timestamp("urgent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.conversationId, table.sourceMessageId],
      foreignColumns: [message.conversationId, message.id],
    }),
    index("agent_handoff_org_idx").on(table.organizationId, table.createdAt),
    index("agent_handoff_conversation_idx").on(table.conversationId),
    check("agent_handoff_priority_check", sql`${table.priority} in ('alta','media','baja')`),
    check("agent_handoff_kind_check", sql`${table.kind} in ('cita','precio','clinico','pago','otro')`),
  ],
)

/**
 * `sin_respuesta`: la corrida por mensaje entrante terminó sin enviar ni
 * proponer una respuesta y sin derivar; no es una ejecución correcta.
 */
export const AGENT_RUN_STATUSES = ["ok", "handoff", "error", "omitida", "sin_respuesta"] as const
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number]

/**
 * Libro de corridas reales del agente (supervisión). Tokens y coste solo se
 * registran si el proveedor los entrega; coste en micro-unidades enteras.
 * `llm_calls` cuenta las llamadas al modelo de la corrida, lo reporte o no.
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
    /** Parte de `input_tokens` servida desde la caché del proveedor. */
    cachedInputTokens: integer("cached_input_tokens"),
    /** Parte de `input_tokens` que se escribió en la caché (el proveedor la cobra aparte). */
    cacheWriteTokens: integer("cache_write_tokens"),
    llmCalls: integer("llm_calls"),
    /** Millonésimas de USD: la suma de las filas de `ai_usage` de la corrida. */
    costMicros: integer("cost_micros"),
    toolsUsed: text("tools_used").array().notNull().default(sql`'{}'`),
    error: text("error"),
  },
  (table) => [
    index("agent_run_ledger_org_idx").on(table.organizationId, table.startedAt),
    index("agent_run_ledger_conversation_idx").on(table.conversationId),
    check(
      "agent_run_ledger_status_check",
      sql`${table.status} in ('ok','handoff','error','omitida','sin_respuesta')`,
    ),
  ],
)

/**
 * De dónde sale un uso de IA (ADR 0031). `recepcion` son las corridas reales;
 * `probar`, `simulacion` y `vista_previa`, las pruebas desde la plataforma;
 * `practica_dictado`, el dictado de práctica; `administrador`, lo que se le
 * pide con palabras; `ya_aviso`, la comprobación antes de un seguimiento;
 * `vectores`, el índice de la búsqueda por significado; `comprobacion`, la
 * llamada mínima que dice si el modelo responde; `reportes`, lo que se le
 * pregunta a Argos sobre las cifras de Reportes.
 */
export const AI_USAGE_ORIGINS = [
  "recepcion",
  "probar",
  "simulacion",
  "vista_previa",
  "dictado",
  "practica_dictado",
  "administrador",
  "ya_aviso",
  "vectores",
  "transcripcion",
  "comprobacion",
  "reportes",
] as const
export type AiUsageOrigin = (typeof AI_USAGE_ORIGINS)[number]

/**
 * Uso de IA por organización y origen (append-only): una fila por proveedor y
 * modelo de cada operación, con lo que el proveedor reportó. Los tokens son
 * null si el proveedor no los entregó; el costo, en millonésimas de USD, es
 * null si además no hay precio conocido para ese modelo: nunca se estima.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    origin: text("origin").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    calls: integer("calls").notNull().default(1),
    /** Entrada total, incluida la servida o escrita en caché. */
    inputTokens: integer("input_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    outputTokens: integer("output_tokens"),
    audioSeconds: integer("audio_seconds"),
    costMicros: bigint("cost_micros", { mode: "number" }),
    conversationId: uuid("conversation_id"),
    /**
     * A qué acción pertenece el gasto, para ver lo que costó cada cosa (ADR
     * 0085): la atención de un dictado, la pregunta a Argos. Null si no se sabe.
     */
    encounterId: uuid("encounter_id"),
    reportQuestionId: uuid("report_question_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ai_usage_org_idx").on(table.organizationId, table.createdAt),
    check(
      "ai_usage_origin_check",
      sql`${table.origin} in ('recepcion','probar','simulacion','vista_previa','dictado','practica_dictado','administrador','ya_aviso','vectores','transcripcion','comprobacion','reportes')`,
    ),
    check("ai_usage_calls_check", sql`${table.calls} >= 1`),
    check("ai_usage_cost_check", sql`${table.costMicros} is null or ${table.costMicros} >= 0`),
  ],
)

/**
 * `shadow`: solo se registra y se compara. `retrieval`: el modelo de decisión
 * elige qué conocimiento llega al turno. `route`: elige el camino del turno
 * antes de llamar al modelo que escribe y, si está seguro de que hace falta
 * una persona, pasa el caso sin llamarlo.
 */
export const DECISION_MODES = ["shadow", "retrieval", "route"] as const
export type DecisionMode = (typeof DECISION_MODES)[number]

/**
 * Libro de decisiones del modelo de decisión (append-only). Guarda ids,
 * huella del estado, pregunta versionada y respuestas con probabilidades;
 * nunca el texto del interlocutor. En modo `shadow` no tiene efecto sobre la
 * corrida: solo se compara.
 */
export const agentDecisionLog = pgTable(
  "agent_decision_log",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    conversationId: uuid("conversation_id"),
    triggerMessageId: uuid("trigger_message_id"),
    /** Punto de decisión y versión de sus preguntas (p. ej. triage.v2). */
    point: text("point").notNull(),
    mode: text("mode").notNull().default("shadow"),
    provider: text("provider").notNull(),
    /** Identificador versionado que reportó el proveedor. */
    model: text("model"),
    /** SHA-256 del estado enviado, para correlacionar sin guardar el texto. */
    stateHash: text("state_hash").notNull(),
    stateChars: integer("state_chars").notNull(),
    answers: jsonb("answers").$type<unknown[]>().notNull(),
    /** Qué habría hecho cada punto con los umbrales ilustrativos; solo informativo. */
    outcome: jsonb("outcome").$type<Record<string, unknown>>(),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_decision_log_org_idx").on(table.organizationId, table.createdAt),
    index("agent_decision_log_conversation_idx").on(table.conversationId),
    check("agent_decision_log_mode_check", sql`${table.mode} in ('shadow','retrieval','route')`),
  ],
)

/** Nota que el agente deja sobre el caso para turnos posteriores. */
export interface AgentCaseNote {
  text: string
  at: string
  /**
   * `atencion_anterior`: la deja el sistema al cerrar la conversación, con
   * cómo terminó; las notas del agente de esa atención no pasan a la siguiente.
   * `para_quien`, `servicio` y `preferencia`: lo que el agente anota con nombre
   * propio (ADR 0104); de cada una vale la última. Sin `kind`, una nota libre.
   */
  kind?: "atencion_anterior" | "para_quien" | "servicio" | "preferencia"
}

/** Última consulta de una herramienta de lectura en el hilo, tal como la vio el modelo. */
export interface AgentCaseLookup {
  text: string
  at: string
}

/**
 * Memoria del caso: lo que el agente necesita recordar de un hilo entre turnos
 * y no vive en otra tabla. Las propuestas, citas y tareas se leen de su fuente;
 * aquí solo van las notas que el propio agente deja y la última consulta de
 * cada herramienta de lectura. Una fila por conversación.
 */
export const agentCaseMemory = pgTable(
  "agent_case_memory",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    conversationId: uuid("conversation_id").notNull(),
    notes: jsonb("notes").$type<AgentCaseNote[]>().notNull().default(sql`'[]'::jsonb`),
    lookups: jsonb("lookups").$type<Record<string, AgentCaseLookup>>().notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_case_memory_org_conversation_uidx").on(table.organizationId, table.conversationId),
    foreignKey({
      columns: [table.organizationId, table.conversationId],
      foreignColumns: [conversation.organizationId, conversation.id],
      name: "agent_case_memory_conversation_fk",
    }).onDelete("cascade"),
  ],
)

/** De dónde salió un dato de la respuesta: fuente legible, nunca el contenido clínico. */
export interface AnswerBasisItem {
  /** agenda | servicios | conocimiento | persona | caso | comercial | otros_canales | conversacion */
  kind: string
  label: string
  detail?: string
  /** Id de lo consultado cuando se puede abrir desde la ficha (hoy, la lección aplicada). */
  ref?: string
}

export const ANSWER_CHECK_KINDS = ["precio", "hora", "fecha", "enlace"] as const
export type AnswerCheckKind = (typeof ANSWER_CHECK_KINDS)[number]

/** Comprobación de un dato concreto de la respuesta contra lo consultado. */
export interface AnswerCheck {
  kind: AnswerCheckKind
  /** El dato tal como aparece en la respuesta. */
  value: string
  ok: boolean
  /** Fuente donde se encontró; nulo si no está en lo consultado. */
  source: string | null
  /**
   * De qué servicio es el precio, cuando lo es (su nombre normalizado). Con
   * esto se cuentan los servicios cuyo precio ya se dijo en la conversación:
   * nunca más de tres (decisión 4 de la fase 4).
   */
  subject?: string
}

export const ANSWER_TRACE_OUTCOMES = ["enviada", "pendiente", "bloqueada", "fallida"] as const
export type AnswerTraceOutcome = (typeof ANSWER_TRACE_OUTCOMES)[number]

/**
 * En qué se basó cada respuesta del agente (solo anexado). `bloqueada` es una
 * respuesta que no salió porque un precio, fecha u hora no estaba en lo
 * consultado. El mensaje real se enlaza por `message_id` cuando el envío es
 * directo y por `proposal_id` cuando espera confirmación o aprobación.
 */
export const agentAnswerTrace = pgTable(
  "agent_answer_trace",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id),
    triggerMessageId: uuid("trigger_message_id"),
    proposalId: uuid("proposal_id"),
    messageId: uuid("message_id"),
    /** Agente que respondió (recepcion hoy; los demás roles llegan después). */
    agent: text("agent").notNull().default("recepcion"),
    outcome: text("outcome").notNull(),
    replyText: text("reply_text").notNull(),
    basis: jsonb("basis").$type<AnswerBasisItem[]>().notNull().default(sql`'[]'::jsonb`),
    checks: jsonb("checks").$type<AnswerCheck[]>().notNull().default(sql`'[]'::jsonb`),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_answer_trace_conversation_idx").on(table.organizationId, table.conversationId, table.createdAt),
    index("agent_answer_trace_message_idx").on(table.organizationId, table.messageId),
    index("agent_answer_trace_proposal_idx").on(table.organizationId, table.proposalId),
    check("agent_answer_trace_outcome_check", sql`${table.outcome} in ('enviada','pendiente','bloqueada','fallida')`),
  ],
)

/* ---------- Aprender: lo que se revisa, lo que se corrige y lo que queda aprendido ---------- */

/** Por qué una respuesta entró en «Por revisar». */
export const REVIEW_REASONS = ["equipo_tomo", "repitio_pregunta", "muestra", "marcada"] as const
export type ReviewReason = (typeof REVIEW_REASONS)[number]

/**
 * Una respuesta del agente que conviene que una persona mire: porque el
 * equipo tomó la conversación justo después, porque el interlocutor repitió la
 * pregunta, por muestra al azar o porque alguien la marcó. Una fila por
 * respuesta.
 */
export const agentReviewItem = pgTable(
  "agent_review_item",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    agent: text("agent").notNull().default("recepcion"),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversation.id),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => agentAnswerTrace.id),
    reason: text("reason").$type<ReviewReason>().notNull(),
    /** Lo que preguntó el interlocutor y lo que respondió el agente, tal como quedaron. */
    question: text("question").notNull().default(""),
    reply: text("reply").notNull(),
    /** Lo que respondió el equipo después, si lo hubo: punto de partida de la corrección. */
    teamReply: text("team_reply"),
    status: text("status").notNull().default("pendiente"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_review_item_trace_uidx").on(table.organizationId, table.traceId),
    index("agent_review_item_org_idx").on(table.organizationId, table.status, table.createdAt),
    check("agent_review_item_reason_check", sql`${table.reason} in ('equipo_tomo','repitio_pregunta','muestra','marcada')`),
    check("agent_review_item_status_check", sql`${table.status} in ('pendiente','bien','corregida')`),
  ],
)

export const LESSON_KINDS = ["respuesta_oficial", "regla", "ejemplo"] as const
export type LessonKind = (typeof LESSON_KINDS)[number]

/** Qué falló en la respuesta corregida. */
export const CORRECTION_FAILURES = ["dato_equivocado", "falto_dato", "tono", "no_debio_responder", "otra_cosa"] as const
export type CorrectionFailure = (typeof CORRECTION_FAILURES)[number]

export const LESSON_STATUSES = ["propuesta", "activa", "retirada", "descartada"] as const
export type LessonStatus = (typeof LESSON_STATUSES)[number]

/** De dónde sale una regla de «Lo que el agente debe saber»: la escribió la clínica o se aprendió. */
export const LESSON_SOURCES = ["aprendida", "escrita"] as const
export type LessonSource = (typeof LESSON_SOURCES)[number]

/**
 * Lección: lo que el agente aprende de una corrección. Nace `propuesta` y no
 * cambia nada hasta que una persona la aprueba; `activa` se usa; `retirada`
 * deja de usarse al instante y se puede restaurar. Tres clases: una respuesta
 * oficial (de toda la clínica, vive en el conocimiento), una regla o un
 * ejemplo (del agente que la recibió). Nunca se borra: es la historia de lo
 * aprendido.
 */
export const agentLesson = pgTable(
  "agent_lesson",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    kind: text("kind").$type<LessonKind>().notNull(),
    /** `clinica` (respuesta oficial) o el agente al que pertenece. */
    scope: text("scope").notNull().default("recepcion"),
    title: text("title").notNull(),
    /** La pregunta del caso que la originó. */
    question: text("question").notNull().default(""),
    /** El texto que se aprende: la respuesta oficial, la regla o la respuesta de ejemplo. */
    body: text("body").notNull(),
    failure: text("failure").$type<CorrectionFailure>(),
    /** Lo que había respondido el agente. */
    originalReply: text("original_reply").notNull().default(""),
    status: text("status").$type<LessonStatus>().notNull().default("propuesta"),
    reviewItemId: uuid("review_item_id").references(() => agentReviewItem.id),
    conversationId: uuid("conversation_id").references(() => conversation.id),
    /** Respuesta oficial que la lección creó o cambió al activarse. */
    knowledgeEntryId: uuid("knowledge_entry_id").references(() => agentKnowledgeEntry.id),
    /** Texto que tenía esa respuesta antes del cambio; nulo si la lección la creó. */
    previousBody: text("previous_body"),
    uses: integer("uses").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /**
     * Lo que el agente debe saber (decisión 24): `escrita` la escribió la
     * clínica (una regla activa desde que se guarda); `aprendida` salió de una
     * corrección y la aprobó alguien.
     */
    source: text("source").$type<LessonSource>().notNull().default("aprendida"),
    proposedBy: text("proposed_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    withdrawnBy: text("withdrawn_by"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_lesson_org_idx").on(table.organizationId, table.status, table.createdAt),
    check("agent_lesson_kind_check", sql`${table.kind} in ('respuesta_oficial','regla','ejemplo')`),
    check("agent_lesson_status_check", sql`${table.status} in ('propuesta','activa','retirada','descartada')`),
    check("agent_lesson_source_check", sql`${table.source} in ('aprendida','escrita')`),
    check("agent_lesson_written_rule_check", sql`${table.source} = 'aprendida' or ${table.kind} = 'regla'`),
    check(
      "agent_lesson_failure_check",
      sql`${table.failure} is null or ${table.failure} in ('dato_equivocado','falto_dato','tono','no_debio_responder','otra_cosa')`,
    ),
  ],
)

/**
 * Caso de prueba: una pregunta real con la respuesta que una persona dio por
 * buena. Antes de activar o retirar una lección se mira a qué casos toca.
 */
export const agentTestCase = pgTable(
  "agent_test_case",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    agent: text("agent").notNull().default("recepcion"),
    question: text("question").notNull(),
    expected: text("expected").notNull(),
    lessonId: uuid("lesson_id").references(() => agentLesson.id),
    status: text("status").notNull().default("activo"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_test_case_org_idx").on(table.organizationId, table.status, table.createdAt),
    check("agent_test_case_status_check", sql`${table.status} in ('activo','retirado')`),
  ],
)

/* ---------- Memoria de la persona: lo que el agente recuerda entre conversaciones ---------- */

/**
 * Un dato no clínico sobre una persona (una preferencia, cómo quiere que la
 * traten, a qué hora le viene bien) que vale para sus próximas conversaciones
 * en cualquier canal. Lleva fecha y origen. Uno nuevo puede reemplazar a otro
 * y cualquiera se puede quitar; la fila se conserva como historia. Nunca
 * guarda síntomas, diagnósticos ni nada de la historia clínica.
 */
export const agentPersonFact = pgTable(
  "agent_person_fact",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contact.id),
    text: text("text").notNull(),
    /** Quién lo registró: el agente al oírlo en una conversación, o alguien del equipo. */
    source: text("source").notNull(),
    /** Conversación y canal donde se dijo, si vino de una. */
    conversationId: uuid("conversation_id").references(() => conversation.id),
    channel: text("channel"),
    createdBy: text("created_by"),
    status: text("status").notNull().default("activo"),
    /** Dato que lo reemplazó. */
    replacedById: uuid("replaced_by_id"),
    removedBy: text("removed_by"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_person_fact_contact_idx").on(table.organizationId, table.contactId, table.status),
    check("agent_person_fact_source_check", sql`${table.source} in ('agente','equipo')`),
    check("agent_person_fact_status_check", sql`${table.status} in ('activo','reemplazado','quitado')`),
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

/**
 * Quién dice que sí a cada acción del agente. Es fija para todas las clínicas
 * (ADR 0021): el agente siempre responde, la cita la confirma el paciente y lo
 * comercial es interno y se deshace. La clínica elige qué funciones enciende,
 * no niveles. No se guarda por organización, y ningún acto espera al equipo
 * (ADR 0023).
 */
export const DEFAULT_AUTONOMY_MODES: Record<AutonomyAction, AutonomyMode> = {
  reservar_cita: "confirmar_usuario",
  reprogramar_cita: "confirmar_usuario",
  cancelar_cita: "confirmar_usuario",
  enviar_mensaje: "directo",
  mover_oportunidad: "directo",
  crear_oportunidad: "directo",
  actualizar_seguimiento: "directo",
  cerrar_oportunidad: "directo",
  // Lo que la persona acepta de su presupuesto se anota solo después de su sí a la lista.
  decidir_presupuesto: "confirmar_usuario",
}

/* ---------- Búsqueda por significado (ADR 0021) ---------- */

/**
 * Vector de pgvector sin dimensión fija: cada fila guarda el modelo que la
 * vectorizó y solo se compara con vectores del mismo modelo. Sin dimensión no
 * hay índice; la búsqueda recorre las filas de una clínica, que son pocas.
 */
export const pgVector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector"
  },
  toDriver(value) {
    return `[${value.join(",")}]`
  },
  fromDriver(value) {
    return JSON.parse(value) as number[]
  },
})

/** Qué se puede encontrar por significado. */
export const SEARCH_ITEM_KINDS = ["servicio", "promocion", "profesional", "respuesta"] as const
export type SearchItemKind = (typeof SEARCH_ITEM_KINDS)[number]

/**
 * Lo que el agente encuentra por significado: un texto descriptivo por cosa
 * de la clínica (nunca precios, fechas ni datos de personas) y su vector. Sirve
 * solo para encontrar: lo que se dice se lee de su tabla en ese momento. La
 * fila se concilia con el catálogo; con el texto cambiado, el vector se borra
 * y el trabajador lo vuelve a calcular.
 */
export const agentSearchItem = pgTable(
  "agent_search_item",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    organizationId: orgFk("organization_id"),
    kind: text("kind").notNull(),
    refId: text("ref_id").notNull(),
    text: text("text").notNull(),
    /** Modelo que calculó `embedding`; nulo mientras falta calcularlo. */
    model: text("model"),
    embedding: pgVector("embedding"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_search_item_ref_uidx").on(table.organizationId, table.kind, table.refId),
    index("agent_search_item_pending_idx").on(table.organizationId).where(sql`${table.embedding} is null`),
    check("agent_search_item_kind_check", sql`${table.kind} in ('servicio','promocion','profesional','respuesta')`),
  ],
)
