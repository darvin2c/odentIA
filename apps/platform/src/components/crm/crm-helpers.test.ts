import { describe, expect, it } from "vitest"
import { dueWords, formatDueAt, isOverdue } from "./crm-helpers"

const LIMA = "America/Lima"
const MADRID = "Europe/Madrid"

describe("isOverdue", () => {
  it("vence solo lo que ya pasó", () => {
    const now = Date.parse("2026-09-30T12:00:00Z")
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

  it("dice la fecha en la zona de la clínica, no en la del navegador", () => {
    // 03:30 UTC es el 30 en Lima y el 1 en Madrid: cada clínica ve su día.
    expect(formatDueAt("2026-10-01T03:30:00Z", LIMA)).toMatch(/30\/09\/2026/)
    expect(formatDueAt("2026-10-01T03:30:00Z", MADRID)).toMatch(/01\/10\/2026/)
  })
})

describe("dueWords", () => {
  const now = Date.parse("2026-10-15T15:00:00Z") // 10:00 en Lima
  it("habla de hoy, mañana y ayer en la zona de la clínica", () => {
    expect(dueWords("2026-10-15T20:00:00Z", now, LIMA)).toMatch(/^hoy, 15:00$/)
    expect(dueWords("2026-10-16T14:00:00Z", now, LIMA)).toMatch(/^mañana, 09:00$/)
    expect(dueWords("2026-10-14T14:00:00Z", now, LIMA)).toMatch(/^ayer, 09:00$/)
    // Medianoche de Lima es la fecha sola.
    expect(dueWords("2026-10-17T05:00:00Z", now, LIMA)).toBe("sáb 17")
    expect(dueWords(null, now, LIMA)).toBe("sin fecha")
  })
})
