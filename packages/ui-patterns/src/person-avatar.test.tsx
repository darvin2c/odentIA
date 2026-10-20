import { describe, expect, it } from "vitest"
import { personInitials } from "./person-avatar.js"

describe("iniciales de una persona", () => {
  it("toma el nombre y el primer apellido, sin el tratamiento", () => {
    expect(personInitials("Dra. Ana Torres")).toBe("AT")
    expect(personInitials("Rosa Quispe Mamani")).toBe("RQ")
    expect(personInitials("Dr. Luis Vega")).toBe("LV")
  })

  it("salta las partículas de un apellido compuesto", () => {
    expect(personInitials("Juan de la Cruz Ríos")).toBe("JC")
    expect(
      personInitials({
        name: "Juan de la Cruz Ríos",
        givenNames: "Juan",
        familyName: "de la Cruz Ríos",
      }),
    ).toBe("JC")
  })

  it("con nombres y apellidos por separado no adivina el apellido", () => {
    expect(
      personInitials({
        name: "María José Pérez Soto",
        givenNames: "María José",
        familyName: "Pérez Soto",
      }),
    ).toBe("MP")
  })

  it("con un solo nombre queda una inicial y sin nada, un signo", () => {
    expect(personInitials("Ana")).toBe("A")
    expect(personInitials("")).toBe("?")
  })
})
