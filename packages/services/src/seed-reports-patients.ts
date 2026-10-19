/**
 * Semilla manual de Reportes › Pacientes, sobre la historia de `seed-reports.ts`:
 * cuándo y por dónde nos buscó cada persona, cómo nos conoció y sus controles.
 * Solo corrige y agrega registros del pasado; no envía nada ni activa nada.
 *
 * - La historia se inserta de golpe: las fichas nacen «hoy» y algunas citas de
 *   quien escribió antes de su primera visita quedaron creadas antes de su
 *   mensaje. Aquí la ficha nace con su primera cita y esa cita, después del
 *   primer mensaje: el embudo ve a cada persona en el mes en que nos buscó.
 *   Las fichas de demostración que no tienen citas ni mensajes nacen antes de
 *   la historia: no son personas que nos buscaron este mes.
 * - Las conversaciones de la historia se reparten por canal como en una
 *   clínica mediana (WhatsApp primero), no por turnos.
 * - «Cómo nos conoció» de la lista (decisión 3); algunos no lo dijeron.
 * - Un control de mantenimiento seis meses después de la primera visita: lo
 *   hizo quien volvió en esas semanas; los demás siguen pendientes o se cancelaron.
 *
 * Determinista: el orden es el de los números de historia y de las conversaciones.
 */
import type { Db } from "@odentia/db"
import { clinicalFollowUp } from "@odentia/db/schema/clinical"
import { sql } from "drizzle-orm"
import { chunks, generator } from "./seed-reports.js"

export interface ReportsPatientsSeedInput {
  orgId: string
  ownerUserId: string
}

/** Por dónde escribe la gente en una clínica mediana. */
const CHANNEL_WEIGHTS = [
  { channel: "whatsapp", weight: 58 },
  { channel: "instagram", weight: 16 },
  { channel: "webchat", weight: 11 },
  { channel: "messenger", weight: 8 },
  { channel: "email", weight: 5 },
  { channel: "telegram", weight: 2 },
]

/** Cómo nos conocieron; `null`: no lo dijo. */
const REFERRAL_WEIGHTS: Array<{ kind: string | null; weight: number; said?: readonly string[] }> = [
  { kind: "recomendacion", weight: 34 },
  { kind: "redes_sociales", weight: 22 },
  { kind: "google_mapas", weight: 17 },
  { kind: "paso_por_aqui", weight: 8 },
  { kind: "convenio", weight: 5 },
  { kind: "otro", weight: 4, said: ["Feria de salud", "Volante en el mercado", "Radio", "Por mi colegio"] },
  { kind: null, weight: 10 },
]

const DAY_MS = 86_400_000
/** El control de mantenimiento vence a los seis meses. */
const CONTROL_DAYS = 182

export async function seedReportsPatients(
  tx: Db,
  input: ReportsPatientsSeedInput,
): Promise<{ moved: number; channels: number; referrals: number; controls: number }> {
  const { orgId } = input
  const random = generator(20_261_118)

  // --- Quien escribió y después agendó su primera visita ---------------------------------------
  const moved = await tx.execute(sql`
    with first_in as (
      select c.contact_id, min(m.created_at) as at from conversation c
      join message m on m.organization_id = c.organization_id and m.conversation_id = c.id and m.direction = 'in'
      where c.organization_id = ${orgId} group by c.contact_id
    ), first_visit as (
      select distinct on (a.patient_id) a.id, a.patient_id, a.created_at, a.starts_at
      from appointment a where a.organization_id = ${orgId} order by a.patient_id, a.starts_at, a.id
    ), early as (
      select v.id, f.at, v.starts_at from first_visit v
      join patient p on p.organization_id = ${orgId} and p.id = v.patient_id
      join first_in f on f.contact_id = p.person_id
      where v.created_at < f.at and v.starts_at > f.at
    )
    update appointment a set created_at = least(e.at + interval '2 hours', e.at + (e.starts_at - e.at) / 2)
    from early e where a.organization_id = ${orgId} and a.id = e.id`)
  // La ficha nace con su primera cita; la persona, con lo primero que se supo de ella.
  await tx.execute(sql`
    update patient p set created_at = v.created_at
    from (select patient_id, min(created_at) as created_at from appointment where organization_id = ${orgId} group by patient_id) v
    where p.organization_id = ${orgId} and p.id = v.patient_id and v.created_at < p.created_at`)
  await tx.execute(sql`
    update contact pp set created_at = k.first_at
    from (
      select person_id, min(at) as first_at from (
        select p.person_id, p.created_at as at from patient p where p.organization_id = ${orgId}
        union all
        select c.contact_id, m.created_at from conversation c
        join message m on m.organization_id = c.organization_id and m.conversation_id = c.id and m.direction = 'in'
        where c.organization_id = ${orgId}
      ) moments group by person_id
    ) k
    where pp.organization_id = ${orgId} and pp.id = k.person_id and k.first_at < pp.created_at`)
  const [start] = await tx.execute<{ at: string | null }>(sql`
    select min(created_at) as at from appointment where organization_id = ${orgId}`)
  if (start?.at) {
    const before = new Date(new Date(start.at).getTime() - DAY_MS)
    await tx.execute(sql`
      with idle as (
        select p.id, p.person_id from patient p
        where p.organization_id = ${orgId} and p.created_at > ${before.toISOString()}::timestamptz
          and not exists (select 1 from appointment a where a.organization_id = p.organization_id and a.patient_id = p.id)
          and not exists (select 1 from conversation c where c.organization_id = p.organization_id and c.contact_id = p.person_id)
      ), people as (
        update contact pp set created_at = ${before.toISOString()}::timestamptz
        from idle where pp.organization_id = ${orgId} and pp.id = idle.person_id returning pp.id
      )
      update patient p set created_at = ${before.toISOString()}::timestamptz from idle where p.organization_id = ${orgId} and p.id = idle.id`)
  }
  // Su registro dice la misma fecha que su ficha («Registrado» en sus datos).
  await tx.execute(sql`
    update patient_registration r set created_at = p.created_at
    from patient p where r.organization_id = ${orgId} and p.organization_id = r.organization_id and p.id = r.patient_id and p.created_at < r.created_at`)

  // --- Por dónde escribieron --------------------------------------------------------------------
  // También por los canales que hoy están desconectados: la historia es de cuando funcionaban.
  const connections = await tx.execute<{ id: string; channel: string }>(sql`
    select distinct on (channel) id, channel from channel_connection
    where organization_id = ${orgId} order by channel, (status = 'active') desc, created_at, id`)
  const byChannel = new Map(connections.map((row) => [row.channel, row.id]))
  const weights = CHANNEL_WEIGHTS.filter((item) => byChannel.has(item.channel))
  const threads = await tx.execute<{ id: string }>(sql`
    select id from conversation where organization_id = ${orgId} and external_thread_id like 'seed-reportes-%'
    order by (substring(external_thread_id from 15))::int`)
  let channels = 0
  if (weights.length > 0) {
    for (const batch of chunks([...threads])) {
      const rows = batch.map((thread) => sql`(${thread.id}::uuid, ${byChannel.get(random.weighted(weights).channel)}::uuid)`)
      await tx.execute(sql`
        update conversation c set channel_connection_id = v.connection_id
        from (values ${sql.join(rows, sql`, `)}) as v(id, connection_id)
        where c.organization_id = ${orgId} and c.id = v.id`)
      channels += batch.length
    }
  }

  // --- Cómo nos conocieron ----------------------------------------------------------------------
  const patients = await tx.execute<{ id: string }>(sql`
    select id from patient where organization_id = ${orgId} and referral_kind is null order by patient_number`)
  for (const batch of chunks([...patients])) {
    const rows = batch.map((row) => {
      const choice = random.weighted(REFERRAL_WEIGHTS)
      const said = choice.said ? random.pick(choice.said) : null
      return sql`(${row.id}::uuid, ${choice.kind}::text, ${said}::text)`
    })
    await tx.execute(sql`
      update patient p set referral_kind = v.kind, referral_source = v.said
      from (values ${sql.join(rows, sql`, `)}) as v(id, kind, said)
      where p.organization_id = ${orgId} and p.id = v.id`)
  }

  // --- Controles de mantenimiento ---------------------------------------------------------------
  const now = Date.now()
  const firsts = await tx.execute<{ patient_id: string; number: number; encounter_id: string; ended_at: string }>(sql`
    select distinct on (e.patient_id) e.patient_id, p.patient_number as number, e.id as encounter_id, e.finalized_at as ended_at
    from encounter e join patient p on p.organization_id = e.organization_id and p.id = e.patient_id
    where e.organization_id = ${orgId} and e.status = 'finalizada' and e.finalized_at is not null
      and not exists (select 1 from clinical_follow_up f where f.organization_id = e.organization_id and f.patient_id = e.patient_id)
    order by e.patient_id, e.finalized_at, e.id`)
  const visits = await tx.execute<{ patient_id: string; encounter_id: string; ended_at: string }>(sql`
    select e.patient_id, e.id as encounter_id, e.finalized_at as ended_at from encounter e
    where e.organization_id = ${orgId} and e.status = 'finalizada' and e.finalized_at is not null
    order by e.patient_id, e.finalized_at, e.id`)
  const visitsOf = new Map<string, Array<{ encounterId: string; at: number }>>()
  for (const row of visits) {
    const list = visitsOf.get(row.patient_id) ?? []
    list.push({ encounterId: row.encounter_id, at: new Date(row.ended_at).getTime() })
    visitsOf.set(row.patient_id, list)
  }
  const controls: Array<typeof clinicalFollowUp.$inferInsert> = []
  for (const first of [...firsts].sort((a, b) => a.number - b.number)) {
    const originAt = new Date(first.ended_at).getTime()
    const dueAt = originAt + CONTROL_DAYS * DAY_MS
    // Solo los que vencen hasta dentro de dos meses: más allá nadie los mira todavía.
    if (dueAt > now + 60 * DAY_MS) continue
    const base = {
      organizationId: orgId,
      patientId: first.patient_id,
      originEncounterId: first.encounter_id,
      kind: "mantenimiento",
      title: "Control de mantenimiento",
      dueAt: new Date(dueAt),
      createdBy: input.ownerUserId,
      createdAt: new Date(originAt),
    }
    // Lo hizo quien volvió entre un mes antes y seis semanas después de la fecha.
    const back = visitsOf.get(first.patient_id)?.find((visit) => visit.at >= dueAt - 30 * DAY_MS && visit.at <= dueAt + 42 * DAY_MS)
    if (back && back.at <= now) {
      controls.push({ ...base, status: "realizado", completedEncounterId: back.encounterId, outcome: "Sin novedades", completedAt: new Date(back.at) })
    } else if (dueAt < now && random.chance(0.2)) {
      controls.push({ ...base, status: "cancelado", cancelledReason: "No respondió", cancelledAt: new Date(dueAt + 14 * DAY_MS) })
    } else {
      controls.push({ ...base, status: "pendiente" })
    }
  }
  for (const batch of chunks(controls)) await tx.insert(clinicalFollowUp).values(batch)

  return { moved: moved.count ?? 0, channels, referrals: patients.length, controls: controls.length }
}
