import { describe, expect, it } from "vitest"
import {
  type DictationFormQuestion,
  formDropNotices,
  formNetMisses,
  formQuestionsOf,
  formSentencesWithoutAnswer,
  prepareFormAnswer,
  withoutFormNotes,
} from "./dictation-forms.js"
import { asHeard, formVocabulary, groundHeard, heardVocabulary, phoneticKey } from "./dictation-heard.js"
import type { ProductSite } from "./product-hooks.js"
import { productHooksFor } from "./products.js"

/**
 * Lo que el reconocimiento de voz de Chrome oyó mal en la prueba con voz del
 * 15 nov («over byte», «sé o d», «volar derecha», «francol», «p o D») cuenta
 * como el término de la ficha; lo que cambia el sentido, nunca.
 */

const FDI: ProductSite = {
  code: (value: unknown) => (typeof value === "number" && /^[1-4][1-8]$|^[5-8][1-5]$/.test(String(value)) ? String(value) : null),
  invalid: (value: unknown) => `${String(value)} no es una pieza`,
} as unknown as ProductSite

const formsOf = (key: string): DictationFormQuestion[] => {
  const form = productHooksFor("dental").forms.suggestions.find((item) => item.key === key)
  if (!form) throw new Error(key)
  return formQuestionsOf([{ id: key, title: form.title, snapshot: form.schema, answers: {} }])
}
const ortho = formsOf("ficha-de-ortodoncia")
const kid = formsOf("ficha-de-odontopediatria")
const adult = formsOf("ficha-odontoestomatologica")
const at = (forms: DictationFormQuestion[], fieldId: string) => forms.find((item) => item.fieldId === fieldId)?.number ?? 0
const ask = (forms: DictationFormQuestion[], fieldId: string, answer: string, said: string, transcript = said) =>
  prepareFormAnswer({ payload: { question: at(forms, fieldId), answer }, sourceText: said }, forms, FDI, transcript)

describe("cómo suena una palabra", () => {
  it("sin tildes, b y v, s, c y z, ll e y, y sin la h muda", () => {
    expect(phoneticKey("overbite")).toBe(phoneticKey("overvite"))
    expect(phoneticKey("ceod")).toBe(phoneticKey("seod"))
    expect(phoneticKey("zona")).toBe(phoneticKey("sona"))
    expect(phoneticKey("llanto")).toBe(phoneticKey("yanto"))
    expect(phoneticKey("hábitos")).toBe(phoneticKey("abitos"))
    expect(phoneticKey("fístula")).toBe(phoneticKey("fistula"))
    // La ch no es una h muda.
    expect(phoneticKey("chupa")).not.toBe(phoneticKey("cupa"))
  })
  it("lo que suena distinto sigue siendo distinto", () => {
    expect(phoneticKey("perdidos")).not.toBe(phoneticKey("cariados"))
    expect(phoneticKey("obturados")).not.toBe(phoneticKey("cariados"))
    expect(phoneticKey("cpod")).not.toBe(phoneticKey("ceod"))
    expect(phoneticKey("canina")).not.toBe(phoneticKey("molar"))
  })
})

describe("lo dictado se lee con los términos de la ficha", () => {
  const vocabulary = formVocabulary([...ortho, ...kid, ...adult])
  it("las siglas con espacios, la palabra en inglés partida y las formas revisadas", () => {
    expect(asHeard("sé o d cinco cariados", vocabulary)).toBe("ceod cinco cariados")
    expect(asHeard("c e o d tres", vocabulary)).toBe("ceod tres")
    expect(asHeard("c p o d tres", vocabulary)).toBe("cpod tres")
    expect(asHeard("p o D cariados 3", vocabulary)).toBe("cpod cariados 3")
    expect(asHeard("over byte de 4", vocabulary)).toBe("overbite de 4")
    expect(asHeard("overjat de 6 no perdón de 4 mm", vocabulary)).toBe("overjet de 6 no perdón de 4 mm")
    expect(asHeard("volar derecha clase 2", vocabulary)).toBe("molar derecha clase 2")
    expect(asHeard("conducta francol 4", vocabulary)).toBe("conducta frankl 4")
    expect(asHeard("llora no deja trabajar Franco 2", vocabulary)).toBe("llora no deja trabajar frankl 2")
  })
  it("nunca lo que cambia el sentido: otro término, otro índice o un número", () => {
    expect(asHeard("perdidos uno obturados dos", vocabulary)).toBe("perdidos uno obturados dos")
    expect(asHeard("clase canina derecha clase 2", vocabulary)).toBe("clase canina derecha clase 2")
    expect(asHeard("ceod cinco", vocabulary)).toBe("ceod cinco")
    // «descarriados» era «tres cariados»: el número se lo comió el reconocimiento. Leerlo como
    // «cariados» le daría el número del término siguiente (prueba con voz del 15 nov, v08).
    expect(asHeard("descarriados uno con extracción indicada", vocabulary)).toBe("descarriados uno con extracción indicada")
    expect(asHeard("ser obturados", vocabulary)).toBe("ser obturados")
  })
  it("una forma revisada solo vale si la ficha tiene ese término", () => {
    const endo = heardVocabulary(formsOf("evaluacion-de-endodoncia").map((item) => item.label))
    expect(asHeard("volar derecha", endo)).toBe("volar derecha")
    expect(asHeard("Franco 2", heardVocabulary(["Overjet"]))).toBe("Franco 2")
  })
  it("la frase que Clío entendió se encuentra en lo dictado, tal como se oyó", () => {
    const heard = "Claro que sí volar derecha clase 2 división 1 la izquierda también clase dos división 1"
    expect(groundHeard("molar derecha clase 2 división 1", heard, vocabulary)).toBe("volar derecha clase 2 división 1")
    expect(groundHeard("CPOD cariados 3", "muy buenos días p o D cariados 3 perdidos uno", vocabulary)).toBe("p o D cariados 3")
    // Lo que no se dijo no aparece, ni con otro número.
    expect(groundHeard("molar derecha clase 3", heard, vocabulary)).toBe("")
    expect(groundHeard("cariados uno", "descarriados uno con extracción indicada", vocabulary)).toBe("")
  })
})

describe("la comprobación del servidor lee lo mal oído", () => {
  it("«volar derecha» es la clase molar derecha; la canina no", () => {
    const heard = "al examen Claro que sí volar derecha clase 2 división 1 la izquierda también clase dos división 1 clase canina derecha clase 2"
    expect(ask(ortho, "clase_molar_derecha", "Clase II división 1", "derecha clase 2 división 1", heard)).toMatchObject({ status: "lista", payload: { value: "Clase II división 1" } })
    expect(ask(ortho, "clase_molar_izquierda", "Clase II división 1", "la izquierda también clase dos división 1", heard)).toMatchObject({ status: "lista" })
    expect(ask(ortho, "clase_canina_derecha", "Clase II", "clase canina derecha clase 2", heard)).toMatchObject({ status: "lista", payload: { value: "Clase II" } })
  })
  it("«sé o d» y «p o D» dicen de qué índice son los cariados", () => {
    expect(ask(adult, "ceod_c", "5", "sé o d cinco cariados")).toMatchObject({ status: "lista", payload: { value: 5 } })
    expect(ask(adult, "cpod_c", "5", "sé o d cinco cariados")).toBeNull()
    const heard = "muy buenos días p o D cariados 3 perdidos uno obturados a ver 8 no 7 por favor"
    expect(ask(adult, "cpod_c", "3", "cariados 3", heard)).toMatchObject({ status: "lista", payload: { value: 3 } })
    expect(ask(adult, "cpod_o", "8", "obturados a ver 8 no 7", heard)).toMatchObject({ status: "lista", payload: { value: 7 } })
    expect(ask(adult, "ceod_c", "3", "cariados 3", heard)).toBeNull()
  })
  it("leído el término, la corrección dicha después sigue valiendo («de 6 no perdón de 4»)", () => {
    const heard = "Okay este seguimos con la ficha overjat de 6 no perdón de 4 mm Pásame el espejo por favor abre un poquito más ya así over byte de Point de tres molar derecha clase 2 división 1"
    expect(ask(ortho, "overjet", "6", "overjat de 6", heard)).toMatchObject({ status: "lista", payload: { value: 4 } })
    expect(ask(ortho, "overjet", "4", "overjat de 6 no perdón de 4 mm", heard)).toMatchObject({ status: "lista", payload: { value: 4 } })
    expect(ask(adult, "cpod_o", "8", "obturados a ver 8 no 7", "p o D cariados 3 perdidos uno obturados a ver 8 no 7 por favor")).toMatchObject({ payload: { value: 7 } })
  })
  it("el número de otro término no es de la pregunta cuyo término no se oyó", () => {
    // «descarriados» era «tres cariados»: el «uno» es de la extracción, no de los cariados (base del 15 nov: 3 de 3).
    const heard = "beso 18 kg me duele descarriados uno con extracción indicada dos obturados no quiero mamá"
    expect(ask(kid, "ceod_c", "1", "descarriados uno", heard)).toBeNull()
    expect(ask(kid, "ceod_e", "1", "uno con extracción indicada", heard)).toMatchObject({ status: "lista", payload: { value: 1 } })
    // Sin otro término al lado, el número dicho sigue valiendo («déjame medir 7 mm» del overjet).
    expect(ask(ortho, "overjet", "7", "7 mm", "a ver déjame medir 7 mm over byte de 4 succión por favor")).toMatchObject({ status: "lista", payload: { value: 7 } })
    expect(ask(kid, "ceod_c", "4", "cariados 4", "cariados 4 obturados uno")).toMatchObject({ status: "lista", payload: { value: 4 } })
  })
  it("lo que se muestra como «dijiste» sigue siendo lo dictado", () => {
    // «Clase dos» sin la división, dicho de la molar: elige tú, con lo que de verdad se oyó.
    expect(ask(ortho, "clase_molar_derecha", "Clase II división 1", "volar derecha clase dos")).toMatchObject({
      status: "por_revisar",
      note: expect.stringContaining("«volar derecha clase dos»"),
    })
  })
  it("«perdidos» no es «cariados»: no se propone en otra pregunta", () => {
    expect(ask(adult, "cpod_c", "2", "CPOD perdidos dos")).toBeNull()
    expect(ask(adult, "ceod_o", "2", "dos perdidos")).toBeNull()
    expect(ask(adult, "cpod_c", "2", "p o D perdidos dos")).toBeNull()
  })
  it("la red avisa lo mal oído que nombra una pregunta, con su pregunta", () => {
    expect(formSentencesWithoutAnswer("llora no deja trabajar Franco 2", kid, new Set(), FDI)).toEqual([
      { said: "llora no deja trabajar Franco 2", why: "Parece de «Conducta (escala de Frankl)»: revísala en la ficha.", questions: [at(kid, "conducta")] },
    ])
    expect(formSentencesWithoutAnswer("over byte de 4", ortho, new Set(), FDI).map((item) => item.questions)).toEqual([[at(ortho, "overbite")]])
  })
  it("la nota pierde lo de la ficha aunque se haya oído mal", () => {
    const drafts = [
      { kind: "ficha", payload: { question: at(ortho, "clase_molar_derecha"), answer: "Clase II división 1" }, sourceText: "volar derecha clase 2 división 1" },
      { kind: "nota", payload: { evolution: "volar derecha clase 2 división 1" }, sourceText: "volar derecha clase 2 división 1" },
    ]
    expect(withoutFormNotes(drafts, ortho, FDI, "volar derecha clase 2 división 1").filter((draft) => draft.kind === "nota")).toEqual([])
  })
})

describe("la segunda lectura de una oración", () => {
  const percussion = formsOf("evaluacion-de-endodoncia")
  const number = at(percussion, "percusion")
  it("lo que calza queda por revisar, con su valor; lo que no, no se propone", () => {
    const reread = { payload: { question: number, answer: "Positiva" }, sourceText: "dolor a la percusión", reread: true }
    expect(prepareFormAnswer(reread, percussion, FDI, "ya dolor a la percusión abre un poquito más")).toMatchObject({
      status: "por_revisar",
      payload: { value: "Positiva", reread: true },
    })
    expect(prepareFormAnswer({ ...reread, payload: { question: number, answer: "Negativa" } }, percussion, FDI, "dolor a la percusión")).toBeNull()
  })
  it("una sola opción en la lista de varias es la respuesta de una pregunta de una opción", () => {
    // Medición del 15 nov: la segunda lectura respondió «Positiva» en `answers`.
    const said = "Dolor a la palpación en el fondo de vestíbulo de la treinta y seis."
    const palpation = at(percussion, "palpacion")
    expect(prepareFormAnswer({ payload: { question: palpation, answers: ["Positiva"] }, sourceText: said }, percussion, FDI, said)).toMatchObject({ status: "lista", payload: { value: "Positiva" } })
    // Dos opciones en una pregunta de una no se eligen.
    expect(prepareFormAnswer({ payload: { question: palpation, answers: ["Positiva", "Negativa"] }, sourceText: said }, percussion, FDI, said)).toBeNull()
  })
  it("si no calza, la red sigue avisando la oración: no cambia el aviso por otro", () => {
    const transcript = "dolor a la percusión"
    const draft = { kind: "ficha", payload: { question: number, answer: "Negativa" }, sourceText: "dolor a la percusión", reread: true }
    const notices = formDropNotices([{ draft, ready: false }], new Set(), percussion, { site: FDI, transcript })
    expect(notices).toEqual([{ said: "dolor a la percusión", why: "Parece de «Percusión»: revísala en la ficha.", questions: [number], by: "red" }])
  })
  it("las oraciones que se leen de nuevo son las de la red, sin las ya propuestas", () => {
    const transcript = "dolor a la percusión. Palpación negativa."
    const palpation = { kind: "ficha", payload: { question: at(percussion, "palpacion"), answer: "Negativa" }, sourceText: "Palpación negativa." }
    expect(formNetMisses([palpation], percussion, FDI, transcript)).toEqual([{ said: "dolor a la percusión.", questions: [number] }])
    expect(formNetMisses([], percussion, FDI, "")).toEqual([])
  })
})

describe("cada aviso dice de qué pregunta es", () => {
  it("lo que no alcanzó, y las dos hermanas cuando no quedó claro cuál", () => {
    const peso = { kind: "ficha", payload: { question: at(kid, "peso"), answer: "15" }, sourceText: "peso 15 libras" }
    expect(formDropNotices([{ draft: peso, ready: false }], new Set(), kid, { site: FDI, transcript: "peso 15 libras" })[0]?.questions).toEqual([at(kid, "peso")])
    const caries = { kind: "ficha", payload: { question: at(adult, "cpod_c"), answer: "3" }, sourceText: "cariados tres" }
    expect(formDropNotices([{ draft: caries, ready: false }], new Set(), adult, { site: FDI, transcript: "cariados tres" })[0]?.questions).toEqual([at(adult, "cpod_c"), at(adult, "ceod_c")])
  })
})
