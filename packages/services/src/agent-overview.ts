import type { Db } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { agentLesson } from "@odentia/db/schema/agent"
import { agentConfig, channelConnection } from "@odentia/db/schema/crm"
import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm"
import { countAgentModelRunsToday } from "./agent-operations.js"
import { countLearningPending } from "./agent-learning.js"
import { getAgentConfig } from "./agentConfig.js"
import { countOpenKnowledgeGaps, getClinicInfoSnapshot, getKnowledgeBasics, listActiveKnowledge } from "./knowledge.js"
import { getOrgLocale } from "./locale.js"

/* ---------- Resumen del agente: cómo va y qué necesita de la clínica ---------- */

export interface AgentOutcomes {
  /** Conversaciones en las que el agente respondió o derivó en el periodo. */
  attended: number
  /** De esas, las que tienen una respuesta que alguien del equipo corrigió en el periodo. */
  corrected: number
  /** De las no corregidas, las que pasó a una persona o en las que alguien del equipo escribió. */
  passed: number
  /** Las demás: las llevó sin intervención del equipo en el periodo. */
  alone: number
  /** Citas reservadas por el agente sin que nadie del equipo las aprobara. */
  booked: number
}

/** Lo aprobado en el periodo que sigue vigente, por tipo de lección. */
export interface AgentLearned {
  officialAnswers: number
  rules: number
  examples: number
  /** La última aprobada; quién y cuándo, para decirlo con palabras de la pantalla. */
  latest: { title: string; approvedByName: string | null; approvedAt: string } | null
}

/**
 * Por qué el agente no puede responder ahora, si su último intento de usar el
 * modelo terminó con un problema del proveedor que no se arregla reintentando.
 * Es la clase del problema, nunca el texto del proveedor.
 */
export type AgentProviderProblem = "rechazado" | "sin_saldo" | "sin_configurar"

export interface AgentOverview {
  enabled: boolean
  /**
   * `review` y `lessons`: respuestas por revisar y lecciones por aprobar en
   * Aprender. Los casos que pasó el agente no se cuentan aquí: su único
   * contador es el del menú (`getAgentPanelSummary`).
   */
  needsYou: { gaps: number; basicsMissing: number; review: number; lessons: number }
  today: AgentOutcomes
  week: AgentOutcomes
  /** Lo que aprendió en los últimos siete días. */
  learned: AgentLearned
  /** `at`: cuándo falló ese último intento. */
  provider: { problem: AgentProviderProblem | null; at: string | null }
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
 * Resultado por conversación, no por mensaje, en tres tramos que no se
 * solapan. Corregida: alguien del equipo corrigió en el periodo una respuesta
 * de esa conversación (o cambió su borrador al aprobarlo). Pasada a una
 * persona: no se corrigió, pero hubo una derivación o alguien del equipo
 * escribió en ella. El resto las llevó el agente. Es lo que pasó en el
 * periodo: no afirma que el caso quedara resuelto.
 */
async function agentOutcomes(tx: Db, orgId: string, since: Date): Promise<AgentOutcomes> {
  // En SQL crudo el driver no serializa `Date`: el instante viaja como texto ISO.
  const at = since.toISOString()
  const [row] = await tx.execute<{ attended: number; corrected: number; passed: number; booked: number }>(sql`
    with attended as (
      select distinct conversation_id as id from agent_run_ledger
      where organization_id = ${orgId} and conversation_id is not null
        and started_at >= ${at}::timestamptz and status in ('ok', 'handoff')
    ), corrected as (
      select a.id from attended a
      where exists (
        select 1 from agent_review_item r
        where r.organization_id = ${orgId} and r.conversation_id = a.id
          and r.status = 'corregida' and r.decided_at >= ${at}::timestamptz)
    ), passed as (
      select a.id from attended a
      where a.id not in (select id from corrected) and (exists (
        select 1 from agent_handoff h
        where h.organization_id = ${orgId} and h.conversation_id = a.id and h.created_at >= ${at}::timestamptz)
      or exists (
        select 1 from message m
        where m.organization_id = ${orgId} and m.conversation_id = a.id
          and m.direction = 'out' and m.sender_kind = 'user' and m.created_at >= ${at}::timestamptz))
    )
    select (select count(*)::int from attended) as attended,
           (select count(*)::int from corrected) as corrected,
           (select count(*)::int from passed) as passed,
           (select count(*)::int from agent_proposal p
             where p.organization_id = ${orgId} and p.action = 'reservar_cita' and p.status = 'ejecutada'
               and p.executed_at >= ${at}::timestamptz and (p.decided_by = 'agent' or p.decided_by like 'contact:%')) as booked`)
  const attended = Number(row?.attended ?? 0)
  const corrected = Number(row?.corrected ?? 0)
  const passed = Number(row?.passed ?? 0)
  return { attended, corrected, passed, alone: attended - corrected - passed, booked: Number(row?.booked ?? 0) }
}

/**
 * Lo aprobado desde `since` que sigue activo: una lección retirada o descartada
 * ya no es algo que el agente sepa. Dos consultas cortas sobre las lecciones;
 * no arma las fichas completas de «Aprender».
 */
async function learnedSince(tx: Db, orgId: string, since: Date): Promise<AgentLearned> {
  const approved = and(eq(agentLesson.organizationId, orgId), eq(agentLesson.status, "activa"), gte(agentLesson.approvedAt, since))
  const kinds = await tx.select({ kind: agentLesson.kind, total: count() }).from(agentLesson).where(approved).groupBy(agentLesson.kind)
  const of = (kind: string) => kinds.find((row) => row.kind === kind)?.total ?? 0
  const [latest] = await tx
    .select({ title: agentLesson.title, approvedAt: agentLesson.approvedAt, approvedByName: user.name })
    .from(agentLesson)
    .leftJoin(user, eq(user.id, agentLesson.approvedBy))
    .where(approved)
    .orderBy(desc(agentLesson.approvedAt))
    .limit(1)
  return {
    officialAnswers: of("respuesta_oficial"),
    rules: of("regla"),
    examples: of("ejemplo"),
    latest: latest?.approvedAt
      ? { title: latest.title, approvedByName: latest.approvedByName, approvedAt: latest.approvedAt.toISOString() }
      : null,
  }
}

/** Códigos con los que la corrida registra un problema del proveedor (`CÓDIGO: detalle` en `error`). */
const PROVIDER_PROBLEM_OF: Record<string, AgentProviderProblem> = {
  PROVIDER_REJECTED: "rechazado",
  PROVIDER_QUOTA: "sin_saldo",
  API_KEY_REQUIRED: "sin_configurar",
}

/**
 * ¿El proveedor del modelo sirve ahora? Lo dice el último intento real de
 * usarlo: una corrida que llamó al modelo, o una que terminó en error. Si fue
 * un problema del proveedor y nadie cambió la configuración del agente después,
 * sigue sin poder responder. El tope diario no es un problema del proveedor y
 * tiene su propio aviso. Sin corridas no se afirma nada; y un arreglo hecho
 * fuera de esta configuración (la credencial de la plataforma) solo se nota
 * con la siguiente corrida.
 */
async function providerProblem(tx: Db, orgId: string): Promise<AgentOverview["provider"]> {
  const [last] = await tx.execute<{ status: string; error: string | null; started_at: Date | string; stale: boolean }>(sql`
    select l.status, l.error, l.started_at,
           exists (select 1 from agent_config c where c.organization_id = ${orgId} and c.updated_at > l.started_at) as stale
    from agent_run_ledger l
    where l.organization_id = ${orgId} and (l.status = 'error' or l.llm_calls > 0)
    order by l.started_at desc limit 1`)
  if (!last || last.status !== "error" || last.stale) return { problem: null, at: null }
  const problem = PROVIDER_PROBLEM_OF[(last.error ?? "").split(":")[0] ?? ""] ?? null
  return problem ? { problem, at: new Date(last.started_at).toISOString() } : { problem: null, at: null }
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
  const weekAgo = new Date(Date.now() - 7 * 86_400_000)
  return {
    enabled: cfg.enabled,
    needsYou: {
      gaps: await countOpenKnowledgeGaps(tx, orgId),
      basicsMissing: basics.total - basics.covered,
      ...(await countLearningPending(tx, orgId)),
    },
    today: await agentOutcomes(tx, orgId, await startOfOrgDay(tx, zone.timezone)),
    week: await agentOutcomes(tx, orgId, weekAgo),
    learned: await learnedSince(tx, orgId, weekAgo),
    provider: await providerProblem(tx, orgId),
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
