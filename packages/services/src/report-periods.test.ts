import { expect, it } from "vitest"
import { monthsOf, reportBuckets, resolveReportWindow, yearBefore } from "./report-periods.js"

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

it("un rango se compara con los mismos días justo antes", () => {
  const window = resolveReportWindow(LIMA, "2026-09-10..2026-09-25", NOW)
  expect(window).toMatchObject({ kind: "range", grain: "day", partial: false, days: { from: "2026-09-10", to: "2026-09-25" } })
  expect([iso(window.start), iso(window.end)]).toEqual(["2026-09-10T05:00:00.000Z", "2026-09-26T05:00:00.000Z"])
  // 16 días: del 25 de agosto al 9 de septiembre.
  expect(window.previous.days).toEqual({ from: "2026-08-25", to: "2026-09-09" })
  expect([iso(window.previous.start), iso(window.previous.end)]).toEqual(["2026-08-25T05:00:00.000Z", "2026-09-10T05:00:00.000Z"])
})

it("un rango que termina hoy corre hasta ahora y se compara con el mismo tiempo", () => {
  const window = resolveReportWindow(LIMA, "2026-10-06..2026-10-12", NOW)
  expect(window.partial).toBe(true)
  expect(iso(window.end)).toBe(iso(NOW))
  expect(window.previous.end.getTime() - window.previous.start.getTime()).toBe(window.end.getTime() - window.start.getTime())
})

it("un rango se agrupa por día, por semana o por mes según su largo", () => {
  expect(resolveReportWindow(LIMA, "2026-09-01..2026-09-30", NOW).grain).toBe("day")
  expect(resolveReportWindow(LIMA, "2026-05-01..2026-09-30", NOW).grain).toBe("week")
  expect(resolveReportWindow(LIMA, "2025-10-01..2026-09-30", NOW).grain).toBe("month")
  // Por semana, de lunes a domingo; la primera y la última se recortan al rango.
  const weeks = reportBuckets(LIMA, resolveReportWindow(LIMA, "2026-08-20..2026-10-07", NOW))
  expect(weeks.length).toBe(8)
  expect(weeks.slice(0, 2).map((week) => [week.firstDay, week.lastDay, week.partial])).toEqual([
    ["2026-08-20", "2026-08-23", true],
    ["2026-08-24", "2026-08-30", false],
  ])
  expect(weeks.slice(-1).map((week) => [week.firstDay, week.lastDay, week.partial])).toEqual([["2026-10-05", "2026-10-07", true]])
})

it("un mes o un año se grafican en los 12 meses que terminan ahí, con el año anterior al lado", () => {
  const buckets = reportBuckets(LIMA, resolveReportWindow(LIMA, "este_mes", NOW))
  expect(buckets.map((bucket) => bucket.key)).toEqual([
    "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10",
  ])
  const last = buckets[11]!
  expect([last.partial, iso(last.end)]).toEqual([true, iso(NOW)])
  // Un año antes: el mismo tramo del mes, hasta el mismo momento.
  const before = yearBefore(LIMA, last)
  expect([iso(before.start), iso(before.end)]).toEqual(["2025-10-01T05:00:00.000Z", "2025-10-12T15:00:00.000Z"])
})

it("rechaza un rango al revés, con días que no pasan o de más de dos años", () => {
  expect(() => resolveReportWindow(LIMA, "2026-09-25..2026-09-10", NOW)).toThrow("El rango empieza después de terminar")
  expect(() => resolveReportWindow(LIMA, "2026-10-01..2026-10-13", NOW)).toThrow("Ese día todavía no pasa")
  expect(() => resolveReportWindow(LIMA, "2024-01-01..2026-09-30", NOW)).toThrow("como mucho dos años")
  expect(() => resolveReportWindow(LIMA, "2026-02-30..2026-03-03", NOW)).toThrow("Periodo no reconocido")
})
