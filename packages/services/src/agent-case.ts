import type { Db } from "@odentia/db"
import {
  agentAnswerTrace,
  agentCaseMemory,
  agentProposal,
  ANSWER_CHECK_KINDS,
  ANSWER_TRACE_OUTCOMES,
  type AgentCaseLookup,
  type AgentCaseNote,
  type AnswerBasisItem,
  type AnswerCheck,
  type AnswerTraceOutcome,
} from "@odentia/db/schema/agent"
import { conversation, message } from "@odentia/db/schema/crm"
import { and, count, desc, eq, inArray } from "drizzle-orm"
import { CONFIRM_TTL_HOURS, listProposals, PROPOSAL_ACTION_LABEL } from "./agent-operations.js"
import { notFound, validation } from "./errors.js"
import { formatZoned, type OrgLocale } from "./locale.js"

/* ---------- Memoria del caso: lo que el agente recuerda de un hilo entre turnos ---------- */

export const CASE_NOTE_LIMIT = 12
export const CASE_NOTE_CHARS = 300
export const CASE_LOOKUP_CHARS = 2000
/** Una consulta más antigua ya no se muestra: la agenda y los saldos cambian. */
export const CASE_LOOKUP_TTL_MS = 6 * 60 * 60 * 1000
/** Lo resuelto en las últimas horas sigue a la vista para no repetirlo. */
const CASE_RECENT_MS = CONFIRM_TTL_HOURS * 60 * 60 * 1000
const CASE_RECENT_LIMIT = 5

/** Herramientas de lectura cuya última consulta se conserva entre turnos. */
export const CASE_LOOKUP_TOOLS = ["buscar_huecos", "ver_contexto_paciente", "ver_resumen_paciente"] as const

export interface AgentCaseProposal {
  id: string
  action: string
  label: string
  summary: string
  status: string
  detail: string | null
  at: string
  expiresAt: string | null
}

export interface AgentCaseState {
  pending: AgentCaseProposal[]
  recent: AgentCaseProposal[]
  notes: AgentCaseNote[]
  lookups: Array<{ tool: string; text: string; at: string }>
  totalMessages: number
}

async function requireConversation(tx: Db, orgId: string, conversationId: string): Promise<void> {
  const [row] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, conversationId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
}

async function caseMemoryRow(tx: Db, orgId: string, conversationId: string) {
  const [row] = await tx
    .select()
    .from(agentCaseMemory)
    .where(and(eq(agentCaseMemory.organizationId, orgId), eq(agentCaseMemory.conversationId, conversationId)))
    .limit(1)
  return row ?? null
}

/**
 * Estado del caso para el siguiente turno. Las propuestas se leen de su tabla
 * (fuente de verdad, con su caducidad consolidada); las notas y las consultas
 * recientes, de la memoria del hilo.
 */
export async function getAgentCaseState(tx: Db, orgId: string, conversationId: string): Promise<AgentCaseState> {
  await requireConversation(tx, orgId, conversationId)
  const proposals = await listProposals(tx, orgId, { conversationId, limit: 30 })
  const now = Date.now()
  const pending: AgentCaseProposal[] = []
  const recent: AgentCaseProposal[] = []
  for (const p of proposals) {
    const base = {
      id: p.id,
      action: p.action,
      label: PROPOSAL_ACTION_LABEL[p.action] ?? p.action,
      summary: p.context.afterSummary,
      status: p.status,
    }
    if (p.status === "propuesta") {
      pending.push({
        ...base,
        detail: null,
        at: p.createdAt,
        expiresAt: new Date(Date.parse(p.createdAt) + CASE_RECENT_MS).toISOString(),
      })
      continue
    }
    // Un mensaje ya enviado está en el historial: repetirlo aquí solo añade ruido.
    if (p.action === "enviar_mensaje" && p.status === "ejecutada") continue
    if (p.status === "aprobada") continue
    const at = p.executedAt ?? p.decidedAt ?? p.createdAt
    if (now - Date.parse(at) > CASE_RECENT_MS || recent.length >= CASE_RECENT_LIMIT) continue
    recent.push({
      ...base,
      detail: p.status === "fallida" ? p.error : null,
      at,
      expiresAt: null,
    })
  }
  const memory = await caseMemoryRow(tx, orgId, conversationId)
  const lookups = Object.entries(memory?.lookups ?? {})
    .filter(([, value]) => now - Date.parse(value.at) <= CASE_LOOKUP_TTL_MS)
    .map(([tool, value]) => ({ tool, text: value.text, at: value.at }))
    .sort((a, b) => a.at.localeCompare(b.at))
  const [total] = await tx
    .select({ total: count() })
    .from(message)
    .where(and(eq(message.organizationId, orgId), eq(message.conversationId, conversationId)))
  return {
    pending,
    recent,
    notes: memory?.notes ?? [],
    lookups,
    totalMessages: Number(total?.total ?? 0),
  }
}

/**
 * Bloque del prompt con el estado del caso. Nulo si no hay nada que decir: un
 * hilo nuevo no gasta tokens en una sección vacía.
 */
export function formatAgentCaseForPrompt(
  state: AgentCaseState,
  zone: Pick<OrgLocale, "timezone" | "locale">,
  historyLimit: number,
): string | null {
  const when = (iso: string) => formatZoned(new Date(iso), zone)
  const sections: string[] = []
  const facts: string[] = []
  // Lo único que queda pendiente en un hilo es lo que confirma el interlocutor (ADR 0023).
  for (const p of state.pending) {
    facts.push(
      `- Propuesta pendiente de que el interlocutor confirme: ${p.label} — ${p.summary} (id ${p.id}; creada ${when(p.at)}${p.expiresAt ? `; vence ${when(p.expiresAt)}` : ""}). Si su último mensaje es un sí claro, ejecútala con confirmar_propuesta y ese id; no la propongas de nuevo ni vuelvas a buscar.`,
    )
  }
  for (const p of state.recent) {
    const detail = p.detail?.trim() ? `: ${p.detail.trim().slice(0, 200)}` : ""
    facts.push(
      p.status === "ejecutada"
        ? `- Hecho: ${p.label} — ${p.summary} (${when(p.at)}).`
        : `- No se hizo: ${p.label} — ${p.summary} (${p.status}${detail}; ${when(p.at)}).`,
    )
  }
  if (facts.length) {
    sections.push(
      `Estado del caso (lo registra el sistema; es la fuente de verdad sobre lo ya propuesto y hecho en este hilo):\n${facts.join("\n")}`,
    )
  }
  // Cómo terminó la atención anterior del hilo (la deja el sistema al cerrar): las notas de entonces no siguen.
  const previous = state.notes.filter((n) => n.kind === "atencion_anterior")
  const own = state.notes.filter((n) => n.kind !== "atencion_anterior")
  for (const note of previous) {
    sections.push(`${note.text} Esta es una atención nueva: no des por pendiente lo de entonces salvo que la persona lo retome.`)
  }
  if (own.length) {
    sections.push(
      `Notas del caso (las dejaste tú en turnos anteriores con anotar_caso):\n${own.map((n) => `- ${n.text}`).join("\n")}`,
    )
  }
  if (state.lookups.length) {
    sections.push(
      `Consultas de turnos anteriores (ya las hiciste: úsalas para responder y para elegir, y vuelve a consultar solo si el interlocutor pide otro día, otra sede u otra persona, o si son de hace más de una hora; al proponer o reservar el sistema comprueba la disponibilidad y te avisa si el horario ya no está):\n${state.lookups
        .map((l) => `[${l.tool} · ${when(l.at)}]\n${l.text}`)
        .join("\n")}`,
    )
  }
  if (state.totalMessages > historyLimit) {
    sections.push(
      `Solo ves los últimos ${historyLimit} mensajes de ${state.totalMessages}: lo anterior no está a la vista. Apóyate en las notas del caso y, si falta un dato, pregúntalo.`,
    )
  }
  return sections.length ? sections.join("\n\n") : null
}

async function upsertCaseMemory(
  tx: Db,
  orgId: string,
  conversationId: string,
  patch: { notes?: AgentCaseNote[]; lookups?: Record<string, AgentCaseLookup> },
): Promise<void> {
  await requireConversation(tx, orgId, conversationId)
  await tx
    .insert(agentCaseMemory)
    .values({
      organizationId: orgId,
      conversationId,
      notes: patch.notes ?? [],
      lookups: patch.lookups ?? {},
    })
    .onConflictDoUpdate({
      target: [agentCaseMemory.organizationId, agentCaseMemory.conversationId],
      set: {
        ...(patch.notes ? { notes: patch.notes } : {}),
        ...(patch.lookups ? { lookups: patch.lookups } : {}),
        updatedAt: new Date(),
      },
    })
}

/**
 * Añade una nota del agente sobre el caso. Acotada: al pasar del límite se
 * descarta la más antigua; una nota repetida no se duplica.
 */
export async function addAgentCaseNote(
  tx: Db,
  orgId: string,
  conversationId: string,
  text: string,
): Promise<AgentCaseNote[]> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, CASE_NOTE_CHARS)
  if (!clean) throw validation("La nota del caso no puede estar vacía")
  const current = (await caseMemoryRow(tx, orgId, conversationId))?.notes ?? []
  if (current.some((note) => note.text === clean)) return current
  const next = [...current, { text: clean, at: new Date().toISOString() }].slice(-CASE_NOTE_LIMIT)
  await upsertCaseMemory(tx, orgId, conversationId, { notes: next })
  return next
}

/** Conserva la última consulta de una herramienta de lectura del hilo. */
export async function recordAgentCaseLookup(
  tx: Db,
  orgId: string,
  conversationId: string,
  input: { tool: string; text: string },
): Promise<void> {
  if (!(CASE_LOOKUP_TOOLS as readonly string[]).includes(input.tool)) return
  const text = input.text.trim()
  if (!text) return
  const current = (await caseMemoryRow(tx, orgId, conversationId))?.lookups ?? {}
  const clipped =
    text.length > CASE_LOOKUP_CHARS ? `${text.slice(0, CASE_LOOKUP_CHARS)}… (recortado: vuelve a consultar)` : text
  await upsertCaseMemory(tx, orgId, conversationId, {
    lookups: { ...current, [input.tool]: { text: clipped, at: new Date().toISOString() } },
  })
}

/* ---------- Traza: en qué se basó cada respuesta ---------- */

export interface RecordAnswerTraceInput {
  conversationId: string
  triggerMessageId?: string | null
  proposalId?: string | null
  messageId?: string | null
  agent?: string
  outcome: AnswerTraceOutcome
  replyText: string
  basis: AnswerBasisItem[]
  checks: AnswerCheck[]
  model?: string | null
}

const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)

export async function recordAnswerTrace(tx: Db, orgId: string, input: RecordAnswerTraceInput): Promise<string> {
  if (!(ANSWER_TRACE_OUTCOMES as readonly string[]).includes(input.outcome)) throw validation("outcome inválido")
  const basis = input.basis.slice(0, 30).map((item) => ({
    kind: item.kind.slice(0, 40),
    label: item.label.slice(0, 160),
    ...(item.detail ? { detail: item.detail.slice(0, 300) } : {}),
    ...(isUuid(item.ref) ? { ref: item.ref } : {}),
  }))
  const checks = input.checks
    .filter((item) => (ANSWER_CHECK_KINDS as readonly string[]).includes(item.kind))
    .slice(0, 40)
    .map((item) => ({
      kind: item.kind,
      value: item.value.slice(0, 80),
      ok: item.ok === true,
      source: item.source ? item.source.slice(0, 80) : null,
    }))
  const [row] = await tx
    .insert(agentAnswerTrace)
    .values({
      organizationId: orgId,
      conversationId: input.conversationId,
      triggerMessageId: isUuid(input.triggerMessageId) ? input.triggerMessageId : null,
      proposalId: isUuid(input.proposalId) ? input.proposalId : null,
      messageId: isUuid(input.messageId) ? input.messageId : null,
      agent: input.agent ?? "recepcion",
      outcome: input.outcome,
      replyText: input.replyText.slice(0, 4000),
      basis,
      checks,
      model: input.model?.slice(0, 120) ?? null,
    })
    .returning({ id: agentAnswerTrace.id })
  if (!row) throw new Error("No se pudo registrar la traza de la respuesta")
  return row.id
}

export interface AnswerTraceItem {
  id: string
  conversationId: string
  messageId: string | null
  proposalId: string | null
  agent: string
  outcome: AnswerTraceOutcome
  /** Lo que escribió la persona y originó la respuesta; nulo si no vino de un mensaje. */
  question: string | null
  replyText: string
  basis: AnswerBasisItem[]
  checks: AnswerCheck[]
  model: string | null
  createdAt: string
}

/** El texto del mensaje que originó cada traza, por id de mensaje. */
async function triggerBodies(tx: Db, orgId: string, rows: AnswerTraceRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.triggerMessageId).filter(isUuid))]
  if (ids.length === 0) return new Map()
  const found = await tx
    .select({ id: message.id, body: message.body })
    .from(message)
    .where(and(eq(message.organizationId, orgId), inArray(message.id, ids)))
  return new Map(found.filter((item) => item.body?.trim()).map((item) => [item.id, item.body as string]))
}

type AnswerTraceRow = typeof agentAnswerTrace.$inferSelect

function toTraceItem(row: AnswerTraceRow, messageId: string | null, questions: Map<string, string>): AnswerTraceItem {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId,
    proposalId: row.proposalId,
    agent: row.agent,
    outcome: row.outcome as AnswerTraceOutcome,
    question: row.triggerMessageId ? (questions.get(row.triggerMessageId) ?? null) : null,
    replyText: row.replyText,
    basis: row.basis,
    checks: row.checks,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * Mensajes del hilo que tienen traza: la bandeja solo ofrece «En qué se basó»
 * donde hay algo que mostrar. Incluye las respuestas bloqueadas (sin mensaje).
 */
export async function listAnswerTraces(
  tx: Db,
  orgId: string,
  conversationId: string,
  input: { limit?: number } = {},
): Promise<AnswerTraceItem[]> {
  await requireConversation(tx, orgId, conversationId)
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  const rows = await tx
    .select({ trace: agentAnswerTrace, result: agentProposal.result })
    .from(agentAnswerTrace)
    .leftJoin(
      agentProposal,
      and(eq(agentProposal.organizationId, orgId), eq(agentProposal.id, agentAnswerTrace.proposalId)),
    )
    .where(and(eq(agentAnswerTrace.organizationId, orgId), eq(agentAnswerTrace.conversationId, conversationId)))
    .orderBy(desc(agentAnswerTrace.createdAt))
    .limit(limit)
  const questions = await triggerBodies(tx, orgId, rows.map((row) => row.trace))
  return rows.map((row) => {
    const viaProposal = row.result?.["messageId"]
    return toTraceItem(row.trace, row.trace.messageId ?? (isUuid(viaProposal) ? viaProposal : null), questions)
  })
}
