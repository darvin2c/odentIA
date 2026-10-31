import type { DocumentFilter } from "./patient-areas"

/**
 * Reglas de la lista de Documentos (lienzo del issue 149): una sola lista de
 * papeles, separada por mes, con un buscador y filtros que acortan esa misma
 * lista. La pantalla las usa; aquí no hay datos ni red.
 */

/** Separa la lista por mes conservando el orden recibido (lo más reciente arriba). */
export function groupByMonth<T>(
  items: readonly T[],
  dateOf: (item: T) => string,
  heading: (iso: string) => string,
): Array<{ heading: string; items: T[] }> {
  const groups: Array<{ heading: string; items: T[] }> = []
  for (const item of items) {
    const title = heading(dateOf(item))
    const last = groups[groups.length - 1]
    if (last && last.heading === title) last.items.push(item)
    else groups.push({ heading: title, items: [item] })
  }
  return groups
}

/** «Pieza 36», «Piezas 36, 46» o nada. */
export function teethWords(teeth: readonly number[]): string | null {
  if (teeth.length === 0) return null
  return `${teeth.length === 1 ? "Pieza" : "Piezas"} ${teeth.join(", ")}`
}

const IMAGE_CATEGORIES = new Set(["radiografia", "foto_clinica"])

/** La radiografía o la foto: lo que se ve en el visor de imágenes y se compara. */
export function isImageCategory(category: string): boolean {
  return IMAGE_CATEGORIES.has(category)
}

/**
 * El filtro de un archivo subido (decisión 11): «Imágenes» son radiografías y
 * fotos; un consentimiento escaneado va con los consentimientos; lo demás
 * (un informe suelto, una carta) en «Otros archivos».
 */
export function fileFilter(category: string): DocumentFilter {
  if (isImageCategory(category)) return "imagenes"
  if (category === "consentimiento") return "consentimientos"
  return "otros"
}

/**
 * Archivos que ya están dentro de otro papel y no salen sueltos: los PDF
 * (firmado y de la revocación) y la hoja en papel de un consentimiento, y el informe que es el
 * resultado de una orden. La radiografía que llegó como resultado sí sale,
 * porque se compara con las demás.
 */
export function filesShownElsewhere(
  consents: ReadonlyArray<{
    pdfDocumentId: string | null
    revokePdfDocumentId?: string | null
    paperDocumentId: string | null
  }>,
  orders: ReadonlyArray<{ resultDocumentId: string | null }>,
  files: ReadonlyArray<{ id: string; category: string }>,
): Set<string> {
  const hidden = new Set<string>()
  for (const consent of consents) {
    if (consent.pdfDocumentId) hidden.add(consent.pdfDocumentId)
    if (consent.revokePdfDocumentId) hidden.add(consent.revokePdfDocumentId)
    if (consent.paperDocumentId) hidden.add(consent.paperDocumentId)
  }
  const categoryOf = new Map(files.map((file) => [file.id, file.category]))
  for (const order of orders) {
    const id = order.resultDocumentId
    const category = id ? categoryOf.get(id) : undefined
    if (id && category && !isImageCategory(category)) hidden.add(id)
  }
  return hidden
}

/** Sin mayúsculas ni tildes: «panoramica» encuentra «Panorámica». */
export function searchable(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
}

/** Cada palabra buscada tiene que estar en el papel, en cualquier orden. */
export function matchesSearch(haystack: string, query: string): boolean {
  const words = searchable(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = searchable(haystack)
  return words.every((word) => text.includes(word))
}

/**
 * Los filtros a la vista (decisión 8): el de un tipo solo si la persona tiene
 * papeles de ese tipo y de algún otro (si todo es de un tipo, filtrar no
 * cambia nada); «Requieren acción» solo si hay algo pendiente y no lo es todo.
 * El filtro puesto se ve siempre, para poder quitarlo. Sin ninguno, no hay
 * fila de filtros (ni «Todo»).
 */
export function visibleDocumentFilters(
  order: readonly DocumentFilter[],
  present: ReadonlySet<DocumentFilter>,
  pending: number,
  total: number,
  active?: DocumentFilter,
): DocumentFilter[] {
  const types = order.filter((id) => id !== "requieren" && present.has(id))
  const shown = new Set<DocumentFilter>(types.length >= 2 ? types : [])
  if (pending > 0 && pending < total) shown.add("requieren")
  if (active) shown.add(active)
  return order.filter((id) => shown.has(id))
}

const NOUNS: Record<string, readonly [string, string]> = {
  todo: ["papel", "papeles"],
  requieren: ["papel que requiere acción", "papeles que requieren acción"],
  presupuestos: ["presupuesto", "presupuestos"],
  recetas: ["receta", "recetas"],
  descansos: ["descanso médico", "descansos médicos"],
  ordenes: ["orden", "órdenes"],
  consentimientos: ["consentimiento", "consentimientos"],
  formularios: ["formulario", "formularios"],
  imagenes: ["imagen", "imágenes"],
  otros: ["archivo", "archivos"],
}

/**
 * «29 papeles», «18 imágenes», «16 imágenes de la pieza 36». El lugar llega
 * dicho («pieza 36») y el papel del producto, con sus palabras (`nouns`).
 */
export function countWords(
  count: number,
  filter?: DocumentFilter,
  options: { place?: string; nouns?: readonly [string, string] } = {},
): string {
  const [one, many] = NOUNS[filter ?? "todo"] ?? options.nouns ?? NOUNS.todo!
  return `${count} ${count === 1 ? one : many}${options.place ? ` de la ${options.place}` : ""}`
}
