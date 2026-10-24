import { describe, expect, it } from "vitest"
import {
  isOpportune,
  lastOpportuneAtOrBefore,
  nextOpportuneFrom,
  type OpportuneSchedule,
  opportuneRangesOn,
} from "./opportune-hours.js"

/**
 * Horas de un horario semanal (el «Horario de recontacto», ADR 0042 y 0084): un
 * día sin tramos no tiene momento permitido. Lima es UTC−5 todo el año; el 12
 * de octubre de 2026 es lunes.
 */
const LIMA = "America/Lima"
const at = (iso: string) => new Date(iso)

/** De lunes a sábado de 9:00 a 13:00 y de 15:00 a 19:00; domingo sin horario. */
const clinic: OpportuneSchedule = {
  timeZone: LIMA,
  week: [[], ...Array.from({ length: 6 }, () => [[540, 780], [900, 1140]] as Array<[number, number]>)],
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
})
