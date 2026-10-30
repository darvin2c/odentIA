import type { Db } from "@odentia/db"
import { agentActionLog, agentHandoff, agentProposal } from "@odentia/db/schema/agent"
import { conversation } from "@odentia/db/schema/crm"
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm"
import { listProposals, type ProposalItem } from "./agent-operations.js"
import { CONFIRM_TTL_HOURS } from "./proposal-state.js"

/**
 * Lo que el agente hizo con una persona, en palabras, para verlo en el hilo y
 * en la fila de la Bandeja. Sale de tres fuentes: sus propuestas (citas,
 * presupuestos, oportunidades), sus derivaciones y lo que anota al actuar sin
 * propuesta (`agent_action_log`). La pantalla no deduce nada de esto.
 *
 * Los mensajes que escribe no llevan acción: ya se ven como mensajes. Lo que
 * solo consulta no se registra: no cambia nada.
 */
export type AgentActionState = "hecho" | "espera" | "no_se_pudo" | "vencio" | "ya_no_vale"

/** Qué sección de «Contexto» abre: `null` si no hay nada más que ver. */
export type AgentActionOpens = "citas" | "plan" | "datos" | "ventas" | null

export interface AgentActionItem {
  id: string
  at: string
  conversationId: string
  /** Lo que cambia algo que el equipo o la persona van a usar es tarjeta; lo demás, una línea. */
  style: "tarjeta" | "linea"
  /** Lo que hizo, sin el nombre del agente: «reservó una cita». */
  title: string
  what: string | null
  detail: string | null
  state: AgentActionState | null
  opens: AgentActionOpens
  /** La propuesta que espera su sí: quien puede, registra el sí que ya dio. */
  proposalId: string | null
  contactId: string | null
  action: string | null
}

/** Lo que cada rol puede ver de una acción: el detalle de lo que no ve queda en la línea. */
export interface AgentActionCapabilities {
  appointments: boolean
  budgets: boolean
  crm: boolean
  /** Quien no ve al agente sabe que propuso algo, no qué: lo mismo que la Bandeja le dice en la fila. */
  agent: boolean
}

const TITLES: Record<string, { propuesta: string; ejecutada: string; fallida: string; opens: AgentActionOpens; style: "tarjeta" | "linea"; needs: keyof AgentActionCapabilities }> = {
  reservar_cita: { propuesta: "propuso una cita", ejecutada: "reservó una cita", fallida: "no pudo reservar la cita", opens: "citas", style: "tarjeta", needs: "appointments" },
  reprogramar_cita: { propuesta: "propuso mover una cita", ejecutada: "movió una cita", fallida: "no pudo mover la cita", opens: "citas", style: "tarjeta", needs: "appointments" },
  cancelar_cita: { propuesta: "propuso cancelar una cita", ejecutada: "canceló una cita", fallida: "no pudo cancelar la cita", opens: "citas", style: "tarjeta", needs: "appointments" },
  decidir_presupuesto: { propuesta: "propuso anotar su respuesta al presupuesto", ejecutada: "anotó su respuesta al presupuesto", fallida: "no pudo anotar su respuesta al presupuesto", opens: "plan", style: "tarjeta", needs: "budgets" },
  crear_oportunidad: { propuesta: "propuso crear una oportunidad", ejecutada: "creó una oportunidad", fallida: "no pudo crear la oportunidad", opens: "ventas", style: "linea", needs: "crm" },
  mover_oportunidad: { propuesta: "propuso cambiar la etapa de una oportunidad", ejecutada: "cambió la etapa de una oportunidad", fallida: "no pudo cambiar la etapa de la oportunidad", opens: "ventas", style: "linea", needs: "crm" },
  actualizar_seguimiento: { propuesta: "propuso una tarea de seguimiento", ejecutada: "dejó una tarea de seguimiento", fallida: "no pudo dejar la tarea de seguimiento", opens: "ventas", style: "linea", needs: "crm" },
  cerrar_oportunidad: { propuesta: "propuso cerrar una oportunidad", ejecutada: "cerró una oportunidad", fallida: "no pudo cerrar la oportunidad", opens: "ventas", style: "linea", needs: "crm" },
}

/** Cómo se ve lo que anota al actuar sin propuesta. */
const LOGGED: Record<string, { style: "tarjeta" | "linea"; opens: AgentActionOpens; state: AgentActionState | null; needs?: keyof AgentActionCapabilities }> = {
  etiquetas: { style: "linea", opens: null, state: null },
  datos: { style: "linea", opens: "datos", state: null },
  tarea: { style: "linea", opens: "ventas", state: null, needs: "crm" },
  enlace: { style: "linea", opens: null, state: null },
  mensajes: { style: "linea", opens: "datos", state: null },
  portal: { style: "linea", opens: null, state: null },
  comprobante: { style: "tarjeta", opens: null, state: "hecho" },
  presupuesto: { style: "tarjeta", opens: "plan", state: "hecho", needs: "budgets" },
  cita: { style: "tarjeta", opens: "citas", state: "hecho", needs: "appointments" },
}

export const AGENT_ACTION_KINDS = Object.keys(LOGGED)

/** Anota lo que hizo sin propuesta. Una corrida que se reintenta no repite la línea. */
export async function recordAgentAction(
  tx: Db,
  orgId: string,
  input: { conversationId: string; triggerMessageId?: string | null; kind: string; title: string; detail?: string | null },
): Promise<void> {
  await tx
    .insert(agentActionLog)
    .values({
      organizationId: orgId,
      conversationId: input.conversationId,
      triggerMessageId: input.triggerMessageId ?? null,
      kind: input.kind,
      title: input.title.slice(0, 200),
      detail: input.detail ? input.detail.slice(0, 300) : null,
    })
    .onConflictDoNothing()
}

function proposalAt(item: Pick<ProposalItem, "executedAt" | "decidedAt" | "createdAt">): string {
  return item.executedAt ?? item.decidedAt ?? item.createdAt
}

function proposalState(item: ProposalItem): AgentActionState | null {
  if (item.status === "ejecutada" || item.status === "aprobada") return item.context.isStale ? "ya_no_vale" : "hecho"
  if (item.status === "propuesta") return "espera"
  if (item.status === "fallida") return "no_se_pudo"
  if (item.status === "expirada") return "vencio"
  return null
}

function proposalTitle(item: ProposalItem, title: (typeof TITLES)[string]): string {
  const fresh = item.action === "reservar_cita" && item.payload.newPatient !== undefined
  if (item.status === "ejecutada" || item.status === "aprobada") return fresh ? "registró a la persona y reservó su cita" : title.ejecutada
  if (item.status === "fallida") return title.fallida
  return fresh ? "propuso registrar a la persona y reservar su cita" : title.propuesta
}

/** La propuesta en palabras; sin permiso de ver su detalle queda solo la línea. */
function proposalAction(item: ProposalItem, caps: AgentActionCapabilities): AgentActionItem | null {
  const title = TITLES[item.action]
  if (!title) return null
  const state = proposalState(item)
  if (state === null) return null
  const canSee = caps.agent && caps[title.needs]
  const failed = item.error ? item.error.replace(/^[A-Z_]+:\s*/, "") : null
  const who = [item.context.professionalName, item.context.branchName].filter(Boolean).join(" · ")
  return {
    id: item.id,
    at: proposalAt(item),
    conversationId: item.conversationId,
    style: canSee ? title.style : "linea",
    title: proposalTitle(item, title),
    what: canSee ? item.context.afterSummary : null,
    detail: !canSee
      ? null
      : state === "no_se_pudo"
        ? failed
        : item.context.currentSummary && state === "ya_no_vale"
          ? `Hoy: ${item.context.currentSummary}`
          : who || null,
    state,
    opens: canSee ? title.opens : null,
    proposalId: state === "espera" && item.mode === "confirmar_usuario" ? item.id : null,
    contactId: item.contactId,
    action: item.action,
  }
}

/**
 * Todo lo que hizo con esta persona, en todos sus canales, del más antiguo al
 * más reciente. Se pide por persona: el hilo de la Bandeja es la línea de
 * tiempo de todos sus canales.
 */
export async function listAgentActions(
  tx: Db,
  orgId: string,
  conversationId: string,
  caps: AgentActionCapabilities,
  limit = 100,
): Promise<AgentActionItem[]> {
  const [conv] = await tx
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!conv) return []
  const ids = (
    await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(and(eq(conversation.organizationId, orgId), eq(conversation.contactId, conv.contactId)))
  ).map((row) => row.id)
  const proposals = await listProposals(tx, orgId, { contactId: conv.contactId, excludeAction: "enviar_mensaje", proposedBy: "agent", limit })
  const handoffs = await tx
    .select({ id: agentHandoff.id, conversationId: agentHandoff.conversationId, createdAt: agentHandoff.createdAt })
    .from(agentHandoff)
    .where(and(eq(agentHandoff.organizationId, orgId), inArray(agentHandoff.conversationId, ids), eq(agentHandoff.createdBy, "agent")))
    .orderBy(desc(agentHandoff.createdAt))
    .limit(limit)
  const logged = await tx
    .select()
    .from(agentActionLog)
    .where(and(eq(agentActionLog.organizationId, orgId), inArray(agentActionLog.conversationId, ids)))
    .orderBy(desc(agentActionLog.createdAt), asc(agentActionLog.id))
    .limit(limit)
  const items: AgentActionItem[] = [
    ...proposals.flatMap((item) => proposalAction(item, caps) ?? []),
    ...handoffs.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      conversationId: row.conversationId ?? conversationId,
      style: "linea" as const,
      title: "le pasó este tema al equipo",
      what: null,
      detail: null,
      state: null,
      opens: null,
      proposalId: null,
      contactId: conv.contactId,
      action: null,
    })),
    ...logged.map((row): AgentActionItem => {
      const shape = LOGGED[row.kind] ?? { style: "linea" as const, opens: null, state: null }
      const canSee = !shape.needs || caps[shape.needs]
      return {
        id: row.id,
        at: row.createdAt.toISOString(),
        conversationId: row.conversationId,
        style: canSee ? shape.style : "linea",
        title: row.title,
        what: canSee ? row.detail : null,
        detail: null,
        state: canSee ? shape.state : null,
        opens: canSee ? shape.opens : null,
        proposalId: null,
        contactId: conv.contactId,
        action: null,
      }
    }),
  ]
  return items.sort((a, b) => a.at.localeCompare(b.at))
}

/** Lo último que hizo en la conversación, para la segunda línea de la fila. */
export interface LastAgentAction {
  at: string
  title: string
  what: string | null
  state: AgentActionState | null
}

function shortWhat(summary: string | null): string | null {
  return summary ? summary.replace(/^Cita:\s*/, "") : null
}

/**
 * Lo último que hizo por cada conversación. Solo cuenta si la persona no volvió
 * a escribir después: una cita de la semana pasada no explica un mensaje de hoy.
 */
export async function lastAgentActions(tx: Db, orgId: string, conversationIds: string[]): Promise<Map<string, LastAgentAction>> {
  const found = new Map<string, LastAgentAction>()
  if (conversationIds.length === 0) return found
  const inbound = new Map(
    (
      await tx
        .select({ id: conversation.id, lastInboundAt: conversation.lastInboundAt })
        .from(conversation)
        .where(and(eq(conversation.organizationId, orgId), inArray(conversation.id, conversationIds)))
    ).map((row) => [row.id, row.lastInboundAt?.toISOString() ?? null]),
  )
  const put = (conversationId: string, next: LastAgentAction) => {
    const last = inbound.get(conversationId)
    if (last && next.at < last) return
    const current = found.get(conversationId)
    if (!current || current.at < next.at) found.set(conversationId, next)
  }
  // La última de cada conversación: `distinct on` usa el índice de la conversación.
  const proposals = await tx
    .selectDistinctOn([agentProposal.conversationId], {
      conversationId: agentProposal.conversationId,
      action: agentProposal.action,
      status: agentProposal.status,
      afterSummary: agentProposal.afterSummary,
      payload: agentProposal.payload,
      executedAt: agentProposal.executedAt,
      decidedAt: agentProposal.decidedAt,
      createdAt: agentProposal.createdAt,
    })
    .from(agentProposal)
    .where(
      and(
        eq(agentProposal.organizationId, orgId),
        inArray(agentProposal.conversationId, conversationIds),
        ne(agentProposal.action, "enviar_mensaje"),
        eq(agentProposal.proposedBy, "agent"),
        inArray(agentProposal.status, ["propuesta", "ejecutada", "fallida"]),
      ),
    )
    .orderBy(agentProposal.conversationId, sql`coalesce(${agentProposal.executedAt}, ${agentProposal.decidedAt}, ${agentProposal.createdAt}) desc`)
  const deadline = Date.now() - CONFIRM_TTL_HOURS * 3_600_000
  for (const row of proposals) {
    const title = TITLES[row.action]
    if (!title) continue
    // La caducidad es perezosa: una vencida puede seguir `propuesta`, y ya no espera a nadie.
    if (row.status === "propuesta" && row.createdAt.getTime() < deadline) continue
    const state: AgentActionState = row.status === "ejecutada" ? "hecho" : row.status === "propuesta" ? "espera" : "no_se_pudo"
    put(row.conversationId, {
      at: (row.executedAt ?? row.decidedAt ?? row.createdAt).toISOString(),
      title: row.status === "ejecutada" ? title.ejecutada : row.status === "propuesta" ? title.propuesta : title.fallida,
      what: shortWhat(row.afterSummary),
      state,
    })
  }
  const logged = await tx
    .selectDistinctOn([agentActionLog.conversationId], {
      conversationId: agentActionLog.conversationId,
      kind: agentActionLog.kind,
      title: agentActionLog.title,
      detail: agentActionLog.detail,
      createdAt: agentActionLog.createdAt,
    })
    .from(agentActionLog)
    .where(and(eq(agentActionLog.organizationId, orgId), inArray(agentActionLog.conversationId, conversationIds)))
    .orderBy(agentActionLog.conversationId, desc(agentActionLog.createdAt))
  for (const row of logged) {
    put(row.conversationId, { at: row.createdAt.toISOString(), title: row.title, what: row.detail, state: LOGGED[row.kind]?.state ?? null })
  }
  return found
}
