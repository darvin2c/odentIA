/**
 * Buscar por letras sin tildes ni mayúsculas (buscador rápido, fase 0): «lucia»
 * encuentra «Lucía» en todas las pantallas. La base pliega el texto con
 * `search_fold` (unaccent + minúsculas, migración 0035) y los índices de
 * trigramas aceptan cualquier pedazo de la palabra («profilax», «quis»).
 *
 * Cada palabra escrita tiene que aparecer, en cualquier orden: «quispe maria»
 * encuentra a «María Quispe». El texto llega como parámetro: `%`, `_` y `\`
 * se escapan para que valgan como letras.
 */
import { and, or, type SQL, type SQLWrapper, sql } from "drizzle-orm"

/** Palabras de una búsqueda, sin vacíos. */
export function searchWords(q: string): string[] {
  return q.trim().split(/\s+/).filter(Boolean)
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** `column` contiene `text` sin distinguir tildes ni mayúsculas. */
export function foldedContains(column: SQLWrapper, text: string): SQL {
  return sql`search_fold(${column}) like '%' || search_fold(${escapeLike(text)}) || '%' escape '\\'`
}

/** `column` empieza con `text` sin distinguir tildes ni mayúsculas (para ordenar). */
export function foldedStartsWith(column: SQLWrapper, text: string): SQL {
  return sql`search_fold(${column}) like search_fold(${escapeLike(text.trim())}) || '%' escape '\\'`
}

/**
 * Cada palabra de `q` aparece en alguna de `columns`. Con una sola columna la
 * condición usa su índice de trigramas, si lo tiene. `minWord` deja fuera las
 * palabras cortas («de», «la»): en textos largos, como mensajes o notas, no
 * distinguen nada y el índice no puede usarlas. Sin palabras que sirvan, nada coincide.
 */
export function foldedWordsMatch(
  columns: SQLWrapper[],
  q: string,
  options: { minWord?: number } = {},
): SQL {
  const all = searchWords(q)
  const words = options.minWord ? all.filter((word) => word.length >= (options.minWord ?? 0)) : all
  if (!columns.length) return sql`true`
  if (!words.length) return options.minWord && all.length ? sql`false` : sql`true`
  return and(...words.map((word) => or(...columns.map((column) => foldedContains(column, word)))!))!
}

/**
 * El número de algo escrito con su prefijo o sin él: «HC-000123», «OC-12»,
 * «P-0045», «N.º 123», «#123» o «123». Nulo si no es un número así.
 */
export function referenceNumber(q: string, prefixes: readonly string[] = []): number | null {
  const text = q.trim().toLowerCase().replace(/\s+/g, "")
  const match = /^([a-z.º°#]*)-?0*(\d{1,9})$/.exec(text)
  if (!match) return null
  const prefix = (match[1] ?? "").replace(/[.º°#]/g, "")
  if (prefix && !prefixes.includes(prefix) && prefix !== "n") return null
  return Number(match[2])
}

/**
 * Dígitos de una búsqueda que parece un número (teléfono, documento, número
 * de comprobante): «987 654», «B001-000123». Vacío si hay menos de 4 o si la
 * mayoría son letras.
 */
export function searchDigits(q: string): string {
  const text = q.trim()
  const digits = text.replace(/\D/g, "")
  const compact = text.replace(/\s/g, "")
  if (digits.length < 4 || digits.length < compact.length * 0.6) return ""
  return digits
}

/** Los dígitos de `column` contienen `digits` («+51 987…» contiene «987654»). */
export function digitsContain(column: SQLWrapper, digits: string): SQL {
  return sql`search_digits(${column}) like ${`%${digits}%`}`
}
