import { describe, expect, it } from "vitest"
import { visitBookedWords, visitWaitWords } from "./encounter-visit"

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

// Mesa de formularios del 13 nov (UX-4): «…sáb 14 nov, 3:00 p. m..», con dos puntos al final.
describe("«Hoy vino sin cita. Ya tiene una reservada»", () => {
  /** Los espacios de la hora son especiales: se comparan como espacios. */
  const plain = (text: string) => text.replace(/\s/g, " ")
  const at = "2026-11-14T20:00:00.000Z"

  it("la hora ya termina en punto: la frase no lleva otro", () => {
    expect(plain(visitBookedWords({ startsAt: at, serviceName: null }, "es-PE", "America/Lima"))).toBe(
      "Hoy vino sin cita. Ya tiene una reservada: sáb 14 nov, 3:00 p. m.",
    )
  })

  it("con el servicio, o con un formato de 24 horas, cierra con su punto", () => {
    expect(plain(visitBookedWords({ startsAt: at, serviceName: "Limpieza dental" }, "es-PE", "America/Lima"))).toBe(
      "Hoy vino sin cita. Ya tiene una reservada: sáb 14 nov, 3:00 p. m. · Limpieza dental.",
    )
    expect(plain(visitBookedWords({ startsAt: at, serviceName: null }, "es-ES", "Europe/Madrid"))).toBe(
      "Hoy vino sin cita. Ya tiene una reservada: sáb 14 nov, 21:00.",
    )
  })
})
