/**
 * Lo que queda guardado de una respuesta de Argos (ADR 0075, decisiones D2 y
 * D5): la consulta y las frases con huecos que escribió el modelo, nunca el
 * texto de la pregunta ni los datos. Con eso se fija en el Resumen (se vuelve
 * a correr cada vez, siempre al día), se descarga en CSV, se sigue con otro
 * orden o grupo y se ve con otro periodo o sede sin llamar otra vez al modelo.
 */
import type { Db } from "@odentia/db"
import { reportPin, reportQuestion, REPORT_PIN_LIMIT } from "@odentia/db/schema/reports"
import { and, eq, isNotNull, sql } from "drizzle-orm"
import { argosColumnLabel, isArgosHiddenColumn } from "./argos-answer.js"
import { type ArgosPeriodSpec, type ArgosResolvedPeriod, bindArgosPeriod, findArgosBranch, listArgosBranches, resolveArgosPeriod } from "./argos-period.js"
import type { ArgosQueryResult } from "./argos-query.js"
import { isCheckViolation, isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
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
  /** El periodo que pidió la pregunta (D8); sin él, la consulta lleva sus fechas escritas (respuestas de antes). */
  periodo?: ArgosPeriodSpec | null
  /** La sede que nombró la pregunta o la de Reportes (D13), si la consulta la usa. */
  sede?: string | null
  /** De dónde sale (D21): una cifra oficial (con su clave) o una consulta de Argos. Sin valor: de antes de la fase 6. */
  fuente?: "oficial" | "argos"
  cifra?: string | null
  /** El paciente elegido entre los que se llaman igual (D23), si la consulta usa `:paciente`. */
  paciente?: string | null
}

/** Lo que guarda una pregunta además de su consulta: sus frases y las consultas para seguir (null: no se ofreció). */
export interface ArgosStoredPlan extends Omit<ArgosStoredAnswer, "sql"> {
  seguir: Array<{ etiqueta: string; sql: string; frase: string; frase_vacia: string; como?: string; fuente?: "oficial" | "argos"; cifra?: string | null } | null>
  /** Los pacientes que se llaman como el de la pregunta (D23): la pantalla pregunta cuál, sin volver al modelo. */
  pacientes?: ArgosPatientOption[]
}

/** Un paciente para elegir entre los que se llaman igual: su id y lo que lo distingue, sin datos clínicos. */
export interface ArgosPatientOption {
  id: string
  label: string
}

/** La consulta y el plan guardados de una pregunta; solo los ve quien preguntó. */
export async function getArgosPlan(tx: Db, orgId: string, userId: string, questionId: string): Promise<{ query: string; plan: ArgosStoredPlan }> {
  // Solo quien preguntó: el id de otra persona no sirve aunque sea de la misma clínica.
  const [row] = await tx
    .select({ query: reportQuestion.query, plan: reportQuestion.plan })
    .from(reportQuestion)
    .where(and(eq(reportQuestion.organizationId, orgId), eq(reportQuestion.userId, userId), eq(reportQuestion.id, questionId)))
    .limit(1)
  const plan = row?.plan as ArgosStoredPlan | null | undefined
  if (!row?.query || !plan) throw notFound("Respuesta de Argos")
  return { query: row.query, plan }
}

/**
 * La respuesta guardada de una pregunta de la clínica: la principal o, con
 * `option`, una de las de seguir (con el título y la pantalla de la pregunta).
 */
export async function getArgosAnswer(
  tx: Db,
  orgId: string,
  userId: string,
  questionId: string,
  option: number | null = null,
  /** El paciente elegido entre los que se llaman igual (D23): solo uno de los que se ofrecieron. */
  patientId?: string,
): Promise<ArgosStoredAnswer> {
  const row = await getArgosPlan(tx, orgId, userId, questionId)
  if (patientId !== undefined && !row.plan.pacientes?.some((item) => item.id === patientId)) throw validation("Ese paciente no es uno de los que se ofrecieron")
  const plan = patientId === undefined ? row.plan : { ...row.plan, paciente: patientId }
  if (option === null)
    return {
      sql: row.query,
      frase: plan.frase,
      frase_vacia: plan.frase_vacia,
      como: plan.como,
      titulo: plan.titulo,
      pantalla: plan.pantalla,
      ...(plan.parcial ? { parcial: true, falta: plan.falta ?? "" } : {}),
      ...(plan.periodo !== undefined ? { periodo: plan.periodo } : {}),
      ...(plan.sede !== undefined ? { sede: plan.sede } : {}),
      ...(plan.fuente ? { fuente: plan.fuente, cifra: plan.cifra ?? null } : {}),
      ...(plan.paciente ? { paciente: plan.paciente } : {}),
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
    // Las de seguir comparten el periodo, la sede y el paciente de la respuesta.
    ...(plan.periodo !== undefined ? { periodo: plan.periodo } : {}),
    ...(plan.sede !== undefined ? { sede: plan.sede } : {}),
    ...(follow.fuente ? { fuente: follow.fuente, cifra: follow.cifra ?? null } : {}),
    ...(plan.paciente ? { paciente: plan.paciente } : {}),
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
  const columns = result.columns.filter((column) => !isArgosHiddenColumn(column.name))
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

/** Lo que se elige en la pantalla para ver una respuesta: otro periodo, el segundo (D15) u otra sede (D13). */
export interface ArgosChoice {
  period?: string | undefined
  other?: string | null | undefined
  /** null: todas las sedes; sin valor: la de la pregunta. */
  branchId?: string | null | undefined
  /** El paciente elegido entre los que se llaman igual (D23). */
  patientId?: string | undefined
}

/** El periodo y la sede con que se corre una respuesta guardada. */
export interface ArgosBound {
  /** Una respuesta de antes de la fase 5: su consulta lleva las fechas escritas y se corre tal cual. */
  legacy: boolean
  period: ArgosResolvedPeriod | null
  branch: { id: string; name: string } | null
  branches: Array<{ id: string; name: string }>
  /** El paciente de `:paciente`, si la consulta lo usa. */
  patient: string | null
}

/**
 * Lo elegido en la pantalla o, si no, lo de la pregunta: el periodo se
 * calcula otra vez (los últimos N días se mueven con el día) y la comparación
 * es siempre la que pidió la pregunta (D14). Lo que es a hoy no cambia de
 * periodo (D12). Un periodo o una sede que no existen son un error de
 * validación.
 */
export async function argosChoiceOf(
  tx: Db,
  orgId: string,
  stored: Pick<ArgosStoredAnswer, "periodo" | "sede" | "paciente"> & { pacientes?: ArgosPatientOption[] | undefined },
  choice: ArgosChoice,
  zone: { timezone: string; locale: string },
  now: Date,
): Promise<ArgosBound> {
  const branches = await listArgosBranches(tx, orgId)
  if (!stored.periodo) return { legacy: true, period: null, branch: null, branches, patient: null }
  // Solo uno de los que se ofrecieron: un id cualquiera no sirve.
  if (choice.patientId !== undefined && !stored.pacientes?.some((option) => option.id === choice.patientId)) throw validation("Ese paciente no es uno de los que se ofrecieron")
  const patient = choice.patientId ?? stored.paciente ?? null
  const spec = stored.periodo
  const period =
    spec.periodo === "a_hoy"
      ? null
      : resolveArgosPeriod(
          {
            periodo: choice.period ?? spec.periodo,
            compara: spec.compara,
            ...(spec.compara === "otro" ? { otro: choice.other ?? spec.otro ?? null } : {}),
          },
          zone,
          now,
        )
  let branch: { id: string; name: string } | null = null
  if (choice.branchId === undefined) branch = stored.sede ? findArgosBranch(branches, stored.sede) : null
  else if (choice.branchId !== null) {
    branch = branches.find((item) => item.id === choice.branchId) ?? null
    if (!branch) throw validation("Esa sede no existe o está desactivada")
  }
  return { legacy: false, period, branch, branches, patient }
}

/** La consulta guardada con el periodo y la sede puestos; la de antes de la fase 5, tal cual. */
export function boundArgosQuery(query: string, bound: ArgosBound): string {
  if (bound.legacy) return query
  const result = bindArgosPeriod(query, bound.period, bound.branch?.name ?? null, bound.patient)
  if ("problem" in result) throw new ServiceError("ARGOS_QUERY", 409, "Esta respuesta no se puede ver con ese periodo")
  return result.sql
}
