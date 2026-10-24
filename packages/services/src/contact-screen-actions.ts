import { type Db, sendAgentRun } from "@odentia/db"
import { agentHandoff } from "@odentia/db/schema/agent"
import { agentConfig, channelConnection, type ContactScreen, conversation, type SpamReason } from "@odentia/db/schema/crm"
import { and, eq, sql } from "drizzle-orm"
import { createHandoff } from "./agent-operations.js"
import {
  autoSpamAllowed,
  blockContact,
  contactScreenFacts,
  markNotSpam,
  markSpam,
  normalizedBodySql,
  SPAM_RECHECKS_PER_DAY,
  SPAM_REPEAT_COUNT,
  SPAM_REPEAT_MINUTES,
  spamRechecksToday,
  unblockContact,
} from "./contact-screen.js"
import { notFound } from "./errors.js"
import { handoffOpenSql } from "./handoff-state.js"
import { windowOpen } from "./message-window.js"
import { updateTask } from "./tasks.js"

/**
 * Lo que pasa alrededor de Spam y Bloquear (ADR 0054): los temas abiertos de
 * esa persona se resuelven, porque nadie tiene que atenderlos; al sacarla de
 * Spam, el agente le responde o queda un tema para el equipo. El estado en sí
 * lo cambia solo `contact-screen.ts`.
 */

/** Proveedores con la ventana de 24 horas de Meta: pasada, solo una plantilla. */
const WINDOWED_PROVIDERS = ["whatsapp_cloud_api", "messenger", "instagram"]

/** Resuelve los temas abiertos de las conversaciones de una persona: ya no hay nada que atender. */
async function settleOpenTopics(tx: Db, orgId: string, contactId: string, actorUserId: string | null): Promise<number> {
  const rows = await tx
    .select({ taskId: agentHandoff.taskId })
    .from(agentHandoff)
    .innerJoin(conversation, and(eq(conversation.organizationId, agentHandoff.organizationId), eq(conversation.id, agentHandoff.conversationId)))
    .where(and(eq(agentHandoff.organizationId, orgId), eq(conversation.contactId, contactId), handoffOpenSql(sql.raw('"agent_handoff"'))))
  let settled = 0
  for (const row of rows) {
    if (!row.taskId) continue
    await updateTask(tx, orgId, row.taskId, { status: "done", actorUserId })
    settled += 1
  }
  return settled
}

/** «Es spam» de una persona del equipo (tablero 4): también desde el tema del límite de 40. */
export async function sendToSpam(tx: Db, orgId: string, input: { contactId: string; userId: string }): Promise<{ changed: boolean }> {
  const changed = await markSpam(tx, orgId, { contactId: input.contactId, reason: "equipo", userId: input.userId })
  if (changed) await settleOpenTopics(tx, orgId, input.contactId, input.userId)
  return { changed }
}

/** Qué pasó al sacar a alguien de Spam, para decirlo en el aviso. */
export interface OutOfSpam {
  /** El agente le responde ahora su último mensaje. */
  agentReplies: boolean
  /** Quedó un tema en «Por atender»: escribió hace más de 24 horas y hace falta una plantilla. */
  topic: boolean
}

/**
 * «No es spam» (tablero 5): vuelve a la Bandeja. Si escribió hace menos de 24
 * horas (o su canal no tiene ventana) y el agente la atiende, el agente le
 * responde ya su último mensaje; si pasó la ventana, queda un tema para el
 * equipo. Con el agente apagado, la conversación ya sale en «Por atender».
 */
export async function takeOutOfSpam(tx: Db, orgId: string, input: { contactId: string; userId: string }): Promise<OutOfSpam> {
  const last = await markNotSpam(tx, orgId, input)
  if (!last) return { agentReplies: false, topic: false }
  const [row] = await tx
    .select({
      status: conversation.status,
      agentStatus: conversation.agentStatus,
      provider: channelConnection.provider,
      channel: channelConnection.channel,
    })
    .from(conversation)
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, last.conversationId)))
    .limit(1)
  if (!row) return { agentReplies: false, topic: false }
  const [cfg] = await tx
    .select({ enabled: agentConfig.enabled })
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  // Sofi atiende todos los canales (ADR 0084).
  const attends = row.status === "open" && row.agentStatus === "on" && Boolean(cfg?.enabled)
  if (!attends) return { agentReplies: false, topic: false }
  const canReply = !WINDOWED_PROVIDERS.includes(row.provider) || windowOpen(last.at)
  if (canReply) {
    await sendAgentRun(tx, { kind: "inbound_message", orgId, conversationId: last.conversationId, messageId: last.messageId })
    return { agentReplies: true, topic: false }
  }
  const days = Math.max(1, Math.floor((Date.now() - last.at.getTime()) / 86_400_000))
  await createHandoff(tx, orgId, input.userId, {
    conversationId: last.conversationId,
    reason: "Salió de Spam",
    summary: `Lo sacaste de Spam. Escribió hace ${days} ${days === 1 ? "día" : "días"}: para responderle hace falta una plantilla.`,
    priority: "media",
    createdBy: "user",
    sourceMessageId: last.messageId,
  })
  return { agentReplies: false, topic: true }
}

/** Bloquear (tablero 5b): sus temas abiertos se resuelven, nadie tiene que atenderlos. */
export async function blockPerson(
  tx: Db,
  orgId: string,
  input: { contactId: string; userId: string; reason: string; note: string },
): Promise<void> {
  await blockContact(tx, orgId, input)
  await settleOpenTopics(tx, orgId, input.contactId, input.userId)
}

/** Desbloquear: puede volver a escribir y el agente la atiende como a cualquiera. */
export async function unblockPerson(tx: Db, orgId: string, input: { contactId: string; userId: string }): Promise<void> {
  await unblockContact(tx, orgId, input)
}

/** Qué hacer con un entrante recién guardado. */
export interface InboundScreen {
  contactId: string
  screen: ContactScreen | null
  /** Está en Spam y escribió algo nuevo: la corrida lo vuelve a mirar (decisión 9a). */
  recheck: boolean
}

/**
 * El worker lo pregunta después de guardar un entrante y antes de encolar la
 * corrida. Aplica la regla de la repetición (decisión 10): el mismo texto
 * `SPAM_REPEAT_COUNT` veces en `SPAM_REPEAT_MINUTES` manda a Spam a quien
 * puede ir solo, y sus temas abiertos se resuelven. A quien ya está en Spam se
 * lo vuelve a mirar solo si el texto es nuevo y no pasó de
 * `SPAM_RECHECKS_PER_DAY`; a un bloqueado, nunca.
 */
export async function screenInbound(
  tx: Db,
  orgId: string,
  input: { conversationId: string; messageId: string },
): Promise<InboundScreen> {
  const [conv] = await tx
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, input.conversationId)))
    .limit(1)
  if (!conv) throw notFound("Conversación")
  const facts = await contactScreenFacts(tx, orgId, conv.contactId)
  if (facts.screen === "blocked") return { contactId: conv.contactId, screen: "blocked", recheck: false }
  const [counts] = await tx.execute<{ text: string; recent_same: number; earlier_same: number }>(sql`
    with this_msg as (
      select ${normalizedBodySql("m")} as text from message m
      where m.organization_id = ${orgId} and m.id = ${input.messageId}
    ), mine as (
      select ${normalizedBodySql("mm")} as text, mm.id, mm.created_at from message mm
      join conversation cv on cv.organization_id = mm.organization_id and cv.id = mm.conversation_id
      where mm.organization_id = ${orgId} and cv.contact_id = ${conv.contactId} and mm.direction = 'in'
        and mm.created_at > now() - interval '30 days'
    )
    select t.text,
      (select count(*)::int from mine where mine.text = t.text
        and mine.created_at > now() - make_interval(mins => ${SPAM_REPEAT_MINUTES})) as recent_same,
      (select count(*)::int from mine where mine.text = t.text and mine.id <> ${input.messageId}) as earlier_same
    from this_msg t`)
  const text = counts?.text ?? ""
  if (facts.screen === null) {
    if (text && (counts?.recent_same ?? 0) >= SPAM_REPEAT_COUNT && autoSpamAllowed(facts)) {
      const changed = await markSpam(tx, orgId, { contactId: conv.contactId, reason: "repeticion", userId: null, messageId: input.messageId })
      if (changed) await settleOpenTopics(tx, orgId, conv.contactId, null)
      return { contactId: conv.contactId, screen: "spam", recheck: false }
    }
    return { contactId: conv.contactId, screen: null, recheck: false }
  }
  // En Spam: solo un texto que no repitió, y no más de lo que se revisa al día.
  if (!text || (counts?.earlier_same ?? 0) > 0) return { contactId: conv.contactId, screen: "spam", recheck: false }
  const rechecks = await spamRechecksToday(tx, orgId, conv.contactId)
  return { contactId: conv.contactId, screen: "spam", recheck: rechecks < SPAM_RECHECKS_PER_DAY }
}

/** Spam automático del modelo de decisión (fase 3): también resuelve sus temas abiertos. */
export async function markSpamByDecision(
  tx: Db,
  orgId: string,
  input: { contactId: string; reason: Exclude<SpamReason, "equipo" | "repeticion">; messageId: string },
): Promise<boolean> {
  const changed = await markSpam(tx, orgId, { contactId: input.contactId, reason: input.reason, userId: null, messageId: input.messageId })
  if (changed) await settleOpenTopics(tx, orgId, input.contactId, null)
  return changed
}
