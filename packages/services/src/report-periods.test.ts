import { expect, it } from "vitest"
import { monthsOf, resolveReportWindow } from "./report-periods.js"

const LIMA = "America/Lima"
/** Lunes 12 de octubre de 2026, 10:00 en Lima (UTC−5). */
const NOW = new Date("2026-10-12T15:00:00Z")
const iso = (date: Date): string => date.toISOString()

it("el mes en curso termina ahora y se compara con el mismo tiempo del mes anterior", () => {
  const window = resolveReportWindow(LIMA, "este_mes", NOW)
  expect(window).toMatchObject({ from: { year: 2026, month: 10 }, to: { year: 2026, month: 10 }, partial: true })
  expect(iso(window.start)).toBe("2026-10-01T05:00:00.000Z")
  expect(iso(window.end)).toBe(iso(NOW))
  expect(window.previous).toMatchObject({ from: { year: 2026, month: 9 }, to: { year: 2026, month: 9 }, partial: true })
  expect(iso(window.previous.start)).toBe("2026-09-01T05:00:00.000Z")
  expect(iso(window.previous.end)).toBe("2026-09-12T15:00:00.000Z")
})

it("el mes pasado es un mes completo y se compara con el mes de antes", () => {
  const window = resolveReportWindow(LIMA, "mes_pasado", NOW)
  expect(window.partial).toBe(false)
  expect([iso(window.start), iso(window.end)]).toEqual(["2026-09-01T05:00:00.000Z", "2026-10-01T05:00:00.000Z"])
  expect([iso(window.previous.start), iso(window.previous.end)]).toEqual(["2026-08-01T05:00:00.000Z", "2026-09-01T05:00:00.000Z"])
  // Pedir el mes por su nombre da el mismo tramo.
  const named = resolveReportWindow(LIMA, "2026-09", NOW)
  expect([iso(named.start), iso(named.end)]).toEqual([iso(window.start), iso(window.end)])
})

it("los últimos tres meses son completos y se comparan con los tres anteriores", () => {
  const window = resolveReportWindow(LIMA, "ultimos_3_meses", NOW)
  expect(monthsOf(window)).toEqual([
    { year: 2026, month: 7 },
    { year: 2026, month: 8 },
    { year: 2026, month: 9 },
  ])
  expect(monthsOf(window.previous)).toEqual([
    { year: 2026, month: 4 },
    { year: 2026, month: 5 },
    { year: 2026, month: 6 },
  ])
})

it("el año en curso se compara con el mismo tramo del año anterior", () => {
  const window = resolveReportWindow(LIMA, "este_ano", NOW)
  expect(window).toMatchObject({ from: { year: 2026, month: 1 }, to: { year: 2026, month: 10 }, partial: true })
  expect(iso(window.previous.start)).toBe("2025-01-01T05:00:00.000Z")
  expect(window.previous.to).toEqual({ year: 2025, month: 10 })
  expect(window.previous.end.getTime() - window.previous.start.getTime()).toBe(window.end.getTime() - window.start.getTime())
})

it("el tramo anterior nunca se pasa de su propio mes", () => {
  // 31 de marzo: febrero tiene 28 días; el tramo anterior termina con febrero.
  const window = resolveReportWindow(LIMA, "este_mes", new Date("2026-03-31T20:00:00Z"))
  expect(iso(window.previous.end)).toBe("2026-03-01T05:00:00.000Z")
})

it("el mes lo decide la zona horaria de la clínica, no UTC", () => {
  // 31 de agosto a las 22:30 UTC ya es 1 de septiembre en Madrid.
  const madrid = resolveReportWindow("Europe/Madrid", "2026-09", NOW)
  expect(iso(madrid.start)).toBe("2026-08-31T22:00:00.000Z")
  // 1 de octubre a las 03:00 UTC todavía es 30 de septiembre en Lima.
  const lima = resolveReportWindow(LIMA, "este_mes", new Date("2026-10-01T03:00:00Z"))
  expect(lima.from).toEqual({ year: 2026, month: 9 })
})

it("rechaza un mes que no empieza y una opción desconocida", () => {
  expect(() => resolveReportWindow(LIMA, "2026-11", NOW)).toThrow("Ese mes todavía no empieza")
  expect(() => resolveReportWindow(LIMA, "ayer", NOW)).toThrow("Periodo no reconocido")
  expect(() => resolveReportWindow(LIMA, "2026-13", NOW)).toThrow("Periodo no reconocido")
})
