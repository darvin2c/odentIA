import type { Db } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { agentConfig, channelConnection } from "@odentia/db/schema/crm"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import {
  countAgentModelRunsToday,
  countPendingProposals,
  getAutonomyPolicy,
  updateAutonomyPolicy,
} from "./agent-operations.js"
import { countLearningPending } from "./agent-learning.js"
import { AGENT_LEVEL_POLICY, AGENT_LEVELS, type AgentLevel, levelOfPolicy } from "./agent-roles.js"
import { getAgentConfig } from "./agentConfig.js"
import { validation } from "./errors.js"
import { countOpenKnowledgeGaps, getClinicInfoSnapshot, getKnowledgeBasics, listActiveKnowledge } from "./knowledge.js"
import { getOrgLocale } from "./locale.js"

/* ---------- Resumen del agente: cómo va y qué necesita de la clínica ---------- */

export interface AgentOutcomes {
  /** Conversaciones en las que el agente respondió o derivó en el periodo. */
  attended: number
  /** De esas, las que pasó a una persona o en las que alguien del equipo escribió. */
  passed: number
  /** Las demás: las llevó sin intervención del equipo en el periodo. */
  alone: number
  /** Citas reservadas por el agente sin que nadie del equipo las aprobara. */
  booked: number
}

export interface AgentOverview {
  enabled: boolean
  level: AgentLevel | "personalizado"
  /** `review` y `lessons`: respuestas por revisar y lecciones por aprobar en Aprender. */
  needsYou: { approvals: number; gaps: number; basicsMissing: number; review: number; lessons: number }
  today: AgentOutcomes
  week: AgentOutcomes
  knows: { answers: number; servicesWithPrice: number; branches: number; basicsCovered: number; basicsTotal: number }
  /** Comprobaciones para encender el agente; ninguna lo impide, todas dicen qué falta. */
  readiness: {
    channels: string[]
    receivers: string[]
    sandboxTurns: number
  }
  /** Corridas con llamada al modelo hoy frente al tope diario. */
  usage: { runsToday: number; dailyRunLimit: number }
}

/**
 * Resultado por conversación, no por mensaje. Una conversación cuenta como
 * pasada a una persona si en el periodo hubo una derivación o alguien del
 * equipo escribió en ella; el resto las llevó el agente. Es lo que pasó en el
 * periodo: no afirma que el caso quedara resuelto.
 */
async function agentOutcomes(tx: Db, orgId: string, since: Date): Promise<AgentOutcomes> {
  // En SQL crudo el driver no serializa `Date`: el instante viaja como texto ISO.
  const at = since.toISOString()
  const [row] = await tx.execute<{ attended: number; passed: number; booked: number }>(sql`
    with attended as (
      select distinct conversation_id as id from agent_run_ledger
      where organization_id = ${orgId} and conversation_id is not null
        and started_at >= ${at}::timestamptz and status in ('ok', 'handoff')
    ), passed as (
      select a.id from attended a
      where exists (
        select 1 from agent_handoff h
        where h.organization_id = ${orgId} and h.conversation_id = a.id and h.created_at >= ${at}::timestamptz)
      or exists (
        select 1 from message m
        where m.organization_id = ${orgId} and m.conversation_id = a.id
          and m.direction = 'out' and m.sender_kind = 'user' and m.created_at >= ${at}::timestamptz)
    )
    select (select count(*)::int from attended) as attended,
           (select count(*)::int from passed) as passed,
           (select count(*)::int from agent_proposal p
             where p.organization_id = ${orgId} and p.action = 'reservar_cita' and p.status = 'ejecutada'
               and p.executed_at >= ${at}::timestamptz and (p.decided_by = 'agent' or p.decided_by like 'contact:%')) as booked`)
  const attended = Number(row?.attended ?? 0)
  const passed = Number(row?.passed ?? 0)
  return { attended, passed, alone: attended - passed, booked: Number(row?.booked ?? 0) }
}

/** Inicio del día de hoy en la zona de la clínica, como instante. */
async function startOfOrgDay(tx: Db, timezone: string): Promise<Date> {
  const [row] = await tx.execute<{ start: Date | string }>(
    sql`select (date_trunc('day', now() at time zone ${timezone}) at time zone ${timezone}) as start`,
  )
  return new Date(row?.start ?? Date.now())
}

export async function getAgentOverview(tx: Db, orgId: string): Promise<AgentOverview> {
  const cfg = await getAgentConfig(tx, orgId)
  const zone = await getOrgLocale(tx, orgId)
  const policy = await getAutonomyPolicy(tx, orgId)
  const pending = await countPendingProposals(tx, orgId)
  const basics = await getKnowledgeBasics(tx, orgId)
  const snapshot = await getClinicInfoSnapshot(tx, orgId)
  const connections = await tx
    .selectDistinct({ channel: channelConnection.channel })
    .from(channelConnection)
    .where(and(eq(channelConnection.organizationId, orgId), eq(channelConnection.status, "active")))
    .orderBy(asc(channelConnection.channel))
  // Quienes pueden decidir por el agente y tomar una derivación.
  const receivers = await tx
    .select({ name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin", "reception"])))
    .orderBy(asc(user.name))
    .limit(6)
  const [turns] = await tx
    .select({ sandboxTurns: agentConfig.sandboxTurns })
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  return {
    enabled: cfg.enabled,
    level: levelOfPolicy(policy),
    needsYou: {
      approvals: pending.team,
      gaps: await countOpenKnowledgeGaps(tx, orgId),
      basicsMissing: basics.total - basics.covered,
      ...(await countLearningPending(tx, orgId)),
    },
    today: await agentOutcomes(tx, orgId, await startOfOrgDay(tx, zone.timezone)),
    week: await agentOutcomes(tx, orgId, new Date(Date.now() - 7 * 86_400_000)),
    knows: {
      answers: (await listActiveKnowledge(tx, orgId)).length,
      servicesWithPrice: snapshot.services.filter((service) => service.priceCents > 0).length,
      branches: snapshot.branches.length,
      basicsCovered: basics.covered,
      basicsTotal: basics.total,
    },
    readiness: {
      channels: connections.map((row) => row.channel),
      receivers: receivers.map((row) => row.name),
      sandboxTurns: turns?.sandboxTurns ?? 0,
    },
    usage: { runsToday: await countAgentModelRunsToday(tx, orgId), dailyRunLimit: cfg.dailyRunLimit },
  }
}

/** Fija «hasta dónde llega solo»: cada nivel es una política de autonomía completa. */
export async function setAgentLevel(tx: Db, orgId: string, actorUserId: string, level: string) {
  if (!(AGENT_LEVELS as readonly string[]).includes(level)) throw validation("Nivel desconocido")
  return updateAutonomyPolicy(tx, orgId, actorUserId, AGENT_LEVEL_POLICY[level as AgentLevel])
}

/** Cuenta un mensaje de prueba: solo sirve para saber si la clínica ya probó a su agente. */
export async function noteSandboxTurn(tx: Db, orgId: string): Promise<void> {
  await tx
    .insert(agentConfig)
    .values({ organizationId: orgId, sandboxTurns: 1 })
    .onConflictDoUpdate({
      target: agentConfig.organizationId,
      set: { sandboxTurns: sql`${agentConfig.sandboxTurns} + 1` },
    })
}
