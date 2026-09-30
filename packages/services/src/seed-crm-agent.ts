import type { Db } from "@odentia/db"
import { agentProposal } from "@odentia/db/schema/agent"
import { and, eq, like } from "drizzle-orm"
import { createProposal, decideProposal } from "./agent-operations.js"

/**
 * Semilla de cinco actos comerciales con evidencia real: cuatro propuestas
 * rechazadas y una pendiente. No envía mensajes ni modifica oportunidades.
 * Respeta una sola propuesta comercial pendiente y vigente por conversación
 * (los mensajes fluyen sin bloquear ni ser bloqueados); sustituye solo la
 * propuesta anterior de demostración en ese hilo. Las claves son estables
 * y la política exige aprobación del equipo.
 */
export async function seedCrmAgent(
  tx: Db,
  input: {
    orgId: string
    ownerUserId: string
    conversationId: string
    contactId: string
    opportunityId: string
    stageId: string
  },
): Promise<void> {
  const { orgId, ownerUserId, conversationId, opportunityId, stageId } = input
  const proposals = [
    {
      action: "enviar_mensaje",
      payload: { kind: "text", text: "Hola, te escribimos de la clínica para confirmar tu próxima visita." },
      reason: "Confirmar asistencia por el canal del paciente.",
      idempotencyKey: "seed:crm-agent:enviar-mensaje",
    },
    {
      action: "mover_oportunidad",
      payload: { opportunityId, stageId },
      reason: "El paciente pidió agendar su cita.",
      idempotencyKey: "seed:crm-agent:mover-oportunidad",
    },
    {
      action: "crear_oportunidad",
      payload: { title: "Ortodoncia — seguimiento", interestText: "Interés detectado en el chat." },
      reason: "Nuevo interés comercial del interlocutor.",
      idempotencyKey: "seed:crm-agent:crear-oportunidad",
    },
    {
      action: "actualizar_seguimiento",
      payload: { opportunityId, nextActionNote: "Llamar para confirmar asistencia" },
      reason: "Programar el siguiente contacto comercial.",
      idempotencyKey: "seed:crm-agent:actualizar-seguimiento",
    },
    {
      action: "cerrar_oportunidad",
      payload: { opportunityId, outcome: "won", reason: "Aceptó el plan de tratamiento" },
      reason: "Cierre ganado de ejemplo.",
      idempotencyKey: "seed:crm-agent:cerrar-oportunidad",
    },
  ] as const
  const previous = await tx.select({ id: agentProposal.id }).from(agentProposal).where(and(
    eq(agentProposal.organizationId, orgId), eq(agentProposal.conversationId, conversationId),
    eq(agentProposal.status, "propuesta"), like(agentProposal.idempotencyKey, "seed:agent:propuesta:%"),
  ))
  for (const row of previous) await decideProposal(tx, orgId, ownerUserId, row.id, {
    decision: "rechazada", reason: "Sustituida por el recorrido comercial de demostración",
  })
  for (const proposal of proposals) {
    const [existing] = await tx.select({ id: agentProposal.id }).from(agentProposal)
      .where(and(eq(agentProposal.organizationId, orgId), eq(agentProposal.idempotencyKey, proposal.idempotencyKey))).limit(1)
    if (existing) continue
    const created = await createProposal(tx, orgId, {
      conversationId, ...proposal, payload: { ...proposal.payload },
      proposedBy: "user", actorUserId: ownerUserId,
    })
    if (proposal.action !== "cerrar_oportunidad") await decideProposal(tx, orgId, ownerUserId, created.id, {
      decision: "rechazada", reason: "Demostración de revisión humana; no se aplica el cambio",
    })
  }
}
