import { canAccess, ORG_ROLES } from "@odentia/auth/permissions"
import { type Db, withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import type { AutomationCause } from "@odentia/db/schema/automation"
import { agentConfig } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { eq, type SQL, sql } from "drizzle-orm"
import {
  ADMIN_LINES,
  type AdminLine,
  type AdminLineKey,
  actorOf,
  adminLineOf,
  CUSTOM_LINES,
  describeLine,
  flowOf,
  hourPhrase,
  type LineFlow,
  TASK_AREA_LABELS,
} from "./admin-lines.js"
import { type AdminDraftView, draftViewOf } from "./admin-drafts.js"
import { MESSAGE_VARIABLES, renderMessage } from "./automation-messages.js"
import { currentSaasPeriod } from "./saas-actions.js"
import { currentAutomationMessageOf } from "./clinic-messages.js"
import {
  activeSince,
  adminRuntime,
  listBudgetHeldJobs,
  CAUSE_WORDS,
  type DeliverDeps,
  deliverDueJobs,
  deliverJob,
  deliveryOf,
  enqueueJob,
  findLineRule,
  type JobDelivery,
  type JobPayload,
  lineConfigOf,
  lineDays,
  lineTiming,
  listLineRules,
  preferredContact,
  reconcileDeliveries,
  requestNeededTemplates,
  type RuleRow,
  setLine,
  type SetLineInput,
  syncAppointmentReminders,
  syncBudgetFollowUps,
  syncCancelledAppointments,
  syncCheckupReminders,
  settleTasks,
  syncOpportunityFollowUps,
  syncVisitFollowUps,
  syncLapsedInvites,
} from "./automation.js"
import type { TemplateDeps } from "./channel-templates.js"
import { shouldSkipSaasOrg } from "./saas-billing.js"
import { type ConversationCareDeps, tickConversationCare } from "./conversation-close.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { offerPendingHeldReplies } from "./held-replies.js"
import { retakeForgottenTopics } from "./topic-retake.js"
import { purgeOldWebchatTests } from "./webchat.js"
import { patientCreditSql } from "./payments.js"
import { getPatientRegistrationConfig } from "./patient-registration.js"
import { formatOrgMoney, getOrgLocale, type OrgLocale } from "./locale.js"
import { productHooks } from "./products.js"
import { lapsedToInvite } from "./return-invites.js"
import { getWritingHours, type WritingWeek } from "./writing-hours.js"
import type { Storage } from "./storage.js"

/* ---------- Argos: mira cómo va la clínica, recomienda qué prender y hace lo que le encargan ---------- */

/**
 * Su página es la lista de líneas (`ADMIN_LINES`): cada una está prendida o
 * apagada, y dice quién lo hace. Una recomendación es una línea apagada que
 * hoy tiene casos; una automatización es una línea prendida. Nada se prende,
 * cambia ni apaga sin una persona (`setLine`).
 *
 * Cada cifra sale de una consulta, nunca de un texto generado: los casos de
 * hoy, lo que pasó con cada persona y los totales de la semana se pueden
 * mostrar con su lista. El servicio recibe `can` y no enseña lo que el rol de
 * quien lee no ve.
 */
export const ADMIN_MAX_RECOMMENDATIONS = 3
/** Filas que viajan en el detalle; el total real va aparte. */
const ADMIN_LIST_LIMIT = 200
/** «Solo esta vez» atiende hasta esta cantidad de casos de una vez; si hay más, lo dice con la cifra real. */
export const ADMIN_ONCE_LIMIT = 2000
const ADMIN_PREVIEW_ITEMS = 4

/* ---------- Ajustes ---------- */

export interface AdminSettings {
  enabled: boolean
}

export async function getAdminSettings(tx: Db, orgId: string): Promise<AdminSettings> {
  const [row] = await tx.select({ advisor: agentConfig.advisor }).from(agentConfig).where(eq(agentConfig.organizationId, orgId)).limit(1)
  return { enabled: row?.advisor?.enabled === true }
}

/**
 * Enciende o apaga a Argos. Encenderlo no prende ninguna línea. A qué
 * hora escribe ya no es un ajuste suyo: es el «Horario de recontacto» de
 * Agente (`writing-hours.ts`, decisión 18 v3), el mismo para todo.
 */
export async function updateAdminSettings(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { enabled?: boolean },
): Promise<AdminSettings> {
  const current = await getAdminSettings(tx, orgId)
  const next: AdminSettings = { enabled: input.enabled ?? current.enabled }
  await tx
    .insert(agentConfig)
    .values({ organizationId: orgId, advisor: next })
    .onConflictDoUpdate({ target: agentConfig.organizationId, set: { advisor: next, updatedAt: new Date() } })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "agent.admin_updated",
    entity: "agent_config",
    entityId: orgId,
    metadata: { enabled: next.enabled },
  })
  return next
}

/* ---------- Casos: lo que hoy encuentra cada línea ---------- */

export interface AdminCase {
  /** Identidad estable del caso: no se atiende dos veces. */
  id: string
  /** Paciente o contacto al que se refiere. */
  personName: string
  line: string
  patientId: string | null
  contactId: string | null
  opportunityId: string | null
  appointmentId: string | null
  budgetId: string | null
  controlId: string | null
  /** Persona del equipo que lleva el caso, si la hay. */
  ownerUserId: string | null
  /** El vencimiento que originó el caso, cuando lo tiene (la tarea de una oportunidad). */
  dueAt?: string
}

interface CaseResult {
  total: number
  items: AdminCase[]
  title: string
  detail: string
  how: string
}

/**
 * Acota una consulta de casos a los nuevos de una línea prendida: los que
 * cumplen la condición desde `since` y todavía no tienen su caso anotado.
 */
interface Fresh {
  since: Date
  kind: AdminLineKey
}

const dayOf = (value: Date | string, zone: OrgLocale) =>
  new Date(value).toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long" })
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)
const blank = { patientId: null, contactId: null, opportunityId: null, appointmentId: null, budgetId: null, controlId: null, ownerUserId: null }

/** Sin cita futura: ninguna cita programada o confirmada desde ahora. */
const NO_FUTURE_APPOINTMENT = sql`not exists (
  select 1 from appointment a
  where a.organization_id = p.organization_id and a.patient_id = p.id
    and a.starts_at > now() and a.status in ('programada', 'confirmada'))`

/** Solo lo nuevo desde que se prendió y que aún no tiene su caso. `at` es cuándo se cumplió la condición. */
/** Un tratamiento en curso del presupuesto sin cita viva para su próxima sesión (decisión 14). */
const NEXT_SESSION_OPEN = sql`exists (select 1 from treatment_budget_item bi
  join treatment_plan_item i on i.organization_id = bi.organization_id and i.id = bi.plan_item_id
  where bi.organization_id = b.organization_id and bi.budget_id = b.id
    and i.status = 'en_curso' and i.decision_status = 'aceptado'
    and not exists (select 1 from appointment_plan_item api
      join appointment a on a.organization_id = api.organization_id and a.id = api.appointment_id
      where api.organization_id = b.organization_id and api.plan_item_id = i.id
        and a.status in ('programada', 'confirmada')))`

function fresh(scope: Fresh | undefined, id: SQL, at: SQL): SQL {
  if (!scope) return sql``
  return sql`and ${at} >= ${scope.since.toISOString()}::timestamptz
    and not exists (select 1 from automation_job j
      where j.organization_id = ${sql.raw("p")}.organization_id and j.dedupe_key = ${`${scope.kind}:`} || ${id})`
}

async function upcomingAppointments(tx: Db, orgId: string, zone: OrgLocale, limit: number = ADMIN_LIST_LIMIT): Promise<CaseResult> {
  const rows = await tx.execute<{ id: string; patient_id: string; name: string; service: string | null; starts_at: Date | string; total: number }>(sql`
    select a.id, p.id as patient_id, pp.display_name as name, a.service_name as service, a.starts_at,
           count(*) over ()::int as total
    from appointment a
    join patient p on p.id = a.patient_id and p.organization_id = a.organization_id join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    where a.organization_id = ${orgId} and a.status = 'programada'
      and a.starts_at > now() and a.starts_at <= now() + interval '24 hours'
    order by a.starts_at asc
    limit ${limit}`)
  const total = Number(rows[0]?.total ?? 0)
  return {
    total,
    items: rows.map((row) => ({
      ...blank,
      id: row.id,
      personName: row.name,
      line: `${row.service ?? "Cita"} · ${new Date(row.starts_at).toLocaleString(zone.locale, { timeZone: zone.timezone, weekday: "long", hour: "numeric", minute: "2-digit" })}`,
      patientId: row.patient_id,
      appointmentId: row.id,
    })),
    title: `${total} ${plural(total, "cita", "citas")} en las próximas 24 horas sin confirmar`,
    detail: "Nadie les recuerda la cita.",
    how: "Citas programadas que empiezan en las próximas 24 horas y todavía no están confirmadas.",
  }
}

async function overdueControls(tx: Db, orgId: string, zone: OrgLocale, limit: number = ADMIN_LIST_LIMIT): Promise<CaseResult> {
  const rows = await tx.execute<{ id: string; patient_id: string; name: string; title: string; due_at: Date | string; total: number; old: number }>(sql`
    select f.id, p.id as patient_id, pp.display_name as name, f.title, f.due_at,
           count(*) over ()::int as total,
           (count(*) filter (where f.due_at < now() - interval '30 days') over ())::int as old
    from clinical_follow_up f
    join patient p on p.id = f.patient_id and p.organization_id = f.organization_id join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    where f.organization_id = ${orgId} and f.status = 'pendiente' and f.due_at < now()
      and pp.is_active and ${NO_FUTURE_APPOINTMENT}
    order by f.due_at asc
    limit ${limit}`)
  const total = Number(rows[0]?.total ?? 0)
  const old = Number(rows[0]?.old ?? 0)
  return {
    total,
    items: rows.map((row) => ({
      ...blank,
      id: row.id,
      personName: row.name,
      line: `${row.title} · venció el ${dayOf(row.due_at, zone)}`,
      patientId: row.patient_id,
      controlId: row.id,
    })),
    title: `${total} ${plural(total, "control vencido de un paciente sin cita", "controles vencidos de pacientes sin cita")}`,
    detail: old > 0 ? `${old} ${plural(old, "venció", "vencieron")} hace más de 30 días.` : "Todos vencieron en los últimos 30 días.",
    how: "Controles pendientes con fecha vencida, de pacientes activos que no tienen una cita programada o confirmada desde ahora.",
  }
}

async function budgetsWithoutAnswer(tx: Db, orgId: string, zone: OrgLocale, days: number, limit: number = ADMIN_LIST_LIMIT): Promise<CaseResult> {
  const rows = await tx.execute<{ id: string; patient_id: string; name: string; title: string; number: number; presented_at: Date | string; total: number }>(sql`
    select b.id, p.id as patient_id, pp.display_name as name, b.title, b.budget_number as number, b.presented_at,
           count(*) over ()::int as total
    from treatment_budget b
    join patient p on p.id = b.patient_id and p.organization_id = b.organization_id join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    where b.organization_id = ${orgId} and b.status = 'presentado'
      and b.presented_at < now() - make_interval(days => ${days})
      and pp.is_active
    order by b.presented_at asc
    limit ${limit}`)
  const total = Number(rows[0]?.total ?? 0)
  return {
    total,
    items: rows.map((row) => ({
      ...blank,
      id: row.id,
      personName: row.name,
      // Sin importes: quien llama ve el presupuesto mínimo, no sus líneas.
      line: `Presupuesto N.º ${row.number} · ${row.title} · presentado el ${dayOf(row.presented_at, zone)}`,
      patientId: row.patient_id,
      budgetId: row.id,
    })),
    title: `${total} ${plural(total, "presupuesto espera", "presupuestos esperan")} respuesta desde hace más de ${days} ${plural(days, "día", "días")}`,
    detail: "Ordenados del más antiguo al más reciente.",
    how: `Presupuestos presentados hace más de ${days} ${plural(days, "día", "días")} que siguen sin respuesta, de pacientes activos.`,
  }
}

/** Oportunidades abiertas con su tarea vencida: los casos de «Retomar una oportunidad». */
async function overdueOpportunities(tx: Db, orgId: string, zone: OrgLocale, limit: number = ADMIN_LIST_LIMIT): Promise<CaseResult> {
  const rows = await tx.execute<{ id: string; contact_id: string; name: string; title: string; task_title: string; due_at: Date | string; owner: string | null; total: number }>(sql`
    select o.id, c.id as contact_id, c.display_name as name, o.title, t.title as task_title, t.due_at, o.assigned_user_id as owner,
           count(*) over ()::int as total
    from opportunity o
    join contact c on c.id = o.contact_id and c.organization_id = o.organization_id
    join task t on t.organization_id = o.organization_id and t.opportunity_id = o.id and t.status = 'open'
    where o.organization_id = ${orgId} and o.status = 'open' and t.due_at < now() and c.is_active
    order by t.due_at asc
    limit ${limit}`)
  const total = Number(rows[0]?.total ?? 0)
  return {
    total,
    items: rows.map((row) => ({
      ...blank,
      id: row.id,
      personName: row.name,
      line: `${row.title} · «${row.task_title}» venció el ${dayOf(row.due_at, zone)}`,
      contactId: row.contact_id,
      opportunityId: row.id,
      ownerUserId: row.owner,
      dueAt: new Date(row.due_at).toISOString(),
    })),
    title: `${total} ${plural(total, "oportunidad tiene", "oportunidades tienen")} su tarea vencida`,
    detail: "Ordenadas de la más atrasada a la más reciente.",
    how: "Oportunidades abiertas cuya tarea tenía fecha y ya pasó, de contactos activos.",
  }
}

/** Quien faltó hace poco y no tiene otra cita: cada persona una vez, con su inasistencia más reciente. */
async function noShowsWithoutAppointment(tx: Db, orgId: string, zone: OrgLocale, limit: number = ADMIN_LIST_LIMIT): Promise<CaseResult> {
  const days = 30
  const rows = await tx.execute<{ id: string; patient_id: string; name: string; service: string | null; starts_at: Date | string; total: number }>(sql`
    with missed as (
      select distinct on (m.patient_id) m.id, m.patient_id, m.service_name, m.starts_at
      from appointment m
      where m.organization_id = ${orgId} and m.status = 'no_asistio'
        and m.starts_at >= now() - make_interval(days => ${days}) and m.starts_at < now()
      order by m.patient_id, m.starts_at desc
    ) select missed.id, p.id as patient_id, pp.display_name as name, missed.service_name as service, missed.starts_at,
           count(*) over ()::int as total
    from missed
    join patient p on p.id = missed.patient_id and p.organization_id = ${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    where pp.is_active and ${NO_FUTURE_APPOINTMENT}
    order by missed.starts_at desc
    limit ${limit}`)
  const total = Number(rows[0]?.total ?? 0)
  return {
    total,
    items: rows.map((row) => ({
      ...blank,
      id: row.id,
      personName: row.name,
      line: `${row.service ?? "Cita"} · faltó el ${dayOf(row.starts_at, zone)}`,
      patientId: row.patient_id,
      appointmentId: row.id,
    })),
    title: `${total} ${plural(total, "persona faltó", "personas faltaron")} a su cita en los últimos ${days} días y no ${plural(total, "tiene", "tienen")} otra`,
    detail: "Ordenadas de la inasistencia más reciente a la más antigua.",
    how: `Citas de los últimos ${days} días que quedaron como «No vino», de pacientes activos que no tienen una cita programada o confirmada desde ahora. Cada persona cuenta una vez.`,
  }
}

/** «Invitar a volver»: quien no viene hace 6 meses (12 en latidIA) y toca invitarlo (decisión 15). */
async function lapsedInvites(tx: Db, orgId: string, zone: OrgLocale, limit: number = ADMIN_LIST_LIMIT): Promise<CaseResult> {
  const all = await lapsedToInvite(tx, orgId, zone.timezone, new Date())
  const months = (await productHooks(tx, orgId)).recallMonths
  const total = all.length
  return {
    total,
    items: all.slice(0, limit).map((row) => ({
      ...blank,
      id: row.patientId,
      personName: row.personName,
      line: `Última visita ${dayOf(new Date(row.lastVisitAt), zone)}`,
      patientId: row.patientId,
      contactId: row.personId,
      appointmentId: row.appointmentId,
    })),
    title: `${total} ${plural(total, "persona", "personas")} sin venir hace ${months} meses ${plural(total, "le toca", "les toca")} una invitación`,
    detail: "Ordenadas de la visita más antigua a la más reciente.",
    how: `Pacientes cuya última cita atendida fue hace más de ${months} meses, sin cita, presupuesto que espere respuesta ni control pendiente. Quien ya recibió una invitación en los últimos ${months} meses, o pidió no recibir mensajes de seguimiento, no aparece.`,
  }
}

async function budgetsWithoutAppointment(tx: Db, orgId: string, zone: OrgLocale, days: number, scope?: Fresh, limit: number = ADMIN_LIST_LIMIT): Promise<CaseResult> {
  const rows = await tx.execute<{ id: string; patient_id: string; name: string; title: string; number: number; decided_at: Date | string; next_session: boolean; total: number }>(sql`
    select b.id, p.id as patient_id, pp.display_name as name, b.title, b.budget_number as number, b.decided_at,
           ${NEXT_SESSION_OPEN} as next_session, count(*) over ()::int as total
    from treatment_budget b
    join patient p on p.id = b.patient_id and p.organization_id = b.organization_id join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    where b.organization_id = ${orgId} and b.status in ('aceptado', 'parcial')
      and (b.decided_at < now() - make_interval(days => ${days}) or ${NEXT_SESSION_OPEN})
      and pp.is_active and ${NO_FUTURE_APPOINTMENT}
      ${fresh(scope, sql`b.id::text`, sql`b.decided_at + make_interval(days => ${days})`)}
    order by b.decided_at asc
    limit ${limit}`)
  const total = Number(rows[0]?.total ?? 0)
  return {
    total,
    items: rows.map((row) => ({
      ...blank,
      id: row.id,
      personName: row.name,
      // Sin importes: quien agenda ve el presupuesto mínimo, no sus líneas.
      line: `${row.next_session ? "Falta agendar la próxima sesión · " : ""}Presupuesto N.º ${row.number} · ${row.title} · aceptado el ${dayOf(row.decided_at, zone)}`,
      patientId: row.patient_id,
      budgetId: row.id,
    })),
    title: `${total} ${plural(total, "presupuesto aceptado", "presupuestos aceptados")} hace más de ${days} días, sin cita`,
    detail: "El paciente aceptó y todavía no tiene fecha para empezar.",
    how: `Presupuestos aceptados (del todo o en parte) hace más de ${days} días, o con un tratamiento en curso sin cita para su próxima sesión; de pacientes activos que no tienen una cita programada o confirmada desde ahora.`,
  }
}

/** Roles que escriben en la historia (`clinical.write`): ven sus atenciones de otro día en «Te espera». */
const ATTENDING_ROLES = ORG_ROLES.filter((role) => canAccess(role, "clinical.write"))

async function unsignedEncounters(tx: Db, orgId: string, zone: OrgLocale, days: number, scope?: Fresh, limit: number = ADMIN_LIST_LIMIT): Promise<CaseResult> {
  const rows = await tx.execute<{ id: string; patient_id: string; name: string; professional: string | null; professional_id: string | null; started_at: Date | string; total: number }>(sql`
    select e.id, p.id as patient_id, pp.display_name as name, u.name as professional, e.professional_user_id as professional_id, e.started_at,
           count(*) over ()::int as total
    from encounter e
    join patient p on p.id = e.patient_id and p.organization_id = e.organization_id join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    left join "user" u on u.id = e.professional_user_id
    where e.organization_id = ${orgId} and e.status = 'borrador'
      and e.started_at < now() - make_interval(days => ${days})
      -- Quien la lleva y sigue atendiendo ya la tiene en «Te espera» con lo que
      -- le falta (staleEncounter): la línea no le deja otra tarea igual.
      and not exists (
        select 1 from member m
        where m.organization_id = e.organization_id and m.user_id = e.professional_user_id
          and lower(m.role) in (${sql.join(ATTENDING_ROLES.map((role) => sql`${role}`), sql`, `)})
      )
      ${fresh(scope, sql`e.id::text`, sql`e.started_at + make_interval(days => ${days})`)}
    order by e.started_at asc
    limit ${limit}`)
  const total = Number(rows[0]?.total ?? 0)
  const byProfessional = new Map<string, number>()
  for (const row of rows) byProfessional.set(row.professional ?? "Sin profesional", (byProfessional.get(row.professional ?? "Sin profesional") ?? 0) + 1)
  const who = [...byProfessional.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => `${name} tiene ${n}`)
  return {
    total,
    items: rows.map((row) => ({
      ...blank,
      id: row.id,
      personName: row.name,
      line: `${row.professional ?? "Sin profesional"} · abierta desde el ${dayOf(row.started_at, zone)}`,
      patientId: row.patient_id,
      ownerUserId: row.professional_id,
    })),
    title: `${total} ${plural(total, "atención lleva", "atenciones llevan")} más de ${days} ${plural(days, "día", "días")} sin firmar`,
    detail: who.length ? `${who.join(" y ")}.` : "",
    how: `Atenciones que siguen en borrador, se abrieron hace más de ${days} ${plural(days, "día", "días")} y no le salen a nadie en «Te espera»: quien la lleva ya no está en el equipo o ya no atiende. Una atención sin firmar no forma parte de la historia.`,
  }
}

/**
 * Deuda vieja: lo que la persona debe (conceptos vigentes menos lo aplicado,
 * menos lo que tiene a favor) cuando su concepto más antiguo sin pagar pasa
 * del plazo. No hay cuotas con fecha: la deuda es el saldo de la cuenta, igual
 * que en Caja (`accountBalances`, decisión 22); con lo que tiene a favor
 * alcanzando, no hay saldo vencido.
 */
async function overdueCollections(tx: Db, orgId: string, zone: OrgLocale, days: number, scope?: Fresh, limit: number = ADMIN_LIST_LIMIT): Promise<CaseResult> {
  const credit = sql`greatest(${patientCreditSql(orgId, sql`p.id`, sql`c.currency`)}, 0)`
  const rows = await tx.execute<{ patient_id: string; name: string; currency: string; owed: number; since: Date | string; since_day: string; total: number }>(sql`
    select p.id as patient_id, pp.display_name as name, c.currency,
           (sum(c.amount_cents - coalesce(a.applied, 0)) - ${credit})::int as owed, min(c.created_at) as since,
           to_char(min(c.created_at), 'YYYY-MM-DD') as since_day,
           count(*) over ()::int as total
    from patient_charge c
    join patient p on p.id = c.patient_id and p.organization_id = c.organization_id join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    left join lateral (
      select sum(app.amount_cents)::int as applied
      from patient_payment_application app
      where app.charge_id = c.id and app.organization_id = c.organization_id and app.voided_at is null
    ) a on true
    where c.organization_id = ${orgId} and c.voided_at is null and c.amount_cents > coalesce(a.applied, 0)
    group by p.id, pp.display_name, p.organization_id, c.currency
    having min(c.created_at) < now() - make_interval(days => ${days})
      and sum(c.amount_cents - coalesce(a.applied, 0)) > ${credit}
      ${fresh(scope, sql`(p.id::text || ':' || c.currency || ':' || to_char(min(c.created_at), 'YYYY-MM-DD'))`, sql`min(c.created_at) + make_interval(days => ${days})`)}
    order by min(c.created_at) asc
    limit ${limit}`)
  const total = Number(rows[0]?.total ?? 0)
  return {
    total,
    items: rows.map((row) => ({
      ...blank,
      // La deuda más antigua identifica el caso: si paga y vuelve a deber, es otro.
      id: `${row.patient_id}:${row.currency}:${row.since_day}`,
      personName: row.name,
      line: `Debe ${formatOrgMoney(Number(row.owed), row.currency, zone)} · desde el ${dayOf(row.since, zone)}`,
      patientId: row.patient_id,
    })),
    title: `${total} ${plural(total, "persona debe", "personas deben")} desde hace más de ${days} días`,
    detail: total > rows.length ? `Se muestran las ${rows.length} más antiguas.` : "Ordenadas de la deuda más antigua a la más reciente.",
    how: `Conceptos por cobrar sin anular cuyo saldo sigue pendiente, descontado lo que la persona tiene a favor, y que se anotaron hace más de ${days} días.`,
  }
}

/** Quien canceló su cita en la última semana y no tiene otra: cada persona una vez. */
async function cancelledWithoutAppointment(tx: Db, orgId: string, zone: OrgLocale, limit: number = ADMIN_LIST_LIMIT): Promise<CaseResult> {
  const days = 7
  const rows = await tx.execute<{ id: string; patient_id: string; name: string; service: string | null; starts_at: Date | string; total: number }>(sql`
    with gone as (
      select distinct on (m.patient_id) m.id, m.patient_id, m.service_name, m.starts_at
      from appointment m
      where m.organization_id = ${orgId} and m.status = 'cancelada' and exists (
        select 1 from audit_event e
        where e.organization_id = m.organization_id and e.entity = 'appointment' and e.entity_id = m.id::text
          and e.action = 'appointment.status_cancelada' and e.created_at >= now() - make_interval(days => ${days})
          and (e.actor_user_id is null or e.metadata->>'cancelReason' = 'paciente'))
      order by m.patient_id, m.starts_at desc
    ) select gone.id, p.id as patient_id, pp.display_name as name, gone.service_name as service, gone.starts_at,
           count(*) over ()::int as total
    from gone
    join patient p on p.id = gone.patient_id and p.organization_id = ${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    where pp.is_active and ${NO_FUTURE_APPOINTMENT}
    order by gone.starts_at desc
    limit ${limit}`)
  const total = Number(rows[0]?.total ?? 0)
  return {
    total,
    items: rows.map((row) => ({
      ...blank,
      id: row.id,
      personName: row.name,
      line: `${row.service ?? "Cita"} · era el ${dayOf(row.starts_at, zone)}`,
      patientId: row.patient_id,
      appointmentId: row.id,
    })),
    title: `${total} ${plural(total, "persona canceló", "personas cancelaron")} su cita en los últimos ${days} días y no ${plural(total, "tiene", "tienen")} otra`,
    detail: "Nadie les ofreció otra fecha.",
    how: `Citas que la persona canceló en los últimos ${days} días (desde su enlace o anotadas con el motivo «paciente»), de pacientes activos sin una cita programada o confirmada desde ahora. Cada persona cuenta una vez.`,
  }
}

/** Los casos de una línea: todos los de hoy o, con `scope`, solo los nuevos desde que se prendió. */
async function casesOf(
  tx: Db,
  orgId: string,
  key: AdminLineKey,
  zone: OrgLocale,
  days: number | null,
  scope?: Fresh,
  limit: number = ADMIN_LIST_LIMIT,
): Promise<CaseResult> {
  if (key === "recordatorio_cita") return upcomingAppointments(tx, orgId, zone, limit)
  if (key === "recordatorio_control") return overdueControls(tx, orgId, zone, limit)
  if (key === "seguimiento_presupuesto") return budgetsWithoutAnswer(tx, orgId, zone, days ?? 2, limit)
  if (key === "seguimiento_comercial") return overdueOpportunities(tx, orgId, zone, limit)
  if (key === "seguimiento_no_asistencia") return noShowsWithoutAppointment(tx, orgId, zone, limit)
  if (key === "invitar_a_volver") return lapsedInvites(tx, orgId, zone, limit)
  if (key === "cita_cancelada") return cancelledWithoutAppointment(tx, orgId, zone, limit)
  if (key === "presupuestos_sin_cita") return budgetsWithoutAppointment(tx, orgId, zone, days ?? 7, scope, limit)
  if (key === "atenciones_sin_firmar") return unsignedEncounters(tx, orgId, zone, days ?? 2, scope, limit)
  return overdueCollections(tx, orgId, zone, days ?? 30, scope, limit)
}

function requireLine(key: string): AdminLine {
  const line = adminLineOf(key)
  if (!line) throw notFound("Línea del administrador")
  return line
}

/* ---------- Las líneas que solo dejan trabajo al equipo ---------- */

/**
 * Anota los casos nuevos de las líneas prendidas que no escriben a nadie: uno
 * por persona, presupuesto o atención que cumple la condición desde que se
 * prendió. La tarea se deja al atender el caso (`deliverJob`), con el motivo
 * comprobado otra vez.
 */
export async function syncTeamLines(tx: Db, orgId: string, now: Date): Promise<number> {
  let queued = 0
  const zone = await getOrgLocale(tx, orgId)
  for (const line of ADMIN_LINES) {
    if (line.agent) continue
    const rule = await findLineRule(tx, orgId, line.key)
    if (!rule?.enabled) continue
    const found = await casesOf(tx, orgId, line.key, zone, lineDays(rule, line.key), { since: activeSince(rule), kind: line.key })
    for (const item of found.items) {
      if (await enqueueCase(tx, orgId, rule, line, item, now, {})) queued++
    }
  }
  return queued
}

async function enqueueCase(
  tx: Db,
  orgId: string,
  rule: RuleRow,
  line: AdminLine,
  item: AdminCase,
  now: Date,
  extra: Pick<JobPayload, "once">,
) {
  // Lo que le escribe el agente va a la persona preferida del paciente.
  const contactId = item.contactId ?? (line.agent && item.patientId ? await preferredContact(tx, orgId, item.patientId) : null)
  return enqueueJob(tx, orgId, {
    ruleId: rule.id,
    kind: line.key,
    dedupeKey: `${line.key}:${item.id}${extra.once ? `:vez:${now.toISOString().slice(0, 10)}` : ""}`,
    scheduledFor: now,
    contactId,
    patientId: item.patientId,
    appointmentId: item.appointmentId,
    budgetId: item.budgetId,
    opportunityId: item.opportunityId,
    payload: {
      detail: item.line,
      ...(item.controlId ? { controlId: item.controlId } : {}),
      ...(item.ownerUserId ? { ownerUserId: item.ownerUserId } : {}),
      ...(item.dueAt ? { dueAt: item.dueAt } : {}),
      ...extra,
    },
  })
}

/* ---------- Qué pasó ---------- */

/** Resultado de un caso, en una palabra que la pantalla sabe decir. */
export type CaseOutcome =
  | "programado"
  | "enviando"
  | "entregado"
  | "confirmo"
  | "respondio"
  | "reservo"
  | "no_pudo"
  | "tarea"
  | "tarea_resuelta"
  | "no_hizo_falta"

export interface AdminPersonRow {
  id: string
  personName: string
  patientId: string | null
  contactId: string | null
  conversationId: string | null
  at: string
  outcome: CaseOutcome
  /** Lo que pasó, en una frase. */
  text: string
  /** Cómo habilitarlo, cuando no se pudo escribir. */
  fix: string | null
  cause: AutomationCause | null
}

const VIA_WORDS: Record<string, string> = { respuesta: "por WhatsApp", plantilla: "por WhatsApp", correo: "por correo" }

interface JobView extends Record<string, unknown> {
  id: string
  kind: string
  status: string
  cause: string | null
  via: string | null
  last_error: string | null
  updated_at: Date | string
  scheduled_for: Date | string
  patient_id: string | null
  contact_id: string | null
  name: string | null
  message_status: string | null
  conversation_id: string | null
  appointment_status: string | null
  replied: boolean
  booked: boolean
  task_status: string | null
  task_area: string | null
  /** La tarea se cerró sola porque su motivo desapareció: por qué. */
  task_settled: string | null
}

/** Consulta común de «qué pasó»: el caso con lo que se sabe de su mensaje, su cita y su tarea. */
function jobsQuery(orgId: string, where: SQL, limit: number): SQL {
  return sql`
    select j.id, j.kind, j.status, j.cause, j.via, j.last_error, j.updated_at, j.scheduled_for,
           j.patient_id, j.contact_id, coalesce(pp.display_name, c.display_name) as name,
           m.status as message_status, m.conversation_id,
           a.status as appointment_status, t.status as task_status, t.area as task_area, t.settled_reason as task_settled,
           (m.id is not null and exists (select 1 from message r
              where r.conversation_id = m.conversation_id and r.organization_id = j.organization_id
                and r.direction = 'in' and r.created_at > m.created_at)) as replied,
           (j.status = 'enviado' and j.patient_id is not null and exists (select 1 from appointment n
              where n.organization_id = j.organization_id and n.patient_id = j.patient_id
                and n.created_at > j.updated_at and n.status in ('programada', 'confirmada', 'atendida'))) as booked
    from automation_job j
    left join patient p on p.id = j.patient_id and p.organization_id = j.organization_id left join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    left join contact c on c.id = j.contact_id and c.organization_id = j.organization_id
    left join message m on m.id = j.sent_message_id and m.organization_id = j.organization_id
    left join appointment a on a.id = j.appointment_id and a.organization_id = j.organization_id
    left join task t on t.id = j.task_id and t.organization_id = j.organization_id
    where j.organization_id = ${orgId} and ${where}
    order by j.updated_at desc, j.id desc
    limit ${limit}`
}

function describeJob(row: JobView, zone: OrgLocale): Pick<AdminPersonRow, "outcome" | "text" | "fix" | "cause"> {
  const via = VIA_WORDS[row.via ?? ""] ?? "por WhatsApp"
  const taskDone = row.task_status === "done"
  // Una tarea que se cerró sola no la resolvió nadie: se dice por qué ya no hacía falta.
  const resolved = row.task_settled ? `Se cerró sola: ${row.task_settled.replace(/\.$/, "")}.` : "Una persona ya lo resolvió."
  const taskTeam = row.task_area && row.task_area in TASK_AREA_LABELS ? TASK_AREA_LABELS[row.task_area as keyof typeof TASK_AREA_LABELS].team : "una persona"
  if (row.status === "enviado") {
    if (row.kind === "recordatorio_cita" && row.appointment_status === "confirmada") return { outcome: "confirmo", text: `Confirmó, ${via}.`, fix: null, cause: null }
    if (row.kind !== "recordatorio_cita" && row.booked) return { outcome: "reservo", text: "Reservó otra cita.", fix: null, cause: null }
    if (row.replied) return { outcome: "respondio", text: `Respondió ${via}. La conversación sigue con Sofi.`, fix: null, cause: null }
    const delivery: JobDelivery | null = deliveryOf(row.message_status)
    if (delivery === "entregado" || delivery === "leido") return { outcome: "entregado", text: `Entregado ${via}${delivery === "leido" ? "; lo leyó" : ""}. Sin respuesta todavía.`, fix: null, cause: null }
    return { outcome: "enviando", text: `Enviado ${via}; todavía sin confirmación de entrega.`, fix: null, cause: null }
  }
  if (row.status === "fallido" || row.status === "omitido") {
    const cause = (row.cause ?? "proveedor") as AutomationCause
    const words = CAUSE_WORDS[cause] ?? CAUSE_WORDS.proveedor
    const who = row.task_status ? (taskDone ? ` ${resolved}` : ` Lo tiene ${taskTeam}.`) : ""
    return { outcome: "no_pudo", text: `Sofi no pudo escribirle: ${words.one}.${who}`, fix: words.fix, cause }
  }
  if (row.status === "tarea") {
    return taskDone
      ? { outcome: "tarea_resuelta", text: resolved, fix: null, cause: null }
      : { outcome: "tarea", text: `Quedó una tarea para ${taskTeam}.`, fix: null, cause: null }
  }
  if (row.status === "cancelado") return { outcome: "no_hizo_falta", text: `No se hizo nada: ${(row.last_error ?? "ya no hacía falta").replace(/\.$/, "").toLowerCase()}.`, fix: null, cause: null }
  return { outcome: "programado", text: `Programado para el ${dayOf(row.scheduled_for, zone)}.`, fix: null, cause: null }
}

function toPersonRow(row: JobView, zone: OrgLocale): AdminPersonRow {
  return {
    id: row.id,
    personName: row.name ?? "Persona sin nombre",
    patientId: row.patient_id,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    at: new Date(row.updated_at).toISOString(),
    ...describeJob(row, zone),
  }
}

/** Lo que pasó con cada persona de una línea, de lo más reciente a lo más antiguo. */
export async function listAdminLinePeople(
  tx: Db,
  orgId: string,
  can: (permission: string) => boolean,
  key: string,
  options: { only?: "no-pudo"; limit?: number } = {},
): Promise<{ items: AdminPersonRow[]; total: number }> {
  const line = requireLine(key)
  if (!can(line.permission)) throw new ServiceError("FORBIDDEN", 403, "Tu rol no puede ver los casos de esta línea")
  const zone = await getOrgLocale(tx, orgId)
  const where = options.only === "no-pudo" ? sql`j.kind = ${line.key} and j.cause is not null` : sql`j.kind = ${line.key}`
  const limit = Math.min(Math.max(options.limit ?? 20, 1), ADMIN_LIST_LIMIT)
  const rows = await tx.execute<JobView>(jobsQuery(orgId, where, limit))
  const [count] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from automation_job j where j.organization_id = ${orgId} and ${where}`)
  return { items: rows.map((row) => toPersonRow(row, zone)), total: Number(count?.n ?? 0) }
}

export interface LineWeek {
  /** Casos atendidos en los últimos siete días. */
  cases: number
  messages: number
  /** Confirmó, respondió o reservó otra cita. */
  answered: number
  tasks: number
  tasksDone: number
  unreached: number
}

async function weekOf(tx: Db, orgId: string, days = 7): Promise<Map<string, LineWeek>> {
  const rows = await tx.execute<{ kind: string; cases: number; messages: number; answered: number; tasks: number; tasks_done: number; unreached: number }>(sql`
    select j.kind,
      count(*) filter (where j.status in ('enviado', 'tarea', 'fallido', 'omitido'))::int as cases,
      count(*) filter (where j.status = 'enviado')::int as messages,
      count(*) filter (where j.status = 'enviado' and (
        (j.kind = 'recordatorio_cita' and a.status = 'confirmada')
        or exists (select 1 from message r where r.conversation_id = m.conversation_id and r.organization_id = j.organization_id
                     and r.direction = 'in' and r.created_at > m.created_at)
        or (j.kind <> 'recordatorio_cita' and j.patient_id is not null and exists (select 1 from appointment n
              where n.organization_id = j.organization_id and n.patient_id = j.patient_id and n.created_at > j.updated_at
                and n.status in ('programada', 'confirmada', 'atendida')))))::int as answered,
      count(*) filter (where j.task_id is not null)::int as tasks,
      count(*) filter (where t.status = 'done')::int as tasks_done,
      count(*) filter (where j.cause is not null)::int as unreached
    from automation_job j
    left join message m on m.id = j.sent_message_id and m.organization_id = j.organization_id
    left join appointment a on a.id = j.appointment_id and a.organization_id = j.organization_id
    left join task t on t.id = j.task_id and t.organization_id = j.organization_id
    where j.organization_id = ${orgId} and j.updated_at >= now() - make_interval(days => ${days})
    group by j.kind`)
  return new Map(rows.map((row) => [row.kind, {
    cases: Number(row.cases), messages: Number(row.messages), answered: Number(row.answered), tasks: Number(row.tasks),
    tasksDone: Number(row.tasks_done), unreached: Number(row.unreached),
  }]))
}

const ANSWERED_WORD: Partial<Record<AdminLineKey, [string, string]>> = {
  recordatorio_cita: ["confirmó", "confirmaron"],
  recordatorio_control: ["respondió o agendó", "respondieron o agendaron"],
  seguimiento_presupuesto: ["respondió", "respondieron"],
  seguimiento_no_asistencia: ["respondió o reservó otra cita", "respondieron o reservaron otra cita"],
  invitar_a_volver: ["volvió o reservó", "volvieron o reservaron"],
  cita_cancelada: ["respondió o reservó otra cita", "respondieron o reservaron otra cita"],
}

/** Días que se miran para proponer un cambio y mínimo de casos para decir algo. */
export const SUGGESTION_DAYS = 30
export const SUGGESTION_MIN_CASES = 10

/**
 * Una línea prendida que no está sirviendo: lo dice con su cifra y propone
 * cambiarla o apagarla. Solo propone: la decisión es de una persona.
 */
function suggestionOf(line: AdminLine, writes: boolean, month: LineWeek | undefined): string | null {
  if (!month) return null
  const reached = month.messages + month.unreached
  if (writes && month.unreached >= SUGGESTION_MIN_CASES && month.unreached > month.messages) {
    return `En ${SUGGESTION_DAYS} días Sofi no pudo escribirle a ${month.unreached} de ${reached} personas. Mira por qué antes de seguir: casi siempre es el permiso o un dato que falta.`
  }
  if (writes && month.messages >= SUGGESTION_MIN_CASES && month.answered === 0) {
    return `En ${SUGGESTION_DAYS} días envió ${month.messages} mensajes y nadie respondió. Puedes cambiar cuándo sale, dejárselo a una persona o apagarla.`
  }
  if (!writes && month.tasks >= SUGGESTION_MIN_CASES && month.tasksDone === 0) {
    return `En ${SUGGESTION_DAYS} días dejó ${month.tasks} tareas y ninguna se resolvió. Puedes cambiar ${line.daysLabel ? "el plazo" : "quién la atiende"} o apagarla.`
  }
  return null
}

/** La semana de una línea prendida, en una frase. Sin actividad, lo dice. */
function weekLine(line: AdminLine, week: LineWeek | undefined): string {
  if (!week || week.cases === 0) return "Esta semana: todavía nada"
  const parts: string[] = []
  if (week.messages > 0) {
    parts.push(`${week.messages} ${plural(week.messages, "mensaje del agente", "mensajes del agente")}`)
    const [one, many] = ANSWERED_WORD[line.key] ?? ["respondió", "respondieron"]
    parts.push(`${week.answered} ${plural(week.answered, one, many)}`)
  }
  if (week.tasks > 0) parts.push(`${week.tasks} ${plural(week.tasks, "tarea", "tareas")}, ${week.tasksDone} ${plural(week.tasksDone, "resuelta", "resueltas")}`)
  if (week.unreached > 0) parts.push(`${week.unreached} ${plural(week.unreached, "aviso", "avisos")} de «no pude»`)
  return `Esta semana: ${parts.join(", ")}`
}

/* ---------- Su página ---------- */

export interface AdminLineView {
  key: AdminLineKey
  name: string
  area: string
  /** Lo que pasa: «Una persona falta a su cita». */
  trigger: string
  /** Quién lo hace con las partes que van. */
  actor: "agente" | "persona"
  /** Qué se hace, con el tiempo verbal de su estado. */
  description: string
  enabled: boolean
  /** La línea tiene parte «el agente le escribe». */
  hasAgent: boolean
  agentPart: boolean
  teamPart: boolean
  team: string
  days: number | null
  defaultDays: number | null
  daysLabel: string | null
  since: string | null
  /** Prendida: su semana en una frase. */
  week: string | null
  /** Apagada: cuántos casos tendría hoy; null si quien lee no puede verlos. */
  todayCases: number | null
  /** Sale en Inicio como recomendación. */
  recommended: boolean
  noRecommend: boolean
  /** Prendida, pero hoy no puede escribir: por qué. */
  paused: "recepcion_apagada" | null
  /** La creó la clínica pidiéndosela con palabras: es la única que se puede eliminar. */
  custom: boolean
  /** Hora fija de salida, si la tiene. */
  hour: number | null
  /** Se le puede fijar una hora del día para salir. */
  hourAdjustable: boolean
  /** Horas que espera, en las líneas que esperan horas; null en las demás. */
  delayHours: number | null
  /** Indicación de la clínica para quien reciba la tarea. */
  taskNote: string | null
  /** Hay un pedido con palabras esperando decisión. */
  hasDraft: boolean
  /** Prendida y sin servir: lo que propone, con su cifra. */
  suggestion: string | null
}

async function lineView(
  tx: Db,
  orgId: string,
  can: (permission: string) => boolean,
  line: AdminLine,
  rule: RuleRow | null,
  context: { zone: OrgLocale; week: Map<string, LineWeek>; month: Map<string, LineWeek>; receptionOn: boolean },
): Promise<AdminLineView> {
  const state = {
    enabled: rule?.enabled ?? false,
    agentPart: line.agent ? (rule?.agentPart ?? true) : false,
    teamPart: rule?.teamPart ?? true,
  }
  const days = lineDays(rule, line.key)
  const timing = lineTiming(rule)
  const todayCases = !state.enabled && can(line.permission) ? (await casesOf(tx, orgId, line.key, context.zone, days)).total : null
  const noRecommend = rule?.noRecommend ?? false
  return {
    key: line.key,
    name: line.name,
    area: line.area,
    trigger: line.trigger(days, (await productHooks(tx, orgId)).recallMonths),
    actor: actorOf(line, state),
    description: describeLine(line, state, timing),
    ...state,
    hasAgent: !!line.agent,
    team: TASK_AREA_LABELS[line.team.area].team,
    days,
    defaultDays: line.defaultDays,
    daysLabel: line.daysLabel,
    since: state.enabled && rule ? activeSince(rule).toISOString() : null,
    week: state.enabled ? weekLine(line, context.week.get(line.key)) : null,
    todayCases,
    recommended: !state.enabled && !noRecommend && (todayCases ?? 0) > 0,
    noRecommend,
    paused: state.enabled && state.agentPart && !context.receptionOn ? "recepcion_apagada" : null,
    custom: !!line.custom,
    hour: timing.hour ?? null,
    hourAdjustable: !!line.hourAdjustable,
    delayHours: line.delayHours === undefined ? null : (timing.delayHours ?? line.delayHours),
    taskNote: lineConfigOf(rule?.config).taskNote ?? null,
    hasDraft: !!rule?.draft,
    suggestion: state.enabled ? suggestionOf(line, !!line.agent && state.agentPart, context.month.get(line.key)) : null,
  }
}

/** Las líneas de una clínica: las que vienen armadas y las que ella creó. */
function linesOf(rules: Map<string, RuleRow>): AdminLine[] {
  return [...ADMIN_LINES, ...CUSTOM_LINES.filter((line) => rules.has(line.key))]
}

export interface AdminPage {
  enabled: boolean
  /** El «Horario de recontacto» de Agente: lo respeta todo lo que escribe el agente por su cuenta. */
  writingHours: WritingWeek
  /** Sofi es quien escribe: apagada, las líneas que escriben quedan en pausa. */
  receptionOn: boolean
  /** Hay un WhatsApp conectado por el que escribir. */
  whatsapp: boolean
  lines: AdminLineView[]
  /** Hoy, en tres cifras. */
  today: { recommendations: number; done: number; yours: number }
  /** Mensajes aprobados enviados este mes: WhatsApp los cobra por mensaje. */
  monthTemplates: number
  /**
   * «Prendida, pero casi no escribe»: en 30 días no pudo escribirle a la
   * mayoría porque no aceptaron ese tipo de mensaje. Dice si el registro de
   * pacientes lo pregunta, que es donde se corrige.
   */
  permissionGaps: PermissionGap[]
  /**
   * La clínica llegó a su presupuesto del mes (ADR 0085, tablero C4): Argos no
   * escribe para recuperar y estos mensajes esperan hasta que lo suba o
   * empiece otro mes (`until`, su último día). Null si no llegó.
   */
  budgetHold: { until: string; total: number; lines: Array<{ kind: string; name: string; count: number }> } | null
}

export interface PermissionGap {
  purpose: "novedades"
  /** Personas a las que no pudo escribir por falta de permiso, de `total`. */
  refused: number
  total: number
  /** El registro de pacientes pregunta por este permiso. */
  asks: boolean
  /** La línea con más casos así, para abrirla y ver quiénes. */
  lineKey: AdminLineKey
}

/** Mínimo de personas sin permiso para decir que una línea casi no escribe. */
export const PERMISSION_GAP_MIN = 5

async function permissionGaps(tx: Db, orgId: string, rules: Map<string, RuleRow>): Promise<PermissionGap[]> {
  // Lo que es parte del servicio no pide permiso (ADR 0030): solo cuentan las líneas
  // de novedades y promociones, y hoy no hay ninguna, así que no se afirma nada.
  const kinds = [...ADMIN_LINES, ...CUSTOM_LINES]
    .filter((line) => line.agent?.purpose === "novedades" && rules.get(line.key)?.enabled && rules.get(line.key)?.agentPart)
    .map((line) => line.key)
  if (kinds.length === 0) return []
  const rows = await tx.execute<{ kind: string; refused: number; total: number }>(sql`
    select j.kind, count(*) filter (where j.cause = 'sin_permiso')::int as refused,
           count(*) filter (where j.status in ('enviado', 'fallido', 'omitido'))::int as total
    from automation_job j
    where j.organization_id = ${orgId} and j.kind in ${kinds} and j.updated_at >= now() - make_interval(days => ${SUGGESTION_DAYS})
    group by j.kind`)
  const config = await getPatientRegistrationConfig(tx, orgId)
  const gaps: PermissionGap[] = []
  for (const purpose of ["novedades"] as const) {
    const mine = rows.filter((row) => adminLineOf(row.kind)?.agent?.purpose === purpose)
    const refused = mine.reduce((sum, row) => sum + Number(row.refused), 0)
    const total = mine.reduce((sum, row) => sum + Number(row.total), 0)
    if (refused < PERMISSION_GAP_MIN || refused * 2 <= total) continue
    const worst = [...mine].sort((a, b) => Number(b.refused) - Number(a.refused))[0]
    const line = worst ? adminLineOf(worst.kind) : null
    if (!line) continue
    gaps.push({ purpose, refused, total, asks: config.askMessages, lineKey: line.key })
  }
  return gaps
}

/**
 * La página de Argos. Apagado, las líneas viajan igual con lo que
 * harían hoy: es la vista previa antes de encenderlo. Nada aquí cambia nada.
 */
export async function getAdminPage(tx: Db, orgId: string, can: (permission: string) => boolean): Promise<AdminPage> {
  const settings = await getAdminSettings(tx, orgId)
  const runtime = await adminRuntime(tx, orgId)
  const zone = await getOrgLocale(tx, orgId)
  const rules = new Map((await listLineRules(tx, orgId)).map((rule) => [rule.kind, rule]))
  const week = await weekOf(tx, orgId)
  const month = await weekOf(tx, orgId, SUGGESTION_DAYS)
  const lines: AdminLineView[] = []
  for (const line of linesOf(rules)) {
    lines.push(await lineView(tx, orgId, can, line, rules.get(line.key) ?? null, { zone, week, month, receptionOn: runtime.receptionOn }))
  }
  const [counts] = await tx.execute<{ done: number; yours: number; templates: number; whatsapp: boolean }>(sql`
    select
      (select count(*)::int from automation_job j where j.organization_id = ${orgId}
         and j.status in ('enviado', 'tarea')
         and (j.updated_at at time zone ${zone.timezone})::date = (now() at time zone ${zone.timezone})::date) as done,
      (select count(*)::int from automation_job j join task t on t.id = j.task_id and t.organization_id = j.organization_id
         where j.organization_id = ${orgId} and t.status = 'open') as yours,
      (select count(*)::int from automation_job j where j.organization_id = ${orgId} and j.status = 'enviado' and j.via = 'plantilla'
         and date_trunc('month', j.updated_at at time zone ${zone.timezone}) = date_trunc('month', now() at time zone ${zone.timezone})) as templates,
      exists (select 1 from channel_connection c where c.organization_id = ${orgId} and c.channel = 'whatsapp' and c.status = 'active') as whatsapp`)
  return {
    enabled: settings.enabled,
    writingHours: await getWritingHours(tx, orgId),
    receptionOn: runtime.receptionOn,
    whatsapp: counts?.whatsapp === true,
    lines,
    today: {
      recommendations: Math.min(lines.filter((line) => line.recommended).length, ADMIN_MAX_RECOMMENDATIONS),
      done: Number(counts?.done ?? 0),
      yours: Number(counts?.yours ?? 0),
    },
    monthTemplates: Number(counts?.templates ?? 0),
    permissionGaps: settings.enabled ? await permissionGaps(tx, orgId, rules) : [],
    budgetHold: runtime.recoveryPaused ? await budgetHoldOf(tx, orgId, zone) : null,
  }
}

/** Lo que espera por el presupuesto, por línea, y hasta cuándo como mucho. */
async function budgetHoldOf(tx: Db, orgId: string, zone: { locale: string; timezone: string }): Promise<NonNullable<AdminPage["budgetHold"]>> {
  const held = await listBudgetHeldJobs(tx, orgId)
  const period = await currentSaasPeriod(tx, orgId)
  const until = new Intl.DateTimeFormat(zone.locale, { day: "numeric", month: "long", timeZone: zone.timezone }).format(new Date(period.end.getTime() - 1))
  return {
    until,
    total: held.reduce((sum, item) => sum + item.count, 0),
    lines: held.map((item) => ({ kind: item.kind, name: adminLineOf(item.kind)?.name ?? item.kind, count: item.count })),
  }
}

export interface AdminLineChange {
  at: string
  by: string | null
  /** «la prendió», «cambió el plazo a 5 días»… */
  what: string
}

function describeChange(changes: Record<string, unknown>): string {
  const parts: string[] = []
  if (changes.enabled === true) parts.push("la prendió")
  if (changes.enabled === false) parts.push("la apagó")
  if (changes.agentPart === true) parts.push("prendió «el agente le escribe»")
  if (changes.agentPart === false) parts.push("apagó «el agente le escribe»")
  if (changes.teamPart === true) parts.push("prendió la tarea para el equipo")
  if (changes.teamPart === false) parts.push("apagó la tarea para el equipo")
  if (typeof changes.days === "number") parts.push(`cambió el plazo a ${changes.days} ${plural(changes.days, "día", "días")}`)
  if (Array.isArray(changes.hoursBefore)) parts.push(`cambió los avisos a ${changes.hoursBefore.join(" y ")} horas antes`)
  if (typeof changes.delayHours === "number") parts.push(`cambió la espera a ${changes.delayHours} ${plural(changes.delayHours, "hora", "horas")}`)
  if (typeof changes.hour === "number") parts.push(`fijó la salida a las ${hourPhrase(changes.hour)}`)
  if (changes.hour === null) parts.push("quitó la hora fija de salida")
  if (changes.taskNote === true) parts.push("cambió la indicación de la tarea")
  if (changes.taskNote === false) parts.push("quitó la indicación de la tarea")
  if (changes.noRecommend === true) parts.push("pidió no recomendarla más")
  if (changes.noRecommend === false) parts.push("volvió a aceptar que se la recomienden")
  return parts.join(" y ") || "la cambió"
}

export interface AdminLineDetail extends AdminLineView {
  /** Lo que se ejecuta con las partes que van. */
  flow: LineFlow
  /** El flujo entero, para verlo con la línea apagada o con «Ver todo el flujo». */
  fullFlow: LineFlow
  /** Lo que recibe la persona, con datos de ejemplo. Null si la línea no escribe. */
  message: { text: string; buttons: string[] } | null
  /** Cómo es el aviso cuando el agente no puede escribir. */
  noticeExample: string | null
  weekStats: LineWeek | null
  people: AdminPersonRow[]
  peopleTotal: number
  changes: AdminLineChange[]
  /** El pedido con palabras que espera decisión, con su flujo, su prueba y su revisión. */
  draft: AdminDraftView | null
}

/** Una línea abierta: su flujo, lo que recibe la persona, su semana y lo que pasó con cada quien. */
export async function getAdminLine(tx: Db, orgId: string, can: (permission: string) => boolean, key: string): Promise<AdminLineDetail> {
  const line = requireLine(key)
  const runtime = await adminRuntime(tx, orgId)
  const zone = await getOrgLocale(tx, orgId)
  const rule = await findLineRule(tx, orgId, line.key)
  // Una línea que la clínica no creó no existe para ella.
  if (line.custom && !rule) throw notFound("Línea del administrador")
  const week = await weekOf(tx, orgId)
  const month = await weekOf(tx, orgId, SUGGESTION_DAYS)
  const timing = lineTiming(rule)
  const view = await lineView(tx, orgId, can, line, rule, { zone, week, month, receptionOn: runtime.receptionOn })
  const { recallMonths } = await productHooks(tx, orgId)
  // Lo que recibe la persona: el texto vigente de la clínica, con datos de ejemplo.
  const spec = await currentAutomationMessageOf(tx, orgId, line.key)
  const example = spec
    ? renderMessage(spec, Object.fromEntries(spec.variables.map((name) => [name, MESSAGE_VARIABLES[name].example])))
    : null
  const people = can(line.permission) ? await listAdminLinePeople(tx, orgId, can, line.key, { limit: 6 }) : { items: [], total: 0 }
  const history = rule
    ? await tx.execute<{ created_at: Date | string; name: string | null; metadata: { changes?: Record<string, unknown> } | null }>(sql`
        select a.created_at, u.name, a.metadata
        from audit_event a left join "user" u on u.id = a.actor_user_id
        where a.organization_id = ${orgId} and a.action = 'admin_line.updated' and a.entity_id = ${rule.id}
        order by a.created_at desc limit 5`)
    : []
  const words = CAUSE_WORDS.sin_permiso
  return {
    ...view,
    flow: flowOf(line, view, { days: view.days, timing, recallMonths }),
    fullFlow: flowOf(line, view, { days: view.days, timing, all: true, recallMonths }),
    message: spec && example ? { text: example.text, buttons: spec.buttons.map((button) => button.title) } : null,
    noticeExample: line.agent ? `No pude escribirle a Tomás Rivas: ${words.one}. ${words.fix}` : null,
    weekStats: week.get(line.key) ?? null,
    people: people.items,
    peopleTotal: people.total,
    changes: history.map((row) => ({
      at: new Date(row.created_at).toISOString(),
      by: row.name,
      what: describeChange(row.metadata?.changes ?? {}),
    })),
    draft: await draftViewOf(tx, orgId, can, line, rule),
  }
}

/** Prende, apaga o ajusta una línea desde su página. Devuelve cómo quedó. */
export async function updateAdminLine(
  tx: Db,
  orgId: string,
  actorUserId: string,
  can: (permission: string) => boolean,
  key: string,
  input: SetLineInput,
): Promise<AdminLineDetail> {
  requireLine(key)
  if (input.enabled === true && !(await getAdminSettings(tx, orgId)).enabled) {
    throw new ServiceError("ADMIN_OFF", 409, "Enciende primero al administrador: mientras esté apagado no hace nada")
  }
  await setLine(tx, orgId, actorUserId, key, input)
  return getAdminLine(tx, orgId, can, key)
}

/* ---------- Recomendaciones ---------- */

export interface AdminRecommendation {
  key: AdminLineKey
  name: string
  area: string
  title: string
  detail: string
  /** Cómo se calculó, en palabras, con el plazo usado. */
  how: string
  total: number
  /** Primeras filas, para la tarjeta; el detalle trae hasta el tope. */
  items: AdminCase[]
  /** Momento del cálculo: los datos son de ahora, no de una foto antigua. */
  computedAt: string
  actor: "agente" | "persona"
  /** Qué pasaría desde ahora si la prende. */
  description: string
  /** «Solo esta vez»: qué se haría con los casos de hoy; null si no aplica. */
  once: { label: string; detail: string } | null
  enabled: boolean
}

function toRecommendation(line: AdminLine, rule: RuleRow | null, result: CaseResult, limit: number): AdminRecommendation {
  const state = { enabled: rule?.enabled ?? false, agentPart: line.agent ? (rule?.agentPart ?? true) : false, teamPart: rule?.teamPart ?? true }
  const total = result.total
  const team = TASK_AREA_LABELS[line.team.area].team
  const writes = !!line.agent && state.agentPart
  const once =
    line.key === "recordatorio_cita"
      ? null
      : writes
        ? {
            label: `Escribirles esta vez`,
            detail:
              total > ADMIN_ONCE_LIMIT
                ? `Sofi les escribe a ${ADMIN_ONCE_LIMIT} de estas ${total} personas, las primeras de la lista, por única vez. A quien no pueda, lo dice con el motivo.`
                : `Sofi les escribe a ${total === 1 ? "esta persona" : `estas ${total} personas`}, por única vez. A quien no pueda, lo dice con el motivo.`,
          }
        : {
            label: `Crear ${Math.min(total, ADMIN_ONCE_LIMIT)} ${plural(Math.min(total, ADMIN_ONCE_LIMIT), "tarea", "tareas")}`,
            detail:
              total > ADMIN_ONCE_LIMIT
                ? `${ADMIN_ONCE_LIMIT} tareas de ${total} para ${team}, una por persona y por orden de la lista. No se envía ningún mensaje.`
                : `${total === 1 ? "Una tarea" : `${total} tareas`} para ${team}, una por persona. No se envía ningún mensaje.`,
          }
  return {
    key: line.key,
    name: line.name,
    area: line.area,
    title: result.title,
    detail: result.detail,
    how: result.how,
    total,
    items: result.items.slice(0, limit),
    computedAt: new Date().toISOString(),
    actor: actorOf(line, state),
    description: describeLine(line, { ...state, enabled: true }, lineTiming(rule)),
    once,
    enabled: state.enabled,
  }
}

export interface AdminAdvice {
  enabled: boolean
  recommendations: AdminRecommendation[]
  /** Cuántas más hay además de las mostradas. */
  more: number
}

/**
 * ¿Puede quien lee atender esta recomendación? Si puede prender la línea
 * (`agent.write`) o pedir «Solo esta vez»: cuando escribe el agente, quien
 * decide por él (`agent.decide`); cuando quedan tareas, quien puede crearlas.
 * Una línea sin «Solo esta vez» (recordar la cita) solo la atiende quien la prende.
 */
export function canActOnLine(line: AdminLine, rule: { agentPart?: boolean } | null, can: (permission: string) => boolean): boolean {
  if (can("agent.write")) return true
  if (line.key === "recordatorio_cita") return false
  const writes = !!line.agent && (rule?.agentPart ?? true)
  return writes ? can("agent.decide") : can("tasks.write")
}

/**
 * Lo que Argos recomienda prender: las líneas apagadas que hoy
 * tienen casos, que el rol de quien lee puede ver y que nadie pidió dejar de
 * recomendar. A lo sumo tres a la vez, en orden fijo. Con él apagado, ninguna.
 * Con `actionable` (Inicio), solo las que quien lee puede atender
 * (`canActOnLine`): a nadie le llega una recomendación sin nada que hacer.
 */
export async function getAdminRecommendations(
  tx: Db,
  orgId: string,
  can: (permission: string) => boolean,
  opts: { preview?: boolean; all?: boolean; actionable?: boolean } = {},
): Promise<AdminAdvice> {
  const settings = await getAdminSettings(tx, orgId)
  if (!settings.enabled && !opts.preview) return { enabled: false, recommendations: [], more: 0 }
  const zone = await getOrgLocale(tx, orgId)
  const rules = new Map((await listLineRules(tx, orgId)).map((rule) => [rule.kind, rule]))
  const found: AdminRecommendation[] = []
  for (const line of ADMIN_LINES) {
    const rule = rules.get(line.key) ?? null
    if (rule?.enabled || rule?.noRecommend || !can(line.permission)) continue
    if (opts.actionable && !canActOnLine(line, rule, can)) continue
    const result = await casesOf(tx, orgId, line.key, zone, lineDays(rule, line.key))
    if (result.total > 0) found.push(toRecommendation(line, rule, result, ADMIN_PREVIEW_ITEMS))
  }
  const shown = opts.all ? found : found.slice(0, ADMIN_MAX_RECOMMENDATIONS)
  return { enabled: settings.enabled, recommendations: shown, more: found.length - shown.length }
}

/** Una recomendación con su lista completa (hasta el tope), para revisar y decidir. */
export async function getAdminRecommendation(
  tx: Db,
  orgId: string,
  can: (permission: string) => boolean,
  key: string,
): Promise<AdminRecommendation> {
  const line = requireLine(key)
  if (!can(line.permission)) throw new ServiceError("FORBIDDEN", 403, "Tu rol no puede ver esta recomendación")
  const zone = await getOrgLocale(tx, orgId)
  const rule = await findLineRule(tx, orgId, line.key)
  return toRecommendation(line, rule, await casesOf(tx, orgId, line.key, zone, lineDays(rule, line.key)), ADMIN_LIST_LIMIT)
}

/**
 * «Solo esta vez»: atiende los casos de hoy de una línea sin prenderla. La
 * pide una persona. En las líneas que dejan trabajo al equipo las tareas
 * quedan creadas en el momento; en las que escribe el agente, los mensajes
 * salen en el siguiente ciclo con las comprobaciones de siempre. Repetirlo el
 * mismo día no duplica nada.
 */
export async function runAdminLineOnce(
  tx: Db,
  orgId: string,
  actorUserId: string,
  can: (permission: string) => boolean,
  key: string,
  deps: { secretsKey: Buffer },
): Promise<{ created: number; total: number; writes: boolean; all: number }> {
  const line = requireLine(key)
  if (!can(line.permission)) throw new ServiceError("FORBIDDEN", 403, "Tu rol no puede ver esta recomendación")
  const recommendation = await getAdminRecommendation(tx, orgId, can, key)
  if (!recommendation.once) throw validation(`«${line.name}» solo se puede prender`)
  // La línea necesita su fila para anotar los casos; se crea apagada, sin prender nada.
  const rule = (await findLineRule(tx, orgId, line.key)) ?? (await setLine(tx, orgId, actorUserId, line.key, {}))
  const writes = !!line.agent && rule.agentPart
  const now = new Date()
  // Todos los casos, no solo los que caben en la lista de la pantalla: la
  // recomendación promete escribirles a todas (hasta `ADMIN_ONCE_LIMIT`).
  const zone = await getOrgLocale(tx, orgId)
  const all = await casesOf(tx, orgId, line.key, zone, lineDays(rule, line.key), undefined, ADMIN_ONCE_LIMIT)
  let created = 0
  for (const item of all.items) {
    const job = await enqueueCase(tx, orgId, rule, line, item, now, { once: true })
    if (!job) continue
    created++
    if (!writes) await deliverJob(tx, orgId, job.id, now, deps)
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "agent.admin_once",
    entity: "agent_config",
    entityId: orgId,
    metadata: { key, created, total: all.items.length, all: all.total, writes },
  })
  // `total`: los casos atendidos ahora; `all`: los que hay, para decir «a 2000 de 2300».
  return { created, total: all.items.length, writes, all: all.total }
}

/* ---------- A quién no pudo escribirle ---------- */

export interface AdminUnreached {
  total: number
  /** Cuántos por motivo, con cómo se habilita. */
  byCause: Array<{ cause: AutomationCause; total: number; reason: string; fix: string }>
  people: Array<AdminPersonRow & { lineKey: string; lineName: string }>
}

/**
 * Las personas a las que el agente no pudo escribir en las últimas 24 horas,
 * con el motivo de cada una y cómo habilitarla. Es la fila de Inicio: un
 * motivo que se puede corregir, no una lista de errores.
 */
export async function getAdminUnreached(tx: Db, orgId: string, can: (permission: string) => boolean): Promise<AdminUnreached> {
  const kinds = [...ADMIN_LINES, ...CUSTOM_LINES].filter((line) => line.agent && can(line.permission)).map((line) => line.key)
  if (kinds.length === 0 || !(await getAdminSettings(tx, orgId)).enabled) return { total: 0, byCause: [], people: [] }
  const zone = await getOrgLocale(tx, orgId)
  // Quien no recibe recordatorios ya sale el día antes como una llamada (ADR 0040): no se cuenta dos veces.
  const where = sql`j.cause is not null and j.updated_at >= now() - interval '24 hours' and j.kind in ${kinds}
    and not (j.kind = 'recordatorio_cita' and j.cause = 'sin_permiso')`
  const rows = await tx.execute<JobView>(jobsQuery(orgId, where, ADMIN_LIST_LIMIT))
  const counts = await tx.execute<{ cause: string; n: number }>(sql`
    select j.cause, count(*)::int as n from automation_job j
    where j.organization_id = ${orgId} and ${where}
    group by j.cause order by count(*) desc, j.cause asc`)
  const byCause = counts
    .filter((row) => row.cause in CAUSE_WORDS)
    .map((row) => {
      const cause = row.cause as AutomationCause
      return { cause, total: Number(row.n), reason: CAUSE_WORDS[cause].one, fix: CAUSE_WORDS[cause].fix }
    })
  return {
    total: byCause.reduce((sum, row) => sum + row.total, 0),
    byCause,
    people: rows.map((row) => ({ ...toPersonRow(row, zone), lineKey: row.kind, lineName: adminLineOf(row.kind)?.name ?? row.kind })),
  }
}

/** Lo suyo para «Resumen» del agente: cuántas tiene prendidas, quién las hace y cuántas más recomienda. */
export async function getAdminOverview(tx: Db, orgId: string, can: (permission: string) => boolean) {
  const settings = await getAdminSettings(tx, orgId)
  const rules = (await listLineRules(tx, orgId)).filter((rule) => rule.enabled && adminLineOf(rule.kind))
  const byAgent = rules.filter((rule) => adminLineOf(rule.kind)?.agent && rule.agentPart).length
  const advice = settings.enabled ? await getAdminRecommendations(tx, orgId, can) : { recommendations: [], more: 0 }
  return {
    enabled: settings.enabled,
    on: rules.length,
    byAgent,
    byTeam: rules.length - byAgent,
    recommended: advice.recommendations.length + advice.more,
  }
}

/* ---------- Ciclo del worker ---------- */

export interface TickDeps {
  secretsKey: Buffer
  publicBaseUrl: string
  /** La invitación de calendario de los avisos de cita (`DeliverDeps.storage`). */
  storage?: Storage
  limit?: number
  /** Para pedir plantillas al proveedor. Sin esto, el ciclo no pide ninguna. */
  templates?: TemplateDeps
  /** Lee lo último que escribió la persona antes de escribirle (`DeliverDeps.alreadyTold`). */
  alreadyTold?: DeliverDeps["alreadyTold"]
  /** Formato del canal para lo que el agente escribe por su cuenta al insistir y al despedirse. */
  format?: ConversationCareDeps["format"]
}

export interface TickSummary {
  orgs: number
  programados: number
  entregados: number
  fallidos: number
  /** Conversaciones en que el agente insistió y que cerró por silencio. */
  insistidas: number
  cerradas: number
  /** Tareas que se cerraron solas porque su motivo desapareció. */
  tareasCerradas: number
  /** «Ver respuesta» que salieron por respuestas del equipo por entregar (R1). */
  respuestasOfrecidas: number
  /** Temas de cita o precio que Sofi retomó a la hora de apertura (decisión 5 del pulido). */
  temasRetomados: number
}

/**
 * Un paso del ciclo que no detiene a los demás: si falla en una clínica, se
 * registra y el ciclo sigue con lo suyo y con las demás clínicas.
 */
async function apart<T>(orgId: string, what: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    console.warn(`[ciclo] ${what} de ${orgId}: ${error instanceof Error ? error.message : String(error)}`)
    return fallback
  }
}

/** Las líneas que escriben a la persona, cada una con quien anota sus casos. */
const AGENT_SYNCS: Array<[AdminLineKey, (tx: Db, orgId: string, now: Date) => Promise<{ programados: number }>]> = [
  ["recordatorio_cita", syncAppointmentReminders],
  ["recordatorio_control", syncCheckupReminders],
  ["seguimiento_presupuesto", syncBudgetFollowUps],
  ["seguimiento_comercial", syncOpportunityFollowUps],
  ["seguimiento_no_asistencia", syncVisitFollowUps],
  ["invitar_a_volver", syncLapsedInvites],
  ["cita_cancelada", syncCancelledAppointments],
]

/**
 * Ciclo del Administrador para el worker: por cada organización que lo tiene
 * encendido, anota los casos nuevos de sus líneas prendidas y atiende lo
 * vencido. Con él apagado no se hace nada. Con Recepción apagada, las líneas
 * que escriben quedan en pausa (no acumulan casos); las que dejan trabajo al
 * equipo siguen.
 *
 * Las organizaciones se listan de la tabla global `organization` (sin RLS de
 * tenant); el trabajo corre siempre con `appDb` dentro de `withOrgContext`.
 * Despertador durable: pg_cron → pgmq `automation_ticks`.
 */
export async function tickAutomations(
  ownerDb: Db,
  appDb: Db,
  now: Date,
  deps: TickDeps,
): Promise<TickSummary> {
  const orgRows = await ownerDb.select({ orgId: organization.id }).from(organization)
  const summary: TickSummary = { orgs: 0, programados: 0, entregados: 0, fallidos: 0, insistidas: 0, cerradas: 0, tareasCerradas: 0, respuestasOfrecidas: 0, temasRetomados: 0 }
  for (const { orgId } of orgRows) {
    // Restricción/pausa comercial: no se programa, coordina ni entrega nada;
    // lo encolado se conserva para la reanudación. La ingesta no pasa por aquí.
    if (await shouldSkipSaasOrg(ownerDb, orgId)) continue
    // Ninguna conversación queda abierta (ADR 0024): es de Recepción, no del
    // Administrador, así que corre aunque este esté apagado.
    const care = await withOrgContext(appDb, orgId, (tx) =>
      tickConversationCare(tx, orgId, now, deps.format ? { format: deps.format } : {}),
    )
    summary.insistidas += care.nudged
    summary.cerradas += care.closed
    // «Sofi se ofrece» (decisión 5 del pulido de la Bandeja): es de Recepción, como insistir y cerrar.
    summary.temasRetomados += await apart(orgId, "temas retomados", 0, () =>
      withOrgContext(appDb, orgId, (tx) =>
        retakeForgottenTopics(tx, orgId, now, { secretsKey: deps.secretsKey, ...(deps.format ? { format: deps.format } : {}) }),
      ),
    )
    // Las tareas se cierran solas cuando su motivo desaparece, aunque el
    // Administrador esté apagado: una cita que pasó no espera a que lo prendan.
    summary.tareasCerradas += await withOrgContext(appDb, orgId, (tx) => settleTasks(tx, orgId, now))
    // Las pruebas del chat web de más de 7 días se borran solas (fase 6 del pulido).
    await apart(orgId, "pruebas del chat web", 0, () => withOrgContext(appDb, orgId, (tx) => purgeOldWebchatTests(tx, orgId, now)))
    // Las respuestas del equipo por entregar (R1) son de la Bandeja: «Ver
    // respuesta» sale cuando Meta lo aprueba, dentro del «Horario de recontacto».
    summary.respuestasOfrecidas += await apart(orgId, "«Ver respuesta»", 0, () =>
      withOrgContext(appDb, orgId, (tx) => offerPendingHeldReplies(tx, orgId, now)),
    )
    // Los mensajes de la clínica se piden a WhatsApp aunque el Administrador
    // esté apagado: «Retomar la conversación» y los propios son de la Bandeja.
    if (deps.templates) {
      const templates = deps.templates
      await withOrgContext(appDb, orgId, (tx) =>
        requestNeededTemplates(tx, orgId, deps.secretsKey, now, templates),
      )
    }
    const runtime = await withOrgContext(appDb, orgId, (tx) => adminRuntime(tx, orgId))
    if (!runtime.adminOn) continue
    summary.orgs++
    // Secuencial: las sincronizaciones comparten la transacción del tenant.
    const synced = await withOrgContext(appDb, orgId, async (tx) => {
      let total = 0
      const rules = new Map((await listLineRules(tx, orgId)).map((rule) => [rule.kind, rule]))
      for (const [key, sync] of AGENT_SYNCS) {
        const rule = rules.get(key)
        // En pausa: Recepción es quien escribe. Si la línea solo deja tareas, sigue.
        if (!rule?.enabled || (rule.agentPart && !runtime.receptionOn)) continue
        total += (await sync(tx, orgId, now)).programados
      }
      total += await syncTeamLines(tx, orgId, now)
      return total
    })
    summary.programados += synced
    const delivered = await withOrgContext(appDb, orgId, async (tx) => {
      await reconcileDeliveries(tx, orgId, now)
      return deliverDueJobs(
        tx,
        orgId,
        now,
        {
          secretsKey: deps.secretsKey,
          publicBaseUrl: deps.publicBaseUrl,
          alreadyTold: deps.alreadyTold,
          ...(deps.storage ? { storage: deps.storage } : {}),
        },
        deps.limit ?? 25,
      )
    })
    for (const r of delivered) {
      if (r.outcome === "enviado" || r.outcome === "tarea") summary.entregados++
      if (r.outcome === "fallido") summary.fallidos++
    }
  }
  return summary
}
