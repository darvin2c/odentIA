/**
 * Las respuestas correctas del segundo banco escrito a ciegas (`eval/argos-blind-2.json`),
 * parte 2: y26 a y50. Se calculan sobre las tablas y con las cifras de Reportes,
 * nunca con las vistas `argos` ni las cifras de Argos: así no heredan un error suyo.
 *
 * Las reglas son las de los bancos anteriores: sin periodo, el mes en curso hasta
 * ahora; un mes nombrado, el más reciente con ese nombre que ya empezó; «el año
 * pasado», de enero a diciembre; «los últimos N meses», meses completos; lo que
 * viene (la próxima semana, noviembre), ese periodo entero; lo pendiente y el
 * inventario, a hoy. Lo realizado es un procedimiento sin anular de una atención
 * firmada, contando su cantidad; lo vendido, lo pagado de lo cargado; lo de un
 * tratamiento puntual se suma sobre los pagos (la lista de Reportes por
 * tratamiento junta los menores en «Otros»). Quien pregunta es la dueña, la
 * Dra. Ana Torres: «yo» es ella. Las preguntas iguales a una ya resuelta (y39 =
 * x20, y41 = g134, y45 = x37) usan su mismo cálculo.
 */
import {
  addDays,
  budgetAwaitsAnswerSql,
  budgetLineUnitsSql,
  budgetValueOptionSql,
  channelWords,
  computeFigure,
  dayStart,
  type FigureGroup,
  type FigureResult,
  getReportPromotions,
  listProducts,
  type ProductListItem,
  PURCHASE_STATUS_WORDS,
  purchaseBalances,
  purchaseOrderLabel,
  reportScope,
  screenedSql,
  upcomingWork,
} from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import { blindSolvers1 } from "./blind-1.js"
import { blindSolvers2 } from "./blind-2.js"
import { goldenWords } from "./finance.js"
import { generatedSolvers6 } from "./generated-6.js"
import type { GoldenAnswer, GoldenHelpers, GoldenSolvers } from "./helpers.js"
import { changePct, monthLabel, sameDaysWords } from "./trends.js"

const DAY_MS = 86_400_000

/** «1 frasco», «2 cepillos», «3 unidades»: la unidad de uso del producto. */
function unitsWord(count: number, unit: string): string {
  if (count === 1 || count === -1) return `${count} ${unit}`
  return `${count} ${/[aeiouáéó]$/i.test(unit) ? `${unit}s` : `${unit}es`}`
}

/** La misma pregunta que otra ya resuelta: su mismo cálculo, diciendo de cuál viene. */
function sameAs(solvers: GoldenSolvers, id: string): () => Promise<GoldenAnswer> {
  return async () => {
    const run = solvers[id]
    if (!run) throw new Error(`Falta el cálculo de la pregunta ${id}`)
    const answer = await run()
    return {
      ...answer,
      criterio: `${answer.criterio} Es la misma pregunta que ${id}: el mismo cálculo.`,
    }
  }
}

/** Un presupuesto presentado con su valor (la opción que vale), lo aceptado y lo aún no decidido. */
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

/** Cómo está un presupuesto que espera respuesta, como lo dice la pantalla. */
const WAITING_WORDS: Record<string, string> = {
  presentado: "enviado, sin respuesta",
  pospuesto: "«lo está pensando»",
  parcial: "aceptado en parte",
}

export function blindSolvers4(h: GoldenHelpers): GoldenSolvers {
  const w = goldenWords(h)
  const days = sameDaysWords(h)
  const { tx, org, tz, money, show, listOf } = h
  const { locale, currency, window } = h.scope
  const nowIso = h.now.toISOString()
  const today = w.todayKey
  const year = window.from.year
  const currentMonth = window.from.month
  const weekdayOf = (key: string): number => new Date(`${key}T12:00:00Z`).getUTCDay()
  /** El lunes de esta semana (día de la clínica). */
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7))
  const startOf = (key: string): Date => {
    const [y, m, d] = key.split("-").map(Number) as [number, number, number]
    return dayStart(tz, y, m, d)
  }
  const iso = (value: Date | string): string =>
    typeof value === "string" ? value : value.toISOString()
  const between = (column: SQL, start: Date | string, end: Date | string) =>
    sql`${column} >= ${iso(start)}::timestamptz and ${column} < ${iso(end)}::timestamptz`
  /** Un instante como texto ISO que `new Date` lee siempre. */
  const isoOf = (column: SQL) => sql`(to_json(${column}) #>> '{}')`
  const plural = (count: number, one: string, many: string): string =>
    `${count.toLocaleString(locale)} ${count === 1 ? one : many}`
  const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
  const pct = (part: number, total: number): string =>
    total > 0 ? `${Math.round((part / total) * 100)} %` : "sin dato"
  const sumOf = <T>(rows: readonly T[], pick: (row: T) => string | number): number =>
    rows.reduce((total, row) => total + Number(pick(row)), 0)
  /** «este mes (del 1 al 21 de octubre de 2026)». */
  const thisMonth = `este mes (${w.monthSoFar})`
  const ThisMonth = capital(thisMonth)
  /** «del lunes 26 de octubre al domingo 1 de noviembre». */
  const spanWords = (from: string, to: string): string =>
    from === to
      ? `el ${w.dayWords(from)}`
      : `del ${from.slice(0, 7) === to.slice(0, 7) ? w.dayWords(from).replace(/ de [^ ]+$/, "") : w.dayWords(from)} al ${w.dayWords(to)}`
  /** «12 de septiembre» o, con el año, «12 de septiembre de 2026», en el día de la clínica. */
  const dateWords = (value: Date | string, withYear = false): string =>
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: tz,
    }).format(new Date(value))
  /** Lo mismo de un día `YYYY-MM-DD`. */
  const dayKeyWords = (key: string, withYear = false): string =>
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    }).format(new Date(`${key.slice(0, 10)}T12:00:00Z`))
  const shortDate = (value: Date | string): string =>
    new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: tz,
    }).format(new Date(value))
  /** El día de la clínica (`YYYY-MM-DD`) de un instante. */
  const reportDay = (value: Date | string): string =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value))
  /** «la Dra. Ana Torres», «el Dr. Diego Salas»; sin título, el nombre solo. */
  const the = (name: string): string =>
    /^Dra\.?\s/.test(name) ? `la ${name}` : /^Dr\.?\s/.test(name) ? `el ${name}` : name
  /** Quien pregunta es la Dra. Ana Torres: cuando sale ella, se dice que es ella. */
  const asker = /ana torres/i
  const whoIs = (name: string): string => (asker.test(name) ? `tú (${name})` : name)
  const changeWords = (value: number, before: number): string =>
    value === before
      ? "lo mismo"
      : `${money(Math.abs(value - before))} ${value > before ? "más" : "menos"}${before > 0 ? ` (${w.signed(value, before)})` : ""}`
  /** Un mes como tramo: el más reciente con ese número que ya empezó (o el de `inYear`); el en curso, hasta ahora. */
  const monthOf = (month: number, inYear?: number) => {
    const y = inYear ?? (month <= currentMonth ? year : year - 1)
    const start = dayStart(tz, y, month, 1)
    const full = month === 12 ? dayStart(tz, y + 1, 1, 1) : dayStart(tz, y, month + 1, 1)
    const partial = full.getTime() > h.now.getTime()
    return {
      year: y,
      month,
      key: `${y}-${String(month).padStart(2, "0")}`,
      start,
      end: partial ? h.now : full,
      partial,
      words: monthLabel(h, { year: y, month }),
    }
  }
  /** El mes de hace `back` meses (1 = el pasado). */
  const monthsBack = (back: number) => {
    const index = year * 12 + (currentMonth - 1) - back
    return monthOf((index % 12) + 1, Math.floor(index / 12))
  }

  // --- La clínica ---------------------------------------------------------------------------
  const branches = async () => [
    ...(await tx.execute<{ id: string; name: string }>(
      sql`select id, name from branch where organization_id = ${org} and is_active order by name`,
    )),
  ]
  /** Una cifra de Reportes con una sede elegida en la pantalla. */
  const figIn = async (
    figure: string,
    group: FigureGroup,
    period: string,
    branchId: string,
  ): Promise<FigureResult> =>
    computeFigure(
      { ...h.ctx, scope: await reportScope(tx, org, { period, branchId }, h.now) },
      { figure, group },
    )
  /** Un miembro de la clínica por su nombre. */
  const userNamed = async (pattern: string) => {
    const [row] = await tx.execute<{ id: string; name: string }>(sql`
      select u.id, u.name from "user" u
      where u.name ilike ${pattern} and exists (select 1 from member m where m.organization_id = ${org} and m.user_id = u.id)
      order by u.name limit 1`)
    return row ?? null
  }
  /** El paciente tiene una cita programada o confirmada por venir. */
  const upcoming = (
    patientColumn: SQL,
  ) => sql`exists (select 1 from appointment n where n.organization_id = ${org} and n.patient_id = ${patientColumn}
    and n.starts_at > ${nowIso}::timestamptz and n.status in ('programada','confirmada'))`
  /** La persona del paciente, sin Spam ni bloqueados. */
  const person = (patientColumn: SQL) =>
    sql`join patient p on p.organization_id = ${org} and p.id = ${patientColumn} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.screen is null`
  /** Un instante que no pasa de ahora (la historia de prueba trae alguno adelantado); nulo si no hay. */
  const capped = (column: SQL) =>
    sql`(case when ${column} > ${nowIso}::timestamptz then ${nowIso}::timestamptz else ${column} end)`
  /** Hace `months` meses en el calendario de la clínica (como «Sin venir»). */
  const monthsAgo = (months: number) =>
    sql`((${nowIso}::timestamptz at time zone ${tz}) - make_interval(months => ${months})) at time zone ${tz}`

  // --- Lo realizado ---------------------------------------------------------------------------
  const doneFrom = (start: Date | string, end: Date | string, where: SQL) => sql`
    from encounter_procedure ep
    join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
    left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
    where ep.organization_id = ${org} and ep.voided_at is null and ${between(sql`e.started_at`, start, end)} and ${where}`
  /** Procedimientos de atenciones firmadas en [start, end), por tratamiento y contando su cantidad (como g038). */
  const done = async (start: Date | string, end: Date | string, where: SQL = sql`true`) => [
    ...(await tx.execute<{ name: string; times: number; rows: number; patients: number }>(sql`
      select coalesce(s.name, ep.description) as name, sum(ep.quantity)::int as times, count(*)::int as rows, count(distinct e.patient_id)::int as patients
      ${doneFrom(start, end, where)}
      group by 1 order by 2 desc, 1`)),
  ]
  /** Lo mismo, en una sola cifra. */
  const doneTotal = async (start: Date | string, end: Date | string, where: SQL = sql`true`) => {
    const [row] = await tx.execute<{ times: number; rows: number; patients: number }>(sql`
      select coalesce(sum(ep.quantity), 0)::int as times, count(*)::int as rows, count(distinct e.patient_id)::int as patients
      ${doneFrom(start, end, where)}`)
    return row ?? { times: 0, rows: 0, patients: 0 }
  }
  const timesWords = (rows: Array<{ name: string; times: number }>) =>
    listOf(rows.map((row) => ({ name: row.name, value: `${row.times}` })))
  /** Un solo servicio: «nombre»; varios, cada uno con sus veces. */
  const serviceWords = (rows: Array<{ name: string; times: number }>) =>
    rows.length === 1 ? `«${rows[0]?.name}»` : timesWords(rows)

  // --- Lo vendido ---------------------------------------------------------------------------
  /** Lo pagado en [start, end) aplicado a conceptos sin anular que cumplen `where` (sobre `h.conceptName`). */
  const paidFor = async (start: Date | string, end: Date | string, where: SQL) => {
    const [row] = await tx.execute<{ cents: string; charges: number }>(sql`
      select coalesce(sum(a.amount_cents), 0)::text as cents, count(distinct c.id)::int as charges
      from patient_payment_application a
      join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
      join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null
      ${h.conceptJoins}
      where a.organization_id = ${org} and a.voided_at is null and pay.currency = ${currency}
        and ${between(sql`pay.paid_at`, start, end)} and ${where}`)
    return { cents: Number(row?.cents ?? 0), charges: row?.charges ?? 0 }
  }
  /** Productos con pagos vigentes en [start, end): las unidades del cargo pagado y lo pagado en el tramo (como `generated-2.ts`). */
  const paidProducts = async (start: Date | string, end: Date | string, where: SQL) => [
    ...(await tx.execute<{ name: string; unit: string; units: number; cents: string }>(sql`
      select pr.name, pr.unit, sum(c.product_quantity)::int as units, sum(ap.cents)::text as cents
      from patient_charge c join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id
      join lateral (select sum(a.amount_cents) as cents from patient_payment_application a
        join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
        where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null
          and ${between(sql`pay.paid_at`, start, end)}) ap on ap.cents > 0
      where c.organization_id = ${org} and c.voided_at is null and ${where}
      group by 1, 2 order by sum(c.product_quantity) desc, sum(ap.cents) desc, 1`)),
  ]
  /** Productos cargados en [start, end), pagados o no (la venta es del día del primer cargo de la cadena). */
  const chargedProducts = async (start: Date | string, end: Date | string, where: SQL) => [
    ...(await tx.execute<{ name: string; unit: string; units: number; cents: string }>(sql`
      select pr.name, pr.unit, sum(c.product_quantity)::int as units, sum(c.amount_cents)::text as cents
      from patient_charge c join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id
      left join patient_charge o on o.organization_id = c.organization_id and o.id = c.original_charge_id
      where c.organization_id = ${org} and c.voided_at is null
        and ${between(sql`coalesce(o.created_at, c.created_at)`, start, end)} and ${where}
      group by 1, 2 order by sum(c.product_quantity) desc, sum(c.amount_cents) desc, 1`)),
  ]
  const productWords = (
    rows: Array<{ name: string; unit: string; units: number; cents: string }>,
  ) =>
    listOf(
      rows.map((row) => ({
        name: row.name,
        value: `${unitsWord(row.units, row.unit)}, ${money(Number(row.cents))}`,
      })),
    )

  // --- Los presupuestos ---------------------------------------------------------------------
  const budgetRef = { id: sql`b.id`, organizationId: sql`b.organization_id` }
  const awaits = budgetAwaitsAnswerSql({
    status: sql`b.status`,
    id: sql`b.id`,
    organizationId: sql`b.organization_id`,
  })
  const units = budgetLineUnitsSql({
    billingMode: sql`i.billing_mode`,
    sessionsPlanned: sql`i.sessions_planned`,
  })
  const acceptedLine = sql`(b.status in ('aceptado','parcial') and i.decision = 'aceptado')`
  /** Entregado: presentado y no sustituido ni cancelado (la base de «Aceptaron su presupuesto»). */
  const delivered = sql`b.status in ('aceptado','parcial','presentado','pospuesto','rechazado')`
  /** Presupuestos presentados (no borradores) que cumplen `where`, con su valor, lo aceptado y lo aún no decidido (como `blind-2.ts`). */
  const budgets = async (where: SQL) => [
    ...(await tx.execute<Budget>(sql`
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
      order by b.presented_at, b.budget_number`)),
  ]

  // --- El inventario ------------------------------------------------------------------------
  /** Cada producto de cada sede activa, como lo muestra Inventario hoy. */
  const bySede = async () => {
    const found: Array<ProductListItem & { branch: string; branchId: string }> = []
    for (const branch of await branches()) {
      const list = await listProducts(tx, org, { branchId: branch.id, now: h.now })
      for (const item of list.items)
        found.push({ ...item, branch: branch.name, branchId: branch.id })
    }
    return found
  }
  /** Lo usado (consumo en las atenciones y ventas) de cada producto y sede en [start, end), en su unidad de uso. */
  const usedIn = async (start: Date | string, end: Date | string) => [
    ...(await tx.execute<{ productId: string; branchId: string; units: number }>(sql`
      select m.product_id as "productId", wh.branch_id as "branchId", sum(-m.quantity_delta)::int as units
      from stock_movement m join warehouse wh on wh.organization_id = m.organization_id and wh.id = m.warehouse_id
      where m.organization_id = ${org} and m.kind in ('consumo','venta') and ${between(sql`m.created_at`, start, end)}
      group by 1, 2`)),
  ]
  /** Lotes con existencias, con su sede y su vencimiento (como g142). */
  const lots = async () => [
    ...(await tx.execute<{
      product: string
      unit: string
      branch: string
      code: string | null
      expires: string | null
      quantity: number
    }>(sql`
      select pr.name as product, pr.unit, b.name as branch, l.code, to_char(l.expires_at, 'YYYY-MM-DD') as expires, l.quantity_on_hand as quantity
      from product_lot l
      join product pr on pr.organization_id = l.organization_id and pr.id = l.product_id
      join warehouse wh on wh.organization_id = l.organization_id and wh.id = l.warehouse_id
      join branch b on b.organization_id = wh.organization_id and b.id = wh.branch_id
      where l.organization_id = ${org} and l.quantity_on_hand > 0
      order by l.expires_at nulls last, pr.name, b.name`)),
  ]
  type Lot = Awaited<ReturnType<typeof lots>>[number]
  const lotWords = (rows: Lot[]) =>
    listOf(
      rows.map((row) => ({
        name: `${row.product} en ${row.branch}${row.code ? `, lote ${row.code}` : ""}`,
        value: `${unitsWord(row.quantity, row.unit)}, ${row.expires ? `${row.expires < today ? "venció" : "vence"} el ${dayKeyWords(row.expires, true)}` : "sin vencimiento anotado"}`,
      })),
    )

  // --- Las promociones ----------------------------------------------------------------------
  const fold = (text: string) =>
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
  const promotions = async () => [
    ...(await tx.execute<{
      id: string
      name: string
      starts: string | null
      ends: string | null
    }>(sql`
      select id::text as id, name, to_char(starts_at at time zone ${tz}, 'YYYY-MM-DD') as starts,
        to_char((ends_at - interval '1 second') at time zone ${tz}, 'YYYY-MM-DD') as ends
      from promotion where organization_id = ${org} order by starts_at`)),
  ]
  type Promotion = Awaited<ReturnType<typeof promotions>>[number]
  /** «vigente del 1 al 30 de septiembre de 2026», «vigente desde el 1 de abril de 2026». */
  const promoSpan = (row: Promotion) =>
    row.ends
      ? `vigente del ${dayKeyWords(row.starts ?? today)} al ${dayKeyWords(row.ends, true)}`
      : `vigente desde el ${dayKeyWords(row.starts ?? today, true)}, sin fecha de fin`
  /** Reportes › Promociones desde que empezó la promoción hasta hoy: quienes la usaron y lo que pagaron desde entonces. */
  const promotionReport = async (row: Promotion) => {
    const report = await getReportPromotions(
      tx,
      org,
      { period: `${row.starts ?? today}..${today}` },
      h.now,
    )
    return report.promotions.find((item) => item.promotionId === row.id) ?? null
  }
  /** Gastos registrados con publicidad, Facebook, anuncio o marketing en el concepto o el tipo (como x29). */
  const adsIn = async (start: Date | string, end: Date | string) => {
    const [row] = await tx.execute<{ count: number; cents: string }>(sql`
      select count(*)::int as count, coalesce(sum(e.amount_cents), 0)::text as cents from expense e
      where e.organization_id = ${org} and e.voided_at is null and e.currency = ${currency} and ${between(sql`e.spent_at`, start, end)}
        and (e.concept ~* 'publicidad|facebook|instagram|anuncio|marketing|campa' or e.category ~* 'publicidad|marketing')`)
    return { count: row?.count ?? 0, cents: Number(row?.cents ?? 0) }
  }

  const b1 = blindSolvers1(h)
  const b2 = blindSolvers2(h)
  const g6 = generatedSolvers6(h)

  return {
    // --- Tratamientos -------------------------------------------------------------------------
    y26: async () => {
      const july = monthOf(7)
      const cleaning = sql`coalesce(s.name, ep.description) ~* '(limpieza|profilaxis)'`
      const rows = await done(july.start, july.end, cleaning)
      const total = await doneTotal(july.start, july.end, cleaning)
      const lastYear = monthOf(7, july.year - 1)
      const before = await doneTotal(lastYear.start, lastYear.end, cleaning)
      const june = monthOf(6, july.year)
      const august = monthOf(8, july.year)
      const juneTotal = await doneTotal(june.start, june.end, cleaning)
      const augustTotal = await doneTotal(august.start, august.end, cleaning)
      const [visits] = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from appointment a where a.organization_id = ${org} and a.status = 'atendida'
          and a.service_name ~* '(limpieza|profilaxis)' and ${between(sql`a.starts_at`, july.start, july.end)}`)
      const paid = await paidFor(
        july.start,
        july.end,
        sql`${h.conceptName} ~* '(limpieza|profilaxis)'`,
      )
      return {
        respuesta: total.times
          ? `En ${july.words} se hicieron ${plural(total.times, "limpieza", "limpiezas")} (${serviceWords(rows)}), a ${plural(total.patients, "paciente", "pacientes")}.`
          : `En ${july.words} no se hizo ninguna limpieza.`,
        criterio:
          "Procedimientos sin anular de limpieza o profilaxis en atenciones firmadas de julio completo (el julio más reciente, por el día de la atención), contando su cantidad, como g026.",
        nota: `Contando cada procedimiento una vez, sin su cantidad: ${total.rows}. Citas atendidas de limpieza en julio: ${visits?.count ?? 0}. En ${lastYear.words}: ${before.times}; en ${june.words}, ${juneTotal.times}; en ${august.words}, ${augustTotal.times}. Lo pagado en julio por limpiezas (sobre los pagos): ${money(paid.cents)}.`,
        datos: {
          mes: july.key,
          filas: rows,
          total,
          julioAnterior: before,
          junio: juneTotal,
          agosto: augustTotal,
          citas: visits?.count ?? 0,
          pagado: paid,
        },
      }
    },

    y27: async () => {
      const month = await done(h.monthStart, h.now)
      const quarter = await reportScope(tx, org, { period: "ultimos_3_meses" }, h.now)
      const three = await done(quarter.window.start, quarter.window.end)
      const twelve = await done(new Date(h.now.getTime() - 365 * DAY_MS), h.now)
      const isEvaluation = (name: string) => /evaluaci|consulta/i.test(name)
      const treatments = month.filter((row) => !isEvaluation(row.name))
      const total = sumOf(month, (row) => row.times)
      const months = `${monthLabel(h, quarter.window.from, false)} a ${monthLabel(h, quarter.window.to)}`
      return {
        respuesta: month.length
          ? `${ThisMonth} los tratamientos que más se hicieron son: ${timesWords(month.slice(0, 5))}. En total van ${total} procedimientos de ${plural(month.length, "tratamiento distinto", "tratamientos distintos")}.`
          : `${ThisMonth} todavía no hay atenciones firmadas con tratamientos.`,
        criterio:
          "Sin periodo en la pregunta, el mes en curso: procedimientos sin anular de atenciones firmadas (por el día de la atención), por tratamiento y contando su cantidad (como t2 y g038).",
        nota: `En los últimos 3 meses completos (${months}): ${timesWords(three.slice(0, 5))}. En los últimos 12 meses: ${timesWords(twelve.slice(0, 5))}. Sin contar evaluaciones ni consultas, este mes: ${timesWords(treatments.slice(0, 5))}.`,
        datos: {
          mes: month.slice(0, 15),
          tresMeses: three.slice(0, 10),
          doceMeses: twelve.slice(0, 10),
        },
      }
    },

    y47: async () => {
      const salas = await userNamed("%salas%")
      if (!salas)
        return {
          respuesta: "En el equipo no hay ningún Dr. Salas.",
          criterio: "Miembros de la clínica por nombre.",
          datos: {},
        }
      const last = { start: dayStart(tz, year - 1, 1, 1), end: dayStart(tz, year, 1, 1) }
      const endo = sql`coalesce(s.name, ep.description) ilike '%endodon%'`
      const mineWhere = sql`${endo} and e.professional_user_id = ${salas.id}`
      const rows = await done(last.start, last.end, mineWhere)
      const mine = await doneTotal(last.start, last.end, mineWhere)
      const team = [
        ...(await tx.execute<{ name: string; times: number }>(sql`
          select coalesce(u.name, 'Sin profesional') as name, coalesce(sum(ep.quantity), 0)::int as times
          from encounter_procedure ep
          join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
          left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
          left join "user" u on u.id = e.professional_user_id
          where ep.organization_id = ${org} and ep.voided_at is null and ${between(sql`e.started_at`, last.start, last.end)} and ${endo}
          group by 1 order by 2 desc, 1`)),
      ]
      const thisYear = await doneTotal(dayStart(tz, year, 1, 1), h.now, mineWhere)
      const rolling = await doneTotal(new Date(h.now.getTime() - 365 * DAY_MS), h.now, mineWhere)
      return {
        respuesta: mine.times
          ? `En ${year - 1} (de enero a diciembre) ${the(salas.name)} hizo ${plural(mine.times, "endodoncia", "endodoncias")} (${serviceWords(rows)}), a ${plural(mine.patients, "paciente", "pacientes")}.`
          : `En ${year - 1} ${the(salas.name)} no hizo ninguna endodoncia.`,
        criterio:
          "«El año pasado» = de enero a diciembre del año anterior. Procedimientos sin anular de endodoncia (por su nombre) en atenciones firmadas del Dr. Diego Salas, el único Salas del equipo, por el día de la atención y contando su cantidad.",
        nota: `Todo el equipo en ${year - 1}: ${listOf(team.map((row) => ({ name: whoIs(row.name), value: `${row.times}` })))}. En lo que va de ${year}, ${the(salas.name)} lleva ${thisYear.times}; en los últimos 365 días, ${rolling.times}.`,
        datos: {
          profesional: salas,
          ano: year - 1,
          filas: rows,
          total: mine,
          equipo: team,
          esteAno: thisYear,
          ultimos365: rolling,
        },
      }
    },

    // --- Presupuestos y planes ----------------------------------------------------------------
    y28: async () => {
      const result = await h.fig("aceptaron", "total", "mes_pasado")
      const scope = await reportScope(tx, org, { period: "mes_pasado" }, h.now)
      const name = monthLabel(h, scope.window.from)
      const before = monthsBack(2)
      const previous = await h.fig("aceptaron", "total", before.key)
      const presented = sql`${between(sql`b.presented_at`, scope.window.start, scope.window.end)}`
      const statuses = [
        ...(await tx.execute<{ status: string; count: number }>(sql`
          select b.status, count(*)::int as count from treatment_budget b
          where b.organization_id = ${org} and ${delivered} and ${presented} group by 1`)),
      ]
      const [value] = await tx.execute<{ cents: string; accepted: string }>(sql`
        select coalesce(sum(i.price_cents::bigint * ${units}), 0)::text as cents,
          coalesce(sum(i.price_cents::bigint * ${units}) filter (where ${acceptedLine}), 0)::text as accepted
        from treatment_budget b
        join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
          and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.price_cents is not null
        where b.organization_id = ${org} and ${delivered} and ${presented}`)
      const of = (status: string) => statuses.find((row) => row.status === status)?.count ?? 0
      const accepted = result.total.part ?? 0
      const whole = result.total.whole ?? 0
      return {
        respuesta: whole
          ? `En ${name} entregaste ${plural(whole, "presupuesto", "presupuestos")} y ${accepted === 1 ? "se aceptó 1" : `se aceptaron ${accepted}`} en todo o en parte: el ${show(result)}. De ellos, ${of("aceptado")} enteros y ${of("parcial")} en parte.`
          : `En ${name} no se entregó ningún presupuesto.`,
        criterio:
          "«Aceptaron su presupuesto» de Reportes del mes pasado completo: presupuestos entregados ese mes (presentados, sin borradores, sustituidos ni cancelados) y cuántos se aceptaron en todo o en parte, según su respuesta a hoy (como x14).",
        nota: `De los demás, ${of("rechazado")} se rechazaron y ${of("presentado") + of("pospuesto")} siguen esperando respuesta (${of("presentado")} sin ninguna y ${of("pospuesto")} «lo están pensando»). Por dinero: se aceptó ${money(Number(value?.accepted ?? 0))} de ${money(Number(value?.cents ?? 0))} presupuestados (${pct(Number(value?.accepted ?? 0), Number(value?.cents ?? 0))}). En ${before.words}: ${show(previous)} (${previous.total.part ?? 0} de ${previous.total.whole ?? 0}).`,
        datos: {
          mes: scope.window.key,
          total: result.total,
          porEstado: statuses,
          valor: value ?? null,
          mesAnterior: previous.total,
        },
      }
    },

    y29: async () => {
      const crown = sql`coalesce(cs.name, ci.title) ilike 'corona cer%'`
      const crownWaits = sql`exists (select 1 from treatment_budget_item ci
        left join service_catalog cs on cs.organization_id = ci.organization_id and cs.id = ci.service_id
        where ci.organization_id = b.organization_id and ci.budget_id = b.id and ci.option_id = ${budgetValueOptionSql(budgetRef)}
          and ci.price_cents is not null and ${crown} and ci.decision in ('pendiente','pospuesto'))`
      const rows = await budgets(sql`${awaits} and ${crownWaits}`)
      const crowns = [
        ...(await tx.execute<{ id: string; lines: number; cents: string }>(sql`
          select b.id, sum(${units})::int as lines, sum(i.price_cents::bigint * ${units})::text as cents
          from treatment_budget b
          join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
            and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.price_cents is not null
          left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
          where b.organization_id = ${org} and ${awaits} and coalesce(s.name, i.title) ilike 'corona cer%' and i.decision in ('pendiente','pospuesto')
          group by 1`)),
      ]
      const crownCents = sumOf(crowns, (row) => row.cents)
      const crownCount = sumOf(crowns, (row) => row.lines)
      const people = new Set(rows.map((row) => row.patientId)).size
      const otherCrowns = [
        ...(await tx.execute<{ name: string; budgets: number }>(sql`
          select coalesce(s.name, i.title) as name, count(distinct b.id)::int as budgets
          from treatment_budget b
          join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
            and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.price_cents is not null
          left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
          where b.organization_id = ${org} and ${awaits} and coalesce(s.name, i.title) ilike '%corona%'
            and coalesce(s.name, i.title) not ilike 'corona cer%' and coalesce(s.name, i.title) not ilike '%alargamiento%'
            and i.decision in ('pendiente','pospuesto')
          group by 1 order by 2 desc, 1`)),
      ]
      const shown = rows.slice(0, 10)
      const by = (status: string) => rows.filter((row) => row.status === status).length
      const oldest = rows[0]
      return {
        respuesta: rows.length
          ? `Hoy ${plural(rows.length, "presupuesto con corona cerámica sigue", "presupuestos con corona cerámica siguen")} esperando respuesta, de ${plural(people, "paciente", "pacientes")}: ${plural(crownCount, "corona", "coronas")} por ${money(crownCents)} sin decidir. De la más antigua a la más reciente: ${listOf(shown.map((row) => ({ name: `${row.person} · N.º ${row.number}`, value: `desde el ${shortDate(row.presented)}, ${WAITING_WORDS[row.status] ?? row.status}` })))}${rows.length > shown.length ? ` y ${rows.length - shown.length} más` : ""}.`
          : "Hoy ningún presupuesto con corona cerámica espera respuesta.",
        criterio:
          "Presupuestos que esperan respuesta a hoy (budgetAwaitsAnswer: enviado, «lo está pensando» o aceptado en parte con algo pendiente) con una Corona cerámica aún sin decidir en la opción que vale; se suma el precio de esas coronas (como x50).",
        nota: `Si «sin respuesta» es solo sin ninguna respuesta (enviados): ${by("presentado")}; ${by("pospuesto")} «lo están pensando» y ${by("parcial")} se aceptaron en parte con la corona pendiente. Con todo lo que falta decidir de esos presupuestos (no solo la corona): ${money(sumOf(rows, (row) => row.pending))}.${oldest ? ` El que espera hace más es el de ${oldest.person}, desde el ${dateWords(oldest.presented, true)}.` : ""}${otherCrowns.length ? ` Otras coronas esperando respuesta: ${listOf(otherCrowns.map((row) => ({ name: row.name, value: plural(row.budgets, "presupuesto", "presupuestos") })))}.` : ""}`,
        datos: {
          presupuestos: rows.map((row) => ({
            numero: row.number,
            paciente: row.person,
            estado: row.status,
            desde: row.presented,
            sinDecidir: row.pending,
          })),
          coronas: crowns,
          coronasCentimos: crownCents,
          otrasCoronas: otherCrowns,
        },
      }
    },

    y30: async () => {
      const [service] = await tx.execute<{ id: string; name: string; price: number }>(sql`
        select id, name, price_cents as price from service_catalog where organization_id = ${org} and is_active and name ilike 'corona cer%'
        order by price_cents desc limit 1`)
      if (!service)
        return {
          respuesta:
            "No puedo decirte cuánto te queda por corona: odentIA no tiene lo que cuesta cada tratamiento, y en tu lista no hay una corona cerámica.",
          criterio: "Trampa: sin costo por tratamiento; el servicio no existe.",
          datos: {},
        }
      const yearAgo = new Date(h.now.getTime() - 365 * DAY_MS)
      const team = [
        ...(await tx.execute<{
          id: string
          name: string
          times: number
          charged: string
          rate: number | null
        }>(sql`
          select u.id, u.name, sum(ep.quantity)::int as times, coalesce(sum(ch.cents), 0)::text as charged,
            (select r.rate_bps from commission_rule r where r.organization_id = ${org} and r.professional_user_id = u.id) as rate
          from encounter_procedure ep
          join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
          join "user" u on u.id = e.professional_user_id
          left join lateral (select sum(c.amount_cents) as cents from patient_charge c
            where c.organization_id = ep.organization_id and c.encounter_procedure_id = ep.id and c.voided_at is null) ch on true
          where ep.organization_id = ${org} and ep.voided_at is null and ep.service_id = ${service.id} and ${between(sql`e.started_at`, yearAgo, h.now)}
          group by u.id, u.name order by (u.name ilike '%ana torres%') desc, 3 desc, 2`)),
      ]
      const rates = [
        ...(await tx.execute<{ name: string; rate: number }>(sql`
          select u.name, r.rate_bps as rate from commission_rule r join "user" u on u.id = r.professional_user_id
          where r.organization_id = ${org} order by (u.name ilike '%ana torres%') desc, r.rate_bps desc, u.name`)),
      ]
      const [materials] = await tx.execute<{ moves: number }>(sql`
        select count(*)::int as moves from stock_movement m
        where m.organization_id = ${org} and m.kind = 'consumo'
          and m.encounter_id in (select ep.encounter_id from encounter_procedure ep where ep.organization_id = ${org} and ep.service_id = ${service.id} and ep.voided_at is null)`)
      const spentOf = async (category: string) => {
        const [row] = await tx.execute<{ count: number; cents: string }>(sql`
          select count(*)::int as count, coalesce(sum(e.amount_cents), 0)::text as cents from expense e
          where e.organization_id = ${org} and e.voided_at is null and e.currency = ${currency} and e.category = ${category}
            and ${between(sql`e.spent_at`, yearAgo, h.now)}`)
        return { count: row?.count ?? 0, cents: Number(row?.cents ?? 0) }
      }
      const lab = await spentOf("Laboratorio")
      const supplies = await spentOf("Materiales")
      const rateWords = (rate: number) => `${(rate / 100).toLocaleString(locale)} %`
      const afterCommission = (rate: number) => Math.round(service.price * (1 - rate / 10_000))
      const crownsDone = sumOf(team, (row) => row.times)
      return {
        respuesta: `No puedo decirte cuánto te queda de ganancia por corona: odentIA no tiene lo que cuesta cada corona en materiales ni en laboratorio (el laboratorio se registra como un gasto del mes, sin ligarlo a cada corona, y en las coronas no se descontó ningún insumo del inventario). Lo que sí está: la ${service.name} cuesta ${money(service.price)} en tu lista, y la comisión es un porcentaje de lo cobrado, así que antes de materiales y laboratorio quedan ${listOf(rates.map((row) => ({ name: `${money(afterCommission(row.rate))} si la ${asker.test(row.name) ? "haces tú" : `hace ${the(row.name)}`}`, value: `comisión del ${rateWords(row.rate)}, ${money(service.price - afterCommission(row.rate))}` })))}.`,
        criterio:
          "Trampa: sin el costo de materiales y de laboratorio de cada tratamiento no hay ganancia por corona. La comisión sí se puede calcular (el porcentaje de cada odontólogo de Finanzas › Comisiones sobre lo cobrado, aplicado al precio de lista), así que se da lo que queda después de la comisión, antes de materiales y laboratorio.",
        nota: `En los últimos 365 días se hicieron ${plural(crownsDone, "corona cerámica", "coronas cerámicas")}: ${listOf(team.map((row) => ({ name: whoIs(row.name), value: `${row.times}, cargadas en promedio a ${row.times ? money(Math.round(Number(row.charged) / row.times)) : "—"}` })))}. Movimientos de insumos ligados a esas atenciones: ${materials?.moves ?? 0}. Gastos registrados en ese tiempo, sin ligar a ningún tratamiento: Laboratorio ${money(lab.cents)} (${plural(lab.count, "gasto", "gastos")}, junta coronas y prótesis) y Materiales ${money(supplies.cents)} (${plural(supplies.count, "gasto", "gastos")}).`,
        datos: {
          servicio: service,
          porProfesional: team,
          comisiones: rates,
          insumosLigados: materials?.moves ?? 0,
          laboratorio365: lab,
          materiales365: supplies,
        },
      }
    },

    y31: async () => {
      const plans = [
        ...(await tx.execute<{
          planId: string
          patientId: string
          person: string
          title: string
          todo: number
          suspended: number
          names: string | null
          created: string
          moved: string
          visit: string | null
          booked: boolean
          stalled: boolean
          stalledOwn: boolean
          idle: boolean
        }>(sql`
          with items as (
            select pi.plan_id, tp.patient_id, tp.title, tp.created_at as plan_created, pi.status, pi.decision_status,
              coalesce(s.name, pi.title) as name,
              ${capped(sql`pi.started_at`)} as started, ${capped(sql`pi.completed_at`)} as completed, ${capped(sql`pi.decided_at`)} as decided
            from treatment_plan_item pi
            join treatment_plan tp on tp.organization_id = pi.organization_id and tp.id = pi.plan_id and not tp.is_legacy
            left join service_catalog s on s.organization_id = pi.organization_id and s.id = pi.service_id
            where pi.organization_id = ${org}),
          plans as (
            select plan_id, patient_id, title, plan_created,
              count(*) filter (where decision_status = 'aceptado' and status in ('pendiente','programado','en_curso'))::int as todo,
              count(*) filter (where decision_status = 'aceptado' and status = 'suspendido')::int as suspended,
              string_agg(distinct name, ', ') filter (where decision_status = 'aceptado' and status in ('pendiente','programado','en_curso')) as names,
              greatest(plan_created, max(started), max(completed), max(decided)) as own_moved
            from items group by 1, 2, 3, 4),
          q as (
            select pl.*, pp.display_name as person,
              (select max(a.starts_at) from appointment a where a.organization_id = ${org} and a.patient_id = pl.patient_id
                and a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz) as visit,
              ${upcoming(sql`pl.patient_id`)} as booked
            from plans pl ${person(sql`pl.patient_id`)}
            where pl.todo > 0 or pl.suspended > 0)
          select q.plan_id as "planId", q.patient_id as "patientId", q.person, q.title, q.todo, q.suspended, q.names,
            ${isoOf(sql`q.plan_created`)} as created, ${isoOf(sql`greatest(q.own_moved, q.visit)`)} as moved, ${isoOf(sql`q.visit`)} as visit, q.booked,
            (q.todo > 0 and not q.booked and greatest(q.own_moved, q.visit) < ${monthsAgo(1)}) as stalled,
            (q.todo > 0 and not q.booked and q.own_moved < ${monthsAgo(1)}) as "stalledOwn",
            (q.todo > 0 and not q.booked and (q.visit is null or q.visit < ${monthsAgo(1)})) as idle
          from q order by greatest(q.own_moved, q.visit), q.person`)),
      ]
      const running = plans.filter((row) => row.todo > 0)
      const stalled = plans.filter((row) => row.stalled)
      const stalledOwn = plans.filter((row) => row.stalledOwn)
      const idle = plans.filter((row) => row.idle)
      const suspendedOnly = plans.filter(
        (row) => row.todo === 0 && row.suspended > 0 && !row.booked,
      )
      const planWords = (list: typeof plans) =>
        listOf(
          list.map((row) => ({
            name: `${row.person} («${row.title}»)`,
            value: `${plural(row.todo, "tratamiento aceptado por hacer", "tratamientos aceptados por hacer")}: ${row.names ?? "—"}; sin movimiento desde el ${shortDate(row.moved)}`,
          })),
        )
      return {
        respuesta: stalled.length
          ? `Hoy ${plural(stalled.length, "plan de tratamiento está parado", "planes de tratamiento están parados")} hace más de un mes, de ${plural(running.length, "plan en curso", "planes en curso")}: ${planWords(stalled)}. Ninguno de esos pacientes tiene una cita por venir.`
          : `Hoy ningún plan de tratamiento lleva más de un mes parado: de los ${running.length} en curso, todos tuvieron algún movimiento en el último mes o tienen una cita por venir.`,
        criterio:
          "Planes (no heredados) con algún tratamiento aceptado por empezar, programado o en curso, a hoy (como x28), sin cita programada o confirmada por venir, y cuyo último movimiento (se creó el plan, se aceptó, empezó o terminó un tratamiento, o el paciente tuvo una cita atendida) fue hace más de un mes, en el calendario de la clínica.",
        nota: `Si «parado» es solo que el paciente no tuvo ninguna cita atendida en el último mes (aunque el plan sea más nuevo): ${idle.length}. Si solo cuenta lo que avanzó el plan (sin mirar otras citas del paciente): ${stalledOwn.length}. Aparte, ${plural(suspendedOnly.length, "plan solo tiene", "planes solo tienen")} tratamientos suspendidos. Hoy no hay ninguna cita por venir en la clínica, así que ningún plan en curso tiene cita.`,
        datos: {
          enCurso: running.length,
          parados: stalled,
          paradosSoloPlan: stalledOwn.length,
          sinCitaAtendidaUnMes: idle.length,
          soloSuspendidos: suspendedOnly.length,
        },
      }
    },

    // --- Controles --------------------------------------------------------------------------
    y32: async () => {
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
      const ortho = [
        ...(await tx.execute<{
          day: string
          time: string
          patient: string
          professional: string
          branch: string
          status: string
        }>(sql`
          select to_char(a.starts_at at time zone ${tz}, 'YYYY-MM-DD') as day, to_char(a.starts_at at time zone ${tz}, 'HH24:MI') as time,
            pp.display_name as patient, u.name as professional, b.name as branch, a.status
          from appointment a
          join "user" u on u.id = a.professional_user_id
          join branch b on b.organization_id = a.organization_id and b.id = a.branch_id
          ${h.joinPerson(sql`a.patient_id`)}
          where a.organization_id = ${org} and a.status in ('programada','confirmada') and ${between(sql`a.starts_at`, start, end)} and ${orthoAppointment}
          order by a.starts_at, u.name`)),
      ]
      const controls = [
        ...(await tx.execute<{ title: string; due: string; patient: string; ortho: boolean }>(sql`
          select f.title, to_char(f.due_at at time zone ${tz}, 'YYYY-MM-DD') as due, pp.display_name as patient,
            (f.title ilike '%ortodon%' or coalesce(s1.name, s2.name, '') ilike '%ortodon%') as ortho
          from clinical_follow_up f
          left join encounter_procedure ep on ep.organization_id = f.organization_id and ep.id = f.encounter_procedure_id
          left join service_catalog s1 on s1.organization_id = f.organization_id and s1.id = ep.service_id
          left join treatment_plan_item pi on pi.organization_id = f.organization_id and pi.id = f.plan_item_id
          left join service_catalog s2 on s2.organization_id = f.organization_id and s2.id = pi.service_id
          ${h.joinPerson(sql`f.patient_id`)}
          where f.organization_id = ${org} and f.status in ('pendiente','programado') and ${between(sql`f.due_at`, start, end)}
          order by f.due_at, pp.display_name`)),
      ]
      // Lo más cercano a «les toca»: controles de ortodoncia aceptados en su plan que aún no se hacen, sin cita por venir.
      const planned = [
        ...(await tx.execute<{ person: string; items: number; last: string | null }>(sql`
          select pp.display_name as person, count(*)::int as items,
            ${isoOf(sql`(select max(a.starts_at) from appointment a where a.organization_id = ${org} and a.patient_id = tp.patient_id
              and a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz and ${orthoAppointment})`)} as last
          from treatment_plan_item pi
          join treatment_plan tp on tp.organization_id = pi.organization_id and tp.id = pi.plan_id and not tp.is_legacy
          left join service_catalog s on s.organization_id = pi.organization_id and s.id = pi.service_id
          ${person(sql`tp.patient_id`)}
          where pi.organization_id = ${org} and pi.decision_status = 'aceptado' and pi.status in ('pendiente','programado','en_curso')
            and coalesce(s.name, pi.title) ilike '%ortodon%' and not ${upcoming(sql`tp.patient_id`)}
          group by tp.patient_id, pp.display_name
          order by 3 nulls first, 1`)),
      ]
      const [last] = await tx.execute<{
        at: string | null
        month: number
        next: string | null
      }>(sql`
        select ${isoOf(sql`max(a.starts_at) filter (where a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz)`)} as at,
          count(*) filter (where a.status = 'atendida' and a.starts_at >= ${h.monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz)::int as month,
          ${isoOf(sql`min(a.starts_at) filter (where a.status in ('programada','confirmada') and a.starts_at > ${nowIso}::timestamptz)`)} as next
        from appointment a where a.organization_id = ${org} and ${orthoAppointment}`)
      const orthoControls = controls.filter((row) => row.ortho)
      const week2 = spanWords(nextMonday, nextSunday)
      const shown = planned.slice(0, 8)
      const plannedWords = planned.length
        ? ` Lo más cercano: ${plural(planned.length, "paciente tiene", "pacientes tienen")} controles de ortodoncia aceptados en su plan que todavía no se hacen y ninguna cita por venir: ${listOf(shown.map((row) => ({ name: row.person, value: row.last ? `último control el ${shortDate(row.last)}` : "sin controles atendidos" })))}${planned.length > shown.length ? ` y ${planned.length - shown.length} más` : ""}.`
        : ""
      return {
        respuesta: ortho.length
          ? `La próxima semana (${week2}) les toca control de ortodoncia a ${plural(ortho.length, "paciente", "pacientes")}: ${listOf(ortho.map((row) => ({ name: `${row.patient}, el ${w.dayWords(row.day)} a las ${row.time}`, value: `${row.professional}, ${row.branch}${row.status === "confirmada" ? ", confirmada" : ", sin confirmar"}` })))}.`
          : `A nadie todavía: para la próxima semana (${week2}) no hay ningún control de ortodoncia agendado${(week?.all ?? 0) === 0 ? "; esa semana aún no hay ninguna cita agendada" : ` (hay ${plural(week?.all ?? 0, "cita", "citas")} de otros tratamientos)`}${orthoControls.length ? "" : ", y en las fichas no toca ningún control de ortodoncia esa semana"}.${plannedWords}`,
        criterio:
          "Citas programadas o confirmadas de la próxima semana (lunes a domingo, día de la clínica) de un servicio de ortodoncia (por su nombre o su especialidad), y los controles pendientes de las fichas que tocan esa semana (como x31). Sin ninguna, lo más cercano: los pacientes con controles de ortodoncia aceptados en su plan por hacer y sin cita por venir.",
        nota: `${controls.length ? `En las fichas tocan esa semana ${plural(controls.length, "control", "controles")}, ${orthoControls.length ? `${orthoControls.length} de ortodoncia` : "ninguno de ortodoncia"}: ${listOf(controls.map((row) => ({ name: row.patient, value: `${row.title.toLowerCase()}, el ${w.dayWords(row.due)}` })))}.` : "En las fichas no hay controles que toquen esa semana."}${last?.at ? ` El último control de ortodoncia atendido fue el ${dateWords(last.at, true)}; ${thisMonth} se atendieron ${last.month}.` : ""}${last?.next ? ` El próximo control de ortodoncia agendado es el ${dateWords(last.next, true)}.` : " No hay ningún control de ortodoncia agendado más adelante."}`,
        datos: {
          semana: { desde: nextMonday, hasta: nextSunday },
          citasSemana: week?.all ?? 0,
          ortodoncia: ortho,
          controles: controls,
          conControlEnSuPlan: planned,
          ultimo: last ?? null,
        },
      }
    },

    y33: async () => {
      const [row] = await tx.execute<{
        controls: number
        people: number
        nothingAfter: number
        over6: number
        over12: number
        last30: number
        withAppointment: number
      }>(sql`
        with overdue as (
          select f.id, f.patient_id, f.due_at from clinical_follow_up f ${person(sql`f.patient_id`)}
          where f.organization_id = ${org} and f.status = 'pendiente' and f.appointment_id is null
            and f.due_at < ${nowIso}::timestamptz and pp.is_active and not ${upcoming(sql`f.patient_id`)})
        select count(*)::int as controls, count(distinct o.patient_id)::int as people,
          count(*) filter (where not exists (select 1 from appointment a where a.organization_id = ${org} and a.patient_id = o.patient_id
            and a.starts_at >= o.due_at))::int as "nothingAfter",
          count(*) filter (where o.due_at < ${monthsAgo(6)})::int as over6,
          count(*) filter (where o.due_at < ${monthsAgo(12)})::int as over12,
          count(*) filter (where o.due_at >= ${nowIso}::timestamptz - interval '30 days')::int as last30,
          (select count(*) from clinical_follow_up f where f.organization_id = ${org} and f.status = 'programado'
            and f.due_at < ${nowIso}::timestamptz)::int as "withAppointment"
        from overdue o`)
      const result = await h.fig("controles")
      const controls = row?.controls ?? 0
      return {
        respuesta: controls
          ? `Hoy ${plural(controls, "control se pasó", "controles se pasaron")} de fecha sin que el paciente lo agendara nunca, de ${plural(row?.people ?? 0, "paciente", "pacientes")}, y ninguno tiene otra cita por venir: ${row?.last30 ?? 0} ${row?.last30 === 1 ? "venció" : "vencieron"} en los últimos 30 días, ${controls - (row?.last30 ?? 0) - (row?.over6 ?? 0)} hace entre uno y 6 meses, ${(row?.over6 ?? 0) - (row?.over12 ?? 0)} hace entre 6 meses y un año, y ${row?.over12 ?? 0} hace más de un año.`
          : "Hoy no hay controles vencidos sin agendar.",
        criterio:
          "Controles de las fichas en estado pendiente (nunca ligados a una cita) cuya fecha ya pasó, a hoy, de pacientes sin archivar, Spam ni bloqueo y sin ninguna cita programada o confirmada por venir (como g055).",
        nota: `Si «nunca agendó» es que después de la fecha del control no sacó ninguna cita de nada: ${row?.nothingAfter ?? 0}; los otros ${controls - (row?.nothingAfter ?? 0)} sí vinieron o agendaron otra cosa después, sin ligarla al control. Controles vencidos ya ligados a una cita (programados): ${row?.withAppointment ?? 0}. «Vinieron a su control» de Reportes ${thisMonth}: ${show(result)} (${result.total.part ?? 0} de ${result.total.whole ?? 0} que tocaban).`,
        datos: { vencidos: row ?? null, vinieronAsuControl: result.total },
      }
    },

    // --- Inventario -------------------------------------------------------------------------
    y34: async () => {
      const found = await bySede()
      const short = found.filter((item) => item.needs)
      const supplies = short.filter((item) => item.usedInCare)
      const others = short.filter((item) => !item.usedInCare)
      const used = await usedIn(new Date(h.now.getTime() - 30 * DAY_MS), h.now)
      const usedOf = (item: (typeof found)[number]) =>
        used.find((row) => row.productId === item.id && row.branchId === item.branchId)?.units ?? 0
      const usable = (item: (typeof found)[number]) => item.onHand - (item.expired?.quantity ?? 0)
      const lastsWords = (item: (typeof found)[number]) => {
        const pace = usedOf(item)
        if (pace <= 0 || usable(item) <= 0) return ""
        const left = Math.floor((usable(item) / pace) * 30)
        return `; al ritmo de los últimos 30 días alcanza para ${left > 365 ? "más de un año" : `unos ${left} días`}`
      }
      const shortWords = (list: typeof found) =>
        listOf(
          list.map((row) => ({
            name: `${row.name} en ${row.branch}`,
            value:
              row.shortage > 0
                ? `se ${row.usedInCare ? "usaron" : "vendieron"} ${unitsWord(row.shortage, row.unit)} sin haber; mínimo ${row.minQuantity}`
                : `${row.onHand <= 0 ? "no queda nada" : `${row.onHand === 1 ? "queda" : "quedan"} ${unitsWord(row.onHand, row.unit)}`}, mínimo ${row.minQuantity}${lastsWords(row)}`,
          })),
        )
      const soon = found.filter(
        (item) =>
          item.usedInCare &&
          item.isActive &&
          !item.needs &&
          usedOf(item) > 0 &&
          usable(item) > 0 &&
          (usable(item) / usedOf(item)) * 30 < 30,
      )
      const expiredLeft = found.filter(
        (item) =>
          item.usedInCare &&
          item.expired &&
          item.minQuantity > 0 &&
          usable(item) < item.minQuantity &&
          !item.needs,
      )
      return {
        respuesta: supplies.length
          ? `Hoy ${supplies.length === 1 ? "hace falta 1 insumo" : `hacen falta ${supplies.length} insumos`} (bajo su mínimo o usados sin haber): ${shortWords(supplies)}.`
          : "Hoy ningún insumo está por debajo de su mínimo ni se usó sin haber.",
        criterio:
          "«Hacen falta» de Inventario en cada sede, a hoy (como x10): insumos (productos que se usan en las atenciones) por debajo de su mínimo o usados sin haber, con lo que queda en su unidad de uso (lotes − faltante) y el ritmo de los últimos 30 días.",
        nota: `${others.length ? `Además hacen falta productos que no son insumos (solo se venden): ${shortWords(others)}. ` : ""}${soon.length ? `Sin estar bajo el mínimo, al ritmo de los últimos 30 días se acabarían en menos de un mes: ${listOf(soon.map((row) => ({ name: `${row.name} en ${row.branch}`, value: `${unitsWord(usable(row), row.unit)}, ${unitsWord(usedOf(row), row.unit)} usados en 30 días` })))}.` : "Ningún otro insumo se acabaría en menos de un mes al ritmo de los últimos 30 días."}${expiredLeft.length ? ` Sin contar lo vencido quedarían bajo el mínimo: ${listOf(expiredLeft.map((row) => ({ name: `${row.name} en ${row.branch}`, value: `${unitsWord(row.expired?.quantity ?? 0, row.unit)} vencidos` })))}.` : ""}`,
        datos: {
          hacenFalta: short.map((row) => ({
            name: row.name,
            branch: row.branch,
            onHand: row.onHand,
            shortage: row.shortage,
            min: row.minQuantity,
            insumo: row.usedInCare,
            usado30: usedOf(row),
          })),
          seAcabanEnUnMes: soon.map((row) => row.name),
        },
      }
    },

    y35: async () => {
      const all = (await lots()).filter(
        (row) =>
          /lidoca/i.test(row.product) || (/resina/i.test(row.product) && /a2/i.test(row.product)),
      )
      const yearEnd = `${year}-12-31`
      const coming = all.filter(
        (row) => row.expires && row.expires >= today && row.expires <= yearEnd,
      )
      const expired = all.filter((row) => row.expires && row.expires < today)
      const later = all.filter((row) => row.expires && row.expires > yearEnd)
      const undated = all.filter((row) => !row.expires)
      const products = [...new Set(all.map((row) => row.product))]
      return {
        respuesta: `${coming.length ? `Sí: de hoy al 31 de diciembre vence${coming.length === 1 ? "" : "n"} ${plural(coming.length, "lote", "lotes")}: ${lotWords(coming)}.` : `De hoy al 31 de diciembre no vence ningún lote de lidocaína ni de resina A2.`}${expired.length ? ` Pero ${expired.length === 1 ? "hay un lote ya vencido que sigue" : `hay ${expired.length} lotes ya vencidos que siguen`} en el almacén: ${lotWords(expired)}.` : ""}`,
        criterio:
          "Lotes con existencias, a hoy, de los productos con lidocaína o resina A2 en el nombre que vencen entre hoy y el 31 de diciembre; lo ya vencido que sigue en el almacén, aparte (como x11).",
        nota: `${later.length ? `Los demás lotes vencen después de fin de año: ${lotWords(later)}. ` : ""}${undated.length ? `Sin vencimiento anotado: ${lotWords(undated)}.` : ""} Productos mirados: ${products.join(", ") || "ninguno"}.`,
        datos: { antesDeFinDeAno: coming, vencidos: expired, despues: later, sinFecha: undated },
      }
    },

    y36: async () => {
      const first = monthsBack(6)
      const lastFull = monthsBack(1)
      const start = first.start
      const end = new Date(h.monthStart)
      const all = (await purchaseBalances(tx, org, { currency })).filter(
        (row) => row.status !== "borrador" && row.status !== "cancelada",
      )
      const made = all.filter((row) => row.createdAt >= start && row.createdAt < end)
      const withOctober = all.filter((row) => row.createdAt >= start && row.createdAt < h.now)
      const rank = (list: typeof all) => {
        const map = new Map<
          string,
          { name: string; orders: number; ordered: number; received: number; paid: number }
        >()
        for (const row of list) {
          const entry = map.get(row.supplierId) ?? {
            name: row.supplierName,
            orders: 0,
            ordered: 0,
            received: 0,
            paid: 0,
          }
          entry.orders += 1
          entry.ordered += row.orderedCents
          entry.received += row.receivedCents
          entry.paid += row.paidCents
          map.set(row.supplierId, entry)
        }
        return [...map.values()].sort(
          (a, b) => b.ordered - a.ordered || a.name.localeCompare(b.name),
        )
      }
      const ranked = rank(made)
      const rankedOct = rank(withOctober)
      const total = sumOf(made, (row) => row.orderedCents)
      const top = ranked[0]
      const months = `de ${monthLabel(h, first, false)} a ${lastFull.words}`
      const [paidOut] = await tx.execute<{ count: number; cents: string }>(sql`
        select count(*)::int as count, coalesce(sum(e.amount_cents), 0)::text as cents from expense e
        where e.organization_id = ${org} and e.voided_at is null and e.purchase_order_id is not null and e.currency = ${currency}
          and ${between(sql`e.spent_at`, start, end)}`)
      return {
        respuesta: top
          ? `En los últimos 6 meses completos (${months}) le compraste a proveedores ${money(total)} en ${plural(made.length, "compra", "compras")}; a quien más, a ${top.name}: ${money(top.ordered)} en ${plural(top.orders, "compra", "compras")} (${pct(top.ordered, total)} del total).${ranked.length > 1 ? ` Le sigue${ranked.length > 2 ? "n" : ""} ${listOf(ranked.slice(1).map((row) => ({ name: row.name, value: `${money(row.ordered)}, ${plural(row.orders, "compra", "compras")}` })))}.` : ""}`
          : `En los últimos 6 meses completos (${months}) no se hizo ninguna compra a proveedores.`,
        criterio:
          "«Los últimos 6 meses» = los 6 meses completos anteriores al mes en curso. Compras de Inventario creadas en ese tramo (día de la clínica), sin borradores ni canceladas: lo pedido por su costo, por proveedor (como g146 y x30).",
        nota: `Contando también lo que va de ${monthLabel(h, window.from, false)}: ${money(sumOf(withOctober, (row) => row.orderedCents))} en ${plural(withOctober.length, "compra", "compras")}; a quien más, ${rankedOct[0] ? `${rankedOct[0].name} (${money(rankedOct[0].ordered)})` : "a nadie"}. De lo comprado en los 6 meses ya llegó ${money(sumOf(made, (row) => row.receivedCents))} y se pagó ${money(sumOf(made, (row) => row.paidCents))}. Pagos de compras registrados en Gastos en ese tramo: ${money(Number(paidOut?.cents ?? 0))} (${plural(paidOut?.count ?? 0, "pago", "pagos")}).`,
        datos: {
          desde: first.key,
          hasta: lastFull.key,
          compras: made.map((row) => ({
            numero: purchaseOrderLabel(row.orderNumber),
            proveedor: row.supplierName,
            estado: PURCHASE_STATUS_WORDS[row.status] ?? row.status,
            pedido: row.orderedCents,
            fecha: row.createdAt,
          })),
          porProveedor: ranked,
          conOctubre: rankedOct,
        },
      }
    },

    y37: async () => {
      const name = sql`translate(lower(pr.name), 'áéíóúü', 'aeiouu')`
      const brush = sql`(${name} ~ 'cepillo' and ${name} ~ 'suave')`
      const rinse = sql`${name} ~ 'enjuague'`
      const where = sql`(${brush} or ${rinse})`
      const paid = await paidProducts(h.monthStart, h.now, where)
      const loaded = await chargedProducts(h.monthStart, h.now, where)
      const before = await paidProducts(window.previous.start, window.previous.end, where)
      const catalog = [
        ...(await tx.execute<{ name: string; unit: string }>(sql`
          select pr.name, pr.unit from product pr where pr.organization_id = ${org} and pr.is_active and ${where} order by pr.name`)),
      ]
      const kinds = [
        {
          none: "ningún cepillo suave",
          test: (text: string) => /cepillo/i.test(text) && /suave/i.test(text),
        },
        { none: "ningún enjuague", test: (text: string) => /enjuague/i.test(text) },
      ]
      const parts = kinds.map((kind) => {
        const rows = paid.filter((row) => kind.test(row.name))
        const unitsSold = sumOf(rows, (row) => row.units)
        const unit = rows[0]?.unit ?? catalog.find((row) => kind.test(row.name))?.unit ?? "unidad"
        return {
          units: unitsSold,
          cents: sumOf(rows, (row) => row.cents),
          words: unitsSold
            ? `${unitsWord(unitsSold, unit)} (${rows.map((row) => row.name).join(" y ")}, ${money(sumOf(rows, (row) => row.cents))})`
            : kind.none,
        }
      })
      const total = sumOf(paid, (row) => row.cents)
      return {
        respuesta: paid.length
          ? `${ThisMonth} vendiste ${parts.map((part) => part.words).join(" y ")}: ${money(total)} en total.`
          : `${ThisMonth} no se vendió ningún cepillo suave ni enjuague${catalog.length ? ` (tus productos son ${catalog.map((row) => row.name).join(" y ")})` : ""}.`,
        criterio:
          "Lo vendido: pagos vigentes del mes en curso aplicados a cargos sin anular de los productos con «cepillo» y «suave» o con «enjuague» en el nombre, con las unidades del cargo pagado (como x35).",
        nota: `Contando lo cargado este mes aunque no se haya pagado: ${productWords(loaded) || "nada"}. En ${days.sameAs}: ${money(sumOf(before, (row) => row.cents))}${before.length ? ` (${productWords(before)})` : ""}.`,
        datos: { pagado: paid, cargado: loaded, mismosDiasMesAnterior: before, productos: catalog },
      }
    },

    y38: async () => {
      const gloves = (await bySede()).filter(
        (item) =>
          /guante/i.test(item.name) &&
          /nitrilo/i.test(item.name) &&
          (item.onHand !== 0 || item.minQuantity > 0),
      )
      const product = gloves[0]
      const count = (value: number, unit: string) =>
        unitsWord(value, unit).replace(/^-?\d+/, value.toLocaleString(locale))
      if (!product)
        return {
          respuesta:
            "No puedo decirte cuántas vas a necesitar: odentIA no hace proyecciones, y no tienes guantes de nitrilo en Inventario.",
          criterio: "Trampa: es una proyección; el producto no existe.",
          datos: {},
        }
      const factor = product.purchaseFactor > 1 ? product.purchaseFactor : 1
      const boxWord = product.purchaseUnit ?? "caja"
      const boxes = (value: number) => {
        if (factor <= 1) return count(value, product.unit)
        const rounded = Math.round((value / factor) * 10) / 10
        return `${rounded.toLocaleString(locale)} ${rounded === 1 ? boxWord : `${boxWord}s`}`
      }
      const usedBetween = async (start: Date | string, end: Date | string) => {
        const [row] = await tx.execute<{ units: number }>(sql`
          select coalesce(sum(-m.quantity_delta), 0)::int as units from stock_movement m
          where m.organization_id = ${org} and m.product_id = ${product.id} and m.kind = 'consumo' and ${between(sql`m.created_at`, start, end)}`)
        return row?.units ?? 0
      }
      const [firstUse] = await tx.execute<{ at: string | null }>(sql`
        select ${isoOf(sql`min(m.created_at)`)} as at from stock_movement m where m.organization_id = ${org} and m.product_id = ${product.id} and m.kind = 'consumo'`)
      const recent = [monthsBack(3), monthsBack(2), monthsBack(1)]
      const perMonth: Array<{ words: string; units: number; complete: boolean }> = []
      for (const month of recent)
        perMonth.push({
          words: monthLabel(h, month, false),
          units: await usedBetween(month.start, month.end),
          complete: !firstUse?.at || new Date(firstUse.at) <= month.start,
        })
      const current = await usedBetween(h.monthStart, h.now)
      const full = perMonth.filter((row) => row.complete)
      const average = full.length ? Math.round(sumOf(full, (row) => row.units) / full.length) : null
      const lastDecember = monthOf(12, year - 1)
      const december = await usedBetween(lastDecember.start, lastDecember.end)
      const onHand = sumOf(gloves, (item) => item.onHand)
      return {
        respuesta: `No puedo decirte cuántas cajas vas a necesitar en diciembre: odentIA no hace proyecciones. Lo registrado: en las atenciones se usaron ${listOf(perMonth.map((row) => ({ name: `${count(row.units, product.unit)} en ${row.words}`, value: `${boxes(row.units)}${row.complete ? "" : ", desde que se empezó a registrar"}` })))}${average !== null ? `, en promedio ${boxes(average)} al mes en los meses completos` : ""}; ${thisMonth} van ${count(current, product.unit)} (${boxes(current)}). Hoy tienes ${count(onHand, product.unit)} (${boxes(onHand)}): ${listOf(gloves.map((item) => ({ name: item.branch, value: `${boxes(item.onHand)}${item.minQuantity ? `, mínimo ${boxes(item.minQuantity)}` : ""}` })))}.`,
        criterio:
          "Trampa: es una proyección. Se ofrece lo usado de guantes de nitrilo en las atenciones (movimientos de consumo del inventario) en los últimos 3 meses y en el mes en curso, y lo que hay hoy en cada sede, en guantes y en cajas de compra.",
        nota: `El consumo se registra desde el ${firstUse?.at ? dateWords(firstUse.at, true) : "—"}: de ${lastDecember.words} ${december ? `hay ${count(december, product.unit)}` : "no hay nada registrado"}, así que no hay un diciembre con que comparar. La caja de compra trae ${count(factor, product.unit)}.`,
        datos: {
          producto: product.name,
          porSede: gloves.map((item) => ({
            branch: item.branch,
            onHand: item.onHand,
            min: item.minQuantity,
          })),
          porMes: perMonth,
          mes: current,
          promedio: average,
          factor,
          primerConsumo: firstUse?.at ?? null,
        },
      }
    },

    // --- Conversaciones y ventas --------------------------------------------------------------
    y39: async () => {
      const base = await sameAs(b1, "x20")()
      const yesterday = addDays(today, -1)
      const [messages] = await tx.execute<{ messages: number; people: number }>(sql`
        select count(*)::int as messages, count(distinct c.contact_id)::int as people from message m
        join conversation c on c.organization_id = m.organization_id and c.id = m.conversation_id
        join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id and cc.channel = 'whatsapp'
        where m.organization_id = ${org} and m.direction = 'in' and not ${screenedSql(sql.raw("c"))}
          and ${between(sql`m.created_at`, startOf(yesterday), startOf(today))}`)
      return {
        ...base,
        nota: `${base.nota ?? ""} Por mensajes: ayer llegaron ${plural(messages?.messages ?? 0, "mensaje", "mensajes")} de WhatsApp de ${plural(messages?.people ?? 0, "persona", "personas")}.`,
        datos: { ...base.datos, mensajesAyer: messages ?? null },
      }
    },

    y40: async () => {
      const writers = async (start: Date | string, end: Date | string) => [
        ...(await tx.execute<{ channel: string; people: number; messages: number }>(sql`
          select cc.channel, count(distinct c.contact_id)::int as people, count(*)::int as messages from message m
          join conversation c on c.organization_id = m.organization_id and c.id = m.conversation_id
          join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id
          where m.organization_id = ${org} and m.direction = 'in' and not ${screenedSql(sql.raw("c"))} and ${between(sql`m.created_at`, start, end)}
          group by 1 order by 2 desc, 3 desc, 1`)),
      ]
      const month = await writers(h.monthStart, h.now)
      const quarter = await reportScope(tx, org, { period: "ultimos_3_meses" }, h.now)
      const three = await writers(quarter.window.start, quarter.window.end)
      const firsts = await h.fig("nos_buscaron", "canal")
      const of = (list: typeof month, channel: string) =>
        list.find((row) => row.channel === channel) ?? { channel, people: 0, messages: 0 }
      const wa = of(month, "whatsapp")
      const ig = of(month, "instagram")
      const wa3 = of(three, "whatsapp")
      const ig3 = of(three, "instagram")
      const firstOf = (channel: string) =>
        firsts.rows.find((row) => row.key === channel)?.value.value ?? 0
      const [connection] = await tx.execute<{ status: string | null }>(sql`
        select string_agg(distinct status, ', ') as status from channel_connection where organization_id = ${org} and channel = 'instagram'`)
      const winner =
        wa.people > ig.people
          ? "Por WhatsApp"
          : ig.people > wa.people
            ? "Por Instagram"
            : "Igual por los dos"
      const months = `${monthLabel(h, quarter.window.from, false)} a ${monthLabel(h, quarter.window.to)}`
      return {
        respuesta: `${winner}: ${thisMonth} nos escribieron ${plural(wa.people, "persona", "personas")} por WhatsApp (${plural(wa.messages, "mensaje", "mensajes")}) y ${plural(ig.people, "persona", "personas")} por Instagram (${plural(ig.messages, "mensaje", "mensajes")}).`,
        criterio:
          "Sin periodo, el mes en curso: personas distintas (sin Spam ni bloqueados) con al menos un mensaje recibido por cada canal, con sus mensajes (como x21).",
        nota: `En los últimos 3 meses completos (${months}): ${wa3.people} por WhatsApp y ${ig3.people} por Instagram. Por primera vez («Nos buscaron por primera vez» de Reportes, este mes): ${firstOf("whatsapp")} por WhatsApp y ${firstOf("instagram")} por Instagram. Por todos los canales este mes: ${listOf(month.map((row) => ({ name: channelWords(row.channel), value: `${row.people}` })))}.${connection?.status && !/active/.test(connection.status) ? " La conexión de Instagram de la clínica está desactivada: mientras siga así, por ese canal no entran mensajes nuevos." : ""}`,
        datos: {
          mes: month,
          tresMeses: three,
          primeraVez: firsts.rows,
          instagram: connection?.status ?? null,
        },
      }
    },

    y41: sameAs(g6, "g134"),

    y42: async () => {
      const promo = (await promotions()).find(
        (row) => /evaluacion/.test(fold(row.name)) && /grat/.test(fold(row.name)),
      )
      if (!promo)
        return {
          respuesta: "No tienes una promoción de evaluación gratis.",
          criterio: "Promociones de la clínica por nombre.",
          datos: {},
        }
      const people = [
        ...(await tx.execute<{
          patientId: string
          person: string
          day: string
          treatments: string | null
          times: number
          accepted: boolean
          waiting: boolean
        }>(sql`
          with uses as (
            select b.patient_id, min(b.presented_at) as at from treatment_budget b
            join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
              and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.promotion_id = ${promo.id}::uuid and i.price_cents is not null
            where b.organization_id = ${org} and b.status <> 'borrador' and b.presented_at < ${nowIso}::timestamptz
            group by 1
            union all
            select c.patient_id, min(c.created_at) from patient_charge c
            where c.organization_id = ${org} and c.voided_at is null and c.budget_item_id is null and c.promotion_id = ${promo.id}
              and c.created_at < ${nowIso}::timestamptz
            group by 1),
          person as (select patient_id, min(at) as at from uses group by 1),
          later as (
            select pe.patient_id, coalesce(s.name, ep.description) as name, ep.quantity
            from person pe
            join encounter e on e.organization_id = ${org} and e.patient_id = pe.patient_id and e.status = 'finalizada' and e.voided_at is null
              and (e.started_at at time zone ${tz})::date >= (pe.at at time zone ${tz})::date and e.started_at < ${nowIso}::timestamptz
            join encounter_procedure ep on ep.organization_id = e.organization_id and ep.encounter_id = e.id and ep.voided_at is null
            left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
            where coalesce(s.name, ep.description) !~* '(evaluaci|consulta)')
          select pe.patient_id as "patientId", pp.display_name as person, to_char(pe.at at time zone ${tz}, 'YYYY-MM-DD') as day,
            (select string_agg(distinct l.name, ', ') from later l where l.patient_id = pe.patient_id) as treatments,
            coalesce((select sum(l.quantity) from later l where l.patient_id = pe.patient_id), 0)::int as times,
            exists (select 1 from treatment_budget b join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
              and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.price_cents is not null
              where b.organization_id = ${org} and b.patient_id = pe.patient_id and b.presented_at >= pe.at and b.status in ('aceptado','parcial')
                and i.decision = 'aceptado' and i.promotion_id is distinct from ${promo.id}::uuid) as accepted,
            exists (select 1 from treatment_budget b where b.organization_id = ${org} and b.patient_id = pe.patient_id and b.presented_at >= pe.at
              and ${awaits}) as waiting
          from person pe ${h.joinPerson(sql`pe.patient_id`)}
          order by pe.at, 2`)),
      ]
      const treated = people.filter((row) => row.times > 0)
      const untreated = people.filter((row) => row.times === 0)
      const month = people.filter((row) => row.day >= reportDay(h.monthStart))
      const report = await promotionReport(promo)
      return {
        respuesta: people.length
          ? `De las ${plural(people.length, "persona que vino", "personas que vinieron")} por la «${promo.name}» (${promoSpan(promo)}), ${treated.length === people.length ? "todas" : treated.length} ${treated.length === 1 ? "terminó" : "terminaron"} haciéndose algún tratamiento después (${pct(treated.length, people.length)}): ${listOf(treated.map((row) => ({ name: row.person, value: row.treatments ?? "—" })))}.${untreated.length ? ` Todavía sin ningún tratamiento: ${listOf(untreated.map((row) => ({ name: row.person, value: row.accepted ? "aceptó un presupuesto que falta hacer" : row.waiting ? "tiene un presupuesto esperando respuesta" : `vino el ${dayKeyWords(row.day)}` })))}.` : ""}`
          : `Nadie usó todavía la «${promo.name}».`,
        criterio:
          "Quienes usaron la promoción «Evaluación gratis» desde que empezó (como Reportes › Promociones: un presupuesto entregado o un cobro con ella), cada persona una vez; «terminó haciéndose algún tratamiento»: desde el día en que la usó, un procedimiento sin anular de una atención firmada que no sea una evaluación ni una consulta, a hoy.",
        nota: `Si «terminaron» es que aceptaron un presupuesto de tratamientos después: ${people.filter((row) => row.accepted).length} de ${people.length}. Este mes la usaron ${month.length}, ${month.filter((row) => row.times > 0).length} ya con algún tratamiento. Reportes › Promociones cuenta ${report?.accepted ?? 0} de ${report?.people ?? 0} como «aceptaron» (la evaluación gratis es una línea aceptada de su propio presupuesto); ${report?.fresh ?? 0} eran pacientes nuevos y desde entonces pagaron ${money(report?.collectedCents ?? 0)}.`,
        datos: {
          promocion: promo,
          personas: people,
          conTratamiento: treated.length,
          reportes: report,
        },
      }
    },

    y43: async () => {
      const all = await promotions()
      const promo = all.find(
        (row) => /blanqueamiento/.test(fold(row.name)) && /2\s*[x×]\s*1/.test(fold(row.name)),
      )
      if (!promo)
        return {
          respuesta: `No tienes una promoción «Blanqueamiento 2x1». Tus promociones son ${all.map((row) => `«${row.name}»`).join(", ")}.`,
          criterio: "Promociones de la clínica por nombre.",
          datos: { promociones: all },
        }
      const report = await promotionReport(promo)
      const [lines] = await tx.execute<{
        lines: number
        people: number
        cents: string
        tariff: string
        paid: string
        charged: string
        doneCount: number
      }>(sql`
        with promo as (
          select i.id, i.plan_item_id, b.patient_id, i.price_cents::bigint * ${units} as cents,
            coalesce(i.tariff_price_cents, i.price_cents)::bigint * ${units} as tariff
          from treatment_budget b
          join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
            and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.promotion_id = ${promo.id}::uuid and i.price_cents is not null
          where b.organization_id = ${org} and ${acceptedLine}),
        charges as (
          select c.id, c.amount_cents from patient_charge c join promo x on c.budget_item_id = x.id or (x.plan_item_id is not null and c.plan_item_id = x.plan_item_id)
          where c.organization_id = ${org} and c.voided_at is null)
        select (select count(*) from promo)::int as lines, (select count(distinct patient_id) from promo)::int as people,
          (select coalesce(sum(cents), 0) from promo)::text as cents, (select coalesce(sum(tariff), 0) from promo)::text as tariff,
          (select coalesce(sum(amount_cents), 0) from charges)::text as charged,
          (select coalesce(sum(a.amount_cents), 0) from patient_payment_application a
            join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
            where a.organization_id = ${org} and a.voided_at is null and a.charge_id in (select id from charges))::text as paid,
          (select count(*) from treatment_plan_item pi where pi.organization_id = ${org} and pi.id in (select plan_item_id from promo) and pi.status = 'realizado')::int as "doneCount"`)
      const month = await getReportPromotions(tx, org, { period: "este_mes" }, h.now)
      const thisMonthRow = month.promotions.find((row) => row.promotionId === promo.id)
      return {
        respuesta: report
          ? `Con la promoción «${promo.name}» (${promoSpan(promo)}) ${plural(report.people, "persona la usó", "personas la usaron")} (${report.fresh ? `${report.fresh} de ellas pacientes nuevos` : "ninguna era paciente nueva"}) y desde entonces ${report.people === 1 ? "pagó" : "pagaron"} ${money(report.collectedCents)}, contando todo lo que pagaron, no solo el blanqueamiento.`
          : `La «${promo.name}» (${promoSpan(promo)}) no la usó nadie: no se vendió nada con ella.`,
        criterio:
          "«Lo cobrado» de Reportes › Finanzas › Promociones desde que empezó la promoción hasta hoy (como g136): quienes la usaron (un presupuesto entregado con ella o un cobro con ella) y lo que pagaron desde que la usaron, sin anulados ni lo devuelto. La promoción ya terminó, así que el mes en curso no la mide.",
        nota: `Si «vendido con la promo» es solo el blanqueamiento con precio de promoción: se aceptaron ${plural(lines?.lines ?? 0, "blanqueamiento", "blanqueamientos")} en presupuestos por ${money(Number(lines?.cents ?? 0))} (a tarifa habrían sido ${money(Number(lines?.tariff ?? 0))}), y de eso se ha cargado ${money(Number(lines?.charged ?? 0))} y cobrado ${money(Number(lines?.paid ?? 0))} (en sus planes figuran ${lines?.doneCount ?? 0} como realizados). ${thisMonthRow ? `${ThisMonth} la ${thisMonthRow.people === 1 ? "usó 1 persona" : `usaron ${thisMonthRow.people} personas`}.` : `${ThisMonth} no la usó nadie.`}`,
        datos: {
          promocion: promo,
          reportes: report,
          blanqueamientos: lines ?? null,
          esteMes: thisMonthRow ?? null,
        },
      }
    },

    y44: async () => {
      const promo = (await promotions()).find(
        (row) => /limpieza/.test(fold(row.name)) && /fluor/.test(fold(row.name)),
      )
      const yearAds = await adsIn(dayStart(tz, year, 1, 1), h.now)
      if (!promo)
        return {
          respuesta:
            "No lo sé: odentIA no registra lo que inviertes en anuncios ni qué anuncio trajo a cada paciente, y no tienes una promoción «Limpieza + flúor».",
          criterio: "Trampa: sin inversión en publicidad; la promoción no existe.",
          datos: { gastosPublicidad: yearAds },
        }
      const startDay = promo.starts ?? today
      const endDay = promo.ends ?? today
      const range = `${startDay}..${endDay < today ? endDay : today}`
      const report = await promotionReport(promo)
      const ads = await adsIn(
        startOf(startDay),
        endDay < today ? startOf(addDays(endDay, 1)) : h.now,
      )
      const channels = await h.fig("nos_buscaron", "canal", range)
      const messenger = channels.rows.find((row) => row.key === "messenger")
      const referral = await h.fig("como_nos_conocieron", "como_nos_conocio", range)
      const social = referral.rows.find((row) => row.key === "redes_sociales")
      return {
        respuesta: `No lo sé: odentIA no registra lo que inviertes en anuncios de Facebook${ads.count ? ` (los gastos registrados de publicidad de esas fechas suman ${money(ads.cents)}, pero no dicen de qué anuncio)` : " (entre los gastos registrados no hay ninguno de publicidad)"} ni qué anuncio trajo a cada paciente. Lo registrado de la promoción «${promo.name}» (${promoSpan(promo)}): la ${report?.people === 1 ? "usó 1 persona" : `usaron ${report?.people ?? 0} personas`}, ${report?.fresh ? `${report.fresh} de ellas pacientes nuevos` : "ninguna paciente nueva"}, y desde entonces pagaron ${money(report?.collectedCents ?? 0)}.`,
        criterio:
          "Trampa: odentIA no registra la inversión en publicidad ni de qué campaña llega cada paciente. Se miran los gastos registrados con publicidad, Facebook, anuncio o marketing y se ofrece Reportes › Promociones de «Limpieza + flúor» desde que empezó (quienes la usaron, cuántos eran nuevos y lo que pagaron).",
        nota: `Mientras estuvo vigente, ${plural(messenger?.value.value ?? 0, "persona nos escribió", "personas nos escribieron")} por primera vez por Messenger, el chat de Facebook (${messenger?.value.part ?? 0} vinieron), y ${social?.value.value ?? 0} de los ${referral.total.value ?? 0} pacientes nuevos dijeron que nos conocieron por redes sociales. Gastos de publicidad registrados en ${year}: ${yearAds.count}.`,
        datos: {
          promocion: promo,
          reportes: report,
          gastosPublicidad: ads,
          gastosPublicidadAno: yearAds,
          messenger: messenger ?? null,
          redesSociales: social ?? null,
        },
      }
    },

    y45: sameAs(b2, "x37"),

    // --- Dinero y sedes -----------------------------------------------------------------------
    y46: async () => {
      const result = await h.fig("cobrado")
      const lastFull = await h.fig("cobrado", "total", "mes_pasado")
      const value = result.total.value ?? 0
      const before = result.previous?.value ?? 0
      const rows: Array<{ name: string; value: number; before: number }> = []
      for (const branch of await branches()) {
        const own = await figIn("cobrado", "total", "este_mes", branch.id)
        rows.push({
          name: branch.name,
          value: own.total.value ?? 0,
          before: own.previous?.value ?? 0,
        })
      }
      const moving = rows.filter((row) => row.value !== 0 || row.before !== 0)
      const full = lastFull.total.value ?? 0
      return {
        respuesta: `${value > before ? "Mejor" : value < before ? "Peor" : "Igual"}: ${days.current} cobraste ${show(result)}, contra ${show(result, before)} en ${days.sameAs}: ${changeWords(value, before)}.`,
        criterio:
          "«Lo cobrado» de Reportes del mes en curso contra los mismos días del mes anterior hasta la misma hora: pagos menos anulaciones y devoluciones.",
        nota: `Contra ${w.previousMonth} completo (${show(lastFull)}), te faltan ${money(Math.max(0, full - value))} para igualarlo. Por sede, contra los mismos días: ${listOf(moving.map((row) => ({ name: row.name, value: `${money(row.value)} contra ${money(row.before)}${changePct(row.value, row.before) ? `, ${changePct(row.value, row.before)}` : ""}` })))}.`,
        datos: {
          mes: result.total,
          anterior: result.previous,
          mesPasado: lastFull.total,
          porSede: rows,
        },
      }
    },

    y48: async () => {
      const all = await branches()
      const surco = all.find((branch) => /surco/i.test(branch.name)) ?? null
      const others = all.filter((branch) => branch.id !== surco?.id)
      const rows: Array<{
        name: string
        collected: number
        collectedBefore: number
        attended: number
        attendedBefore: number
      }> = []
      for (const branch of others) {
        const collected = await figIn("cobrado", "total", "este_mes", branch.id)
        const attended = await figIn("atendidas", "total", "este_mes", branch.id)
        rows.push({
          name: branch.name,
          collected: collected.total.value ?? 0,
          collectedBefore: collected.previous?.value ?? 0,
          attended: attended.total.value ?? 0,
          attendedBefore: attended.previous?.value ?? 0,
        })
      }
      const clinic = await h.fig("cobrado")
      const words = rows
        .map(
          (row) =>
            `la ${row.name} cobró ${money(row.collected)} contra ${money(row.collectedBefore)} en ${days.sameAs}${changePct(row.collected, row.collectedBefore) ? ` (${changePct(row.collected, row.collectedBefore)})` : ""} y atendió ${plural(row.attended, "cita", "citas")} contra ${row.attendedBefore}`,
        )
        .join("; ")
      if (!surco)
        return {
          respuesta: `No tienes una sede Surco. ${ThisMonth}, en tus sedes: ${words}.`,
          criterio:
            "La sede no existe; se dan lo cobrado y las citas atendidas de Reportes por sede del mes en curso.",
          datos: { sedes: rows },
        }
      const [facts] = await tx.execute<{
        appointments: number
        payments: number
        charges: number
        encounters: number
        schedules: number
        rooms: number
        expenses: number
      }>(sql`
        select (select count(*) from appointment a where a.organization_id = ${org} and a.branch_id = ${surco.id})::int as appointments,
          (select count(*) from patient_payment p where p.organization_id = ${org} and p.branch_id = ${surco.id})::int as payments,
          (select count(*) from patient_charge c where c.organization_id = ${org} and c.branch_id = ${surco.id})::int as charges,
          (select count(*) from encounter e where e.organization_id = ${org} and e.branch_id = ${surco.id})::int as encounters,
          (select count(*) from professional_schedule s where s.organization_id = ${org} and s.branch_id = ${surco.id} and s.is_active)::int as schedules,
          (select count(*) from schedule_room c where c.organization_id = ${org} and c.branch_id = ${surco.id} and c.is_active)::int as rooms,
          (select count(*) from expense e where e.organization_id = ${org} and e.branch_id = ${surco.id} and e.voided_at is null)::int as expenses`)
      const empty =
        !facts ||
        facts.appointments + facts.payments + facts.charges + facts.encounters + facts.expenses ===
          0
      const own = empty ? null : await figIn("cobrado", "total", "este_mes", surco.id)
      const ownAttended = empty ? null : await figIn("atendidas", "total", "este_mes", surco.id)
      return {
        respuesta: empty
          ? `En la ${surco.name} no hay nada registrado: ni citas, ni atenciones, ni cobros, ni gastos${facts?.schedules ? "" : ", y ningún profesional tiene horario ahí"}, así que no hay cómo decir cómo les fue. Lo más cercano, ${thisMonth} en las otras sedes: ${words}. En toda la clínica se cobró ${show(clinic)}.`
          : `${ThisMonth} en la ${surco.name} se cobró ${show(own as FigureResult)} (${changeWords(own?.total.value ?? 0, own?.previous?.value ?? 0)} que en ${days.sameAs}) y se atendieron ${plural(ownAttended?.total.value ?? 0, "cita", "citas")}.`,
        criterio:
          "Sin periodo, el mes en curso. Lo registrado en la sede desde siempre (citas, atenciones, cobros, cargos, gastos, horarios y unidades dentales); sin nada, «Lo cobrado» y «Citas atendidas» de Reportes con cada otra sede elegida, contra los mismos días del mes anterior.",
        nota: `En la ${surco.name}, desde siempre: ${facts?.appointments ?? 0} citas, ${facts?.encounters ?? 0} atenciones, ${facts?.payments ?? 0} cobros, ${facts?.charges ?? 0} cargos, ${facts?.expenses ?? 0} gastos, ${facts?.schedules ?? 0} horarios y ${plural(facts?.rooms ?? 0, "unidad dental", "unidades dentales")} registrados.`,
        datos: { sede: surco, hechos: facts ?? null, otrasSedes: rows, clinica: clinic.total },
      }
    },

    y49: async () => {
      const yearAgo = new Date(h.now.getTime() - 365 * DAY_MS)
      const twoYearsAgo = new Date(h.now.getTime() - 730 * DAY_MS)
      const services = [
        ...(await tx.execute<{
          id: string
          name: string
          price: number
          times: number
          before: number
          month: number
        }>(sql`
          select sc.id, sc.name, sc.price_cents as price,
            coalesce((select sum(ep.quantity) ${doneFrom(yearAgo, h.now, sql`ep.service_id = sc.id`)}), 0)::int as times,
            coalesce((select sum(ep.quantity) ${doneFrom(twoYearsAgo, yearAgo, sql`ep.service_id = sc.id`)}), 0)::int as before,
            coalesce((select sum(ep.quantity) ${doneFrom(h.monthStart, h.now, sql`ep.service_id = sc.id`)}), 0)::int as month
          from service_catalog sc
          where sc.organization_id = ${org} and sc.is_active and (sc.name ilike '%limpieza%' or sc.name ilike '%profilaxis%')
          order by 4 desc, 3, 2`)),
      ]
      const main = services[0]
      if (!main)
        return {
          respuesta:
            "Subir el precio es una decisión tuya; odentIA no da consejos. Además, no hay ningún servicio de limpieza en tu lista de precios.",
          criterio: "Trampa: es un consejo y el servicio no existe.",
          datos: {},
        }
      const [charged] = await tx.execute<{ count: number; average: number | null }>(sql`
        select count(*)::int as count, avg(c.amount_cents::float / greatest(coalesce(ep.quantity, 1), 1))::float as average
        from patient_charge c join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id
        where c.organization_id = ${org} and c.voided_at is null and c.currency = ${currency} and ep.service_id = ${main.id}
          and ${between(sql`c.created_at`, yearAgo, h.now)}`)
      const [quoted] = await tx.execute<{ lines: number; accepted: number }>(sql`
        select count(*)::int as lines, count(*) filter (where ${acceptedLine})::int as accepted
        from treatment_budget b
        join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
          and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.price_cents is not null
        where b.organization_id = ${org} and ${delivered} and i.service_id = ${main.id} and i.promotion_id is null
          and ${between(sql`b.presented_at`, yearAgo, h.now)}`)
      const promo = (await promotions()).find((row) => /limpieza/.test(fold(row.name)))
      const promoReport = promo ? await promotionReport(promo) : null
      const [promoPrice] = promo
        ? await tx.execute<{ price: number | null }>(sql`
            select min(i.price_cents)::int as price from treatment_budget_item i where i.organization_id = ${org} and i.promotion_id = ${promo.id}::uuid`)
        : []
      const paid = await paidFor(h.monthStart, h.now, sql`coalesce(sep.id, spi.id) = ${main.id}`)
      const otherServices = services.slice(1)
      return {
        respuesta: `Subir el precio es una decisión tuya: odentIA no da consejos ni sabe cómo responderían tus pacientes. Lo registrado: la ${main.name} cuesta ${money(main.price)} en tu lista; en los últimos 12 meses se hizo ${plural(main.times, "vez", "veces")} (${main.before.toLocaleString(locale)} en los 12 anteriores) y se cargó en promedio ${money(Math.round(charged?.average ?? 0))} por vez; ${thisMonth} van ${main.month}.`,
        criterio:
          "Trampa: es un consejo (como g186). Se ofrecen el precio de lista de la limpieza que se usa, las veces que se hizo (atenciones firmadas) en los últimos 12 meses y en los 12 anteriores, lo cargado en promedio por vez y lo de este mes.",
        nota: `En los presupuestos entregados de los últimos 12 meses se cotizó a precio de lista ${plural(quoted?.lines ?? 0, "vez", "veces")} y se aceptó ${quoted?.accepted ?? 0} (${pct(quoted?.accepted ?? 0, quoted?.lines ?? 0)}).${promo ? ` Con la promoción «${promo.name}» (${promoSpan(promo)}${promoPrice?.price ? `, a ${money(promoPrice.price)}` : ""}) la usaron ${promoReport?.people ?? 0} personas.` : ""} Lo pagado este mes por limpiezas, sobre los pagos: ${money(paid.cents)}.${otherServices.length ? ` También están en tu lista ${listOf(otherServices.map((row) => ({ name: row.name, value: `${money(row.price)}, ${plural(row.times, "vez", "veces")} en 12 meses` })))}.` : ""}`,
        datos: {
          servicios: services,
          cargado: charged ?? null,
          presupuestos: quoted ?? null,
          promocion: promo ?? null,
          promocionReportes: promoReport,
          pagadoMes: paid,
        },
      }
    },

    y50: async () => {
      const november = monthOf(11, currentMonth <= 11 ? year : year + 1)
      const start = november.start
      const end = dayStart(tz, november.year, 12, 1)
      const [booked] = await tx.execute<{ total: number; confirmed: number }>(sql`
        select count(*)::int as total, count(*) filter (where a.status = 'confirmada')::int as confirmed from appointment a
        where a.organization_id = ${org} and a.status in ('programada','confirmada') and ${between(sql`a.starts_at`, start, end)}`)
      const coming = await upcomingWork(tx, org, currency, h.now)
      const lastNovember = await h.fig("cobrado", "total", `${november.year - 1}-11`)
      const months = await h.fig("cobrado", "mes", "mes_pasado")
      const current = await h.fig("cobrado")
      const recent = months.months.filter((month) => !month.partial).slice(-3)
      const average = recent.length
        ? recent.reduce((sum, month) => sum + (month.value.value ?? 0), 0) / recent.length
        : 0
      const owed = await h.fig("te_deben")
      return {
        respuesta: `No puedo decirte cuánto vas a cobrar en ${november.words}: odentIA no hace proyecciones. Lo registrado: en los últimos 3 meses completos cobraste en promedio ${money(Math.round(average))} al mes (${listOf(recent.map((month) => ({ name: monthLabel(h, month.month, false), value: show(months, month.value.value) })))}) y ${thisMonth} vas ${show(current)}. En ${monthLabel(h, { year: november.year - 1, month: 11 })} se cobró ${show(lastNovember)}. Para ${monthLabel(h, november, false)} ${booked?.total ? `ya hay ${plural(booked.total, "cita agendada", "citas agendadas")}` : "todavía no hay ninguna cita agendada"}.`,
        criterio:
          "Trampa: es una proyección (como x38). Se ofrecen lo cobrado de Reportes en los últimos 3 meses completos y en el mes en curso, lo cobrado en noviembre del año pasado y las citas ya agendadas para noviembre.",
        nota: `Lo aceptado en presupuestos que falta hacer («Lo que viene» de Reportes) vale ${money(coming.cents)} de ${plural(coming.patients, "paciente", "pacientes")}, sin fecha de cobro. Hoy te deben ${show(owed)}.`,
        datos: {
          citasNoviembre: booked ?? null,
          loQueViene: coming,
          noviembrePasado: lastNovember.total,
          ultimos3: recent,
          mes: current.total,
          teDeben: owed.total,
        },
      }
    },
  }
}
