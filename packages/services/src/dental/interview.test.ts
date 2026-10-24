import { describe, expect, it } from "vitest"
import { dentalInterview } from "./interview.js"

/** Sin base: la entrevista de odentIA no cambió con la de latidIA (issue 229). */
describe("la entrevista de odentIA", () => {
  const today = "2026-10-24"

  it("odentIA sigue como antes: lo personal y su boca con sus mismas claves", () => {
    expect(
      dentalInterview.declared(
        { personal: { embarazo: true, semanasEmbarazo: 10 }, dental: { bruxismo: true } },
        today,
      ),
    ).toEqual({
      antecedentesPersonales: { embarazo: true, semanasEmbarazo: 10 },
      antecedentesOdontologicos: { bruxismo: true },
    })
    // La entrevista de odentIA no valida lo médico: no lo pregunta.
    const answers = { antecedentesOdontologicos: { bruxismo: true } }
    expect(dentalInterview.check(answers, today)).toBe(answers)
  })
})
