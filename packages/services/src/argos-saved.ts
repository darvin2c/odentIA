/**
 * Lo que queda guardado de una respuesta de Argos (ADR 0073, decisiones D2 y
 * D5): la consulta y las frases con huecos que escribió el modelo, nunca el
 * texto de la pregunta ni los datos. Con eso se fija en el Resumen (se vuelve
 * a correr cada vez, siempre al día), se descarga en CSV y se sigue con otra
 * fecha u orden sin llamar otra vez al modelo.
 */
import type { Db } from "@odentia/db"
import { reportPin, reportQuestion, REPORT_PIN_LIMIT } from "@odentia/db/schema/reports"
import { and, eq, isNotNull, sql } from "drizzle-orm"
import { argosColumnLabel, isArgosIdColumn } from "./argos-answer.js"
import type { ArgosQueryResult } from "./argos-query.js"
import { isCheckViolation, isUniqueViolation, notFound, ServiceError } from "./errors.js"
import { type CsvFile, csvFileName, toCsv } from "./report-csv.js"

/** Las pantallas de odentIA a las que una respuesta puede llevar («Abrir Finanzas»). */
export const ARGOS_SCREENS = ["finanzas", "pacientes", "agenda", "presupuestos", "inventario", "servicios", "reportes", "ninguna"] as const
export type ArgosScreenKey = (typeof ARGOS_SCREENS)[number]

/** Una respuesta que se puede volver a correr: su consulta y sus frases. */
export interface ArgosStoredAnswer {
  sql: string
  frase: string
  frase_vacia: string
  como: string
  titulo: string
  pantalla: ArgosScreenKey
  /** Respondió solo una parte: lo dice también fijada, con lo que falta. */
  parcial?: boolean
  falta?: string
}

/** Lo que guarda una pregunta además de su consulta: sus frases y las consultas para seguir (null: no se ofreció). */
export interface ArgosStoredPlan extends Omit<ArgosStoredAnswer, "sql"> {
  seguir: Array<{ etiqueta: string; sql: string; frase: string; frase_vacia: string; como?: string } | null>
}

/**
 * La respuesta guardada de una pregunta de la clínica: la principal o, con
 * `option`, una de las de seguir (con el título y la pantalla de la pregunta).
 */
export async function getArgosAnswer(tx: Db, orgId: string, userId: string, questionId: string, option: number | null = null): Promise<ArgosStoredAnswer> {
  // Solo quien preguntó: el id de otra persona no sirve aunque sea de la misma clínica.
  const [row] = await tx
    .select({ query: reportQuestion.query, plan: reportQuestion.plan })
    .from(reportQuestion)
    .where(and(eq(reportQuestion.organizationId, orgId), eq(reportQuestion.userId, userId), eq(reportQuestion.id, questionId)))
    .limit(1)
  const plan = row?.plan as ArgosStoredPlan | null | undefined
  if (!row?.query || !plan) throw notFound("Respuesta de Argos")
  if (option === null)
    return {
      sql: row.query,
      frase: plan.frase,
      frase_vacia: plan.frase_vacia,
      como: plan.como,
      titulo: plan.titulo,
      pantalla: plan.pantalla,
      ...(plan.parcial ? { parcial: true, falta: plan.falta ?? "" } : {}),
    }
  const follow = plan.seguir[option]
  if (!follow) throw notFound("Opción de la respuesta")
  return {
    sql: follow.sql,
    frase: follow.frase,
    frase_vacia: follow.frase_vacia,
    como: follow.como?.trim() || plan.como,
    titulo: `${plan.titulo} · ${follow.etiqueta}`,
    pantalla: plan.pantalla,
  }
}

/** Fija una respuesta en el Resumen; la misma consulta no se fija dos veces. */
export async function pinArgosAnswer(tx: Db, orgId: string, userId: string, answer: ArgosStoredAnswer): Promise<{ id: string }> {
  const [existing] = await tx
    .select({ id: reportPin.id })
    .from(reportPin)
    .where(and(eq(reportPin.organizationId, orgId), isNotNull(reportPin.argos), sql`md5(${reportPin.argos} ->> 'sql') = md5(${answer.sql})`))
    .limit(1)
  if (existing) return existing
  try {
    const [row] = await tx.insert(reportPin).values({ organizationId: orgId, argos: answer, createdBy: userId }).returning({ id: reportPin.id })
    return { id: row?.id ?? "" }
  } catch (error) {
    if (isCheckViolation(error)) throw new ServiceError("REPORT_PIN_LIMIT", 409, `Ya hay ${REPORT_PIN_LIMIT} respuestas fijadas en el Resumen. Quita una para fijar esta.`)
    if (isUniqueViolation(error)) throw new ServiceError("REPORT_PIN_EXISTS", 409, "Esa respuesta ya está fijada en el Resumen.")
    throw error
  }
}

/** Las respuestas de Argos fijadas en el Resumen, en el orden en que se fijaron, con quién y cuándo. */
export async function listArgosPins(tx: Db, orgId: string): Promise<Array<{ id: string; answer: ArgosStoredAnswer; pinnedBy: string; pinnedAt: string }>> {
  const rows = await tx.execute<{ id: string; argos: ArgosStoredAnswer; name: string; createdAt: string }>(sql`
    select p.id, p.argos, u.name, p.created_at::text as "createdAt"
    from report_pin p join "user" u on u.id = p.created_by
    where p.organization_id = ${orgId} and p.argos is not null order by p.created_at, p.id`)
  return [...rows].map((row) => ({ id: row.id, answer: row.argos, pinnedBy: row.name, pinnedAt: row.createdAt }))
}

/**
 * El resultado en CSV (RFC 4180, con marca UTF-8): las columnas que se
 * muestran, con sus nombres, y los valores tal cual; un momento, como en los
 * demás CSV de Reportes, «AAAA-MM-DD HH:MM» en la zona de la clínica.
 */
export function argosAnswerCsv(title: string, day: string, result: ArgosQueryResult, timezone: string): CsvFile {
  const columns = result.columns.filter((column) => !isArgosIdColumn(column.name))
  const moment = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
  const cell = (value: string | number | boolean | null | undefined, kind: string) =>
    kind === "timestamp" && typeof value === "string" ? moment.format(new Date(value)) : value
  return {
    filename: csvFileName(title, day),
    body: toCsv(
      columns.map((column) => argosColumnLabel(column.name)),
      result.rows.map((row) => columns.map((column) => cell(row[column.name], column.kind))),
    ),
  }
}
