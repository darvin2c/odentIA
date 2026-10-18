/**
 * Reglas de la lista de Documentos (lienzo del issue 149): una sola lista de
 * papeles, separada por mes. La pantalla las usa; aquí no hay datos ni red.
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
