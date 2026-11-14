import { describe, expect, it } from "vitest"
import { dentalHabitsErrors, dentalInterviewEntries, dentalInterviewErrors, dentalInterviewItems, dentalInterviewLines } from "./interview.js"

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

// QA del 14 nov (causa raíz): arriba de la ficha y de la atención va solo lo que cambia la cita.
describe("lo de la entrevista que va arriba", () => {
  it("el corazón, el antibiótico y la anestesia solo con «Sí» o «No sabe»; la lactancia con su día; el tabaco nunca", () => {
    const items = dentalInterviewItems({
      antecedentesOdontologicos: { corazon: { riesgoEndocarditis: "si", antibioticoPrevio: "no_sabe" }, problemaAnestesia: "no" },
      habitos: { tabaco: "fuma", cigarrillos: "10_o_mas" },
      embarazoLactancia: { lactancia: { estado: "si", fecha: "2026-11-14" } },
    })
    expect(items.map((item) => [item.key, item.alert])).toEqual([
      ["corazon", "Corazón: válvula, de nacimiento o endocarditis · no sabe si debe tomar antibiótico antes"],
      ["anestesia", null],
      ["tabaco", null],
      ["lactancia", "Lactancia"],
    ])
    expect(items.find((item) => item.key === "lactancia")?.saidOn).toBe("2026-11-14")
    // Lo que nadie dijo no sale: nunca un «No» inventado.
    expect(dentalInterviewItems({})).toEqual([])
  })
})


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
