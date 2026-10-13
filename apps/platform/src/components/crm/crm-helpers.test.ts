import { describe, expect, it } from "vitest"
import {
  dateInputToIso,
  formatDueAt,
  isoToLocalInput,
  isOverdue,
  localInputToIso,
} from "./crm-helpers"

describe("localInputToIso / isoToLocalInput", () => {
  it("conserva el instante en ida y vuelta con la zona local", () => {
    const iso = localInputToIso("2026-09-30T14:30")
    expect(iso).not.toBeNull()
    // El ISO representa las 14:30 locales, no 14:30 UTC a secas.
    const back = isoToLocalInput(iso)
    expect(back).toBe("2026-09-30T14:30")
  })

  it("rechaza vacío e inválidos sin lanzar", () => {
    expect(localInputToIso("")).toBeNull()
    expect(localInputToIso("   ")).toBeNull()
    expect(localInputToIso("no-fecha")).toBeNull()
    expect(isoToLocalInput(null)).toBe("")
    expect(isoToLocalInput("basura")).toBe("")
  })
})

describe("dateInputToIso", () => {
  it("convierte fecha calendario a ISO de medianoche local", () => {
    const iso = dateInputToIso("2026-09-30")
    expect(iso).not.toBeNull()
    const back = new Date(iso as string)
    expect(back.getFullYear()).toBe(2026)
    expect(back.getMonth()).toBe(8)
    expect(back.getDate()).toBe(30)
    expect(back.getHours()).toBe(0)
  })

  it("rechaza vacío y formas no calendario", () => {
    expect(dateInputToIso("")).toBeNull()
    expect(dateInputToIso("30/09/2026")).toBeNull()
    expect(dateInputToIso("2026-09-30T10:00")).toBeNull()
  })
})

describe("isOverdue", () => {
  it("distingue pasado, futuro y ausente", () => {
    const now = new Date("2026-09-30T12:00:00Z").getTime()
    expect(isOverdue("2026-09-30T11:59:00Z", now)).toBe(true)
    expect(isOverdue("2026-09-30T12:01:00Z", now)).toBe(false)
    expect(isOverdue(null, now)).toBe(false)
    expect(isOverdue("basura", now)).toBe(false)
  })
})

describe("formatDueAt", () => {
  it("nunca devuelve blanco: sin fecha en null o inválidos", () => {
    expect(formatDueAt(null)).toBe("Sin fecha")
    expect(formatDueAt(undefined)).toBe("Sin fecha")
    expect(formatDueAt("basura")).toBe("Sin fecha")
  })

  it("formatea pasada y futura con fecha y hora es-PE", () => {
    for (const iso of ["2020-05-06T10:15:00Z", "2030-05-06T10:15:00Z"]) {
      const label = formatDueAt(iso)
      expect(label).not.toBe("")
      expect(label).not.toBe("Sin fecha")
      expect(label).toMatch(/\d{2}\/\d{2}\/\d{4}/)
    }
  })
})
