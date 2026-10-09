import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"

/**
 * Actividad legible del agente para recepción: qué envió (y si llegó a
 * salir), qué propuso (y en qué quedó) y a quién derivó, con enlace al caso.
 * No es el libro técnico de corridas (modelo, tokens): ese sigue en
 * Agente › Actividad.
 *
 * Todo mensaje del agente nace de una propuesta `enviar_mensaje` ejecutada,
 * así que el feed se alimenta solo de propuestas y derivaciones suyas; no se
 * leen mensajes por `sender_kind`, que también usan automatizaciones y portal.
 */
export interface AgentActivityItem {
  id: string
  kind: "mensaje" | "propuesta" | "derivacion"
  at: string
  conversationId: string | null
  contactName: string | null
  /** Qué hizo, en una línea. */
  title: string
  /** Detalle breve (texto enviado recortado, cambio previsto, motivo). */
  detail: string | null
  /**
   * Estado de la propuesta o de la derivación; en mensajes, el estado de
   * entrega (`queued|sent|delivered|read|failed|unknown`).
   */
  status: string | null
}

const ACTION_TITLE: Record<string, string> = {
  reservar_cita: "Propuso reservar una cita",
  reprogramar_cita: "Propuso reprogramar una cita",
  cancelar_cita: "Propuso cancelar una cita",
  enviar_mensaje: "Preparó un mensaje",
  mover_oportunidad: "Propuso cambiar la etapa comercial",
  crear_oportunidad: "Propuso crear una oportunidad",
  actualizar_seguimiento: "Propuso programar un seguimiento",
  cerrar_oportunidad: "Propuso cerrar una oportunidad",
}

/** Un envío ejecutado se cuenta como mensaje y se titula según su entrega real. */
const MESSAGE_TITLE: Record<string, string> = {
  sent: "Envió un mensaje",
  delivered: "Envió un mensaje",
  read: "Envió un mensaje",
  queued: "Mensaje pendiente de envío",
  failed: "No pudo enviar un mensaje",
  unknown: "Envío de resultado incierto",
}

export async function listAgentActivity(
  tx: Db,
  orgId: string,
  input: { limit?: number } = {},
): Promise<AgentActivityItem[]> {
  const limit =
    input.limit === undefined || !Number.isFinite(input.limit)
      ? 50
      : Math.min(Math.max(Math.floor(input.limit), 1), 100)
  const rows = await tx.execute<{
    id: string
    kind: "propuesta" | "derivacion"
    at: Date | string
    conversation_id: string | null
    contact_name: string | null
    action: string | null
    detail: string | null
    status: string | null
    message_status: string | null
  }>(sql`
    (select p.id, 'propuesta' as kind, coalesce(p.executed_at, p.decided_at, p.created_at) as at, p.conversation_id,
            c.display_name as contact_name, p.action, left(p.after_summary, 160) as detail, p.status,
            m.status as message_status
       from agent_proposal p
       left join contact c on c.id = p.contact_id
       left join message m on p.action = 'enviar_mensaje' and p.status = 'ejecutada'
            and m.organization_id = p.organization_id and m.id::text = p.result->>'messageId'
      where p.organization_id = ${orgId} and p.proposed_by = 'agent'
      order by coalesce(p.executed_at, p.decided_at, p.created_at) desc limit ${limit})
    union all
    (select h.id, 'derivacion' as kind, h.created_at as at, h.conversation_id, c.display_name as contact_name,
            null as action, left(h.reason, 160) as detail,
            case when t.id is not null and t.status <> 'open' then 'resuelta' when h.assignee_user_id is not null then 'tomada' else 'abierta' end as status,
            null as message_status
       from agent_handoff h left join contact c on c.id = h.contact_id
       left join task t on t.id = h.task_id and t.organization_id = h.organization_id
      where h.organization_id = ${orgId} and h.created_by = 'agent'
      order by h.created_at desc limit ${limit})
    order by at desc limit ${limit}`)
  return rows.map((r) => {
    const sent = r.kind === "propuesta" && r.action === "enviar_mensaje" && r.status === "ejecutada"
    // Ejecutada sin mensaje vinculado: quedó encolada o el vínculo no existe; no afirmar entrega.
    const messageStatus = sent ? (r.message_status ?? "queued") : null
    return {
      id: r.id,
      kind: sent ? "mensaje" : r.kind,
      at: r.at instanceof Date ? r.at.toISOString() : new Date(r.at).toISOString(),
      conversationId: r.conversation_id,
      contactName: r.contact_name,
      title: sent
        ? (MESSAGE_TITLE[messageStatus ?? ""] ?? MESSAGE_TITLE.unknown)
        : r.kind === "derivacion"
          ? "Derivó el caso al equipo"
          : (ACTION_TITLE[r.action ?? ""] ?? "Propuso un cambio"),
      detail: r.detail,
      status: sent ? messageStatus : r.status,
    }
  })
}
