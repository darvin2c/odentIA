/**
 * Argos consulta las vistas del negocio (ADR 0073). El modelo escribe una
 * consulta; aquí se revisa y se corre con la llave de solo lectura del rol de
 * quien pregunta. Lo que garantiza los permisos es la base (la llave solo lee
 * las vistas `argos` de su rol, `argos_dueno` está sujeto a la RLS de la
 * clínica y nadie fuera del rol app puede cambiar `app.org_id`); el revisor es
 * una defensa más y la forma de decirle al modelo qué corregir.
 */
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"

/** La llave de base de cada rol de la aplicación. `member` no pregunta. */
const ARGOS_ROLES: Record<string, string> = {
  owner: "argos_gestion",
  admin: "argos_gestion",
  reception: "argos_recepcion",
  dentist: "argos_clinico",
  cashier: "argos_caja",
}

export function argosRoleOf(memberRole: string): string | null {
  return ARGOS_ROLES[memberRole.trim().toLowerCase()] ?? null
}

/** Las vistas que una consulta puede nombrar (con o sin `argos.`). `agenda_base` es interna. */
export const ARGOS_VIEWS = [
  "ventas",
  "cobros",
  "pagos_por_venta",
  "tickets",
  "deudas",
  "gastos",
  "comisiones",
  "citas",
  "agenda_por_dia",
  "agenda_por_hora",
  "pacientes",
  "tratamientos_hechos",
  "planes",
  "controles",
  "presupuestos",
  "lineas_presupuesto",
  "promociones",
  "promociones_uso",
  "lotes",
  "inventario",
  "movimientos_inventario",
  "compras",
  "conversaciones",
  "oportunidades",
  "tareas",
] as const

/** Funciones y palabras que pueden ir antes de un paréntesis. */
const ALLOWED_CALLS = new Set([
  // Agregados y ventanas.
  "count", "sum", "avg", "min", "max", "percentile_cont", "percentile_disc", "mode", "stddev", "variance", "string_agg", "array_agg",
  "bool_and", "bool_or", "every", "row_number", "rank", "dense_rank", "ntile", "lag", "lead", "first_value", "last_value",
  // Números, textos y fechas.
  "round", "trunc", "abs", "ceil", "ceiling", "floor", "coalesce", "nullif", "greatest", "least", "upper", "lower", "initcap", "trim",
  "length", "concat", "concat_ws", "substring", "left", "right", "replace", "position", "split_part", "date_trunc", "date_part",
  "extract", "to_char", "to_date", "make_date", "make_interval", "age", "now", "generate_series", "unnest", "array_length", "cardinality",
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
    .split(new RegExp(`(${LITERAL.source})`))
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
    const name = (match[1] ?? "").toLowerCase()
    const view = name.startsWith("argos.") ? name.slice(6) : name
    const isCall = new RegExp(`^\\s*\\(`).test(bare.slice((match.index ?? 0) + match[0].length))
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

export class ArgosQueryError extends Error {
  constructor(
    readonly code: "REVISOR" | "PERMISO" | "TIEMPO" | "CONSULTA",
    message: string,
  ) {
    super(message)
  }
}

export interface ArgosQueryResult {
  rows: Array<Record<string, unknown>>
  /** Había más filas que el tope: la respuesta lo dice. */
  truncated: boolean
}

/** Tope de filas y de tiempo de una consulta de Argos. */
export const ARGOS_ROW_LIMIT = 200
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
  const limit = Math.max(1, Math.min(input.rowLimit ?? ARGOS_ROW_LIMIT, ARGOS_ROW_LIMIT))
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
      const rows = [...(await tx.execute<Record<string, unknown>>(sql.raw(`select * from (${review.sql}) as argos_respuesta limit ${limit + 1}`)))]
      return { rows: rows.slice(0, limit), truncated: rows.length > limit }
    })
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause ?? (error as { code?: string; message?: string })
    if (cause?.code === "42501") throw new ArgosQueryError("PERMISO", "Eso no lo puede ver tu rol")
    if (cause?.code === "57014") throw new ArgosQueryError("TIEMPO", "La consulta tardó demasiado")
    throw new ArgosQueryError("CONSULTA", cause?.message ?? (error instanceof Error ? error.message : String(error)))
  }
}
