/**
 * «Invitar a volver» (issue 139, decisiones 13 a 15 del lienzo): quién no viene
 * hace 6 meses, a quién ya se invitó y cómo se anota una invitación. Es la misma
 * regla de Reportes (`lapsedSql`) que usan el atajo de Pacientes, la línea del
 * Administrador y su cifra: no hay una segunda definición.
 *
 * Una invitación es una fila de `audit_event` con `INVITED_TO_RETURN_ACTION`, de
 * la persona (`entity_id` = id del paciente). Vale para la invitación que
 * manda el agente y para la que anota quien la llamó o habló en persona.
 */
import type { Db } from "@odentia/db"
import { patient } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, sql } from "drizzle-orm"
import { notFound } from "./errors.js"
import { lapsedSql } from "./report-patients.js"

export const INVITED_TO_RETURN_ACTION = "paciente.invitada_a_volver"

/** Meses sin invitar a quien ya lo fue (decisión 15: vuelve a tocarle 6 meses después). */
export const INVITE_CYCLE_MONTHS = 6

export interface InviteCase {
  /** La última cita atendida, que es el caso de la invitación. */
  appointmentId: string
  patientId: string
  personId: string
  personName: string
  lastVisitAt: string
  /** Cuántas veces se la invitó en total: cambia el caso cada ciclo. */
  invites: number
}

/**
 * Pacientes a quienes toca invitar ahora: sin venir hace 6 meses (`lapsedSql`),
 * sin invitación en los últimos 6 meses y sin «no quiere» de seguimiento. Con
 * `patientId`, dice solo si esa persona hoy le toca.
 */
export async function lapsedToInvite(
  tx: Db,
  orgId: string,
  timezone: string,
  now: Date,
  options: { patientId?: string; limit?: number } = {},
): Promise<InviteCase[]> {
  const only = options.patientId ? sql`and l.patient_id = ${options.patientId}::uuid` : sql``
  const limit = options.limit ? sql`limit ${options.limit}` : sql``
  const rows = await tx.execute<{
    appointment_id: string
    patient_id: string
    person_id: string
    person_name: string
    last_visit: Date | string
    invites: number
  }>(sql`
    with ${lapsedSql(orgId, { branch: null, timezone }, now)}
    select l.id as appointment_id, l.patient_id, p.person_id, pp.display_name as person_name, l.starts_at as last_visit,
      (select count(*)::int from audit_event ae
        where ae.organization_id = ${orgId} and ae.action = ${INVITED_TO_RETURN_ACTION}
          and ae.entity = 'patient' and ae.entity_id = l.patient_id::text) as invites
    from lapsed l
    join patient p on p.organization_id = ${orgId} and p.id = l.patient_id
    join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.is_active
    where not exists (
        select 1 from audit_event ae
        where ae.organization_id = ${orgId} and ae.action = ${INVITED_TO_RETURN_ACTION}
          and ae.entity = 'patient' and ae.entity_id = l.patient_id::text
          and ae.created_at > ${now.toISOString()}::timestamptz - make_interval(months => ${INVITE_CYCLE_MONTHS}))
      and not exists (
        select 1 from automation_consent ac
        where ac.organization_id = ${orgId} and ac.contact_id = p.person_id
          and ac.purpose = 'seguimiento' and ac.status = 'revoked')
      ${only}
    order by l.starts_at asc, l.patient_id asc
    ${limit}
  `)
  return rows.map((row) => ({
    appointmentId: row.appointment_id,
    patientId: row.patient_id,
    personId: row.person_id,
    personName: row.person_name,
    lastVisitAt: new Date(row.last_visit).toISOString(),
    invites: Number(row.invites),
  }))
}

/** Su última invitación y si pidió no recibir seguimiento, de cada paciente pedido. */
export interface InviteStatus {
  invitedAt: Date | null
  /** Quien la anotó con «Ya la invité»; nulo si fue el agente. */
  invitedBy: string | null
  declined: boolean
}

export async function inviteStatusOf(tx: Db, orgId: string, patientIds: string[]): Promise<Map<string, InviteStatus>> {
  if (patientIds.length === 0) return new Map()
  const rows = await tx.execute<{ patient_id: string; invited_at: Date | string | null; invited_by: string | null; declined: boolean }>(sql`
    select p.id as patient_id, last.created_at as invited_at, u.name as invited_by,
      exists (select 1 from automation_consent ac where ac.organization_id = ${orgId} and ac.contact_id = p.person_id
        and ac.purpose = 'seguimiento' and ac.status = 'revoked') as declined
    from patient p
    left join lateral (
      select ae.created_at, ae.actor_user_id from audit_event ae
      where ae.organization_id = ${orgId} and ae.action = ${INVITED_TO_RETURN_ACTION}
        and ae.entity = 'patient' and ae.entity_id = p.id::text
      order by ae.created_at desc limit 1
    ) last on true
    left join "user" u on u.id = last.actor_user_id
    where p.organization_id = ${orgId} and p.id in (${sql.join(patientIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
  return new Map(
    rows.map((row) => [
      row.patient_id,
      { invitedAt: row.invited_at ? new Date(row.invited_at) : null, invitedBy: row.invited_by, declined: row.declined },
    ]),
  )
}

/**
 * Lo que dice «Qué sigue» de quien no tiene nada pendiente y ya no toca
 * invitar (decisión 15): «Invitada por Ana Torres el 3 oct · la próxima, en abril»
 * mientras corre su ciclo, o «No quiere invitaciones» si no viene y pidió no
 * recibir seguimiento. Nulo si no aplica: vino después de la invitación o
 * tiene una cita por venir. `by` es quién la invitó, para «Lo lleva…»; nadie
 * la lleva si no quiere invitaciones.
 */
export function inviteStepText(
  status: InviteStatus | undefined,
  person: { lastVisitAt: string | null; nextAppointmentAt: string | null },
  zone: { locale: string; timezone: string },
  now: Date,
): { text: string; by: "agente" | "persona" | null } | null {
  if (!status || person.nextAppointmentAt) return null
  const lastVisit = person.lastVisitAt ? new Date(person.lastVisitAt) : null
  const cycleStart = monthsAgo(now, INVITE_CYCLE_MONTHS)
  const { invitedAt } = status
  if (invitedAt && invitedAt > cycleStart && (!lastVisit || invitedAt > lastVisit)) {
    const day = new Intl.DateTimeFormat(zone.locale, { day: "numeric", month: "short", timeZone: zone.timezone }).format(invitedAt).replace(".", "")
    // El mes solo, en minúscula: algunos idiomas lo escriben con mayúscula cuando va suelto.
    const next = new Intl.DateTimeFormat(zone.locale, { month: "long", timeZone: zone.timezone })
      .format(monthsAgo(invitedAt, -INVITE_CYCLE_MONTHS))
      .toLocaleLowerCase(zone.locale)
    const by = status.invitedBy ? ` por ${status.invitedBy.trim()}` : ""
    return { text: `Invitada${by} el ${day} · la próxima, en ${next}`, by: status.invitedBy ? "persona" : "agente" }
  }
  if (status.declined && (!lastVisit || lastVisit < cycleStart)) return { text: "No quiere invitaciones", by: null }
  return null
}

/** La misma fecha, `months` meses antes (negativo: después). */
function monthsAgo(date: Date, months: number): Date {
  const result = new Date(date)
  result.setUTCMonth(result.getUTCMonth() - months)
  return result
}

/** Anota una invitación hecha: a mano («Ya la invité») o la que dejó el agente. */
export async function recordInvitation(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  patientId: string,
  via: string,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: INVITED_TO_RETURN_ACTION,
    entity: "patient",
    entityId: patientId,
    metadata: { via },
  })
}

/**
 * «Ya la invité»: quien la llamó o habló con ella en persona lo anota. Recibe a
 * la persona (su contacto), que es la misma antes y después de ser paciente.
 */
export async function markInvitedToReturn(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  contactId: string,
  via: string = "telefono",
): Promise<void> {
  const [row] = await tx
    .select({ id: patient.id })
    .from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.personId, contactId)))
    .limit(1)
  if (!row) throw notFound("Paciente")
  await recordInvitation(tx, orgId, actorUserId, row.id, via)
}
