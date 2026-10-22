import { describe, expect, it } from "vitest"
import { type LessonPreview, lessonScopeChip, lessonScopeFor, lessonUsage, previewCounts, previewSummary } from "./agent"

const DAY = 86_400_000
const NOW = Date.parse("2026-10-11T12:00:00Z")
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

describe("cuánto se usa una lección", () => {
  it("cuenta los usos con el género de cada clase", () => {
    expect(lessonUsage({ kind: "respuesta_oficial", uses: 9, lastUsedAt: ago(1), approvedAt: ago(60) }, NOW)).toEqual({ text: "Usada 9 veces", stale: false })
    expect(lessonUsage({ kind: "regla", uses: 1, lastUsedAt: ago(2), approvedAt: ago(60) }, NOW).text).toBe("Aplicada 1 vez")
    expect(lessonUsage({ kind: "ejemplo", uses: 6, lastUsedAt: ago(29), approvedAt: ago(60) }, NOW).text).toBe("Usado 6 veces")
  })

  it("«Sin usar en 30 días» solo cuando las fechas lo respaldan", () => {
    // Recién aprobada y sin usos: todavía no han pasado 30 días.
    expect(lessonUsage({ kind: "regla", uses: 0, lastUsedAt: null, approvedAt: ago(3) }, NOW)).toEqual({ text: "Sin usar todavía", stale: false })
    // Nunca se usó y se aprobó hace 30 días o más.
    expect(lessonUsage({ kind: "regla", uses: 0, lastUsedAt: null, approvedAt: ago(30) }, NOW)).toEqual({ text: "Sin usar en 30 días", stale: true })
    // Se usó, pero la última vez fue hace más de 30 días.
    expect(lessonUsage({ kind: "regla", uses: 12, lastUsedAt: ago(45), approvedAt: ago(90) }, NOW).stale).toBe(true)
    // Sin ninguna fecha no se afirma.
    expect(lessonUsage({ kind: "regla", uses: 0, lastUsedAt: null, approvedAt: null }, NOW).stale).toBe(false)
  })
})

describe("el resultado de probar una lección", () => {
  const item = (same: boolean) => ({ question: same ? "igual" : "cambia", expected: null, before: "a", after: same ? "a" : "b", same })

  it("los casos que no tocan el tema cuentan como iguales", () => {
    const preview: LessonPreview = { cases: [item(false), item(true), item(false)], total: 24, touched: 2, model: "m" }
    const counts = previewCounts(preview)
    // Tres respondidas (la pregunta de origen y dos casos) más los 22 que no tocan el tema.
    expect(counts).toEqual({ total: 25, same: 23, changed: 2, answered: 3 })
    expect(previewSummary(counts)).toBe("23 responden igual y 2 cambian.")
  })

  it("dice el caso de una sola pregunta y el de ninguna diferencia", () => {
    expect(previewSummary(previewCounts({ cases: [item(true)], total: 0, touched: 0, model: "m" }))).toBe("Responde igual.")
    expect(previewSummary({ same: 4, changed: 0 })).toBe("Las 4 responden igual.")
    expect(previewSummary({ same: 1, changed: 1 })).toBe("1 responde igual y 1 cambia.")
  })
})

describe("alcance de una lección", () => {
  it("la clínica entera o el agente, sin «Solo»", () => {
    expect(lessonScopeChip("clinica", "Sofi")).toBe("Toda la clínica")
    expect(lessonScopeChip("recepcion", "Sofi")).toBe("Sofi")
    expect(lessonScopeChip("recepcion", "Ana")).toBe("Ana")
    expect(lessonScopeChip("administrador", "Ana")).toBe("Argos")
    expect(lessonScopeFor("clinica", "Sofi")).toBe("Para toda la clínica")
    expect(lessonScopeFor("recepcion", "Sofi")).toBe("Solo para Sofi")
    expect(lessonScopeFor("asistente_clinico", "Sofi")).toBe("Solo para Clío")
  })
})
