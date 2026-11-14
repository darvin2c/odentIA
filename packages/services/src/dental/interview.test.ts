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

  it("el corazón y la anestesia van con su boca; la lactancia y el tabaco, con la forma de latidIA", () => {
    expect(
      dentalInterview.declared(
        {
          personal: { embarazo: false },
          dental: { corazon: { riesgoEndocarditis: "si", antibioticoPrevio: "no_sabe" }, problemaAnestesia: "no" },
          medical: { lactancia: true, tabaco: "fuma", cigarrillos: "10_o_mas" },
        },
        today,
      ),
    ).toEqual({
      embarazoLactancia: { embarazo: { estado: "no", fecha: today }, lactancia: { estado: "si", fecha: today } },
      habitos: { tabaco: "fuma", cigarrillos: "10_o_mas" },
      antecedentesOdontologicos: {
        corazon: { riesgoEndocarditis: "si", antibioticoPrevio: "no_sabe" },
        problemaAnestesia: "no",
      },
    })
  })

  it("lo que no es una respuesta de la lista no se guarda, y cuántos fuma solo de quien fuma", () => {
    expect(() =>
      dentalInterview.check({ antecedentesOdontologicos: { problemaAnestesia: "quizá" } }, today),
    ).toThrow()
    expect(() => dentalInterview.check({ habitos: { tabaco: "nunca", cigarrillos: "menos_10" } }, today)).toThrow()
    expect(() => dentalInterview.check({ habitos: { alcohol: "no" } }, today)).toThrow()
    const ok = { habitos: { tabaco: "fuma", cigarrillos: "menos_10" } }
    expect(dentalInterview.check(ok, today)).toBe(ok)
  })

  it("«de pequeño», lo que contó la mamá de un niño, entra a su boca y se lee en palabras", () => {
    const said = { dental: { biberon: "ya_no", chupon: "dedo", dulcesEntreComidas: "4_o_mas", pastaConFluor: "si", quienCepilla: "solo" } } as const
    expect(dentalInterview.declared(said, today)).toEqual({ antecedentesOdontologicos: said.dental })
    expect(dentalInterview.check({ antecedentesOdontologicos: said.dental }, today)).toEqual({ antecedentesOdontologicos: said.dental })
    expect(dentalInterview.declaredLines?.(said)).toEqual([
      { label: "De pequeño", value: "ya no toma biberón · se chupa el dedo" },
      { label: "Dulces o jugos entre comidas", value: "4 o más veces al día" },
      { label: "Dientes", value: "pasta con flúor · se cepilla sin ayuda" },
    ])
    expect(dentalInterview.declaredLines?.({ dental: { corazon: { riesgoEndocarditis: "no" } } })).toEqual([])
  })
})
