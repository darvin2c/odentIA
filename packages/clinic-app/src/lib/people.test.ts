import { describe, expect, it } from "vitest"
import { filiationGapsText } from "./patients"
import { isPeopleView, listDay } from "./people"

describe("lo que falta para atenderla, en palabras", () => {
  it("dice el documento una sola vez aunque falten tipo y número", () => {
    expect(
      filiationGapsText([
        { key: "birthDate", label: "Fecha de nacimiento" },
        { key: "docType", label: "Tipo de documento" },
        { key: "docNumber", label: "Número de documento" },
      ]),
    ).toBe("Fecha de nacimiento y documento")
    expect(filiationGapsText([])).toBe("")
  })
})

describe("vistas de la lista única", () => {
  it("solo valen las vistas que tienen chip", () => {
    expect(isPeopleView("por_registrar")).toBe(true)
    expect(isPeopleView("contactos")).toBe(false)
    expect(isPeopleView(undefined)).toBe(false)
  })
})

// QA del 6 nov (B10): «Última visita: vie, 21 nov.» era del año pasado y parecía de este mes.
describe("las fechas de la lista de Pacientes", () => {
  const now = new Date("2026-11-07T15:00:00.000Z")
  it("dicen el año si no es de este", () => {
    expect(listDay("2025-11-21T15:00:00.000Z", "es-PE", "America/Lima", now)).toMatch(/2025/)
  })
  it("de este año, sin el año, en la zona de la clínica", () => {
    expect(listDay("2026-11-06T15:00:00.000Z", "es-PE", "America/Lima", now)).not.toMatch(/2026/)
    // A las 02:00 UTC del 7 todavía es el 6 en Lima.
    expect(listDay("2026-11-07T02:00:00.000Z", "es-PE", "America/Lima", now)).toMatch(/6/)
  })
})
