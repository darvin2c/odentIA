import { describe, expect, it } from "vitest"
import { commonInterviewEntries } from "./interview.js"

describe("la entrevista de salud en palabras (copia de la historia)", () => {
  it("dice los antecedentes personales en el orden de la pantalla, con las semanas del embarazo", () => {
    expect(
      commonInterviewEntries({
        antecedentesPersonales: {
          embarazo: true,
          semanasEmbarazo: 30,
          transfusiones: " Ninguna ",
          hospitalizaciones: "Neumonía en 2019",
        },
      }),
    ).toEqual([
      { key: "antecedentesPersonales.hospitalizaciones", label: "Hospitalizaciones", value: "Neumonía en 2019" },
      { key: "antecedentesPersonales.transfusiones", label: "Transfusiones", value: "Ninguna" },
      { key: "antecedentesPersonales.embarazo", label: "Embarazo", value: "Sí, 30 semanas al registrarlo" },
    ])
  })

  it("un «no» es una respuesta; lo que no se respondió no sale", () => {
    expect(commonInterviewEntries({ antecedentesPersonales: { embarazo: false, cirugias: "" } })).toEqual([
      { key: "antecedentesPersonales.embarazo", label: "Embarazo", value: "No" },
    ])
    expect(commonInterviewEntries({ antecedentesPersonales: { embarazo: true, semanasEmbarazo: 1 } })[0]?.value).toBe(
      "Sí, 1 semana al registrarlo",
    )
    expect(commonInterviewEntries(null)).toEqual([])
    expect(commonInterviewEntries({ antecedentesOdontologicos: { bruxismo: true } })).toEqual([])
  })

  it("lo que una entrevista antigua guardaba como texto sale como registro anterior", () => {
    expect(
      commonInterviewEntries({
        antecedentesFamiliares: "Madre diabética",
        antecedentesPersonales: { enfermedades: "Hipertensión" },
      }).map((entry) => `${entry.label}: ${entry.value}`),
    ).toEqual(["Enfermedades (registro anterior): Hipertensión", "Antecedentes familiares (registro anterior): Madre diabética"])
  })
})
