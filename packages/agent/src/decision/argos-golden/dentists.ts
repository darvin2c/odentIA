/** Respuestas correctas de los odontólogos (eval/argos-owner.json). */
import { agendaMinutes, collectedByProfessional, getReportProfessionals } from "@odentia/services"
import { sql } from "drizzle-orm"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"

export function dentistSolvers(h: GoldenHelpers): GoldenSolvers {
  const { tx, org, now, scope, money, fig, show, listOf, monthStart } = h
  const nowIso = now.toISOString()
  const yearAgo = new Date(now.getTime() - 365 * 86_400_000)
  const dayKey = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: h.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
  /** Los últimos 365 días hasta hoy, como periodo de Reportes. */
  const lastYear = `${dayKey(yearAgo)}..${dayKey(now)}`
  /** «octubre de 2026»: el mes en curso, con su nombre. */
  const month = new Intl.DateTimeFormat(scope.locale, { month: "long", year: "numeric", timeZone: h.tz }).format(now)
  const pct = (part: number, total: number): string => (total > 0 ? `${Math.round((part / total) * 100)} %` : "sin dato")
  const hoursOf = (minutes: number): string => `${(Math.round((minutes / 60) * 10) / 10).toLocaleString(scope.locale)} h`

  /** Lo cargado este mes de lo que atendió cada uno: conceptos de procedimientos de sus atenciones firmadas, sin anulados. */
  const chargedByDentist = () =>
    tx.execute<{ id: string; name: string; cents: string; charges: number; encounters: number }>(sql`
      select e.dentist_user_id as id, u.name, sum(c.amount_cents)::text as cents, count(*)::int as charges, count(distinct e.id)::int as encounters
      from patient_charge c
      join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id and ep.voided_at is null
      join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
      join "user" u on u.id = e.dentist_user_id
      where c.organization_id = ${org} and c.voided_at is null and c.created_at >= ${monthStart}::timestamptz and c.created_at < ${nowIso}::timestamptz
      group by 1, 2 order by sum(c.amount_cents) desc, 2`)

  /** Citas atendidas y pacientes distintos atendidos del mes, por profesional. */
  const attendedByDentist = () =>
    tx.execute<{ id: string; name: string; patients: number; appointments: number }>(sql`
      select u.id, u.name, count(distinct a.patient_id)::int as patients, count(*)::int as appointments
      from appointment a join "user" u on u.id = a.dentist_user_id
      where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at >= ${monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz
      group by 1, 2 order by 3 desc, 4 desc, 2`)

  return {
    d1: async () => {
      const result = await fig("cobrado", "profesional")
      const charged = await chargedByDentist()
      const year = await fig("cobrado", "profesional", lastYear)
      const top = result.rows[0]
      const total = result.rows.reduce((sum, row) => sum + (row.value.value ?? 0), 0)
      return {
        respuesta: top
          ? `En ${month} (hasta hoy) quien más ingresos genera es ${top.label}: ${show(result, top.value.value)} cobrados de lo que atendió (${pct(top.value.value ?? 0, total)} de lo atribuido a los ${result.rows.length} odontólogos). Le siguen ${listOf(result.rows.slice(1).map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.`
          : `En ${month} todavía no hay cobros de lo que atendió cada odontólogo.`,
        criterio: "Lo cobrado por profesional de Reportes, del mes en curso: lo pagado de lo que atendió cada uno, sin anulados ni lo devuelto (la base de las comisiones).",
        nota: `Por lo cargado este mes de lo que atendió (pagado o no): ${listOf(charged.map((row) => ({ name: row.name, value: money(Number(row.cents)) })))}. En los últimos 12 meses, por lo cobrado: ${listOf(year.rows.slice(0, 4).map((row) => ({ name: row.label, value: show(year, row.value.value) })))}.`,
        datos: { cobrado: result.rows, cargado: charged, doceMeses: year.rows },
      }
    },

    d2: async () => {
      const rows = await attendedByDentist()
      const [all] = await tx.execute<{ patients: number }>(sql`
        select count(distinct a.patient_id)::int as patients from appointment a
        where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at >= ${monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz`)
      return {
        respuesta: rows.length
          ? `En ${month} (hasta hoy): ${listOf(rows.map((row) => ({ name: row.name, value: `${row.patients} pacientes` })))}. En toda la clínica, ${all?.patients ?? 0} pacientes distintos (alguno lo vio más de un odontólogo).`
          : `En ${month} todavía no hay citas atendidas.`,
        criterio: "Pacientes distintos con al menos una cita atendida en el mes en curso, hasta ahora, por el profesional de la cita.",
        nota: `Contando citas atendidas en vez de pacientes (como «Citas atendidas» de Reportes): ${listOf(rows.map((row) => ({ name: row.name, value: `${row.appointments} citas` })))}.`,
        datos: { filas: rows, clinica: all?.patients ?? 0 },
      }
    },

    d3: async () => {
      const result = await fig("cobrado", "profesional")
      const charged = await chargedByDentist()
      const attended = await attendedByDentist()
      const clinic = await fig("cobrado")
      const producing = result.rows.filter((row) => (row.value.value ?? 0) > 0)
      const total = producing.reduce((sum, row) => sum + (row.value.value ?? 0), 0)
      const average = producing.length ? total / producing.length : 0
      const chargedTotal = charged.reduce((sum, row) => sum + Number(row.cents), 0)
      const clinicTotal = clinic.total.value ?? 0
      return {
        respuesta: producing.length
          ? `En ${month} (hasta hoy) la producción promedio es de ${money(average)} por odontólogo: ${money(total)} cobrados de lo que atendieron ${producing.length} odontólogos (${listOf(producing.map((row) => ({ name: row.label, value: show(result, row.value.value) })))}).`
          : `En ${month} todavía no hay producción cobrada.`,
        criterio: "Producción = lo cobrado de lo que atendió cada uno (Reportes, por profesional) en el mes en curso; el promedio divide entre los odontólogos con producción.",
        nota: `Con lo cargado de lo que atendieron (pagado o no): ${money(charged.length ? chargedTotal / charged.length : 0)} por odontólogo (${money(chargedTotal)} entre ${charged.length}). Con todo lo cobrado de la clínica (incluye productos y lo que no se liga a una atención): ${money(attended.length ? clinicTotal / attended.length : 0)} por cada uno de los ${attended.length} odontólogos con citas atendidas (${show(clinic)}).`,
        datos: { cobrado: result.rows, cargado: charged, cobradoClinica: clinic.total, conCitas: attended.length },
      }
    },

    d4: async () => {
      const result = await fig("canceladas", "profesional")
      const year = await fig("canceladas", "profesional", lastYear)
      const byRate = (rows: typeof result.rows) =>
        [...rows].filter((row) => (row.value.whole ?? 0) > 0).sort((a, b) => (b.value.value ?? -1) - (a.value.value ?? -1) || (b.value.part ?? 0) - (a.value.part ?? 0) || a.label.localeCompare(b.label))
      const rows = byRate(result.rows)
      const byCount = [...result.rows].sort((a, b) => (b.value.part ?? 0) - (a.value.part ?? 0) || a.label.localeCompare(b.label))
      const words = (list: typeof rows, figure: typeof result) =>
        listOf(list.map((row) => ({ name: row.label, value: `${show(figure, row.value.value)}, ${row.value.part ?? 0} de ${row.value.whole ?? 0}` })))
      const top = rows[0]
      return {
        respuesta: top
          ? `En ${month} (hasta hoy) la mayor tasa de cancelaciones es de ${top.label}: ${show(result, top.value.value)} (${top.value.part ?? 0} de ${top.value.whole ?? 0} citas que ya pasaron). Le siguen ${words(rows.slice(1), result)}. En toda la clínica, ${show(result)}.`
          : `En ${month} todavía no hay citas que hayan pasado.`,
        criterio: "«Canceladas» de Reportes por profesional, del mes en curso: canceladas ÷ citas que ya pasaron (atendidas, no vinieron, canceladas y sin marcar).",
        nota: `Por cuántas, no por tasa: ${listOf(byCount.map((row) => ({ name: row.label, value: `${row.value.part ?? 0} ${row.value.part === 1 ? "cancelada" : "canceladas"}` })))}. En los últimos 12 meses: ${words(byRate(year.rows), year)}.`,
        datos: { mes: result.rows, total: result.total, doceMeses: year.rows },
      }
    },

    d5: async () => {
      const done = (since: string) =>
        tx.execute<{ name: string; times: number; lines: number; encounters: number }>(sql`
          select u.name, sum(ep.quantity)::int as times, count(*)::int as lines, count(distinct e.id)::int as encounters
          from encounter_procedure ep
          join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
          join "user" u on u.id = e.dentist_user_id
          where ep.organization_id = ${org} and ep.voided_at is null and e.started_at >= ${since}::timestamptz and e.started_at < ${nowIso}::timestamptz
          group by 1 order by 2 desc, 1`)
      const rows = await done(monthStart)
      const year = await done(yearAgo.toISOString())
      return {
        respuesta: rows.length
          ? `En ${month} (hasta hoy) quien más tratamientos realizó es ${rows[0]?.name}: ${rows[0]?.times} tratamientos. Todos: ${listOf(rows.map((row) => ({ name: row.name, value: `${row.times}` })))}.`
          : `En ${month} todavía no hay tratamientos realizados.`,
        criterio: "Procedimientos no anulados de atenciones firmadas del mes en curso, por quien atendió, contando su cantidad (3 sellantes son 3).",
        nota: `Sin contar la cantidad (procedimientos registrados): ${listOf(rows.map((row) => ({ name: row.name, value: `${row.lines}` })))}. En los últimos 12 meses: ${listOf(year.map((row) => ({ name: row.name, value: `${row.times}` })))}.`,
        datos: { mes: rows, doceMeses: year },
      }
    },

    d6: async () => {
      const result = await fig("cobrado", "profesional")
      const charged = await chargedByDentist()
      const attended = await attendedByDentist()
      const payers = await tx.execute<{ id: string; patients: number }>(sql`
        select e.dentist_user_id as id, count(distinct c.patient_id)::int as patients
        from patient_payment_application a
        join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
        join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null
        join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id and ep.voided_at is null
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
        where a.organization_id = ${org} and a.voided_at is null and a.created_at >= ${monthStart}::timestamptz and a.created_at < ${nowIso}::timestamptz
        group by 1`)
      const rows = result.rows
        .map((row) => {
          const cents = row.value.value ?? 0
          const patients = payers.find((item) => item.id === row.key)?.patients ?? 0
          const visits = attended.find((item) => item.id === row.key)?.appointments ?? 0
          const own = charged.find((item) => item.id === row.key)
          return {
            name: row.label,
            cents,
            patients,
            perPatient: patients > 0 ? cents / patients : null,
            visits,
            perVisit: visits > 0 ? cents / visits : null,
            chargedCents: Number(own?.cents ?? 0),
            encounters: own?.encounters ?? 0,
            perEncounter: own && own.encounters > 0 ? Number(own.cents) / own.encounters : null,
          }
        })
        .sort((a, b) => (b.perPatient ?? -1) - (a.perPatient ?? -1))
      const value = (cents: number | null) => (cents === null ? "sin dato" : money(cents))
      return {
        respuesta: rows.length
          ? `En ${month} (hasta hoy), lo que deja en promedio cada paciente que pagó algo de lo que atendió cada profesional: ${listOf(rows.map((row) => ({ name: row.name, value: `${value(row.perPatient)}: ${money(row.cents)} de ${row.patients} pacientes` })))}.`
          : `En ${month} todavía no hay cobros de lo que atendió cada profesional.`,
        criterio: "Lo cobrado de lo que atendió cada uno (Reportes, por profesional) ÷ pacientes distintos que pagaron algo de sus atenciones este mes. odentIA no guarda el ticket por profesional: un ticket de pago puede cubrir tratamientos de varios.",
        nota: `Por cita atendida del mes (lo cobrado ÷ sus citas atendidas): ${listOf(rows.map((row) => ({ name: row.name, value: `${value(row.perVisit)}, ${row.visits} citas` })))}. Por atención firmada, con lo cargado (pagado o no): ${listOf(rows.map((row) => ({ name: row.name, value: `${value(row.perEncounter)}, ${row.encounters} atenciones` })))}.`,
        datos: { filas: rows },
      }
    },

    d7: async () => {
      const [end] = await tx.execute<{ at: string }>(sql`select ((date_trunc('month', now() at time zone ${h.tz}) + interval '1 month') at time zone ${h.tz})::text as at`)
      const people = await tx.execute<{ id: string; name: string }>(sql`
        select distinct s.dentist_user_id as id, u.name from professional_schedule s join "user" u on u.id = s.dentist_user_id
        where s.organization_id = ${org} and s.is_active order by 2`)
      const rest: Array<{ name: string; minutes: number; availMin: number }> = []
      for (const person of people) {
        const minutes = await agendaMinutes(tx, org, { start: now, end: new Date(end?.at ?? nowIso) }, { dentistUserId: person.id })
        rest.push({
          name: person.name,
          minutes: minutes.days.reduce((total, day) => total + Math.max(0, day.availMin - day.occMin), 0),
          availMin: minutes.days.reduce((total, day) => total + day.availMin, 0),
        })
      }
      rest.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name))
      const screen = await fig("horas_libres", "profesional")
      const top = rest[0]
      return {
        respuesta: top
          ? `De aquí a fin de ${month}, quien más horas libres tiene en la agenda es ${top.name}: ${hoursOf(top.minutes)} sin citas. Le siguen ${listOf(rest.slice(1).map((row) => ({ name: row.name, value: hoursOf(row.minutes) })))}.`
          : "Nadie tiene horario cargado.",
        criterio: "Lo que queda del mes, a partir de ahora: horas del horario de cada profesional menos sus ausencias y sus citas no canceladas (la cuenta de Reportes › Agenda).",
        nota: `«Horas libres» de Reportes en lo que va del mes (del 1 hasta hoy): ${listOf(screen.rows.map((row) => ({ name: row.label, value: show(screen, row.value.value) })))}.`,
        datos: { restoDelMes: rest, reportes: screen.rows },
      }
    },

    d8: async () => {
      const report = await getReportProfessionals(tx, org, { period: "este_mes" }, now)
      const before = scope.window.previous
      const previousCollected = await collectedByProfessional(tx, org, { start: before.start, end: before.end }, scope.currency)
      const previousAttended = await tx.execute<{ id: string; attended: number }>(sql`
        select a.dentist_user_id as id, count(*)::int as attended from appointment a
        where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at >= ${before.start.toISOString()}::timestamptz and a.starts_at < ${before.end.toISOString()}::timestamptz
        group by 1`)
      const rows = report.rows.map((row) => ({
        name: row.name,
        collectedCents: row.collectedCents,
        attended: row.attended,
        noShow: row.noShow,
        total: row.total,
        occupied: row.availMin > 0 ? Math.round((row.occMin / row.availMin) * 100) : null,
        presented: row.presented,
        accepted: row.accepted,
        previousCollectedCents: previousCollected.find((item) => item.professionalUserId === row.userId)?.cobradoCents ?? 0,
        previousAttended: previousAttended.find((item) => item.id === row.userId)?.attended ?? 0,
      }))
      const line = (row: (typeof rows)[number]) =>
        `${money(row.collectedCents)} cobrados de lo que atendió, ${row.attended} citas atendidas, agenda ocupada ${row.occupied === null ? "sin horario" : `${row.occupied} %`}, no vinieron ${pct(row.noShow, row.total)}, presupuestos aceptados ${row.presented ? `${row.accepted} de ${row.presented}` : "ninguno presentado"}`
      return {
        respuesta: rows.length
          ? `En ${month} (hasta hoy), de más a menos cobrado: ${rows.map((row) => `${row.name}: ${line(row)}`).join("; ")}.`
          : `En ${month} todavía no hay actividad por profesional.`,
        criterio: "La tabla «Por profesional» de Reportes › Resumen, del mes en curso: lo cobrado de lo que atendió, citas atendidas, agenda ocupada, no vinieron (÷ citas que ya pasaron) y presupuestos que presentó y se aceptaron.",
        nota: `Contra los mismos días del mes anterior (cobrado y citas atendidas): ${listOf(rows.map((row) => ({ name: row.name, value: `${money(row.collectedCents)} contra ${money(row.previousCollectedCents)}; ${row.attended} contra ${row.previousAttended} citas` })))}.`,
        datos: { filas: rows },
      }
    },

    d9: async () => {
      const specialty = sql`coalesce(case when c.product_id is not null then 'Productos (no es una especialidad)' end, os.name, 'Sin especialidad')`
      const joins = sql`
        left join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id
        left join treatment_budget_item bi on bi.organization_id = c.organization_id and bi.id = c.budget_item_id
        left join treatment_plan_item pi on pi.organization_id = c.organization_id and pi.id = c.plan_item_id
        left join service_catalog sc on sc.organization_id = c.organization_id and sc.id = coalesce(ep.service_id, bi.service_id, pi.service_id)
        left join org_specialty os on os.organization_id = sc.organization_id and os.id = sc.specialty_id`
      const end = scope.window.end.toISOString()
      // La regla de lo cobrado por tratamiento de Reportes (`collectedByTreatment`): lo aplicado en el mes, y lo devuelto se resta el día de la devolución.
      const rows = await tx.execute<{ name: string; cents: string }>(sql`
        with x as (
          select ${specialty} as name, a.amount_cents::bigint as cents
          from patient_payment_application a
          join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id
          join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id
          ${joins}
          where a.organization_id = ${org} and c.currency = ${scope.currency} and a.replaces_application_id is null
            and a.created_at >= ${monthStart}::timestamptz and a.created_at < ${end}::timestamptz
            and (a.voided_at is null or a.voided_at >= ${end}::timestamptz or a.return_id is not null)
            and (c.voided_at is null or c.voided_at >= ${end}::timestamptz or a.return_id is not null)
            and (p.voided_at is null or p.voided_at >= ${end}::timestamptz)
          union all
          select ${specialty},
            -(a.amount_cents - coalesce((select sum(n.amount_cents) from patient_payment_application n
              where n.organization_id = a.organization_id and n.replaces_application_id = a.id), 0))::bigint
          from patient_payment_application a
          join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id
          join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id
          ${joins}
          where a.organization_id = ${org} and c.currency = ${scope.currency} and a.return_id is not null
            and a.voided_at >= ${monthStart}::timestamptz and a.voided_at < ${end}::timestamptz
            and (p.voided_at is null or p.voided_at >= ${end}::timestamptz)
        )
        select name, sum(cents)::text as cents from x group by 1 having sum(cents) <> 0 order by sum(cents) desc, 1`)
      const charged = await tx.execute<{ name: string; cents: string }>(sql`
        select ${specialty} as name, sum(c.amount_cents)::text as cents from patient_charge c ${joins}
        where c.organization_id = ${org} and c.voided_at is null and c.created_at >= ${monthStart}::timestamptz and c.created_at < ${nowIso}::timestamptz
        group by 1 order by sum(c.amount_cents) desc, 1`)
      const total = rows.reduce((sum, row) => sum + Number(row.cents), 0)
      const collected = await fig("cobrado")
      const top = rows[0]
      return {
        respuesta: top
          ? `En ${month} (hasta hoy) la especialidad que más ingresos genera es ${top.name}: ${money(Number(top.cents))} cobrados (${pct(Number(top.cents), total)} de ${money(total)}). Le siguen ${listOf(rows.slice(1, 5).map((row) => ({ name: row.name, value: money(Number(row.cents)) })))}.`
          : `En ${month} todavía no hay cobros.`,
        criterio: "Lo cobrado del mes en curso aplicado a cada concepto (la regla de «Lo cobrado por tratamiento» de Reportes), agrupado por la especialidad del servicio; los productos van aparte.",
        nota: `Por lo cargado este mes (pagado o no): ${listOf(charged.slice(0, 5).map((row) => ({ name: row.name, value: money(Number(row.cents)) })))}. Las especialidades suman ${money(total)} y no los ${show(collected)} cobrados del mes: lo pagado que quedó a favor, sin aplicarse a un tratamiento, no tiene especialidad.`,
        datos: { cobrado: rows, cargado: charged, cobradoMes: collected.total },
      }
    },
  }
}
