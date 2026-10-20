/**
 * Las cifras que Argos sabe responder (ADR 0070): unas 30, declaradas una
 * sola vez. Cada una dice qué pregunta responde, cómo se calcula, por qué se
 * puede agrupar y qué hace falta para verla, y se calcula con la misma
 * consulta de su pestaña (`collectedNetMany`, `appointmentTotalsMany`,
 * `funnelMany`…): la respuesta de Argos, la tarjeta y su lista dicen lo mismo.
 *
 * Ninguna cifra sale de un modelo. El modelo de decisión solo elige la clave
 * de una de estas cifras y cómo agruparla (`report-questions.ts`); aquí se
 * calcula, y la frase sale de una plantilla con lo calculado.
 */
import { REFERRAL_KIND_LABELS, type ReferralKind } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { collectedByProfessional, collectedNetMany } from "./finance.js"
import { unpaidPurchasesMany } from "./purchase-balance.js"
import { agentBillingMany, agentBookedMany, agentCollectedMany, agentConversationsMany, agentDictatedMany, agentRecoveredMany, collectedIn, firstResponsesMany } from "./report-agent.js"
import { appointmentsByProfessional, occupancyMany } from "./report-agenda.js"
import {
  collectedByMethod,
  collectedByTreatment,
  commissionsMany,
  commissionsOwedMany,
  DEBT_AGES,
  debtAgingMany,
  expensesMany,
  newPatientValue,
  upcomingWork,
} from "./report-finance.js"
import { activePatientsMany, funnelMany, lapsedCount, referralMany, returnedMany, STOPPED_WRITING_DAYS } from "./report-patients.js"
import { lastMonths, reportDayOf, type ReportSpan, type YearMonth } from "./report-periods.js"
import type { ReportScope, Span } from "./report-scope.js"
import { budgetAcceptanceMany, getReportProfessionals, overdueDebtMany } from "./report-summary.js"
import {
  absoluteChangeWords,
  capitalize,
  countWords,
  hoursWords,
  minutesWords,
  moneyWords,
  monthWords,
  POINT_WORDS,
  percentWords,
  previousWords,
  rateOf,
  relativeChangeWords,
  spanWords,
  whole,
} from "./report-words.js"
import { appointmentTotalsMany, controlTotals, newPatientsMany, waitInRoom } from "./reports.js"
import { OVERDUE_DAYS } from "./report-debts.js"

// --- Lo que se puede preguntar -------------------------------------------------------------

export const FIGURE_AREAS = ["dinero", "pacientes", "agenda", "agente"] as const
export type FigureArea = (typeof FIGURE_AREAS)[number]

/** Cómo se agrupa una cifra: `total` es una sola cifra, con su comparación y su línea de 12 meses. */
export const FIGURE_GROUPS = ["total", "mes", "sede", "profesional", "canal", "medio", "tratamiento", "categoria", "como_nos_conocio", "antiguedad"] as const
export type FigureGroup = (typeof FIGURE_GROUPS)[number]

export const FIGURE_GROUP_WORDS: Record<FigureGroup, string> = {
  total: "En total",
  mes: "Por mes",
  sede: "Por sede",
  profesional: "Por profesional",
  canal: "Por canal",
  medio: "Por medio de pago",
  tratamiento: "Por tratamiento",
  categoria: "Por tipo de gasto",
  como_nos_conocio: "Por cómo nos conocieron",
  antiguedad: "Por antigüedad",
}

/** Lo que viaja de una cifra: centavos de la moneda, un conteo, un porcentaje entero o minutos. */
export type FigureUnit = "money" | "count" | "rate" | "minutes" | "hours"

/** Una cifra calculada: `value` nulo si no hay con qué calcularla (sin citas, sin horario…). */
export interface FigureValue {
  value: number | null
  /** En un porcentaje, la parte y el total («11 de 81»); en un conteo, una parte que se destaca. */
  part?: number
  whole?: number
}

export interface FigureRow {
  key: string
  label: string
  value: FigureValue
}

export interface FigureContext {
  tx: Db
  orgId: string
  scope: ReportScope
  /** Quien pregunta ve lo que la clínica le paga a odentIA (`seesBilling`). */
  billing: boolean
}

/** La lista de personas detrás de una cifra, la misma que abre su tarjeta. */
interface FigureList {
  key: string
  noun: { one: string; many: string }
  feminine: boolean
  /** Cuántas filas tiene la lista para esta cifra. */
  count: (total: FigureValue) => number
  /** «¿Quiénes no vinieron?»: la pregunta que la abre. */
  question?: string
}

export interface ReportFigure {
  key: string
  area: FigureArea
  /** Nombre corto, como lo dice su tarjeta: «No vinieron». */
  name: string
  /** Para el modelo de decisión: qué pregunta responde, con las palabras de quien pregunta. */
  describes: string
  /** «Así lo calculé». */
  how: string
  unit: FigureUnit
  /** En un conteo o un porcentaje, de qué se cuenta: «cita», «persona». */
  noun?: { one: string; many: string }
  /** La pestaña donde se mira entera. */
  tab: "resumen" | "finanzas" | "pacientes" | "agenda" | "agente"
  /** Cómo más se puede agrupar, además de `total`. */
  groups: FigureGroup[]
  /** Con esa agrupación se responde cuando no se pidió otra: una lista de canales no es una sola cifra. */
  defaultGroup?: FigureGroup
  /**
   * La cifra que responde si se pide esta agrupación y esta no la tiene: los
   * pacientes nuevos «por Instagram» son los que nos buscaron por ese canal.
   */
  insteadFor?: Partial<Record<FigureGroup, string>>
  /** No pertenece a una sede (conversaciones, presupuestos, controles). */
  wholeClinic?: boolean
  /** Se mide al cierre de cada tramo (lo que se debe), no durante. */
  atClose?: boolean
  /** Es lo de hoy: sin comparación ni línea de 12 meses. */
  asOfToday?: boolean
  /** Solo para quien ve Facturación. */
  billing?: boolean
  /** Mejor si sube (`up`) o si baja (`down`). */
  better: "up" | "down"
  list?: FigureList
  /** La pregunta de Reportes con un aviso de Argos al lado (`getReportAdvice`). */
  advice?: "dinero" | "agenda" | "ventas"
  /** La cifra para varios tramos a la vez; con `branchId`, de esa sede. */
  values: (ctx: FigureContext, spans: Span[], branchId: string | undefined) => Promise<FigureValue[]>
  /** El periodo repartido por otra cosa que el mes o la sede. */
  breakdown?: (ctx: FigureContext, group: FigureGroup, branchId: string | undefined) => Promise<FigureRow[]>
  /** La moneda de la cifra si no es la de la clínica: lo pagado a odentIA va en la del plan. */
  moneyIn?: (ctx: FigureContext) => Promise<string | null>
  /** Una frase propia cuando la de la plantilla no alcanza (lo que trajo el agente, un canal). */
  sentence?: (ctx: FigureContext, result: FigureResult, branchId: string | undefined) => Promise<Sentence | null>
}

// --- Ayudas para declarar cifras ---------------------------------------------------------

type Money = Array<{ currency: string; cents: number }>

function centsIn(list: Money | undefined, currency: string): number {
  return list?.find((item) => item.currency === currency)?.cents ?? 0
}

function branchScope(branchId: string | undefined): { branch: { id: string; name: string } | null } {
  return { branch: branchId ? { id: branchId, name: "" } : null }
}

function rateValue(part: number, total: number): FigureValue {
  return { value: rateOf(part, total), part, whole: total }
}

function count(value: number): FigureValue {
  return { value }
}

function money(cents: number): FigureValue {
  return { value: cents }
}

async function userNames(tx: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await tx.execute<{ id: string; name: string }>(sql`select id, name from "user" where id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
  return new Map([...rows].map((row) => [row.id, row.name]))
}

const PEOPLE = { one: "persona", many: "personas" }
const PATIENTS = { one: "paciente", many: "pacientes" }
const APPOINTMENTS = { one: "cita", many: "citas" }
const CONVERSATIONS = { one: "conversación", many: "conversaciones" }

/** Por dónde escribieron, como lo dice la pantalla. */
const CHANNEL_WORDS: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  messenger: "Messenger",
  instagram: "Instagram",
  email: "Correo",
  gmail: "Gmail",
  microsoft365: "Microsoft 365",
  webchat: "Chat web",
  web_chat: "Chat web",
  recepcion: "Recepción",
  registro_en_linea: "Registro en línea",
}

export function channelWords(channel: string | null): string {
  return channel ? (CHANNEL_WORDS[channel] ?? channel) : "Canal retirado"
}

const EXPENSE_WORDS: Record<string, string> = { comision: "Pago de comisiones", compra: "Compras de Inventario" }

/** Las citas de cada profesional en el periodo (la regla de la pestaña Agenda). */
async function byProfessional(ctx: FigureContext, branchId: string | undefined, pick: (row: { attended: number; noShow: number; cancelled: number; unmarked: number }) => FigureValue): Promise<FigureRow[]> {
  const rows = await appointmentsByProfessional(ctx.tx, ctx.orgId, ctx.scope.window, ctx.scope.now, branchId)
  return rows.map((row) => ({ key: row.userId, label: row.name, value: pick(row) }))
}

async function occupancyByProfessional(ctx: FigureContext, branchId: string | undefined, pick: (row: { availMin: number; occMin: number }) => FigureValue): Promise<FigureRow[]> {
  const [occupancy] = await occupancyMany(ctx.tx, ctx.orgId, [ctx.scope.window], { branchId })
  const rows = (occupancy?.byProfessional ?? []).filter((row) => row.availMin > 0)
  const names = await userNames(ctx.tx, rows.map((row) => row.userId))
  return rows.map((row) => ({ key: row.userId, label: names.get(row.userId) ?? "", value: pick(row) }))
}

// --- El catálogo -------------------------------------------------------------------------

export const REPORT_FIGURES: ReportFigure[] = [
  // ---------------- Dinero ----------------
  {
    key: "cobrado",
    area: "dinero",
    name: "Lo cobrado",
    describes: "Cuánto se cobró, «cuánto gané» o «cuánto vendimos»: lo que pagaron los pacientes, las ventas, los ingresos; también cómo pagaron (efectivo, tarjeta, transferencia) o qué tratamiento dejó más.",
    how: "Pagos del periodo menos lo anulado y lo devuelto, en la moneda de la clínica. Por profesional, solo lo de sus atenciones: la base de las comisiones.",
    unit: "money",
    tab: "finanzas",
    better: "up",
    groups: ["mes", "sede", "profesional", "medio", "tratamiento"],
    values: async (ctx, spans, branchId) =>
      (await collectedNetMany(ctx.tx, ctx.orgId, spans, { branchId })).map((list) => money(centsIn(list, ctx.scope.currency))),
    breakdown: async (ctx, group, branchId) => {
      const { window, currency } = ctx.scope
      if (group === "profesional") {
        const rows = await collectedByProfessional(ctx.tx, ctx.orgId, { start: window.start, end: window.end, branchId }, currency)
        return rows.map((row) => ({ key: row.professionalUserId, label: row.name ?? "", value: money(row.cobradoCents) }))
      }
      if (group === "medio") {
        const { methods } = await collectedByMethod(ctx.tx, ctx.orgId, window, { currency, branchId })
        return methods.map((row) => ({ key: row.label, label: row.label, value: money(row.cents) }))
      }
      const { rows, others } = await collectedByTreatment(ctx.tx, ctx.orgId, window, { currency, branchId })
      return [
        ...rows.map((row) => ({ key: row.name, label: row.name, value: money(row.cents) })),
        ...(others ? [{ key: "otros", label: `Otros (${others.count})`, value: money(others.cents) }] : []),
      ]
    },
  },
  {
    key: "lo_que_deja",
    area: "dinero",
    name: "Lo que deja",
    describes: "Cuánto queda después de pagar gastos y comisiones, «cuánto me queda»: la utilidad o ganancia neta del periodo.",
    how: "Lo cobrado menos las comisiones generadas y menos los demás gastos del periodo (el pago de comisiones ya está contado en ellas).",
    unit: "money",
    tab: "finanzas",
    better: "up",
    insteadFor: { tratamiento: "cobrado", medio: "cobrado", profesional: "cobrado" },
    groups: ["mes", "sede"],
    values: async (ctx, spans, branchId) => {
      const { currency } = ctx.scope
      const collected = await collectedNetMany(ctx.tx, ctx.orgId, spans, { branchId })
      const commissions = await commissionsMany(ctx.tx, ctx.orgId, spans, { currency, branchId })
      const expenses = await expensesMany(ctx.tx, ctx.orgId, spans, { branchId })
      return spans.map((_, index) => {
        const spent = expenses[index]?.find((item) => item.currency === currency)
        const generated = (commissions[index] ?? []).reduce((total, item) => total + item.commissionCents, 0)
        return money(centsIn(collected[index], currency) - generated - ((spent?.totalCents ?? 0) - (spent?.commissionPaidCents ?? 0)))
      })
    },
  },
  {
    key: "gastos",
    area: "dinero",
    name: "Lo gastado",
    describes: "Cuánto se gastó: los gastos o egresos registrados (alquiler, laboratorio, materiales, sueldos…).",
    how: "Gastos registrados en Finanzas en el periodo, menos los anulados. El pago de comisiones va aparte, en Comisiones.",
    unit: "money",
    tab: "finanzas",
    better: "down",
    groups: ["mes", "sede", "categoria"],
    values: async (ctx, spans, branchId) =>
      (await expensesMany(ctx.tx, ctx.orgId, spans, { branchId })).map((list) => {
        const spent = list.find((item) => item.currency === ctx.scope.currency)
        return money((spent?.totalCents ?? 0) - (spent?.commissionPaidCents ?? 0))
      }),
    breakdown: async (ctx, _group, branchId) => {
      const [list] = await expensesMany(ctx.tx, ctx.orgId, [ctx.scope.window], { branchId })
      const spent = list?.find((item) => item.currency === ctx.scope.currency)
      return (spent?.byCategory ?? []).map((row) => ({ key: row.category, label: EXPENSE_WORDS[row.category] ?? row.category, value: money(row.cents) }))
    },
  },
  {
    key: "comisiones",
    area: "dinero",
    name: "Las comisiones",
    describes: "Cuánto se generó en comisiones de los profesionales, o cuánto le toca a cada uno.",
    how: "El porcentaje de cada profesional sobre lo cobrado de lo que atendió, al momento de cobrar; la misma cuenta de Finanzas › Comisiones.",
    unit: "money",
    tab: "finanzas",
    better: "up",
    groups: ["mes", "sede", "profesional"],
    values: async (ctx, spans, branchId) =>
      (await commissionsMany(ctx.tx, ctx.orgId, spans, { currency: ctx.scope.currency, branchId })).map((list) =>
        money(list.reduce((total, item) => total + item.commissionCents, 0)),
      ),
    breakdown: async (ctx, _group, branchId) => {
      const [list] = await commissionsMany(ctx.tx, ctx.orgId, [ctx.scope.window], { currency: ctx.scope.currency, branchId })
      const names = await userNames(ctx.tx, (list ?? []).map((row) => row.userId))
      return (list ?? []).filter((row) => row.commissionCents !== 0).map((row) => ({ key: row.userId, label: names.get(row.userId) ?? "", value: money(row.commissionCents) }))
    },
  },
  {
    key: "lo_que_debes",
    area: "dinero",
    name: "Lo que debes",
    describes: "Cuánto debe pagar la clínica: comisiones por pagar a los profesionales y compras a proveedores sin pagar.",
    how: "Comisiones por pagar más compras de Inventario recibidas y sin pagar, al cierre del periodo.",
    unit: "money",
    tab: "finanzas",
    better: "down",
    atClose: true,
    groups: ["mes", "sede"],
    values: async (ctx, spans, branchId) => {
      const moments = spans.map((span) => span.end)
      const owed = await commissionsOwedMany(ctx.tx, ctx.orgId, moments, { currency: ctx.scope.currency, branchId })
      const purchases = await unpaidPurchasesMany(ctx.tx, ctx.orgId, moments, { branchId })
      return moments.map((_, index) => money((owed[index]?.cents ?? 0) + centsIn(purchases[index], ctx.scope.currency)))
    },
  },
  {
    key: "deuda_vencida",
    area: "dinero",
    name: `Te deben hace más de ${OVERDUE_DAYS} días`,
    describes: "Cuánto deben los pacientes desde hace más de un mes: la deuda vencida, la cobranza atrasada, los morosos.",
    how: `Lo que cada persona debe desde hace más de ${OVERDUE_DAYS} días al cierre del periodo, descontando lo que tiene a favor. La misma regla de «Saldo vencido».`,
    unit: "money",
    noun: PEOPLE,
    tab: "finanzas",
    better: "down",
    atClose: true,
    advice: "dinero",
    insteadFor: { antiguedad: "te_deben" },
    groups: ["mes", "sede"],
    list: { key: "debts_overdue", noun: PEOPLE, feminine: true, count: (total) => total.part ?? 0, question: "¿Quiénes me deben?" },
    values: async (ctx, spans, branchId) =>
      (await overdueDebtMany(ctx.tx, ctx.orgId, branchId, spans.map((span) => span.end))).map((list) => {
        const found = list.find((item) => item.currency === ctx.scope.currency)
        return { value: found?.cents ?? 0, part: found?.people ?? 0 }
      }),
  },
  {
    key: "te_deben",
    area: "dinero",
    name: "Te deben",
    describes: "Cuánto deben en total los pacientes, de cualquier antigüedad: las cuentas por cobrar, los saldos pendientes.",
    how: "Lo que cada persona debe al cierre del periodo (lo que se le cobró menos lo que pagó y lo que tiene a favor), por días desde el cargo más antiguo sin pagar.",
    unit: "money",
    noun: PEOPLE,
    tab: "finanzas",
    better: "down",
    atClose: true,
    groups: ["mes", "sede", "antiguedad"],
    values: async (ctx, spans, branchId) =>
      (await debtAgingMany(ctx.tx, ctx.orgId, spans.map((span) => span.end), { currency: ctx.scope.currency, branchId })).map((item) => ({ value: item.totalCents, part: item.people })),
    breakdown: async (ctx, _group, branchId) => {
      const [aging] = await debtAgingMany(ctx.tx, ctx.orgId, [ctx.scope.window.end], { currency: ctx.scope.currency, branchId })
      const words: Record<string, string> = { "0_30": "Hasta 30 días", "31_60": "De 31 a 60 días", "61_90": "De 61 a 90 días", "90_plus": "Más de 90 días" }
      return DEBT_AGES.map((age) => {
        const found = aging?.ages.find((item) => item.key === age.key)
        return { key: age.key, label: words[age.key] ?? age.key, value: { value: found?.cents ?? 0, part: found?.people ?? 0 } }
      })
    },
  },
  {
    key: "lo_que_viene",
    area: "dinero",
    name: "Lo que viene",
    describes: "Cuánto dinero está por venir: tratamientos aceptados en presupuestos que aún no se hicieron.",
    how: "Lo aceptado en presupuestos que todavía no se hizo, a su precio acordado, a hoy. «Sin cita» son los de pacientes sin una cita por venir.",
    unit: "money",
    noun: PATIENTS,
    tab: "finanzas",
    better: "up",
    asOfToday: true,
    wholeClinic: true,
    groups: [],
    list: { key: "upcoming_unbooked", noun: PATIENTS, feminine: false, count: (total) => total.whole ?? 0 },
    values: async (ctx, spans) => {
      const work = await upcomingWork(ctx.tx, ctx.orgId, ctx.scope.currency, ctx.scope.now)
      // `whole`: cuántos de esos pacientes no tienen cita por venir (su lista).
      return spans.map(() => ({ value: work.cents, part: work.patients, whole: work.unbooked.patients }))
    },
  },
  {
    key: "valor_paciente",
    area: "dinero",
    name: "Lo que deja un paciente nuevo en 6 meses",
    describes: "Cuánto vale o deja en promedio un paciente nuevo: el ticket promedio de un paciente en sus primeros meses.",
    how: "El promedio de lo que pagaron en sus primeros 6 meses los pacientes nuevos de hace 6 a 9 meses, para que todos tengan sus 6 meses enteros.",
    unit: "money",
    tab: "finanzas",
    better: "up",
    insteadFor: { tratamiento: "cobrado", medio: "cobrado" },
    groups: ["sede"],
    values: async (ctx, spans, branchId) => {
      const out: FigureValue[] = []
      for (const span of spans) {
        const value = await newPatientValue(ctx.tx, ctx.orgId, span.end, { currency: ctx.scope.currency, branchId })
        out.push({ value: value.averageCents, part: value.patients })
      }
      return out
    },
  },

  // ---------------- Pacientes ----------------
  {
    key: "pacientes_nuevos",
    area: "pacientes",
    name: "Pacientes nuevos",
    describes: "Cuántos pacientes nuevos llegaron o vinieron por primera vez a atenderse.",
    how: "Personas cuya primera cita atendida fue en el periodo.",
    unit: "count",
    noun: PATIENTS,
    tab: "pacientes",
    better: "up",
    insteadFor: { canal: "nos_buscaron" },
    groups: ["mes", "sede"],
    list: { key: "new_patients", noun: PATIENTS, feminine: false, count: (total) => total.value ?? 0, question: "¿Quiénes son?" },
    values: async (ctx, spans, branchId) => (await newPatientsMany(ctx.tx, ctx.orgId, branchScope(branchId), spans)).map(count),
  },
  {
    key: "nos_buscaron",
    area: "pacientes",
    name: "Nos buscaron por primera vez",
    describes: "Cuántas personas nuevas escribieron o nos contactaron por primera vez, por dónde nos escribe la gente y por qué canal llegaron (WhatsApp, Instagram, chat web…).",
    how: "Personas cuya primera conversación (por cualquier canal) o su registro fue en el periodo. Por canal, también cuántas tuvieron su primera cita atendida. Es el canal, no «Cómo nos conoció».",
    unit: "count",
    noun: PEOPLE,
    tab: "pacientes",
    better: "up",
    wholeClinic: true,
    groups: ["mes", "canal"],
    list: { key: "funnel_sought", noun: PEOPLE, feminine: true, count: (total) => total.value ?? 0, question: "¿Quiénes nos buscaron?" },
    values: async (ctx, spans) => (await funnelMany(ctx.tx, ctx.orgId, spans, ctx.scope.now)).map((item) => ({ value: item.counts.sought, part: item.counts.came })),
    breakdown: async (ctx) => {
      const [funnel] = await funnelMany(ctx.tx, ctx.orgId, [ctx.scope.window], ctx.scope.now)
      return (funnel?.channels ?? []).map((row) => ({ key: row.channel ?? "retirado", label: channelWords(row.channel), value: { value: row.sought, part: row.came } }))
    },
    sentence: async (ctx, result) => {
      if (result.group !== "canal" || !result.focus) return null
      const focus = result.rows.find((row) => row.key === result.focus)
      const { locale } = ctx.scope
      const span = spanWords(ctx.scope.window, locale)
      const name = channelWords(result.focus)
      if (!focus?.value.value) return [{ text: `En ${span} nadie nos escribió por primera vez por ${name}.` }]
      const came = focus.value.part ?? 0
      const out: Sentence = [
        { text: `En ${span} ` },
        { text: countWords(focus.value.value, PEOPLE, locale), strong: true },
        { text: ` nos ${focus.value.value === 1 ? "escribió" : "escribieron"} por primera vez por ${name} y ` },
        { text: whole(came, locale), strong: true },
        { text: ` ${came === 1 ? "vino" : "vinieron"} (${percentWords(rateOf(came, focus.value.value) ?? 0, locale)}).` },
      ]
      const best = result.rows
        .filter((row) => row.key !== result.focus && (row.value.value ?? 0) > 0)
        .sort((a, b) => (b.value.value ?? 0) - (a.value.value ?? 0))[0]
      if (best) out.push({ text: ` Por ${best.label} vino el ${percentWords(rateOf(best.value.part ?? 0, best.value.value ?? 0) ?? 0, locale)}.` })
      return out
    },
  },
  {
    key: "aceptaron",
    area: "pacientes",
    name: "Aceptaron su presupuesto",
    describes: "Qué porcentaje de los presupuestos presentados se aceptó: la conversión, la tasa de cierre de ventas.",
    how: "Presupuestos aceptados en todo o en parte ÷ presentados en el periodo, según su respuesta a hoy. Por profesional, los que presentó cada uno.",
    unit: "rate",
    noun: { one: "presupuesto", many: "presupuestos" },
    tab: "pacientes",
    better: "up",
    wholeClinic: true,
    advice: "ventas",
    groups: ["mes", "profesional"],
    values: async (ctx, spans) => (await budgetAcceptanceMany(ctx.tx, ctx.orgId, spans)).map((item) => rateValue(item.accepted, item.presented)),
    breakdown: async (ctx, _group, branchId) => {
      const { rows } = await getReportProfessionals(ctx.tx, ctx.orgId, { period: ctx.scope.window.key, branchId }, ctx.scope.now)
      return rows.filter((row) => row.presented > 0).map((row) => ({ key: row.userId, label: row.name, value: rateValue(row.accepted, row.presented) }))
    },
  },
  {
    key: "como_nos_conocieron",
    area: "pacientes",
    name: "Cómo nos conocieron",
    describes: "Cómo se enteraron de la clínica los pacientes nuevos: recomendación, redes sociales, Google, convenio.",
    how: "Lo que eligió cada paciente nuevo del periodo en «Cómo nos conoció» del registro.",
    unit: "count",
    noun: PATIENTS,
    tab: "pacientes",
    better: "up",
    groups: ["como_nos_conocio"],
    defaultGroup: "como_nos_conocio",
    values: async (ctx, spans, branchId) =>
      (await referralMany(ctx.tx, ctx.orgId, branchScope(branchId), spans)).map((list) => count(list.reduce((total, item) => total + item.count, 0))),
    breakdown: async (ctx, _group, branchId) => {
      const [list] = await referralMany(ctx.tx, ctx.orgId, branchScope(branchId), [ctx.scope.window])
      return (list ?? []).map((row) => ({ key: row.kind ?? "sin_dato", label: row.kind ? (REFERRAL_KIND_LABELS[row.kind as ReferralKind] ?? row.kind) : "No lo dijeron", value: count(row.count) }))
    },
  },
  {
    key: "activos",
    area: "pacientes",
    name: "Pacientes activos",
    describes: "Cuántos pacientes tiene la clínica, los pacientes activos o la cartera de pacientes.",
    how: "Pacientes con una cita atendida en los 18 meses anteriores al cierre del periodo.",
    unit: "count",
    noun: PATIENTS,
    tab: "pacientes",
    better: "up",
    atClose: true,
    groups: ["mes", "sede"],
    values: async (ctx, spans, branchId) =>
      (await activePatientsMany(ctx.tx, ctx.orgId, { ...branchScope(branchId), timezone: ctx.scope.timezone }, spans.map((span) => span.end))).map(count),
  },
  {
    key: "volvieron",
    area: "pacientes",
    name: "Volvieron en el año",
    describes: "Cuántos pacientes regresan o vuelven a atenderse: la fidelidad, la retención de pacientes.",
    how: "De los pacientes atendidos hace 12 a 24 meses, cuántos tuvieron otra cita atendida en los últimos 12.",
    unit: "rate",
    noun: PATIENTS,
    tab: "pacientes",
    better: "up",
    atClose: true,
    groups: ["mes", "sede"],
    values: async (ctx, spans, branchId) =>
      (await returnedMany(ctx.tx, ctx.orgId, { ...branchScope(branchId), timezone: ctx.scope.timezone }, spans.map((span) => span.end))).map((item) => rateValue(item.returned, item.cohort)),
  },
  {
    key: "sin_venir",
    area: "pacientes",
    name: "Sin venir hace más de 6 meses",
    describes: "Cuántos pacientes dejaron de venir hace tiempo, los pacientes perdidos o inactivos que habría que invitar a volver.",
    how: "Pacientes cuya última cita atendida fue hace más de 6 meses, a hoy, sin cita por venir, sin presupuesto esperando respuesta y sin control pendiente.",
    unit: "count",
    noun: PATIENTS,
    tab: "pacientes",
    better: "down",
    asOfToday: true,
    groups: ["sede"],
    list: { key: "lapsed", noun: PATIENTS, feminine: false, count: (total) => total.value ?? 0, question: "¿Quiénes son?" },
    values: async (ctx, spans, branchId) => {
      const value = await lapsedCount(ctx.tx, ctx.orgId, { ...ctx.scope, ...branchScope(branchId) })
      return spans.map(() => count(value))
    },
  },
  {
    key: "controles",
    area: "pacientes",
    name: "Vinieron a su control",
    describes: "Cuántos pacientes vinieron a su control o cita de seguimiento que les tocaba.",
    how: "Controles que tocaban en el periodo y se hicieron con su atención cerrada ÷ los que tocaban, según su estado a hoy.",
    unit: "rate",
    noun: { one: "control", many: "controles" },
    tab: "pacientes",
    better: "up",
    wholeClinic: true,
    groups: ["mes"],
    list: { key: "controls_missed", noun: PATIENTS, feminine: false, count: (total) => (total.whole ?? 0) - (total.part ?? 0), question: "¿Quiénes no vinieron a su control?" },
    values: async (ctx, spans) => {
      const out: FigureValue[] = []
      for (const span of spans) {
        const totals = await controlTotals(ctx.tx, ctx.orgId, span as ReportSpan)
        out.push(rateValue(totals.came, totals.due))
      }
      return out
    },
  },
  {
    key: "dejaron_de_escribir",
    area: "pacientes",
    name: "Dejaron de escribir",
    describes: "Cuántas personas preguntaron algo y dejaron de responder sin agendar.",
    how: `De quienes nos buscaron por primera vez en el periodo y no agendaron, cuántos escribieron por última vez hace más de ${STOPPED_WRITING_DAYS} días sin nada pendiente del equipo.`,
    unit: "count",
    noun: PEOPLE,
    tab: "pacientes",
    better: "down",
    wholeClinic: true,
    groups: ["mes"],
    list: { key: "funnel_stopped", noun: PEOPLE, feminine: true, count: (total) => total.value ?? 0, question: "¿Quiénes dejaron de escribir?" },
    values: async (ctx, spans) => (await funnelMany(ctx.tx, ctx.orgId, spans, ctx.scope.now)).map((item) => count(item.stopped)),
  },

  // ---------------- Agenda ----------------
  {
    key: "atendidas",
    area: "agenda",
    name: "Citas atendidas",
    describes: "Cuántas citas o consultas se atendieron, cuántos pacientes se vieron.",
    how: "Citas del periodo que terminaron atendidas.",
    unit: "count",
    noun: APPOINTMENTS,
    tab: "agenda",
    better: "up",
    groups: ["mes", "sede", "profesional"],
    values: async (ctx, spans, branchId) => (await appointmentTotalsMany(ctx.tx, ctx.orgId, { ...branchScope(branchId), now: ctx.scope.now }, spans)).map((item) => count(item.attended)),
    breakdown: (ctx, _group, branchId) => byProfessional(ctx, branchId, (row) => count(row.attended)),
  },
  {
    key: "no_vinieron",
    area: "agenda",
    name: "No vinieron",
    describes: "Cuántos pacientes faltaron a su cita: las inasistencias, el ausentismo, los que no se presentaron.",
    how: "Citas a las que el paciente no vino ÷ citas que ya pasaron (atendidas, no vinieron, canceladas y las que pasaron sin marcar).",
    unit: "rate",
    noun: APPOINTMENTS,
    tab: "agenda",
    better: "down",
    advice: "agenda",
    groups: ["mes", "sede", "profesional"],
    list: { key: "no_show", noun: APPOINTMENTS, feminine: true, count: (total) => total.part ?? 0, question: "¿Quiénes no vinieron?" },
    values: async (ctx, spans, branchId) =>
      (await appointmentTotalsMany(ctx.tx, ctx.orgId, { ...branchScope(branchId), now: ctx.scope.now }, spans)).map((item) => rateValue(item.noShow, item.total)),
    breakdown: (ctx, _group, branchId) =>
      byProfessional(ctx, branchId, (row) => rateValue(row.noShow, row.attended + row.noShow + row.cancelled + row.unmarked)),
  },
  {
    key: "canceladas",
    area: "agenda",
    name: "Canceladas",
    describes: "Cuántas citas se cancelaron.",
    how: "Citas canceladas ÷ citas que ya pasaron (atendidas, no vinieron, canceladas y las que pasaron sin marcar).",
    unit: "rate",
    noun: APPOINTMENTS,
    tab: "agenda",
    better: "down",
    groups: ["mes", "sede", "profesional"],
    list: { key: "cancelled", noun: APPOINTMENTS, feminine: true, count: (total) => total.part ?? 0, question: "¿Cuáles se cancelaron?" },
    values: async (ctx, spans, branchId) =>
      (await appointmentTotalsMany(ctx.tx, ctx.orgId, { ...branchScope(branchId), now: ctx.scope.now }, spans)).map((item) => rateValue(item.cancelled, item.total)),
    breakdown: (ctx, _group, branchId) =>
      byProfessional(ctx, branchId, (row) => rateValue(row.cancelled, row.attended + row.noShow + row.cancelled + row.unmarked)),
  },
  {
    key: "agenda_ocupada",
    area: "agenda",
    name: "Agenda ocupada",
    describes: "Qué tan llena está la agenda: la ocupación de los profesionales, el porcentaje de horas con citas.",
    how: "Minutos de citas no canceladas ÷ minutos del horario de cada profesional menos sus ausencias. Cada día usa el horario vigente ese día.",
    unit: "rate",
    tab: "agenda",
    better: "up",
    groups: ["mes", "sede", "profesional"],
    values: async (ctx, spans, branchId) => (await occupancyMany(ctx.tx, ctx.orgId, spans, { branchId })).map((item) => rateValue(item.occMin, item.availMin)),
    breakdown: (ctx, _group, branchId) => occupancyByProfessional(ctx, branchId, (row) => rateValue(row.occMin, row.availMin)),
  },
  {
    key: "horas_libres",
    area: "agenda",
    name: "Horas libres",
    describes: "Cuántas horas de agenda quedaron sin citas, el tiempo libre o desaprovechado de los profesionales.",
    how: "Horas del horario de cada profesional, menos sus ausencias y menos las citas no canceladas.",
    unit: "hours",
    tab: "agenda",
    better: "down",
    groups: ["mes", "sede", "profesional"],
    values: async (ctx, spans, branchId) =>
      (await occupancyMany(ctx.tx, ctx.orgId, spans, { branchId })).map((item) => ({ value: item.availMin > 0 ? Math.max(0, item.availMin - item.occMin) : null })),
    breakdown: (ctx, _group, branchId) => occupancyByProfessional(ctx, branchId, (row) => ({ value: Math.max(0, row.availMin - row.occMin) })),
  },
  {
    key: "espera_en_sala",
    area: "agenda",
    name: "Espera en sala",
    describes: "Cuánto esperan los pacientes en la sala antes de ser atendidos.",
    how: "Mediana de minutos entre «Llegó» y el inicio de la atención de la cita; solo cuenta la llegada marcada antes de empezar.",
    unit: "minutes",
    tab: "agenda",
    better: "down",
    groups: ["mes", "sede", "profesional"],
    values: async (ctx, spans, branchId) => {
      const out: FigureValue[] = []
      for (const span of spans) out.push({ value: (await waitInRoom(ctx.tx, ctx.orgId, branchScope(branchId), span)).medianMinutes })
      return out
    },
    breakdown: async (ctx, _group, branchId) =>
      (await waitInRoom(ctx.tx, ctx.orgId, branchScope(branchId), ctx.scope.window)).byProfessional.map((row) => ({ key: row.userId, label: row.name, value: { value: row.medianMinutes } })),
  },

  // ---------------- Agente ----------------
  {
    key: "agente_trajo",
    area: "agente",
    name: "Lo que te trajo el agente",
    describes: "Cuánto trajo o aportó el agente en general: citas que agendó, citas recuperadas y lo cobrado en ellas.",
    how: "Citas que el agente o su enlace agendaron, más las citas recuperadas del cobro; lo cobrado a esos pacientes en esas citas. Las mismas cifras de la pestaña Agente.",
    unit: "count",
    noun: APPOINTMENTS,
    tab: "agente",
    better: "up",
    groups: ["mes"],
    list: { key: "agent_booked", noun: APPOINTMENTS, feminine: true, count: (total) => total.value ?? 0 },
    values: async (ctx, spans, branchId) => (await agentBookedMany(ctx.tx, ctx.orgId, branchId, spans)).map((item) => count(item.booked)),
    sentence: async (ctx, result, branchId) => {
      if (result.group !== "total") return null
      const { tx, orgId, scope } = ctx
      const { locale, currency, window } = scope
      const [recovered] = await agentRecoveredMany(tx, orgId, branchId, [window])
      const [collected] = await agentCollectedMany(tx, orgId, branchId, [window], scope.now)
      const booked = result.total.value ?? 0
      const out: Sentence = [
        { text: `En ${spanWords(window, locale)} el agente agendó ` },
        { text: countWords(booked, APPOINTMENTS, locale), strong: true },
      ]
      if ((recovered ?? 0) > 0) out.push({ text: " y recuperó " }, { text: whole(recovered ?? 0, locale), strong: true })
      out.push({ text: "." })
      const cents = collected ? collectedIn(collected, currency) : 0
      if (cents > 0) out.push({ text: " En esas citas cobraste " }, { text: moneyWords(cents, currency, locale), strong: true }, { text: "." })
      if (ctx.billing) {
        const [paid] = await agentBillingMany(tx, orgId, [window], scope.now)
        // Las mismas cuentas de la pestaña Agente: lo que pasó del crédito del plan es lo que se cobró aparte.
        if (paid?.currency && paid.charging !== "no" && paid.totalCents > 0) {
          out.push({
            text:
              paid.overCents > 0
                ? ` Por encima del crédito del plan, odentIA te cobró ${moneyWords(paid.overCents, paid.currency, locale)} por el agente.`
                : ` Lo del agente (${moneyWords(paid.totalCents, paid.currency, locale)}) entró en el crédito del plan.`,
          })
        }
      }
      return out
    },
  },
  {
    key: "agente_conversaciones",
    area: "agente",
    name: "Conversaciones que atendió el agente",
    describes: "Cuántas conversaciones o mensajes de pacientes respondió el agente, y cuántas resolvió solo sin el equipo.",
    how: "Conversaciones con al menos una respuesta del agente en el periodo. «Solo»: sin mensajes del equipo ni paso al equipo.",
    unit: "count",
    noun: CONVERSATIONS,
    tab: "agente",
    better: "up",
    wholeClinic: true,
    groups: ["mes"],
    values: async (ctx, spans) => (await agentConversationsMany(ctx.tx, ctx.orgId, spans)).map((item) => ({ value: item.attended, part: item.alone })),
  },
  {
    key: "agente_citas",
    area: "agente",
    name: "Citas que agendó el agente",
    describes: "Cuántas citas agendó o reservó el agente por su cuenta, en el chat o desde su enlace.",
    how: "Citas reservadas en la conversación del agente o desde su enlace, por el día en que se reservaron.",
    unit: "count",
    noun: APPOINTMENTS,
    tab: "agente",
    better: "up",
    groups: ["mes", "sede"],
    list: { key: "agent_booked", noun: APPOINTMENTS, feminine: true, count: (total) => total.value ?? 0, question: "¿Cuáles agendó?" },
    values: async (ctx, spans, branchId) => (await agentBookedMany(ctx.tx, ctx.orgId, branchId, spans)).map((item) => ({ value: item.booked, part: item.attended })),
  },
  {
    key: "agente_recuperadas",
    area: "agente",
    name: "Citas recuperadas",
    describes: "Cuántas citas recuperó el agente: pacientes que volvieron a agendar después de un mensaje de Argos.",
    how: "Citas atendidas que el cobro contó como recuperadas: la persona reservó dentro de los 7 días siguientes a un mensaje de Argos.",
    unit: "count",
    noun: APPOINTMENTS,
    tab: "agente",
    better: "up",
    groups: ["mes", "sede"],
    values: async (ctx, spans, branchId) => (await agentRecoveredMany(ctx.tx, ctx.orgId, branchId, spans)).map(count),
  },
  {
    key: "agente_dictadas",
    area: "agente",
    name: "Consultas dictadas",
    describes: "Cuántas consultas se dictaron con Clío, el asistente clínico que escucha al odontólogo y ordena la atención.",
    how: "Atenciones dictadas que el odontólogo confirmó, por el día en que se cerró la atención.",
    unit: "count",
    noun: { one: "consulta", many: "consultas" },
    tab: "agente",
    better: "up",
    groups: ["mes", "sede"],
    values: async (ctx, spans, branchId) => (await agentDictatedMany(ctx.tx, ctx.orgId, branchId, spans)).map(count),
  },
  {
    key: "agente_pagado",
    area: "agente",
    name: "Lo que pagaste por el agente",
    describes: "Cuánto cuesta o cuánto se le paga a odentIA por el agente: la factura del agente.",
    how: "Las acciones del agente del periodo con las mismas cuentas de Plan y pagos, en la moneda del plan.",
    unit: "money",
    tab: "agente",
    better: "down",
    wholeClinic: true,
    billing: true,
    groups: ["mes"],
    moneyIn: async (ctx) => (await agentBillingMany(ctx.tx, ctx.orgId, [ctx.scope.window], ctx.scope.now))[0]?.currency ?? null,
    values: async (ctx, spans) => (await agentBillingMany(ctx.tx, ctx.orgId, spans, ctx.scope.now)).map((item) => ({ value: item.currency ? item.totalCents : null })),
    sentence: async (ctx, result) => {
      if (result.group !== "total") return null
      const [paid] = await agentBillingMany(ctx.tx, ctx.orgId, [ctx.scope.window], ctx.scope.now)
      const span = spanWords(ctx.scope.window, ctx.scope.locale)
      if (!paid?.currency) return [{ text: `En ${span} la clínica no tenía un plan con precio: no hay importe que decir.` }]
      const amount = moneyWords(paid.totalCents, paid.currency, ctx.scope.locale)
      if (paid.charging === "no") return [{ text: `En ${span} lo del agente sumaría ${amount}, pero no se cobra: ${paid.notCharged === "demo" ? "es una cuenta de demostración" : paid.notCharged === "prueba" ? "la clínica está en su prueba" : "no hay un plan activo"}.` }]
      return [{ text: `En ${span} el agente costó ` }, { text: amount, strong: true }, { text: paid.overCents > 0 ? `, de los que ${moneyWords(paid.overCents, paid.currency, ctx.scope.locale)} pasaron del crédito del plan.` : ", dentro del crédito del plan." }]
    },
  },
  {
    key: "primera_respuesta",
    area: "agente",
    name: "Primera respuesta",
    describes: "Cuánto se tarda en responder al paciente que escribe: la velocidad de respuesta del agente y del equipo.",
    how: "Mediana del tiempo entre el primer mensaje de la persona y la primera respuesta, del agente y del equipo por separado.",
    unit: "minutes",
    tab: "agente",
    better: "down",
    wholeClinic: true,
    groups: ["mes"],
    values: async (ctx, spans) =>
      (await firstResponsesMany(ctx.tx, ctx.orgId, spans)).map((item) => ({ value: item.agentMedianSeconds === null ? null : item.agentMedianSeconds / 60 })),
    sentence: async (ctx, result) => {
      if (result.group !== "total") return null
      const [responses] = await firstResponsesMany(ctx.tx, ctx.orgId, [ctx.scope.window])
      const { locale } = ctx.scope
      const span = spanWords(ctx.scope.window, locale)
      if (!responses || responses.responded === 0) return [{ text: `En ${span} nadie escribió por primera vez o no hubo respuestas que medir.` }]
      const parts: Sentence = [{ text: `En ${span}, a quien escribió por primera vez ` }]
      if (responses.agentMedianSeconds !== null) parts.push({ text: "el agente le respondió en " }, { text: minutesWords(responses.agentMedianSeconds / 60, locale), strong: true })
      if (responses.teamMedianSeconds !== null) {
        parts.push({ text: responses.agentMedianSeconds !== null ? " y el equipo en " : "el equipo le respondió en " }, { text: minutesWords(responses.teamMedianSeconds / 60, locale), strong: true })
      }
      parts.push({ text: ` (la mitad de las veces, menos que eso; ${countWords(responses.responded, CONVERSATIONS, locale)} con respuesta).` })
      return parts
    },
  },
  {
    key: "pasaron_al_equipo",
    area: "agente",
    name: "Pasaron al equipo",
    describes: "Cuántas conversaciones el agente pasó o derivó a una persona del equipo.",
    how: "De quienes escribieron por primera vez en el periodo, las conversaciones que el agente pasó al equipo, hasta hoy.",
    unit: "count",
    noun: CONVERSATIONS,
    tab: "agente",
    better: "down",
    wholeClinic: true,
    groups: ["mes"],
    list: { key: "agent_handoffs", noun: CONVERSATIONS, feminine: true, count: (total) => total.value ?? 0, question: "¿Cuáles pasaron al equipo?" },
    values: async (ctx, spans) => (await firstResponsesMany(ctx.tx, ctx.orgId, spans)).map((item) => ({ value: item.handedOff, whole: item.conversations })),
  },
]

const BY_KEY = new Map(REPORT_FIGURES.map((figure) => [figure.key, figure]))

export function reportFigureOf(key: string): ReportFigure | undefined {
  return BY_KEY.get(key)
}

/** Las cifras que puede ver quien pregunta: lo pagado a odentIA solo si ve Facturación. */
export function visibleFigures(billing: boolean): ReportFigure[] {
  return REPORT_FIGURES.filter((figure) => billing || !figure.billing)
}

/** Agrupaciones que acepta una cifra: siempre `total`, más las suyas; sin sede si es de toda la clínica. */
export function groupsOf(figure: ReportFigure): FigureGroup[] {
  return ["total", ...figure.groups.filter((group) => !(group === "sede" && figure.wholeClinic))]
}

// --- Calcular ----------------------------------------------------------------------------

/** Una frase, en partes: lo destacado (`strong`) es siempre una cifra calculada. */
export type Sentence = Array<{ text: string; strong?: boolean }>

export interface FigureRequest {
  figure: string
  group: FigureGroup
  /** Lo que se destaca dentro del grupo (un canal). */
  focus?: string | null
}

export interface FigureResult {
  figure: ReportFigure
  group: FigureGroup
  focus: string | null
  total: FigureValue
  previous: FigureValue | null
  /** Los 12 meses que terminan en el periodo (con `total` o `mes`), del más antiguo al más reciente. */
  months: Array<{ month: YearMonth; partial: boolean; value: FigureValue }>
  /** Con otra agrupación: una fila por grupo, de mayor a menor. */
  rows: FigureRow[]
  /** Se pidió una agrupación que esta cifra no tiene: se responde con la que sí. */
  regrouped: FigureGroup | null
  /** La moneda en que van sus importes: la de la clínica, salvo lo pagado a odentIA. */
  currency: string
}

async function activeBranches(tx: Db, orgId: string): Promise<Array<{ id: string; name: string }>> {
  const rows = await tx.execute<{ id: string; name: string }>(sql`select id, name from branch where organization_id = ${orgId} and is_active order by name, id`)
  return [...rows]
}

function byValue(a: FigureRow, b: FigureRow): number {
  return (b.value.value ?? -Infinity) - (a.value.value ?? -Infinity) || a.label.localeCompare(b.label)
}

/**
 * Calcula una cifra del catálogo con el periodo y la sede de la pantalla. Una
 * agrupación que la cifra no tiene se cambia por la suya (y se dice): nunca se
 * inventa un reparto que la consulta no sabe hacer.
 */
export async function computeFigure(ctx: FigureContext, request: FigureRequest): Promise<FigureResult> {
  const figure = reportFigureOf(request.figure)
  if (!figure || (figure.billing && !ctx.billing)) throw new Error(`Cifra desconocida: ${request.figure}`)
  const allowed = groupsOf(figure)
  const wanted = request.group === "total" && figure.defaultGroup ? figure.defaultGroup : request.group
  const group = allowed.includes(wanted) ? wanted : (figure.defaultGroup ?? "total")
  const regrouped = group !== request.group && request.group !== "total" ? group : null
  const { scope } = ctx
  const { window } = scope
  // Por sede se comparan todas: el total es el de la clínica, aunque la pantalla tenga una elegida.
  const branchId = figure.wholeClinic || group === "sede" ? undefined : scope.branch?.id
  const monthSpans = figure.asOfToday ? [] : lastMonths(scope.timezone, window.to, 12, window.end)
  const spans: Span[] = figure.asOfToday ? [window] : [window, window.previous, ...monthSpans]
  const values = await figure.values(ctx, spans, branchId)
  const total = values[0] ?? { value: null }
  const previous = figure.asOfToday ? null : (values[1] ?? null)
  const months = monthSpans.map((span, index) => {
    const [year, month] = span.key.split("-").map(Number) as [number, number]
    return { month: { year, month }, partial: span.partial, value: values[index + 2] ?? { value: null } }
  })

  let rows: FigureRow[] = []
  if (group === "sede") {
    for (const branch of await activeBranches(ctx.tx, ctx.orgId)) {
      const [value] = await figure.values(ctx, [window], branch.id)
      rows.push({ key: branch.id, label: branch.name, value: value ?? { value: null } })
    }
    rows.sort(byValue)
  } else if (group !== "total" && group !== "mes" && figure.breakdown) {
    rows = await figure.breakdown(ctx, group, branchId)
    // La antigüedad de la deuda se lee en su orden (de 0 a 90+ días); lo demás, de mayor a menor.
    if (group !== "antiguedad") rows.sort(byValue)
  }
  // Un canal pedido se conserva aunque no tenga filas: así se dice «nadie nos escribió por Instagram».
  const focus = request.focus && (group === "canal" || rows.some((row) => row.key === request.focus)) ? request.focus : null
  const currency = (await figure.moneyIn?.(ctx)) ?? scope.currency
  return { figure, group, focus, total, previous, months, rows, regrouped, currency }
}

// --- Decirlo -----------------------------------------------------------------------------

export function formatFigure(value: number, unit: FigureUnit, scope: Pick<ReportScope, "currency" | "locale">): string {
  switch (unit) {
    case "money":
      return moneyWords(Math.round(value), scope.currency, scope.locale)
    case "rate":
      return percentWords(value, scope.locale)
    case "minutes":
      return minutesWords(value, scope.locale)
    case "hours":
      return hoursWords(value, scope.locale)
    default:
      return whole(value, scope.locale)
  }
}

function detailOf(figure: ReportFigure, value: FigureValue, locale: string): string {
  if (figure.unit === "rate" && value.whole !== undefined && value.whole > 0 && figure.noun) {
    return ` (${whole(value.part ?? 0, locale)} de ${countWords(value.whole, figure.noun, locale)})`
  }
  if (figure.unit === "money" && figure.noun && value.part !== undefined && value.part > 0) return ` (${countWords(value.part, figure.noun, locale)})`
  return ""
}

function changeOf(figure: ReportFigure, current: FigureValue, previous: FigureValue | null, scope: ReportScope): string | null {
  if (!previous || current.value === null || previous.value === null) return null
  const phrase = previousWords(scope.window.previous, scope.locale)
  const change =
    figure.unit === "money"
      ? relativeChangeWords(current.value, previous.value, phrase, scope.locale)
      : figure.unit === "rate"
        ? absoluteChangeWords(current.value, previous.value, phrase, scope.locale, (value) => countWords(value, POINT_WORDS, scope.locale))
        : figure.unit === "minutes"
          ? absoluteChangeWords(current.value, previous.value, phrase, scope.locale, (value) => minutesWords(value, scope.locale))
          : figure.unit === "hours"
            ? absoluteChangeWords(current.value / 60, previous.value / 60, phrase, scope.locale, (value) => countWords(value, { one: "hora", many: "horas" }, scope.locale))
            : absoluteChangeWords(current.value, previous.value, phrase, scope.locale)
  return change?.text ?? null
}

/** Cuándo vale la cifra: «en septiembre de 2026», «al cierre de septiembre de 2026», «a hoy». */
export function whenWords(figure: ReportFigure, scope: ReportScope): string {
  if (figure.asOfToday) return "a hoy"
  const span = spanWords(scope.window, scope.locale)
  if (figure.atClose) return scope.window.partial ? "a hoy" : `al cierre de ${span}`
  return `en ${span}`
}

/** «En toda la clínica» o «En Sede Norte», para comparar una fila con el conjunto. */
function wholeWords(result: FigureResult, scope: ReportScope): string {
  return result.group !== "sede" && scope.branch && !result.figure.wholeClinic ? `En ${scope.branch.name}` : "En toda la clínica"
}

/** La frase de la respuesta: la de la cifra si tiene una, y si no, la plantilla de su agrupación. */
export async function sentenceOf(ctx: FigureContext, result: FigureResult): Promise<Sentence> {
  const sentence = await templateOf(ctx, result)
  // Se pidió una agrupación que la cifra no tiene: se dice antes de responder con la suya.
  if (!result.regrouped) return sentence
  const groupName = FIGURE_GROUP_WORDS[result.regrouped].toLowerCase()
  return [{ text: `${result.figure.name} no se puede separar así; te lo muestro ${groupName}. ` }, ...sentence]
}

async function templateOf(ctx: FigureContext, result: FigureResult): Promise<Sentence> {
  const { figure } = result
  const { scope } = ctx
  const branchId = figure.wholeClinic || result.group === "sede" ? undefined : scope.branch?.id
  const own = figure.sentence ? await figure.sentence(ctx, result, branchId) : null
  if (own) return own
  const fmt = (value: number) => formatFigure(value, figure.unit, { currency: result.currency, locale: scope.locale })
  const { locale } = scope

  if (result.group === "total") {
    if (result.total.value === null) return [{ text: `${figure.name}: sin datos ${whenWords(figure, scope)}.` }]
    const change = changeOf(figure, result.total, result.previous, scope)
    return [
      { text: `${figure.name}: ` },
      { text: fmt(result.total.value), strong: true },
      { text: `${detailOf(figure, result.total, locale)} ${whenWords(figure, scope)}${change ? `, ${change}` : ""}.` },
    ]
  }

  if (result.group === "mes") {
    const known = result.months.filter((month) => month.value.value !== null)
    const last = result.months[result.months.length - 1]
    const year = last?.month.year
    if (!last || known.length === 0) return [{ text: `${figure.name}: sin datos en los últimos 12 meses.` }]
    const pool = known.filter((month) => !month.partial)
    const best = (pool.length > 0 ? pool : known).reduce((top, month) =>
      figure.better === "down" ? ((month.value.value ?? 0) < (top.value.value ?? 0) ? month : top) : (month.value.value ?? 0) > (top.value.value ?? 0) ? month : top,
    )
    const out: Sentence = [
      { text: `${figure.name}, por mes: el mejor de los últimos 12 fue ${monthWords(best.month, locale, year)}, con ` },
      { text: fmt(best.value.value ?? 0), strong: true },
    ]
    if (last.value.value !== null && last !== best) {
      out.push({ text: `; ${monthWords(last.month, locale, year)} ${last.partial ? "va en" : "cerró en"} ` }, { text: fmt(last.value.value), strong: true })
    }
    out.push({ text: "." })
    return out
  }

  const rows = result.rows.filter((row) => row.value.value !== null)
  const groupName = FIGURE_GROUP_WORDS[result.group].toLowerCase()
  if (rows.length === 0) return [{ text: `${figure.name}: no hay nada que separar ${groupName} ${whenWords(figure, scope)}.` }]
  const lead = (result.focus ? rows.find((row) => row.key === result.focus) : null) ?? rows[0]!
  const out: Sentence = [{ text: `${lead.label}: ` }, { text: fmt(lead.value.value ?? 0), strong: true }]
  if (figure.unit === "rate" || figure.unit === "minutes") {
    out.push({ text: detailOf(figure, lead.value, locale) })
    if (result.total.value !== null) out.push({ text: `. ${wholeWords(result, scope)} fue ${fmt(result.total.value)}` })
  } else if (result.total.value !== null && result.total.value > 0 && figure.unit !== "hours") {
    const share = rateOf(lead.value.value ?? 0, result.total.value)
    out.push({ text: ` de ${fmt(result.total.value)}${share !== null ? ` (${percentWords(share, locale)})` : ""}` })
  }
  out.push({ text: ` ${whenWords(figure, scope)}.` })
  return out
}

/** «Así lo calculé»: la regla, el periodo y la sede (o «De toda la clínica»). */
export function scopeWords(result: FigureResult, scope: ReportScope): string {
  const when = result.figure.asOfToday ? "a hoy" : capitalize(spanWords(scope.window, scope.locale), scope.locale)
  const where = result.figure.wholeClinic ? "De toda la clínica" : result.group === "sede" || !scope.branch ? "Todas las sedes" : scope.branch.name
  return `${when} · ${where}`
}

/** El periodo anterior como clave de Reportes, para «¿Y en agosto?». */
export function previousPeriodKey(scope: ReportScope): { key: string; label: string } | null {
  const { window, timezone, locale } = scope
  const single = window.kind === "months" && window.from.year === window.to.year && window.from.month === window.to.month
  if (single) {
    const month = window.from.month === 1 ? { year: window.from.year - 1, month: 12 } : { year: window.from.year, month: window.from.month - 1 }
    return { key: `${month.year}-${String(month.month).padStart(2, "0")}`, label: `¿Y en ${monthWords(month, locale, window.from.year)}?` }
  }
  // El fin es exclusivo: el último día es el del instante anterior (en un tramo que corre, es el mismo día).
  const from = window.previous.days?.from ?? reportDayOf(timezone, window.previous.start)
  const to = window.previous.days?.to ?? reportDayOf(timezone, new Date(window.previous.end.getTime() - 1))
  if (to < from) return null
  return { key: `${from}..${to}`, label: "¿Y en el periodo anterior?" }
}
