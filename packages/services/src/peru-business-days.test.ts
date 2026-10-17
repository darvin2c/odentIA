import { describe, expect, it } from "vitest"
import {
  addPeruBusinessDays,
  isPeruBusinessDay,
  limaDate,
  peruBusinessDaysBetween,
} from "./peru-business-days.js"

describe("días hábiles de Perú", () => {
  it("salta fines de semana, feriados fijos y la Semana Santa de cada año", () => {
    expect(isPeruBusinessDay("2026-10-16")).toBe(true) // viernes
    expect(isPeruBusinessDay("2026-10-17")).toBe(false) // sábado
    expect(isPeruBusinessDay("2026-10-08")).toBe(false) // Combate de Angamos
    expect(isPeruBusinessDay("2026-12-09")).toBe(false) // Batalla de Ayacucho (Ley 31788)
    expect(isPeruBusinessDay("2026-07-23")).toBe(false) // Fuerza Aérea (Ley 31822)
    // Pascua 2026: 5 de abril; 2027: 28 de marzo.
    expect(isPeruBusinessDay("2026-04-02")).toBe(false)
    expect(isPeruBusinessDay("2026-04-03")).toBe(false)
    expect(isPeruBusinessDay("2026-04-06")).toBe(true)
    expect(isPeruBusinessDay("2027-03-25")).toBe(false)
    expect(isPeruBusinessDay("2027-03-26")).toBe(false)
  })

  it("el plazo de 15 días cuenta desde el día hábil siguiente", () => {
    // Jueves 1 de octubre: cuenta desde el viernes 2 y salta el jueves 8.
    expect(addPeruBusinessDays("2026-10-01", 15)).toBe("2026-10-23")
    // Una hoja del viernes empieza a contar el lunes; el 1 de noviembre cae domingo.
    expect(addPeruBusinessDays("2026-10-16", 15)).toBe("2026-11-06")
    // Fin de año: salta el 8, 9 y 25 de diciembre y el 1 de enero.
    expect(addPeruBusinessDays("2026-12-04", 15)).toBe("2026-12-30")
    expect(addPeruBusinessDays("2026-12-18", 15)).toBe("2027-01-12")
  })

  it("cuenta los días que quedan después de hoy y hasta el último incluido", () => {
    expect(peruBusinessDaysBetween("2026-10-17", "2026-10-23")).toBe(5)
    expect(peruBusinessDaysBetween("2026-10-23", "2026-10-23")).toBe(0)
    expect(peruBusinessDaysBetween("2026-10-24", "2026-10-23")).toBe(0)
  })

  it("el día de una hoja es el de Lima, no el del servidor", () => {
    // 2 de enero 03:30 UTC son las 22:30 del 1 de enero en Lima.
    expect(limaDate(new Date("2027-01-02T03:30:00Z"))).toBe("2027-01-01")
  })
})
