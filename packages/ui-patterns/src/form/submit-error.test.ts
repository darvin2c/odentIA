import { describe, expect, it } from "vitest"
import { SUBMIT_ERROR_WORDS, submitErrorMessage, submitErrorOf } from "./submit-error.js"

/** El `ApiError` de las apps: estado HTTP y cuerpo `{ error }`. */
const apiError = (status: number, message?: string) => ({ status, shape: message ? { message } : {} })

describe("submitErrorOf", () => {
  it("una historia abierta solo para leer dice eso, no «Revisa los datos marcados» (423)", () => {
    const error = apiError(423, "La historia está abierta solo para leer")
    expect(submitErrorOf(error)).toEqual({ form: "La historia está abierta solo para leer", fields: {} })
    expect(submitErrorMessage(error)).toBe("La historia está abierta solo para leer")
  })

  it("un 423 sin mensaje dice que la historia está bloqueada", () => {
    expect(submitErrorOf(apiError(423)).form).toBe(SUBMIT_ERROR_WORDS.locked)
  })

  it("un estado que no viene de la API sigue diciendo lo de siempre", () => {
    expect(submitErrorOf(apiError(422, "detalle interno")).form).toBe(SUBMIT_ERROR_WORDS.invalid)
  })
})
