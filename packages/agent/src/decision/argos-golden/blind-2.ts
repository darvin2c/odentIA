/**
 * Las respuestas correctas de las preguntas escritas a ciegas (`eval/argos-blind.json`),
 * parte 2: x26 a x50. Se calculan sobre las tablas y con las cifras de Reportes,
 * nunca con las vistas `argos` ni las cifras de Argos: así no heredan un error suyo.
 *
 * Las mismas reglas de las carpetas del dueño y de las generadas: sin periodo,
 * el mes en curso hasta ahora; «la semana pasada», de lunes a domingo; lo que
 * está agendado (ausencias, citas, controles), el periodo entero; lo pendiente
 * (deudas, planes, presupuestos), a hoy. Lo realizado es un procedimiento sin
 * anular de una atención firmada, contando su cantidad; lo vendido, lo pagado
 * de lo cargado; un paciente nuevo, el de su primera cita atendida. Quien
 * pregunta es la dueña, la Dra. Ana Torres: «yo» es ella.
 */
import {
  addDays,
  budgetAwaitsAnswerSql,
  budgetLineUnitsSql,
  budgetValueOptionSql,
  collectedNetMany,
  computeFigure,
  dayStart,
  type FigureGroup,
  type FigureResult,
  type FigureRow,
  getAgendaReport,
  getPatientReportList,
  getReportList,
  getReportPromotions,
  getReportSummary,
  overdueDebtSql,
  PURCHASE_STATUS_WORDS,
  purchaseBalances,
  purchaseOrderLabel,
  reportScope,
  upcomingWork,
} from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import { goldenWords, NO_INVOICES } from "./finance.js"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"
import { changePct, monthLabel, sameDaysWords } from "./trends.js"

const DAY_MS = 86_400_000

/** Las listas de «Te deben» por antigüedad: juntas son todos los que deben hoy. */
const DEBT_LISTS = ["debts_age_0_30", "debts_age_31_60", "debts_age_61_90", "debts_age_90_plus"] as const

/** A quién va una tarea sin responsable (`TASK_AREAS`). */
const AREA_WORDS: Record<string, string> = {
  recepcion: "Recepción",
  caja: "Caja",
  clinico: "el equipo clínico",
  administracion: "Administración",
}

/** La clasificación del periodontograma (AAP/EFP 2017), como la dice la ficha (`periodontalDiagnosisLabel`). */
const STAGE_WORDS = ["", "I", "II", "III", "IV"]
const EXTENT_WORDS: Record<string, string> = { localized: "localizada", generalized: "generalizada", molar_incisor: "con patrón molar-incisivo" }
const PERIO_STATUS_WORDS: Record<string, string> = { stable: "estable", remission: "en remisión", unstable: "inestable" }

/** «1 frasco», «2 cepillos», «3 unidades»: la unidad de uso del producto. */
function unitsWord(count: number, unit: string): string {
  if (count === 1) return `1 ${unit}`
  return `${count} ${/[aeiouáéó]$/i.test(unit) ? `${unit}s` : `${unit}es`}`
}

/** Un bloqueo o una ausencia de la agenda, con sus días y horas de la sede (como `generated-4.ts`). */
type Block = {
  dentist: string | null
  dentistId: string | null
  branch: string
  branchId: string
  chair: string | null
  kind: string
  reason: string | null
  fromDay: string
  fromTime: string
  lastDay: string
  toTime: string
  startMs: number
  endMs: number
}

/** Un presupuesto con su valor (la opción que vale), lo aceptado y lo aún no decidido (como `generated-5.ts`). */
type Budget = {
  id: string
  patientId: string
  person: string
  number: number
  status: string
  presented: string
  cents: string
  accepted: string
  pending: string
}

export function blindSolvers2(h: GoldenHelpers): GoldenSolvers {
  const w = goldenWords(h)
  const days = sameDaysWords(h)
  const { tx, org, tz, money, show, listOf } = h
  const { locale, currency, window } = h.scope
  const nowIso = h.now.toISOString()
  const today = w.todayKey
  const weekdayOf = (key: string): number => new Date(`${key}T12:00:00Z`).getUTCDay()
  /** El lunes de esta semana (día de la clínica). */
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7))
  const year = window.from.year
  const startOf = (key: string): Date => {
    const [y, m, d] = key.split("-").map(Number) as [number, number, number]
    return dayStart(tz, y, m, d)
  }
  const iso = (value: Date | string): string => (typeof value === "string" ? value : value.toISOString())
  const between = (column: SQL, start: Date | string, end: Date | string) =>
    sql`${column} >= ${iso(start)}::timestamptz and ${column} < ${iso(end)}::timestamptz`
  /** Un instante como texto ISO que `new Date` lee siempre. */
  const isoOf = (column: SQL) => sql`(to_json(${column}) #>> '{}')`
  const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
  const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
  const lower = (text: string): string => text.charAt(0).toLocaleLowerCase(locale) + text.slice(1)
  const pct = (part: number, total: number): string => (total > 0 ? `${Math.round((part / total) * 100)} %` : "sin dato")
  const hoursOf = (minutes: number): string => `${(Math.round((minutes / 60) * 10) / 10).toLocaleString(locale)} h`
  const per = (cents: number, count: number): string => (count > 0 ? money(Math.round(cents / count)) : "sin dato")
  const sumOf = <T>(rows: readonly T[], pick: (row: T) => string | number): number => rows.reduce((total, row) => total + Number(pick(row)), 0)
  /** «este mes (del 1 al 21 de octubre de 2026)». */
  const thisMonth = `este mes (${w.monthSoFar})`
  const ThisMonth = capital(thisMonth)
  /** «del lunes 12 al domingo 18 de octubre». */
  const spanWords = (from: string, to: string): string =>
    from === to
      ? `el ${w.dayWords(from)}`
      : `del ${from.slice(0, 7) === to.slice(0, 7) ? w.dayWords(from).replace(/ de [^ ]+$/, "") : w.dayWords(from)} al ${w.dayWords(to)}`
  /** «12 de septiembre» o, con el año, «12 de septiembre de 2026». */
  const dateWords = (value: Date | string, withYear = false): string =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}), timeZone: tz }).format(new Date(value))
  /** El día de la clínica (`YYYY-MM-DD`) de un instante. */
  const reportDay = (value: Date | string): string =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value))
  const shortDate = (value: Date | string): string =>
    new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: tz }).format(new Date(value))
  /** «la Dra. Ana Torres», «el Dr. Diego Salas»; sin título, el nombre solo. */
  const the = (name: string): string => (/^Dra\.?\s/.test(name) ? `la ${name}` : /^Dr\.?\s/.test(name) ? `el ${name}` : name)
  /** Quien pregunta es la Dra. Ana Torres: cuando sale ella, se dice que es ella. */
  const whoIs = (name: string | null): string => (name && /ana torres/i.test(name) ? `tú (${name})` : (name ?? "—"))

  // --- La clínica ---------------------------------------------------------------------------
  const branches = async () => [
    ...(await tx.execute<{ id: string; name: string }>(sql`select id, name from branch where organization_id = ${org} and is_active order by name`)),
  ]
  /** Lo registrado alguna vez en una sede: horarios, unidades, citas y cobros. */
  const branchFacts = async (branchId: string) => {
    const [row] = await tx.execute<{ schedules: number; chairs: number; appointments: number; payments: number }>(sql`
      select (select count(*) from professional_schedule s where s.organization_id = ${org} and s.branch_id = ${branchId} and s.is_active)::int as schedules,
        (select count(*) from schedule_chair c where c.organization_id = ${org} and c.branch_id = ${branchId} and c.is_active)::int as chairs,
        (select count(*) from appointment a where a.organization_id = ${org} and a.branch_id = ${branchId})::int as appointments,
        (select count(*) from patient_payment p where p.organization_id = ${org} and p.branch_id = ${branchId})::int as payments`)
    return row ?? { schedules: 0, chairs: 0, appointments: 0, payments: 0 }
  }
  /** «horarios de profesionales, unidades dentales ni citas». */
  const missingWords = (facts: { schedules: number; chairs: number; appointments: number }): string => {
    const items = [facts.schedules === 0 ? "horarios de profesionales" : null, facts.chairs === 0 ? "unidades dentales" : null, facts.appointments === 0 ? "citas" : null].filter(
      (item): item is string => item !== null,
    )
    return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ni ${items.at(-1)}`
  }
  /** Un miembro de la clínica por su nombre. */
  const userNamed = async (pattern: string) => {
    const [row] = await tx.execute<{ id: string; name: string }>(sql`
      select u.id, u.name from "user" u
      where u.name ilike ${pattern} and exists (select 1 from member m where m.organization_id = ${org} and m.user_id = u.id)
      order by u.name limit 1`)
    return row ?? null
  }
  /** Una cifra de Reportes con una sede elegida en la pantalla. */
  const figIn = async (figure: string, group: FigureGroup, period: string, branchId?: string): Promise<FigureResult> =>
    computeFigure({ ...h.ctx, scope: await reportScope(tx, org, branchId ? { period, branchId } : { period }, h.now) }, { figure, group })
  /** El paciente tiene una cita programada o confirmada por venir. */
  const upcoming = (patientColumn: SQL) => sql`exists (select 1 from appointment n where n.organization_id = ${org} and n.patient_id = ${patientColumn}
    and n.starts_at > ${nowIso}::timestamptz and n.status in ('programada','confirmada'))`

  // --- La agenda ----------------------------------------------------------------------------
  /** Bloqueos y ausencias que tocan un tramo, con los días y horas de su sede. */
  const blocksIn = async (start: Date, end: Date): Promise<Block[]> => {
    const rows = await tx.execute<Block>(sql`
      select u.name as dentist, k.dentist_user_id as "dentistId", b.name as branch, b.id as "branchId", c.name as chair, k.kind, k.reason,
        to_char(k.starts_at at time zone coalesce(b.timezone, ${tz}), 'YYYY-MM-DD') as "fromDay",
        to_char(k.starts_at at time zone coalesce(b.timezone, ${tz}), 'HH24:MI') as "fromTime",
        to_char((k.ends_at - interval '1 second') at time zone coalesce(b.timezone, ${tz}), 'YYYY-MM-DD') as "lastDay",
        to_char(k.ends_at at time zone coalesce(b.timezone, ${tz}), 'HH24:MI') as "toTime",
        (extract(epoch from k.starts_at) * 1000)::float8 as "startMs", (extract(epoch from k.ends_at) * 1000)::float8 as "endMs"
      from schedule_block k
      join branch b on b.organization_id = k.organization_id and b.id = k.branch_id
      left join "user" u on u.id = k.dentist_user_id
      left join schedule_chair c on c.organization_id = k.organization_id and c.id = k.chair_id
      where k.organization_id = ${org} and k.starts_at < ${end.toISOString()}::timestamptz and k.ends_at > ${start.toISOString()}::timestamptz
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

  // --- El dinero ----------------------------------------------------------------------------
  /** Quién debe hoy y cuánto: las listas de «Te deben» por antigüedad juntas, de mayor a menor. */
  const debtors = async () => {
    const lists = await Promise.all(DEBT_LISTS.map((list) => getReportList(tx, org, { period: "este_mes", list, limit: 5000 }, h.now)))
    return lists
      .flatMap((list) => list.rows)
      .map((row) => ({ patientId: row.patientId, name: row.personName, cents: row.cents ?? 0, since: row.at }))
      .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name))
  }
  /** Productos con pagos vigentes en [start, end): las unidades del cargo pagado y lo pagado en el tramo (como `generated-2.ts`). */
  const paidProducts = (start: string, end: string, where: SQL = sql``) =>
    tx.execute<{ name: string; unit: string; units: number; cents: string }>(sql`
      select pr.name, pr.unit, sum(c.product_quantity)::int as units, sum(ap.cents)::text as cents
      from patient_charge c join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id
      join lateral (select sum(a.amount_cents) as cents from patient_payment_application a
        join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
        where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null
          and pay.paid_at >= ${start}::timestamptz and pay.paid_at < ${end}::timestamptz) ap on ap.cents > 0
      where c.organization_id = ${org} and c.voided_at is null ${where}
      group by 1, 2 order by sum(c.product_quantity) desc, sum(ap.cents) desc, 1`)
  /** Productos cargados en [start, end), pagados o no (la venta es del día del primer cargo de la cadena). */
  const chargedProducts = (start: string, end: string, where: SQL = sql``) =>
    tx.execute<{ name: string; unit: string; units: number; cents: string }>(sql`
      select pr.name, pr.unit, sum(c.product_quantity)::int as units, sum(c.amount_cents)::text as cents
      from patient_charge c join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id
      left join patient_charge o on o.organization_id = c.organization_id and o.id = c.original_charge_id
      where c.organization_id = ${org} and c.voided_at is null
        and coalesce(o.created_at, c.created_at) >= ${start}::timestamptz and coalesce(o.created_at, c.created_at) < ${end}::timestamptz ${where}
      group by 1, 2 order by sum(c.product_quantity) desc, sum(c.amount_cents) desc, 1`)
  const productWords = (rows: Array<{ name: string; unit: string; units: number; cents: string }>) =>
    listOf(rows.map((row) => ({ name: row.name, value: `${unitsWord(row.units, row.unit)}, ${money(Number(row.cents))}` })))

  // --- Los presupuestos ---------------------------------------------------------------------
  const budgetRef = { id: sql`b.id`, organizationId: sql`b.organization_id` }
  const awaits = budgetAwaitsAnswerSql({ status: sql`b.status`, id: sql`b.id`, organizationId: sql`b.organization_id` })
  const units = budgetLineUnitsSql({ billingMode: sql`i.billing_mode`, sessionsPlanned: sql`i.sessions_planned` })
  const acceptedLine = sql`(b.status in ('aceptado','parcial') and i.decision = 'aceptado')`
  /** Presupuestos presentados (no borradores) que cumplen `where`, con su valor, lo aceptado y lo aún no decidido. */
  const budgets = (where: SQL) =>
    tx.execute<Budget>(sql`
      select b.id, b.patient_id as "patientId", pp.display_name as person, b.budget_number as number, b.status,
        ${isoOf(sql`b.presented_at`)} as presented,
        coalesce(sum(i.price_cents::bigint * ${units}), 0)::text as cents,
        coalesce(sum(i.price_cents::bigint * ${units}) filter (where ${acceptedLine}), 0)::text as accepted,
        coalesce(sum(i.price_cents::bigint * ${units}) filter (where i.decision in ('pendiente','pospuesto')), 0)::text as pending
      from treatment_budget b
      left join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
        and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.price_cents is not null
      ${h.joinPerson(sql`b.patient_id`)}
      where b.organization_id = ${org} and b.presented_at is not null and ${where}
      group by b.id, b.patient_id, pp.display_name, b.budget_number, b.status, b.presented_at
      order by b.presented_at, b.budget_number`)

  // --- Las promociones ----------------------------------------------------------------------
  /** Los usos de cada promoción en [start, end): presupuestos entregados (con su opción de valor) y cobros sueltos que la llevan, como Reportes › Promociones. */
  const promotionUses = (start: string, end: string) =>
    tx.execute<{ id: string; uses: number; people: number }>(sql`
      with uses as (
        select i.promotion_id, b.id as use_id, b.patient_id from treatment_budget b
        join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
          and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.promotion_id is not null and i.price_cents is not null
        where b.organization_id = ${org} and b.currency = ${currency} and b.status <> 'borrador'
          and b.presented_at >= ${start}::timestamptz and b.presented_at < ${end}::timestamptz
        union all
        select c.promotion_id::uuid, c.id, c.patient_id from patient_charge c
        where c.organization_id = ${org} and c.currency = ${currency} and c.voided_at is null and c.budget_item_id is null
          and c.promotion_id ~ '^[0-9a-f]{8}-[0-9a-f-]{27}$'
          and c.created_at >= ${start}::timestamptz and c.created_at < ${end}::timestamptz)
      select u.promotion_id::text as id, count(distinct u.use_id)::int as uses, count(distinct u.patient_id)::int as people
      from uses u group by 1`)

  return {
    x26: async () => {
      const from = addDays(monday, -7)
      const to = addDays(monday, -1)
      const result = await h.fig("agenda_ocupada", "sede", `${from}..${to}`)
      const before = await h.fig("agenda_ocupada", "sede", `${addDays(from, -7)}..${addDays(to, -7)}`)
      const free = await h.fig("horas_libres", "sede", `${from}..${to}`)
      const measured = result.rows.filter((row) => row.value.value !== null).sort((a, b) => (b.value.value ?? 0) - (a.value.value ?? 0))
      const empty = result.rows.filter((row) => row.value.value === null)
      const emptyWords: string[] = []
      for (const row of empty) {
        const facts = await branchFacts(row.key)
        emptyWords.push(`la ${row.label} no tiene ${missingWords(facts) || "horario de profesionales"} registrados: no hay agenda que medir`)
      }
      const words = (res: FigureResult, rows: FigureRow[]) =>
        listOf(rows.map((row) => ({ name: row.label, value: `${show(res, row.value.value)}: ${hoursOf(row.value.part ?? 0)} con citas de ${hoursOf(row.value.whole ?? 0)} de horario` })))
      const beforeRows = before.rows.filter((row) => row.value.value !== null)
      return {
        respuesta: measured.length
          ? `La semana pasada (${spanWords(from, to)}) la agenda estuvo ocupada así: ${words(result, measured)}.${emptyWords.length ? ` ${capital(emptyWords.join("; "))}.` : ""} En toda la clínica, ${show(result)}.`
          : `La semana pasada (${spanWords(from, to)}) ninguna sede tiene horario de profesionales: no hay agenda que medir.`,
        criterio:
          "«Agenda ocupada» de Reportes por sede, de lunes a domingo de la semana pasada: minutos de citas no canceladas ÷ minutos del horario de cada profesional menos sus ausencias y bloqueos.",
        nota: `La semana anterior (${spanWords(addDays(from, -7), addDays(to, -7))}): ${listOf(beforeRows.map((row) => ({ name: row.label, value: show(before, row.value.value) })))}; en toda la clínica, ${show(before)}. Horas libres la semana pasada: ${listOf(free.rows.filter((row) => row.value.value !== null).map((row) => ({ name: row.label, value: show(free, row.value.value) })))}.`,
        datos: { semana: { desde: from, hasta: to }, sedes: result.rows, total: result.total, semanaAnterior: before.rows, horasLibres: free.rows },
      }
    },

    x27: async () => {
      const luis = await userNamed("%luis prado%")
      const salas = await userNamed("%salas%")
      const count = (start: string, end: string) =>
        tx.execute<{ id: string; patients: number; appointments: number }>(sql`
          select a.dentist_user_id as id, count(distinct a.patient_id)::int as patients, count(*)::int as appointments
          from appointment a
          where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at >= ${start}::timestamptz and a.starts_at < ${end}::timestamptz
          group by 1`)
      const month = [...(await count(h.monthStart, nowIso))]
      const before = [...(await count(window.previous.start.toISOString(), window.previous.end.toISOString()))]
      const of = (rows: typeof month, person: { id: string } | null) => rows.find((row) => row.id === person?.id) ?? { id: "", patients: 0, appointments: 0 }
      const people = [luis, salas].filter((person): person is { id: string; name: string } => person !== null)
      const missing = [!luis ? "Luis Prado" : null, !salas ? "ningún Dr. Salas" : null].filter(Boolean)
      const [first, second] = people
      return {
        respuesta: first
          ? `${ThisMonth}, ${the(first.name)} atendió a ${plural(of(month, first).patients, "paciente", "pacientes")}${second ? ` y ${the(second.name)}, a ${plural(of(month, second).patients, "paciente", "pacientes")}` : ""}.${missing.length ? ` En el equipo no hay ${missing.join(" ni ")}.` : ""}`
          : "En el equipo no hay ni Luis Prado ni un Dr. Salas.",
        criterio: "Pacientes distintos con al menos una cita atendida en el mes en curso, hasta ahora, por el profesional de la cita (como d2). El Dr. Salas es el Dr. Diego Salas, el único Salas del equipo.",
        nota: `Contando citas atendidas en vez de pacientes (como «Citas atendidas» de Reportes): ${listOf(people.map((person) => ({ name: person.name, value: plural(of(month, person).appointments, "cita", "citas") })))}. En ${days.sameAs}: ${listOf(people.map((person) => ({ name: person.name, value: plural(of(before, person).patients, "paciente", "pacientes") })))}.`,
        datos: { profesionales: people.map((person) => ({ ...person, mes: of(month, person), mismosDiasMesAnterior: of(before, person) })) },
      }
    },

    x28: async () => {
      const ninety = new Date(h.now.getTime() - 90 * DAY_MS).toISOString()
      const [row] = await tx.execute<{ running: number; booked: number; stalled: number; suspendedOnly: number; stalledAll: number; active90: number; idle90: number }>(sql`
        with p as (
          select pi.plan_id, tp.patient_id,
            bool_or(pi.decision_status = 'aceptado' and pi.status in ('pendiente','programado','en_curso')) as running,
            bool_or(pi.decision_status = 'aceptado' and pi.status = 'suspendido') as suspended
          from treatment_plan_item pi
          join treatment_plan tp on tp.organization_id = pi.organization_id and tp.id = pi.plan_id and not tp.is_legacy
          where pi.organization_id = ${org}
          group by pi.plan_id, tp.patient_id),
        q as (
          select p.*, ${upcoming(sql`p.patient_id`)} as booked,
            exists (select 1 from appointment v where v.organization_id = ${org} and v.patient_id = p.patient_id and v.status = 'atendida'
              and v.starts_at >= ${ninety}::timestamptz and v.starts_at < ${nowIso}::timestamptz) as recent
          from p)
        select count(*) filter (where running)::int as running,
          count(*) filter (where running and booked)::int as booked,
          count(*) filter (where running and not booked)::int as stalled,
          count(*) filter (where suspended and not running)::int as "suspendedOnly",
          count(*) filter (where (running or suspended) and not booked)::int as "stalledAll",
          count(*) filter (where running and recent)::int as active90,
          count(*) filter (where running and not recent)::int as idle90
        from q`)
      const running = row?.running ?? 0
      const booked = row?.booked ?? 0
      const stalled = row?.stalled ?? 0
      const suspended = row?.suspendedOnly ?? 0
      return {
        respuesta: !running
          ? "Hoy no hay ningún plan de tratamiento en curso: ninguno tiene tratamientos aceptados por hacer."
          : booked
            ? `Hoy hay ${plural(running, "plan de tratamiento en curso", "planes de tratamiento en curso")} (con tratamientos aceptados por hacer): ${booked} ${booked === 1 ? "sigue avanzando" : "siguen avanzando"} con una cita por venir y ${stalled} se ${stalled === 1 ? "quedó parado" : "quedaron parados"}, sin ninguna cita agendada.${suspended ? ` Aparte, ${plural(suspended, "plan solo tiene", "planes solo tienen")} tratamientos suspendidos.` : ""}`
            : `Hoy hay ${plural(running, "plan de tratamiento en curso", "planes de tratamiento en curso")} (con tratamientos aceptados por hacer) y ${running === 1 ? "está parado" : `los ${running} están parados`}: ninguno de esos pacientes tiene una cita por venir.${suspended ? ` Aparte, ${plural(suspended, "plan solo tiene", "planes solo tienen")} tratamientos suspendidos.` : ""}`,
        criterio:
          "Planes (no heredados) con al menos un tratamiento aceptado por empezar, programado o en curso, a hoy (como g113); parado, si el paciente no tiene una cita programada o confirmada por venir (como g114).",
        nota: `Si «parado» es sin ninguna cita atendida en los últimos 90 días: ${plural(row?.idle90 ?? 0, "parado", "parados")} y ${row?.active90 ?? 0} con una cita atendida en ese tiempo. Contando también los que solo tienen algo suspendido, sin cita por venir: ${row?.stalledAll ?? 0}.`,
        datos: { row },
      }
    },

    x29: async () => {
      const adsWhere = sql`(e.concept ~* 'publicidad|facebook|instagram|anuncio|marketing|campa' or e.category ~* 'publicidad|marketing')`
      const adsIn = async (start: string) => {
        const [row] = await tx.execute<{ count: number; cents: string }>(sql`
          select count(*)::int as count, coalesce(sum(e.amount_cents), 0)::text as cents from expense e
          where e.organization_id = ${org} and e.voided_at is null and e.currency = ${currency}
            and e.spent_at >= ${start}::timestamptz and e.spent_at < ${nowIso}::timestamptz and ${adsWhere}`)
        return { count: row?.count ?? 0, cents: Number(row?.cents ?? 0) }
      }
      const month = await adsIn(h.monthStart)
      const yearAds = await adsIn(startOf(`${year}-01-01`).toISOString())
      const channels = await h.fig("nos_buscaron", "canal")
      const messenger = channels.rows.find((row) => row.key === "messenger")
      const instagram = channels.rows.find((row) => row.key === "instagram")
      const referral = await h.fig("como_nos_conocieron")
      const social = referral.rows.find((row) => row.key === "redes_sociales")
      const spent = await h.fig("gastos", "categoria")
      return {
        respuesta: `No lo sé: odentIA no registra lo que gastas en publicidad de Facebook${month.count ? ` (los gastos registrados de publicidad de este mes suman ${money(month.cents)}, pero no dicen de qué anuncio)` : " (entre los gastos registrados de este mes no hay ninguno de publicidad)"} ni qué anuncio trajo a cada paciente. Lo más cercano ${thisMonth}: ${plural(messenger?.value.value ?? 0, "persona nos escribió", "personas nos escribieron")} por primera vez por Messenger, el chat de Facebook, y ${(messenger?.value.part ?? 0) === 0 ? "ninguna vino todavía a atenderse" : `${messenger?.value.part} ya ${messenger?.value.part === 1 ? "vino" : "vinieron"} a atenderse`}; ${social?.value.value ?? 0} de los ${referral.total.value ?? 0} pacientes nuevos dijeron que nos conocieron por redes sociales.`,
        criterio: `Trampa: odentIA no registra la inversión en publicidad ni de qué campaña llega cada paciente. Se miran los gastos registrados del mes con publicidad, Facebook, anuncio o marketing en el concepto (${month.count}) y se ofrecen el embudo de Reportes por canal (Messenger, el de Facebook) y «Cómo nos conocieron» = Redes sociales, del mes en curso.`,
        nota: `Por Instagram, este mes: ${instagram?.value.value ?? 0} personas, ${instagram?.value.part ?? 0} ya vinieron. Gastos registrados del mes por tipo: ${listOf(spent.rows.map((row) => ({ name: row.label, value: show(spent, row.value.value) })))}. Gastos de publicidad registrados en ${year}: ${yearAds.count}.`,
        datos: { gastosPublicidadMes: month, gastosPublicidadAno: yearAds, messenger: messenger ?? null, instagram: instagram ?? null, redesSociales: social ?? null, pacientesNuevos: referral.total },
      }
    },

    x30: async () => {
      const last = window.previous.from
      const start = dayStart(tz, last.year, last.month, 1)
      const end = window.start
      const name = monthLabel(h, last)
      const orders = (await purchaseBalances(tx, org, { currency })).filter((row) => row.createdAt >= start && row.createdAt < end)
      const made = orders
        .filter((row) => row.status !== "borrador" && row.status !== "cancelada")
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.orderNumber - b.orderNumber)
      const others = orders.filter((row) => row.status === "borrador" || row.status === "cancelada")
      const total = sumOf(made, (row) => row.orderedCents)
      const [paidOut] = await tx.execute<{ count: number; cents: string }>(sql`
        select count(*)::int as count, coalesce(sum(e.amount_cents), 0)::text as cents from expense e
        where e.organization_id = ${org} and e.voided_at is null and e.purchase_order_id is not null and e.currency = ${currency}
          and ${between(sql`e.spent_at`, start, end)}`)
      const bySupplier = new Map<string, number>()
      for (const row of made) bySupplier.set(row.supplierName, (bySupplier.get(row.supplierName) ?? 0) + row.orderedCents)
      return {
        respuesta: made.length
          ? `En ${name} le compraste a proveedores ${money(total)} en ${plural(made.length, "compra", "compras")}: ${made
              .map((row) => `${purchaseOrderLabel(row.orderNumber)} a ${row.supplierName}, ${money(row.orderedCents)} (${dateWords(row.createdAt)}, ${(PURCHASE_STATUS_WORDS[row.status] ?? row.status).toLowerCase()})`)
              .join("; ")}.`
          : `En ${name} no se hizo ninguna compra a proveedores.`,
        criterio: "Compras de Inventario creadas en el mes pasado completo (día de la clínica), sin borradores ni canceladas: lo pedido por su costo, con el proveedor, el día y su estado (como g147).",
        nota: `De esas compras ya llegó ${money(sumOf(made, (row) => row.receivedCents))} y se pagó ${money(sumOf(made, (row) => row.paidCents))}. Lo pagado a proveedores durante ${name} (pagos de compras registrados en Gastos, de cualquier compra): ${money(Number(paidOut?.cents ?? 0))} en ${plural(paidOut?.count ?? 0, "pago", "pagos")}.${others.length ? ` Sin contar ${listOf(others.map((row) => ({ name: purchaseOrderLabel(row.orderNumber), value: (PURCHASE_STATUS_WORDS[row.status] ?? row.status).toLowerCase() })))}.` : ""}`,
        datos: {
          mes: `${last.year}-${String(last.month).padStart(2, "0")}`,
          compras: made.map((row) => ({ numero: purchaseOrderLabel(row.orderNumber), proveedor: row.supplierName, estado: row.status, pedido: row.orderedCents, recibido: row.receivedCents, pagado: row.paidCents })),
          porProveedor: Object.fromEntries(bySupplier),
          pagadoEnElMes: paidOut ?? null,
        },
      }
    },

    x31: async () => {
      const nextMonday = addDays(monday, 7)
      const nextSunday = addDays(monday, 13)
      const start = startOf(nextMonday)
      const end = startOf(addDays(monday, 14))
      const orthoAppointment = sql`(a.service_name ilike '%ortodon%' or exists (select 1 from service_catalog s
        left join org_specialty os on os.organization_id = s.organization_id and os.id = s.specialty_id
        where s.organization_id = a.organization_id and s.id = a.service_id and (s.name ilike '%ortodon%' or os.key ilike 'ortodon%')))`
      const [week] = await tx.execute<{ all: number }>(sql`
        select count(*)::int as all from appointment a
        where a.organization_id = ${org} and a.status in ('programada','confirmada') and ${between(sql`a.starts_at`, start, end)}`)
      const ortho = await tx.execute<{ day: string; time: string; patient: string; dentist: string; branch: string; status: string }>(sql`
        select to_char(a.starts_at at time zone ${tz}, 'YYYY-MM-DD') as day, to_char(a.starts_at at time zone ${tz}, 'HH24:MI') as time,
          pp.display_name as patient, u.name as dentist, b.name as branch, a.status
        from appointment a
        join "user" u on u.id = a.dentist_user_id
        join branch b on b.organization_id = a.organization_id and b.id = a.branch_id
        ${h.joinPerson(sql`a.patient_id`)}
        where a.organization_id = ${org} and a.status in ('programada','confirmada') and ${between(sql`a.starts_at`, start, end)} and ${orthoAppointment}
        order by a.starts_at, u.name`)
      const [last] = await tx.execute<{ at: string | null; month: number; next: string | null }>(sql`
        select ${isoOf(sql`max(a.starts_at) filter (where a.status = 'atendida')`)} as at,
          count(*) filter (where a.status = 'atendida' and a.starts_at >= ${h.monthStart}::timestamptz)::int as month,
          ${isoOf(sql`min(a.starts_at) filter (where a.status in ('programada','confirmada') and a.starts_at > ${nowIso}::timestamptz)`)} as next
        from appointment a where a.organization_id = ${org} and ${orthoAppointment}`)
      const controls = await tx.execute<{ title: string; due: string; patient: string; ortho: boolean }>(sql`
        select f.title, to_char(f.due_at at time zone ${tz}, 'YYYY-MM-DD') as due, pp.display_name as patient,
          (f.title ilike '%ortodon%' or coalesce(s1.name, s2.name, '') ilike '%ortodon%') as ortho
        from clinical_follow_up f
        left join encounter_procedure ep on ep.organization_id = f.organization_id and ep.id = f.encounter_procedure_id
        left join service_catalog s1 on s1.organization_id = f.organization_id and s1.id = ep.service_id
        left join treatment_plan_item pi on pi.organization_id = f.organization_id and pi.id = f.plan_item_id
        left join service_catalog s2 on s2.organization_id = f.organization_id and s2.id = pi.service_id
        ${h.joinPerson(sql`f.patient_id`)}
        where f.organization_id = ${org} and f.status in ('pendiente','programado') and ${between(sql`f.due_at`, start, end)}
        order by f.due_at, pp.display_name`)
      const orthoControls = controls.filter((row) => row.ortho)
      const week2 = spanWords(nextMonday, nextSunday)
      const lastWords = last?.at ? ` El último control de ortodoncia atendido fue el ${dateWords(last.at, true)}; ${thisMonth} se atendieron ${last.month}.` : " Nunca se ha atendido un control de ortodoncia."
      return {
        respuesta: ortho.length
          ? `La próxima semana (${week2}) hay ${plural(ortho.length, "control de ortodoncia", "controles de ortodoncia")}: ${listOf(ortho.map((row) => ({ name: `${w.dayWords(row.day)} a las ${row.time}, ${row.patient}`, value: `${row.dentist}, ${row.branch}${row.status === "confirmada" ? ", confirmada" : ", sin confirmar"}` })))}.`
          : `No hay ninguno: para la próxima semana (${week2}) no hay ningún control de ortodoncia agendado${(week?.all ?? 0) === 0 ? "; esa semana todavía no hay ninguna cita agendada" : ` (hay ${plural(week?.all ?? 0, "cita", "citas")} de otros tratamientos)`}.${lastWords}`,
        criterio:
          "Citas programadas o confirmadas de la próxima semana (lunes a domingo, día de la clínica) de un servicio de ortodoncia (por su nombre o su especialidad); aparte, los controles pendientes de las fichas que tocan esa semana.",
        nota: `${
          controls.length
            ? `En las fichas tocan esa semana ${plural(controls.length, "control", "controles")}, ${orthoControls.length ? `${orthoControls.length} de ortodoncia` : "ninguno de ortodoncia"}: ${listOf(controls.map((row) => ({ name: row.patient, value: `${lower(row.title)}, el ${w.dayWords(row.due)}` })))}.`
            : "En las fichas no hay controles que toquen esa semana."
        }${last?.next ? ` El próximo control de ortodoncia agendado es el ${dateWords(last.next, true)}.` : " No hay ningún control de ortodoncia agendado más adelante."}`,
        datos: { semana: { desde: nextMonday, hasta: nextSunday }, citasSemana: week?.all ?? 0, ortodoncia: ortho, ultimo: last ?? null, controles: controls },
      }
    },

    x32: async () => {
      const collected = await h.fig("cobrado")
      const fresh = await h.fig("pacientes_nuevos")
      const accepted = await h.fig("aceptaron")
      const noShow = await h.fig("no_vinieron")
      const overdue = await h.fig("deuda_vencida")
      const leaves = await h.fig("lo_que_deja")
      const summary = await getReportSummary(tx, org, { period: "este_mes" }, h.now)
      const goals = summary.goals
      const value = collected.total.value ?? 0
      const before = collected.previous?.value ?? 0
      const freshValue = fresh.total.value ?? 0
      const freshBefore = fresh.previous?.value ?? 0
      const change = value === before ? "lo mismo" : `${money(Math.abs(value - before))} ${value > before ? "más" : "menos"} (${w.signed(value, before)})`
      const goal = goals?.cobrado
      const goalWords = goal
        ? ` Vas en el ${goal.percent} % de tu meta del mes (${money(goal.amount)}) con el ${goals?.elapsedPercent ?? 0} % del mes transcurrido${goal.remaining > 0 ? `: te faltan ${money(goal.remaining)}` : ": ya la cumpliste"}.`
        : ""
      const freshGoal = goals?.pacientesNuevos ? `; tu meta es ${goals.pacientesNuevos.amount}` : ""
      return {
        respuesta: `${ThisMonth} cobraste ${show(collected)}, ${change} que en ${days.sameAs} (${show(collected, before)}).${goalWords} Llegaron ${plural(freshValue, "paciente nuevo", "pacientes nuevos")} (${freshBefore} en los mismos días del mes anterior${freshGoal}), se aceptó el ${show(accepted)} de los presupuestos entregados (${accepted.total.part ?? 0} de ${accepted.total.whole ?? 0}) y no vino el ${show(noShow)} de las citas (${noShow.total.part ?? 0} de ${noShow.total.whole ?? 0}).`,
        criterio:
          "Las cifras del Resumen de Reportes del mes en curso hasta hoy contra los mismos días del mes anterior: lo cobrado (con el avance de la meta del mes), pacientes nuevos, aceptación de presupuestos y no vinieron.",
        nota: `En ${days.sameAs}: aceptación ${show(accepted, accepted.previous?.value ?? null)} y no vinieron ${show(noShow, noShow.previous?.value ?? null)}. Hoy te deben ${show(overdue)} desde hace más de 30 días (${plural(overdue.total.part ?? 0, "persona", "personas")}). Lo que deja el mes (lo cobrado menos comisiones y gastos registrados): ${show(leaves)}.`,
        datos: {
          cobrado: collected.total,
          cobradoAntes: collected.previous,
          metas: goals,
          nuevos: fresh.total,
          nuevosAntes: fresh.previous,
          aceptaron: accepted.total,
          noVinieron: noShow.total,
          vencida: overdue.total,
          deja: leaves.total,
        },
      }
    },

    x33: async () => {
      const promos = await tx.execute<{ id: string; name: string; starts: string | null; ends: string | null; startsAt: string | null }>(sql`
        select id::text as id, name, to_char(starts_at at time zone ${tz}, 'YYYY-MM-DD') as starts,
          to_char((ends_at - interval '1 second') at time zone ${tz}, 'YYYY-MM-DD') as ends, ${isoOf(sql`starts_at`)} as "startsAt"
        from promotion where organization_id = ${org} order by starts_at`)
      const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
      const cleaning = promos.find((row) => /limpieza/.test(fold(row.name)) && /fluor/.test(fold(row.name)))
      const whitening = promos.find((row) => /blanqueamiento/.test(fold(row.name)) && /2\s*[x×]\s*1/.test(fold(row.name)))
      const asked = [cleaning, whitening].filter((row): row is NonNullable<typeof row> => row !== undefined)
      const since = asked.map((row) => row.startsAt).filter((at): at is string => at !== null).sort()[0] ?? h.monthStart
      const all = [...(await promotionUses(since, nowIso))]
      const month = [...(await promotionUses(h.monthStart, nowIso))]
      const usesOf = (list: typeof all, id: string) => list.find((row) => row.id === id) ?? { id, uses: 0, people: 0 }
      const span = (row: { starts: string | null; ends: string | null }) =>
        row.ends ? `del ${dateWords(`${row.starts}T12:00:00Z`)} al ${dateWords(`${row.ends}T12:00:00Z`, true)}` : `desde el ${dateWords(`${row.starts}T12:00:00Z`, true)}, sin fecha de fin`
      const ended = (row: { ends: string | null }) => row.ends !== null && row.ends < today
      const report = await getReportPromotions(tx, org, { period: `${reportDay(since)}..${today}` }, h.now)
      const reportOf = (name: string) => report.promotions.find((row) => row.name === name)
      if (asked.length < 2) {
        return {
          respuesta: `No tienes ${!cleaning ? "una promoción «Limpieza + flúor»" : ""}${!cleaning && !whitening ? " ni " : ""}${!whitening ? "una promoción «Blanqueamiento 2x1»" : ""}. Tus promociones son ${promos.map((row) => `«${row.name}»`).join(", ")}.`,
          criterio: "Promociones de la clínica por nombre.",
          datos: { promociones: promos },
        }
      }
      const [a, b] = [...asked].sort((x, y) => usesOf(all, y.id).uses - usesOf(all, x.id).uses || usesOf(all, y.id).people - usesOf(all, x.id).people) as [
        (typeof asked)[number],
        (typeof asked)[number],
      ]
      const ua = usesOf(all, a.id)
      const ub = usesOf(all, b.id)
      const ma = usesOf(month, a.id)
      const mb = usesOf(month, b.id)
      const monthWords =
        ma.uses + mb.uses === 0
          ? ` Este mes ninguna de las dos se usó${ended(a) && ended(b) ? ": ya terminaron" : ""}.`
          : ` Este mes: «${a.name}», ${plural(ma.uses, "vez", "veces")}; «${b.name}», ${plural(mb.uses, "vez", "veces")}.`
      const ra = reportOf(a.name)
      const rb = reportOf(b.name)
      return {
        respuesta:
          ua.uses === ub.uses
            ? `Las dos se usaron lo mismo: ${plural(ua.uses, "vez", "veces")} cada una («${a.name}», vigente ${span(a)}; «${b.name}», ${span(b)}).${monthWords}`
            : `Se usó más «${a.name}»: ${plural(ua.uses, "vez", "veces")} (${plural(ua.people, "persona", "personas")}) mientras estuvo vigente, ${span(a)}, contra ${plural(ub.uses, "vez", "veces")} (${plural(ub.people, "persona", "personas")}) de «${b.name}», ${span(b)}.${monthWords}`,
        criterio:
          "Usos de cada promoción como los cuenta Reportes › Finanzas › Promociones (un presupuesto entregado que la lleva en la opción que vale o un cobro suelto con ella), desde que empezó la primera de las dos hasta hoy: las dos ya terminaron, así que el mes en curso no las compara.",
        nota: `Por lo que pagaron después quienes la usaron (Reportes › Promociones, en el mismo tramo): «${a.name}», ${money(ra?.collectedCents ?? 0)} (${ra?.fresh ?? 0} pacientes nuevos); «${b.name}», ${money(rb?.collectedCents ?? 0)} (${rb?.fresh ?? 0} nuevos).`,
        datos: { desde: since, usos: { [a.name]: ua, [b.name]: ub }, mes: { [a.name]: ma, [b.name]: mb }, reportes: report.promotions },
      }
    },

    x34: async () => {
      const month = await h.fig("canceladas")
      const year12 = await h.fig("canceladas", "total", w.lastYear)
      const bySede = await h.fig("canceladas", "sede")
      const [links] = await tx.execute<{ count: number }>(sql`
        select count(distinct t.appointment_id)::int as count from automation_link_token t
        join appointment a on a.organization_id = t.organization_id and a.id = t.appointment_id and a.status = 'cancelada'
        where t.organization_id = ${org} and t.purpose = 'cancel' and t.used_at is not null
          and a.starts_at >= ${new Date(h.now.getTime() - 365 * DAY_MS).toISOString()}::timestamptz`)
      const ofWords = (value: { part?: number; whole?: number } | null | undefined) => `${value?.part ?? 0} de ${value?.whole ?? 0}`
      return {
        respuesta: `No lo sé: odentIA no guarda quién canceló cada cita (ni el motivo), así que no puedo separar las que cancelan los pacientes de las que cancelan ustedes. Lo registrado: ${days.current} se cancelaron ${plural(month.total.part ?? 0, "cita", "citas")}, el ${show(month)} de las que ya pasaron (${ofWords(month.total)}); ${days.previous}, el ${show(month, month.previous?.value ?? null)} (${ofWords(month.previous)}).`,
        criterio:
          "Trampa: la cita no guarda quién la canceló ni por qué (`appointment` solo tiene su estado). Se ofrece «Canceladas» de Reportes del mes en curso contra los mismos días del anterior; lo único que dice quién canceló es el enlace «cancelar» del recordatorio, que se cuenta en la nota.",
        nota: `Solo se sabe cuando la persona cancela desde el enlace de su recordatorio: en los últimos 12 meses, ${plural(links?.count ?? 0, "cita", "citas")}. Por sede este mes: ${listOf(bySede.rows.filter((row) => (row.value.whole ?? 0) > 0).map((row) => ({ name: row.label, value: `${show(bySede, row.value.value)}, ${ofWords(row.value)}` })))}. En los últimos 365 días: ${show(year12)} (${ofWords(year12.total)}).`,
        datos: { mes: month.total, anterior: month.previous, doceMeses: year12.total, porSede: bySede.rows, canceladasPorEnlace: links?.count ?? 0 },
      }
    },

    x35: async () => {
      const where = sql`and translate(lower(pr.name), 'áéíóúü', 'aeiouu') ~ 'cepillo|enjuague'`
      const paid = [...(await paidProducts(h.monthStart, nowIso, where))]
      const loaded = [...(await chargedProducts(h.monthStart, nowIso, where))]
      const before = [...(await paidProducts(window.previous.start.toISOString(), window.previous.end.toISOString(), where))]
      const catalog = await tx.execute<{ name: string; forSale: boolean }>(sql`
        select name, for_sale as "forSale" from product where organization_id = ${org} and is_active
          and translate(lower(name), 'áéíóúü', 'aeiouu') ~ 'cepillo|enjuague' order by name`)
      const total = sumOf(paid, (row) => row.cents)
      return {
        respuesta: paid.length
          ? `${ThisMonth} vendiste ${money(total)} en cepillos y enjuagues: ${productWords(paid)}.`
          : `${ThisMonth} no se vendió ningún cepillo ni enjuague${catalog.length ? ` (tus productos son ${catalog.map((row) => row.name).join(" y ")})` : ""}.`,
        criterio: "Lo vendido: pagos vigentes del mes en curso aplicados a cargos sin anular de los productos con cepillo o enjuague en el nombre, con sus unidades.",
        nota: `Contando lo cargado este mes aunque no se haya pagado: ${productWords(loaded) || "nada"}. En ${days.sameAs}: ${money(sumOf(before, (row) => row.cents))}${before.length ? ` (${productWords(before)})` : ""}.`,
        datos: { pagado: paid, cargado: loaded, mismosDiasMesAnterior: before, productos: catalog },
      }
    },

    x36: async () => {
      const sunday = addDays(monday, 6)
      const blocks = await blocksIn(startOf(monday), startOf(addDays(monday, 7)))
      const absent = blocks.filter((block) => block.dentistId !== null)
      const closed = blocks.filter((block) => block.dentistId === null && block.chair === null)
      const chairs = blocks.filter((block) => block.dentistId === null && block.chair !== null)
      const next = (await blocksIn(startOf(addDays(monday, 7)), startOf(addDays(monday, 14)))).filter((block) => block.dentistId !== null)
      const nowMs = h.now.getTime()
      const when = (block: Block) => `${blockWhen(block)}${block.endMs <= nowMs ? ", ya pasó" : block.startMs <= nowMs ? ", ahora" : ""}`
      const passed = absent.filter((block) => block.startMs < nowMs)
      const closedWords = closed.map((block) => `la ${block.branch} cierra ${blockWhen(block)} (${blockWhy(block)})`).join("; ")
      return {
        respuesta: absent.length
          ? `Esta semana (${spanWords(monday, sunday)}) ${absent.length === 1 ? "solo hay una ausencia" : `hay ${absent.length} ausencias`}: ${listOf(absent.map((block) => ({ name: `${whoIs(block.dentist)} ${when(block)}`, value: blockWhy(block) })))}. El resto del equipo tiene su horario de siempre.${closed.length ? ` Además, ${closedWords}.` : ""}`
          : `Esta semana (${spanWords(monday, sunday)}) nadie del equipo tiene una ausencia registrada: todos tienen su horario de siempre.${closed.length ? ` Pero ${closedWords}.` : ""}`,
        criterio:
          "Ausencias de profesionales (bloqueos de la agenda con profesional) que tocan esta semana, de lunes a domingo, con los días y horas de su sede; aparte, los cierres de sede y las unidades dentales bloqueadas.",
        nota: `Contando solo de lunes a ahora: ${passed.length ? listOf(passed.map((block) => ({ name: whoIs(block.dentist), value: blockWhy(block) }))) : "nadie faltó"}. La próxima semana: ${next.length ? listOf(next.map((block) => ({ name: `${whoIs(block.dentist)} ${blockWhen(block)}`, value: blockWhy(block) }))) : "ninguna ausencia registrada"}.${chairs.length ? ` Unidades dentales bloqueadas esta semana: ${chairs.map((block) => `${block.chair} de la ${block.branch} ${blockWhen(block)} (${blockWhy(block)})`).join("; ")}.` : ""}`,
        datos: { semana: { desde: monday, hasta: sunday }, ausencias: absent, cierres: closed, unidades: chairs, proximaSemana: next },
      }
    },

    x37: async () => {
      const tasks = await tx.execute<{ title: string; due: string; assignee: string | null; area: string | null }>(sql`
        select t.title, to_char(t.due_at at time zone ${tz}, 'YYYY-MM-DD HH24:MI') as due, u.name as assignee, t.area
        from task t left join "user" u on u.id = t.assignee_user_id
        where t.organization_id = ${org} and t.status = 'open' and t.due_at is not null and t.due_at <= ${nowIso}::timestamptz
        order by t.due_at, t.title`)
      const [open] = await tx.execute<{ open: number; later: number; undated: number }>(sql`
        select count(*)::int as open,
          count(*) filter (where t.due_at > ${nowIso}::timestamptz and (t.due_at at time zone ${tz})::date = ${today}::date)::int as later,
          count(*) filter (where t.due_at is null)::int as undated
        from task t where t.organization_id = ${org} and t.status = 'open'`)
      type Overdue = { title: string; due: string; assignee: string | null; area: string | null }
      const whom = (task: Overdue) => (task.assignee ? whoIs(task.assignee) : `${AREA_WORDS[task.area ?? ""] ?? "nadie"} (sin responsable)`)
      const groups = new Map<string, Overdue[]>()
      for (const task of [...tasks] as Overdue[]) groups.set(whom(task), [...(groups.get(whom(task)) ?? []), task])
      const since = (due: string) => {
        const [day, time] = due.split(" ") as [string, string]
        return `desde el ${w.dayWords(day)} a las ${time}`
      }
      return {
        respuesta: tasks.length
          ? `El equipo tiene ${plural(tasks.length, "tarea vencida", "tareas vencidas")}: ${[...groups].map(([name, list]) => `${name}, ${list.map((task) => `«${task.title}» (${since(task.due)})`).join(" y ")}`).join("; ")}.`
          : "El equipo no tiene tareas vencidas.",
        criterio: "Tareas abiertas con vencimiento ya pasado, a ahora, de toda la clínica (como g085); a quien tiene de responsable o, sin responsable, al área a la que van.",
        nota: `Tareas abiertas en total: ${open?.open ?? 0}; ${plural(open?.later ?? 0, "vence", "vencen")} más tarde hoy y ${plural(open?.undated ?? 0, "no tiene", "no tienen")} fecha.`,
        datos: { vencidas: tasks, abiertas: open?.open ?? 0, vencenHoy: open?.later ?? 0, sinFecha: open?.undated ?? 0 },
      }
    },

    x38: async () => {
      const december = { year, month: 12 }
      const start = dayStart(tz, year, 12, 1)
      const end = dayStart(tz, year + 1, 1, 1)
      const [booked] = await tx.execute<{ total: number; confirmed: number }>(sql`
        select count(*)::int as total, count(*) filter (where a.status = 'confirmada')::int as confirmed from appointment a
        where a.organization_id = ${org} and a.status in ('programada','confirmada') and ${between(sql`a.starts_at`, start, end)}`)
      const coming = await upcomingWork(tx, org, currency, h.now)
      const lastDecember = await h.fig("cobrado", "total", `${year - 1}-12`)
      const months = await h.fig("cobrado", "mes", "mes_pasado")
      const current = await h.fig("cobrado")
      const recent = months.months.filter((month) => !month.partial).slice(-3)
      const average = recent.length ? recent.reduce((sum, month) => sum + (month.value.value ?? 0), 0) / recent.length : 0
      const owed = await h.fig("te_deben")
      return {
        respuesta: `${NO_INVOICES}, y no puedo decirte cuánto vas a cobrar en ${monthLabel(h, december)}: odentIA no hace proyecciones. Lo registrado: en los últimos 3 meses completos cobraste en promedio ${money(Math.round(average))} al mes (${listOf(recent.map((month) => ({ name: monthLabel(h, month.month, false), value: show(months, month.value.value) })))}) y ${thisMonth} vas ${show(current)}. En ${monthLabel(h, { year: year - 1, month: 12 })} se cobró ${show(lastDecember)}. Para ${monthLabel(h, december, false)} ${booked?.total ? `ya hay ${plural(booked.total, "cita agendada", "citas agendadas")}` : "todavía no hay ninguna cita agendada"}.`,
        criterio:
          "Trampa: es una predicción. Se ofrecen lo cobrado de Reportes en los últimos 3 meses completos y en el mes en curso, lo cobrado en diciembre del año pasado y las citas ya agendadas para diciembre.",
        nota: `Lo aceptado en presupuestos que falta hacer («Lo que viene» de Reportes) vale ${money(coming.cents)} de ${plural(coming.patients, "paciente", "pacientes")}, sin fecha de cobro. Hoy te deben ${show(owed)}.`,
        datos: { citasDiciembre: booked ?? null, loQueViene: coming, diciembrePasado: lastDecember.total, ultimos3: recent, mes: current.total, teDeben: owed.total },
      }
    },

    x39: async () => {
      const current = await h.fig("cobrado", "mes")
      const previousYear = await h.fig("cobrado", "mes", `${year - 1}-01-01..${year - 1}-12-31`)
      const total = await h.fig("cobrado", "total", "este_ano")
      const months = current.months.filter((month) => month.month.year === year)
      const partial = months.find((month) => month.partial)
      // El mes en curso, contra sus mismos días del año anterior hasta la misma hora (el fin del tramo anterior de «Este año»).
      const yearBefore = (await reportScope(tx, org, { period: "este_ano" }, h.now)).window.previous.end
      const [sameDaysList] = partial
        ? await collectedNetMany(tx, org, [{ start: dayStart(tz, year - 1, partial.month.month, 1), end: yearBefore }])
        : [undefined]
      const sameDays = sameDaysList?.find((item) => item.currency === currency)?.cents ?? 0
      const lastOf = (month: number) => previousYear.months.find((item) => item.month.month === month)?.value.value ?? 0
      const rows = months.map((month) => {
        const value = month.value.value ?? 0
        const before = month.partial ? sameDays : lastOf(month.month.month)
        const change = changePct(value, before)
        return {
          name: `${monthLabel(h, month.month, false)}${month.partial ? " hasta hoy" : ""}`,
          value: `${money(value)} contra ${money(before)}${month.partial ? ` de los mismos días de ${year - 1}` : ""}${change ? `, ${change}` : ""}`,
        }
      })
      const value = total.total.value ?? 0
      const before = total.previous?.value ?? 0
      const fullLast = previousYear.months.reduce((sum, month) => sum + (month.value.value ?? 0), 0)
      return {
        respuesta: `Lo cobrado mes a mes, ${year} contra ${year - 1}: ${listOf(rows)}. En lo que va de ${year}, ${show(total)} contra ${show(total, before)} en los mismos días de ${year - 1} (${changePct(value, before) ?? "sin dato"}).`,
        criterio:
          "«Lo cobrado» de Reportes por mes (pagos menos anulaciones y devoluciones) de enero al mes en curso, contra el mismo mes del año anterior; el mes en curso, contra sus mismos días del año anterior. «Ingresos» es lo cobrado.",
        nota: `${partial ? `${capital(monthLabel(h, { year: year - 1, month: partial.month.month }))} completo: ${money(lastOf(partial.month.month))}. ` : ""}Todo ${year - 1}, de enero a diciembre: ${money(fullLast)}.`,
        datos: { meses: months, anoAnterior: previousYear.months, total: total.total, totalAnterior: total.previous, mismosDias: partial ? sameDays : null },
      }
    },

    x40: async () => {
      const list = await branches()
      const rows: Array<{ name: string; cents: number; total: number; count: number; label: string | null }> = []
      for (const branch of list) {
        const result = await figIn("cobrado", "medio", "este_mes", branch.id)
        const card = result.rows.find((row) => /tarjeta/i.test(row.label))
        const [paid] = await tx.execute<{ count: number }>(sql`
          select count(*)::int as count from patient_payment p
          where p.organization_id = ${org} and p.branch_id = ${branch.id} and p.currency = ${currency} and p.method_name ilike '%tarjeta%'
            and p.paid_at >= ${h.monthStart}::timestamptz and p.paid_at < ${nowIso}::timestamptz and (p.voided_at is null or p.voided_at >= ${nowIso}::timestamptz)`)
        rows.push({ name: branch.name, cents: card?.value.value ?? 0, total: result.total.value ?? 0, count: paid?.count ?? 0, label: card?.label ?? null })
      }
      const sorted = [...rows].sort((a, b) => b.cents - a.cents || b.count - a.count)
      const top = sorted[0]
      const withCard = sorted.filter((row) => row.cents !== 0)
      const without = sorted.filter((row) => row.cents === 0)
      const share = [...withCard].sort((a, b) => b.cents / Math.max(1, b.total) - a.cents / Math.max(1, a.total))
      const yearRows: Array<{ name: string; cents: number }> = []
      for (const branch of list) {
        const result = await figIn("cobrado", "medio", w.lastYear, branch.id)
        yearRows.push({ name: branch.name, cents: result.rows.find((row) => /tarjeta/i.test(row.label))?.value.value ?? 0 })
      }
      return {
        respuesta:
          top && top.cents > 0
            ? `${ThisMonth} se paga más con tarjeta en la ${top.name}: ${money(top.cents)} en ${plural(top.count, "pago", "pagos")}, el ${pct(top.cents, top.total)} de lo que cobró la sede.${withCard.length > 1 ? ` Le sigue ${listOf(withCard.slice(1).map((row) => ({ name: `la ${row.name}`, value: `${money(row.cents)}, ${plural(row.count, "pago", "pagos")}, ${pct(row.cents, row.total)}` })))}.` : ""}${without.length ? ` En ${without.map((row) => `la ${row.name}`).join(" y ")} no hay pagos con tarjeta${without.every((row) => row.total === 0) ? " (no tiene ningún cobro este mes)" : ""}.` : ""}`
            : `${ThisMonth} no hay pagos con tarjeta en ninguna sede.`,
        criterio: "«Lo cobrado» de Reportes por medio de pago con cada sede elegida, fila Tarjeta, del mes en curso (pagos menos anulaciones y devoluciones), por importe.",
        nota: `Por la parte de lo cobrado en cada sede que fue con tarjeta: ${listOf(share.map((row) => ({ name: row.name, value: pct(row.cents, row.total) })))}. En los últimos 365 días, con tarjeta: ${listOf(yearRows.map((row) => ({ name: row.name, value: money(row.cents) })))}.`,
        datos: { sedes: rows, doceMeses: yearRows },
      }
    },

    x41: async () => {
      const tomorrow = addDays(today, 1)
      const firstTime = sql`not exists (select 1 from appointment x where x.organization_id = a.organization_id and x.patient_id = a.patient_id
        and x.status = 'atendida' and x.starts_at < a.starts_at)`
      const rows = await tx.execute<{ time: string; patient: string; dentist: string; branch: string; status: string; fresh: boolean }>(sql`
        select to_char(a.starts_at at time zone ${tz}, 'HH24:MI') as time, pp.display_name as patient, u.name as dentist, b.name as branch, a.status, ${firstTime} as fresh
        from appointment a
        join "user" u on u.id = a.dentist_user_id
        join branch b on b.organization_id = a.organization_id and b.id = a.branch_id
        ${h.joinPerson(sql`a.patient_id`)}
        where a.organization_id = ${org} and ${h.dayOf(sql`a.starts_at`)} = ${h.today} + 1
        order by a.starts_at`)
      const active = rows.filter((row) => row.status === "programada" || row.status === "confirmada")
      const fresh = active.filter((row) => row.fresh)
      const [next] = await tx.execute<{ day: string | null; total: number }>(sql`
        with f as (select ${h.dayOf(sql`a.starts_at`)} as day from appointment a
          where a.organization_id = ${org} and a.status in ('programada','confirmada') and ${h.dayOf(sql`a.starts_at`)} > ${h.today} + 1 and ${firstTime})
        select to_char(min(day), 'YYYY-MM-DD') as day, count(*) filter (where day = (select min(day) from f))::int as total from f`)
      const [last] = await tx.execute<{ day: string | null; patient: string | null }>(sql`
        select to_char(a.starts_at at time zone ${tz}, 'YYYY-MM-DD') as day, pp.display_name as patient
        from appointment a ${h.joinPerson(sql`a.patient_id`)}
        where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz and ${firstTime}
        order by a.starts_at desc limit 1`)
      const week = await h.fig("pacientes_nuevos", "total", `${monday}..${today}`)
      const month = await h.fig("pacientes_nuevos")
      return {
        respuesta: fresh.length
          ? `Mañana (${w.dayWords(tomorrow)}) ${fresh.length === 1 ? "viene 1 paciente" : `vienen ${fresh.length} pacientes`} por primera vez: ${listOf(fresh.map((row) => ({ name: `${row.time}, ${row.patient}`, value: `${row.dentist}, ${row.branch}` })))}.`
          : `Mañana (${w.dayWords(tomorrow)}) no viene nadie por primera vez: ${active.length ? `las ${plural(active.length, "cita", "citas")} son de pacientes que ya se atendieron antes` : "no hay ninguna cita agendada para mañana"}.${next?.day ? ` La próxima cita de primera vez es el ${w.dayWords(next.day)} (${next.total}).` : " Tampoco hay citas de primera vez agendadas para después."}${last?.day ? ` El último paciente que vino por primera vez fue ${last.patient}, el ${w.dayWords(last.day)}.` : ""}`,
        criterio: "Citas de mañana (día de la clínica) programadas o confirmadas de pacientes sin ninguna cita atendida antes: su primera vez.",
        nota: `«Pacientes nuevos» de Reportes (su primera cita atendida): ${week.total.value ?? 0} esta semana (${spanWords(monday, today)}) y ${month.total.value ?? 0} en lo que va del mes.`,
        datos: { manana: tomorrow, citas: rows, primeraVez: fresh, siguiente: next ?? null, ultima: last ?? null, nuevosSemana: week.total, nuevosMes: month.total },
      }
    },

    x42: async () => {
      const rows = await tx.execute<{ patientId: string; person: string; owed: string; since: string }>(sql`
        ${overdueDebtSql(org, [h.now], 7)}
        select o.patient_id as "patientId", pp.display_name as person, o.owed::text as owed, ${isoOf(sql`o.since`)} as since
        from overdue o ${h.joinPerson(sql`o.patient_id`)}
        where o.currency = ${currency}
        order by o.owed desc, pp.display_name`)
      const [loose] = await tx.execute<{ charges: number; people: number; cents: string }>(sql`
        select count(*)::int as charges, count(distinct c.patient_id)::int as people, coalesce(sum(c.amount_cents - coalesce(ap.applied, 0)), 0)::text as cents
        from patient_charge c
        left join lateral (select sum(a.amount_cents) as applied from patient_payment_application a
          where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null) ap on true
        where c.organization_id = ${org} and c.voided_at is null and c.currency = ${currency}
          and c.created_at < ${new Date(h.now.getTime() - 7 * DAY_MS).toISOString()}::timestamptz and c.amount_cents > coalesce(ap.applied, 0)`)
      const owed = await h.fig("te_deben")
      const overdue = await h.fig("deuda_vencida")
      const total = sumOf(rows, (row) => row.owed)
      const shown = rows.slice(0, 5)
      return {
        respuesta: rows.length
          ? `En odentIA no hay tickets sin pagar: el ticket de pago se emite al cobrar. Lo que sí hay es deuda: hoy ${plural(rows.length, "persona debe", "personas deben")} desde hace más de una semana, ${money(total)} en total, descontando lo que tienen a favor. Las que más deben: ${listOf(shown.map((row) => ({ name: row.person, value: `${money(Number(row.owed))}, desde el ${shortDate(row.since)}` })))}${rows.length > shown.length ? ` y ${rows.length - shown.length} más` : ""}.`
          : "En odentIA no hay tickets sin pagar (el ticket se emite al cobrar) y nadie debe nada desde hace más de una semana.",
        criterio:
          "Un ticket de pago es el comprobante de un cobro, siempre pagado: se lee como lo cargado sin pagar. La regla de «Te deben hace más de 30 días» de Reportes (`overdueDebtSql`) con 7 días: personas cuyo concepto sin pagar más antiguo se anotó hace más de 7 días, con lo que deben descontando lo que tienen a favor, a hoy.",
        nota: `Contando cada concepto anotado hace más de 7 días que sigue con saldo, sin descontar lo que tienen a favor: ${plural(loose?.charges ?? 0, "concepto", "conceptos")} de ${plural(loose?.people ?? 0, "persona", "personas")}, ${money(Number(loose?.cents ?? 0))}. En total hoy te deben ${show(owed)}; desde hace más de 30 días, ${show(overdue)}.`,
        datos: { deudores: rows.length, deuda: total, lista: rows.slice(0, 20), conceptos: loose ?? null, teDeben: owed.total, vencida: overdue.total },
      }
    },

    x43: async () => {
      const result = await h.fig("sin_venir")
      const lapsed = await getPatientReportList(tx, org, { period: "este_mes", list: "lapsed", limit: 5000 }, h.now)
      const recent = [...lapsed.rows].sort((a, b) => b.at.localeCompare(a.at))
      const unbooked = await getReportList(tx, org, { period: "este_mes", list: "upcoming_unbooked", limit: 5000 }, h.now)
      return {
        respuesta: `No te puedo recomendar qué hacer: odentIA no da consejos. Lo registrado: hoy ${show(result)} pacientes dejaron de venir (su última cita atendida fue hace más de 6 meses y no tienen cita, presupuesto esperando respuesta ni control pendiente). Los que se fueron más recientemente: ${listOf(recent.slice(0, 5).map((row) => ({ name: row.personName, value: `última cita el ${shortDate(row.at)}` })))}.`,
        criterio:
          "Trampa: es un consejo. Se ofrece «Sin venir hace más de 6 meses» de Reportes, a hoy, con su lista ordenada de la última cita más reciente a la más antigua.",
        nota: `Además, ${plural(unbooked.total, "paciente tiene", "pacientes tienen")} tratamientos aceptados por hacer y ninguna cita por venir («Aceptaron y no tienen cita» de Reportes).`,
        datos: { sinVenir: result.total, lista: recent.slice(0, 10).map((row) => ({ name: row.personName, at: row.at })), aceptadoSinCita: unbooked.total },
      }
    },

    x44: async () => {
      const ana = await userNamed("%ana torres%")
      const yearStart = startOf(`${year}-01-01`).toISOString()
      const crown = sql`coalesce(s.name, ep.description) ilike 'corona cer%'`
      const doneBy = (start: string, where: SQL) =>
        tx.execute<{ name: string; times: number; patients: number }>(sql`
          select coalesce(u.name, 'Sin profesional') as name, coalesce(sum(ep.quantity), 0)::int as times, count(distinct e.patient_id)::int as patients
          from encounter_procedure ep
          join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
          left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
          left join "user" u on u.id = e.dentist_user_id
          where ep.organization_id = ${org} and ep.voided_at is null and e.started_at >= ${start}::timestamptz and e.started_at < ${nowIso}::timestamptz and ${where}
          group by 1 order by 2 desc, 1`)
      if (!ana) return { respuesta: "No hay nadie llamado Ana Torres en el equipo.", criterio: "Miembros de la clínica por nombre.", datos: {} }
      const team = [...(await doneBy(yearStart, crown))]
      const mine = team.find((row) => row.name === ana.name) ?? { name: ana.name, times: 0, patients: 0 }
      const month = (await doneBy(h.monthStart, sql`${crown} and e.dentist_user_id = ${ana.id}`))[0]?.times ?? 0
      const otherCrowns = [
        ...(await tx.execute<{ name: string; times: number }>(sql`
          select coalesce(s.name, ep.description) as name, sum(ep.quantity)::int as times
          from encounter_procedure ep
          join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
          left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
          where ep.organization_id = ${org} and ep.voided_at is null and e.dentist_user_id = ${ana.id}
            and e.started_at >= ${yearStart}::timestamptz and e.started_at < ${nowIso}::timestamptz
            and coalesce(s.name, ep.description) ilike '%corona%' and not (${crown})
          group by 1 order by 2 desc, 1`)),
      ]
      return {
        respuesta: mine.times
          ? `En lo que va de ${year} (del 1 de enero al ${dateWords(h.now)}) hiciste ${plural(mine.times, "corona cerámica", "coronas cerámicas")}, a ${plural(mine.patients, "paciente", "pacientes")}.`
          : `En lo que va de ${year} no hiciste ninguna corona cerámica.`,
        criterio: "Procedimientos sin anular de «Corona cerámica» en atenciones firmadas de la Dra. Ana Torres (quien pregunta), del 1 de enero a hoy (por el día de la atención), contando su cantidad.",
        nota: `Todo el equipo en ese tiempo: ${listOf(team.map((row) => ({ name: row.name, value: `${row.times}` })))}. ${capital(thisMonth)}: ${month}. Otras coronas que hiciste este año (de porcelana, metal-cerámica…): ${otherCrowns.length ? listOf(otherCrowns.map((row) => ({ name: row.name, value: `${row.times}` }))) : "ninguna"}.`,
        datos: { profesional: ana, ano: mine, equipo: team, mes: month, otrasCoronas: otherCrowns },
      }
    },

    x45: async () => {
      const specialtyJoins = sql`
        left join treatment_budget_item bi on bi.organization_id = c.organization_id and bi.id = c.budget_item_id
        left join service_catalog sx on sx.organization_id = c.organization_id and sx.id = coalesce(ep.service_id, bi.service_id, pi.service_id)
        left join org_specialty os on os.organization_id = c.organization_id and os.id = sx.specialty_id`
      const ortho = sql`(os.key ilike 'ortodon%' or ${h.conceptName} ilike '%ortodon%' or ${h.conceptName} ilike '%bracket%')`
      const rows = [
        ...(await tx.execute<{ patientId: string; person: string; charges: number; owed: string; names: string }>(sql`
          select c.patient_id as "patientId", pp.display_name as person, count(*)::int as charges,
            sum(c.amount_cents - coalesce(ap.applied, 0))::text as owed, string_agg(distinct ${h.conceptName}, ', ') as names
          from patient_charge c ${h.conceptJoins} ${specialtyJoins}
          left join lateral (select sum(a.amount_cents) as applied from patient_payment_application a
            where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null) ap on true
          ${h.joinPerson(sql`c.patient_id`)}
          where c.organization_id = ${org} and c.voided_at is null and c.currency = ${currency} and c.amount_cents > coalesce(ap.applied, 0) and ${ortho}
          group by c.patient_id, pp.display_name order by sum(c.amount_cents - coalesce(ap.applied, 0)) desc, 2`)),
      ]
      const total = sumOf(rows, (row) => row.owed)
      const charges = sumOf(rows, (row) => row.charges)
      const ids = new Set(rows.map((row) => row.patientId))
      const theirs = (await debtors()).filter((row) => !!row.patientId && ids.has(row.patientId))
      const owed = await h.fig("te_deben")
      const names = [...new Set(rows.flatMap((row) => row.names.split(", ")))]
      return {
        respuesta: rows.length
          ? `Hoy los pacientes deben ${money(total)} de ortodoncia: ${plural(rows.length, "persona tiene", "personas tienen")} ${plural(charges, "concepto", "conceptos")} de ortodoncia sin pagar (${names.join(", ")}). Los que más deben: ${listOf(rows.slice(0, 5).map((row) => ({ name: row.person, value: money(Number(row.owed)) })))}.`
          : "Hoy nadie debe nada de ortodoncia.",
        criterio:
          "Lo que falta pagar de cada concepto de ortodoncia sin anular (servicio de la especialidad Ortodoncia, o «ortodoncia» o «bracket» en su nombre): su importe menos lo aplicado de pagos vigentes, a hoy.",
        nota: `Si «lo que deben» es todo lo que deben esas personas (también de otros tratamientos), descontando lo que tienen a favor, como «Te deben»: ${money(sumOf(theirs, (row) => row.cents))} de ${plural(theirs.length, "persona", "personas")}. En toda la clínica te deben ${show(owed)}.`,
        datos: { personas: rows.length, conceptos: charges, deuda: total, lista: rows.slice(0, 20), comoTeDeben: { personas: theirs.length, cents: sumOf(theirs, (row) => row.cents) }, teDeben: owed.total },
      }
    },

    x46: async () => {
      // El título del código en la lista de diagnósticos de la clínica (CIE-10 o CIE-11): ahí dice si es una periodontitis.
      const diagnoses = [
        ...(await tx.execute<{ patientId: string; person: string; codes: string; titles: string | null; count: number; active: number; encounters: number }>(sql`
          select d.patient_id as "patientId", pp.display_name as person, string_agg(distinct d.diagnosis_system || ' ' || d.diagnosis_code, ', ') as codes,
            string_agg(distinct t.title, ', ') as titles,
            count(*)::int as count, count(*) filter (where d.status = 'activo')::int as active, count(distinct d.encounter_id)::int as encounters
          from encounter_diagnosis d
          join encounter e on e.organization_id = d.organization_id and e.id = d.encounter_id and e.voided_at is null
          join lateral (select dc.title from catalog.diagnosis_code dc where dc.system_key = d.diagnosis_system and dc.code = d.diagnosis_code
            order by dc.edition desc limit 1) t on true
          ${h.joinPerson(sql`d.patient_id`)}
          where d.organization_id = ${org} and d.voided_at is null and translate(lower(t.title), 'áéíóú', 'aeiou') like '%periodontitis%'
          group by d.patient_id, pp.display_name order by 2`)),
      ]
      const charts = [
        ...(await tx.execute<{ patientId: string; person: string; stage: number | null; grade: string | null; extent: string | null; status: string | null; at: string }>(sql`
          select distinct on (c.patient_id) c.patient_id as "patientId", pp.display_name as person, c.stage, c.grade, c.extent,
            c.periodontitis_status as status, ${isoOf(sql`coalesce(c.classified_at, c.created_at)`)} as at
          from periodontal_chart c ${h.joinPerson(sql`c.patient_id`)}
          where c.organization_id = ${org} and c.diagnosis = 'periodontitis'
          order by c.patient_id, coalesce(c.classified_at, c.created_at) desc`)),
      ]
      const [context] = await tx.execute<{ diagnosed: number; charted: number }>(sql`
        select (select count(distinct patient_id) from encounter_diagnosis where organization_id = ${org} and voided_at is null)::int as diagnosed,
          (select count(distinct patient_id) from periodontal_chart where organization_id = ${org})::int as charted`)
      const people = new Map<string, string>()
      for (const row of [...diagnoses, ...charts]) people.set(row.patientId, row.person)
      const chartWords = (row: (typeof charts)[number]) =>
        `periodontograma clasificado como periodontitis estadio ${STAGE_WORDS[row.stage ?? 0] ?? ""}, grado ${row.grade ?? "—"}${row.extent ? `, ${EXTENT_WORDS[row.extent] ?? row.extent}` : ""}${row.status ? `, ${PERIO_STATUS_WORDS[row.status] ?? row.status}` : ""} (${dateWords(row.at, true)})`
      const words = [...people].map(([id, person]) => {
        const diagnosis = diagnoses.find((row) => row.patientId === id)
        const chart = charts.find((row) => row.patientId === id)
        const parts = [
          diagnosis ? `diagnóstico de ${lower(diagnosis.titles ?? "periodontitis")}, ${diagnosis.codes.replace(/\bICD-/g, "CIE-")}, en ${plural(diagnosis.encounters, "atención", "atenciones")}` : null,
          chart ? chartWords(chart) : null,
        ].filter(Boolean)
        return `${person}, con ${parts.join(", y su ")}`
      })
      // Argos no lee la historia clínica (ADR 0075): lo correcto es decir que eso no lo puede consultar, sin decir que
      // odentIA no lo registra ni dar una cifra. Lo que hay en las fichas va en la nota, para quien califica.
      return {
        respuesta:
          "Eso no lo puedo consultar: los diagnósticos están en la historia clínica de cada paciente, que Argos no lee. Se ven en la ficha de cada paciente.",
        criterio:
          "Trampa: Argos no lee la historia clínica (ADR 0075). Está bien si dice que no puede consultarlo; está mal si dice que odentIA no registra diagnósticos (sí los guarda) o si da una cifra de pacientes con periodontitis.",
        nota: `En las fichas: ${people.size ? `${people.size === 1 ? "1 paciente tiene" : `${people.size} pacientes tienen`} periodontitis registrada: ${words.join(". ")}` : "ningún paciente tiene periodontitis registrada"}. Pacientes con algún diagnóstico registrado: ${context?.diagnosed ?? 0}; con periodontograma: ${context?.charted ?? 0}.`,
        datos: { pacientes: people.size, diagnosticos: diagnoses, periodontogramas: charts, contexto: context ?? null },
      }
    },

    x47: async () => {
      const all = await branches()
      const surco = all.find((branch) => /surco/i.test(branch.name)) ?? null
      const facts = surco ? await branchFacts(surco.id) : null
      const hourly = async (branchId: string) => {
        const report = await getAgendaReport(tx, org, { period: "este_mes", branchId }, h.now)
        const byHour = new Map<number, { avail: number; occ: number }>()
        for (const slot of report.map.week) {
          const entry = byHour.get(slot.hour) ?? { avail: 0, occ: 0 }
          entry.avail += slot.availMin
          entry.occ += slot.occMin
          byHour.set(slot.hour, entry)
        }
        return [...byHour]
          .filter(([, entry]) => entry.avail > 0)
          .map(([hour, entry]) => ({ hour, avail: entry.avail, occ: entry.occ }))
          .sort((a, b) => b.occ / b.avail - a.occ / a.avail || b.occ - a.occ || a.hour - b.hour)
      }
      const hourWords = (row: { hour: number; avail: number; occ: number }) => `de ${row.hour}:00 a ${row.hour + 1}:00, ${pct(row.occ, row.avail)} ocupada`
      const own = surco && facts && facts.schedules > 0 ? await hourly(surco.id) : []
      const others: Array<{ name: string; hours: Awaited<ReturnType<typeof hourly>> }> = []
      for (const branch of all.filter((item) => item.id !== surco?.id)) others.push({ name: branch.name, hours: await hourly(branch.id) })
      const othersWords = listOf(others.filter((row) => row.hours[0]).map((row) => ({ name: row.name, value: hourWords(row.hours[0] as (typeof row.hours)[number]) })))
      return {
        respuesta: !surco
          ? `No tienes una sede Surco. En tus sedes, ${thisMonth}, la hora más llena es: ${othersWords}.`
          : own[0]
            ? `${ThisMonth}, en la ${surco.name} la agenda se llena más ${hourWords(own[0])}. Le siguen ${listOf(own.slice(1, 3).map((row) => ({ name: `de ${row.hour}:00`, value: pct(row.occ, row.avail) })))}.`
            : `En la ${surco.name} no hay agenda que mirar: no tiene ${missingWords(facts ?? { schedules: 0, chairs: 0, appointments: 0 })} registrados. En tus otras sedes, ${thisMonth}, la hora más llena es: ${othersWords}.`,
        criterio:
          "La sede Surco (horarios de profesionales, unidades dentales y citas); con horario, la semana tipo de Reportes › Agenda del mes en curso por hora: minutos con citas no canceladas ÷ minutos de horario, sumando los días. Sin nada en Surco, lo mismo en las otras sedes.",
        nota: `Las tres horas más llenas de cada sede este mes: ${others.map((row) => `${row.name}, ${listOf(row.hours.slice(0, 3).map((item) => ({ name: `${item.hour}:00`, value: pct(item.occ, item.avail) })))}`).join("; ")}.`,
        datos: { sede: surco, hechos: facts, surco: own, otras: others.map((row) => ({ name: row.name, horas: row.hours.slice(0, 5) })) },
      }
    },

    x48: async () => {
      const products = [
        ...(await tx.execute<{ id: string; name: string; unit: string }>(sql`
          select id::text as id, name, unit from product
          where organization_id = ${org} and translate(lower(name || ' ' || coalesce(sku, '')), 'áéíóú', 'aeiou') ~ 'resina' and lower(name || ' ' || coalesce(sku, '')) ~ 'a2'
          order by name`)),
      ]
      if (!products.length) {
        return {
          respuesta: "No tienes resina A2 en el inventario: ningún producto se llama así, así que no hay compras registradas.",
          criterio: "Productos de Inventario con resina y A2 en el nombre o el código: ninguno.",
          datos: { productos: [] },
        }
      }
      const lines = [
        ...(await tx.execute<{ orderNumber: number; status: string; supplier: string; quantity: number; received: number; purchaseUnit: string | null; factor: number; unitCost: number; product: string; unit: string; arrived: string; ordered: string }>(sql`
          select o.order_number as "orderNumber", o.status, s.name as supplier, pl.quantity, pl.received_quantity as received,
            pl.purchase_unit as "purchaseUnit", pl.unit_factor as factor, pl.unit_cost_cents as "unitCost", pr.name as product, pr.unit,
            ${isoOf(sql`coalesce(r.last_at, o.created_at)`)} as arrived, ${isoOf(sql`o.created_at`)} as ordered
          from purchase_order_line pl
          join purchase_order o on o.organization_id = pl.organization_id and o.id = pl.order_id
          join supplier s on s.organization_id = o.organization_id and s.id = o.supplier_id
          join product pr on pr.organization_id = pl.organization_id and pr.id = pl.product_id
          left join lateral (
            select max(m.created_at) as last_at from stock_movement m
            where m.organization_id = pl.organization_id and m.purchase_order_id = o.id and m.product_id = pl.product_id and m.kind = 'ingreso'
          ) r on true
          where pl.organization_id = ${org} and o.currency = ${currency} and pl.product_id in (${sql.join(products.map((row) => sql`${row.id}::uuid`), sql`, `)})
          order by coalesce(r.last_at, o.created_at) desc, o.order_number desc`)),
      ]
      const received = lines.filter((line) => line.received > 0)
      const last = received[0]
      const previous = received[1]
      const pending = lines.filter((line) => ["confirmada", "parcialmente_recibida"].includes(line.status) && line.received < line.quantity)
      const unitWord = (line: (typeof lines)[number]) => (line.purchaseUnit && line.factor > 1 ? `${line.purchaseUnit} de ${unitsWord(line.factor, line.unit)}` : line.unit)
      const lineWords = (line: (typeof lines)[number]) =>
        `a ${money(line.unitCost)} ${line.purchaseUnit && line.factor > 1 ? `la ${unitWord(line)}` : `cada ${line.unit}`}, a ${line.supplier} (${purchaseOrderLabel(line.orderNumber)}, ${unitsWord(line.received, line.purchaseUnit && line.factor > 1 ? line.purchaseUnit : line.unit)}, llegó el ${dateWords(line.arrived, true)})`
      return {
        respuesta: last
          ? `La última vez que llegó ${last.product} la compraste ${lineWords(last)}.`
          : `No hay compras de ${products.map((row) => row.name).join(", ")} que hayan llegado.`,
        criterio:
          "La «Última compra» de Inventario del producto: la línea de compra recibida más reciente, por el día en que llegó (su ingreso al inventario), con su costo unitario y su proveedor.",
        nota: `${previous ? `La anterior: ${lineWords(previous)}. ` : ""}${pending.length ? `Pedida y todavía por llegar: ${pending.map((line) => `${purchaseOrderLabel(line.orderNumber)} a ${line.supplier}, ${unitsWord(line.quantity - line.received, line.unit)} a ${money(line.unitCost)} cada ${line.unit} (pedida el ${dateWords(line.ordered, true)})`).join("; ")}.` : "No hay pedidos por llegar."}`,
        datos: { productos: products, ultima: last ?? null, anterior: previous ?? null, porLlegar: pending },
      }
    },

    x49: async () => {
      const collected = await h.fig("cobrado")
      const attended = await h.fig("atendidas")
      const yearCollected = await h.fig("cobrado", "total", w.lastYear)
      const yearAttended = await h.fig("atendidas", "total", w.lastYear)
      const [own] = await tx.execute<{ encounters: number; cents: string }>(sql`
        select count(distinct e.id)::int as encounters, coalesce(sum(c.amount_cents), 0)::text as cents
        from encounter e
        left join encounter_procedure ep on ep.organization_id = e.organization_id and ep.encounter_id = e.id and ep.voided_at is null
        left join patient_charge c on c.organization_id = ep.organization_id and c.encounter_procedure_id = ep.id and c.voided_at is null
        where e.organization_id = ${org} and e.status = 'finalizada' and e.voided_at is null
          and e.started_at >= ${h.monthStart}::timestamptz and e.started_at < ${nowIso}::timestamptz`)
      const [payers] = await tx.execute<{ payers: number }>(sql`
        select count(distinct p.patient_id)::int as payers from patient_payment p
        where p.organization_id = ${org} and p.voided_at is null and p.currency = ${currency}
          and p.paid_at >= ${h.monthStart}::timestamptz and p.paid_at < ${nowIso}::timestamptz`)
      const cents = collected.total.value ?? 0
      const visits = attended.total.value ?? 0
      return {
        respuesta: visits
          ? `${ThisMonth} un paciente gasta en promedio ${per(cents, visits)} por visita: ${show(collected)} cobrados entre ${plural(visits, "cita atendida", "citas atendidas")}.`
          : `${ThisMonth} todavía no hay citas atendidas.`,
        criterio: "«Lo cobrado» de Reportes ÷ «Citas atendidas» de Reportes, del mes en curso (como el promedio por atención de una sede, g030).",
        nota: `Por lo cargado en cada atención firmada este mes (lo hecho en la visita, pagado o no): ${per(Number(own?.cents ?? 0), own?.encounters ?? 0)} (${money(Number(own?.cents ?? 0))} en ${plural(own?.encounters ?? 0, "atención", "atenciones")}). En los últimos 365 días: ${per(yearCollected.total.value ?? 0, yearAttended.total.value ?? 0)} por cita atendida. Por paciente que pagó este mes, no por visita: ${per(cents, payers?.payers ?? 0)}.`,
        datos: { cobrado: collected.total, atendidas: attended.total, cargado: own ?? null, doceMeses: { cobrado: yearCollected.total, atendidas: yearAttended.total }, pagaron: payers?.payers ?? 0 },
      }
    },

    x50: async () => {
      const waiting = [...(await budgets(awaits))]
      const implants = await tx.execute<{ id: string }>(sql`
        select distinct b.id from treatment_budget b
        join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id and i.option_id = ${budgetValueOptionSql(budgetRef)}
        left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
        where b.organization_id = ${org} and b.presented_at is not null and coalesce(s.name, i.title) ilike '%implant%'`)
      const implantIds = new Set(implants.map((row) => row.id))
      const cut = h.now.getTime() - 15 * DAY_MS
      const old = waiting.filter((row) => new Date(row.presented).getTime() < cut)
      const rows = old.filter((row) => implantIds.has(row.id))
      const catalog = await tx.execute<{ name: string }>(sql`
        select distinct name from service_catalog where organization_id = ${org} and is_active and name ilike '%implant%' order by 1`)
      const [ever] = await tx.execute<{ lines: number }>(sql`
        select count(*)::int as lines from treatment_budget_item i left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
        where i.organization_id = ${org} and coalesce(s.name, i.title) ilike '%implant%'`)
      const words = (list: Budget[]) => listOf(list.map((row) => ({ name: `${row.person} · N.º ${row.number}`, value: `desde el ${shortDate(row.presented)}, ${money(Number(row.pending))} sin decidir` })))
      return {
        respuesta: rows.length
          ? `Hoy ${plural(rows.length, "presupuesto de implantes lleva", "presupuestos de implantes llevan")} más de 15 días sin respuesta, por ${money(sumOf(rows, (row) => row.pending))} sin decidir: ${words(rows.slice(0, 5))}.`
          : `Ninguno: hoy no hay presupuestos de implantes esperando respuesta${(ever?.lines ?? 0) === 0 ? "; de hecho, todavía no se ha presupuestado ningún implante" : ""}${catalog.length ? ` (en tus servicios están ${catalog.map((row) => row.name).join(", ")})` : ""}. Lo que sí hay: ${plural(old.length, "presupuesto lleva", "presupuestos llevan")} más de 15 días esperando respuesta, de ${plural(new Set(old.map((row) => row.patientId)).size, "paciente", "pacientes")}, por ${money(sumOf(old, (row) => row.pending))} sin decidir.`,
        criterio:
          "Presupuestos que esperan respuesta a hoy (budgetAwaitsAnswer: enviado, «lo está pensando» o aceptado en parte con algo pendiente) con un tratamiento con «implante» en el nombre en la opción que vale, entregados hace más de 15 días; se suma lo aún no decidido.",
        nota: `${rows.length ? "" : `Los que esperan hace más: ${words(old.slice(0, 3))}. `}En total esperan respuesta ${waiting.length}; de ellos, ${old.filter((row) => row.status === "presentado").length} de los de más de 15 días no tienen ninguna respuesta (enviados) y ${old.filter((row) => row.status === "pospuesto").length} «lo están pensando».`,
        datos: { implantes: rows.map((row) => ({ numero: row.number, paciente: row.person, desde: row.presented })), masDe15Dias: old.length, esperan: waiting.length, catalogo: catalog.map((row) => row.name), cotizadosAlgunaVez: ever?.lines ?? 0 },
      }
    },
  }
}
