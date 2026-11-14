import { describe, expect, it } from "vitest"
import { dentalHabitsErrors, dentalInterviewErrors, dentalInterviewLines } from "./interview.js"

describe("lo que odentIA suma a la entrevista: corazón, anestesia, tabaco y lactancia", () => {
  it("se dice en palabras, y lo que no se respondió no sale", () => {
    expect(
      dentalInterviewLines({
        antecedentesOdontologicos: { corazon: { riesgoEndocarditis: "si", antibioticoPrevio: "no_sabe" }, problemaAnestesia: "no" },
        habitos: { tabaco: "fuma", cigarrillos: "10_o_mas" },
        embarazoLactancia: { lactancia: { estado: "si", fecha: "2026-11-13" } },
      }),
    ).toEqual([
      "Corazón: válvula, problema de nacimiento o endocarditis: sí · antibiótico antes del dentista: no sabe",
      "Problemas con la anestesia o sangrado tras una extracción: no",
      "Tabaco: fuma, 10 o más al día",
      "Lactancia: sí",
    ])
    expect(dentalInterviewLines({ antecedentesOdontologicos: { bruxismo: true } })).toEqual([])
  })

  it("solo se guardan las respuestas de la lista", () => {
    expect(dentalInterviewErrors({ antecedentesOdontologicos: { corazon: { riesgoEndocarditis: "tal vez" } } })).toHaveProperty(
      "antecedentesOdontologicos.corazon",
    )
    expect(dentalHabitsErrors({ habitos: { tabaco: "fuma", cigarrillos: "menos_10" } })).toEqual({})
    expect(dentalHabitsErrors({ habitos: { tabaco: "nunca", cigarrillos: "menos_10" } })).toHaveProperty("habitos.cigarrillos")
  })
})
