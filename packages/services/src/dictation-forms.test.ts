import { withOrgContext } from "@odentia/db"
import { encounterDictationSuggestion } from "@odentia/db/schema/clinical"
import { clinicalFormResponse, clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { and, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { upsertAgentConfig } from "./agentConfig.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { listFormResponses } from "./clinical-forms.js"
import {
  type DictationFormQuestion,
  dictationFormQuestions,
  formAnswerDropReason,
  formAnswerFragments,
  formQuestionsOf,
  formSentencesWithoutAnswer,
  prepareFormAnswer,
  saidNumbers,
  withDiagnosisFormAnswers,
  withoutFormNotes,
  withoutFormPhrases,
} from "./dictation-forms.js"
import {
  confirmDictationSuggestion,
  discardDictationSuggestion,
  listDictationSuggestions,
  restoreDictationSuggestion,
  saveDictationSegment,
} from "./encounter-dictation.js"
import { voidEncounter } from "./encounters.js"
import { loadFormRecords } from "./form-record.js"
import type { ProductSite } from "./product-hooks.js"
import { productHooksFor } from "./products.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Clío propone las respuestas de la ficha empezada (entrega 11, ADR 0188): solo
 * lo que se dijo, comprobado contra la frase, y nada entra hasta que una
 * persona lo acepta, sin pisar lo que ella escribió.
 */

const FDI: ProductSite = {
  code: (value: unknown) => (typeof value === "number" && /^[1-4][1-8]$|^[5-8][1-5]$/.test(String(value)) ? String(value) : null),
  invalid: (value: unknown) => `${String(value)} no es una pieza`,
} as unknown as ProductSite

const question = (number: number, overrides: Partial<DictationFormQuestion>): DictationFormQuestion => ({
  number,
  responseId: "r1",
  formTitle: "Ficha de ortodoncia",
  fieldId: `p${number}`,
  label: `Pregunta ${number}`,
  type: "numero",
  options: null,
  unit: null,
  min: null,
  max: null,
  order: number,
  dependsOn: null,
  ...overrides,
})

const ANGLE = ["Clase I", "Clase II división 1", "Clase II división 2", "Clase III"]
const QUESTIONS: DictationFormQuestion[] = [
  question(1, { fieldId: "clase_molar_derecha", label: "Clase molar derecha (Angle)", type: "opcion_unica", options: ANGLE }),
  question(2, { fieldId: "overjet", label: "Overjet", unit: "mm", min: -10, max: 20 }),
  question(3, { fieldId: "dolor", label: "¿Presenta dolor?", type: "booleano" }),
  question(4, { fieldId: "intensidad", label: "Intensidad", type: "escala", min: 0, max: 10 }),
  question(5, { fieldId: "pieza", label: "Pieza", type: "pieza" }),
  question(6, { fieldId: "habitos", label: "Hábitos", type: "opcion_multiple", options: ["Onicofagia", "Succión digital", "Respiración bucal"] }),
]
const propose = (payload: Record<string, unknown>, sourceText?: string) => prepareFormAnswer({ payload, sourceText }, QUESTIONS, FDI)

describe("los números que se dijeron", () => {
  it("lee cifras, palabras, decimales y negativos, con sus repeticiones", () => {
    expect(saidNumbers("overjet de seis milímetros, overbite de tres")).toEqual([6, 3])
    expect(saidNumbers("dolor en la cuarenta y seis, ocho de diez")).toEqual([46, 8, 10])
    expect(saidNumbers("la veintiséis y la 6,5")).toEqual([26, 6.5])
    expect(saidNumbers("seis y medio, menos dos")).toEqual([6.5, -2])
    expect(saidNumbers("clase dos división dos")).toEqual([2, 2])
    // El punto que cierra la frase no es parte del número.
    expect(saidNumbers("overbite de tres. Clase 2.")).toEqual([3, 2])
    expect(saidNumbers("talla de ciento quince")).toEqual([115])
  })
  it("en una opción lee los romanos; en lo dictado, solo los de dos letras", () => {
    expect(saidNumbers("Clase II división 1", { roman: "todos" })).toEqual([2, 1])
    expect(saidNumbers("Clase I", { roman: "todos" })).toEqual([1])
    expect(saidNumbers("I lado derecho", { roman: "largos" })).toEqual([])
  })
})

describe("lo que propone Clío se comprueba contra lo que se dijo", () => {
  it("sin frase no se propone nada, ni a una pregunta que no se le dio", () => {
    expect(propose({ question: 2, answer: "6" })).toBeNull()
    expect(propose({ question: 9, answer: "6" }, "overjet de seis")).toBeNull()
  })
  it("el número tiene que estar en la frase, sin convertir unidades", () => {
    expect(propose({ question: 2, answer: "6" }, "overjet de seis milímetros")).toMatchObject({ status: "lista", payload: { fieldId: "overjet", value: 6, unit: "mm" } })
    expect(propose({ question: 2, answer: "5" }, "medio centímetro de overjet")).toBeNull()
    expect(propose({ question: 2, answer: "16" }, "overjet de seis")).toBeNull()
  })
  it("fuera de rango queda por revisar, sin valor", () => {
    expect(propose({ question: 4, answer: "15" }, "dolor quince de diez")).toMatchObject({ status: "por_revisar", payload: { value: null } })
  })
  it("el silencio no es «No»: un «No» exige una negación dicha", () => {
    expect(propose({ question: 3, answer: "No" }, "dolor a la percusión en la cuarenta y seis")).toBeNull()
    expect(propose({ question: 3, answer: "No" }, "sin dolor espontáneo")).toMatchObject({ status: "lista", payload: { value: false } })
    expect(propose({ question: 3, answer: "Sí" }, "presenta dolor")).toMatchObject({ status: "lista", payload: { value: true } })
  })
  it("la opción cuya división no se dijo queda por revisar y nombra entre cuáles elegir", () => {
    const vague = propose({ question: 1, answer: "Clase II división 1" }, "clase dos molar derecha")
    expect(vague).toMatchObject({ status: "por_revisar", payload: { value: null } })
    expect(vague?.note).toContain("«Clase II división 1» y «Clase II división 2»")
    expect(propose({ question: 1, answer: "clase i" }, "clase uno molar derecha")).toMatchObject({ status: "lista", payload: { value: "Clase I" } })
    expect(propose({ question: 1, answer: "Clase IV" }, "clase cuatro")).toBeNull()
  })
  it("el número de una opción es solo un rótulo si se dijeron sus palabras y ninguna otra calza mejor", () => {
    const frankl = [question(1, { fieldId: "conducta", label: "Conducta (Frankl)", type: "opcion_unica", options: ["1 · Definitivamente negativa", "2 · Negativa", "3 · Positiva", "4 · Definitivamente positiva"] })]
    const check = (answer: string, said: string) => prepareFormAnswer({ payload: { question: 1, answer }, sourceText: said }, frankl, FDI)
    expect(check("1 · Definitivamente negativa", "conducta definitivamente negativa")).toMatchObject({ status: "lista" })
    expect(check("2 · Negativa", "conducta definitivamente negativa")).toMatchObject({ status: "por_revisar" })
    expect(check("3 · Positiva", "Frankl tres")).toMatchObject({ status: "lista" })
    // Con un número dicho que es de la lista, las palabras no bastan: «clase dos» no es «Clase I».
    expect(propose({ question: 1, answer: "Clase I" }, "clase dos molar derecha")).toMatchObject({ status: "por_revisar" })
  })
  it("la pieza tiene que existir y haberse dicho", () => {
    expect(propose({ question: 5, answer: "46" }, "en la cuarenta y seis")).toMatchObject({ status: "lista", payload: { value: 46 } })
    expect(propose({ question: 5, answer: "19" }, "la diecinueve")).toMatchObject({ status: "por_revisar" })
  })
  it("varias opciones: solo las que están en la lista", () => {
    expect(propose({ question: 6, answers: ["Onicofagia", "Bruxismo"] }, "hábitos: onicofagia")).toMatchObject({ status: "lista", payload: { value: ["Onicofagia"] } })
    // La opción exige su palabra o cómo se dice en la consulta: «se come las uñas» es «Onicofagia» (prueba con voz
    // del 15 nov; el 14 nov se había decidido que no). «las uñas» sola no.
    expect(propose({ question: 6, answers: ["Onicofagia"] }, "se come las uñas")).toMatchObject({ status: "lista", payload: { value: ["Onicofagia"] } })
    expect(propose({ question: 6, answers: ["Onicofagia"] }, "tiene las uñas cortas")).toBeNull()
  })
})

describe("lo que el servidor dejaba pasar (QA del 14 nov)", () => {
  const ORTHO = {
    sections: [
      {
        id: "o",
        title: "Oclusión",
        fields: [
          { id: "clase_molar_derecha", label: "Clase molar derecha (Angle)", type: "opcion_unica", options: ANGLE },
          { id: "clase_canina_derecha", label: "Clase canina derecha", type: "opcion_unica", options: ["Clase I", "Clase II", "Clase III"] },
          { id: "clase_canina_izquierda", label: "Clase canina izquierda", type: "opcion_unica", options: ["Clase I", "Clase II", "Clase III"] },
          { id: "mordida_cruzada", label: "Mordida cruzada", type: "opcion_multiple", options: ["No tiene", "Anterior", "Posterior derecha", "Posterior izquierda"] },
          { id: "apinamiento", label: "Apiñamiento", type: "opcion_unica", options: ["No", "Leve", "Moderado", "Severo"] },
          { id: "linea_media_superior", label: "Línea media superior", type: "opcion_unica", options: ["Centrada", "Desviada a la derecha", "Desviada a la izquierda"] },
          { id: "linea_media_inferior", label: "Línea media inferior", type: "opcion_unica", options: ["Centrada", "Desviada a la derecha", "Desviada a la izquierda"] },
        ],
      },
    ],
  }
  const ENDO = {
    sections: [
      {
        id: "e",
        title: "Pieza y pruebas",
        fields: [
          { id: "pieza", label: "Pieza", type: "pieza" },
          { id: "tumefaccion", label: "Tumefacción", type: "opcion_unica", options: ["No tiene", "Intraoral", "Extraoral"] },
          { id: "fistula", label: "Fístula (tracto sinusal)", type: "booleano" },
          { id: "movilidad", label: "Movilidad", type: "opcion_unica", options: ["Grado 0 (fisiológica)", "Grado 1", "Grado 2", "Grado 3"] },
          { id: "percusion", label: "Percusión", type: "opcion_unica", options: ["Negativa", "Positiva"] },
          { id: "palpacion", label: "Palpación", type: "opcion_unica", options: ["Negativa", "Positiva"] },
        ],
      },
    ],
  }
  const forms = formQuestionsOf([
    { id: "orto", title: "Ficha de ortodoncia", snapshot: ORTHO, answers: {} },
    { id: "endo", title: "Evaluación de endodoncia", snapshot: ENDO, answers: {} },
  ])
  const ask = (fieldId: string, answer: string | string[], said: string) => {
    const number = forms.find((item) => item.fieldId === fieldId)?.number
    const payload = Array.isArray(answer) ? { question: number, answers: answer } : { question: number, answer }
    return prepareFormAnswer({ payload, sourceText: said }, forms, FDI)
  }

  it("una opción sin número exige su palabra; «No», «No tiene» o «Negativa», una negación y la pregunta nombrada", () => {
    expect(ask("mordida_cruzada", ["Anterior"], "mordida abierta anterior")).toBeNull()
    expect(ask("palpacion", "Negativa", "percusión positiva")).toBeNull()
    expect(ask("apinamiento", "No", "buena higiene, sin caries")).toBeNull()
    expect(ask("tumefaccion", "No tiene", "dolor provocado al masticar")).toBeNull()
    expect(ask("apinamiento", "No", "no hay apiñamiento")).toMatchObject({ status: "lista", payload: { value: "No" } })
    expect(ask("tumefaccion", "No tiene", "sin tumefacción")).toMatchObject({ status: "lista", payload: { value: "No tiene" } })
    expect(ask("mordida_cruzada", ["Anterior"], "mordida cruzada anterior")).toMatchObject({ status: "lista", payload: { value: ["Anterior"] } })
  })
  it("la frase tiene que hablar de esa pregunta: el lado y superior o inferior", () => {
    expect(ask("clase_canina_izquierda", "Clase I", "clase canina derecha clase uno")).toBeNull()
    expect(ask("clase_canina_derecha", "Clase I", "clase canina derecha clase uno")).toMatchObject({ status: "lista" })
    expect(ask("linea_media_inferior", "Centrada", "línea media superior centrada")).toBeNull()
  })
  it("«un» y «una» no cuentan como 1 al elegir una opción", () => {
    expect(ask("clase_molar_derecha", "Clase II división 1", "una clase dos molar derecha")).not.toMatchObject({ status: "lista" })
    expect(ask("movilidad", "Grado 1", "un diente con movilidad grado dos")).not.toMatchObject({ status: "lista" })
  })
  it("un «Sí» con una negación queda por revisar; «sin embargo» no niega", () => {
    expect(ask("fistula", "Sí", "no hay fístula")).toMatchObject({ status: "por_revisar" })
    expect(ask("fistula", "Sí", "sin embargo hay fístula")).toMatchObject({ status: "lista", payload: { value: true } })
  })
  it("lo que no nombra la pregunta no se avisa como si fuera de la ficha", () => {
    const draft = { payload: { question: forms.find((item) => item.fieldId === "clase_molar_derecha")?.number, answer: "Clase II división 1" }, sourceText: "el diagnóstico es maloclusión clase dos división uno" }
    expect(prepareFormAnswer(draft, forms, FDI)).toBeNull()
    expect(formAnswerDropReason(draft, forms)).toBeNull()
  })

  it("«al menos dos» no es menos dos, y la pieza se dice dígito a dígito", () => {
    expect(saidNumbers("al menos dos")).toEqual([2])
    expect(saidNumbers("por lo menos dos")).toEqual([2])
    expect(saidNumbers("menos dos")).toEqual([-2])
    expect(ask("pieza", "46", "en la cuatro seis")).toMatchObject({ status: "lista", payload: { value: 46 } })
  })
})

describe("lo que la revisión final del 15 nov mostró", () => {
  // La ficha odontoestomatológica de odentIA, por el registro de productos (ADR 0079): tiene CPOD y ceod.
  const STOMATOLOGIC = productHooksFor("dental").forms.suggestions.find((item) => item.key === "ficha-odontoestomatologica")!.schema
  const ENDO: DictationFormQuestion[] = [
    question(1, { responseId: "endo", formTitle: "Evaluación de endodoncia", fieldId: "pieza", label: "Pieza", type: "pieza", answered: 36 }),
    question(2, { responseId: "endo", formTitle: "Evaluación de endodoncia", fieldId: "dolor", label: "Dolor", type: "opcion_unica", options: ["Sin dolor", "Provocado", "Espontáneo"] }),
    question(3, { responseId: "endo", formTitle: "Evaluación de endodoncia", fieldId: "movilidad", label: "Movilidad", type: "opcion_unica", options: ["Grado 1", "Grado 2"] }),
  ]
  it("lo escrito a mano no queda «lista»: lo que lo cambia queda por revisar, con su valor", () => {
    const written = QUESTIONS.map((item) => (item.fieldId === "overjet" ? { ...item, answered: 3 } : item))
    expect(prepareFormAnswer({ payload: { question: 2, answer: "1" }, sourceText: "overjet de un milímetro" }, written, FDI)).toEqual({
      payload: expect.objectContaining({ value: 1, replaces: 3 }),
      status: "por_revisar",
      note: "Ya dice «3 mm».",
    })
  })
  it("la ficha de la 36 no recibe lo dictado para la 46, y se dice por qué", () => {
    const transcript = "Pieza cuarenta y seis con dolor espontáneo. Movilidad grado dos."
    const pain = { payload: { question: 2, answer: "Espontáneo" }, sourceText: "dolor espontáneo" }
    expect(prepareFormAnswer(pain, ENDO, FDI, transcript)).toBeNull()
    expect(prepareFormAnswer({ payload: { question: 3, answer: "Grado 2" }, sourceText: "movilidad grado dos" }, ENDO, FDI, transcript)).toBeNull()
    expect(formAnswerDropReason(pain, ENDO, { site: FDI, transcript })).toBe(
      "«Evaluación de endodoncia» es de la 36 y dijiste la 46: no la llené. Escríbelo tú o empieza otra ficha para la 46.",
    )
    // Dicho de su pieza, o sin nombrar ninguna, sí se propone; «dolor de ocho» no es una pieza.
    expect(prepareFormAnswer(pain, ENDO, FDI, "En la treinta y seis, dolor espontáneo.")).toMatchObject({ status: "lista" })
    expect(prepareFormAnswer(pain, ENDO, FDI, "Dolor espontáneo, ocho de diez.")).toMatchObject({ status: "lista" })
    expect(prepareFormAnswer(pain, ENDO, FDI, "La cuatro seis con dolor espontáneo.")).toBeNull()
    // Sin pieza escrita en la ficha, la pieza dicha no frena nada.
    const open = ENDO.map((item) => (item.fieldId === "pieza" ? { ...item, answered: undefined } : item))
    expect(prepareFormAnswer(pain, open, FDI, transcript)).toMatchObject({ status: "lista" })
  })
  it("«cariados tres» sin decir de qué índice va a «No pude usar esto» con entre cuáles; «perdidos uno» se propone", () => {
    const forms = formQuestionsOf([{ id: "norma", title: "Ficha odontoestomatológica", snapshot: STOMATOLOGIC, answers: {} }])
    const ask = (fieldId: string, answer: string, said: string) => ({ payload: { question: forms.find((item) => item.fieldId === fieldId)?.number, answer }, sourceText: said })
    const transcript = "En la ficha, cariados tres, perdidos uno, obturados dos."
    expect(prepareFormAnswer(ask("cpod_c", "3", "cariados tres"), forms, FDI, transcript)).toBeNull()
    expect(formAnswerDropReason(ask("cpod_c", "3", "cariados tres"), forms)).toBe(
      "No quedó claro si era «CPOD · C, cariados» o «ceod · c, cariados»: nómbrala o escríbela en la ficha.",
    )
    expect(formAnswerDropReason(ask("cpod_o", "2", "obturados dos"), forms)).toContain("«CPOD · O, obturados» o «ceod · o, obturados»")
    expect(prepareFormAnswer(ask("cpod_p", "1", "perdidos uno"), forms, FDI, transcript)).toMatchObject({ status: "lista", payload: { value: 1 } })
  })
  it("lo usado se resalta por dato, no por frase", () => {
    const forms = formQuestionsOf([{ id: "norma", title: "Ficha odontoestomatológica", snapshot: STOMATOLOGIC, answers: {} }])
    const of = (fieldId: string) => forms.find((item) => item.fieldId === fieldId)
    expect(formAnswerFragments("cariados tres, perdidos uno, obturados dos", of("cpod_p"))).toEqual(["perdidos uno"])
    expect(formAnswerFragments("higiene oral regular", of("higiene"))).toEqual(["higiene oral regular"])
    expect(formAnswerFragments("perdidos uno y obturados dos", of("cpod_o"))).toEqual(["obturados dos"])
  })
})

describe("lo que la medición del 14 nov mostró que se perdía", () => {
  const EVAL = {
    sections: [
      {
        id: "e",
        title: "Dolor",
        fields: [
          { id: "dolor", label: "Dolor", type: "opcion_unica", options: ["Sin dolor", "Provocado", "Espontáneo"] },
          { id: "dolor_intensidad", label: "Intensidad del dolor", type: "escala", min: 0, max: 10 },
          { id: "cpod_c", label: "CPOD · C, cariados", type: "numero" },
          { id: "ceod_c", label: "ceod · c, cariados", type: "numero" },
          { id: "clase_molar_derecha", label: "Clase molar derecha (Angle)", type: "opcion_unica", options: ANGLE },
          { id: "clase_canina_derecha", label: "Clase canina derecha", type: "opcion_unica", options: ["Clase I", "Clase II", "Clase III"] },
        ],
      },
    ],
  }
  const forms = formQuestionsOf([{ id: "f", title: "Ficha", snapshot: EVAL, answers: {} }])
  const ask = (fieldId: string, answer: string, said: string, transcript?: string) =>
    prepareFormAnswer({ payload: { question: forms.find((item) => item.fieldId === fieldId)?.number, answer }, sourceText: said }, forms, FDI, transcript)

  it("«dolor espontáneo» no empata con «Sin dolor» si no se negó nada", () => {
    expect(ask("dolor", "Espontáneo", "dolor espontáneo")?.payload["value"]).toBe("Espontáneo")
    expect(ask("dolor", "Sin dolor", "sin dolor")?.payload["value"]).toBe("Sin dolor")
  })

  it("«intensidad ocho de diez» basta para «Intensidad del dolor»", () => {
    expect(ask("dolor_intensidad", "8", "intensidad ocho de diez")?.payload["value"]).toBe(8)
  })

  it("la oración dice de qué índice es la frase, sin mezclar otra oración", () => {
    expect(ask("cpod_c", "5", "cinco cariados", "CPOD: cinco cariados, dos perdidos.")?.payload["value"]).toBe(5)
    expect(ask("cpod_c", "5", "cinco cariados")).toBeNull()
    expect(ask("ceod_c", "5", "cinco cariados", "CPOD de diez. Ahora, cinco cariados.")).toBeNull()
  })

  it("la primera palabra con otra cosa detrás no es la pregunta; con su valor, sí", () => {
    const more = formQuestionsOf([
      {
        id: "g",
        title: "Ficha",
        snapshot: {
          sections: [
            {
              id: "g",
              title: "General",
              fields: [
                { id: "higiene", label: "Higiene oral", type: "opcion_unica", options: ["Buena", "Regular", "Mala"] },
                { id: "conducta", label: "Conducta (escala de Frankl)", type: "opcion_unica", options: ["1 · Definitivamente negativa", "2 · Negativa", "3 · Positiva", "4 · Definitivamente positiva"] },
                { id: "riesgo", label: "Riesgo estomatológico", type: "opcion_unica", options: ["Bajo", "Moderado", "Alto"] },
                { id: "sondaje", label: "Sondaje periodontal más profundo", type: "numero", unit: "mm" },
              ],
            },
          ],
        },
        answers: {},
      },
    ])
    const say = (fieldId: string, answer: string, said: string) =>
      prepareFormAnswer({ payload: { question: more.find((item) => item.fieldId === fieldId)?.number, answer }, sourceText: said }, more, FDI)?.payload["value"] ?? null
    expect(say("higiene", "Regular", "higiene regular")).toBe("Regular")
    expect(say("conducta", "3 · Positiva", "conducta positiva")).toBe("3 · Positiva")
    expect(say("sondaje", "4", "sondaje de cuatro milímetros")).toBe(4)
    expect(say("riesgo", "Alto", "riesgo de caries alto")).toBeNull()
  })

  it("la opción dicha distingue hermanas sin opciones en común; un sí o no se dice con su complemento", () => {
    const more = formQuestionsOf([
      {
        id: "h",
        title: "Ficha",
        snapshot: {
          sections: [
            {
              id: "h",
              title: "Diagnóstico",
              fields: [
                { id: "pulpar", label: "Diagnóstico pulpar", type: "opcion_unica", options: ["Pulpa normal", "Pulpitis irreversible sintomática"] },
                { id: "apical", label: "Diagnóstico apical", type: "opcion_unica", options: ["Tejidos apicales normales", "Periodontitis apical sintomática"] },
                { id: "vacunas", label: "Vacunas al día", type: "booleano" },
                { id: "linea_inferior", label: "Línea media inferior", type: "opcion_unica", options: ["Centrada", "Desviada a la izquierda"] },
                { id: "desviacion_inferior", label: "Desviación de la línea media inferior", type: "numero", unit: "mm" },
                { id: "desviacion_superior", label: "Desviación de la línea media superior", type: "numero", unit: "mm" },
              ],
            },
          ],
        },
        answers: {},
      },
    ])
    const say = (fieldId: string, answer: string, said: string) =>
      prepareFormAnswer({ payload: { question: more.find((item) => item.fieldId === fieldId)?.number, answer }, sourceText: said }, more, FDI)
    expect(say("pulpar", "Pulpitis irreversible sintomática", "pulpitis irreversible sintomática")?.payload["value"]).toBe("Pulpitis irreversible sintomática")
    expect(say("vacunas", "Sí", "vacunas completas")?.payload["value"]).toBe(true)
    expect(say("desviacion_inferior", "2", "la inferior desviada a la izquierda dos milímetros")?.payload["value"]).toBe(2)
    expect(say("desviacion_inferior", "2", "desviada unos dos milímetros a la izquierda, la inferior")).toMatchObject({ status: "por_revisar", payload: { value: null } })
  })

  it("el texto de la consulta pierde lo que fue para la ficha y las frases que solo corrigen", () => {
    const evolution = "Overjet de seis, perdón, de cuatro milímetros. Paciente refiere dolor al masticar. No, el overjet es de cuatro. Corrijo: overbite de dos."
    expect(withoutFormPhrases(evolution, ["Overjet de seis, perdón, de cuatro milímetros", "overbite de dos"])).toBe("Paciente refiere dolor al masticar.")
    expect(withoutFormPhrases("No es alérgico. Control en un mes.", [])).toBe("No es alérgico. Control en un mes.")
    // La oración que además dice otra cosa se queda: la evolución no pierde lo suyo.
    expect(withoutFormPhrases("Dolor espontáneo desde hace tres días en la cuarenta y seis.", ["dolor espontáneo"])).toBe("Dolor espontáneo desde hace tres días en la cuarenta y seis.")
  })

  it("un diagnóstico dicho que también pregunta una ficha se propone en ella", () => {
    const endo = formQuestionsOf([
      {
        id: "endo",
        title: "Evaluación de endodoncia",
        snapshot: {
          sections: [
            {
              id: "d",
              title: "Diagnóstico",
              fields: [
                { id: "pulpar", label: "Diagnóstico pulpar", type: "opcion_unica", options: ["Pulpitis irreversible sintomática", "Pulpitis irreversible asintomática"] },
                { id: "apical", label: "Diagnóstico apical", type: "opcion_unica", options: ["Periodontitis apical sintomática", "Periodontitis apical asintomática"] },
              ],
            },
          ],
        },
        answers: {},
      },
    ])
    const said = "pulpitis irreversible sintomática con periodontitis apical sintomática"
    const dictated: Array<{ kind: string; payload: Record<string, unknown>; sourceText: string }> = [{ kind: "diagnostico", payload: { diagnosisCode: "K04.0" }, sourceText: said }]
    const all = withDiagnosisFormAnswers(dictated, endo)
    expect(all.filter((draft) => draft.kind === "ficha").map((draft) => draft.payload["answer"])).toEqual(["Pulpitis irreversible sintomática", "Periodontitis apical sintomática"])
    const ready = all.filter((draft) => draft.kind === "ficha").map((draft) => prepareFormAnswer(draft, endo, FDI)?.payload["value"])
    expect(ready).toEqual(["Pulpitis irreversible sintomática", "Periodontitis apical sintomática"])
  })

  it("«la derecha en clase dos» no elige canina ni molar", () => {
    expect(ask("clase_canina_derecha", "Clase II", "la derecha en clase dos")).toBeNull()
    expect(ask("clase_canina_derecha", "Clase II", "canina derecha clase dos")?.payload["value"]).toBe("Clase II")
  })
})

describe("lo que la medición del 15 nov mostró que se perdía en silencio", () => {
  // Las fichas de odentIA por el registro de productos (ADR 0079), con su clave como id.
  const formsOf = (keys: string[], answers: Record<string, Record<string, unknown>> = {}) =>
    formQuestionsOf(
      keys.map((key) => {
        const form = productHooksFor("dental").forms.suggestions.find((item) => item.key === key)!
        return { id: key, title: form.title, snapshot: form.schema, answers: answers[key] ?? {} }
      }),
    )
  const endo = formsOf(["evaluacion-de-endodoncia"])
  const numberOf = (forms: DictationFormQuestion[], fieldId: string) => forms.find((item) => item.fieldId === fieldId)!.number
  const ask = (fieldId: string, answer: string, said: string) => prepareFormAnswer({ payload: { question: numberOf(endo, fieldId), answer }, sourceText: said }, endo, FDI, said)
  const net = (forms: DictationFormQuestion[], transcript: string, handled: string[] = []) =>
    formSentencesWithoutAnswer(transcript, forms, new Set(handled.map((fieldId) => numberOf(forms, fieldId))), FDI).map(({ said, why }) => ({ said, why }))

  it("«dolor a la percusión» y «dolor a la palpación» son «Positiva»; con una negación, no", () => {
    expect(ask("percusion", "Positiva", "Dolor a la percusión")).toMatchObject({ status: "lista", payload: { value: "Positiva" } })
    expect(ask("palpacion", "Positiva", "duele a la palpación en el fondo de vestíbulo")).toMatchObject({ status: "lista", payload: { value: "Positiva" } })
    expect(ask("palpacion", "Positiva", "dolor al palpar")).toMatchObject({ status: "lista", payload: { value: "Positiva" } })
    expect(ask("percusion", "Positiva", "no hay dolor a la percusión")).toBeNull()
    expect(ask("percusion", "Negativa", "sin dolor a la percusión")).toMatchObject({ status: "lista", payload: { value: "Negativa" } })
    // «ni» también niega: «sin dolor a la percusión ni a la palpación».
    expect(ask("palpacion", "Negativa", "ni a la palpación")).toMatchObject({ status: "lista", payload: { value: "Negativa" } })
    // El dolor a la percusión no dice nada de la palpación.
    expect(ask("palpacion", "Positiva", "dolor a la percusión")).toBeNull()
    // Ni de la pregunta «Dolor»: «sin dolor a la percusión» no es «Sin dolor» (lo inventaba en el caso nuevo).
    expect(ask("dolor", "Sin dolor", "Sin dolor a la percusión ni a la palpación")).toBeNull()
    expect(ask("dolor", "Sin dolor", "sin dolor")).toMatchObject({ status: "lista", payload: { value: "Sin dolor" } })
    // Tampoco si cita solo el pedazo «Sin dolor» de esa oración.
    const pain = { payload: { question: numberOf(endo, "dolor"), answer: "Sin dolor" }, sourceText: "Sin dolor" }
    expect(prepareFormAnswer(pain, endo, FDI, "Pieza cuarenta y seis. Sin dolor a la percusión ni a la palpación.")).toBeNull()
    expect(prepareFormAnswer(pain, endo, FDI, "Pieza cuarenta y seis. Sin dolor.")).toMatchObject({ status: "lista" })
  })

  it("la opción respondida con su número («4») es la que empieza con ese número, y se comprueba igual", () => {
    const kid = formsOf(["ficha-de-odontopediatria"])
    const frankl = (answer: string, said: string) => prepareFormAnswer({ payload: { question: numberOf(kid, "conducta"), answer }, sourceText: said }, kid, FDI, said)
    expect(frankl("4", "Frankl cuatro")).toMatchObject({ status: "lista", payload: { value: "4 · Definitivamente positiva" } })
    // El número tiene que estar dicho, como con la opción escrita entera.
    expect(frankl("4", "Frankl tres")).not.toMatchObject({ status: "lista" })
    // «Grado 1» no empieza con su número: «1» no la elige.
    expect(ask("movilidad", "1", "movilidad grado uno")).toBeNull()
  })

  it("la oración que nombra una pregunta sin propuesta ni aviso va a «No pude usar esto»", () => {
    const kid = formsOf(["ficha-de-odontopediatria", "ficha-de-ortodoncia"])
    expect(net(kid, "Frankl tres, colaboró bien. Overjet de tres.")).toEqual([
      { said: "Frankl tres, colaboró bien.", why: "Parece de «Conducta (escala de Frankl)»: revísala en la ficha." },
      { said: "Overjet de tres.", why: "Parece de «Overjet»: revísala en la ficha." },
    ])
    // Lo que ya quedó propuesto o avisado no se vuelve a avisar.
    expect(net(kid, "Frankl tres, colaboró bien. Overjet de tres.", ["overjet"])).toEqual([
      { said: "Frankl tres, colaboró bien.", why: "Parece de «Conducta (escala de Frankl)»: revísala en la ficha." },
    ])
    expect(net(kid, "Conducta definitivamente negativa, lloró toda la consulta.")).toEqual([
      { said: "Conducta definitivamente negativa, lloró toda la consulta.", why: "Parece de «Conducta (escala de Frankl)»: revísala en la ficha." },
    ])
    expect(net(endo, "Dolor a la percusión en la cuatro seis, ocho de diez.", ["dolor_intensidad"])).toEqual([
      { said: "Dolor a la percusión en la cuatro seis, ocho de diez.", why: "Parece de «Pieza» y «Percusión»: revísalas en la ficha." },
    ])
    expect(net(endo, "Control de la cuarenta y seis.")).toEqual([{ said: "Control de la cuarenta y seis.", why: "Parece de «Pieza»: revísala en la ficha." }])
  })

  it("sin falsos avisos: la oración que no nombra la pregunta, o no dice su valor, no avisa", () => {
    const ortho = formsOf(["ficha-de-ortodoncia"])
    expect(net(ortho, "El diagnóstico es maloclusión clase dos división uno.")).toEqual([])
    expect(net(ortho, "Buena higiene, sin caries. Seguimos con el arco de acero, control en un mes.")).toEqual([])
    // «dolor» sin su tipo no es la pregunta «Dolor», ni lo de la vez pasada un valor.
    expect(net(endo, "Refiere un dolor de quince sobre diez.", ["dolor_intensidad"])).toEqual([])
    expect(net(endo, "Percusión igual que la vez pasada.")).toEqual([])
    // El dolor a una prueba es de esa prueba, no de la pregunta «Dolor».
    expect(net(endo, "Sin dolor a la percusión ni a la palpación.", ["percusion", "palpacion"])).toEqual([])
    // Con las dos hermanas en la oración, el valor es de la parte que nombra a cada una: los dos
    // milímetros son de la inferior, no de la superior.
    expect(
      net(ortho, "Línea media superior centrada, la inferior desviada a la izquierda dos milímetros.", ["linea_media_superior", "linea_media_inferior", "linea_media_inferior_mm"]),
    ).toEqual([])
    expect(net(ortho, "Línea media superior desviada a la derecha, dos milímetros.", ["linea_media_superior"])).toEqual([
      { said: "Línea media superior desviada a la derecha, dos milímetros.", why: "Parece de «Desviación de la línea media superior»: revísala en la ficha." },
    ])
    // «conductometría» empieza como «conducta», pero no es la conducta del niño.
    expect(net(formsOf(["ficha-de-odontopediatria"]), "Hicimos la conductometría de la cincuenta y cinco.")).toEqual([])
    // Lo que repite lo ya escrito no se avisa; lo que dice otro valor, sí.
    const written = formsOf(["ficha-de-ortodoncia"], { "ficha-de-ortodoncia": { overjet: 6 } })
    expect(net(written, "Overjet de seis.")).toEqual([])
    expect(net(written, "Overjet de cinco.")).toEqual([{ said: "Overjet de cinco.", why: "Parece de «Overjet»: revísala en la ficha." }])
  })
})

describe("lo que la prueba con voz mostró (15 nov): lo que oye Chrome, sin puntuación ni comas", () => {
  const formsOf = (key: string) => {
    const form = productHooksFor("dental").forms.suggestions.find((item) => item.key === key)!
    return formQuestionsOf([{ id: key, title: form.title, snapshot: form.schema, answers: {} }])
  }
  const kid = formsOf("ficha-de-odontopediatria")
  const endo = formsOf("evaluacion-de-endodoncia")
  const ortho = formsOf("ficha-de-ortodoncia")
  const at = (forms: DictationFormQuestion[], fieldId: string) => forms.find((item) => item.fieldId === fieldId)!.number
  const ask = (forms: DictationFormQuestion[], fieldId: string, answer: string | string[], said: string, transcript = said) =>
    prepareFormAnswer({ payload: Array.isArray(answer) ? { question: at(forms, fieldId), answers: answer } : { question: at(forms, fieldId), answer }, sourceText: said }, forms, FDI, transcript)

  it("las muletillas no cortan la relación con la pregunta", () => {
    expect(ask(endo, "dolor_intensidad", "6", "intensidad digamos 6 de 10")).toMatchObject({ status: "lista", payload: { value: 6 } })
    expect(ask(endo, "dolor_intensidad", "6", "intensidad eh a ver 6 de 10")).toMatchObject({ status: "lista", payload: { value: 6 } })
  })
  it("«se come las uñas» es onicofagia", () => {
    expect(ask(ortho, "habitos", ["Respiración bucal", "Onicofagia"], "hábitos respiración bucal o sea duerme con la boca abierta y se come las uñas")).toMatchObject({
      status: "lista",
      payload: { value: ["Respiración bucal", "Onicofagia"] },
    })
  })
  it("«15 kg y medio» es 15,5 y «medio milímetro», 0,5", () => {
    expect(saidNumbers("peso 15 kg y medio")).toEqual([15.5])
    expect(saidNumbers("desviada a la derecha eh medio milímetro")).toEqual([0.5])
    expect(saidNumbers("un milímetro y medio")).toEqual([1.5])
    expect(ask(kid, "peso", "15.5", "peso 15 kg y medio")).toMatchObject({ status: "lista", payload: { value: 15.5 } })
  })
  it("en una corrección vale el número que va después del «no» o del «perdón»", () => {
    expect(ask(kid, "peso", "24", "la niña pesa 24 kg no 22 perdón")).toMatchObject({ status: "lista", payload: { value: 22 } })
    expect(ask(ortho, "overjet", "4", "overjat de 6 no perdón de 4 mm")).toMatchObject({ status: "lista", payload: { value: 4 } })
    expect(ask(endo, "dolor_intensidad", "8", "intensidad 8 de 10 no cede con nada")).toMatchObject({ status: "lista", payload: { value: 8 } })
  })
  it("cada número va con el término que tiene al lado, en el orden en que se dijo", () => {
    const heard = "beso 18 kg me duele descarriados uno con extracción indicada dos obturados no quiero mamá"
    expect(ask(kid, "ceod_e", "2", "con extracción indicada dos", heard)).toMatchObject({ status: "lista", payload: { value: 1 } })
    expect(ask(kid, "ceod_o", "2", "dos obturados", heard)).toMatchObject({ status: "lista", payload: { value: 2 } })
    const after = "cariados 4 obturados uno extracción indicada 0 te duele cuando muerdes"
    expect(ask(kid, "ceod_c", "4", "cariados 4", after)).toMatchObject({ status: "lista", payload: { value: 4 } })
    expect(ask(kid, "ceod_o", "1", "obturados uno", after)).toMatchObject({ status: "lista", payload: { value: 1 } })
    expect(ask(kid, "ceod_e", "0", "extracción indicada 0", after)).toMatchObject({ status: "lista", payload: { value: 0 } })
  })
  it("la red sin comas: el medio milímetro es de la línea media inferior, no de la superior", () => {
    const heard = "caninos el derecho clase 2 El izquierdo clase 1 línea Media Superior centrada la inferior desviada a la derecha eh medio milímetro"
    const handled = new Set(["clase_canina_derecha", "clase_canina_izquierda", "linea_media_superior", "linea_media_inferior"].map((fieldId) => at(ortho, fieldId)))
    expect(formSentencesWithoutAnswer(heard, ortho, handled, FDI).map((item) => item.why)).toEqual(["Parece de «Desviación de la línea media inferior»: revísala en la ficha."])
  })
  it("la nota no repite con otras palabras lo que fue para la ficha, ni lo que se le preguntó al paciente", () => {
    const heard = "caninos el derecho clase 2 El izquierdo clase 1 te duele cuando comes cuando mastico"
    const drafts = [
      { kind: "ficha", payload: { question: at(ortho, "clase_canina_derecha"), answer: "Clase II" }, sourceText: "caninos el derecho clase 2" },
      { kind: "ficha", payload: { question: at(ortho, "clase_canina_izquierda"), answer: "Clase I" }, sourceText: "El izquierdo clase 1" },
      { kind: "nota", payload: { evolution: "Canino derecho clase 2, canino izquierdo clase 1; se cementó el bracket.", presentIllness: "Se le soltó un bracket. ¿Te duele cuando comes? Cuando mastico." }, sourceText: "" },
    ]
    const note = withoutFormNotes(drafts, ortho, FDI, heard).find((draft) => draft.kind === "nota")
    expect(note?.payload).toEqual({ evolution: "se cementó el bracket.", presentIllness: "Se le soltó un bracket. Cuando mastico." })
  })
})

setupTestDb()
const ORG = "org_a"

const ORTHO_SCHEMA = {
  sections: [
    {
      id: "oclusion",
      title: "Oclusión",
      fields: [
        { id: "clase_molar_derecha", label: "Clase molar derecha (Angle)", type: "opcion_unica", options: ANGLE },
        { id: "overjet", label: "Overjet", type: "numero", unit: "mm", min: -10, max: 20 },
        { id: "overbite", label: "Overbite", type: "numero", unit: "mm", min: -10, max: 15 },
        { id: "dolor", label: "¿Presenta dolor?", type: "booleano" },
        { id: "intensidad", label: "Intensidad", type: "escala", min: 0, max: 10, showIf: { field: "dolor", equals: true } },
        { id: "observaciones", label: "Observaciones", type: "texto_largo" },
      ],
    },
  ],
}

/** Una atención con Clío encendida y la ficha de ortodoncia ya empezada. */
async function startedForm(answers: Record<string, unknown> = {}) {
  const fx = await clinicalFixture()
  await withOrgContext(appDb, ORG, (tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: true }))
  const [template] = await ownerDb
    .insert(clinicalFormTemplate)
    .values({ organizationId: ORG, key: `orto-${fx.actor}`, title: "Ficha de ortodoncia", status: "publicado", schema: ORTHO_SCHEMA })
    .returning()
  const [form] = await ownerDb
    .insert(clinicalFormResponse)
    .values({
      organizationId: ORG,
      templateId: template!.id,
      templateVersion: 1,
      templateTitle: "Ficha de ortodoncia",
      templateSnapshot: ORTHO_SCHEMA,
      patientId: fx.patient.id,
      encounterId: fx.encounter.id,
      professionalUserId: fx.actor,
      authorUserId: fx.actor,
      status: "borrador",
      source: "staff",
      answers,
    })
    .returning()
  const questions = () => fx.run((tx) => dictationFormQuestions(tx, ORG, fx.encounter.id))
  /** Como la ruta: con las preguntas que vio Clío (leídas antes de ordenar, salvo que se den). */
  const save = async (drafts: Array<{ payload: Record<string, unknown>; sourceText: string }>, seen?: DictationFormQuestion[]) => {
    const formQuestions = seen ?? (await questions())
    return fx.run((tx) =>
      saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { drafts: drafts.map((draft) => ({ kind: "ficha" as const, ...draft })), formQuestions }),
    )
  }
  const answersNow = async () =>
    ((await ownerDb.select().from(clinicalFormResponse).where(eq(clinicalFormResponse.id, form!.id)))[0]?.answers ?? {}) as Record<string, unknown>
  return { fx, form: form!, save, questions, answersNow }
}

describe("la ficha empezada recibe lo que propone Clío (base)", () => {
  it("Clío ve las preguntas que puede comprobar, las respondidas con lo que dicen; sin ficha empezada, ninguna", async () => {
    const { questions, fx } = await startedForm({ overbite: 4 })
    const list = await questions()
    expect(list.map((item) => item.fieldId)).toEqual(["clase_molar_derecha", "overjet", "overbite", "dolor", "intensidad"])
    expect(list.find((item) => item.fieldId === "overbite")?.answered).toBe(4)
    expect(list.find((item) => item.fieldId === "overjet")).not.toHaveProperty("answered")
    expect(list.find((item) => item.fieldId === "intensidad")?.dependsOn).toMatchObject({ fieldId: "dolor", equals: true })
    await ownerDb.update(clinicalFormResponse).set({ status: "finalizado", finalizedAt: new Date() }).where(eq(clinicalFormResponse.encounterId, fx.encounter.id))
    expect(await questions()).toEqual([])
  })

  it("aceptar escribe en la ficha con quién y cuándo; la ficha lo dice mientras siga siendo eso", async () => {
    const { save, fx, form, answersNow } = await startedForm()
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis milímetros" }])
    expect(saved.suggestions).toHaveLength(1)
    expect(await answersNow()).not.toHaveProperty("overjet", 6)
    const confirmed = await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, saved.suggestions[0]!.id))
    expect(confirmed.status).toBe("confirmada")
    expect(await answersNow()).toMatchObject({ overjet: 6 })
    const listed = await fx.run((tx) => listFormResponses(tx, ORG, { patientId: fx.patient.id }))
    expect(listed.find((row) => row.id === form.id)?.clioAccepted["overjet"]?.by).toBe(fx.actor)
    // Cambiada a mano, ya es de la persona: la marca se va.
    await ownerDb.update(clinicalFormResponse).set({ answers: { ...(await answersNow()), overjet: 7 } }).where(eq(clinicalFormResponse.id, form.id))
    const after = await fx.run((tx) => listFormResponses(tx, ORG, { patientId: fx.patient.id }))
    expect(after.find((row) => row.id === form.id)?.clioAccepted).toEqual({})
  })

  it("lo que escribió la persona gana: la propuesta se descarta y se dice por qué", async () => {
    const { save, fx, form, answersNow } = await startedForm()
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }])
    await ownerDb.update(clinicalFormResponse).set({ answers: { overjet: 5 } }).where(eq(clinicalFormResponse.id, form.id))
    const result = await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, saved.suggestions[0]!.id))
    expect(result.status).toBe("descartada")
    expect(result.note).toBe("Clío proponía «6 mm»; quedó «5 mm», que ya estaba escrito.")
    expect(await answersNow()).toMatchObject({ overjet: 5 })
  })

  it("respondida a mano mientras Clío ordenaba, no se propone, y el número no se corre a otra pregunta", async () => {
    const { save, form, questions } = await startedForm()
    const seen = await questions()
    await ownerDb.update(clinicalFormResponse).set({ answers: { overjet: 5 } }).where(eq(clinicalFormResponse.id, form.id))
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }], seen)
    expect(saved.suggestions).toEqual([])
  })

  it("sin las preguntas que vio Clío no se propone nada", async () => {
    const { fx } = await startedForm()
    const saved = await fx.run((tx) =>
      saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { drafts: [{ kind: "ficha", payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }] }),
    )
    expect(saved.suggestions).toEqual([])
  })

  it("la que depende de otra no acepta esa otra por su cuenta: se confirman en el orden de la ficha", async () => {
    const { save, fx, answersNow } = await startedForm()
    const saved = await save([
      { payload: { question: 4, answer: "Sí" }, sourceText: "presenta dolor" },
      { payload: { question: 5, answer: "8" }, sourceText: "intensidad ocho de diez" },
    ])
    const pain = saved.suggestions.find((item) => item.payload["fieldId"] === "dolor")!
    const intensity = saved.suggestions.find((item) => item.payload["fieldId"] === "intensidad")!
    // Desmarcada «¿Presenta dolor?» al firmar, la intensidad sola no la acepta.
    await expect(fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, intensity.id))).rejects.toMatchObject({
      code: "FORM_ANSWER_DEPENDS",
    })
    expect(await answersNow()).toEqual({})
    await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, pain.id))
    await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, intensity.id))
    expect(await answersNow()).toMatchObject({ dolor: true, intensidad: 8 })
  })

  it("respondida la otra de forma que la oculta, la propuesta se descarta con el motivo, sin error", async () => {
    const { save, fx, form, answersNow } = await startedForm()
    const saved = await save([{ payload: { question: 5, answer: "8" }, sourceText: "intensidad ocho de diez" }])
    await ownerDb.update(clinicalFormResponse).set({ answers: { dolor: false } }).where(eq(clinicalFormResponse.id, form.id))
    const result = await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, saved.suggestions[0]!.id))
    expect(result.status).toBe("descartada")
    expect(result.note).toBe("«¿Presenta dolor?» quedó en «No»: esta pregunta ya no va.")
    expect(await answersNow()).toEqual({ dolor: false })
  })

  it("confirma lo que se veía: si una pausa la cambió, avisa y no escribe", async () => {
    const { save, fx, answersNow } = await startedForm()
    const first = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }])
    await save([{ payload: { question: 2, answer: "9" }, sourceText: "no, overjet de nueve" }])
    await expect(
      fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, first.suggestions[0]!.id, { expectedValue: 6 })),
    ).rejects.toMatchObject({ code: "SUGGESTION_CHANGED" })
    expect(await answersNow()).toEqual({})
    await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, first.suggestions[0]!.id, { expectedValue: 9 }))
    expect(await answersNow()).toMatchObject({ overjet: 9 })
  })

  it("dos respuestas a la misma pregunta en una pausa: vale la última", async () => {
    const { save } = await startedForm()
    const saved = await save([
      { payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" },
      { payload: { question: 2, answer: "9" }, sourceText: "perdón, overjet de nueve" },
    ])
    expect(saved.suggestions).toHaveLength(1)
    expect(saved.suggestions[0]).toMatchObject({ payload: { value: 9 }, sourceText: "perdón, overjet de nueve" })
  })

  it("corregida por voz, la propuesta muestra la frase nueva", async () => {
    const { save, fx, questions } = await startedForm()
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }])
    const id = saved.suggestions[0]!.id
    const formQuestions = await questions()
    await fx.run((tx) =>
      saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, {
        drafts: [],
        corrections: [{ suggestionId: id, changes: { answer: "7" }, said: "no, el overjet es de siete" }],
        formQuestions,
      }),
    )
    const pending = await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))
    expect(pending.find((item) => item.id === id)).toMatchObject({ payload: { value: 7 }, sourceText: "no, el overjet es de siete" })
  })

  it("sobre una ya respondida, lo que la cambia queda por revisar, dice lo que ya dice y se cambia de a una; lo mismo no se propone", async () => {
    const { save, fx, answersNow } = await startedForm({ clase_molar_derecha: "Clase II división 2" })
    const same = await save([{ payload: { question: 1, answer: "Clase II división 2" }, sourceText: "clase molar derecha clase dos división dos" }])
    expect(same.suggestions).toEqual([])
    // Lo que repite lo ya escrito no es algo que no se pudo usar: no se avisa.
    expect(same.droppedForms).toEqual([])
    const changed = await save([{ payload: { question: 1, answer: "Clase II división 1" }, sourceText: "corrijo, clase molar derecha clase dos división uno" }])
    expect(changed.suggestions).toHaveLength(1)
    // Lo escrito a mano lo cambia una persona: nunca «lista» (revisión final del 15 nov, dev H5).
    expect(changed.suggestions[0]).toMatchObject({
      status: "por_revisar",
      payload: { value: "Clase II división 1", replaces: "Clase II división 2" },
      note: "Ya dice «Clase II división 2».",
    })
    expect(await answersNow()).toEqual({ clase_molar_derecha: "Clase II división 2" })
    await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, changed.suggestions[0]!.id, { expectedValue: "Clase II división 1" }))
    expect(await answersNow()).toMatchObject({ clase_molar_derecha: "Clase II división 1" })
  })

  it("la corrección de lo escrito no pisa lo que alguien cambió después", async () => {
    const { save, fx, form, answersNow } = await startedForm({ clase_molar_derecha: "Clase II división 2" })
    const changed = await save([{ payload: { question: 1, answer: "Clase II división 1" }, sourceText: "corrijo, clase molar derecha clase dos división uno" }])
    await ownerDb.update(clinicalFormResponse).set({ answers: { clase_molar_derecha: "Clase III" } }).where(eq(clinicalFormResponse.id, form.id))
    const result = await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, changed.suggestions[0]!.id))
    expect(result.status).toBe("descartada")
    expect(await answersNow()).toEqual({ clase_molar_derecha: "Clase III" })
  })

  it("lo que entra al firmar queda dicho en la ficha: «confirmó al firmar»", async () => {
    const { save, fx, form } = await startedForm()
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }])
    await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, saved.suggestions[0]!.id, { expectedValue: 6, atSign: true }))
    const listed = await fx.run((tx) => listFormResponses(tx, ORG, { patientId: fx.patient.id }))
    expect(listed.find((row) => row.id === form.id)?.clioAccepted["overjet"]).toMatchObject({ by: fx.actor, atSign: true })
    // La Historia y la copia lo dicen en su pregunta, mientras siga siendo eso (finalizada, es registro).
    await ownerDb.update(clinicalFormResponse).set({ status: "finalizado", finalizedAt: new Date() }).where(eq(clinicalFormResponse.id, form.id))
    const [record] = await fx.run((tx) => loadFormRecords(tx, ORG, fx.patient.id, { ids: [form.id] }))
    const overjet = record?.sections.flatMap((section) => section.items).find((item) => item.id === "overjet")
    expect(overjet?.clio).toMatch(/^Clío · confirmó al firmar .+ el /)
    expect(record?.sections.flatMap((section) => section.items).find((item) => item.id === "overbite")?.clio).toBeNull()
  })

  it("la respuesta que cambia lo escrito no entra sola: se confirma de a una, solo esa", async () => {
    const { save, fx, answersNow } = await startedForm({ overjet: 3 })
    const saved = await save([
      { payload: { question: 2, answer: "1" }, sourceText: "overjet de un milímetro" },
      { payload: { question: 3, answer: "2" }, sourceText: "overbite de dos" },
    ])
    const byField = (field: string) => saved.suggestions.find((item) => item.payload["fieldId"] === field)!
    expect(byField("overjet")).toMatchObject({ status: "por_revisar", payload: { value: 1, replaces: 3 } })
    expect(byField("overbite")).toMatchObject({ status: "lista" })
    expect(saved.formSources).toEqual(["overjet de un milímetro", "overbite de dos"])
    await fx.run((tx) => confirmDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, byField("overjet").id, { expectedValue: 1 }))
    expect(await answersNow()).toMatchObject({ overjet: 1 })
  })

  it("lo dicho para la ficha que no queda como propuesta vuelve con su motivo", async () => {
    const { save } = await startedForm()
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis centímetros" }])
    expect(saved.suggestions).toEqual([])
    expect(saved.droppedForms).toEqual([{ said: "overjet de seis centímetros", why: "«Overjet» va en mm: dilo en mm o escríbelo en la ficha." }])
  })

  it("lo dicho para la ficha no se pierde en silencio: sin propuesta ni aviso, la oración vuelve con la pregunta", async () => {
    const { fx, questions } = await startedForm()
    const formQuestions = await questions()
    const transcript = "Overjet de seis. El diagnóstico es maloclusión clase dos división uno. Overbite de dos."
    // El modelo respondió el overjet sin una frase que se encuentre en lo dictado, y no respondió el overbite.
    const saved = await fx.run((tx) =>
      saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, {
        drafts: [{ kind: "ficha", payload: { question: 2, answer: "6" }, sourceText: "" }],
        transcript,
        formQuestions,
      }),
    )
    expect(saved.suggestions).toEqual([])
    // El diagnóstico no nombra la clase molar: no se avisa como si fuera de ella.
    expect(saved.droppedForms).toEqual([
      { said: "Overjet de seis.", why: "Parece de «Overjet»: revísala en la ficha." },
      { said: "Overbite de dos.", why: "Parece de «Overbite»: revísala en la ficha." },
    ])
  })

  it("lo que ya propone una pendiente no se avisa otra vez; otro valor dicho sin corregirla, sí", async () => {
    const { fx, questions } = await startedForm()
    const formQuestions = await questions()
    const pause = (transcript: string, drafts: Array<{ kind: "ficha"; payload: Record<string, unknown>; sourceText: string }> = []) =>
      fx.run((tx) => saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { drafts, transcript, formQuestions }))
    const first = await pause("Overjet de seis.", [{ kind: "ficha", payload: { question: 2, answer: "6" }, sourceText: "Overjet de seis" }])
    expect(first.suggestions).toHaveLength(1)
    expect(first.droppedForms).toEqual([])
    expect((await pause("Como te decía, overjet de seis.")).droppedForms).toEqual([])
    expect((await pause("Overjet de cuatro.")).droppedForms).toEqual([{ said: "Overjet de cuatro.", why: "Parece de «Overjet»: revísala en la ficha." }])
  })

  it("con la ficha empezada, la nota no repite lo que fue para la ficha", async () => {
    const { fx, questions } = await startedForm()
    const formQuestions = await questions()
    const saved = await fx.run((tx) =>
      saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, {
        drafts: [
          { kind: "ficha", payload: { question: 2, answer: "4" }, sourceText: "Overjet de seis, perdón, de cuatro milímetros" },
          { kind: "nota", payload: { evolution: "Overjet de seis, perdón, de cuatro milímetros. Paciente refiere dolor al masticar. No, el overjet es de cuatro." }, sourceText: "dolor al masticar" },
        ],
        formQuestions,
      }),
    )
    const note = saved.suggestions.find((item) => item.kind === "nota")
    expect(note?.payload["evolution"]).toBe("Paciente refiere dolor al masticar.")
    // La frase de la ficha que abarca otra oración: esa otra sigue en la nota.
    const wide = await fx.run((tx) =>
      saveDictationSegment(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, {
        drafts: [
          { kind: "ficha", payload: { question: 3, answer: "2" }, sourceText: "No, el overbite es de dos. Se cementan brackets en la arcada superior." },
          { kind: "nota", payload: { evolution: "No, el overbite es de dos. Se cementan brackets en la arcada superior." }, sourceText: "brackets" },
        ],
        formQuestions,
      }),
    )
    expect(wide.suggestions.find((item) => item.kind === "nota")?.payload["evolution"]).toBe("Se cementan brackets en la arcada superior.")
  })

  it("la ficha abierta en pantalla se lee siempre, además de las dos últimas tocadas", async () => {
    const { fx, form, questions } = await startedForm()
    // Después de la primera por su hora, no por el reloj de la base.
    const more = async (title: string, after: number) =>
      (
        await ownerDb
          .insert(clinicalFormResponse)
          .values({ ...form, id: undefined, templateTitle: title, answers: {}, createdAt: new Date(form.createdAt.getTime() + after), updatedAt: new Date(Date.now() + after) })
          .returning()
      )[0]!
    await ownerDb.update(clinicalFormResponse).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(clinicalFormResponse.id, form.id))
    await more("Segunda", 1000)
    await more("Tercera", 2000)
    const titles = (list: DictationFormQuestion[]) => [...new Set(list.map((item) => item.formTitle))]
    expect(titles(await questions())).toEqual(["Segunda", "Tercera"])
    const open = await fx.run((tx) => dictationFormQuestions(tx, ORG, fx.encounter.id, { open: [form.id] }))
    expect(titles(open)).toEqual(["Ficha de ortodoncia", "Segunda", "Tercera"])
  })

  it("un dato que preguntan dos fichas empezadas se propone en las dos", async () => {
    const { form, save } = await startedForm()
    await ownerDb
      .insert(clinicalFormResponse)
      .values({ ...form, id: undefined, templateTitle: "Control de ortodoncia", answers: {}, createdAt: new Date(form.createdAt.getTime() + 1000) })
    const saved = await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis milímetros" }])
    expect(saved.suggestions.map((item) => [item.payload["formTitle"], item.payload["value"]])).toEqual([
      ["Ficha de ortodoncia", 6],
      ["Control de ortodoncia", 6],
    ])
  })

  it("la × de la ficha se deshace: la propuesta vuelve como estaba; lo descartado por otra vía, no", async () => {
    const { save, fx } = await startedForm()
    const saved = await save([
      { payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" },
      { payload: { question: 1, answer: "Clase II división 1" }, sourceText: "clase molar derecha clase dos" },
    ])
    const [overjet, molar] = [saved.suggestions.find((item) => item.payload["fieldId"] === "overjet")!, saved.suggestions.find((item) => item.payload["fieldId"] === "clase_molar_derecha")!]
    await fx.run((tx) => discardDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, overjet.id))
    const back = await fx.run((tx) => restoreDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, overjet.id))
    expect(back).toMatchObject({ status: "lista", payload: { value: 6 } })
    // Otro toque de «Deshacer»: queda como está.
    expect(await fx.run((tx) => restoreDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, overjet.id))).toMatchObject({ status: "lista" })
    // Descartada al firmar o al anular (sin la ×): no se deshace desde aquí.
    await ownerDb.update(encounterDictationSuggestion).set({ status: "descartada" }).where(eq(encounterDictationSuggestion.id, molar.id))
    await expect(fx.run((tx) => restoreDictationSuggestion(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, molar.id))).rejects.toMatchObject({ code: "SUGGESTION_DECIDED" })
  })

  it("anular la atención descarta lo que Clío proponía", async () => {
    const { save, fx } = await startedForm()
    await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }])
    await fx.run((tx) => voidEncounter(tx, ORG, fx.actor, fx.patient.id, fx.encounter.id, { reason: "Paciente equivocado" }))
    const rows = await ownerDb.select().from(encounterDictationSuggestion).where(eq(encounterDictationSuggestion.encounterId, fx.encounter.id))
    expect(rows.map((row) => [row.status, row.note])).toEqual([["descartada", "Atención anulada: Paciente equivocado"]])
  })

  it("lo último que dijo para la misma pregunta cambia la propuesta, no la repite", async () => {
    const { save, fx } = await startedForm()
    await save([{ payload: { question: 2, answer: "6" }, sourceText: "overjet de seis" }])
    const again = await save([{ payload: { question: 2, answer: "7" }, sourceText: "no, overjet de siete" }])
    expect(again.corrected).toHaveLength(1)
    const pending = await fx.run((tx) => listDictationSuggestions(tx, ORG, fx.patient.id, fx.encounter.id))
    const forms = pending.filter((item) => item.kind === "ficha")
    expect(forms).toHaveLength(1)
    expect(forms[0]?.payload["value"]).toBe(7)
    const rows = await ownerDb
      .select({ id: encounterDictationSuggestion.id })
      .from(encounterDictationSuggestion)
      .where(and(eq(encounterDictationSuggestion.encounterId, fx.encounter.id), eq(encounterDictationSuggestion.kind, "ficha")))
    expect(rows).toHaveLength(1)
  })
})
