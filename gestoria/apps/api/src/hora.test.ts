/**
 * La hora de la tienda (ADR 0221), sin base: el «hoy» que fallaba en producción (desde las 19:00
 * de Lima gestorIA ya contaba el día siguiente, con la hora de Londres) y los periodos de Reportes.
 */
import { describe, expect, it } from "vitest"
import { addDays, dayIn, isTimeZone, startOfDay, weekdayOf } from "./hora.js"
import { periodStart } from "./sofi/reportes.js"

const LIMA = "America/Lima"

describe("qué día es en la tienda", () => {
  it("a las 19:30 del martes en Lima sigue siendo martes (en Londres ya es miércoles)", () => {
    // Martes 25 de noviembre de 2026, 19:30 en Lima = miércoles 26, 00:30 en UTC.
    const at = new Date("2026-11-26T00:30:00Z")
    expect(at.toISOString().slice(0, 10)).toBe("2026-11-26")
    expect(dayIn(LIMA, at)).toBe("2026-11-25")
    expect(dayIn("Europe/London", at)).toBe("2026-11-26")
  })

  it("el día cambia a la medianoche de la tienda, no a la del servidor", () => {
    expect(dayIn(LIMA, new Date("2026-11-26T04:59:59Z"))).toBe("2026-11-25")
    expect(dayIn(LIMA, new Date("2026-11-26T05:00:00Z"))).toBe("2026-11-26")
    // Más adelante que UTC: en Auckland ya es el día siguiente.
    expect(dayIn("Pacific/Auckland", new Date("2026-11-25T12:00:00Z"))).toBe("2026-11-26")
  })

  it("el día empieza a las 00:00 de la tienda", () => {
    expect(startOfDay(LIMA, "2026-11-25").toISOString()).toBe("2026-11-25T05:00:00.000Z")
    expect(startOfDay("Asia/Kolkata", "2026-11-25").toISOString()).toBe("2026-11-24T18:30:00.000Z")
    expect(startOfDay("UTC", "2026-11-25").toISOString()).toBe("2026-11-25T00:00:00.000Z")
  })

  it("con cambio de hora, el día empieza cuando el reloj vuelve a andar", () => {
    // Santiago adelanta la hora a la medianoche: el 6 de septiembre de 2026 empieza a la 01:00.
    const start = startOfDay("America/Santiago", "2026-09-06")
    expect(dayIn("America/Santiago", start)).toBe("2026-09-06")
    expect(dayIn("America/Santiago", new Date(start.getTime() - 1000))).toBe("2026-09-05")
    // Ciudad de México ya no cambia la hora: siempre 06:00 UTC.
    expect(startOfDay("America/Mexico_City", "2026-07-01").toISOString()).toBe(
      "2026-07-01T06:00:00.000Z",
    )
  })

  it("los días se cuentan en el calendario", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
    expect(weekdayOf("2026-11-23")).toBe(0) // lunes
    expect(weekdayOf("2026-11-29")).toBe(6) // domingo
  })

  it("solo zonas que existen", () => {
    expect(isTimeZone(LIMA)).toBe(true)
    expect(isTimeZone("UTC")).toBe(true)
    expect(isTimeZone("America/Narnia")).toBe(false)
    expect(isTimeZone("../etc/passwd")).toBe(false)
    expect(isTimeZone("")).toBe(false)
  })
})

describe("los periodos de Reportes", () => {
  it("«Hoy» a las 19:30 del martes cuenta desde las 00:00 del martes en Lima", () => {
    const today = dayIn(LIMA, new Date("2026-11-26T00:30:00Z"))
    expect(periodStart("hoy", today, LIMA).toISOString()).toBe("2026-11-25T05:00:00.000Z")
  })

  it("la semana desde el lunes y el mes desde el día 1, a las 00:00 de la tienda", () => {
    expect(periodStart("semana", "2026-11-25", LIMA).toISOString()).toBe("2026-11-23T05:00:00.000Z")
    expect(periodStart("semana", "2026-11-23", LIMA).toISOString()).toBe("2026-11-23T05:00:00.000Z")
    expect(periodStart("mes", "2026-11-25", LIMA).toISOString()).toBe("2026-11-01T05:00:00.000Z")
  })
})
