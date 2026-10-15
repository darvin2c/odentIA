import type { Db } from "@odentia/db"
import { agentProposal, commercialFollowUpCoordination } from "@odentia/db/schema/agent"
import {
  agentConfig,
  channelConnection,
  conversation,
  crmTask,
  message,
} from "@odentia/db/schema/crm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm"
import {
  createHandoff,
  expireDueProposals,
  getProposal,
  type ProposalItem,
} from "./agent-operations.js"
import { failureRecipient, hasConsent, inQuietHours } from "./automation.js"
import { notFound, ServiceError } from "./errors.js"
import { getOrgLocale } from "./locale.js"
import { getTask } from "./tasks.js"
import { createWorkspaceNotification } from "./workspace.js"

const QUIET_START = "20:00"
const QUIET_END = "08:00"

export interface CommercialCoordinationRun {
  run: true
  coordinationId: string
  conversationId: string
  contactId: string
  triggerId: string
  instruction: string
}

export interface CommercialCoordinationStop {
  run: false
  status: string
  reason: string | null
}

async function audit(
  tx: Db,
  orgId: string,
  id: string,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    action,
    entity: "commercial_follow_up_coordination",
    entityId: id,
    metadata,
  })
}

async function lockCoordination(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(commercialFollowUpCoordination)
    .where(
      and(
        eq(commercialFollowUpCoordination.id, id),
        eq(commercialFollowUpCoordination.organizationId, orgId),
      ),
    )
    .for("update")
    .limit(1)
  if (!row) throw notFound("Coordinación comercial")
  return row
}

async function omitLocked(
  tx: Db,
  row: typeof commercialFollowUpCoordination.$inferSelect,
  reason: string,
): Promise<CommercialCoordinationStop> {
  await tx
    .update(commercialFollowUpCoordination)
    .set({
      status: "omitida",
      reason,
      result: { code: "NO_LONGER_APPLICABLE" },
      nextResponsibleKind: "none",
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(commercialFollowUpCoordination.id, row.id))
  await audit(tx, row.organizationId, row.id, "commercial_follow_up.omitted", {
    taskId: row.taskId,
    opportunityId: row.opportunityId,
    reason,
  })
  return { run: false, status: "omitida", reason }
}

async function deriveLocked(
  tx: Db,
  row: typeof commercialFollowUpCoordination.$inferSelect,
  reason: string,
  summary: string,
  /** `handoff: false`: solo avisa (p. ej. el equipo rechazó la propuesta: ya lo sabe una persona). */
  opts: { handoff?: boolean } = {},
): Promise<CommercialCoordinationStop> {
  const task = await getTask(tx, row.organizationId, row.taskId)
  if (!row.conversationId || opts.handoff === false) {
    // Sin derivación en la cola: el aviso llega al responsable del
    // seguimiento o, si no tiene, a quien administra la organización.
    const recipient = await failureRecipient(tx, row.organizationId, task.assigneeUserId)
    await tx
      .update(commercialFollowUpCoordination)
      .set({
        status: "derivada",
        reason,
        result: { code: "HUMAN_REQUIRED" },
        nextResponsibleKind: recipient ? "user" : "team",
        nextResponsibleUserId: recipient,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(commercialFollowUpCoordination.id, row.id))
    if (recipient) {
      await createWorkspaceNotification(tx, row.organizationId, {
        userId: recipient,
        dedupeKey: `commercial-coordination:${row.id}`,
        title: "Seguimiento comercial requiere intervención",
        body: reason.slice(0, 1000),
        href: `/tasks?task=${row.taskId}`,
        permission: "tasks.read",
      })
    }
    await audit(tx, row.organizationId, row.id, "commercial_follow_up.derived", {
      taskId: row.taskId,
      opportunityId: row.opportunityId,
      reason,
    })
    return { run: false, status: "derivada", reason }
  }
  const handoff = await createHandoff(tx, row.organizationId, null, {
    conversationId: row.conversationId,
    taskId: row.taskId,
    reason,
    summary,
    priority: "media",
    assigneeUserId: task.assigneeUserId,
    createdBy: "agent",
  })
  await tx
    .update(commercialFollowUpCoordination)
    .set({
      status: "derivada",
      reason,
      result: { code: "HUMAN_REQUIRED", handoffId: handoff.id },
      nextResponsibleKind: handoff.assigneeUserId ? "user" : "team",
      nextResponsibleUserId: handoff.assigneeUserId,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(commercialFollowUpCoordination.id, row.id))
  await audit(tx, row.organizationId, row.id, "commercial_follow_up.derived", {
    taskId: row.taskId,
    opportunityId: row.opportunityId,
    handoffId: handoff.id,
    reason,
  })
  return { run: false, status: "derivada", reason }
}

export async function deriveCommercialFollowUpCoordination(
  tx: Db,
  orgId: string,
  id: string,
  reason: string,
  summary = reason,
): Promise<CommercialCoordinationStop> {
  const row = await lockCoordination(tx, orgId, id)
  if (row.status !== "pendiente") return { run: false, status: row.status, reason: row.reason }
  return deriveLocked(tx, row, reason.slice(0, 500), summary.slice(0, 2000))
}

/**
 * Revalida la tarea bajo bloqueo antes de dar contexto al modelo. Actividad
 * equivalente posterior al vencimiento impide un nuevo contacto.
 */
export async function beginCommercialFollowUpCoordination(
  tx: Db,
  orgId: string,
  id: string,
  now: Date,
): Promise<CommercialCoordinationRun | CommercialCoordinationStop> {
  const row = await lockCoordination(tx, orgId, id)
  if (row.status !== "pendiente") return { run: false, status: row.status, reason: row.reason }
  if (row.attempts >= 2) {
    return deriveLocked(
      tx,
      row,
      "La coordinación no pudo completarse tras dos intentos",
      "Revisa manualmente la próxima acción vencida.",
    )
  }
  const [current] = await tx
    .select({
      taskStatus: crmTask.status,
      taskKind: crmTask.kind,
      taskDueAt: crmTask.dueAt,
      taskTitle: crmTask.title,
      taskConversationId: crmTask.conversationId,
      opportunityStatus: opportunity.status,
      opportunityNextActionAt: opportunity.nextActionAt,
      opportunityTitle: opportunity.title,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      agentStatus: conversation.agentStatus,
      channel: channelConnection.channel,
      connectionStatus: channelConnection.status,
      agentEnabled: agentConfig.enabled,
    })
    .from(crmTask)
    .innerJoin(
      opportunity,
      and(
        eq(opportunity.id, crmTask.opportunityId),
        eq(opportunity.organizationId, crmTask.organizationId),
      ),
    )
    .leftJoin(
      conversation,
      and(
        eq(conversation.id, crmTask.conversationId),
        eq(conversation.organizationId, crmTask.organizationId),
      ),
    )
    .leftJoin(
      channelConnection,
      and(
        eq(channelConnection.id, conversation.channelConnectionId),
        eq(channelConnection.organizationId, crmTask.organizationId),
      ),
    )
    .leftJoin(agentConfig, eq(agentConfig.organizationId, crmTask.organizationId))
    .where(and(eq(crmTask.id, row.taskId), eq(crmTask.organizationId, orgId)))
    .limit(1)
  if (!current) return omitLocked(tx, row, "La tarea o la oportunidad ya no existe")
  if (
    current.taskStatus !== "open" ||
    current.taskKind !== "opportunity_follow_up" ||
    current.opportunityStatus !== "open" ||
    !current.taskDueAt ||
    !current.opportunityNextActionAt ||
    current.taskDueAt.getTime() !== row.triggerDueAt.getTime() ||
    current.opportunityNextActionAt.getTime() !== row.triggerDueAt.getTime()
  ) {
    return omitLocked(tx, row, "La próxima acción se resolvió o cambió después del vencimiento")
  }
  if (
    !current.conversationId ||
    current.taskConversationId !== current.conversationId ||
    !current.contactId
  ) {
    return deriveLocked(
      tx,
      row,
      "La conversación vinculada ya no está disponible",
      "Gestiona manualmente la próxima acción vencida.",
    )
  }
  const [recentMessage] = await tx
    .select({ direction: message.direction, status: message.status })
    .from(message)
    .where(
      and(
        eq(message.organizationId, orgId),
        eq(message.conversationId, current.conversationId),
        gte(message.createdAt, row.triggerDueAt),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1)
  if (recentMessage?.direction === "in") {
    return deriveLocked(
      tx,
      row,
      "Existe una respuesta posterior al vencimiento",
      "Revisa la respuesta antes de decidir el siguiente paso.",
    )
  }
  if (recentMessage?.direction === "out" && recentMessage.status !== "failed") {
    return omitLocked(tx, row, "Ya existe una actuación saliente posterior al vencimiento")
  }
  const [proposal] = await tx
    .select({ id: agentProposal.id })
    .from(agentProposal)
    .where(
      and(
        eq(agentProposal.organizationId, orgId),
        eq(agentProposal.conversationId, current.conversationId),
        eq(agentProposal.action, "enviar_mensaje"),
        inArray(agentProposal.status, ["propuesta", "aprobada", "ejecutada"]),
        gte(agentProposal.createdAt, row.triggerDueAt),
      ),
    )
    .limit(1)
  if (proposal) return omitLocked(tx, row, "Ya existe una propuesta o actuación equivalente")
  if (current.agentStatus !== "on" || !current.agentEnabled) {
    return deriveLocked(
      tx,
      row,
      "El agente no está habilitado para este caso",
      "Gestiona manualmente la próxima acción vencida.",
    )
  }
  if (!current.channel || current.connectionStatus !== "active") {
    return deriveLocked(
      tx,
      row,
      "El canal ya no está disponible",
      "Elige un canal válido o gestiona manualmente el seguimiento.",
    )
  }
  if (!(await hasConsent(tx, orgId, current.contactId, "seguimiento"))) {
    return deriveLocked(
      tx,
      row,
      "El consentimiento de seguimiento fue revocado o no existe",
      "No contactes automáticamente; revisa una alternativa autorizada.",
    )
  }
  const locale = await getOrgLocale(tx, orgId)
  if (inQuietHours(now, locale.timezone, QUIET_START, QUIET_END)) {
    return deriveLocked(
      tx,
      row,
      "La ejecución cayó fuera del horario permitido",
      "Gestiona el seguimiento dentro del horario de atención.",
    )
  }
  await tx
    .update(commercialFollowUpCoordination)
    .set({ attempts: row.attempts + 1, updatedAt: now })
    .where(eq(commercialFollowUpCoordination.id, row.id))
  return {
    run: true,
    coordinationId: row.id,
    conversationId: current.conversationId,
    contactId: current.contactId,
    triggerId: row.id,
    instruction: [
      "Coordinación interna: no es un mensaje nuevo del interlocutor.",
      `La próxima acción comercial «${current.taskTitle}» de la oportunidad «${current.opportunityTitle}» venció.`,
      "Reevalúa el contexto vigente. Solo puedes proponer un mensaje de seguimiento o derivar a una persona.",
      "No reserves, muevas, cierres ni reprogrames entidades. No programes otra reiteración automática.",
      "Debes usar una herramienta terminal; no respondas con texto sin registrar una decisión.",
    ].join("\n"),
  }
}

export async function recordCommercialFollowUpProposal(
  tx: Db,
  orgId: string,
  coordinationId: string,
  proposal: ProposalItem,
): Promise<void> {
  const row = await lockCoordination(tx, orgId, coordinationId)
  // `pendiente`: el agente acaba de proponer; `propuesta`: el equipo decide
  // después (también en el caso proactivo sin conversación).
  if (row.status !== "pendiente" && row.status !== "propuesta") return
  const terminal = ["fallida", "expirada", "rechazada"].includes(proposal.status)
  // Sigue esperando al equipo: nada nuevo que registrar.
  if (row.status === "propuesta" && !terminal && proposal.status !== "ejecutada") return
  if (terminal) {
    // Si entre tanto alguien atendió o reprogramó el seguimiento, no hay nada
    // que derivar: la coordinación deja de aplicar.
    if (row.status === "propuesta" && !(await followUpStillDue(tx, row))) {
      await omitLocked(tx, row, "La próxima acción se resolvió o cambió después del vencimiento")
      return
    }
    await deriveLocked(
      tx,
      row,
      `La propuesta de seguimiento quedó ${proposal.status}`,
      proposal.error?.trim() || "Revisa manualmente la próxima acción vencida.",
      // Un rechazo tardío ya lo decidió una persona: no abre una derivación
      // ni apaga el agente del hilo; caducidad y fallo sí necesitan a alguien.
      { handoff: !(row.status === "propuesta" && proposal.status === "rechazada") },
    )
    return
  }
  const executed = proposal.status === "ejecutada"
  const messageId =
    typeof proposal.result?.messageId === "string" ? proposal.result.messageId : null
  await tx
    .update(commercialFollowUpCoordination)
    .set({
      status: executed ? "ejecutada" : "propuesta",
      reason: proposal.reason,
      result: {
        proposalId: proposal.id,
        proposalStatus: proposal.status,
        ...(messageId ? { messageId } : {}),
      },
      nextResponsibleKind: executed ? "contact" : "team",
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(commercialFollowUpCoordination.id, row.id))
  await audit(
    tx,
    orgId,
    row.id,
    executed ? "commercial_follow_up.executed" : "commercial_follow_up.proposed",
    {
      taskId: row.taskId,
      opportunityId: row.opportunityId,
      proposalId: proposal.id,
      messageId,
    },
  )
}

/**
 * Cierra las coordinaciones que esperan al equipo cuya propuesta ya terminó
 * sin pasar por la decisión (caducó a las 48 h, o falló/se resolvió por otra
 * vía): el seguimiento no puede quedar esperando a nadie. Lo invoca el tick.
 */
export async function reconcileProposedCoordinations(tx: Db, orgId: string): Promise<number> {
  await expireDueProposals(tx, orgId)
  const rows = await tx.execute<{ id: string; proposal_id: string }>(sql`
    select c.id, p.id as proposal_id
    from commercial_follow_up_coordination c
    join agent_proposal p
      on p.organization_id = c.organization_id and p.id::text = c.result->>'proposalId'
    where c.organization_id = ${orgId} and c.status = 'propuesta'
      and p.status in ('ejecutada', 'fallida', 'expirada', 'rechazada')
    order by c.created_at limit 25`)
  for (const row of rows) {
    const proposal = await getProposal(tx, orgId, row.proposal_id)
    await closeProposedCoordination(tx, orgId, row.id, proposal)
  }
  return rows.length
}

/** La tarea y la oportunidad siguen esperando la misma próxima acción vencida. */
async function followUpStillDue(
  tx: Db,
  row: typeof commercialFollowUpCoordination.$inferSelect,
): Promise<boolean> {
  const [current] = await tx
    .select({
      taskStatus: crmTask.status,
      taskDueAt: crmTask.dueAt,
      opportunityStatus: opportunity.status,
      nextActionAt: opportunity.nextActionAt,
    })
    .from(crmTask)
    .innerJoin(
      opportunity,
      and(
        eq(opportunity.id, crmTask.opportunityId),
        eq(opportunity.organizationId, crmTask.organizationId),
      ),
    )
    .where(and(eq(crmTask.id, row.taskId), eq(crmTask.organizationId, row.organizationId)))
    .limit(1)
  const due = row.triggerDueAt.getTime()
  return (
    current?.taskStatus === "open" &&
    current.opportunityStatus === "open" &&
    current.taskDueAt?.getTime() === due &&
    current.nextActionAt?.getTime() === due
  )
}

/**
 * Cierra la coordinación con el desenlace de su propuesta sin poner en riesgo
 * a quien llama (la decisión del equipo o el tick): si el cierre choca con una
 * regla de dominio, se deshace y queda derivada al equipo con el motivo.
 */
export async function closeProposedCoordination(
  tx: Db,
  orgId: string,
  coordinationId: string,
  proposal: ProposalItem,
): Promise<void> {
  await tx.execute(sql.raw("SAVEPOINT sp_coordination_close"))
  try {
    await recordCommercialFollowUpProposal(tx, orgId, coordinationId, proposal)
    await tx.execute(sql.raw("RELEASE SAVEPOINT sp_coordination_close"))
  } catch (error) {
    await tx.execute(sql.raw("ROLLBACK TO SAVEPOINT sp_coordination_close"))
    await tx.execute(sql.raw("RELEASE SAVEPOINT sp_coordination_close"))
    if (!(error instanceof ServiceError)) throw error
    const reason = `La propuesta de seguimiento quedó ${proposal.status}`
    const [pending] = await tx
      .select({ taskId: commercialFollowUpCoordination.taskId })
      .from(commercialFollowUpCoordination)
      .where(
        and(
          eq(commercialFollowUpCoordination.id, coordinationId),
          eq(commercialFollowUpCoordination.organizationId, orgId),
        ),
      )
      .limit(1)
    const [task] = pending
      ? await tx
          .select({ assigneeUserId: crmTask.assigneeUserId })
          .from(crmTask)
          .where(and(eq(crmTask.id, pending.taskId), eq(crmTask.organizationId, orgId)))
          .limit(1)
      : []
    const who = await failureRecipient(tx, orgId, task?.assigneeUserId ?? null)
    const [row] = await tx
      .update(commercialFollowUpCoordination)
      .set({
        status: "derivada",
        reason,
        result: { code: "HUMAN_REQUIRED", proposalId: proposal.id, detail: error.message.slice(0, 300) },
        nextResponsibleKind: who ? "user" : "team",
        nextResponsibleUserId: who,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(commercialFollowUpCoordination.id, coordinationId),
          eq(commercialFollowUpCoordination.organizationId, orgId),
          eq(commercialFollowUpCoordination.status, "propuesta"),
        ),
      )
      .returning()
    if (row) {
      if (who) {
        await createWorkspaceNotification(tx, orgId, {
          userId: who,
          dedupeKey: `commercial-coordination:${row.id}`,
          title: "Seguimiento comercial requiere intervención",
          body: reason,
          href: `/tasks?task=${row.taskId}`,
          permission: "tasks.read",
        })
      }
      await audit(tx, orgId, row.id, "commercial_follow_up.derived", {
        taskId: row.taskId,
        opportunityId: row.opportunityId,
        reason,
      })
    }
  }
}

/** Un timeout de proveedor deja el caso para conciliación; jamás reencola el envío. */
export async function markCommercialFollowUpUncertain(
  tx: Db,
  orgId: string,
  messageId: string,
  reason: string,
): Promise<void> {
  const rows = await tx
    .update(commercialFollowUpCoordination)
    .set({
      status: "incierta",
      reason,
      nextResponsibleKind: "team",
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(commercialFollowUpCoordination.organizationId, orgId),
        sql`${commercialFollowUpCoordination.result}->>'messageId' = ${messageId}`,
      ),
    )
    .returning({
      id: commercialFollowUpCoordination.id,
      taskId: commercialFollowUpCoordination.taskId,
    })
  for (const row of rows) {
    const task = await getTask(tx, orgId, row.taskId)
    // Sin responsable del seguimiento, lo recibe quien administra: un envío
    // de resultado incierto no puede quedar sin que nadie lo sepa.
    const who = await failureRecipient(tx, orgId, task.assigneeUserId)
    await tx
      .update(commercialFollowUpCoordination)
      .set({
        nextResponsibleKind: who ? "user" : "team",
        nextResponsibleUserId: who,
      })
      .where(eq(commercialFollowUpCoordination.id, row.id))
    if (who) {
      await createWorkspaceNotification(tx, orgId, {
        userId: who,
        dedupeKey: `commercial-coordination-uncertain:${row.id}`,
        title: "Envío pendiente de conciliación",
        body: "El proveedor pudo recibir el mensaje, pero no confirmó el resultado. No lo reenvíes sin comprobarlo.",
        href: `/tasks?task=${task.id}`,
        permission: "tasks.read",
      })
    }
    await audit(tx, orgId, row.id, "commercial_follow_up.uncertain", { messageId, reason })
  }
}
