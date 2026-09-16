/**
 * Normalización canónica de etiquetas (contactos y documentos).
 * Un solo helper frontend/backend: la UI y los servicios consumen este módulo.
 *
 * Reglas (contrato):
 * - NFKD + quitar marcas combinantes (tildes/diacríticos), trim, lowercase.
 * - Grupos de espacios/guiones/underscore -> un solo '-'; recortar '-' extremos.
 * - Solo letras/números y guion interno; vacío o puntuación arbitraria se rechaza.
 * - Deduplicación sobre el valor canónico (primer orden conservado).
 * - Límites sobre el resultado: máximo 20 únicos, 40 caracteres por etiqueta
 *   canónica. 'TAG'/'tag'/' tag ' -> 'tag'; 'tag 1'/'tag-1'/'tag_1' -> 'tag-1'.
 *
 * Lanza Error en español; los servicios lo convierten a ServiceError validation
 * y la API a 400 VALIDATION.
 */

export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 40

/** Solo letras/números Unicode con guiones estrictamente internos. */
const CANONICAL_RE = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u

function canonicalize(raw: string): string {
  const withoutMarks = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  const lowered = withoutMarks.trim().toLowerCase()
  const dashed = lowered.replace(/[\s\-_]+/g, "-")
  return dashed.replace(/^-+|-+$/g, "")
}

/**
 * Normaliza una lista de etiquetas a su forma canónica.
 * @param input etiquetas crudas (tal como las escribe el usuario o llegan al API).
 * @returns etiquetas canónicas, únicas, en orden de primera aparición.
 * @throws Error en español si alguna etiqueta es vacía/inválida o se superan límites.
 */
export function normalizeTags(input: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== "string") {
      throw new Error(`Etiqueta inválida: debe ser texto`)
    }
    const canonical = canonicalize(raw)
    if (!canonical) {
      throw new Error(
        raw.trim()
          ? `Etiqueta inválida: "${raw.trim()}" (usa solo letras, números y guiones)`
          : `Etiqueta inválida: no puede estar vacía`,
      )
    }
    if (canonical.length > MAX_TAG_LENGTH) {
      throw new Error(`La etiqueta "${canonical}" supera ${MAX_TAG_LENGTH} caracteres`)
    }
    if (!CANONICAL_RE.test(canonical)) {
      throw new Error(`Etiqueta inválida: "${raw.trim()}" (usa solo letras, números y guiones)`)
    }
    if (!seen.has(canonical)) {
      seen.add(canonical)
      out.push(canonical)
    }
  }
  if (out.length > MAX_TAGS) {
    throw new Error(`Máximo ${MAX_TAGS} etiquetas`)
  }
  return out
}
