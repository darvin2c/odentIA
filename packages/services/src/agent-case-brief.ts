import type { Db } from "@odentia/db"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { and, desc, eq } from "drizzle-orm"
import { caseSlotLabel, getAgentCaseState } from "./agent-case.js"
import { type HandoffItem, listHandoffs } from "./agent-operations.js"
import { getPersonMemory } from "./agent-person-memory.js"
import { notFound } from "./errors.js"
import { listPatientsByContact } from "./patients.js"

/**
 * Resumen del caso para quien lo toma: lo que la persona escribió, lo que ya
 * se sabe (con su origen) y lo que hizo el agente. Se arma con lo que el
 * sistema ya guarda (la derivación, la memoria del caso, lo que se recuerda de
 * la persona y sus vínculos), sin modelo: nadie lo redacta ni lo mantiene, y
 * es lo mismo que el agente recibe antes de preguntar algo. No lleva nada
 * clínico: la memoria de la persona no lo admite y las notas del caso tampoco.
 */
export interface CaseBrief {
  conversationId: string
  contactId: string
  /** La derivación sin resolver más reciente de la conversación, si la hay. */
  handoff: Pick<HandoffItem, "id" | "reason" | "summary" | "priority" | "status" | "dueAt" | "createdAt" | "asks" | "pending" | "notice"> | null
  contactName: string | null
  /** Canal de la conversación. */
  channel: string | null
  /** Lo que la persona escribió seguido antes de pasar el caso, del más antiguo al más reciente. */
  said: string[]
  known: Array<{
    /** De qué es el dato, cuando el sistema lo sabe (los que salen de la ficha). */
    label: string | null
    text: string
    /** De dónde sale: de esta conversación, de lo que se recuerda de la persona o de su ficha. */
    origin: "caso" | "persona" | "ficha"
    /** Canal por el que lo dijo, cuando lo guardó el agente. */
    channel: string | null
    /** Quién lo guardó, en lo que se recuerda de la persona: el agente (lo dijo ella) o alguien del equipo. */
    notedBy: "agente" | "equipo" | null
    at: string | null
  }>
  /** Lo que el agente dejó propuesto o ya hizo en este caso. */
  proposals: Array<{ label: string; summary: string; status: string; at: string }>
  /** Lo último que el agente le dijo a la persona. */
  lastAgentMessage: { text: string; at: string } | null
}

const SAID = /^Escribió: «(.+)»$/s
const BURST_LIMIT = 8

/** Los mensajes que el agente dejó citados al pasar el caso («Escribió: «a» · «b»»). */
export function parseHandoffSaid(summary: string): string[] {
  const match = SAID.exec(summary.trim())
  if (!match?.[1]) return []
  return match[1]
    .split("» · «")
    .map((text) => text.trim())
    .filter(Boolean)
}

export async function getCaseBrief(
  tx: Db,
  orgId: string,
  conversationId: string,
  options: { includePerson?: boolean } = {},
): Promise<CaseBrief> {
  const [conv] = await tx
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, conversationId)))
    .limit(1)
  if (!conv) throw notFound("Conversación")

  const handoffs = await listHandoffs(tx, orgId, { conversationId, limit: 5 })
  const open = handoffs.find((item) => item.status !== "resuelta") ?? null
  const state = await getAgentCaseState(tx, orgId, conversationId)

  const recent = await tx
    .select({ direction: message.direction, senderKind: message.senderKind, body: message.body, createdAt: message.createdAt })
    .from(message)
    .where(and(eq(message.organizationId, orgId), eq(message.conversationId, conversationId)))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(30)
  const lastAgent = recent.find((item) => item.senderKind === "agent" && item.body?.trim())

  // Lo que escribió: lo que el agente citó al pasar el caso o, si la derivación
  // la hizo una persona, sus últimos mensajes seguidos antes de la última respuesta.
  let said = open ? parseHandoffSaid(open.summary) : []
  if (said.length === 0) {
    const run: string[] = []
    let seenInbound = false
    for (const item of recent) {
      if (item.direction === "in") {
        seenInbound = true
        if (item.body?.trim()) run.unshift(item.body.trim())
        if (run.length >= BURST_LIMIT) break
      } else if (seenInbound) break
    }
    said = run
  }

  const [person] = await tx
    .select({ displayName: contact.displayName, channel: channelConnection.channel })
    .from(conversation)
    .innerJoin(contact, eq(contact.id, conversation.contactId))
    .leftJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, conversationId)))
    .limit(1)

  // Lo que el agente anotó con nombre propio llega con ese nombre: «Para quién», «Qué pide», «Prefiere» (ADR 0104).
  const known: CaseBrief["known"] = state.notes.map((note) => ({ label: caseSlotLabel(note.kind), text: note.text, origin: "caso", channel: null, notedBy: null, at: note.at }))
  if (options.includePerson !== false) {
    const memory = await getPersonMemory(tx, orgId, conv.contactId)
    for (const fact of memory.facts) known.push({ label: null, text: fact.text, origin: "persona", channel: fact.channel, notedBy: fact.source, at: fact.createdAt })
    const own = (await listPatientsByContact(tx, orgId, conv.contactId)).find((link) => link.relationship === "self" && link.isActive)
    if (own) known.push({ label: "Paciente", text: own.displayName, origin: "ficha", channel: null, notedBy: null, at: null })
    for (const item of memory.derived) known.push({ label: item.label, text: item.text, origin: "ficha", channel: null, notedBy: null, at: null })
  }

  return {
    conversationId,
    contactId: conv.contactId,
    handoff: open
      ? {
          id: open.id,
          reason: open.reason,
          summary: open.summary,
          priority: open.priority,
          status: open.status,
          dueAt: open.dueAt,
          createdAt: open.createdAt,
          asks: open.asks,
          pending: open.pending,
          notice: open.notice,
        }
      : null,
    contactName: person?.displayName ?? null,
    channel: person?.channel ?? null,
    said,
    known,
    proposals: [...state.pending, ...state.recent].map((proposal) => ({
      label: proposal.label,
      summary: proposal.summary,
      status: proposal.status,
      at: proposal.at,
    })),
    lastAgentMessage: lastAgent?.body ? { text: lastAgent.body, at: lastAgent.createdAt.toISOString() } : null,
  }
}
