/**
 * Lo que Recepción lee de su conversación en cada turno (ADR 0104): la
 * atención en curso entera, no una ventana fija de mensajes. En WhatsApp la
 * gente escribe en pedazos: veinte mensajes eran tres o cuatro vueltas, y con
 * más Sofi volvía a pedir el nombre, la hora o el motivo porque ya no los veía.
 */

/** Lo que lee siempre, aunque la atención recién empiece: el aviso de cita que la persona responde. */
export const HISTORY_MIN_TAIL = 20
/** Mensajes que se leen de la base por turno, los más recientes. */
export const HISTORY_MAX_MESSAGES = 300
/**
 * Tope por tamaño de lo que el modelo lee del hilo: unas 6 000 palabras, mucho
 * más que una atención por WhatsApp. Pasado el tope se conservan el comienzo
 * y lo último, y el contexto dice cuántos mensajes quedaron fuera.
 */
export const HISTORY_CHARS = 24_000
/** Con la atención recortada, los primeros mensajes que se conservan: por qué escribió. */
export const HISTORY_HEAD = 4

/** Lo que pesa un mensaje en el historial: su texto y el sello de cuándo se dijo. */
const weight = (item: { body: string | null }): number => (item.body?.length ?? 0) + 40

/**
 * Acota el historial al tope sin cortarlo a ciegas: si no cabe entero, quedan
 * los primeros `head` (cómo empezó la atención) y los últimos que caben, y se
 * cuenta cuántos del medio no van. El último mensaje va siempre: es el que se
 * responde.
 */
export function fitHistory<T extends { body: string | null }>(
  items: T[],
  budget = HISTORY_CHARS,
  head = HISTORY_HEAD,
): { items: T[]; omitted: number } {
  const total = items.reduce((sum, item) => sum + weight(item), 0)
  if (total <= budget || items.length <= head + 1) return { items, omitted: 0 }
  const first = items.slice(0, head)
  let room = budget - first.reduce((sum, item) => sum + weight(item), 0)
  const last: T[] = []
  for (let index = items.length - 1; index >= head; index -= 1) {
    const item = items[index]
    if (!item || (last.length > 0 && weight(item) > room)) break
    last.unshift(item)
    room -= weight(item)
  }
  return { items: [...first, ...last], omitted: items.length - first.length - last.length }
}
