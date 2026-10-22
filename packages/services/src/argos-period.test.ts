/**
 * El periodo de las respuestas de Argos (D8 a D16): las mismas fechas que
 * Reportes, los dos lados cortados a la misma hora, cómo se dice cada uno y la
 * consulta con las fechas y la sede puestas por odentIA.
 */
import { describe, expect, it } from "vitest"
import { fillArgosSentence, fillArgosWords } from "./argos-answer.js"
import { argosTodayLabel, bindArgosPeriod, resolveArgosPeriod } from "./argos-period.js"
import { resolveReportWindow } from "./report-periods.js"

// Miércoles 21 de octubre de 2026, 15:40 en Lima (UTC−5).
const NOW = new Date("2026-10-21T20:40:00.000Z")
const ZONE = { timezone: "America/Lima", locale: "es-PE" }
const resolve = (periodo: string, compara: "no" | "anterior" | "año_anterior" | "otro" = "no", otro?: string) => {
  const period = resolveArgosPeriod({ periodo, compara, ...(otro ? { otro } : {}) }, ZONE, NOW)
  if (!period) throw new Error("sin periodo")
  return period
}

describe("el periodo de una respuesta", () => {
  it("lo que viene (D26): el día, la semana y el mes enteros, mañana, lo que queda del mes y el próximo", () => {
    expect(resolve("hoy_entero")).toMatchObject({ grain: "dia", label: "Hoy, el día entero", words: { periodo: "hoy" } })
    expect(resolve("hoy_entero").span).toMatchObject({ partial: false, end: new Date("2026-10-22T05:00:00.000Z") })
    expect(resolve("manana")).toMatchObject({ grain: "dia", label: "Mañana, 22 de octubre", words: { periodo: "mañana" } })
    expect(resolve("semana_entera")).toMatchObject({ grain: "semana", label: "Esta semana, de lunes a domingo", words: { periodo: "esta semana" } })
    expect(resolve("semana_entera").span).toMatchObject({ firstDay: "2026-10-19", lastDay: "2026-10-25", partial: false })
    expect(resolve("proxima_semana")).toMatchObject({ label: "La próxima semana, del 26 de octubre al 1 de noviembre", words: { periodo: "la próxima semana" } })
    expect(resolve("mes_entero", "anterior")).toMatchObject({
      grain: "mes",
      label: "Octubre de 2026, el mes entero",
      words: { periodo: "en octubre", periodo_antes: "en setiembre" },
    })
    expect(resolve("mes_entero").span).toMatchObject({ firstDay: "2026-10-01", lastDay: "2026-10-31" })
    expect(resolve("resto_del_mes")).toMatchObject({ label: "Lo que queda de octubre, desde hoy", words: { periodo: "en lo que queda de octubre" } })
    expect(resolve("resto_del_mes").span.start).toEqual(NOW)
    expect(resolve("proximo_mes")).toMatchObject({ label: "Noviembre de 2026", words: { periodo: "en noviembre" } })
  })

  it("este mes contra el anterior: las fechas de Reportes, hasta la misma hora en los dos lados", () => {
    const period = resolve("este_mes", "anterior")
    const screen = resolveReportWindow(ZONE.timezone, "este_mes", NOW)
    expect(period.span.start).toEqual(screen.start)
    expect(period.span.end).toEqual(NOW)
    expect(period.before?.start).toEqual(screen.previous.start)
    expect(period.before?.end).toEqual(new Date("2026-09-21T20:40:00.000Z"))
    expect(period).toMatchObject({
      grain: "mes",
      label: "Octubre de 2026, hasta hoy",
      compareLabel: "los mismos días de setiembre de 2026",
      words: { periodo: "del 1 al 21 de octubre", periodo_antes: "en los mismos días de setiembre" },
    })
  })

  it("los meses completos se dicen como meses", () => {
    expect(resolve("mes_pasado", "anterior")).toMatchObject({
      label: "Setiembre de 2026",
      compareLabel: "agosto de 2026",
      words: { periodo: "en setiembre", periodo_antes: "en agosto" },
    })
    expect(resolve("ultimos_3_meses", "anterior")).toMatchObject({ label: "Julio a setiembre de 2026", compareLabel: "abril a junio de 2026", words: { periodo: "de julio a setiembre" } })
    expect(resolve("ultimos_12_meses")).toMatchObject({ label: "Octubre de 2025 a setiembre de 2026", words: { periodo: "de octubre de 2025 a setiembre de 2026" } })
    expect(resolve("este_ano", "anterior")).toMatchObject({
      label: "Enero a octubre de 2026, hasta hoy",
      compareLabel: "el mismo tramo de enero a octubre de 2025",
      words: { periodo: "del 1 de enero al 21 de octubre", periodo_antes: "en el mismo tramo de 2025" },
    })
  })

  it("un día y una semana ofrecen sus propias opciones y se comparan con el día y la semana de antes", () => {
    const today = resolve("hoy", "anterior")
    expect(today).toMatchObject({ grain: "dia", label: "Hoy, hasta las 15:40", compareLabel: "el día anterior, hasta la misma hora", words: { periodo: "hoy", periodo_antes: "el día anterior" } })
    expect(today.before?.end).toEqual(new Date("2026-10-20T20:40:00.000Z"))
    expect(resolve("ayer")).toMatchObject({ label: "Ayer, 20 de octubre", words: { periodo: "ayer" } })
    expect(resolve("2026-10-05")).toMatchObject({ label: "5 de octubre de 2026", words: { periodo: "el 5 de octubre" } })
    // Del lunes 19 a hoy contra el lunes 12 al miércoles 14, hasta la misma hora: no los tres días justo antes.
    const week = resolve("esta_semana", "anterior")
    expect(week).toMatchObject({ grain: "semana", label: "Esta semana, hasta hoy", compareLabel: "los mismos días de la semana anterior", words: { periodo: "esta semana" } })
    expect(week.span.firstDay).toBe("2026-10-19")
    expect(week.before).toMatchObject({ firstDay: "2026-10-12", lastDay: "2026-10-14", end: new Date("2026-10-14T20:40:00.000Z") })
    expect(resolve("semana_pasada")).toMatchObject({ label: "La semana pasada, del 12 al 18 de octubre", words: { periodo: "la semana pasada" } })
  })

  it("unas fechas se comparan con los mismos días justo antes, y los últimos N días se mueven con el día", () => {
    expect(resolve("2026-10-01..2026-10-15", "anterior")).toMatchObject({
      label: "Del 1 al 15 de octubre de 2026",
      compareLabel: "los mismos días justo antes: 16 al 30 de setiembre de 2026",
      words: { periodo: "del 1 al 15 de octubre", periodo_antes: "en los 15 días anteriores" },
    })
    const rolling = resolve("ultimos_90_dias")
    expect(rolling).toMatchObject({ rolling: true, label: "Del 24 de julio al 21 de octubre de 2026, hasta hoy" })
    const tomorrow = resolveArgosPeriod({ periodo: "ultimos_90_dias", compara: "no" }, ZONE, new Date(NOW.getTime() + 86_400_000))
    expect(tomorrow?.span.firstDay).toBe("2026-07-25")
  })

  it("contra el año pasado y contra otro periodo que nombra la pregunta (D14 y D15)", () => {
    const lastYear = resolve("este_mes", "año_anterior")
    expect(lastYear).toMatchObject({ compareLabel: "los mismos días de octubre de 2025", words: { periodo_antes: "en los mismos días de octubre de 2025" } })
    expect(lastYear.before).toMatchObject({ firstDay: "2025-10-01", end: new Date("2025-10-21T20:40:00.000Z") })
    expect(resolve("mes_pasado", "año_anterior")).toMatchObject({ compareLabel: "setiembre de 2025", words: { periodo_antes: "en setiembre de 2025" } })
    expect(resolve("2026-07", "otro", "2026-03")).toMatchObject({
      label: "Julio de 2026",
      otherLabel: "Marzo de 2026",
      compareLabel: null,
      words: { periodo: "en julio", periodo_antes: "en marzo" },
    })
  })

  it("lo que solo existe a hoy no lleva periodo, y un periodo imposible no se acepta", () => {
    expect(resolveArgosPeriod({ periodo: "a_hoy", compara: "no" }, ZONE, NOW)).toBeNull()
    expect(argosTodayLabel(ZONE, NOW)).toBe("A hoy, 21 de octubre, 15:40")
    expect(() => resolve("2026-10-22")).toThrow("todavía no pasa")
    expect(() => resolve("la_quincena")).toThrow("Periodo no reconocido")
    expect(() => resolve("este_mes", "otro")).toThrow("segundo periodo")
  })
})

describe("la consulta con el periodo", () => {
  it("odentIA pone las fechas y la sede; los textos entre comillas y los ::tipo no se tocan", () => {
    const period = resolve("este_mes", "anterior")
    const bound = bindArgosPeriod(
      "select sum(importe) filter (where momento >= :desde and momento < :hasta) as a, sum(importe) filter (where momento >= :desde_antes and momento < :hasta_antes) as b, ':desde' as texto, dia::date as d from cobros where (:sede is null or sede = :sede)",
      period,
      "O'Higgins",
    )
    expect(bound).toEqual({
      sql: "select sum(importe) filter (where momento >= timestamptz '2026-10-01T05:00:00.000Z' and momento < timestamptz '2026-10-21T20:40:00.000Z') as a, sum(importe) filter (where momento >= timestamptz '2026-09-01T05:00:00.000Z' and momento < timestamptz '2026-09-21T20:40:00.000Z') as b, ':desde' as texto, dia::date as d from cobros where ('O''Higgins' is null or sede = 'O''Higgins')",
    })
    expect(bindArgosPeriod("select count(*) from agenda_por_dia where dia >= :dia_desde and dia < :dia_hasta and (:sede is null or sede = :sede)", resolve("mes_pasado"), null)).toEqual({
      sql: "select count(*) from agenda_por_dia where dia >= date '2026-09-01' and dia < date '2026-10-01' and (null::text is null or sede = null::text)",
    })
  })

  it("si la consulta no usa el periodo que eligió, el modelo recibe qué corregir", () => {
    expect(bindArgosPeriod("select sum(importe) from cobros where dia >= date_trunc('month', current_date)", resolve("este_mes"), null)).toMatchObject({ problem: expect.stringContaining(":desde y :hasta") })
    expect(bindArgosPeriod("select sum(saldo) from deudas where momento >= :desde", null, null)).toMatchObject({ problem: expect.stringContaining("a_hoy") })
    expect(bindArgosPeriod("select 1 where :desde < :hasta and :desde_antes < :hasta_antes", resolve("este_mes"), null)).toMatchObject({ problem: expect.stringContaining("compara es «no»") })
    expect(bindArgosPeriod("select 1 where :desde < :hasta", resolve("este_mes", "anterior"), null)).toMatchObject({ problem: expect.stringContaining(":desde_antes") })
  })

  it("la frase dice el periodo sin destacarlo y con mayúscula si abre con él", () => {
    const period = resolve("este_mes", "anterior")
    const result = { columns: [{ name: "cobrado_dinero", kind: "number" as const }], rows: [{ cobrado_dinero: 34818 }], truncated: false }
    const filled = fillArgosSentence("{periodo} cobraste {cobrado_dinero}; {periodo_antes}, menos.", result, { ...ZONE, currency: "PEN" }, period.words)
    expect(filled.text).toBe("Del 1 al 21 de octubre cobraste S/ 34,818.00; en los mismos días de setiembre, menos.")
    expect(filled.parts.filter((part) => part.strong).map((part) => part.text)).toEqual(["S/ 34,818.00"])
    expect(fillArgosWords("{periodo} no se cobró nada.", resolve("2025-08").words)).toBe("En agosto de 2025 no se cobró nada.")
    // El periodo ya trae su preposición: la que el modelo escribió delante sobra.
    expect(fillArgosSentence("En {periodo} se cobró {cobrado_dinero}.", result, { ...ZONE, currency: "PEN" }, period.words).text).toBe("Del 1 al 21 de octubre se cobró S/\u00a034,818.00.")
    expect(fillArgosWords("Lo cobrado en {periodo}.", period.words)).toBe("Lo cobrado del 1 al 21 de octubre.")
    expect(fillArgosWords("Lo cobrado durante {periodo}.", resolve("hoy").words)).toBe("Lo cobrado hoy.")
    expect(fillArgosSentence("No hay facturas. {periodo} se cobró {cobrado_dinero}.", result, { ...ZONE, currency: "PEN" }, period.words).text).toMatch(/^No hay facturas\. Del 1 al 21/)
  })

  it("un total que la frase ya dice no se repite en cada fila de la lista", () => {
    const result = {
      columns: [
        { name: "concepto", kind: "text" as const },
        { name: "cobrado_dinero", kind: "number" as const },
        { name: "total_dinero", kind: "number" as const },
        { name: "variacion_pct", kind: "number" as const },
      ],
      rows: [
        { concepto: "Corona", cobrado_dinero: 9000, total_dinero: 34818, variacion_pct: -33 },
        { concepto: "Obturación", cobrado_dinero: 4500, total_dinero: 34818, variacion_pct: -33 },
      ],
      truncated: false,
    }
    const filled = fillArgosSentence("Se cobró {total_dinero} ({variacion_pct}). Por concepto: {lista}.", result, { ...ZONE, currency: "PEN" })
    expect(filled.text).toBe("Se cobró S/\u00a034,818.00 (-33 %). Por concepto: Corona (S/\u00a09,000.00); Obturación (S/\u00a04,500.00).")
  })
})
