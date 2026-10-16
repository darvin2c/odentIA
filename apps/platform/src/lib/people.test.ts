import { describe, expect, it } from "vitest"
import { filiationGapsText } from "./patients"
import { isPeopleView } from "./people"

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
