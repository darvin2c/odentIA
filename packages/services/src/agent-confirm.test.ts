import { describe, expect, it } from "vitest"
import { isAffirmative, onlyCourtesy } from "./agent-operations.js"

/** La evidencia de confirmación nunca acepta negaciones como consentimiento. */
describe("isAffirmative", () => {
  it.each([
    "Sí",
    "sí",
    "  Sí. ",
    "confirmo",
    "Confirmado",
    "de acuerdo",
    "vale",
    "OK",
    "adelante",
    "dale",
    "acepto",
    "quiero",
    "sí quiero",
    // Se dice de muchas formas (ADR 0023): se entiende la intención, no una frase exacta.
    "Confirmo, perfecto",
    "Perfecto",
    "Sí, gracias",
    "Sí, por favor",
    "si porfa",
    "Sí, confírmala",
    "Ok, ahí estaré",
    "Listo, gracias Sofi",
    "Claro que sí",
    "Me parece bien",
    "Sí, me sirve",
    "👍",
  ])("acepta %s", (text) => {
    expect(isAffirmative(text)).toBe(true)
  })

  it.each([
    null,
    "",
    "no quiero ese horario, ¿hay otro?",
    "no, así no",
    "por favor espérame",
    "Hola, ¿tienen cita mañana?",
    "sí pero mañana no puedo",
    "ok, pero no mañana",
    "¿confirmo?",
    "sí, confirmo la cita de mañana por la mañana temprano sin falta",
    // Lo que trae otra cosa no se da por sí con palabras: lo decide el modelo de decisión.
    "Sí, pero mejor a las 10",
    "perfecto, ¿y el precio?",
    "ahí estaré pero llego tarde",
    "mejor otro día",
    "no gracias",
    "gracias",
    "bueno",
  ])("rechaza %s", (text) => {
    expect(isAffirmative(text)).toBe(false)
  })
})

/** Lo que no pide nada no entra a un tema (ADR 0122); confirmar sigue siendo solo `isAffirmative`. */
describe("onlyCourtesy", () => {
  it.each(["Si", "Sí.", "ok", "Ok gracias", "gracias", "Muchas gracias doctora", "entendido", "Ya", "ajá", "👍", "gracias 🙏", "Perfecto, nos vemos"])(
    "%s no pide nada",
    (text) => {
      expect(onlyCourtesy(text)).toBe(true)
    },
  )

  it.each([
    null,
    "",
    "¿Y?",
    "No cuentan con alineadores invisibles?",
    "Sigo esperando lo del descuento",
    "no gracias",
    "sí, pero mañana no puedo",
    "Y una extracción de la muela del juicio",
  ])("%s sí dice algo", (text) => {
    expect(onlyCourtesy(text)).toBe(false)
  })

  it("agradecer no confirma", () => {
    expect(onlyCourtesy("gracias")).toBe(true)
    expect(isAffirmative("gracias")).toBe(false)
    expect(onlyCourtesy("entendido")).toBe(true)
    expect(isAffirmative("entendido")).toBe(false)
  })
})
