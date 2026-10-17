import type { ScheduleStatus } from "./types.js"

interface Occupancy {
  id: string
  start: string
  end: string
  status: ScheduleStatus
  professionalId: string
  chairId: string
}
export interface ScheduleConflict {
  professional: boolean
  chair: boolean
}

/** Intervalos [inicio, fin): citas contiguas no chocan. Calcula antes de filtrar la vista. */
export function findScheduleConflicts(
  entries: readonly Occupancy[],
): Map<string, ScheduleConflict> {
  const conflicts = new Map<string, ScheduleConflict>()
  const occupied = entries
    .filter((entry) => entry.status !== "cancelada" && entry.status !== "no_asistio")
    .map((entry) => ({ entry, start: Date.parse(entry.start), end: Date.parse(entry.end) }))
    .sort((a, b) => a.start - b.start)
  for (const [field, kind] of [
    ["professionalId", "professional"],
    ["chairId", "chair"],
  ] as const) {
    const active = new Map<string, typeof occupied>()
    for (const item of occupied) {
      const key = item.entry[field]
      const overlapping = (active.get(key) ?? []).filter((previous) => previous.end > item.start)
      for (const previous of overlapping) {
        for (const id of [previous.entry.id, item.entry.id]) {
          let conflict = conflicts.get(id)
          if (!conflict) {
            conflict = { professional: false, chair: false }
            conflicts.set(id, conflict)
          }
          conflict[kind] = true
        }
      }
      overlapping.push(item)
      active.set(key, overlapping)
    }
  }
  return conflicts
}

export function conflictLabel(conflict: ScheduleConflict | undefined): string | undefined {
  if (!conflict) return undefined
  return conflict.professional && conflict.chair
    ? "Solapamiento de profesional y unidad dental"
    : conflict.professional
      ? "Solapamiento de profesional"
      : "Solapamiento de unidad dental"
}
