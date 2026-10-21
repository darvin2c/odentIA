import type { Db } from "@odentia/db"
import { agentConfig, contact, conversation, message } from "@odentia/db/schema/crm"
import { and, desc, eq, sql } from "drizzle-orm"
import { sendOutbound } from "./conversations.js"
import { proposalPendingSql } from "./proposal-state.js"

/**
 * Lo que dice Sofi cuando la persona reacciona (👍) al mensaje que le propone
 * una cita: una reacción es ambigua y confirmar tiene consecuencias, así que
 * no confirma nada (decisión 7 de la Bandeja); le pide el «sí» con un texto
 * fijo, sin gastar una corrida del modelo.
 */
export const REACTION_CONFIRM_TEXT = "¡Genial! Para dejarla reservada, respóndeme «sí» por aquí."
/** El mismo pedido cuando la clínica trata de «usted». */
export const REACTION_CONFIRM_TEXT_USTED = "¡Genial! Para dejarla reservada, respóndame «sí» por aquí."

/** Ventana de WhatsApp y Meta: pasadas 24 horas de su último mensaje no se le escribe libremente. */
const WINDOW_MS = 24 * 3_600_000

/**
 * La persona reaccionó al último mensaje de la clínica mientras una cita
 * propuesta espera su sí: se le pide el sí una sola vez. No hace nada si la
 * reacción se quitó, si el mensaje era suyo o no es el último que le
 * escribieron, si lo que espera no es reservar una cita (cancelar, mover o un
 * presupuesto no se piden con un pulgar), si está en Spam o bloqueada, si la
 * conversación no la atiende el agente, si pasaron las 24 horas o si ya se le
 * pidió. Devuelve si se le escribió.
 */
export async function askConfirmationAfterReaction(
  tx: Db,
  orgId: string,
  input: { conversationId: string; messageId: string; emoji: string | null },
): Promise<boolean> {
  if (!input.emoji) return false
  const [state] = await tx
    .select({
      direction: message.direction,
      status: conversation.status,
      agentStatus: conversation.agentStatus,
      lastInboundAt: conversation.lastInboundAt,
      pending: sql<boolean>`exists (select 1 from agent_proposal p_r
        where p_r.organization_id = ${orgId} and p_r.conversation_id = "conversation"."id"
          and p_r.action = 'reservar_cita' and ${proposalPendingSql(sql.raw("p_r"))})`,
      enabled: agentConfig.enabled,
      treatment: agentConfig.treatment,
      screen: contact.screen,
    })
    .from(message)
    .innerJoin(
      conversation,
      and(eq(conversation.id, message.conversationId), eq(conversation.organizationId, orgId)),
    )
    .innerJoin(contact, eq(contact.id, conversation.contactId))
    .leftJoin(agentConfig, eq(agentConfig.organizationId, orgId))
    .where(
      and(
        eq(message.id, input.messageId),
        eq(message.organizationId, orgId),
        eq(message.conversationId, input.conversationId),
      ),
    )
    .limit(1)
  if (!state || state.direction !== "out" || !state.pending || state.screen !== null) return false
  if (state.status !== "open" || state.agentStatus !== "on" || !state.enabled) return false
  if (!state.lastInboundAt || Date.now() - state.lastInboundAt.getTime() > WINDOW_MS) return false
  // Una sola vez: si lo último que dijo la clínica ya es este pedido, no se repite.
  const [last] = await tx
    .select({ id: message.id, body: message.body })
    .from(message)
    .where(
      and(
        eq(message.organizationId, orgId),
        eq(message.conversationId, input.conversationId),
        eq(message.direction, "out"),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1)
  // Solo sobre el último mensaje de la clínica, el que le propone la cita: un 👍 a un saludo de antes no pide nada.
  if (!last || last.id !== input.messageId || last.body === REACTION_CONFIRM_TEXT || last.body === REACTION_CONFIRM_TEXT_USTED) return false
  await sendOutbound(tx, orgId, {
    conversationId: input.conversationId,
    senderKind: "agent",
    content: { type: "text", text: state.treatment === "usted" ? REACTION_CONFIRM_TEXT_USTED : REACTION_CONFIRM_TEXT },
  })
  return true
}
