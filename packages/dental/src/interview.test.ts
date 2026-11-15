import { describe, expect, it } from "vitest"
import { childhoodEntries, dentalHabitsErrors, dentalInterviewEntries, dentalInterviewErrors, dentalInterviewItems, dentalInterviewLines } from "./interview.js"

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

describe("lo de un niño en casa: lo que cuenta quien lo cuida", () => {
  it("se lee dato por dato, con sus palabras, y lo que no se respondió no sale", () => {
    expect(childhoodEntries({ biberon: "ya_no", dulcesEntreComidas: "4_o_mas", quienCepilla: "solo" })).toEqual([
      { key: "biberon", label: "Biberón o pecho para dormir", value: "ya no toma biberón" },
      { key: "dulcesEntreComidas", label: "Dulces o jugos entre comidas", value: "4 o más veces al día" },
      { key: "quienCepilla", label: "Quién le cepilla los dientes", value: "se cepilla sin ayuda" },
    ])
    expect(childhoodEntries({ bruxismo: true })).toEqual([])
    expect(childhoodEntries(undefined)).toEqual([])
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

  it("lo de pequeño que contó quien cuida a un niño también va en la copia, con las palabras de la pantalla", () => {
    expect(
      dentalInterviewEntries({
        antecedentesOdontologicos: { biberon: "ya_no", chupon: "dedo", dulcesEntreComidas: "4_o_mas", pastaConFluor: "si", quienCepilla: "solo" },
      }).map((entry) => `${entry.key} · ${entry.label}: ${entry.value}`),
    ).toEqual([
      "antecedentesOdontologicos.biberon · Biberón o pecho para dormir: Ya no toma biberón",
      "antecedentesOdontologicos.chupon · Chupón o dedo: Se chupa el dedo",
      "antecedentesOdontologicos.dulcesEntreComidas · Dulces o jugos entre comidas: 4 o más veces al día",
      "antecedentesOdontologicos.pastaConFluor · Pasta de dientes con flúor: Pasta con flúor",
      "antecedentesOdontologicos.quienCepilla · Quién le cepilla los dientes: Se cepilla sin ayuda",
    ])
    // Una respuesta que no es de la lista no sale.
    expect(dentalInterviewEntries({ antecedentesOdontologicos: { biberon: "mucho" } })).toEqual([])
  })
})
