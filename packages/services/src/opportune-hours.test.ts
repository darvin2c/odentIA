import { describe, expect, it } from "vitest"
import {
  insideAgentHours,
  isOpportune,
  lastOpportuneAtOrBefore,
  nextAgentOpening,
  nextOpportuneFrom,
  type OpportuneSchedule,
  opportuneRangesOn,
} from "./opportune-hours.js"

/**
 * Horas de un horario semanal (el «Horario para escribir», ADR 0042, y el del
 * agente): un día sin tramos no tiene momento permitido. Lima es UTC−5 todo el
 * año; el 12 de octubre de 2026 es lunes.
 */
const LIMA = "America/Lima"
const at = (iso: string) => new Date(iso)

/** De lunes a sábado de 9:00 a 13:00 y de 15:00 a 19:00; domingo sin horario. */
const clinic: OpportuneSchedule = {
  timeZone: LIMA,
  week: [[], ...Array.from({ length: 6 }, () => [[540, 780], [900, 1140]] as Array<[number, number]>)],
  agent: null,
}

describe("horario oportuno", () => {
  it("medianoche no es oportuna: lo siguiente es la apertura de esa mañana", () => {
    const midnight = at("2026-10-13T05:00:00Z") // martes 00:00 en Lima
    expect(isOpportune(midnight, clinic)).toBe(false)
    expect(nextOpportuneFrom(midnight, clinic)?.toISOString()).toBe("2026-10-13T14:00:00.000Z") // 9:00
    // Y lo último oportuno antes fue el lunes a las 18:59.
    expect(lastOpportuneAtOrBefore(midnight, clinic)?.toISOString()).toBe("2026-10-12T23:59:00.000Z")
  })

  it("dentro del horario es el mismo instante; en el almuerzo, el final de la mañana o la vuelta de la tarde", () => {
    const morning = at("2026-10-12T15:30:00Z") // lunes 10:30
    expect(isOpportune(morning, clinic)).toBe(true)
    expect(nextOpportuneFrom(morning, clinic)).toEqual(morning)
    expect(lastOpportuneAtOrBefore(morning, clinic)).toEqual(morning)
    const lunch = at("2026-10-12T19:00:00Z") // lunes 14:00
    expect(isOpportune(lunch, clinic)).toBe(false)
    expect(nextOpportuneFrom(lunch, clinic)?.toISOString()).toBe("2026-10-12T20:00:00.000Z") // 15:00
    expect(lastOpportuneAtOrBefore(lunch, clinic)?.toISOString()).toBe("2026-10-12T17:59:00.000Z") // 12:59
  })

  it("un domingo sin tramos no tiene momento: lo siguiente es el lunes y lo anterior, el sábado", () => {
    expect(opportuneRangesOn(clinic, 0)).toEqual([])
    const sundayEarly = at("2026-10-11T11:30:00Z") // domingo 6:30
    expect(isOpportune(at("2026-10-11T17:00:00Z"), clinic)).toBe(false) // domingo 12:00
    expect(nextOpportuneFrom(sundayEarly, clinic)?.toISOString()).toBe("2026-10-12T14:00:00.000Z") // lunes 9:00
    expect(lastOpportuneAtOrBefore(sundayEarly, clinic)?.toISOString()).toBe("2026-10-10T23:59:00.000Z") // sábado 18:59
  })

  it("el horario del agente recorta el de la clínica, también si cruza la medianoche", () => {
    const withAgent = { ...clinic, agent: { fromMin: 600, untilMin: 1080 } }
    expect(opportuneRangesOn(withAgent, 1)).toEqual([[600, 780], [900, 1080]])
    expect(isOpportune(at("2026-10-12T14:30:00Z"), withAgent)).toBe(false) // lunes 9:30: la clínica sí, el agente no
    expect(nextOpportuneFrom(at("2026-10-12T14:30:00Z"), withAgent)?.toISOString()).toBe("2026-10-12T15:00:00.000Z")
    const night = { ...clinic, agent: { fromMin: 1080, untilMin: 120 } }
    // Lunes de 15:00 a 19:00 y el agente de 18:00 a 2:00: solo de 18:00 a 19:00; el domingo, nada.
    expect(opportuneRangesOn(night, 1)).toEqual([[1080, 1140]])
    expect(opportuneRangesOn(night, 0)).toEqual([])
  })

  it("el agente abre a su hora: fuera de su franja la corrida espera a la apertura", () => {
    const agent = { fromMin: 480, untilMin: 1200 }
    const late = at("2026-10-13T03:00:00Z") // lunes 22:00
    expect(insideAgentHours(late, LIMA, agent)).toBe(false)
    expect(nextAgentOpening(late, LIMA, agent).toISOString()).toBe("2026-10-13T13:00:00.000Z") // martes 8:00
    const inside = at("2026-10-12T15:00:00Z")
    expect(insideAgentHours(inside, LIMA, agent)).toBe(true)
    expect(nextAgentOpening(inside, LIMA, agent)).toEqual(inside)
    expect(nextAgentOpening(late, LIMA, null)).toEqual(late)
  })
})
