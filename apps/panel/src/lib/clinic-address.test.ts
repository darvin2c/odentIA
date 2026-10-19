import { describe, expect, it } from "vitest"
import {
  addressAlternatives,
  addressFromName,
  CLINIC_ADDRESS_PATTERN,
  slugify,
} from "./clinic-address"

describe("addressFromName", () => {
  it("quita lo genérico del principio", () => {
    expect(addressFromName("Clínica Dental Sonrisa")).toBe("sonrisa")
    expect(addressFromName("Centro Odontológico San Juan")).toBe("san-juan")
    expect(addressFromName("Consultorio Dental de la Dra. Ruiz")).toBe("dra-ruiz")
  })

  it("no deja la dirección vacía", () => {
    expect(addressFromName("Clínica Dental")).toBe("clinica-dental")
  })

  it("conserva lo que no es genérico, aunque empiece con un artículo", () => {
    expect(addressFromName("La Sonrisa")).toBe("la-sonrisa")
    expect(addressFromName("demo")).toBe("demo")
  })

  it("corta en un guion a los 30 caracteres", () => {
    const address = addressFromName("Clínica Dental Especialistas Asociados en Ortodoncia Infantil")
    expect(address).toBe("especialistas-asociados-en")
    expect(address.length).toBeLessThanOrEqual(30)
    expect(address).toMatch(CLINIC_ADDRESS_PATTERN)
  })

  it("sin letras ni números no propone nada", () => {
    expect(addressFromName("¡¡!!")).toBe("")
  })
})

describe("slugify", () => {
  it("quita tildes y signos", () => {
    expect(slugify("Ñandú & Peña")).toBe("nandu-pena")
  })
})

describe("addressAlternatives", () => {
  it("propone la misma dirección con un número", () => {
    expect(addressAlternatives("sonrisa", 3)).toEqual(["sonrisa-2", "sonrisa-3", "sonrisa-4"])
  })

  it("conserva lo escrito y no pasa de una etiqueta de dominio", () => {
    const typed = "direccion-89a80434-e591-4571-8507-a5e6cc6c36a9"
    expect(addressAlternatives(typed, 1)).toEqual([`${typed}-2`])
    for (const option of addressAlternatives("a".repeat(30) + "-" + "b".repeat(32))) {
      expect(option.length).toBeLessThanOrEqual(63)
      expect(option).toMatch(CLINIC_ADDRESS_PATTERN)
    }
  })
})
