import { isClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  SAAS_LOST_REASONS,
  type SaasClientOrigin,
  type SaasLostReason,
  saasClient,
  saasOpportunity,
  saasProposal,
} from "@odentia/db/schema/admin-arm"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { organization, user } from "@odentia/db/schema/auth"
import {
  saasFollowUp,
  saasPayment,
  saasPlan,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import { type SQL, sql } from "drizzle-orm"
import {
  CLIENT_ORIGIN_WORDS,
  LOST_REASON_WORDS,
  proposalLiveSql,
  proposalOfOpenSaleSql,
} from "./admin-clients.js"
import type { AdminActor } from "./admin-core.js"
import { ServiceError } from "./errors.js"
import { limaDate } from "./peru-business-days.js"
import { monthWords } from "./report-words.js"
import { getCostMarginOverview } from "./saas-cost.js"
import { moneyText } from "./saas-emails.js"

/**
 * Reportes del ARM de la administración (solo Administración): el embudo de
 * venta, los ingresos y la previsión. Solo leen y no dejan auditoría.
 *
 * - Las cifras las pone este cálculo, nunca el modelo: Kairós escribe el
 *   resumen de la semana citándolas.
 * - Cada cifra trae `howCalculated`, en palabras, para «Así se calcula».
 * - Con pocos casos (menos de 10) una proporción se dice «n de m», no en %.
 * - Las demos para presentar nunca son clientes ni cuentan (ADR 0096), y los
 *   clientes archivados no entran.
 * - Dinero en la unidad menor con su moneda ISO 4217; cada moneda se suma
 *   aparte (ADR 0135).
 * - Los meses son de America/Lima, donde trabaja el equipo.
 */

const LOCALE = "es-PE"
const DAY_MS = 86_400_000
/** Debajo de esto una proporción se dice «n de m»: un porcentaje de pocos casos engaña. */
export const REPORT_FEW_CASES = 10
export const FUNNEL_DEFAULT_MONTHS = 6
export const FUNNEL_MAX_MONTHS = 24

/* ---------- Tipos ---------- */

/** Una cifra con sus palabras y cómo se calcula. */
export interface AdminReportFigure<T = number> {
  value: T
  words: string
  howCalculated: string
}

/** Una proporción: `n` de `m`. `pct` es nulo sin casos. */
export interface ReportRatio {
  n: number
  m: number
  pct: number | null
  words: string
  howCalculated: string
}

export interface ReportMoney {
  currency: string
  cents: number
}

/** Un monto por moneda: nunca se suman monedas distintas. */
export interface ReportMoneyFigure {
  amounts: ReportMoney[]
  words: string
  howCalculated: string
}

/** Las etapas del embudo, en orden, que salen de los hechos. */
export const FUNNEL_STAGES = ["contacto", "presentacion_hecha", "propuesta", "entro"] as const
export type FunnelStage = (typeof FUNNEL_STAGES)[number]

/** Cómo terminó (o sigue) la venta de cada cliente. */
export const FUNNEL_OUTCOMES = ["entro", "no_por_ahora", "perdido", "abierta"] as const
export type FunnelOutcome = (typeof FUNNEL_OUTCOMES)[number]

export interface FunnelStageRow {
  stage: FunnelStage
  label: string
  reached: AdminReportFigure
  /** De las que llegaron a la etapa anterior, cuántas llegaron a esta; nulo en Contacto. */
  fromPrevious: ReportRatio | null
  /** Mediana de días en la etapa, de las que ya pasaron a otra; nulo en Entró. */
  medianDays: (AdminReportFigure<number | null> & { cases: number }) | null
}

export interface FunnelCohort {
  /** `YYYY-MM` del primer contacto. */
  month: string
  label: string
  clients: number
  reached: Record<FunnelStage, number>
  outcomes: Record<FunnelOutcome, number>
  conversion: ReportRatio
}

export interface FunnelGroupRow {
  key: string
  label: string
  clients: number
  outcomes: Record<FunnelOutcome, number>
  conversion: ReportRatio
}

export interface FunnelReport {
  /** Del primer día del mes más antiguo (día de Lima) a hoy. */
  from: string
  to: string
  months: number
  spanWords: string
  clients: AdminReportFigure
  conversion: ReportRatio
  stages: FunnelStageRow[]
  outcomes: Record<FunnelOutcome, AdminReportFigure & { label: string }>
  cohorts: FunnelCohort[]
  cohortsHowCalculated: string
  byOrigin: FunnelGroupRow[]
  byProduct: FunnelGroupRow[]
  byOwner: FunnelGroupRow[]
  groupsHowCalculated: string
  lostReasons: Array<{ reason: SaasLostReason; label: string; count: number }>
  lost: AdminReportFigure
}

export interface RevenueMonth {
  month: string
  label: string
  starts: number
  stops: number
}

export interface RevenueReport {
  /** `YYYY-MM` del mes en curso (Lima). */
  month: string
  monthLabel: string
  paying: AdminReportFigure
  monthlyFee: ReportMoneyFigure
  /** Cuántas de las que pagan tienen hoy un descuento negociado sobre las acciones. */
  withDiscount: AdminReportFigure
  collected: ReportMoneyFigure & { payments: number }
  movements: RevenueMonth[]
  movementsHowCalculated: string
  starts: AdminReportFigure
  stops: AdminReportFigure
  costMargin: {
    clinics: number
    chargedCents: number
    costMicros: number
    marginPct: number | null
    marginAfterCommissionPct: number | null
    /** Las que tienen la alarma de IA o son Fundadoras sin uso. */
    toReview: number
    charged: ReportMoneyFigure
    cost: AdminReportFigure
    margin: AdminReportFigure<number | null>
    marginAfterCommission: AdminReportFigure<number | null>
  }
}

export interface ForecastRow {
  proposalId: string
  clientId: string
  clientName: string
  product: string
  version: number
  planName: string
  currency: string
  /** La cuota del plan en la propuesta (precio de lista congelado). */
  monthlyCents: number
  /** Descuento sobre el precio de cada acción y cuántos meses dura (nulo: mientras dure). */
  discountBps: number
  discountMonths: number | null
  validUntil: string
  daysLeft: number
  sentAt: Date | null
}

export interface ForecastReport {
  today: string
  proposals: AdminReportFigure
  total: ReportMoneyFigure
  rows: ForecastRow[]
}

/* ---------- Palabras ---------- */

const STAGE_LABELS: Record<FunnelStage, string> = {
  contacto: "Contacto",
  presentacion_hecha: "Presentación hecha",
  propuesta: "Propuesta",
  entro: "Entró",
}

const OUTCOME_LABELS: Record<FunnelOutcome, string> = {
  entro: "Entraron",
  no_por_ahora: "No por ahora",
  perdido: "Perdidas",
  abierta: "Siguen abiertas",
}

/** «odentIA», «latidIA», «vistIA». */
function productLabel(product: string): string {
  return isClinicalProduct(product) ? productWords(product).name : product
}

function plural(count: number, one: string, many: string): string {
  return `${new Intl.NumberFormat(LOCALE).format(count)} ${count === 1 ? one : many}`
}

/** «3 de 7» con pocos casos; «43 %» con 10 o más. */
export function reportRatio(n: number, m: number, howCalculated: string): ReportRatio {
  const pct = m > 0 ? Math.round((n * 100) / m) : null
  const words =
    m === 0
      ? "Sin casos"
      : n < REPORT_FEW_CASES || m < REPORT_FEW_CASES
        ? `${n} de ${m}`
        : `${pct} %`
  return { n, m, pct, words, howCalculated }
}

function moneyFigure(
  totals: Map<string, number>,
  empty: string,
  howCalculated: string,
): ReportMoneyFigure {
  const amounts = [...totals.entries()]
    .map(([currency, cents]) => ({ currency, cents }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
  const words = amounts.length
    ? amounts.map((item) => moneyText(item.currency, item.cents)).join(" y ")
    : empty
  return { amounts, words, howCalculated }
}

function pctWords(value: number | null): string {
  return value === null ? "Sin cobros" : `${Math.round(value)} %`
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

/* ---------- Meses de Lima ---------- */

interface LimaMonth {
  year: number
  month: number
}

function limaMonthOf(now: Date): LimaMonth {
  const [year, month] = limaDate(now).split("-").map(Number)
  return { year: year as number, month: month as number }
}

function shiftMonth(value: LimaMonth, by: number): LimaMonth {
  const index = value.year * 12 + (value.month - 1) + by
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

function monthKey(value: LimaMonth): string {
  return `${value.year}-${String(value.month).padStart(2, "0")}`
}

/** El instante en que empieza un mes en Lima (UTC−5 sin cambio de hora desde 1994). */
function limaMonthStart(value: LimaMonth): Date {
  return new Date(Date.UTC(value.year, value.month - 1, 1, 5))
}

function monthLabel(value: LimaMonth, currentYear: number): string {
  return monthWords(value, LOCALE, currentYear)
}

/** Los `months` meses de Lima que terminan en el de `now`, del más antiguo al actual. */
function monthWindow(now: Date, months: number): LimaMonth[] {
  const current = limaMonthOf(now)
  return Array.from({ length: months }, (_, index) => shiftMonth(current, index - (months - 1)))
}

function monthsOption(raw: number | undefined): number {
  if (raw === undefined) return FUNNEL_DEFAULT_MONTHS
  if (!Number.isInteger(raw) || raw < 1 || raw > FUNNEL_MAX_MONTHS)
    throw new ServiceError("VALIDATION", 400, `Elige de 1 a ${FUNNEL_MAX_MONTHS} meses`, {
      months: `Elige de 1 a ${FUNNEL_MAX_MONTHS} meses`,
    })
  return raw
}

/* ---------- Permisos y filtros comunes ---------- */

function requireReportsAdmin(actor: AdminActor | null): AdminActor {
  if (!actor) throw new ServiceError("FORBIDDEN", 403, "Se requiere personal de administración")
  if (actor.role !== "admin")
    throw new ServiceError("FORBIDDEN", 403, "Los reportes son solo para Administración")
  return actor
}

/** Una organización que no es demo para presentar (ni marcada en su suscripción). */
export function notDemoOrg(orgId: SQL): SQL {
  return sql`(not exists (select 1 from ${saasDemo} d where d.organization_id = ${orgId})
    and not exists (select 1 from ${saasSubscription} ds where ds.organization_id = ${orgId} and ds.is_demo))`
}

type Rows<T> = T[]

async function rowsOf<T>(tx: Db, query: SQL): Promise<Rows<T>> {
  return (await tx.execute(query)) as unknown as Rows<T>
}

/* ---------- Embudo ---------- */

interface FunnelFactRow {
  id: string
  product: string
  origin: string
  ownerId: string | null
  ownerName: string | null
  month: string
  contactAt: number
  presentationAt: number | null
  proposalAt: number | null
  enteredAt: number | null
  isOpen: boolean
  lastDecision: string | null
}

const COHORT_HOW =
  "Cada fila es un mes del primer contacto: el día en que la clínica pasó a ser cliente (la solicitud de la web, la cuenta que abrió o el alta a mano). Una clínica que llegó a una etapa más adelante cuenta como que pasó por las anteriores, aunque se las haya saltado (por ejemplo, entró sin presentación)."

const GROUPS_HOW =
  "Las clínicas cuyo primer contacto cae en esos meses, por cómo llegaron, por producto y por su responsable de hoy. «Entraron» son las que tienen cuenta o una venta cerrada como «Entró»; «No por ahora» y «Perdidas», las que tienen esa decisión en su última venta cerrada y ninguna abierta; las demás siguen abiertas."

function reachedLevel(row: FunnelFactRow): number {
  if (row.enteredAt !== null) return 3
  if (row.proposalAt !== null) return 2
  if (row.presentationAt !== null) return 1
  return 0
}

function outcomeOf(row: FunnelFactRow): FunnelOutcome {
  if (row.enteredAt !== null) return "entro"
  if (row.isOpen) return "abierta"
  if (row.lastDecision === "no_por_ahora" || row.lastDecision === "perdido") return row.lastDecision
  return "abierta"
}

function emptyOutcomes(): Record<FunnelOutcome, number> {
  return { entro: 0, no_por_ahora: 0, perdido: 0, abierta: 0 }
}

function groupRows(
  rows: FunnelFactRow[],
  keyOf: (row: FunnelFactRow) => string,
  labelOf: (key: string, row: FunnelFactRow) => string,
): FunnelGroupRow[] {
  const groups = new Map<string, { label: string; rows: FunnelFactRow[] }>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key) ?? { label: labelOf(key, row), rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const outcomes = emptyOutcomes()
      for (const row of group.rows) outcomes[outcomeOf(row)] += 1
      return {
        key,
        label: group.label,
        clients: group.rows.length,
        outcomes,
        conversion: reportRatio(
          outcomes.entro,
          group.rows.length,
          "De las clínicas de este grupo que llegaron en esos meses, cuántas entraron.",
        ),
      }
    })
    .sort((a, b) => b.clients - a.clients || a.label.localeCompare(b.label, LOCALE))
}

/**
 * El embudo de venta agrupado por el mes del primer contacto (`saas_client.created_at`).
 * La etapa alcanzada sale de los hechos, nunca de un campo que alguien mueva:
 * presentación hecha = una actividad `presentacion`; propuesta = una
 * propuesta enviada (o una invitación de la lista de espera); entró = la
 * cuenta o la venta cerrada como «Entró».
 */
export async function funnelReport(
  tx: Db,
  actor: AdminActor | null,
  options: { months?: number } = {},
  now = new Date(),
): Promise<FunnelReport> {
  requireReportsAdmin(actor)
  const months = monthsOption(options.months)
  const window = monthWindow(now, months)
  const first = window[0] as LimaMonth
  const current = window[window.length - 1] as LimaMonth
  const from = limaMonthStart(first)
  const epoch = (value: SQL) => sql`(extract(epoch from ${value}) * 1000)::float8`
  const cohortFilter = sql`c.archived_at is null
    and c.created_at >= ${from.toISOString()}::timestamptz
    and c.created_at <= ${now.toISOString()}::timestamptz
    and (c.organization_id is null or ${notDemoOrg(sql`c.organization_id`)})`

  const facts = await rowsOf<FunnelFactRow>(
    tx,
    sql`select c.id, c.product, c.origin, c.owner_user_id as "ownerId", u.name as "ownerName",
        to_char(c.created_at at time zone 'America/Lima', 'YYYY-MM') as month,
        ${epoch(sql`c.created_at`)} as "contactAt",
        ${epoch(sql`(select min(f.happened_at) from ${saasFollowUp} f where f.client_id = c.id and f.kind = 'presentacion')`)} as "presentationAt",
        ${epoch(sql`least(
          (select min(coalesce(p.sent_at, p.decided_at, p.updated_at)) from ${saasProposal} p
            where p.client_id = c.id and p.status in ('enviada', 'aceptada', 'no_aceptada')),
          (select min(r.invited_at) from ${saasWaitlistRequest} r where r.client_id = c.id))`)} as "proposalAt",
        ${epoch(sql`coalesce(
          (select min(o.decided_at) from ${saasOpportunity} o where o.client_id = c.id and o.decision = 'entro'),
          org.created_at)`)} as "enteredAt",
        exists (select 1 from ${saasOpportunity} o where o.client_id = c.id and o.decision is null) as "isOpen",
        (select o.decision from ${saasOpportunity} o where o.client_id = c.id and o.decision is not null
          order by o.decided_at desc limit 1) as "lastDecision"
      from ${saasClient} c
      left join ${user} u on u.id = c.owner_user_id
      left join ${organization} org on org.id = c.organization_id
      where ${cohortFilter}`,
  )

  const lostRows = await rowsOf<{ reason: string; count: number }>(
    tx,
    sql`select o.reason, count(*)::int as count
      from ${saasOpportunity} o join ${saasClient} c on c.id = o.client_id
      where o.decision = 'perdido' and ${cohortFilter}
      group by o.reason`,
  )

  // Etapas alcanzadas y días en cada una (de un hecho al siguiente que sí ocurrió).
  const reached = [0, 0, 0, 0]
  const stageDays: number[][] = [[], [], []]
  const outcomes = emptyOutcomes()
  const cohorts = new Map(
    window.map((value) => [
      monthKey(value),
      { clients: 0, reached: [0, 0, 0, 0], outcomes: emptyOutcomes() },
    ]),
  )
  for (const row of facts) {
    const level = reachedLevel(row)
    for (let stage = 0; stage <= level; stage += 1) reached[stage] = (reached[stage] ?? 0) + 1
    const outcome = outcomeOf(row)
    outcomes[outcome] += 1
    const cohort = cohorts.get(row.month)
    if (cohort) {
      cohort.clients += 1
      for (let stage = 0; stage <= level; stage += 1)
        cohort.reached[stage] = (cohort.reached[stage] ?? 0) + 1
      cohort.outcomes[outcome] += 1
    }
    const dated = [row.contactAt, row.presentationAt, row.proposalAt, row.enteredAt]
    let previous = 0
    for (let stage = 1; stage < dated.length; stage += 1) {
      const at = dated[stage]
      if (at === null || at === undefined) continue
      const since = dated[previous] as number
      stageDays[previous]?.push(Math.max(0, (at - since) / DAY_MS))
      previous = stage
    }
  }

  const stageHow: Record<FunnelStage, string> = {
    contacto:
      "Todas las clínicas cuyo primer contacto cae en esos meses, sin las demos ni las archivadas.",
    presentacion_hecha:
      "Las que tienen anotada una presentación (una actividad de tipo presentación), o que llegaron más adelante.",
    propuesta:
      "Las que recibieron una propuesta (enviada, aceptada o no aceptada) o una invitación de la lista de espera, o que ya entraron.",
    entro: "Las que tienen cuenta o una venta cerrada como «Entró».",
  }
  const stages: FunnelStageRow[] = FUNNEL_STAGES.map((stage, index) => {
    const count = reached[index] ?? 0
    const days = index < 3 ? (stageDays[index] ?? []) : null
    const value = days ? median(days) : null
    return {
      stage,
      label: STAGE_LABELS[stage],
      reached: {
        value: count,
        words: plural(count, "clínica", "clínicas"),
        howCalculated: stageHow[stage],
      },
      fromPrevious:
        index === 0
          ? null
          : reportRatio(
              count,
              reached[index - 1] ?? 0,
              `De las que llegaron a «${STAGE_LABELS[FUNNEL_STAGES[index - 1] as FunnelStage]}», cuántas llegaron a «${STAGE_LABELS[stage]}».`,
            ),
      medianDays: days
        ? {
            value: value === null ? null : Math.round(value),
            cases: days.length,
            words:
              value === null
                ? "Sin casos"
                : `${plural(Math.round(value), "día", "días")}${days.length < REPORT_FEW_CASES ? ` (${plural(days.length, "caso", "casos")})` : ""}`,
            howCalculated: `La mediana de los días entre llegar a «${STAGE_LABELS[stage]}» y el siguiente paso que sí ocurrió, solo de las que ya lo dieron: la mitad tardó menos y la otra mitad más. Las que siguen en esta etapa no cuentan.`,
          }
        : null,
    }
  })

  const outcomeHow: Record<FunnelOutcome, string> = {
    entro: "Tienen cuenta o su venta se cerró como «Entró».",
    no_por_ahora: "Su última venta cerrada dice «No por ahora» y no tienen otra abierta.",
    perdido: "Su última venta cerrada dice «Perdido» y no tienen otra abierta.",
    abierta: "Tienen una venta abierta o todavía no hay una decisión.",
  }
  const outcomeFigures = Object.fromEntries(
    FUNNEL_OUTCOMES.map((key) => [
      key,
      {
        label: OUTCOME_LABELS[key],
        value: outcomes[key],
        words: plural(outcomes[key], "clínica", "clínicas"),
        howCalculated: outcomeHow[key],
      },
    ]),
  ) as Record<FunnelOutcome, AdminReportFigure & { label: string }>

  const lostTotal = lostRows.reduce((sum, row) => sum + Number(row.count), 0)
  const lostReasons = SAAS_LOST_REASONS.map((reason) => ({
    reason,
    label: LOST_REASON_WORDS[reason],
    count: Number(lostRows.find((row) => row.reason === reason)?.count ?? 0),
  }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)

  const total = facts.length
  return {
    from: limaDate(from),
    to: limaDate(now),
    months,
    spanWords:
      months === 1
        ? monthLabel(current, current.year)
        : `${monthLabel(first, current.year)} a ${monthLabel(current, current.year)}`,
    clients: {
      value: total,
      words: plural(total, "clínica", "clínicas"),
      howCalculated: stageHow.contacto,
    },
    conversion: reportRatio(
      outcomes.entro,
      total,
      "De las clínicas cuyo primer contacto cae en esos meses, cuántas entraron (tienen cuenta o su venta se cerró como «Entró»).",
    ),
    stages,
    outcomes: outcomeFigures,
    cohorts: window.map((value) => {
      const key = monthKey(value)
      const cohort = cohorts.get(key) ?? {
        clients: 0,
        reached: [0, 0, 0, 0],
        outcomes: emptyOutcomes(),
      }
      return {
        month: key,
        label: monthLabel(value, current.year),
        clients: cohort.clients,
        reached: Object.fromEntries(
          FUNNEL_STAGES.map((stage, index) => [stage, cohort.reached[index] ?? 0]),
        ) as Record<FunnelStage, number>,
        outcomes: cohort.outcomes,
        conversion: reportRatio(
          cohort.outcomes.entro,
          cohort.clients,
          "De las clínicas de ese mes, cuántas entraron. Un mes reciente todavía tiene ventas abiertas.",
        ),
      }
    }),
    cohortsHowCalculated: COHORT_HOW,
    byOrigin: groupRows(
      facts,
      (row) => row.origin,
      (key) => CLIENT_ORIGIN_WORDS[key as SaasClientOrigin] ?? key,
    ),
    byProduct: groupRows(
      facts,
      (row) => row.product,
      (key) => productLabel(key),
    ),
    byOwner: groupRows(
      facts,
      (row) => row.ownerId ?? "sin",
      (key, row) => (key === "sin" ? "Sin responsable" : (row.ownerName ?? "Sin nombre")),
    ),
    groupsHowCalculated: GROUPS_HOW,
    lostReasons,
    lost: {
      value: lostTotal,
      words: plural(lostTotal, "venta perdida", "ventas perdidas"),
      howCalculated:
        "Las ventas cerradas como «Perdido» de las clínicas cuyo primer contacto cae en esos meses, contadas por el motivo que eligió quien la cerró. Una clínica que se perdió dos veces cuenta dos.",
    },
  }
}

/* ---------- Ingresos ---------- */

/** Pagan: suscripción activa o en gracia, sin demo, con al menos un pago confirmado (la misma regla que «Paga»). */
function payingSql(sub: SQL): SQL {
  return sql`${sub}.status in ('activa', 'gracia') and not ${sub}.is_demo
    and ${notDemoOrg(sql`${sub}.organization_id`)}
    and exists (select 1 from ${saasPayment} pp where pp.organization_id = ${sub}.organization_id and pp.status = 'confirmado')`
}

/**
 * Ingresos de Sallca: la cuota mensual de las clínicas que pagan, lo cobrado y
 * confirmado en el mes, las altas y bajas por mes y el costo y el margen
 * (la misma cuenta de «Costo y margen», `getCostMarginOverview`).
 *
 * La cuota es el precio del plan: el descuento negociado rige sobre el precio
 * de cada acción, no sobre la cuota (así cobra la plataforma, `saas-terms.ts`),
 * por eso se cuenta aparte cuántas lo tienen vigente.
 */
export async function revenueReport(
  tx: Db,
  actor: AdminActor | null,
  now = new Date(),
  options: { months?: number } = {},
): Promise<RevenueReport> {
  requireReportsAdmin(actor)
  const months = monthsOption(options.months)
  const window = monthWindow(now, months)
  const current = window[window.length - 1] as LimaMonth
  const monthStart = limaMonthStart(current)
  const windowStart = limaMonthStart(window[0] as LimaMonth)
  const nowText = now.toISOString()

  const fees = await rowsOf<{
    currency: string
    cents: string | number
    clinics: number
    discounted: number
  }>(
    tx,
    sql`select p.currency, sum(p.price_cents)::bigint as cents, count(*)::int as clinics,
        count(*) filter (where s.discount_bps > 0
          and (s.discount_ends_at is null or s.discount_ends_at > ${nowText}::timestamptz))::int as discounted
      from ${saasSubscription} s join ${saasPlan} p on p.id = s.plan_id
      where ${payingSql(sql`s`)}
      group by p.currency`,
  )
  const collectedRows = await rowsOf<{
    currency: string
    cents: string | number
    payments: number
  }>(
    tx,
    sql`select pay.currency, sum(pay.amount_cents)::bigint as cents, count(*)::int as payments
      from ${saasPayment} pay
      where pay.status = 'confirmado'
        and pay.confirmed_at >= ${monthStart.toISOString()}::timestamptz
        and pay.confirmed_at <= ${nowText}::timestamptz
        and ${notDemoOrg(sql`pay.organization_id`)}
      group by pay.currency`,
  )
  const startRows = await rowsOf<{ month: string; count: number }>(
    tx,
    sql`select to_char(first_paid at time zone 'America/Lima', 'YYYY-MM') as month, count(*)::int as count
      from (select pay.organization_id, min(pay.confirmed_at) as first_paid
        from ${saasPayment} pay
        where pay.status = 'confirmado' and ${notDemoOrg(sql`pay.organization_id`)}
        group by pay.organization_id) firsts
      where first_paid >= ${windowStart.toISOString()}::timestamptz and first_paid <= ${nowText}::timestamptz
      group by 1`,
  )
  const stopRows = await rowsOf<{ month: string; count: number }>(
    tx,
    sql`select to_char(s.updated_at at time zone 'America/Lima', 'YYYY-MM') as month, count(*)::int as count
      from ${saasSubscription} s
      where s.status = 'cancelada' and not s.is_demo and ${notDemoOrg(sql`s.organization_id`)}
        and s.updated_at >= ${windowStart.toISOString()}::timestamptz and s.updated_at <= ${nowText}::timestamptz
      group by 1`,
  )

  const paying = fees.reduce((sum, row) => sum + Number(row.clinics), 0)
  const discounted = fees.reduce((sum, row) => sum + Number(row.discounted), 0)
  const payments = collectedRows.reduce((sum, row) => sum + Number(row.payments), 0)
  const label = monthLabel(current, current.year)
  const movements = window.map((value) => {
    const key = monthKey(value)
    return {
      month: key,
      label: monthLabel(value, current.year),
      starts: Number(startRows.find((row) => row.month === key)?.count ?? 0),
      stops: Number(stopRows.find((row) => row.month === key)?.count ?? 0),
    }
  })
  const starts = movements.reduce((sum, row) => sum + row.starts, 0)
  const stops = movements.reduce((sum, row) => sum + row.stops, 0)

  const overview = await getCostMarginOverview(tx, now)
  const costCents = Math.round(overview.costMicros / 10_000)
  const chargedByCurrency = new Map<string, number>()
  for (const clinic of overview.clinics)
    chargedByCurrency.set(
      clinic.currency,
      (chargedByCurrency.get(clinic.currency) ?? 0) + clinic.chargedCents,
    )
  const marginHow =
    "Es la misma cuenta de «Costo y margen»: lo facturado sin impuesto en lo que va del mes de cada clínica activa o en gracia, la cuota y lo que pasó del crédito, se haya pagado o no (sin demos, y la prueba no se cobra), frente a lo que nos costó: la IA que reportó cada proveedor, el espacio guardado y una parte estimada del servidor y los gastos fijos."

  return {
    month: monthKey(current),
    monthLabel: label,
    paying: {
      value: paying,
      words: plural(paying, "clínica paga", "clínicas pagan"),
      howCalculated:
        "Las clínicas con la suscripción activa o en gracia y al menos un pago confirmado, sin las demos. Una cuenta en prueba o que nunca pagó no cuenta, aunque esté activa.",
    },
    monthlyFee: moneyFigure(
      new Map(fees.map((row) => [row.currency, Number(row.cents)])),
      "Ninguna paga todavía",
      "La suma de la cuota del plan de cada clínica que paga, en la moneda del plan. El descuento negociado se aplica al precio de cada acción, no a la cuota, así que no la baja. Lo que pasa del crédito del plan se cobra aparte y no está aquí.",
    ),
    withDiscount: {
      value: discounted,
      words: plural(discounted, "con descuento", "con descuento"),
      howCalculated:
        "De las que pagan, cuántas tienen hoy un descuento negociado sobre el precio de las acciones que no ha vencido.",
    },
    collected: {
      ...moneyFigure(
        new Map(collectedRows.map((row) => [row.currency, Number(row.cents)])),
        `Nada en ${label}`,
        `Los pagos confirmados por la administración entre el 1 de ${label} y hoy (día de Lima), en su moneda, sin las demos. Un pago reversado o devuelto ya no cuenta; un comprobante por revisar, todavía no.`,
      ),
      payments,
    },
    movements,
    movementsHowCalculated:
      "Altas: el mes del primer pago confirmado de cada clínica, que es cuando empieza a pagar. Bajas: las suscripciones canceladas, en el mes de su último cambio. Sin las demos.",
    starts: {
      value: starts,
      words: plural(starts, "alta", "altas"),
      howCalculated: "Las clínicas cuyo primer pago confirmado cae en esos meses, sin las demos.",
    },
    stops: {
      value: stops,
      words: plural(stops, "baja", "bajas"),
      howCalculated:
        "Las suscripciones canceladas en esos meses (por la fecha de su último cambio), sin las demos. Pausada o restringida no es una baja.",
    },
    costMargin: {
      clinics: overview.clinics.length,
      chargedCents: overview.chargedCents,
      costMicros: overview.costMicros,
      marginPct: overview.marginPct,
      marginAfterCommissionPct: overview.marginAfterCommissionPct,
      toReview: overview.clinics.filter((item) => item.alarm || item.idle).length,
      charged: moneyFigure(chargedByCurrency, "Nada todavía", marginHow),
      cost: {
        value: overview.costMicros,
        // Lo que reportan los proveedores y los gastos fijos están en USD (`saas-cost.ts`).
        words: moneyText("USD", costCents),
        howCalculated: marginHow,
      },
      margin: {
        value: overview.marginPct,
        words: pctWords(overview.marginPct),
        howCalculated: marginHow,
      },
      marginAfterCommission: {
        value: overview.marginAfterCommissionPct,
        words: pctWords(overview.marginAfterCommissionPct),
        howCalculated: `${marginHow} Después de comisiones, además, se resta lo que se lleva cada vendedor.`,
      },
    },
  }
}

/* ---------- Previsión ---------- */

interface ForecastSqlRow {
  proposalId: string
  clientId: string
  clientName: string
  product: string
  version: number
  planName: string
  currency: string
  monthlyCents: number
  discountBps: number
  discountMonths: number | null
  validUntil: string
  sentAt: Date | string | null
}

/**
 * Cuánto sumaría la cuota de las propuestas vigentes si entran, sin inventar
 * probabilidades: la última propuesta enviada y vigente de cada cliente sin
 * cuenta, a su precio de lista congelado.
 */
export async function forecastReport(
  tx: Db,
  actor: AdminActor | null,
  now = new Date(),
): Promise<ForecastReport> {
  requireReportsAdmin(actor)
  const today = limaDate(now)
  const rows = await rowsOf<ForecastSqlRow>(
    tx,
    sql`select distinct on (p.client_id)
        p.id as "proposalId", p.client_id as "clientId", c.name as "clientName", c.product,
        p.version, pl.name as "planName", p.currency, p.list_price_cents as "monthlyCents",
        p.discount_bps as "discountBps", p.discount_months as "discountMonths",
        to_char(p.valid_until, 'YYYY-MM-DD') as "validUntil", p.sent_at as "sentAt"
      from ${saasProposal} p
      join ${saasClient} c on c.id = p.client_id
      join ${saasPlan} pl on pl.id = p.plan_id
      -- Solo la última vigente (una que reemplazó otra versión no suma dos veces) y de la venta
      -- abierta: la de una venta perdida o en «no por ahora» ya no está en juego.
      where ${proposalLiveSql(today)} and ${proposalOfOpenSaleSql()}
        and c.archived_at is null and c.organization_id is null
      order by p.client_id, p.version desc`,
  )
  const items: ForecastRow[] = rows
    .map((row) => ({
      proposalId: row.proposalId,
      clientId: row.clientId,
      clientName: row.clientName,
      product: row.product,
      version: Number(row.version),
      planName: row.planName,
      currency: row.currency,
      monthlyCents: Number(row.monthlyCents),
      discountBps: Number(row.discountBps),
      discountMonths: row.discountMonths === null ? null : Number(row.discountMonths),
      validUntil: row.validUntil,
      daysLeft: Math.round(
        (Date.parse(`${row.validUntil}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
      ),
      sentAt: row.sentAt === null ? null : new Date(row.sentAt),
    }))
    .sort(
      (a, b) =>
        a.validUntil.localeCompare(b.validUntil) ||
        a.clientName.localeCompare(b.clientName, LOCALE),
    )
  const totals = new Map<string, number>()
  for (const item of items)
    totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.monthlyCents)
  return {
    today,
    proposals: {
      value: items.length,
      words: plural(items.length, "propuesta vigente", "propuestas vigentes"),
      howCalculated:
        "Las propuestas enviadas que no se han respondido y cuya vigencia llega a hoy o después, de clínicas que todavía no tienen cuenta y con la venta abierta: la de una venta perdida o en «no por ahora» no cuenta. Si una clínica tiene varias, cuenta solo la última versión.",
    },
    total: moneyFigure(
      totals,
      "Ninguna propuesta vigente",
      "La cuota mensual que sumarían esas propuestas si todas entran, en su moneda: el precio de lista del plan que quedó en cada una. No es una predicción: no se le pone a nadie una probabilidad. El descuento de una propuesta rige sobre el precio de cada acción, no sobre la cuota, así que no la cambia.",
    ),
    rows: items,
  }
}
