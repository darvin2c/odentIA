import { describe, expect, it } from "vitest"
import { CONFIRMS_QUESTION, confirmState, understoodYes } from "./confirm-intent.js"
import type { DecisionModel } from "./decision/port.js"

/** Un modelo de decisión de prueba que responde siempre con esta probabilidad. */
function model(probability: number | "falla"): DecisionModel & { states: string[] } {
  const states: string[] = []
  return {
    provider: "fake",
    reportsProbabilities: true,
    states,
    async decide(state) {
      states.push(state)
      if (probability === "falla") throw new Error("sin respuesta")
      return { answers: [{ id: CONFIRMS_QUESTION.id, kind: "yesno", probability }], model: "prueba", usage: null, latencyMs: 1 }
    },
  }
}

const proposed = "Te propongo el lunes 26 a las 9:00 con la Dra. Ana. ¿Te la confirmo?"

describe("el sí del paciente se entiende por su intención (ADR 0023)", () => {
  it("las palabras de siempre bastan, sin llamar al modelo", async () => {
    const decision = model(0)
    expect(await understoodYes(decision, { proposed, reply: "Sí, gracias" })).toBe(true)
    expect(decision.states).toEqual([])
  })

  it("lo demás lo decide el modelo de decisión, con lo propuesto y lo respondido", async () => {
    const yes = model(0.95)
    expect(await understoodYes(yes, { proposed, reply: "Me sirve, ahí estaré el lunes temprano" })).toBe(true)
    expect(yes.states[0]).toBe(confirmState({ proposed, reply: "Me sirve, ahí estaré el lunes temprano" }))
    expect(yes.states[0]).toContain("Dra. Ana")
    expect(await understoodYes(model(0.6), { proposed, reply: "sí, pero mejor a las 10" })).toBe(false)
  })

  it("sin modelo o si falla, no se da por sí: el agente vuelve a preguntar", async () => {
    expect(await understoodYes(null, { proposed, reply: "Me sirve, ahí estaré el lunes temprano" })).toBe(false)
    expect(await understoodYes(model("falla"), { proposed, reply: "Me sirve, ahí estaré el lunes temprano" })).toBe(false)
  })
})
