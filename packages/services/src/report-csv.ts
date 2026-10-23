/**
 * «Descargar» de Reportes (decisión 11; ADR 0071): cada lista y cada tabla en
 * CSV (RFC 4180), con las mismas filas y columnas que la pantalla. El archivo
 * lleva la marca UTF-8 al principio para que Excel lea bien los acentos, las
 * filas terminan en CRLF y los importes van sin separador de miles y con
 * punto decimal, que es lo que entiende cualquier hoja de cálculo. El
 * teléfono solo va si quien descarga puede ver los datos de la persona.
 */
import { formatMoneyInput } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { answerFor, type ReportAskOptions, type ReportAskQuery } from "./report-ask.js"
import { getReportCommissions } from "./report-finance.js"
import { channelWords, reportFigureOf } from "./report-figures.js"
import { getPatientReportList, isPatientReportList } from "./report-patients.js"
import { type ReportQuery, reportScope } from "./report-scope.js"
import { getReportProfessionals } from "./report-summary.js"
import { getReportList, REPORT_LIST_DOWNLOAD_LIMIT, type ReportListKey } from "./reports.js"

export type CsvCell = string | number | boolean | null | undefined

/**
 * Un campo según RFC 4180: entre comillas si lleva coma, comillas o salto de
 * línea. Un texto que una hoja de cálculo leería como fórmula (empieza por =,
 * +, -, @, tabulador o retorno) va con un apóstrofo delante (OWASP, «CSV
 * injection»): el nombre de quien escribe lo pone esa persona. Un número no.
 */
function field(value: CsvCell): string {
  if (value === null || value === undefined) return ""
  let text = typeof value === "boolean" ? (value ? "Sí" : "No") : String(value)
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return `﻿${[header, ...rows].map((row) => row.map(field).join(",")).join("\r\n")}\r\n`
}

/** «deuda-mas-de-30-dias-2026-09.csv»: el título sin tildes ni signos, y el periodo. */
export function csvFileName(title: string, period: string): string {
  const slug = (text: string) =>
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  return `${slug(title) || "reporte"}-${slug(period.replace("..", "-a-"))}.csv`
}

/** El periodo resuelto para el nombre del archivo: «2026-09», «2026-07-a-2026-09», «2026-09-10-a-2026-09-25». */
export function periodFileKey(span: { from: { year: number; month: number }; to: { year: number; month: number }; days?: { from: string; to: string } }): string {
  const month = (value: { year: number; month: number }) => `${value.year}-${String(value.month).padStart(2, "0")}`
  if (span.days) return `${span.days.from}..${span.days.to}`
  return month(span.from) === month(span.to) ? month(span.from) : `${month(span.from)}..${month(span.to)}`
}

export interface CsvFile {
  filename: string
  body: string
}

function amount(cents: number | null, currency: string | null): string {
  if (cents === null || !currency) return ""
  // Sin agrupar miles y con punto decimal: lo que lee cualquier hoja de cálculo, en cualquier idioma.
  return `${cents < 0 ? "-" : ""}${formatMoneyInput(Math.abs(cents), currency, "en-US")}`
}

/** El instante en la zona de la clínica: `YYYY-MM-DD HH:MM`. */
function localTime(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`
}

const LIST_TITLES: Record<string, string> = {
  no_show: "No vinieron",
  cancelled: "Canceladas",
  unmarked: "Pasaron sin marcar",
  new_patients: "Pacientes nuevos",
  debts_overdue: "Deuda de más de 30 días",
  agent_booked: "Citas que agendó el agente",
  agent_handoffs: "Pasaron al equipo",
  debts_age_0_30: "Te deben hasta 30 días",
  debts_age_31_60: "Te deben de 31 a 60 días",
  debts_age_61_90: "Te deben de 61 a 90 días",
  debts_age_90_plus: "Te deben más de 90 días",
  upcoming_unbooked: "Aceptaron y no tienen cita",
  funnel_sought: "Nos buscaron por primera vez",
  funnel_booked: "Agendaron",
  funnel_came: "Vinieron",
  funnel_budget: "Recibieron presupuesto",
  funnel_accepted: "Aceptaron su presupuesto",
  funnel_paid: "Pagaron algo",
  funnel_lost_booked: "No agendaron",
  funnel_lost_came: "Agendaron y no vinieron",
  funnel_lost_budget: "Vinieron y no recibieron presupuesto",
  funnel_lost_accepted: "Aún no responden o lo rechazaron",
  funnel_lost_paid: "Aceptaron y aún no pagan",
  funnel_stopped: "Dejaron de escribir",
  controls_missed: "No vinieron a su control",
  lapsed: "Sin venir hace meses",
  invited_returned: "Volvieron tras la invitación",
}

/** Los teléfonos de las personas de una lista, por paciente o por conversación. */
async function phonesOf(tx: Db, orgId: string, rows: Array<{ patientId: string | null; conversationId?: string | null }>) {
  const patients = [...new Set(rows.map((row) => row.patientId).filter((id): id is string => !!id))]
  const conversations = [...new Set(rows.map((row) => (row.patientId ? null : row.conversationId)).filter((id): id is string => !!id))]
  const byPatient = new Map<string, string>()
  const byConversation = new Map<string, string>()
  if (patients.length > 0) {
    const found = await tx.execute<{ id: string; phone: string | null }>(sql`
      select p.id, c.phone from patient p join contact c on c.organization_id = p.organization_id and c.id = p.person_id
      where p.organization_id = ${orgId} and p.id in (${sql.join(patients.map((id) => sql`${id}`), sql`, `)})`)
    for (const row of found) if (row.phone) byPatient.set(row.id, row.phone)
  }
  if (conversations.length > 0) {
    const found = await tx.execute<{ id: string; phone: string | null }>(sql`
      select v.id, c.phone from conversation v join contact c on c.organization_id = v.organization_id and c.id = v.contact_id
      where v.organization_id = ${orgId} and v.id in (${sql.join(conversations.map((id) => sql`${id}`), sql`, `)})`)
    for (const row of found) if (row.phone) byConversation.set(row.id, row.phone)
  }
  return (row: { patientId: string | null; conversationId?: string | null }) =>
    (row.patientId ? byPatient.get(row.patientId) : row.conversationId ? byConversation.get(row.conversationId) : undefined) ?? ""
}

/** Una lista de Reportes entera (hasta `REPORT_LIST_DOWNLOAD_LIMIT` filas), como la abre su tarjeta. */
export async function reportListCsv(
  tx: Db,
  orgId: string,
  query: ReportQuery & { list: string },
  can: (permission: string) => boolean,
  now: Date = new Date(),
): Promise<CsvFile> {
  const list = query.list
  const report = isPatientReportList(list)
    ? await getPatientReportList(tx, orgId, { ...query, list, limit: REPORT_LIST_DOWNLOAD_LIMIT }, now)
    : await getReportList(tx, orgId, { ...query, list: list as ReportListKey, limit: REPORT_LIST_DOWNLOAD_LIMIT }, now)
  const rows = report.rows as Array<{
    at: string
    patientId: string | null
    conversationId?: string | null
    personName: string
    channel?: string | null
    title: string | null
    professionalName: string | null
    branchName: string | null
    hasNextAppointment: boolean
    cents: number | null
    currency: string | null
  }>
  const withPhone = can("patients.read") || can("crm.read")
  const phone = withPhone ? await phonesOf(tx, orgId, rows) : null
  const header = ["Fecha", "Persona", ...(phone ? ["Teléfono"] : []), "Canal", "Detalle", "Profesional", "Sede", "Importe", "Moneda", "Ya tiene otra cita"]
  const body = rows.map((row) => [
    localTime(row.at, report.timezone),
    row.personName,
    ...(phone ? [phone(row)] : []),
    row.channel === undefined ? "" : channelWords(row.channel ?? null),
    row.title,
    row.professionalName,
    row.branchName,
    amount(row.cents, row.currency),
    row.currency,
    row.hasNextAppointment,
  ])
  return { filename: csvFileName(LIST_TITLES[list] ?? list, periodFileKey(report.period)), body: toCsv(header, body) }
}

/** «Por profesional» del Resumen. */
export async function reportProfessionalsCsv(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()): Promise<CsvFile> {
  const report = await getReportProfessionals(tx, orgId, query, now)
  const rate = (part: number, total: number) => (total > 0 ? Math.round((part * 100) / total) : "")
  const header = ["Profesional", "Atendidas", "Citas que ya pasaron", "No vinieron", "No vinieron (%)", "Presupuestos presentados", "Aceptados", "Aceptaron (%)", "Horas de agenda", "Horas con citas", "Ocupado (%)", `Cobrado (${report.currency})`]
  const body = report.rows.map((row) => [
    row.name,
    row.attended,
    row.total,
    row.noShow,
    rate(row.noShow, row.total),
    row.presented,
    row.accepted,
    rate(row.accepted, row.presented),
    Math.round(row.availMin / 60),
    Math.round(row.occMin / 60),
    rate(row.occMin, row.availMin),
    amount(row.collectedCents, report.currency),
  ])
  return { filename: csvFileName("por profesional", periodFileKey(report.period)), body: toCsv(header, body) }
}

/** Finanzas › Comisiones, una fila por profesional, con las columnas de su tabla. */
export async function reportCommissionsCsv(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()): Promise<CsvFile> {
  const report = await getReportCommissions(tx, orgId, query, now)
  const money = (cents: number) => amount(cents, report.currency)
  const header = ["Profesional", "Atendió", "Atendido sin cobrar", "Se cobró", "Porcentaje", "Comisión", "Pagado", "Por pagar", "A descontar", "Moneda"]
  const body = report.rows.map((row) => [
    row.name,
    money(row.attendedCents),
    money(row.unpaidCents),
    money(row.collectedCents),
    row.rateBps / 100,
    money(row.commissionCents),
    money(row.paidCents),
    money(row.pendingCents),
    money(row.discountCents),
    report.currency,
  ])
  return { filename: csvFileName("comisiones", periodFileKey(report.period)), body: toCsv(header, body) }
}

const GROUP_COLUMN: Partial<Record<string, string>> = {
  sede: "Sede",
  profesional: "Profesional",
  canal: "Canal",
  medio: "Medio de pago",
  tratamiento: "Tratamiento",
  categoria: "Tipo de gasto",
  como_nos_conocio: "Cómo nos conoció",
  antiguedad: "Antigüedad",
}

/** La respuesta de Argos con sus filas: lo que dibuja su gráfico, como tabla. */
export async function reportAnswerCsv(tx: Db, orgId: string, query: ReportAskQuery, options: ReportAskOptions): Promise<CsvFile> {
  const answer = await answerFor(tx, orgId, query, options)
  const chart = answer.chart
  const name = reportFigureOf(answer.query.figure)?.name ?? answer.title
  // La cifra como número que una hoja de cálculo puede sumar: importes sin miles, horas en horas, porcentajes enteros.
  const number = (value: number | null): CsvCell =>
    value === null
      ? ""
      : answer.unit === "money"
        ? amount(Math.round(value), answer.currency)
        : answer.unit === "hours"
          ? Math.round(value / 60)
          : Math.round(value)
  const unit = answer.unit === "money" ? ` (${answer.currency})` : answer.unit === "rate" ? " (%)" : answer.unit === "hours" ? " (horas)" : answer.unit === "minutes" ? " (minutos)" : ""
  const bars = chart?.kind === "bars" ? chart : null
  const part = bars?.rows.some((row) => row.part !== undefined) ? (bars.legend?.part ?? "Parte") : null
  const note = bars?.rows.some((row) => row.note) ?? false
  // Primera columna: el grupo (Profesional, Sede…); después, la cifra con su nombre.
  const header = bars
    ? [GROUP_COLUMN[answer.query.group] ?? "Grupo", `${name}${unit}`, ...(part ? [part] : []), ...(note ? ["Detalle"] : [])]
    : ["Mes", `${name}${unit}`]
  const rows = bars
    ? bars.rows.map((row) => [row.label, number(row.value), ...(part ? [row.part ?? ""] : []), ...(note ? [row.note ?? ""] : [])])
    : (chart?.kind === "months" ? chart.points : []).map((point) => [point.key, number(point.value)])
  const scope = await reportScope(tx, orgId, { period: query.period, branchId: query.branchId }, options.now ?? new Date())
  return { filename: csvFileName(answer.title, periodFileKey(scope.window)), body: toCsv(header, rows) }
}
