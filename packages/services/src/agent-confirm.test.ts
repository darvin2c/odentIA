import { describe, expect, it } from "vitest"
import { isAffirmative, onlyCourtesy, repeatsProposal } from "./agent-operations.js"

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
    // Lo que solo acompaña a un sí no alcanza: pide algo.
    "Por favor",
    "Doctora, por favor",
    "A la una",
    "Es la una",
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

describe("repeatsProposal", () => {
  const PROPOSED = "¿Te reservo mañana, lunes 9 de noviembre, a las 10:00 en Miraflores con el Dr. Luis Prado?"
  it("un sí que repite lo propuesto es un sí, aunque no haya modelo de decisión", () => {
    // Caso 12 de la auditoría del 8 nov: lo repitió cinco veces y nunca se reservó.
    expect(isAffirmative("Sí, porfa, mañana a las 10 en Miraflores.")).toBe(false)
    expect(repeatsProposal("Sí, porfa, mañana a las 10 en Miraflores.", PROPOSED)).toBe(true)
    expect(repeatsProposal("Resérvala porfa, mañana a las 10 en Miraflores", PROPOSED)).toBe(true)
    expect(repeatsProposal("Sí, con el Dr. Prado", PROPOSED)).toBe(true)
  })
  it.each([
    "Sí, pero a las 11",
    "Sí, mañana a las 11",
    "Sí, en San Isidro",
    "Mañana a las 10 en Miraflores",
    "No, mañana a las 10 no puedo",
    "Sí, mejor más tarde",
    "¿Sí, mañana a las 10?",
  ])("«%s» no repite lo propuesto: no es un sí", (reply) => {
    expect(repeatsProposal(reply, PROPOSED)).toBe(false)
  })
  it("si lo propuesto ofrece elegir, repetir una parte no dice cuál", () => {
    expect(repeatsProposal("Sí, a las 10", "¿Te reservo a las 10:00 o a las 11:30?")).toBe(false)
    expect(repeatsProposal("Sí, a las 10", null)).toBe(false)
  })
})
