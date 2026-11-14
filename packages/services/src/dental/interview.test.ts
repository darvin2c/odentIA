import { describe, expect, it } from "vitest"
import { dentalInterview } from "./interview.js"

/** Sin base: lo que odentIA hace con la entrevista y con lo declarado en el registro. */
describe("la entrevista de odentIA", () => {
  const today = "2026-10-24"

  it("lo personal y su boca con sus mismas claves, y el embarazo con el día en que se dijo", () => {
    expect(
      dentalInterview.declared(
        { personal: { embarazo: true, semanasEmbarazo: 10, cirugias: "Apendicitis" }, dental: { bruxismo: true } },
        today,
      ),
    ).toEqual({
      antecedentesPersonales: { cirugias: "Apendicitis" },
      embarazoLactancia: { embarazo: { estado: "si", fecha: today, semanas: 10 } },
      antecedentesOdontologicos: { bruxismo: true },
    })
    expect(dentalInterview.declared({ personal: { embarazo: false } }, today)).toEqual({
      embarazoLactancia: { embarazo: { estado: "no", fecha: today } },
    })
    // La entrevista de odentIA no valida lo médico: no lo pregunta.
    const answers = { antecedentesOdontologicos: { bruxismo: true } }
    expect(dentalInterview.check(answers, today)).toBe(answers)
  })

  it("el embarazo sin la fecha en que se dijo no se guarda, y con ella queda en una sola forma", () => {
    expect(() => dentalInterview.check({ embarazoLactancia: { embarazo: { estado: "si" } } }, today)).toThrow(/fecha/)
    expect(
      dentalInterview.check(
        {
          antecedentesPersonales: { embarazo: true, semanasEmbarazo: 8 },
          embarazoLactancia: { embarazo: { estado: "si", fecha: today, semanas: 10 } },
        },
        today,
      ),
    ).toEqual({ embarazoLactancia: { embarazo: { estado: "si", fecha: today, semanas: 10 } } })
  })
})
