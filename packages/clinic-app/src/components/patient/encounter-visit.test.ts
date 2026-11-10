import { describe, expect, it } from "vitest"
import { visitWaitWords } from "./encounter-visit"

describe("«Hoy viene a…» con la espera entre sesiones (QA del 10 nov, B6)", () => {
  it("la sesión 1 de hoy avisa con los días que pide su servicio, sin trabar", () => {
    expect(visitWaitWords({ wait: { days: 7, sinceDays: 0, from: "2026-11-16" } })).toBe(
      "La sesión anterior fue hoy: la medicación suele dejarse una semana.",
    )
    expect(visitWaitWords({ wait: { days: 10, sinceDays: 1, from: "2026-11-18" } })).toBe(
      "La sesión anterior fue ayer: la medicación suele dejarse 10 días.",
    )
    expect(visitWaitWords({ wait: { days: 14, sinceDays: 3, from: "2026-11-20" } })).toBe(
      "La sesión anterior fue hace 3 días: la medicación suele dejarse 2 semanas.",
    )
  })

  it("sin espera pendiente no dice nada", () => {
    expect(visitWaitWords({ wait: null })).toBeNull()
    expect(visitWaitWords({})).toBeNull()
  })
})
