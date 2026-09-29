import { describe, expect, it } from "vitest"
import { isAffirmative } from "./agent-operations.js"

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
  ])("rechaza %s", (text) => {
    expect(isAffirmative(text)).toBe(false)
  })
})
