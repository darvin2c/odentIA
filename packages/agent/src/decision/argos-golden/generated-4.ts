/** Las respuestas correctas de las preguntas generadas (`eval/argos-generadas.json`), parte 4: equipo y agenda (g076 a g100). */
import {
  addDays,
  agendaMinutes,
  computeFigure,
  dayStart,
  type FigureGroup,
  type FigureResult,
  type FigureRow,
  getAgendaReport,
  type ReportScope,
  reportScope,
} from "@odentia/services"
import { sql } from "drizzle-orm"
import { goldenWords } from "./finance.js"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"
import { monthLabel, sameDaysWords } from "./trends.js"

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]

/** «los lunes», «los sábados». */
function weekdaysWord(weekday: number): string {
  const name = WEEKDAYS[weekday] ?? ""
  return name.endsWith("s") ? name : `${name}s`
}

/** A quién va una tarea sin responsable (`TASK_AREAS`). */
const AREA_WORDS: Record<string, string> = {
  recepcion: "Recepción",
  caja: "Caja",
  clinico: "el equipo clínico",
  administracion: "Administración",
}

/** Cómo llegó la cita (`appointment.source`). */
const SOURCE_WORDS: Record<string, string> = { recepcion: "por recepción", agent: "por el agente", enlace: "por su enlace" }

/** Un bloqueo o una ausencia de la agenda, con sus días y horas de la sede. */
type Block = {
  professional: string | null
  professionalId: string | null
  branch: string
  branchId: string
  room: string | null
  kind: string
  reason: string | null
  fromDay: string
  fromTime: string
  lastDay: string
  toTime: string
  startMs: number
  endMs: number
}

export function generatedSolvers4(h: GoldenHelpers): GoldenSolvers {
  const w = goldenWords(h)
  const days = sameDaysWords(h)
  const { money, show, listOf } = h
  const nowIso = h.now.toISOString()
  const today = w.todayKey
  const weekdayOf = (key: string): number => new Date(`${key}T12:00:00Z`).getUTCDay()
  /** El lunes de esta semana (día de la clínica). */
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7))
  const year = Number(today.slice(0, 4))
  const startOf = (key: string): Date => {
    const [y, m, d] = key.split("-").map(Number) as [number, number, number]
    return dayStart(h.tz, y, m, d)
  }
  const pct = (part: number, total: number): string => (total > 0 ? `${Math.round((part / total) * 100)} %` : "sin dato")
  const hoursOf = (minutes: number): string => `${(Math.round((minutes / 60) * 10) / 10).toLocaleString(h.scope.locale)} h`
  const clock = (minutes: number): string => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`
  const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000)
  /** «el miércoles 21 de octubre», «del lunes 19 al miércoles 21 de octubre». */
  const spanWords = (from: string, to: string): string =>
    from === to
      ? `el ${w.dayWords(from)}`
      : `del ${from.slice(0, 7) === to.slice(0, 7) ? w.dayWords(from).replace(/ de [^ ]+$/, "") : w.dayWords(from)} al ${w.dayWords(to)}`
  const lower = (text: string): string => text.charAt(0).toLocaleLowerCase(h.scope.locale) + text.slice(1)
  const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

  const scopeAt = (period: string, branchId?: string): Promise<ReportScope> => reportScope(h.tx, h.org, { period, ...(branchId ? { branchId } : {}) }, h.now)
  const figWith = (scope: ReportScope, figure: string, group: FigureGroup = "total"): Promise<FigureResult> => computeFigure({ ...h.ctx, scope }, { figure, group })
  const rowOf = (result: FigureResult, key: string): FigureRow | undefined => result.rows.find((row) => row.key === key)

  const branchNamed = async (pattern: string) => {
    const [row] = await h.tx.execute<{ id: string; name: string }>(sql`
      select id, name from branch where organization_id = ${h.org} and name ilike ${pattern} order by is_active desc, name limit 1`)
    return row ?? null
  }
  const branchNames = async () => {
    const rows = await h.tx.execute<{ id: string; name: string }>(sql`select id, name from branch where organization_id = ${h.org} and is_active order by name`)
    return [...rows]
  }
  const userNamed = async (pattern: string) => {
    const [row] = await h.tx.execute<{ id: string; name: string }>(sql`
      select u.id, u.name from "user" u
      where u.name ilike ${pattern} and exists (select 1 from member m where m.organization_id = ${h.org} and m.user_id = u.id)
      order by u.name limit 1`)
    return row ?? null
  }

  /** Bloqueos y ausencias que tocan un tramo, con los días y horas de su sede. */
  const blocksIn = async (start: Date, end: Date): Promise<Block[]> => {
    const rows = await h.tx.execute<Block>(sql`
      select u.name as professional, k.professional_user_id as "professionalId", b.name as branch, b.id as "branchId", c.name as room, k.kind, k.reason,
        to_char(k.starts_at at time zone coalesce(b.timezone, ${h.tz}), 'YYYY-MM-DD') as "fromDay",
        to_char(k.starts_at at time zone coalesce(b.timezone, ${h.tz}), 'HH24:MI') as "fromTime",
        to_char((k.ends_at - interval '1 second') at time zone coalesce(b.timezone, ${h.tz}), 'YYYY-MM-DD') as "lastDay",
        to_char(k.ends_at at time zone coalesce(b.timezone, ${h.tz}), 'HH24:MI') as "toTime",
        (extract(epoch from k.starts_at) * 1000)::float8 as "startMs", (extract(epoch from k.ends_at) * 1000)::float8 as "endMs"
      from schedule_block k
      join branch b on b.organization_id = k.organization_id and b.id = k.branch_id
      left join "user" u on u.id = k.professional_user_id
      left join schedule_room c on c.organization_id = k.organization_id and c.id = k.room_id
      where k.organization_id = ${h.org} and k.starts_at < ${end.toISOString()}::timestamptz and k.ends_at > ${start.toISOString()}::timestamptz
      order by k.starts_at, b.name`)
    return [...rows]
  }
  /** «del lunes 26 al miércoles 28 de octubre», «el sábado 24 de octubre de 15:00 a 18:00». */
  const blockWhen = (block: Block): string => {
    if (block.fromTime === "00:00" && block.toTime === "00:00") return spanWords(block.fromDay, block.lastDay)
    if (block.fromDay === block.lastDay) return `el ${w.dayWords(block.fromDay)} de ${block.fromTime} a ${block.toTime}`
    return `del ${w.dayWords(block.fromDay)} a las ${block.fromTime} al ${w.dayWords(block.lastDay)} a las ${block.toTime}`
  }
  const blockWhy = (block: Block): string => lower(block.reason ?? (block.kind === "ausencia" ? "ausencia" : "bloqueo"))
  /** Días de la sede que toca un bloqueo. */
  const blockDays = (block: Block): number => daysBetween(block.fromDay, block.lastDay) + 1
  /** Quién atiende, con su horario vigente: sede, día de la semana y tramo. */
  const currentSchedules = async (professionalUserId?: string) => {
    const rows = await h.tx.execute<{ userId: string; name: string; branch: string; branchId: string; weekday: number; start: number; end: number; from: string }>(sql`
      select s.professional_user_id as "userId", u.name, b.name as branch, b.id as "branchId", s.weekday, s.start_min as start, s.end_min as end, s.valid_from::text as from
      from professional_schedule s
      join branch b on b.organization_id = s.organization_id and b.id = s.branch_id
      join "user" u on u.id = s.professional_user_id
      where s.organization_id = ${h.org} and s.is_active and s.valid_until is null
        ${professionalUserId ? sql`and s.professional_user_id = ${professionalUserId}` : sql``}
      order by u.name, b.name, s.weekday, s.start_min`)
    return [...rows]
  }

  return {
    // --- Equipo ---------------------------------------------------------------------------
    g076: async () => {
      const surco = await branchNamed("%surco%")
      const branches = await branchNames()
      const [specialty] = await h.tx.execute<{ id: string; name: string; people: string | null }>(sql`
        select os.id, os.name, string_agg(u.name, ', ' order by u.name) as people
        from org_specialty os
        left join professional_specialty ps on ps.organization_id = os.organization_id and ps.specialty_id = os.id
          and exists (select 1 from member m where m.organization_id = os.organization_id and m.user_id = ps.user_id)
        left join "user" u on u.id = ps.user_id
        where os.organization_id = ${h.org} and os.is_active and (os.key ilike 'ortodon%' or os.name ilike 'ortodon%')
        group by os.id, os.name order by os.name limit 1`)
      const done = (since: string) =>
        specialty
          ? h.tx.execute<{ name: string; branch: string; branchId: string; times: number }>(sql`
              select u.name, b.name as branch, b.id as "branchId", sum(ep.quantity)::int as times
              from encounter_procedure ep
              join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
              join service_catalog sc on sc.organization_id = ep.organization_id and sc.id = ep.service_id
              join branch b on b.organization_id = e.organization_id and b.id = e.branch_id
              join "user" u on u.id = e.professional_user_id
              where ep.organization_id = ${h.org} and ep.voided_at is null and sc.specialty_id = ${specialty.id}
                and e.started_at >= ${since}::timestamptz and e.started_at < ${nowIso}::timestamptz
              group by 1, 2, 3 order by 4 desc, 1`)
          : Promise.resolve([])
      const month = [...(await done(h.monthStart))]
      const twelve = [...(await done(startOf(w.yearAgoKey).toISOString()))]
      const [activity] = surco
        ? await h.tx.execute<{ schedules: number; rooms: number; appointments: number; encounters: number }>(sql`
            select (select count(*) from professional_schedule s where s.organization_id = ${h.org} and s.branch_id = ${surco.id} and s.is_active and s.valid_until is null)::int as schedules,
              (select count(*) from schedule_room c where c.organization_id = ${h.org} and c.branch_id = ${surco.id} and c.is_active)::int as rooms,
              (select count(*) from appointment a where a.organization_id = ${h.org} and a.branch_id = ${surco.id})::int as appointments,
              (select count(*) from encounter e where e.organization_id = ${h.org} and e.branch_id = ${surco.id} and e.voided_at is null)::int as encounters`)
        : []
      const where = (rows: typeof month) => listOf(rows.map((row) => ({ name: `${row.name} en ${row.branch}`, value: `${row.times}` })))
      const assigned = specialty
        ? specialty.people
          ? `La especialidad ${specialty.name} la tiene asignada ${specialty.people}.`
          : `Nadie del equipo tiene asignada la especialidad ${specialty.name}.`
        : "La clínica no tiene la especialidad de ortodoncia."
      const missing = activity
        ? [activity.schedules === 0 ? "horarios de profesionales" : "", activity.rooms === 0 ? "unidades dentales" : "", activity.appointments === 0 ? "citas" : ""].filter(Boolean)
        : []
      const inSurco = surco ? month.filter((row) => row.branchId === surco.id) : []
      const respuesta = !surco
        ? `No tienes una sede Surco: tus sedes son ${branches.map((row) => row.name).join(", ")}. ${assigned}`
        : inSurco.length
          ? `En ${surco.name}, este mes (${w.monthSoFar}) hicieron ortodoncia ${where(inSurco)}. ${assigned}`
          : `En ${surco.name} no hace ortodoncia nadie${missing.length ? `: la sede no tiene ${missing.join(", ").replace(/, ([^,]+)$/, " ni $1")} registrados` : " este mes"}. ${assigned} ${month.length ? `En las otras sedes, los tratamientos de ortodoncia de este mes (${w.monthSoFar}) los hicieron ${where(month)}.` : "Este mes nadie hizo tratamientos de ortodoncia."}`
      return {
        respuesta,
        criterio:
          "La sede Surco (horarios vigentes, unidades dentales, citas y atenciones), quién tiene asignada la especialidad de ortodoncia (`professional_specialty`) y quién hizo tratamientos de esa especialidad (procedimientos no anulados de atenciones firmadas, por la especialidad del servicio, contando la cantidad) en el mes en curso, por sede.",
        nota: `En los últimos 12 meses, los tratamientos de ortodoncia los hicieron ${where(twelve) || "nadie"}.`,
        datos: { sede: surco, actividad: activity ?? null, especialidad: specialty ?? null, mes: month, doceMeses: twelve },
      }
    },

    g077: async () => {
      const yearStart = startOf(`${year}-01-01`)
      const blocks = (await blocksIn(yearStart, startOf(`${year + 1}-01-01`))).filter((block) => block.professionalId !== null)
      const people = await h.tx.execute<{ id: string; name: string }>(sql`
        select distinct u.id, u.name from professional_schedule s join "user" u on u.id = s.professional_user_id
        where s.organization_id = ${h.org} and exists (select 1 from member m where m.organization_id = s.organization_id and m.user_id = s.professional_user_id)
        order by u.name`)
      /** Días que ya pasaron de cada ausencia (hasta hoy), y los que están por venir. */
      const pastDays = (block: Block): number => {
        if (block.startMs >= h.now.getTime()) return 0
        const last = block.endMs <= h.now.getTime() ? block.lastDay : today < block.lastDay ? today : block.lastDay
        return daysBetween(block.fromDay, last) + 1
      }
      const rows = people.map((person) => {
        const own = blocks.filter((block) => block.professionalId === person.id)
        return {
          name: person.name,
          past: own.reduce((sum, block) => sum + pastDays(block), 0),
          all: own.reduce((sum, block) => sum + blockDays(block), 0),
          blocks: own,
        }
      })
      const absent = rows.filter((row) => row.past > 0).sort((a, b) => b.past - a.past || a.name.localeCompare(b.name))
      const coming = blocks.filter((block) => block.endMs > h.now.getTime())
      const [closures] = await h.tx.execute<{ days: number }>(sql`
        select count(distinct (b.name, (k.starts_at at time zone coalesce(b.timezone, ${h.tz}))::date))::int as days
        from schedule_block k join branch b on b.organization_id = k.organization_id and b.id = k.branch_id
        where k.organization_id = ${h.org} and k.professional_user_id is null and k.room_id is null
          and k.starts_at >= ${yearStart.toISOString()}::timestamptz and k.starts_at < ${nowIso}::timestamptz`)
      const comingWords = listOf(coming.map((block) => ({ name: `${block.professional} ${blockWhen(block)}`, value: blockWhy(block) })))
      return {
        respuesta: absent.length
          ? `En lo que va de ${year} (hasta hoy), días con ausencia registrada: ${listOf(absent.map((row) => ({ name: row.name, value: plural(row.past, "día", "días") })))}; los demás, ninguno.${coming.length ? ` Por venir: ${comingWords}.` : ""}`
          : `En lo que va de ${year} (hasta hoy) ningún profesional faltó: no hay ausencias registradas que ya hayan pasado (${rows.map((row) => row.name).join(", ")}: 0 días).${coming.length ? ` Las que hay están por venir: ${comingWords}.` : ""}`,
        criterio:
          "Ausencias de la agenda (bloqueos con profesional, `schedule_block`) de este año que ya pasaron, contando los días de la sede que tocan, por profesional con horario. Los feriados y cierres de toda la sede no son faltas de nadie.",
        nota: `Contando también las ya registradas para el resto del año: ${listOf(rows.map((row) => ({ name: row.name, value: plural(row.all, "día", "días") })))}. Este año, hasta hoy, las sedes cerraron ${plural(closures?.days ?? 0, "día", "días")} por feriados o bloqueos de toda la sede (sumando cada sede).`,
        datos: { porProfesional: rows.map(({ blocks: own, ...row }) => ({ ...row, ausencias: own })), cierresDeSede: closures?.days ?? 0 },
      }
    },

    g078: async () => {
      const nextMonday = addDays(monday, 7)
      const nextSunday = addDays(monday, 13)
      const blocks = await blocksIn(startOf(nextMonday), startOf(addDays(monday, 14)))
      const absent = blocks.filter((block) => block.professionalId !== null)
      const closed = blocks.filter((block) => block.professionalId === null && block.room === null)
      const rooms = blocks.filter((block) => block.professionalId === null && block.room !== null)
      const thisWeek = (await blocksIn(h.now, startOf(nextMonday))).filter((block) => block.professionalId !== null)
      const schedules = await currentSchedules()
      const byPerson = new Map<string, Set<number>>()
      for (const row of schedules) byPerson.set(row.name, (byPerson.get(row.name) ?? new Set()).add(row.weekday))
      const usual = [...byPerson]
        .filter(([, weekdays]) => weekdays.size < 7)
        .map(([name, weekdays]) => {
          const worked = [...weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
          const off = [0, 1, 2, 3, 4, 5, 6].filter((day) => !weekdays.has(day)).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
          const join = (list: number[]) => list.map(weekdaysWord).join(", ").replace(/, ([^,]+)$/, " y $1")
          return worked.length >= 4 ? `${name} no atiende los ${join(off)}` : `${name} solo atiende los ${join(worked)}`
        })
      const week = spanWords(nextMonday, nextSunday)
      const closedWords = closed.map((block) => `${block.branch} cierra ${blockWhen(block)} (${blockWhy(block)})`).join("; ")
      return {
        respuesta: absent.length
          ? `La próxima semana (${week}) no va a estar ${listOf(absent.map((block) => ({ name: `${block.professional} ${blockWhen(block)}`, value: blockWhy(block) })))}.${closed.length ? ` Además, ${closedWords}.` : ""} El resto del equipo tiene su horario de siempre.`
          : `La próxima semana (${week}) no hay ausencias registradas: todos tienen su horario de siempre.${closed.length ? ` Pero ${closedWords}.` : ""}`,
        criterio: "Ausencias de profesionales y cierres de sede (bloqueos de la agenda) que tocan la próxima semana, de lunes a domingo, con los días y horas de la sede.",
        nota: `Por su horario de siempre: ${usual.join("; ") || "todos atienden todos los días"}.${rooms.length ? ` Unidades dentales bloqueadas: ${rooms.map((block) => `${block.room} de ${block.branch} ${blockWhen(block)} (${blockWhy(block)})`).join("; ")}.` : ""}${thisWeek.length ? ` Lo que queda de esta semana: ${listOf(thisWeek.map((block) => ({ name: `${block.professional} ${blockWhen(block)}`, value: blockWhy(block) })))}.` : ""}`,
        datos: { semana: { desde: nextMonday, hasta: nextSunday }, ausencias: absent, cierres: closed, unidades: rooms, estaSemana: thisWeek },
      }
    },

    g079: async () => {
      const rows = await h.tx.execute<{ name: string; people: string | null }>(sql`
        select os.name, string_agg(u.name, ', ' order by u.name) as people
        from org_specialty os
        left join professional_specialty ps on ps.organization_id = os.organization_id and ps.specialty_id = os.id
          and exists (select 1 from member m where m.organization_id = os.organization_id and m.user_id = ps.user_id)
        left join "user" u on u.id = ps.user_id
        where os.organization_id = ${h.org} and os.is_active
        group by os.id, os.name order by os.name`)
      const without = await h.tx.execute<{ name: string }>(sql`
        select distinct u.name from member m join "user" u on u.id = m.user_id
        where m.organization_id = ${h.org}
          and (m.role = 'clinician' or exists (select 1 from professional_schedule s where s.organization_id = m.organization_id and s.professional_user_id = m.user_id))
          and not exists (select 1 from professional_specialty ps join org_specialty os on os.organization_id = ps.organization_id and os.id = ps.specialty_id and os.is_active
            where ps.organization_id = m.organization_id and ps.user_id = m.user_id)
        order by 1`)
      const done = await h.tx.execute<{ specialty: string; people: string }>(sql`
        select os.name as specialty, string_agg(x.name || ' (' || x.times || ')', ', ' order by x.times desc, x.name) as people
        from (
          select sc.specialty_id, u.name, sum(ep.quantity)::int as times
          from encounter_procedure ep
          join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
          join service_catalog sc on sc.organization_id = ep.organization_id and sc.id = ep.service_id
          join "user" u on u.id = e.professional_user_id
          where ep.organization_id = ${h.org} and ep.voided_at is null and e.started_at >= ${h.monthStart}::timestamptz and e.started_at < ${nowIso}::timestamptz
          group by 1, 2) x
        join org_specialty os on os.organization_id = ${h.org} and os.id = x.specialty_id
        group by os.name order by os.name`)
      const covered = rows.filter((row) => row.people)
      const empty = rows.filter((row) => !row.people)
      return {
        respuesta: `Tienes ${rows.length} especialidades activas. Con profesional asignado: ${listOf(covered.map((row) => ({ name: row.name, value: row.people ?? "" })))}. Sin nadie asignado: ${empty.map((row) => row.name).join(", ") || "ninguna"}.${without.length ? ` ${without.map((row) => row.name).join(" y ")} no ${without.length === 1 ? "tiene" : "tienen"} ninguna especialidad asignada.` : ""}`,
        criterio: "Especialidades activas de la clínica (`org_specialty`) y quién del equipo tiene asignada cada una (`professional_specialty`), como Ajustes › Especialidades.",
        nota: `Por lo que hicieron este mes (${w.monthSoFar}; tratamientos de atenciones firmadas por la especialidad del servicio): ${done.map((row) => `${row.specialty}: ${row.people}`).join("; ") || "nadie hizo tratamientos"}.`,
        datos: { especialidades: rows, sinEspecialidad: without, hechoEsteMes: done },
      }
    },

    g080: async () => {
      const result = await h.fig("no_vinieron", "profesional")
      const year = await h.fig("no_vinieron", "profesional", w.lastYear)
      const byCount = (rows: FigureRow[]) =>
        [...rows]
          .filter((row) => (row.value.whole ?? 0) > 0)
          .sort((a, b) => (b.value.part ?? 0) - (a.value.part ?? 0) || (b.value.value ?? 0) - (a.value.value ?? 0) || a.label.localeCompare(b.label))
      const byRate = (rows: FigureRow[]) =>
        [...rows].filter((row) => (row.value.whole ?? 0) > 0).sort((a, b) => (b.value.value ?? -1) - (a.value.value ?? -1) || a.label.localeCompare(b.label))
      const words = (rows: FigureRow[], figure: FigureResult) =>
        listOf(rows.map((row) => ({ name: row.label, value: `${row.value.part ?? 0} de ${row.value.whole ?? 0}, ${show(figure, row.value.value)}` })))
      const rows = byCount(result.rows)
      const top = rows[0]
      return {
        respuesta: top && (top.value.part ?? 0) > 0
          ? `${days.current[0]?.toUpperCase()}${days.current.slice(1)} (hasta hoy), a quien más pacientes dejan plantado es ${top.label}: ${plural(top.value.part ?? 0, "cita", "citas")} en que el paciente no vino, el ${show(result, top.value.value)} de sus ${top.value.whole ?? 0} citas que ya pasaron. Le siguen ${words(rows.slice(1), result)}.`
          : `${days.current[0]?.toUpperCase()}${days.current.slice(1)} (hasta hoy) ningún paciente dejó de venir a su cita.`,
        criterio: "«No vinieron» de Reportes por profesional, del mes en curso: citas en que el paciente no vino, de más a menos, con su parte de las citas que ya pasaron.",
        nota: `Por porcentaje: ${words(byRate(result.rows), result)}. En los últimos 12 meses, por cuántas: ${words(byCount(year.rows), year)}.`,
        datos: { mes: result.rows, total: result.total, doceMeses: year.rows },
      }
    },

    g081: async () => {
      const result = await h.fig("cobrado", "profesional")
      const occupied = await h.fig("agenda_ocupada", "profesional")
      const hours = await h.tx.execute<{ id: string; name: string; minutes: number }>(sql`
        select u.id, u.name, sum(a.duration_min)::int as minutes from appointment a join "user" u on u.id = a.professional_user_id
        where a.organization_id = ${h.org} and a.status = 'atendida' and a.starts_at >= ${h.monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz
        group by 1, 2`)
      const ids = [...new Set([...result.rows.map((row) => row.key), ...hours.map((row) => row.id)])]
      const rows = ids
        .map((id) => {
          const row = rowOf(result, id)
          const own = hours.find((item) => item.id === id)
          const agenda = rowOf(occupied, id)
          const cents = row?.value.value ?? 0
          const minutes = own?.minutes ?? 0
          const scheduled = agenda?.value.whole ?? 0
          return {
            name: row?.label ?? own?.name ?? "",
            cents,
            minutes,
            perHour: minutes > 0 ? cents / (minutes / 60) : null,
            scheduled,
            perScheduledHour: scheduled > 0 ? cents / (scheduled / 60) : null,
          }
        })
        .sort((a, b) => (b.perHour ?? -1) - (a.perHour ?? -1) || a.name.localeCompare(b.name))
      return {
        respuesta: rows.length
          ? `${days.current[0]?.toUpperCase()}${days.current.slice(1)} (hasta hoy), por hora de cita atendida: ${listOf(rows.map((row) => ({ name: row.name, value: row.perHour === null ? "sin citas atendidas" : `${money(row.perHour)} por hora: ${money(row.cents)} en ${hoursOf(row.minutes)}` })))}.`
          : `${days.current[0]?.toUpperCase()}${days.current.slice(1)} todavía no hay citas atendidas ni cobros de lo atendido.`,
        criterio: "Lo cobrado de lo que atendió cada uno (Reportes por profesional, la base de las comisiones) ÷ las horas reservadas de sus citas atendidas del mes en curso.",
        nota: `Por hora de su horario (lo cobrado ÷ las horas de agenda de Reportes, con o sin citas): ${listOf(rows.map((row) => ({ name: row.name, value: row.perScheduledHour === null ? "sin horario" : `${money(row.perScheduledHour)} por hora en ${hoursOf(row.scheduled)} de horario` })))}.`,
        datos: { filas: rows },
      }
    },

    g082: async () => {
      const person = await userNamed("%luis prado%")
      if (!person) return { respuesta: "No hay nadie llamado Luis Prado en el equipo.", criterio: "Miembros de la clínica por nombre.", datos: {} }
      const schedules = await currentSchedules(person.id)
      const saturday = schedules.filter((row) => row.weekday === 6)
      const [before] = await h.tx.execute<{ ranges: string | null; until: string | null }>(sql`
        select string_agg(s.start_min || '-' || s.end_min, ',' order by s.start_min) as ranges, s.valid_until::text as until
        from professional_schedule s
        where s.organization_id = ${h.org} and s.professional_user_id = ${person.id} and s.weekday = 6 and s.valid_until is not null
          and s.valid_until = (select max(x.valid_until) from professional_schedule x
            where x.organization_id = s.organization_id and x.professional_user_id = s.professional_user_id and x.weekday = 6 and x.valid_until is not null)
        group by s.valid_until`)
      const [visits] = await h.tx.execute<{ saturdays: number; total: number }>(sql`
        select count(*) filter (where extract(dow from a.starts_at at time zone ${h.tz}) = 6)::int as saturdays, count(*)::int as total
        from appointment a where a.organization_id = ${h.org} and a.professional_user_id = ${person.id} and a.status = 'atendida'
          and a.starts_at >= ${startOf(w.yearAgoKey).toISOString()}::timestamptz and a.starts_at < ${nowIso}::timestamptz`)
      const ranges = (rows: Array<{ start: number; end: number }>) => rows.map((row) => `de ${clock(row.start)} a ${clock(row.end)}`).join(" y ")
      const branches = [...new Set(saturday.map((row) => row.branch))]
      const workdays = [...new Set(schedules.map((row) => row.weekday))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
      const previous = before?.ranges
        ? before.ranges.split(",").map((pair) => {
            const [start, end] = pair.split("-").map(Number) as [number, number]
            return { start, end }
          })
        : []
      const changed = previous.length > 0 && ranges(previous) !== ranges(saturday)
      return {
        respuesta: saturday.length
          ? `Sí: ${person.name} atiende los sábados en ${branches.map((branch) => `${branch}, ${ranges(saturday.filter((row) => row.branch === branch))}`).join("; ")}.`
          : `No: el horario de ${person.name} no incluye los sábados${workdays.length ? `; atiende los ${workdays.map(weekdaysWord).join(", ").replace(/, ([^,]+)$/, " y $1")}` : ""}.`,
        criterio: "Su horario vigente (`professional_schedule` activo y sin fin) de los sábados, por sede.",
        nota: `${changed ? `Ese horario vale desde el ${w.dayWords(saturday[0]?.from ?? today)}; hasta entonces los sábados atendía ${ranges(previous)}. ` : ""}En los últimos 12 meses atendió ${plural(visits?.saturdays ?? 0, "cita", "citas")} en sábado, de ${visits?.total ?? 0} citas atendidas.`,
        datos: { sabado: saturday, anterior: before ?? null, citas: visits ?? null },
      }
    },

    g083: async () => {
      const branch = await branchNamed("%miraflores%")
      if (!branch) return { respuesta: "No tienes una sede Miraflores.", criterio: "Sedes de la clínica por nombre.", datos: {} }
      const month = Number(today.slice(5, 7))
      const period = `${month >= 10 ? year : year - 1}-10`
      const scope = await scopeAt(period, branch.id)
      const collected = await figWith(scope, "cobrado", "profesional")
      const attended = await figWith(scope, "atendidas", "profesional")
      const charged = await h.tx.execute<{ id: string; cents: string }>(sql`
        select e.professional_user_id as id, sum(c.amount_cents)::text as cents
        from patient_charge c
        join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id and ep.voided_at is null
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
        where c.organization_id = ${h.org} and c.voided_at is null and c.currency = ${h.scope.currency} and e.branch_id = ${branch.id}
          and c.created_at >= ${scope.window.start.toISOString()}::timestamptz and c.created_at < ${scope.window.end.toISOString()}::timestamptz
        group by 1`)
      const ids = [...new Set([...collected.rows.map((row) => row.key), ...attended.rows.map((row) => row.key)])]
      const rows = ids
        .map((id) => ({
          id,
          name: rowOf(collected, id)?.label ?? rowOf(attended, id)?.label ?? "",
          cents: rowOf(collected, id)?.value.value ?? 0,
          attended: rowOf(attended, id)?.value.value ?? 0,
          charged: Number(charged.find((row) => row.id === id)?.cents ?? 0),
        }))
        .sort((a, b) => b.cents - a.cents || b.attended - a.attended || a.name.localeCompare(b.name))
      const when = scope.window.partial ? `${w.monthSoFar[0]?.toUpperCase()}${w.monthSoFar.slice(1)} (hasta hoy)` : `En ${monthLabel(h, scope.window.from)}`
      return {
        respuesta: rows.length
          ? `${when}, en ${branch.name}: ${rows.map((row) => `${row.name}, ${money(row.cents)} cobrados de lo que atendió y ${plural(row.attended, "cita atendida", "citas atendidas")}`).join("; ")}.`
          : `${when}, en ${branch.name} todavía no hay citas atendidas ni cobros de lo atendido.`,
        criterio: "Lo cobrado por profesional (de lo que atendió cada uno, la base de las comisiones) y las citas atendidas por profesional de Reportes, de octubre con la sede Miraflores elegida.",
        nota: `Si «produjo» es lo cargado de lo que atendió en esa sede (pagado o no): ${listOf(rows.map((row) => ({ name: row.name, value: money(row.charged) })))}. En toda la sede: ${show(await figWith(scope, "cobrado"))} cobrados y ${show(await figWith(scope, "atendidas"))} citas atendidas.`,
        datos: { sede: branch, periodo: period, filas: rows },
      }
    },

    g084: async () => {
      const tasks = await h.tx.execute<{ title: string; due: string | null; overdue: boolean; kind: string | null; assignee: string | null; mine: boolean }>(sql`
        select t.title, to_char(t.due_at at time zone ${h.tz}, 'YYYY-MM-DD HH24:MI') as due,
          (t.due_at is not null and t.due_at <= ${nowIso}::timestamptz) as overdue, t.kind, u.name as assignee,
          (t.assignee_user_id is null and t.area = 'recepcion'
            or exists (select 1 from member m where m.organization_id = t.organization_id and m.user_id = t.assignee_user_id and m.role = 'reception')) as mine
        from task t left join "user" u on u.id = t.assignee_user_id
        where t.organization_id = ${h.org} and t.status = 'open'
          and (t.area = 'recepcion' or exists (select 1 from member m where m.organization_id = t.organization_id and m.user_id = t.assignee_user_id and m.role = 'reception'))
        order by t.due_at nulls last, t.created_at, t.title`)
      const mine = tasks.filter((task) => task.mine)
      const others = tasks.filter((task) => !task.mine)
      const dueWords = (task: (typeof tasks)[number]): string => {
        if (!task.due) return task.kind ? "la dejó el registro en línea, sin fecha" : "sin fecha"
        const [day, time] = task.due.split(" ") as [string, string]
        if (task.overdue) return `vencida desde el ${w.dayWords(day)} a las ${time}`
        return day === today ? `vence hoy a las ${time}` : `vence el ${w.dayWords(day)} a las ${time}`
      }
      const overdue = mine.filter((task) => task.overdue).length
      return {
        respuesta: mine.length
          ? `Recepción tiene ${plural(mine.length, "tarea pendiente", "tareas pendientes")}${overdue ? `, ${overdue} ${overdue === 1 ? "vencida" : "vencidas"}` : ""}: ${listOf(mine.map((task) => ({ name: `«${task.title}»`, value: dueWords(task) })))}.`
          : "Recepción no tiene tareas pendientes.",
        criterio: "Tareas abiertas de recepción, como «Mías y de mi área» en Tareas: las sin responsable del área recepción y las de quien tiene el rol de recepción, por vencimiento.",
        nota: others.length
          ? `Del área recepción pero ya con responsable: ${listOf(others.map((task) => ({ name: `«${task.title}»`, value: `${task.assignee}, ${dueWords(task)}` })))}.`
          : undefined,
        datos: { recepcion: mine, conResponsable: others },
      }
    },

    g085: async () => {
      const tasks = await h.tx.execute<{ title: string; due: string; assignee: string | null; area: string | null }>(sql`
        select t.title, to_char(t.due_at at time zone ${h.tz}, 'YYYY-MM-DD HH24:MI') as due, u.name as assignee, t.area
        from task t left join "user" u on u.id = t.assignee_user_id
        where t.organization_id = ${h.org} and t.status = 'open' and t.due_at is not null and t.due_at <= ${nowIso}::timestamptz
        order by t.due_at, t.title`)
      const [open] = await h.tx.execute<{ open: number; later: number }>(sql`
        select count(*)::int as open,
          count(*) filter (where t.due_at > ${nowIso}::timestamptz and (t.due_at at time zone ${h.tz})::date = ${today}::date)::int as later
        from task t where t.organization_id = ${h.org} and t.status = 'open'`)
      type Overdue = { title: string; due: string; assignee: string | null; area: string | null }
      const whom = (task: Overdue) => task.assignee ?? `${AREA_WORDS[task.area ?? ""] ?? "nadie"} (sin responsable)`
      const groups = new Map<string, Overdue[]>()
      for (const task of [...tasks] as Overdue[]) groups.set(whom(task), [...(groups.get(whom(task)) ?? []), task])
      const since = (due: string) => {
        const [day, time] = due.split(" ") as [string, string]
        return `desde el ${w.dayWords(day)} a las ${time}`
      }
      return {
        respuesta: tasks.length
          ? `Hay ${plural(tasks.length, "tarea vencida", "tareas vencidas")}: ${[...groups].map(([name, list]) => `${name}, ${list.map((task) => `«${task.title}» (${since(task.due)})`).join(" y ")}`).join("; ")}.`
          : "No hay tareas vencidas.",
        criterio: "Tareas abiertas con vencimiento ya pasado, a ahora, de toda la clínica; a quien tiene de responsable o, sin responsable, al área a la que van.",
        nota: `Tareas abiertas en total: ${open?.open ?? 0}; ${plural(open?.later ?? 0, "vence", "vencen")} más tarde hoy.`,
        datos: { vencidas: tasks, abiertas: open?.open ?? 0, vencenHoy: open?.later ?? 0 },
      }
    },

    // --- Agenda ---------------------------------------------------------------------------
    g086: async () => {
      const tomorrow = addDays(today, 1)
      const rows = await h.tx.execute<{ branch: string; status: string; total: number }>(sql`
        select b.name as branch, a.status, count(*)::int as total from appointment a
        join branch b on b.organization_id = a.organization_id and b.id = a.branch_id
        where a.organization_id = ${h.org} and ${h.dayOf(sql`a.starts_at`)} = ${h.today} + 1
        group by 1, 2 order by 1, 2`)
      const active = rows.filter((row) => row.status === "programada" || row.status === "confirmada")
      const total = active.reduce((sum, row) => sum + row.total, 0)
      const confirmed = active.filter((row) => row.status === "confirmada").reduce((sum, row) => sum + row.total, 0)
      const cancelled = rows.filter((row) => row.status === "cancelada").reduce((sum, row) => sum + row.total, 0)
      const byBranch = new Map<string, number>()
      for (const row of active) byBranch.set(row.branch, (byBranch.get(row.branch) ?? 0) + row.total)
      const [next] = await h.tx.execute<{ day: string | null; total: number; coming: number }>(sql`
        select to_char(min(${h.dayOf(sql`a.starts_at`)}), 'YYYY-MM-DD') as day,
          count(*) filter (where ${h.dayOf(sql`a.starts_at`)} = (select min(${h.dayOf(sql`x.starts_at`)}) from appointment x
            where x.organization_id = ${h.org} and x.status in ('programada','confirmada') and ${h.dayOf(sql`x.starts_at`)} > ${h.today} + 1))::int as total,
          (select count(*) from appointment y where y.organization_id = ${h.org} and y.status in ('programada','confirmada') and y.starts_at > ${nowIso}::timestamptz)::int as coming
        from appointment a
        where a.organization_id = ${h.org} and a.status in ('programada','confirmada') and ${h.dayOf(sql`a.starts_at`)} > ${h.today} + 1`)
      return {
        respuesta: total
          ? `Mañana (${w.dayWords(tomorrow)}) hay ${plural(total, "cita", "citas")}: ${confirmed} ${confirmed === 1 ? "confirmada" : "confirmadas"} y ${total - confirmed} por confirmar${byBranch.size > 1 ? ` (${listOf([...byBranch].map(([name, count]) => ({ name, value: `${count}` })))})` : byBranch.size === 1 ? `, todas en ${[...byBranch.keys()][0]}` : ""}.`
          : `Mañana (${w.dayWords(tomorrow)}) no hay citas agendadas${cancelled ? ` (${plural(cancelled, "se canceló", "se cancelaron")})` : ""}.`,
        criterio: "Citas de mañana (día de la clínica) programadas o confirmadas, todas las sedes.",
        nota: next?.day
          ? `La siguiente fecha con citas es el ${w.dayWords(next.day)}: ${plural(next.total, "cita", "citas")}. En total hay ${plural(next.coming, "cita por venir", "citas por venir")} agendadas.`
          : next?.coming
            ? `Después de mañana no hay más citas agendadas; desde ahora quedan ${plural(next.coming, "cita por venir", "citas por venir")} en total.`
            : "Tampoco hay citas agendadas para después: no queda ninguna cita por venir desde ahora.",
        datos: { manana: tomorrow, porSedeYEstado: rows, siguiente: next ?? null },
      }
    },

    g087: async () => {
      const surco = await branchNamed("%surco%")
      const range = `${monday}..${today}`
      const result = await h.fig("agenda_ocupada", "sede", range)
      const weekEnd = startOf(addDays(monday, 7))
      const [booked] = surco
        ? await h.tx.execute<{ total: number }>(sql`
            select count(*)::int as total from appointment a
            where a.organization_id = ${h.org} and a.branch_id = ${surco.id} and a.status <> 'cancelada'
              and a.starts_at >= ${startOf(monday).toISOString()}::timestamptz and a.starts_at < ${weekEnd.toISOString()}::timestamptz`)
        : []
      const wholeWeek: Array<{ name: string; availMin: number; occMin: number }> = []
      for (const branch of await branchNames()) {
        const minutes = await agendaMinutes(h.tx, h.org, { start: startOf(monday), end: weekEnd }, { branchId: branch.id })
        wholeWeek.push({
          name: branch.name,
          availMin: minutes.days.reduce((sum, day) => sum + day.availMin, 0),
          occMin: minutes.days.reduce((sum, day) => sum + day.occMin, 0),
        })
      }
      const row = surco ? rowOf(result, surco.id) : undefined
      const words = (rows: FigureRow[]) =>
        listOf(rows.map((item) => ({ name: item.label, value: `${show(result, item.value.value)}: ${hoursOf(item.value.part ?? 0)} con citas de ${hoursOf(item.value.whole ?? 0)} de horario` })))
      const others = result.rows.filter((item) => item.key !== surco?.id && item.value.value !== null)
      const week = `${spanWords(monday, today)}, hasta ahora`
      return {
        respuesta: !surco
          ? `No tienes una sede Surco. Esta semana (${week}) la agenda de tus sedes está así: ${words(others)}.`
          : row?.value.value === null || row === undefined
            ? `${surco.name} no tiene agenda que medir: ningún profesional tiene horario ahí${booked?.total ? `, aunque tiene ${plural(booked.total, "cita", "citas")} esta semana` : " y no tiene citas esta semana"}. En las otras sedes, esta semana (${week}): ${words(others)}.`
            : `Esta semana (${week}) la agenda de ${surco.name} está ocupada al ${show(result, row.value.value)}: ${hoursOf(row.value.part ?? 0)} con citas de ${hoursOf(row.value.whole ?? 0)} de horario.`,
        criterio: "«Agenda ocupada» de Reportes por sede, de esta semana (del lunes a hoy): minutos de citas no canceladas ÷ minutos del horario de cada profesional menos ausencias y bloqueos.",
        nota: `Con la semana entera, ${spanWords(monday, addDays(monday, 6))} (lo que ya está agendado para los días que faltan): ${listOf(wholeWeek.filter((item) => item.availMin > 0 || item.name === surco?.name).map((item) => ({ name: item.name, value: item.availMin > 0 ? `${pct(item.occMin, item.availMin)}, ${hoursOf(item.occMin)} de ${hoursOf(item.availMin)}` : "sin horario" })))}.`,
        datos: { sedes: result.rows, semanaEntera: wholeWeek, citasSurco: booked?.total ?? 0 },
      }
    },

    g088: async () => {
      const rows = await h.tx.execute<{ time: string; status: string; past: boolean; professional: string; branch: string; patient: string }>(sql`
        select to_char(a.starts_at at time zone ${h.tz}, 'HH24:MI') as time, a.status, (a.ends_at < ${nowIso}::timestamptz) as past,
          u.name as professional, b.name as branch, pp.display_name as patient
        from appointment a
        join "user" u on u.id = a.professional_user_id
        join branch b on b.organization_id = a.organization_id and b.id = a.branch_id
        ${h.joinPerson(sql`a.patient_id`)}
        where a.organization_id = ${h.org} and ${h.dayOf(sql`a.starts_at`)} = ${h.today}
        order by a.starts_at, u.name`)
      const active = rows.filter((row) => row.status !== "cancelada")
      const pending = active.filter((row) => row.status === "programada")
      const passed = pending.filter((row) => row.past)
      const count = (status: string) => rows.filter((row) => row.status === status).length
      return {
        respuesta: !active.length
          ? `Hoy (${w.dayWords(today)}) no hay citas.`
          : pending.length
            ? `De las ${plural(active.length, "cita", "citas")} de hoy (${w.dayWords(today)}), ${pending.length === active.length ? (pending.length === 1 ? "la única sigue" : `las ${pending.length} siguen`) : `${pending.length} ${pending.length === 1 ? "sigue" : "siguen"}`} sin confirmar: ${listOf(pending.map((row) => ({ name: `${row.time} con ${row.professional} en ${row.branch}`, value: row.patient })))}.${passed.length ? ` A ${passed.length === pending.length ? (passed.length === 1 ? "esa" : "todas") : passed.length} ya ${passed.length === 1 ? "le pasó" : "les pasó"} la hora y nadie marcó si el paciente vino.` : ""}`
            : `Ninguna: las ${plural(active.length, "cita", "citas")} de hoy (${w.dayWords(today)}) ya están confirmadas o marcadas.`,
        criterio: "Citas de hoy (día de la clínica) no canceladas que siguen «programada», es decir, sin confirmar; con las que ya pasaron de su hora sin marcarse.",
        nota: `El resto de hoy: ${count("confirmada")} confirmadas, ${count("atendida")} atendidas, ${count("no_asistio")} en que no vino el paciente y ${count("cancelada")} canceladas. Contando solo las que aún no llegan a su hora: ${pending.length - passed.length} sin confirmar.`,
        datos: { citas: rows },
      }
    },

    g089: async () => {
      const result = await h.fig("no_vinieron", "total", "mes_pasado")
      const scope = await scopeAt("mes_pasado")
      const people = async (start: Date, end: Date) => {
        const [row] = await h.tx.execute<{ people: number }>(sql`
          select count(distinct a.patient_id)::int as people from appointment a
          where a.organization_id = ${h.org} and a.status = 'no_asistio' and a.starts_at >= ${start.toISOString()}::timestamptz and a.starts_at < ${end.toISOString()}::timestamptz`)
        return row?.people ?? 0
      }
      const current = await people(scope.window.start, scope.window.end)
      const before = await people(scope.window.previous.start, scope.window.previous.end)
      return {
        respuesta: `En ${monthLabel(h, scope.window.from)} no vinieron a su cita ${plural(current, "persona", "personas")}: ${plural(result.total.part ?? 0, "cita", "citas")} sin venir, el ${show(result)} de las ${result.total.whole ?? 0} citas que ya pasaron.`,
        criterio: "«No vinieron» de Reportes del mes pasado completo (citas en que el paciente no vino ÷ citas que ya pasaron), con las personas distintas de esas citas.",
        nota: `En ${monthLabel(h, scope.window.previous.from)}: ${plural(before, "persona", "personas")}, ${result.previous?.part ?? 0} citas sin venir, el ${show(result, result.previous?.value ?? null)} de ${result.previous?.whole ?? 0}.`,
        datos: { total: result.total, anterior: result.previous, personas: current, personasAnterior: before },
      }
    },

    g090: async () => {
      const branch = await branchNamed("%miraflores%")
      if (!branch) return { respuesta: "No tienes una sede Miraflores.", criterio: "Sedes de la clínica por nombre.", datos: {} }
      const result = await figWith(await scopeAt("este_mes", branch.id), "canceladas")
      const clinic = await h.fig("canceladas")
      const year = await figWith(await scopeAt(w.lastYear, branch.id), "canceladas")
      return {
        respuesta: `${days.current[0]?.toUpperCase()}${days.current.slice(1)} (hasta hoy), en ${branch.name} termina cancelada el ${show(result)} de las citas: ${result.total.part ?? 0} de ${result.total.whole ?? 0} citas que ya pasaron. En toda la clínica, el ${show(clinic)}.`,
        criterio: "«Canceladas» de Reportes con la sede Miraflores elegida, del mes en curso: citas canceladas ÷ citas que ya pasaron (atendidas, no vinieron, canceladas y sin marcar).",
        nota: `En los últimos 12 meses en ${branch.name}: ${show(year)} (${year.total.part ?? 0} de ${year.total.whole ?? 0}). ${days.sameAs[0]?.toUpperCase()}${days.sameAs.slice(1)}: ${show(result, result.previous?.value ?? null)} (${result.previous?.part ?? 0} de ${result.previous?.whole ?? 0}).`,
        datos: { mes: result.total, anterior: result.previous, clinica: clinic.total, doceMeses: year.total },
      }
    },

    g091: async () => {
      const byDay = (start: string) =>
        h.tx.execute<{ day: number; noShow: number; total: number }>(sql`
          select extract(dow from a.starts_at at time zone ${h.tz})::int as day,
            count(*) filter (where a.status = 'no_asistio')::int as "noShow", count(*)::int as total
          from appointment a
          where a.organization_id = ${h.org} and a.starts_at >= ${start}::timestamptz and a.starts_at < ${nowIso}::timestamptz
            and (a.status in ('atendida','no_asistio','cancelada') or (a.status in ('programada','confirmada') and a.ends_at < ${nowIso}::timestamptz))
          group by 1`)
      type Row = { day: number; noShow: number; total: number }
      const byCount = (rows: Row[]) => [...rows].filter((row) => row.total > 0).sort((a, b) => b.noShow - a.noShow || b.noShow / b.total - a.noShow / a.total || a.day - b.day)
      const byRate = (rows: Row[]) => [...rows].filter((row) => row.total > 0).sort((a, b) => b.noShow / b.total - a.noShow / a.total || b.noShow - a.noShow)
      const words = (rows: Row[]) => listOf(rows.map((row) => ({ name: `los ${weekdaysWord(row.day)}`, value: `${row.noShow} de ${row.total}, ${pct(row.noShow, row.total)}` })))
      const month = byCount([...(await byDay(h.monthStart))])
      const year = [...(await byDay(startOf(w.yearAgoKey).toISOString()))]
      const top = month[0]
      return {
        respuesta: top && top.noShow > 0
          ? `${days.current[0]?.toUpperCase()}${days.current.slice(1)} (hasta hoy), falta más gente los ${weekdaysWord(top.day)}: ${plural(top.noShow, "cita", "citas")} en que el paciente no vino, el ${pct(top.noShow, top.total)} de sus ${top.total} citas que ya pasaron. Le siguen ${words(month.slice(1, 4))}.`
          : `${days.current[0]?.toUpperCase()}${days.current.slice(1)} (hasta hoy) nadie faltó a su cita.`,
        criterio: "Citas del mes en curso en que el paciente no vino, por día de la semana (día de la clínica), de más a menos, con su parte de las citas de ese día que ya pasaron (la regla de «No vinieron» de Reportes).",
        nota: `Por porcentaje, este mes: ${words(byRate(month).slice(0, 3))}. En los últimos 12 meses, por cuántas: ${words(byCount(year).slice(0, 3))}; por porcentaje: ${words(byRate(year).slice(0, 3))}.`,
        datos: { mes: month, doceMeses: year },
      }
    },

    g092: async () => {
      const branch = await branchNamed("%san isidro%")
      if (!branch) return { respuesta: "No tienes una sede San Isidro.", criterio: "Sedes de la clínica por nombre.", datos: {} }
      const report = await getAgendaReport(h.tx, h.org, { period: "este_mes", branchId: branch.id }, h.now)
      const slots = new Map<string, number>()
      const byHour = new Map<number, number>()
      const byWeekday = new Map<number, number>()
      for (const slot of report.map.week) {
        const free = Math.max(0, slot.availMin - slot.occMin)
        slots.set(`${slot.weekday}|${slot.hour}`, (slots.get(`${slot.weekday}|${slot.hour}`) ?? 0) + free)
        byHour.set(slot.hour, (byHour.get(slot.hour) ?? 0) + free)
        byWeekday.set(slot.weekday, (byWeekday.get(slot.weekday) ?? 0) + free)
      }
      const top = [...slots.entries()].filter(([, minutes]) => minutes > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4)
      const hours = [...byHour.entries()].filter(([, minutes]) => minutes > 0).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 3)
      const weekdays = [...byWeekday.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
      const free = await figWith(await scopeAt("este_mes", branch.id), "horas_libres")
      return {
        respuesta: top.length
          ? `Este mes (${w.monthSoFar}), en ${branch.name} los horarios con más huecos libres son ${listOf(
              top.map(([key, minutes]) => {
                const [weekday, hour] = key.split("|").map(Number) as [number, number]
                return { name: `${WEEKDAYS[weekday]} a las ${hour}:00`, value: `${hoursOf(minutes)} libres` }
              }),
            )}.`
          : `Este mes ${branch.name} no tiene huecos libres en su horario.`,
        criterio: "Semana tipo de Reportes › Agenda con la sede San Isidro elegida, del mes en curso: minutos de horario menos ausencias y citas no canceladas, por día de la semana y hora.",
        nota: `Por hora del día, sumando todos los días: ${listOf(hours.map(([hour, minutes]) => ({ name: `de ${hour}:00 a ${hour + 1}:00`, value: `${hoursOf(minutes)} libres` })))}. Por día de la semana: ${listOf(weekdays.map(([weekday, minutes]) => ({ name: WEEKDAYS[weekday] ?? "", value: hoursOf(minutes) })))}. En total, ${show(free)} libres en la sede este mes.`,
        datos: { franjas: top, porHora: hours, porDia: weekdays, horasLibres: free.total },
      }
    },

    g093: async () => {
      const person = await userNamed("%ana torres%")
      if (!person) return { respuesta: "No hay nadie llamado Ana Torres en el equipo.", criterio: "Miembros de la clínica por nombre.", datos: {} }
      const nextMonday = addDays(monday, 7)
      const nextSunday = addDays(monday, 13)
      const start = startOf(nextMonday)
      const end = startOf(addDays(monday, 14))
      const minutes = await agendaMinutes(h.tx, h.org, { start, end }, { professionalUserId: person.id })
      const scheduled = minutes.days.reduce((sum, day) => sum + day.scheduledMin, 0)
      const available = minutes.days.reduce((sum, day) => sum + day.availMin, 0)
      const booked = minutes.days.reduce((sum, day) => sum + day.occMin, 0)
      const free = minutes.days.reduce((sum, day) => sum + Math.max(0, day.availMin - day.occMin), 0)
      const branchIds = new Set(minutes.days.map((day) => day.branchId))
      const blocks = (await blocksIn(start, end)).filter((block) => block.professionalId === person.id || (block.professionalId === null && block.room === null && branchIds.has(block.branchId)))
      const perDay = minutes.days.map((day) => ({ day: day.day, free: Math.max(0, day.availMin - day.occMin), scheduled: day.scheduledMin }))
      const blockedWords = blocks.map((block) => `${block.professionalId ? "su ausencia" : `el cierre de ${block.branch}`} ${blockWhen(block)} (${blockWhy(block)})`).join(" y ")
      return {
        respuesta: scheduled
          ? `La próxima semana (${spanWords(nextMonday, nextSunday)}) ${person.name} tiene ${hoursOf(free)} libres en su agenda: su horario suma ${hoursOf(scheduled)}${scheduled > available ? `, ${blockedWords || "los bloqueos"} le ${blocks.length > 1 ? "quitan" : "quita"} ${hoursOf(scheduled - available)}` : ""} y ${booked > 0 ? `tiene ${hoursOf(booked)} con citas` : "todavía no tiene citas agendadas"}.`
          : `La próxima semana (${spanWords(nextMonday, nextSunday)}) ${person.name} no tiene horario.`,
        criterio: "La próxima semana, de lunes a domingo: horas de su horario vigente menos sus ausencias y los cierres de su sede, menos sus citas no canceladas (la cuenta de Reportes › Agenda).",
        nota: `Por día: ${listOf(perDay.map((day) => ({ name: w.dayWords(day.day), value: `${hoursOf(day.free)} libres de ${hoursOf(day.scheduled)}` })))}.`,
        datos: { semana: { desde: nextMonday, hasta: nextSunday }, horario: scheduled, disponible: available, conCitas: booked, libres: free, bloqueos: blocks, porDia: perDay },
      }
    },

    g094: async () => {
      const use = (since: string) =>
        h.tx.execute<{ name: string; branch: string; appointments: number; minutes: number; attended: number; attendedMin: number }>(sql`
          select c.name, b.name as branch,
            count(a.id) filter (where a.status <> 'cancelada')::int as appointments,
            coalesce(sum(a.duration_min) filter (where a.status <> 'cancelada'), 0)::int as minutes,
            count(a.id) filter (where a.status = 'atendida')::int as attended,
            coalesce(sum(a.duration_min) filter (where a.status = 'atendida'), 0)::int as "attendedMin"
          from schedule_room c
          join branch b on b.organization_id = c.organization_id and b.id = c.branch_id and b.is_active
          left join appointment a on a.organization_id = c.organization_id and a.room_id = c.id
            and a.starts_at >= ${since}::timestamptz and a.starts_at < ${nowIso}::timestamptz
          where c.organization_id = ${h.org} and c.is_active
          group by c.id, c.name, b.name order by 4, 3, 2, 1`)
      const month = [...(await use(h.monthStart))]
      const year = [...(await use(startOf(w.yearAgoKey).toISOString()))]
      const label = (row: (typeof month)[number]) => `${row.name} de ${row.branch}`
      const least = month[0]
      const byAttended = [...month].sort((a, b) => a.attendedMin - b.attendedMin || a.attended - b.attended || label(a).localeCompare(label(b)))
      return {
        respuesta: least
          ? `Este mes (${w.monthSoFar}), la unidad dental que menos se usa es la ${label(least)}: ${plural(least.appointments, "cita", "citas")}, ${hoursOf(least.minutes)} reservadas. Todas, de menos a más: ${listOf(month.map((row) => ({ name: label(row), value: `${hoursOf(row.minutes)}, ${row.appointments} citas` })))}.`
          : "La clínica no tiene unidades dentales registradas.",
        criterio: "Horas reservadas en cada unidad dental activa con citas no canceladas del mes en curso, hasta ahora (la regla de «Agenda ocupada»), de menos a más. Reportes no da un porcentaje por unidad: las unidades no tienen horario.",
        nota: `Contando solo citas atendidas: ${listOf(byAttended.map((row) => ({ name: label(row), value: `${hoursOf(row.attendedMin)}, ${row.attended} citas` })))}. En los últimos 12 meses la que menos se usó es la ${year[0] ? `${label(year[0])} (${hoursOf(year[0].minutes)}, ${year[0].appointments} citas)` : "—"}.`,
        datos: { mes: month, doceMeses: year },
      }
    },

    g095: async () => {
      const range = `${monday}..${today}`
      const result = await h.fig("canceladas", "total", range)
      const bySede = await h.fig("canceladas", "sede", range)
      const lastWeek = await h.fig("canceladas", "total", `${addDays(monday, -7)}..${addDays(today, -7)}`)
      const sunday = addDays(monday, 6)
      const [week] = await h.tx.execute<{ cancelled: number }>(sql`
        select count(*)::int as cancelled from appointment a
        where a.organization_id = ${h.org} and a.status = 'cancelada'
          and a.starts_at >= ${startOf(monday).toISOString()}::timestamptz and a.starts_at < ${startOf(addDays(monday, 7)).toISOString()}::timestamptz`)
      const part = result.total.part ?? 0
      const sedes = bySede.rows.filter((row) => (row.value.part ?? 0) > 0)
      return {
        respuesta: `Esta semana (${spanWords(monday, today)}, hasta ahora) se ${part === 1 ? "canceló" : "cancelaron"} ${plural(part, "cita", "citas")}: el ${show(result)} de las ${result.total.whole ?? 0} citas que ya pasaron.${sedes.length ? ` Por sede: ${listOf(sedes.map((row) => ({ name: row.label, value: `${row.value.part ?? 0}` })))}.` : ""}`,
        criterio: "«Canceladas» de Reportes de esta semana (del lunes a hoy): citas canceladas cuya hora cae en esos días ÷ citas que ya pasaron. odentIA no guarda cuándo se canceló cada cita: se cuenta por el día de la cita.",
        nota: `Con las citas de los días que faltan hasta el ${w.dayWords(sunday)}: ${plural(week?.cancelled ?? 0, "cancelada", "canceladas")}. La semana pasada, en los mismos días (${spanWords(addDays(monday, -7), addDays(today, -7))}): ${lastWeek.total.part ?? 0} canceladas, el ${show(lastWeek)}.`,
        datos: { semana: result.total, porSede: bySede.rows, semanaEntera: week?.cancelled ?? 0, semanaPasada: lastWeek.total },
      }
    },

    g096: async () => {
      const rows = await h.tx.execute<{ source: string; status: string; total: number }>(sql`
        select a.source, a.status, count(*)::int as total from appointment a
        where a.organization_id = ${h.org} and ${h.dayOf(sql`a.created_at`)} = ${h.today}
        group by 1, 2 order by 3 desc, 1, 2`)
      const total = rows.reduce((sum, row) => sum + row.total, 0)
      const bySource = new Map<string, number>()
      for (const row of rows) bySource.set(row.source, (bySource.get(row.source) ?? 0) + row.total)
      const [other] = await h.tx.execute<{ forToday: number; lastDay: string | null; lastTotal: number }>(sql`
        select (select count(*) from appointment x where x.organization_id = ${h.org} and x.status <> 'cancelada' and ${h.dayOf(sql`x.starts_at`)} = ${h.today})::int as "forToday",
          to_char(max(${h.dayOf(sql`a.created_at`)}), 'YYYY-MM-DD') as "lastDay",
          count(*) filter (where ${h.dayOf(sql`a.created_at`)} = (select max(${h.dayOf(sql`y.created_at`)}) from appointment y
            where y.organization_id = ${h.org} and ${h.dayOf(sql`y.created_at`)} < ${h.today}))::int as "lastTotal"
        from appointment a where a.organization_id = ${h.org} and ${h.dayOf(sql`a.created_at`)} < ${h.today}`)
      return {
        respuesta: total
          ? `Hoy (${w.dayWords(today)}, hasta ahora) se ${total === 1 ? "agendó" : "agendaron"} ${plural(total, "cita", "citas")}: ${listOf([...bySource].map(([source, count]) => ({ name: SOURCE_WORDS[source] ?? source, value: `${count}` })))}.`
          : `Hoy (${w.dayWords(today)}, hasta ahora) todavía no se agendó ninguna cita.`,
        criterio: "Citas creadas hoy (día de la clínica), para cualquier fecha y en cualquier estado, por cómo llegaron.",
        nota: `Si se pregunta por las citas que son para hoy: ${plural(other?.forToday ?? 0, "cita no cancelada", "citas no canceladas")}.${other?.lastDay ? ` El último día antes de hoy en que se agendaron citas fue el ${w.dayWords(other.lastDay)}: ${other.lastTotal}.` : ""}`,
        datos: { hoy: rows, paraHoy: other?.forToday ?? 0, ultimoDia: other?.lastDay ?? null, ultimoDiaTotal: other?.lastTotal ?? 0 },
      }
    },

    g097: async () => {
      const byHour = (since: string, withCancelled: boolean) =>
        h.tx.execute<{ hour: number; total: number }>(sql`
          select extract(hour from a.starts_at at time zone ${h.tz})::int as hour, count(*)::int as total from appointment a
          where a.organization_id = ${h.org} ${withCancelled ? sql`` : sql`and a.status <> 'cancelada'`}
            and a.starts_at >= ${since}::timestamptz and a.starts_at < ${nowIso}::timestamptz
          group by 1 order by 2 desc, 1`)
      const month = [...(await byHour(h.monthStart, false))]
      const year = [...(await byHour(startOf(w.yearAgoKey).toISOString(), false))]
      const withCancelled = [...(await byHour(h.monthStart, true))]
      const sum = (rows: typeof month) => rows.reduce((total, row) => total + row.total, 0)
      const words = (rows: typeof month, all: typeof month = rows) =>
        listOf(rows.slice(0, 3).map((row) => ({ name: `las ${row.hour}:00`, value: `${row.total} citas, ${pct(row.total, sum(all))}` })))
      const top = month[0]
      return {
        respuesta: top
          ? `Este mes (${w.monthSoFar}) la hora más pedida es las ${top.hour}:00: ${plural(top.total, "cita", "citas")}, el ${pct(top.total, sum(month))} de las ${sum(month)}. Le siguen ${words(month.slice(1), month)}.`
          : "Este mes todavía no hay citas.",
        criterio: "Citas no canceladas del mes en curso, hasta ahora, por la hora en que empiezan (hora de la clínica), de más a menos.",
        nota: `En los últimos 12 meses: ${words(year)}. Contando también las canceladas, este mes: ${words(withCancelled)}.`,
        datos: { mes: month, doceMeses: year, conCanceladas: withCancelled },
      }
    },

    g098: async () => {
      const weekday = weekdayOf(today)
      const saturday = addDays(today, -(weekday === 6 ? 7 : weekday + 1))
      const period = `${saturday}..${saturday}`
      const result = await h.fig("atendidas", "total", period)
      const bySede = await h.fig("atendidas", "sede", period)
      const byPerson = await h.fig("atendidas", "profesional", period)
      const noShow = await h.fig("no_vinieron", "total", period)
      const cancelled = await h.fig("canceladas", "total", period)
      const count = result.total.value ?? 0
      const sedes = bySede.rows.filter((row) => (row.value.value ?? 0) > 0)
      const missedWords = (n: number) => (n === 0 ? "ningún paciente faltó a su cita" : n === 1 ? "1 paciente no vino a su cita" : `${n} pacientes no vinieron a su cita`)
      const cancelledWords = (n: number) => (n === 0 ? "no se canceló ninguna" : n === 1 ? "se canceló 1 cita" : `se cancelaron ${n} citas`)
      return {
        respuesta: count
          ? `El sábado pasado (${w.dayWords(saturday).replace(/^[^ ]+ /, "")}) se ${count === 1 ? "atendió" : "atendieron"} ${plural(count, "cita", "citas")}${sedes.length ? `: ${listOf(sedes.map((row) => ({ name: row.label, value: show(bySede, row.value.value) })))}` : ""}.`
          : `El sábado pasado (${w.dayWords(saturday).replace(/^[^ ]+ /, "")}) no se atendió ninguna cita.`,
        criterio: "«Citas atendidas» de Reportes del último sábado antes de hoy (día de la clínica), por sede.",
        nota: `Por profesional: ${listOf(byPerson.rows.filter((row) => (row.value.value ?? 0) > 0).map((row) => ({ name: row.label, value: show(byPerson, row.value.value) })))}. Ese día, además, ${missedWords(noShow.total.part ?? 0)} y ${cancelledWords(cancelled.total.part ?? 0)}.`,
        datos: { dia: saturday, total: result.total, porSede: bySede.rows, porProfesional: byPerson.rows, noVinieron: noShow.total, canceladas: cancelled.total },
      }
    },

    g099: async () => {
      const result = await h.fig("no_vinieron", "mes", "este_ano")
      const scope = await scopeAt("este_ano")
      const part = result.total.part ?? 0
      const whole = result.total.whole ?? 0
      const before = result.previous
      const rate = whole > 0 ? (part / whole) * 100 : null
      const beforeRate = before && (before.whole ?? 0) > 0 ? ((before.part ?? 0) / (before.whole ?? 0)) * 100 : null
      const change = rate !== null && beforeRate !== null ? Math.round((rate - beforeRate) * 10) / 10 : null
      const points = (value: number) => `${Math.abs(value).toLocaleString(h.scope.locale)} ${Math.abs(value) === 1 ? "punto" : "puntos"}`
      const oneDecimal = (value: number | null) => (value === null ? "sin dato" : `${(Math.round(value * 10) / 10).toLocaleString(h.scope.locale)} %`)
      const lastDay = (end: Date) => new Date(end.getTime() - 1)
      const dayOfEnd = new Intl.DateTimeFormat("en-CA", { timeZone: h.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(lastDay(scope.window.end))
      const prevEnd = new Intl.DateTimeFormat("en-CA", { timeZone: h.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(lastDay(scope.window.previous.end))
      const months = result.months.filter((month) => month.month.year === year)
      const verdict = change === null ? "No lo puedo comparar" : change < 0 ? "Sí, bajaron" : change > 0 ? "No, subieron" : "Siguen igual"
      return {
        respuesta: `${verdict}: en lo que va de ${year} (del 1 de enero al ${w.dayWords(dayOfEnd)}) no vino el ${oneDecimal(rate)} de las citas (${part} de ${whole}), contra el ${oneDecimal(beforeRate)} en los mismos días de ${year - 1} (${before?.part ?? 0} de ${before?.whole ?? 0}, hasta el ${w.dayWords(prevEnd)})${change ? `: ${change < 0 ? "bajó" : "subió"} ${points(change)}` : ""}.`,
        criterio: "«No vinieron» de Reportes de este año hasta hoy contra los mismos días del año anterior (la comparación de Reportes): citas en que el paciente no vino ÷ citas que ya pasaron.",
        nota: `Mes a mes este año: ${listOf(months.map((month) => ({ name: monthLabel(h, month.month, false), value: `${show(result, month.value.value)}${month.partial ? ", hasta hoy" : ""}` })))}.`,
        datos: { ano: result.total, anoAnterior: before, meses: months },
      }
    },

    g100: async () => {
      const yearStart = startOf(`${year}-01-01`).toISOString()
      const missed = (statuses: string[]) =>
        h.tx.execute<{ person: string; times: number }>(sql`
          select pp.display_name as person, count(*)::int as times
          from appointment a ${h.joinPerson(sql`a.patient_id`)}
          where a.organization_id = ${h.org} and a.status in ${statuses} and a.starts_at >= ${yearStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz
          group by a.patient_id, pp.display_name order by 2 desc, 1`)
      const all = [...(await missed(["no_asistio"]))]
      const rows = all.filter((row) => row.times > 1)
      const once = all.length - rows.length
      const orCancelled = [...(await missed(["no_asistio", "cancelada"]))].filter((row) => row.times > 1)
      const shown = rows.slice(0, 30)
      return {
        respuesta: rows.length
          ? `En lo que va de ${year}, ${plural(rows.length, "paciente faltó", "pacientes faltaron")} a más de una cita: ${listOf(shown.map((row) => ({ name: row.person, value: `${row.times}` })))}${rows.length > shown.length ? ` y ${rows.length - shown.length} más` : ""}.`
          : `En lo que va de ${year} ningún paciente faltó a más de una cita.`,
        criterio: "Pacientes con dos o más citas en que no vinieron («no vino»), de este año hasta hoy, de más a menos faltas.",
        nota: `Con una sola falta este año: ${plural(once, "paciente", "pacientes")}. Contando también las citas canceladas (faltó o canceló), ${plural(orCancelled.length, "paciente tiene", "pacientes tienen")} más de una.`,
        datos: { masDeUna: rows, conUna: once, conCanceladas: orCancelled.length },
      }
    },
  }
}
