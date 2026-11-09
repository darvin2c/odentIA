import type { SiteFinding } from "./patients"

/** Un hallazgo como lo dice el clínico: una caries de dos caras es uno, con sus caras. */
export interface FindingGroup<T extends SiteFinding = SiteFinding> {
  /** Las filas que lo forman, una por cara; la primera es la que se vincula (como el panel de la pieza). */
  ids: string[]
  first: T
  /** Las caras, en el orden en que se guardaron; vacío si es de la pieza entera. */
  surfaces: string[]
}

/**
 * Junta las caras de un mismo registro (QA de la atención del 8 nov: «una caries
 * DO quedó como 2 hallazgos»). Se guarda una fila por cara y las de un registro
 * comparten pieza, condición, estado, diagnóstico y el instante en que se
 * guardaron (la misma transacción): eso las une. Hallazgos distintos de la
 * misma pieza, registrados en otro momento, siguen aparte.
 */
export function groupFindings<T extends SiteFinding>(entries: readonly T[]): FindingGroup<T>[] {
  const groups = new Map<string, FindingGroup<T>>()
  for (const entry of entries) {
    const at = entry.createdAt ? new Date(entry.createdAt).getTime() : ""
    const key = [
      entry.toothNumber,
      entry.condition,
      entry.status,
      entry.diagnosisCode ?? "",
      at,
      entry.voidedAt ? "x" : "",
    ].join("|")
    const group = groups.get(key)
    if (group) {
      group.ids.push(entry.id)
      if (entry.surface && !group.surfaces.includes(entry.surface))
        group.surfaces.push(entry.surface)
    } else {
      groups.set(key, {
        ids: [entry.id],
        first: entry,
        surfaces: entry.surface ? [entry.surface] : [],
      })
    }
  }
  return [...groups.values()]
}
