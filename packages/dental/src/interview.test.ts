import { describe, expect, it } from "vitest"
import { childhoodLines, dentalHabitsErrors, dentalInterviewErrors, dentalInterviewLines } from "./interview.js"

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

describe("«de pequeño»: lo que cuenta quien cuida a un niño", () => {
  it("se lee en tres filas, con sus palabras, y lo que no se respondió no sale", () => {
    expect(
      childhoodLines({ biberon: "ya_no", chupon: "dedo", dulcesEntreComidas: "4_o_mas", pastaConFluor: "si", quienCepilla: "solo" }),
    ).toEqual([
      { label: "De pequeño", value: "ya no toma biberón · se chupa el dedo" },
      { label: "Dulces o jugos entre comidas", value: "4 o más veces al día" },
      { label: "Dientes", value: "pasta con flúor · se cepilla sin ayuda" },
    ])
    // A los 8 años no se preguntan el biberón ni el chupón: no hay fila «De pequeño».
    expect(childhoodLines({ dulcesEntreComidas: "1_a_3", quienCepilla: "adulto" })).toEqual([
      { label: "Dulces o jugos entre comidas", value: "1 a 3 veces al día" },
      { label: "Dientes", value: "lo cepilla un adulto" },
    ])
    expect(childhoodLines({ bruxismo: true })).toEqual([])
    expect(childhoodLines(undefined)).toEqual([])
  })

  it("solo se guardan las respuestas de su lista", () => {
    expect(dentalInterviewErrors({ antecedentesOdontologicos: { dulcesEntreComidas: "4_o_mas", biberon: "ya_no" } })).toEqual({})
    expect(dentalInterviewErrors({ antecedentesOdontologicos: { dulcesEntreComidas: "muchos" } })).toHaveProperty(
      "antecedentesOdontologicos.dulcesEntreComidas",
    )
    expect(dentalInterviewErrors({ antecedentesOdontologicos: { quienCepilla: "papá" } })).toHaveProperty(
      "antecedentesOdontologicos.quienCepilla",
    )
  })
})
