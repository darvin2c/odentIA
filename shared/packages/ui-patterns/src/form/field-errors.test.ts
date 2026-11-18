import { describe, expect, it } from "vitest"
import { fieldErrorMessages } from "./field-errors.js"

describe("fieldErrorMessages", () => {
  it("extrae message de issues de Standard Schema (Zod)", () => {
    expect(fieldErrorMessages([{ message: "Correo inválido", path: ["email"] }])).toEqual([
      "Correo inválido",
    ])
  })

  it("pasa strings y descarta basura sin pintar [object Object]", () => {
    expect(fieldErrorMessages(["requerido", 42, null, {}])).toEqual(["requerido"])
  })

  it("no-array devuelve vacío", () => {
    expect(fieldErrorMessages(undefined)).toEqual([])
  })
})
