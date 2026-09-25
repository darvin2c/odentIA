/**
 * Reparto de solapes en un carril: cuando dos citas pisan el mismo recurso a
 * la misma hora (doble reserva, emergencia) se pintan lado a lado en vez de
 * una encima de otra. Algoritmo de barrido por grupos: cada grupo es un
 * conjunto maximal de rangos que se tocan; dentro del grupo cada rango toma
 * el primer subcarril libre y el ancho es el total del grupo.
 */

export interface LanePlacement<T> {
  item: T
  startMinutes: number
  endMinutes: number
  /** Subcarril dentro del grupo (0-based). */
  lane: number
  /** Subcarriles totales del grupo: el ancho es 1/lanes. */
  lanes: number
}

export function layoutOverlaps<T>(
  items: T[],
  rangeOf: (item: T) => { startMinutes: number; endMinutes: number },
): LanePlacement<T>[] {
  const sorted = items
    .map((item) => ({ item, ...rangeOf(item) }))
    .sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes)

  const placements: LanePlacement<T>[] = []
  let cluster: typeof sorted = []
  let clusterEnd = Number.NEGATIVE_INFINITY

  const flush = () => {
    if (cluster.length === 0) return
    const freeAt: number[] = []
    const assigned = cluster.map((entry) => {
      let lane = freeAt.findIndex((end) => end <= entry.startMinutes)
      if (lane === -1) {
        lane = freeAt.length
        freeAt.push(entry.endMinutes)
      } else {
        freeAt[lane] = entry.endMinutes
      }
      return { ...entry, lane }
    })
    const lanes = freeAt.length
    for (const entry of assigned) {
      placements.push({
        item: entry.item,
        startMinutes: entry.startMinutes,
        endMinutes: entry.endMinutes,
        lane: entry.lane,
        lanes,
      })
    }
    cluster = []
    clusterEnd = Number.NEGATIVE_INFINITY
  }

  for (const entry of sorted) {
    if (entry.startMinutes < clusterEnd) {
      cluster.push(entry)
      clusterEnd = Math.max(clusterEnd, entry.endMinutes)
    } else {
      flush()
      cluster.push(entry)
      clusterEnd = entry.endMinutes
    }
  }
  flush()
  return placements
}
