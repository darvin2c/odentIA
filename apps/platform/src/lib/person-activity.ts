/**
 * Actividad reciente de una persona: une fuentes que ya vienen ordenadas de
 * la más nueva a la más antigua (citas, historia clínica, actividad comercial
 * de cada interlocutor) sin inventar un orden que no se puede garantizar.
 */

export interface ActivityEntry {
  /** Único entre fuentes. */
  key: string
  at: string
  source: "cita" | "clinica" | "comercial"
  /** Tipo legible: «Cita», «Atención», «Mensaje»… */
  label: string
  title: string
  detail: string | null
  /** Quién habló o actuó, con su vínculo cuando es un interlocutor. */
  who: string | null
  status: string | null
}

export interface ActivitySource {
  entries: ActivityEntry[]
  /** La fuente tiene elementos más antiguos que aún no se cargaron. */
  hasMore: boolean
}

/**
 * Mezcla cronológica correcta con páginas parciales: de una fuente con más
 * páginas solo se conoce hasta su elemento más antiguo, así que la mezcla se
 * corta ahí. Por debajo de ese instante faltarían eventos de esa fuente y la
 * lista aparentaría un orden completo que no tiene.
 */
export function mergeActivity(sources: ActivitySource[]): {
  entries: ActivityEntry[]
  /** Instante hasta el que la mezcla es completa; null si se cargó todo. */
  completeSince: string | null
} {
  let cutoff: string | null = null
  for (const source of sources) {
    if (!source.hasMore || source.entries.length === 0) continue
    const oldest = source.entries.reduce(
      (min, entry) => (entry.at < min ? entry.at : min),
      source.entries[0].at,
    )
    if (cutoff === null || oldest > cutoff) cutoff = oldest
  }
  const entries = sources
    .flatMap((source) => source.entries)
    .filter((entry) => cutoff === null || entry.at >= cutoff)
    .sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : b.at.localeCompare(a.at)))
  return { entries, completeSince: cutoff }
}
