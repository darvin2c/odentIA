/**
 * La respuesta de Argos sobre las vistas del negocio (ADR 0073): lo que hace
 * falta antes de llamar a los modelos, la frase con huecos llenada con el
 * resultado y el registro de cada pregunta. El modelo nunca ve el resultado:
 * escribe la frase con `{columna}`, `{lista}` y `{filas}` y aquí se llenan,
 * con el formato de la clínica.
 *
 * Cada pregunta deja una fila en `report_question` con la consulta que corrió
 * y cómo terminó, nunca el texto (decisión D2). Las que pasaron por el modelo
 * cuentan para `REPORT_DAILY_LIMIT`; las que fallaron por el modelo o la base
 * no (decisión D6: el costo lo asume odentIA).
 */
import type { Db } from "@odentia/db"
import { reportQuestion } from "@odentia/db/schema/reports"
import { and, count, eq, gte, ne } from "drizzle-orm"
import { getAdminSettings } from "./agent-admin.js"
import type { ArgosQueryResult } from "./argos-query.js"
import { getOrgLocale, type OrgLocale } from "./locale.js"
import { REPORT_DAILY_LIMIT } from "./report-ask.js"
import { type ReportQuery, reportScope } from "./report-scope.js"

export const ARGOS_WORDS = {
  // Se ven en Reportes y en el buscador: no nombran una pantalla.
  apagado: "Argos está apagado. Enciéndelo para preguntarle.",
  tope: `La clínica llegó a las ${REPORT_DAILY_LIMIT} preguntas de hoy. Mañana sigo respondiendo.`,
  sinModelo: "Ahora no puedo leer preguntas. Prueba de nuevo en un momento.",
  noPudo: "No pude calcular eso. Prueba a decirlo de otra forma o con un periodo más corto.",
  noExiste: "Eso no está en los datos que registra odentIA.",
  ayuda: "Eso es de cómo se usa odentIA: te lo explica la Ayuda.",
  otro: "Respondo preguntas sobre los datos de la clínica: dinero, pacientes, agenda, tratamientos, presupuestos e inventario. Prueba con «¿cuánto cobramos este mes?».",
} as const

export type ArgosOutcome = "respondida" | "parcial" | "no_sabe" | "ayuda" | "otro" | "no_pudo"

/** Lo que hace falta antes de llamar a los modelos: si Argos está encendido, si queda tope y el formato de la clínica. */
export async function prepareArgosQuestion(
  tx: Db,
  orgId: string,
  now: Date = new Date(),
): Promise<{ enabled: boolean; roomLeft: number; zone: OrgLocale }> {
  const { enabled } = await getAdminSettings(tx, orgId)
  const [row] = await tx
    .select({ total: count() })
    .from(reportQuestion)
    .where(
      and(
        eq(reportQuestion.organizationId, orgId),
        eq(reportQuestion.usedModel, true),
        ne(reportQuestion.outcome, "no_pudo"),
        gte(reportQuestion.createdAt, new Date(now.getTime() - 86_400_000)),
      ),
    )
  return { enabled, roomLeft: Math.max(0, REPORT_DAILY_LIMIT - Number(row?.total ?? 0)), zone: await getOrgLocale(tx, orgId) }
}

export async function recordArgosQuestion(
  tx: Db,
  orgId: string,
  userId: string,
  input: { outcome: ArgosOutcome; query: string | null; usedModel: boolean },
): Promise<void> {
  await tx.insert(reportQuestion).values({ organizationId: orgId, userId, outcome: input.outcome, query: input.query, usedModel: input.usedModel })
}

/**
 * Lo que muestra la pantalla desde donde se pregunta (decisión D7): su periodo
 * y su sede valen si la pregunta no dice otros. Días locales, ambos incluidos.
 */
export async function argosScreen(tx: Db, orgId: string, screen: ReportQuery, now: Date): Promise<{ from: string; to: string; branch: string | null }> {
  const scope = await reportScope(tx, orgId, screen, now)
  const day = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: scope.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
  return { from: day(scope.window.start), to: day(new Date(scope.window.end.getTime() - 1)), branch: scope.branch?.name ?? null }
}

/** Una parte de la frase: lo que vino del resultado va destacado. */
export type ArgosSentencePart = { text: string; strong?: true }

const HOLE = /\{(\w+)\}/g
const LIST_ROWS = 10

/** Los huecos de la frase que no son columnas del resultado ni `{lista}`/`{filas}`: el modelo se equivocó. */
export function unknownArgosHoles(template: string, result: Pick<ArgosQueryResult, "columns">): string[] {
  const names = new Set(result.columns.map((column) => column.name))
  return [...template.matchAll(HOLE)].map((match) => match[1] ?? "").filter((name) => name !== "lista" && name !== "filas" && !names.has(name))
}

/** Un id (`paciente_id`, `presupuesto_id`…) sirve para contar y agrupar: no se muestra. */
export function isArgosIdColumn(name: string): boolean {
  return /(^|_)id$/.test(name)
}

/** «cobrado_dinero» → «Cobrado»: el nombre de una columna dicho para la pantalla. */
export function argosColumnLabel(name: string): string {
  const text = name.replace(/_(dinero|pct|mes)$/, "").replace(/_/g, " ").trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : name
}

/**
 * El valor con el formato de la clínica. El nombre de la columna dice qué es:
 * `_dinero` en la moneda de la clínica, `_pct` un porcentaje de 0 a 100 y
 * `_mes` un mes (así se le pide al modelo); el tipo de la base dice si es fecha.
 */
export function formatArgosValue(value: string | number | boolean | null, column: ArgosQueryResult["columns"][number], zone: Pick<OrgLocale, "locale" | "currency" | "timezone">): string {
  if (value === null) return "—"
  if (column.kind === "boolean") return value ? "sí" : "no"
  if (column.kind === "date") {
    const [year, month, day] = String(value).split("-").map(Number)
    const isMonth = /(^|_)mes$/.test(column.name)
    return new Intl.DateTimeFormat(zone.locale, { timeZone: "UTC", ...(isMonth ? {} : { day: "numeric" }), month: "long", year: "numeric" }).format(
      new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)),
    )
  }
  if (column.kind === "timestamp")
    return new Intl.DateTimeFormat(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(String(value)))
  if (column.kind === "number" && typeof value === "number") {
    if (/_dinero$/.test(column.name)) return new Intl.NumberFormat(zone.locale, { style: "currency", currency: zone.currency }).format(value)
    if (/_pct$/.test(column.name)) return `${new Intl.NumberFormat(zone.locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} %`
    return new Intl.NumberFormat(zone.locale, { maximumFractionDigits: 2 }).format(value)
  }
  return String(value)
}

/**
 * Llena la frase con el resultado: `{columna}` es el valor de la primera fila,
 * `{lista}` las primeras filas como «a (b, c); …» en el orden de la consulta,
 * con «y N más» si hay más, y `{filas}` cuántas son. En la lista, un número
 * suelto lleva el nombre de su columna («Dra. Ana Torres (citas: 65)»): el
 * dinero y los porcentajes solos ya se entienden. Un hueco desconocido queda
 * «—» (antes se reintenta). El «%» que el modelo escriba junto a un
 * porcentaje se quita: el hueco ya lo trae.
 */
export function fillArgosSentence(
  template: string,
  result: ArgosQueryResult,
  zone: Pick<OrgLocale, "locale" | "currency" | "timezone">,
): { text: string; parts: ArgosSentencePart[] } {
  const first = result.rows[0] ?? {}
  const byName = new Map(result.columns.map((column) => [column.name, column]))
  const cell = (row: Record<string, string | number | boolean | null>, name: string) => {
    const column = byName.get(name)
    return column ? formatArgosValue(row[name] ?? null, column, zone) : "—"
  }
  const [lead, ...rest] = result.columns.filter((column) => !isArgosIdColumn(column.name))
  const selfExplained = (column: ArgosQueryResult["columns"][number]) => column.kind !== "number" || /_(dinero|pct)$/.test(column.name)
  const labeled = !(rest.length === 1 && rest[0] && selfExplained(rest[0]))
  const items = result.rows.slice(0, LIST_ROWS).map((row) => {
    const head = lead ? cell(row, lead.name) : ""
    if (!rest.length) return head
    const details = rest.map((column) => (labeled && !selfExplained(column) ? `${argosColumnLabel(column.name).toLowerCase()}: ${cell(row, column.name)}` : cell(row, column.name)))
    return `${head} (${details.join(", ")})`
  })
  const more = result.truncated ? " y más" : result.rows.length > LIST_ROWS ? ` y ${result.rows.length - LIST_ROWS} más` : ""
  const list = `${items.join("; ")}${more}`
  const rows = result.truncated ? `más de ${result.rows.length}` : String(result.rows.length)
  const parts: ArgosSentencePart[] = []
  let last = 0
  for (const match of template.matchAll(HOLE)) {
    const name = match[1] ?? ""
    const at = match.index ?? 0
    if (at > last) parts.push({ text: template.slice(last, at) })
    parts.push({ text: name === "lista" ? list : name === "filas" ? rows : cell(first, name), strong: true })
    last = at + match[0].length
    if (/_pct$/.test(name)) {
      const repeated = /^\s?%/.exec(template.slice(last))
      if (repeated) last += repeated[0].length
    }
  }
  if (last < template.length) parts.push({ text: template.slice(last) })
  return { text: parts.map((part) => part.text).join(""), parts }
}
