import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { handoffOpenSql } from "./handoff-state.js"
import { getOrgLocale } from "./locale.js"
import { AGENT_SOURCES } from "./saas-actions.js"
import type { WorkspaceAccess } from "./workspace.js"

/**
 * «Mientras no estabas» (decisión 8 del lienzo de acceso, aprobada el
 * 2026-10-17): una vez al día, la primera vez que la persona mira Inicio en el
 * día de la clínica, se le cuenta lo que hicieron los agentes desde su visita
 * anterior. No depende de la sesión: una pestaña abierta toda la noche cuenta
 * desde la última vez que se miró.
 *
 * Cada número es de lo que su rol ve: las citas y los pacientes de vuelta, quien
 * ve la agenda (el odontólogo, solo los suyos); los casos, quien los atiende
 * (lo que nadie tomó más lo suyo, salvo quien ve todas las tareas). Sin nada que
 * contar no hay línea.
 */
export interface HomeAway {
  since: string
  appointments: number | null
  recovered: number | null
  cases: number | null
}

/** Anota la visita y, si es la primera del día y hubo trabajo, lo que hicieron los agentes. */
export async function recordHomeVisit(
  tx: Db,
  orgId: string,
  userId: string,
  access: Pick<WorkspaceAccess, "appointments" | "ownAppointments" | "agent" | "allTasks">,
  now: Date = new Date(),
): Promise<HomeAway | null> {
  const { timezone } = await getOrgLocale(tx, orgId)
  const [day] = await tx.execute<{ date: string }>(
    sql`select to_char(${now.toISOString()}::timestamptz at time zone ${timezone}, 'YYYY-MM-DD') as date`,
  )
  const today = day?.date ?? now.toISOString().slice(0, 10)
  const [previous] = await tx.execute<{ last_seen_at: string; greeted_on: string | null }>(sql`
    select last_seen_at::text, greeted_on::text from home_visit
    where organization_id = ${orgId} and user_id = ${userId}
    for update`)
  const firstToday = !!previous && previous.greeted_on !== today
  await tx.execute(sql`
    insert into home_visit (organization_id, user_id, last_seen_at, greeted_on)
    values (${orgId}, ${userId}, ${now.toISOString()}, ${today})
    on conflict (organization_id, user_id) do update
      set last_seen_at = excluded.last_seen_at,
          greeted_on = coalesce(${firstToday ? today : null}::date, home_visit.greeted_on)`)
  // La primera vez que entra no hay «antes»: no se le saluda con números.
  if (!firstToday || !previous) return null

  const since = previous.last_seen_at
  const own = access.ownAppointments ? sql`and a.professional_user_id = ${userId}` : sql``
  const [counts] = await tx.execute<{ appointments: number; recovered: number; cases: number }>(sql`
    select
      ${
        access.appointments
          ? sql`(select count(*)::int from appointment a
        where a.organization_id = ${orgId} and a.source in (${sql.join(
          AGENT_SOURCES.map((source) => sql`${source}`),
          sql`, `,
        )})
          and a.created_at > ${since}::timestamptz and a.created_at <= ${now.toISOString()}::timestamptz ${own})`
          : sql`0`
      } as appointments,
      ${
        access.appointments
          ? sql`(select count(*)::int from saas_action s
        join appointment a on a.organization_id = s.organization_id and a.id = s.appointment_id
        where s.organization_id = ${orgId} and s.kind = 'cita'
          and s.occurred_at > ${since}::timestamptz and s.occurred_at <= ${now.toISOString()}::timestamptz ${own})`
          : sql`0`
      } as recovered,
      ${
        access.agent
          ? sql`(select count(*)::int from agent_handoff h
        where h.organization_id = ${orgId} and h.created_at > ${since}::timestamptz
          and ${handoffOpenSql(sql.raw("h"))}
          ${access.allTasks ? sql`` : sql`and (h.assignee_user_id is null or h.assignee_user_id = ${userId})`})`
          : sql`0`
      } as cases`)
  const away: HomeAway = {
    since: new Date(since).toISOString(),
    appointments: access.appointments ? (counts?.appointments ?? 0) : null,
    recovered: access.appointments ? (counts?.recovered ?? 0) : null,
    cases: access.agent ? (counts?.cases ?? 0) : null,
  }
  return (away.appointments ?? 0) + (away.recovered ?? 0) + (away.cases ?? 0) > 0 ? away : null
}
