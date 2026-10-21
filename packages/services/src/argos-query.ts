/**
 * Argos consulta las vistas del negocio (ADR 0075). El modelo escribe una
 * consulta; aquí se revisa y se corre con la llave de solo lectura del rol de
 * quien pregunta. Lo que garantiza los permisos es la base (la llave solo lee
 * las vistas `argos` de su rol, `argos_dueno` está sujeto a la RLS de la
 * clínica y nadie fuera del rol app puede cambiar `app.org_id`); el revisor es
 * una defensa más y la forma de decirle al modelo qué corregir.
 */
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { ARGOS_CATALOG, type ArgosKey } from "./argos-catalog.js"

/** La llave de base de cada rol de la aplicación. `member` no pregunta. */
const ARGOS_KEYS: Record<string, ArgosKey> = {
  owner: "gestion",
  admin: "gestion",
  reception: "recepcion",
  dentist: "clinico",
  cashier: "caja",
}

export function argosKeyOf(memberRole: string): ArgosKey | null {
  return ARGOS_KEYS[memberRole.trim().toLowerCase()] ?? null
}

/** El rol de base de la llave (`SET LOCAL ROLE`). */
export function argosRoleOf(memberRole: string): string | null {
  const key = argosKeyOf(memberRole)
  return key ? `argos_${key}` : null
}

/** Las vistas que una consulta puede nombrar (con o sin `argos.`): las del catálogo. `agenda_base` es interna. */
export const ARGOS_VIEWS: readonly string[] = ARGOS_CATALOG.map((view) => view.name)

/**
 * Funciones y palabras que pueden ir antes de un paréntesis. Sin
 * `generate_series`: no hace falta para leer las vistas y un rango enorme
 * gastaría el tope de tiempo entero.
 */
const ALLOWED_CALLS = new Set([
  // Agregados y ventanas.
  "count", "sum", "avg", "min", "max", "percentile_cont", "percentile_disc", "mode", "stddev", "variance", "string_agg", "array_agg",
  "bool_and", "bool_or", "every", "row_number", "rank", "dense_rank", "ntile", "lag", "lead", "first_value", "last_value",
  // Números, textos y fechas.
  "round", "trunc", "abs", "ceil", "ceiling", "floor", "coalesce", "nullif", "greatest", "least", "upper", "lower", "initcap", "trim",
  "length", "concat", "concat_ws", "substring", "left", "right", "replace", "position", "split_part", "date_trunc", "date_part",
  "extract", "to_char", "to_date", "make_date", "make_interval", "age", "now", "unnest", "array_length", "cardinality",
  // Palabras del lenguaje.
  "cast", "in", "exists", "any", "all", "some", "values", "over", "filter", "within", "as", "from", "join", "lateral", "on", "and", "or",
  "not", "using", "select", "where", "when", "then", "else", "by", "between", "is", "interval", "date", "timestamp", "timestamptz", "numeric", "int",
])

const FORBIDDEN_WORDS =
  /\b(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|call|do|execute|vacuum|analyze|listen|notify|unlisten|set|reset|lock|comment|security|refresh|prepare|deallocate|declare|fetch|move|cluster|reindex|checkpoint|load|import|into|returning)\b/i

export type ArgosReview = { ok: true; sql: string } | { ok: false; reason: string }

/** Un texto entre comillas simples (con `''` dentro): es un valor, no se revisa ni se cambia. */
const LITERAL = /'(?:[^']|'')*'/g

/**
 * Lo que no tiene valor va al final: en Postgres `DESC` pone los nulos
 * primero, y «el que más…» no puede ser una fila sin dato. Se agrega
 * `NULLS LAST` a cada `DESC` que no dice dónde van (`ASC` ya los pone al final).
 */
function nullsLast(text: string): string {
  return text
    .split(/('(?:[^']|'')*')/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/\bdesc\b(?!\s+nulls\b)/gi, "desc nulls last")))
    .join("")
}

/**
 * Una sola lectura (`SELECT` o `WITH … SELECT`), sin comentarios ni punto y
 * coma, que solo nombra vistas `argos` o los nombres de su `WITH`, y solo
 * llama funciones de la lista. Los textos entre comillas no se revisan por
 * dentro (son valores). Devuelve la consulta con los nulos al final.
 */
export function reviewArgosQuery(query: string): ArgosReview {
  const text = query.trim().replace(/;\s*$/, "")
  if (!text) return { ok: false, reason: "La consulta está vacía" }
  if (/--|\/\*|\$/.test(text)) return { ok: false, reason: "Sin comentarios ni comillas de dólar" }
  // Los valores entre comillas simples no cuentan para lo que sigue.
  const bare = text.replace(LITERAL, "''")
  // Las cadenas con escapes (E'…', U&'…') no siguen la regla de las comillas: no se admiten. Se mira sin los valores, para no confundir un «Sede E» escrito.
  if (/\b[eE]'|\b[uU]&'/.test(bare)) return { ok: false, reason: "Sin cadenas con escapes (E'…' o U&'…')" }
  if ((bare.match(/'/g)?.length ?? 0) % 2 === 1) return { ok: false, reason: "Una comilla sin cerrar" }
  if (bare.includes(";")) return { ok: false, reason: "Más de una sentencia" }
  if (!/^(with|select)\b/i.test(bare)) return { ok: false, reason: "Tiene que empezar con SELECT o WITH" }
  const forbidden = FORBIDDEN_WORDS.exec(bare)
  if (forbidden) return { ok: false, reason: `No se permite «${forbidden[1]?.toLowerCase()}»` }
  if (/\bpg_\w*|\binformation_schema\b|"/i.test(bare)) return { ok: false, reason: "Solo las vistas de Argos, sin catálogos del sistema ni nombres entre comillas" }

  const ctes = new Set([...bare.matchAll(/(?:\bwith|,)\s+([a-z_][a-z0-9_]*)\s*(?:\([^)]*\)\s*)?as\s*\(/gi)].map((match) => match[1]?.toLowerCase() ?? ""))
  const views = new Set<string>(ARGOS_VIEWS)
  const relation = /\b(?:from|join)\s+(?:lateral\s+)?([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?)/gi
  for (const match of bare.matchAll(relation)) {
    // `extract(day from c.inicio)` o `substring(x from 2)`: ese FROM es de la función, no nombra una vista.
    if (insideFromCall(bare, match.index ?? 0)) continue
    const name = (match[1] ?? "").toLowerCase()
    const view = name.startsWith("argos.") ? name.slice(6) : name
    const isCall = /^\s*\(/.test(bare.slice((match.index ?? 0) + match[0].length))
    if (isCall && ALLOWED_CALLS.has(view)) continue
    if (name.includes(".") && !name.startsWith("argos.")) return { ok: false, reason: `Solo las vistas de Argos: ${name}` }
    if (!views.has(view) && !ctes.has(view)) return { ok: false, reason: `No es una vista de Argos: ${name}` }
  }
  // Tablas sueltas tras una coma en el FROM: cualquier nombre seguido de alias o coma que no sea vista, CTE o columna no se puede
  // distinguir aquí sin un analizador; la llave de la base no lee nada fuera de sus vistas.
  for (const match of bare.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
    const name = (match[1] ?? "").toLowerCase()
    if (!ALLOWED_CALLS.has(name) && !ctes.has(name)) return { ok: false, reason: `No se permite la función «${name}»` }
  }
  return { ok: true, sql: nullsLast(text) }
}

/** Funciones de SQL que llevan FROM dentro de sus paréntesis. */
const FROM_CALLS = new Set(["extract", "substring", "trim", "position", "overlay"])

/** El FROM en `index` está dentro de los paréntesis de una de esas funciones. */
function insideFromCall(text: string, index: number): boolean {
  let depth = 0
  for (let at = index - 1; at >= 0; at -= 1) {
    if (text[at] === ")") depth += 1
    else if (text[at] === "(") {
      if (depth > 0) depth -= 1
      else return FROM_CALLS.has((/([a-z_]+)\s*$/i.exec(text.slice(0, at))?.[1] ?? "").toLowerCase())
    }
  }
  return false
}

export class ArgosQueryError extends Error {
  constructor(
    readonly code: "REVISOR" | "PERMISO" | "TIEMPO" | "CONSULTA",
    message: string,
  ) {
    super(message)
  }
}

/** Qué es cada columna del resultado, por su tipo en la base: así se le da formato sin adivinar. */
export type ArgosColumnKind = "number" | "date" | "timestamp" | "boolean" | "text"

export interface ArgosQueryResult {
  columns: Array<{ name: string; kind: ArgosColumnKind }>
  /** Valores listos para JSON: números como número, `date` como `AAAA-MM-DD` y `timestamptz` en ISO. */
  rows: Array<Record<string, string | number | boolean | null>>
  /** Había más filas que el tope: la respuesta lo dice. */
  truncated: boolean
}

/** Tipos de PostgreSQL por su oid (`pg_type`). */
const KIND_OF_TYPE: Record<number, ArgosColumnKind> = {
  16: "boolean",
  20: "number",
  21: "number",
  23: "number",
  700: "number",
  701: "number",
  1700: "number",
  1082: "date",
  1114: "timestamp",
  1184: "timestamp",
}

function plainValue(value: unknown, kind: ArgosColumnKind): string | number | boolean | null {
  if (value === null || value === undefined) return null
  if (kind === "number") return typeof value === "number" ? value : Number(value)
  if (kind === "boolean") return value === true || value === "t" || value === "true"
  // Una fecha llega como la medianoche UTC de ese día: se toma su día, no se pasa a otra zona.
  if (kind === "date") return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
  if (kind === "timestamp") return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
  return typeof value === "object" ? JSON.stringify(value) : String(value)
}

/** Tope de filas y de tiempo de una consulta de Argos; al descargar, el de los demás CSV de Reportes. */
export const ARGOS_ROW_LIMIT = 200
export const ARGOS_DOWNLOAD_LIMIT = 5_000
export const ARGOS_TIMEOUT_MS = 3_000

/**
 * Corre una consulta ya revisada con la llave del rol: transacción de solo
 * lectura, la clínica fijada, `SET LOCAL ROLE`, `search_path` en `argos`,
 * tope de tiempo y de filas. Recibe la conexión del rol app (`appDb`).
 */
export async function runArgosQuery(
  db: Db,
  input: { orgId: string; memberRole: string; query: string; rowLimit?: number; timeoutMs?: number },
): Promise<ArgosQueryResult> {
  const role = argosRoleOf(input.memberRole)
  if (!role) throw new ArgosQueryError("PERMISO", "Tu rol no puede preguntarle a Argos")
  const review = reviewArgosQuery(input.query)
  if (!review.ok) throw new ArgosQueryError("REVISOR", review.reason)
  const limit = Math.max(1, Math.min(input.rowLimit ?? ARGOS_ROW_LIMIT, ARGOS_DOWNLOAD_LIMIT))
  const timeout = Math.max(100, Math.min(input.timeoutMs ?? ARGOS_TIMEOUT_MS, 10_000))
  try {
    return await db.transaction(async (tx) => {
      // Primero: después de cualquier lectura ya no se puede pasar a solo lectura.
      await tx.execute(sql.raw("set transaction read only"))
      await tx.execute(sql`select set_config('app.org_id', ${input.orgId}, true)`)
      // «Hoy» y «ahora» de la consulta son los de la clínica, no los del servidor.
      const [zone] = await tx.execute<{ timezone: string | null }>(sql`select timezone from org_profile where organization_id = ${input.orgId}`)
      const timezone = zone?.timezone && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone.timezone) ? zone.timezone : "UTC"
      await tx.execute(sql.raw(`set local timezone = '${timezone}'`))
      await tx.execute(sql.raw(`set local role ${role}`))
      await tx.execute(sql.raw(`set local statement_timeout = ${timeout}`))
      await tx.execute(sql.raw("set local search_path = argos"))
      const result = await tx.execute<Record<string, unknown>>(sql.raw(`select * from (${review.sql}) as argos_respuesta limit ${limit + 1}`))
      const described = (result as unknown as { columns?: Array<{ name: string; type: number }> }).columns ?? []
      const columns = described.map((column) => ({ name: column.name, kind: KIND_OF_TYPE[column.type] ?? ("text" as const) }))
      const rows = [...result].slice(0, limit).map((row) => Object.fromEntries(columns.map((column) => [column.name, plainValue(row[column.name], column.kind)])))
      return { columns, rows, truncated: result.length > limit }
    })
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause ?? (error as { code?: string; message?: string })
    if (cause?.code === "42501") throw new ArgosQueryError("PERMISO", "Eso no lo puede ver tu rol")
    if (cause?.code === "57014") throw new ArgosQueryError("TIEMPO", "La consulta tardó demasiado")
    throw new ArgosQueryError("CONSULTA", problemOf(cause?.code, cause?.message))
  }
}

/**
 * El problema que se le devuelve al modelo para que corrija su consulta. Un
 * error de datos (clase 22) puede citar un valor de la base —«invalid input
 * syntax for type integer: "Rosa Quispe"»— y ese texto viajaría al proveedor:
 * se dice qué pasó sin el valor. Los de la clase 42 (columna que no existe,
 * función, sintaxis, agrupación) y 21 (una subconsulta con varias filas)
 * nombran solo lo que escribió el modelo, y se pasan tal cual. Lo demás, sin
 * detalle.
 */
function problemOf(code: string | undefined, message: string | undefined): string {
  const data: Record<string, string> = {
    "22P02": "un valor no se pudo convertir a ese tipo (por ejemplo, un texto a número): revisa los ::tipo y las comparaciones entre tipos",
    "22003": "un número quedó fuera del rango de su tipo",
    "22007": "una fecha u hora con un formato que no se reconoce",
    "22008": "una fecha u hora fuera de rango",
    "22012": "una división por cero: usa nullif(…, 0) en el divisor",
    "22001": "un texto más largo que su tipo",
  }
  if (code && data[code]) return data[code]
  if (code?.startsWith("22")) return "un valor no sirve para esa operación: revisa los tipos y las conversiones"
  if ((code?.startsWith("42") || code?.startsWith("21")) && message) return message.slice(0, 300)
  return "la consulta no se pudo correr"
}
