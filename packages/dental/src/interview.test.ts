import { describe, expect, it } from "vitest"
import { dentalInterviewEntries } from "./interview.js"

describe("«Odontológicos y hábitos» en palabras (copia de la historia)", () => {
  it("cada dato con el nombre de la pantalla y su opción dicha", () => {
    expect(
      dentalInterviewEntries({
        antecedentesOdontologicos: {
          habitos: ["onicofagia", "morder lápices"],
          bruxismo: true,
          hiloDental: false,
          ansiedadDental: "moderada",
          experienciaPrevia: "traumatica",
          cepilladosAlDia: 2,
          ultimaVisita: "Hace dos años",
        },
      }).map((entry) => `${entry.key} · ${entry.label}: ${entry.value}`),
    ).toEqual([
      "antecedentesOdontologicos.ultimaVisita · Última visita: Hace dos años",
      "antecedentesOdontologicos.cepilladosAlDia · Cepillados al día: 2",
      "antecedentesOdontologicos.experienciaPrevia · Experiencia previa: Traumática",
      "antecedentesOdontologicos.ansiedadDental · Ansiedad dental: Moderada",
      "antecedentesOdontologicos.hiloDental · Hilo dental: No",
      "antecedentesOdontologicos.bruxismo · Bruxismo: Sí",
      "antecedentesOdontologicos.habitos · Hábitos: onicofagia, morder lápices",
    ])
  })

  it("sin respuestas de la boca no dice nada", () => {
    expect(dentalInterviewEntries({ antecedentesPersonales: { embarazo: true } })).toEqual([])
    expect(dentalInterviewEntries({ antecedentesOdontologicos: { cepilladosAlDia: 0, habitos: [] } })).toEqual([
      { key: "antecedentesOdontologicos.cepilladosAlDia", label: "Cepillados al día", value: "0" },
    ])
    expect(dentalInterviewEntries(undefined)).toEqual([])
  })
})
