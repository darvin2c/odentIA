import { describe, expect, it } from "vitest"
import { medicalInterview } from "./interview.js"

/** Sin base: lo que latidIA hace con la entrevista y con lo declarado en el registro. */
describe("la entrevista de latidIA (issue 229, decisión 13)", () => {
  const today = "2026-10-24"

  it("latidIA guarda el embarazo del registro con la fecha en que se dijo, y la lactancia y los hábitos", () => {
    expect(
      medicalInterview.declared(
        {
          personal: { embarazo: true, semanasEmbarazo: 10, cirugias: "Apendicitis" },
          medical: { lactancia: false, tabaco: "fuma", alcohol: "no" },
        },
        today,
      ),
    ).toEqual({
      antecedentesPersonales: { cirugias: "Apendicitis" },
      embarazoLactancia: {
        embarazo: { estado: "si", fecha: today, semanas: 10 },
        lactancia: { estado: "no", fecha: today },
      },
      habitos: { tabaco: "fuma", alcohol: "no" },
    })
    expect(medicalInterview.declared({}, today)).toEqual({})
  })

  it("latidIA rechaza lo que no vale y limpia lo que sí", () => {
    expect(() =>
      medicalInterview.check({ embarazoLactancia: { embarazo: { estado: "si" } } }, today),
    ).toThrow(/fecha/)
    expect(
      medicalInterview.check({ habitos: { tabaco: "nunca", cigarrillosDia: 5 } }, today),
    ).toEqual({
      habitos: { tabaco: "nunca" },
    })
  })
})
