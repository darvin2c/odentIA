/**
 * «Pregúntale a Argos» en Reportes (ADR 0070): la pregunta ya entendida
 * (`report-questions.ts`) se responde con una cifra del catálogo
 * (`report-figures.ts`), calculada con el periodo y la sede de la pantalla, y
 * una frase de plantilla. Solo lee: no prende, no cambia ni envía nada; para
 * actuar lleva a la línea de Argos que lo haría.
 *
 * Cada pregunta deja una fila en `report_question`, sin el texto: la cifra que
 * eligió y cómo terminó. Las que pasaron por el modelo cuentan para el tope
 * diario de la clínica (`REPORT_DAILY_LIMIT`, como el de la Ayuda). Tocar una
 * opción de la respuesta («¿Y en agosto?», «Por sede») no llama al modelo.
 */
import { reportPin, reportQuestion, REPORT_PIN_LIMIT } from "@odentia/db/schema/reports"
import type { Db } from "@odentia/db"
import { and, count, eq, gte, sql } from "drizzle-orm"
import { getAdminSettings } from "./agent-admin.js"
import { adminLineOf } from "./admin-lines.js"
import { LINE_WORDS } from "./admin-request.js"
import { isCheckViolation, isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import {
  computeFigure,
  FIGURE_GROUP_WORDS,
  FIGURE_GROUPS,
  type FigureContext,
  type FigureGroup,
  type FigureResult,
  type FigureUnit,
  formatFigure,
  groupsOf,
  previousPeriodKey,
  reportFigureOf,
  scopeWords,
  type Sentence,
  sentenceOf,
} from "./report-figures.js"
import { FOLLOW_UP_GROUPS, type ReportCandidate, type ReportInterpretationResult } from "./report-questions.js"
import { REPORT_PERIOD_PATTERN, reportDayOf } from "./report-periods.js"
import { type ReportQuery, type ReportScope, reportScope } from "./report-scope.js"
import { countWords, monthWords } from "./report-words.js"
import { type ReportAdvice, getReportAdvice } from "./reports.js"

/** Preguntas con modelo por clínica en 24 horas (decisión 7): odentIA asume su costo. */
export const REPORT_DAILY_LIMIT = 200

export const REPORT_ASK_WORDS = {
  apagado: "Argos está apagado. Enciéndelo para preguntarle; las cifras de Reportes no dependen de él.",
  tope: `La clínica llegó a las ${REPORT_DAILY_LIMIT} preguntas de hoy. Mañana sigo respondiendo; las cifras de Reportes siguen a la vista.`,
  sinModelo: "Ahora no puedo leer preguntas. Las cifras de Reportes siguen a la vista; prueba de nuevo en un momento.",
  noSabe: "Todavía no sé responder eso: no está entre las cifras que conozco.",
  clinico: "Eso está en la historia clínica y no lo veo. Respondo solo con cifras de gestión: dinero, agenda, pacientes y el agente.",
  accion: "Desde aquí solo respondo con cifras. Lo que el agente hace por su cuenta se prende en la página de Argos.",
  otro: "Respondo con las cifras de Reportes: dinero, pacientes, agenda y el agente. Prueba con una pregunta como «¿cuánto cobramos este mes?».",
  pregunta: "¿Cuál de estas quieres ver?",
  preguntaSedes: "¿Qué quieres comparar entre las sedes?",
} as const

/** La pregunta ya entendida: lo que guarda una respuesta fijada y lo que envía una opción. */
export interface ReportAskQuery extends ReportQuery {
  figure: string
  group: FigureGroup
  focus?: string | null
}

export type ReportAnswerChart =
  | {
      kind: "bars"
      rows: Array<{ key: string; label: string; value: number; part?: number; valueText: string; note?: string; highlight: boolean }>
      legend: { value: string; part: string } | null
    }
  | { kind: "months"; points: Array<{ key: string; label: string; short: string; partial: boolean; value: number | null }> }

export type ReportFollowUp = { label: string; query: ReportAskQuery } | { label: string; list: string }

export interface ReportAnswer {
  query: ReportAskQuery
  title: string
  sentence: Sentence
  /** «Así lo calculé». */
  how: string
  /** «Septiembre de 2026 · Todas las sedes». */
  scope: string
  unit: FigureUnit
  currency: string
  locale: string
  chart: ReportAnswerChart | null
  /** «Ver las 11 citas»: abre la misma lista de su tarjeta. */
  list: { key: string; label: string } | null
  tab: { key: string; label: string }
  followUps: ReportFollowUp[]
  /** El aviso de Argos de esa pregunta, si lo hay: la línea apagada que la atendería. */
  advice: ReportAdvice | null
  /** Se puede descargar: tiene filas. */
  downloadable: boolean
}

export type ReportAskResult =
  | { kind: "respuesta"; answer: ReportAnswer }
  | { kind: "pregunta"; message: string; options: Array<{ label: string; query: ReportAskQuery }> }
  | { kind: "no_sabe"; message: string; closest: Array<{ label: string; query: ReportAskQuery }> }
  | { kind: "accion"; message: string; line: { key: string; name: string } | null }
  | { kind: "clinico" | "otro" | "tope" | "sin_modelo" | "apagado"; message: string }

export interface ReportAskOptions {
  billing: boolean
  can: (permission: string) => boolean
  now?: Date
}

type Outcome = "respondida" | "pregunta" | "no_sabe" | "clinico" | "accion" | "otro" | "no_pudo"

async function record(tx: Db, orgId: string, userId: string, outcome: Outcome, usedModel: boolean, figure?: string | null, group?: string | null): Promise<void> {
  await tx.insert(reportQuestion).values({ organizationId: orgId, userId, outcome, usedModel, figure: figure ?? null, groupBy: group ?? null })
}

/**
 * Lo que hace falta antes de llamar al modelo: si Argos está encendido, si
 * queda tope y lo que se lee con reglas. Con la pantalla, la valida antes (una
 * sede que ya no existe falla aquí, no después de pagar la llamada).
 */
export async function prepareReportQuestion(tx: Db, orgId: string, now: Date = new Date(), screen?: ReportQuery) {
  if (screen) await reportScope(tx, orgId, screen, now)
  const { enabled } = await getAdminSettings(tx, orgId)
  const since = new Date(now.getTime() - 86_400_000)
  const [row] = await tx
    .select({ total: count() })
    .from(reportQuestion)
    .where(and(eq(reportQuestion.organizationId, orgId), eq(reportQuestion.usedModel, true), gte(reportQuestion.createdAt, since)))
  const [zone] = await tx.execute<{ timezone: string }>(sql`select timezone from org_profile where organization_id = ${orgId}`)
  const branches = await tx.execute<{ id: string; name: string }>(sql`select id, name from branch where organization_id = ${orgId} and is_active order by name, id`)
  return { enabled, roomLeft: Math.max(0, REPORT_DAILY_LIMIT - Number(row?.total ?? 0)), timezone: zone?.timezone ?? "UTC", branches: [...branches] }
}

/** El modelo no respondió: queda anotado (cuenta para el tope, porque se le llamó). */
export async function recordReportQuestionFailure(tx: Db, orgId: string, userId: string): Promise<ReportAskResult> {
  await record(tx, orgId, userId, "no_pudo", true)
  return { kind: "sin_modelo", message: REPORT_ASK_WORDS.sinModelo }
}

function optionOf(candidate: { figure: string }, base: Omit<ReportAskQuery, "figure">): { label: string; query: ReportAskQuery } | null {
  const figure = reportFigureOf(candidate.figure)
  if (!figure) return null
  const group = groupsOf(figure).includes(base.group) ? base.group : (figure.defaultGroup ?? "total")
  const label = group === "total" || group === figure.defaultGroup ? figure.name : `${figure.name}, ${FIGURE_GROUP_WORDS[group].toLowerCase()}`
  return { label, query: { ...base, figure: figure.key, group } }
}

/** La pregunta entendida, con el periodo y la sede de la pantalla salvo que la pregunta nombre otros. */
function screenOf(interpretation: { period: string | null; branch: { id: string } | null; allBranches: boolean }, screen: ReportQuery): ReportQuery {
  return {
    period: interpretation.period ?? screen.period,
    branchId: interpretation.allBranches ? undefined : (interpretation.branch?.id ?? screen.branchId),
  }
}

/**
 * Lo que respondió el modelo convertido en respuesta: la cifra calculada, la
 * pregunta entre dos o tres, «todavía no sé» con lo más cercano, o por qué no
 * le toca. Deja su fila en `report_question`.
 */
export async function resolveReportQuestion(
  tx: Db,
  orgId: string,
  userId: string,
  text: string,
  understood: ReportInterpretationResult,
  screen: ReportQuery,
  options: ReportAskOptions,
): Promise<ReportAskResult> {
  const { interpretation } = understood
  // Lo que se reconoció sin modelo (lo clínico) no cuenta para el tope.
  const usedModel = understood.model !== null
  if (interpretation.kind === "clinico" || interpretation.kind === "otro") {
    await record(tx, orgId, userId, interpretation.kind, usedModel)
    return { kind: interpretation.kind, message: REPORT_ASK_WORDS[interpretation.kind] }
  }
  if (interpretation.kind === "accion") {
    await record(tx, orgId, userId, "accion", usedModel)
    const line = actionLineOf(text)
    return {
      kind: "accion",
      message: line ? `Desde aquí solo respondo con cifras. Para que el agente lo haga, prende «${line.name}».` : REPORT_ASK_WORDS.accion,
      line,
    }
  }
  if (interpretation.kind === "no_sabe") {
    await record(tx, orgId, userId, "no_sabe", usedModel, interpretation.closest[0]?.figure ?? null)
    return { kind: "no_sabe", message: REPORT_ASK_WORDS.noSabe, closest: closestOptions(interpretation.closest, screen) }
  }
  if (interpretation.kind === "pregunta") {
    const base = { ...screenOf(interpretation, screen), group: interpretation.group }
    const offered = interpretation.candidates.map((candidate) => optionOf(candidate, base)).filter((option) => option !== null)
    await record(tx, orgId, userId, "pregunta", usedModel, interpretation.candidates[0]?.figure ?? null, interpretation.group)
    if (offered.length === 0) return { kind: "no_sabe", message: REPORT_ASK_WORDS.noSabe, closest: [] }
    return { kind: "pregunta", message: interpretation.group === "sede" ? REPORT_ASK_WORDS.preguntaSedes : REPORT_ASK_WORDS.pregunta, options: offered }
  }
  const query: ReportAskQuery = { ...screenOf(interpretation, screen), figure: interpretation.figure, group: interpretation.group, focus: interpretation.focus }
  const answer = await answerFor(tx, orgId, query, options)
  await record(tx, orgId, userId, "respondida", usedModel, query.figure, answer.query.group)
  return { kind: "respuesta", answer }
}

function closestOptions(closest: ReportCandidate[], screen: ReportQuery): Array<{ label: string; query: ReportAskQuery }> {
  return closest.map((candidate) => optionOf(candidate, { ...screen, group: "total" })).filter((option) => option !== null)
}

/** «Escríbeles a los que no vinieron»: qué línea de Argos lo haría, por palabras. */
export function actionLineOf(text: string): { key: string; name: string } | null {
  const plain = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  const key = LINE_WORDS.find(([, words]) => words.test(plain))?.[0]
  const line = key ? adminLineOf(key) : null
  return line ? { key: line.key, name: line.name } : null
}

/** Una opción tocada en una respuesta (otro periodo, otra agrupación, una de las que ofreció): sin modelo. */
export async function answerReportQuery(tx: Db, orgId: string, userId: string, query: ReportAskQuery, options: ReportAskOptions): Promise<ReportAskResult> {
  const answer = await answerFor(tx, orgId, query, options)
  await record(tx, orgId, userId, "respondida", false, query.figure, answer.query.group)
  return { kind: "respuesta", answer }
}

const TAB_WORDS: Record<string, string> = { resumen: "Resumen", finanzas: "Finanzas", pacientes: "Pacientes", agenda: "Agenda", agente: "Agente" }

export function assertReportQuery(query: ReportAskQuery, billing: boolean): void {
  const figure = reportFigureOf(query.figure)
  if (!figure || (figure.billing && !billing)) throw validation("Esa cifra no está entre las que Argos sabe responder")
  if (!(FIGURE_GROUPS as readonly string[]).includes(query.group)) throw validation("Agrupación no reconocida")
  if (!REPORT_PERIOD_PATTERN.test(query.period)) throw validation("Periodo no reconocido")
}

/** La respuesta de una pregunta ya entendida: siempre con la consulta de su pestaña. */
export async function answerFor(tx: Db, orgId: string, query: ReportAskQuery, options: ReportAskOptions): Promise<ReportAnswer> {
  assertReportQuery(query, options.billing)
  const now = options.now ?? new Date()
  const scope = await reportScope(tx, orgId, { period: query.period, branchId: query.branchId }, now)
  const ctx: FigureContext = { tx, orgId, scope, billing: options.billing }
  const result = await computeFigure(ctx, { figure: query.figure, group: query.group, focus: query.focus ?? null })
  const { figure } = result
  const understood: ReportAskQuery = { ...query, group: result.group, focus: result.focus }
  const sentence = await sentenceOf(ctx, result)
  const listCount = figure.list ? figure.list.count(result.total) : 0
  const list = figure.list && listCount > 0 ? { key: figure.list.key, label: listLabel(figure.list, listCount, scope.locale) } : null

  const followUps: ReportFollowUp[] = []
  const previous = figure.asOfToday ? null : previousPeriodKey(scope)
  if (previous) followUps.push({ label: previous.label, query: { ...understood, period: previous.key } })
  for (const group of FOLLOW_UP_GROUPS.filter((item) => item !== result.group && groupsOf(figure).includes(item)).slice(0, 2)) {
    followUps.push({ label: FIGURE_GROUP_WORDS[group], query: { ...understood, group, focus: null } })
  }
  if (figure.list?.question && list) followUps.push({ label: figure.list.question, list: figure.list.key })

  const advice = figure.advice ? ((await getReportAdvice(tx, orgId, { period: query.period, branchId: query.branchId }, options.can, now)).notices.find((item) => item.tab === figure.advice) ?? null) : null
  const chart = chartOf(result, scope)
  return {
    query: understood,
    title: result.group === "total" || result.group === figure.defaultGroup ? figure.name : `${figure.name}, ${FIGURE_GROUP_WORDS[result.group].toLowerCase()}`,
    sentence,
    how: figure.how,
    scope: scopeWords(result, scope),
    unit: figure.unit,
    currency: result.currency,
    locale: scope.locale,
    chart,
    list,
    tab: { key: figure.tab, label: `Abrir ${TAB_WORDS[figure.tab] ?? figure.tab}` },
    followUps,
    advice,
    downloadable: chart !== null,
  }
}

function listLabel(list: NonNullable<ReturnType<typeof reportFigureOf>>["list"] & object, total: number, locale: string): string {
  // «Ver la cita», «Ver las 11 citas», «Ver los 38 pacientes».
  if (total === 1) return `Ver ${list.feminine ? "la" : "el"} ${list.noun.one}`
  return `Ver ${list.feminine ? "las" : "los"} ${countWords(total, list.noun, locale)}`
}

/** El gráfico de la respuesta: barras por grupo o los 12 meses. Las cifras son las calculadas. */
function chartOf(result: FigureResult, scope: ReportScope): ReportAnswerChart | null {
  const { figure } = result
  const fmt = (value: number) => formatFigure(value, figure.unit, { currency: result.currency, locale: scope.locale })
  if (result.group === "total" || result.group === "mes") {
    if (figure.asOfToday) return null
    const points = result.months.map((month) => ({
      key: `${month.month.year}-${String(month.month.month).padStart(2, "0")}`,
      label: monthWords(month.month, scope.locale),
      short: monthWords(month.month, scope.locale).slice(0, 3),
      partial: month.partial,
      value: month.value.value,
    }))
    return points.some((point) => point.value !== null && point.value !== 0) ? { kind: "months", points } : null
  }
  const rows = result.rows.filter((row) => row.value.value !== null)
  if (rows.length === 0) return null
  const withPart = figure.key === "nos_buscaron"
  return {
    kind: "bars",
    legend: withPart ? { value: "Nos buscaron", part: "Vinieron" } : null,
    rows: rows.map((row) => ({
      key: row.key,
      label: row.label,
      value: row.value.value ?? 0,
      ...(withPart ? { part: row.value.part ?? 0 } : {}),
      valueText: withPart ? `${row.value.part ?? 0} de ${row.value.value ?? 0}` : fmt(row.value.value ?? 0),
      ...(figure.unit === "rate" && row.value.whole ? { note: `${row.value.part ?? 0} de ${row.value.whole}` } : {}),
      highlight: result.focus ? row.key === result.focus : row === rows[0],
    })),
  }
}

// --- Fijar en el Resumen -----------------------------------------------------------------

export interface PinnedAnswer {
  id: string
  pinnedBy: string
  /** El día en que se fijó, en la zona de la clínica (`YYYY-MM-DD`). */
  pinnedOn: string
  answer: ReportAnswer | null
}

/** Las respuestas fijadas, recalculadas con el periodo y la sede de la pantalla (decisión 8). */
export async function listReportPins(tx: Db, orgId: string, screen: ReportQuery, options: ReportAskOptions) {
  const rows = await tx.execute<{ id: string; figure: string; groupBy: string; focus: string; name: string; createdAt: string; timezone: string }>(sql`
    select p.id, p.figure, p.group_by as "groupBy", p.focus, u.name, p.created_at::text as "createdAt", op.timezone
    from report_pin p join "user" u on u.id = p.created_by
    join org_profile op on op.organization_id = p.organization_id
    where p.organization_id = ${orgId} order by p.created_at, p.id`)
  const pins: PinnedAnswer[] = []
  for (const row of rows) {
    const figure = reportFigureOf(row.figure)
    // Lo pagado a odentIA no se recalcula para quien no ve Facturación; una cifra retirada del catálogo tampoco.
    const visible = !!figure && (!figure.billing || options.billing)
    const answer = visible
      ? await answerFor(tx, orgId, { ...screen, figure: row.figure, group: row.groupBy as FigureGroup, focus: row.focus || null }, options)
      : null
    pins.push({ id: row.id, pinnedBy: row.name, pinnedOn: reportDayOf(row.timezone, new Date(row.createdAt)), answer })
  }
  return { limit: REPORT_PIN_LIMIT, pins }
}

/**
 * Lo que está fijado, sin recalcularlo: con esto una respuesta del panel sabe
 * si ya está en el Resumen, aunque alguien la haya quitado desde ahí.
 */
export async function listReportPinKeys(tx: Db, orgId: string): Promise<Array<{ id: string; figure: string; group: FigureGroup; focus: string | null }>> {
  const rows = await tx
    .select({ id: reportPin.id, figure: reportPin.figure, group: reportPin.groupBy, focus: reportPin.focus })
    .from(reportPin)
    .where(eq(reportPin.organizationId, orgId))
    .orderBy(reportPin.createdAt, reportPin.id)
  return rows.map((row) => ({ id: row.id, figure: row.figure, group: row.group as FigureGroup, focus: row.focus || null }))
}

export async function pinReportAnswer(tx: Db, orgId: string, userId: string, query: Pick<ReportAskQuery, "figure" | "group" | "focus">, billing: boolean): Promise<{ id: string }> {
  const figure = reportFigureOf(query.figure)
  if (!figure || (figure.billing && !billing)) throw validation("Esa cifra no está entre las que Argos sabe responder")
  const group = groupsOf(figure).includes(query.group) ? query.group : (figure.defaultGroup ?? "total")
  const focus = query.focus ?? ""
  const [existing] = await tx
    .select({ id: reportPin.id })
    .from(reportPin)
    .where(and(eq(reportPin.organizationId, orgId), eq(reportPin.figure, figure.key), eq(reportPin.groupBy, group), eq(reportPin.focus, focus)))
    .limit(1)
  if (existing) return existing
  try {
    const [row] = await tx.insert(reportPin).values({ organizationId: orgId, figure: figure.key, groupBy: group, focus, createdBy: userId }).returning({ id: reportPin.id })
    return { id: row!.id }
  } catch (error) {
    if (isCheckViolation(error)) {
      throw new ServiceError("REPORT_PIN_LIMIT", 409, `Ya hay ${REPORT_PIN_LIMIT} respuestas fijadas en el Resumen. Quita una para fijar esta.`)
    }
    if (isUniqueViolation(error)) throw new ServiceError("REPORT_PIN_EXISTS", 409, "Esa respuesta ya está fijada en el Resumen.")
    throw error
  }
}

export async function unpinReportAnswer(tx: Db, orgId: string, pinId: string): Promise<void> {
  const removed = await tx.delete(reportPin).where(and(eq(reportPin.organizationId, orgId), eq(reportPin.id, pinId))).returning({ id: reportPin.id })
  if (removed.length === 0) throw notFound("Respuesta fijada")
}
