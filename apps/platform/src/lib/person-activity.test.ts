import { describe, expect, it } from "vitest"
import { type ActivityEntry, mergeActivity } from "./person-activity"

const entry = (key: string, at: string, source: ActivityEntry["source"] = "comercial"): ActivityEntry => ({
  key,
  at,
  source,
  label: source,
  title: key,
  detail: null,
  who: null,
  status: null,
})

describe("actividad unificada de la persona", () => {
  it("ordena de lo más nuevo a lo más antiguo cuando todo está cargado", () => {
    const merged = mergeActivity([
      { entries: [entry("cita", "2026-10-05T15:00:00.000Z", "cita")], hasMore: false },
      {
        entries: [
          entry("mensaje", "2026-10-07T09:40:00.000Z"),
          entry("nota", "2026-10-01T10:00:00.000Z"),
        ],
        hasMore: false,
      },
    ])
    expect(merged.entries.map((item) => item.key)).toEqual(["mensaje", "cita", "nota"])
    expect(merged.completeSince).toBeNull()
  })

  it("corta donde una fuente aún tiene páginas: no aparenta un orden completo", () => {
    const merged = mergeActivity([
      {
        // Faltan mensajes anteriores al día 6.
        entries: [
          entry("m2", "2026-10-07T09:00:00.000Z"),
          entry("m1", "2026-10-06T09:00:00.000Z"),
        ],
        hasMore: true,
      },
      {
        entries: [
          entry("atencion", "2026-10-06T12:00:00.000Z", "clinica"),
          entry("antigua", "2026-09-01T12:00:00.000Z", "clinica"),
        ],
        hasMore: false,
      },
    ])
    expect(merged.entries.map((item) => item.key)).toEqual(["m2", "atencion", "m1"])
    expect(merged.completeSince).toBe("2026-10-06T09:00:00.000Z")
  })

  it("una fuente con más páginas pero vacía no corta la mezcla", () => {
    const merged = mergeActivity([
      { entries: [], hasMore: true },
      { entries: [entry("cita", "2026-10-05T15:00:00.000Z", "cita")], hasMore: false },
    ])
    expect(merged.entries).toHaveLength(1)
    expect(merged.completeSince).toBeNull()
  })
})
