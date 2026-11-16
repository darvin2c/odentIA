import { describe, expect, it } from "vitest"
// Por el índice, que carga primero los productos (ver `index.ts`).
import "./index.js"
import { type DictationFormQuestion, formDropNotices, formNetMisses, formQuestionsOf, prepareFormAnswer } from "../dictation-forms.js"
import { productHooksFor } from "../products.js"

/**
 * Lo que encontró la sexta prueba con voz del 16 nov (corrida c6, sobre 97e8ea87), tal como lo oyó
 * Chrome: la red no avisaba «18 kg» cuando Clío no respondía la ficha (v08, Chrome oyó «beso» por
 * «peso») ni «2 obturados» cuando la frase no dice si es del CPOD o del ceod (v11).
 */

const dental = productHooksFor("dental")
const formOf = (key: string): DictationFormQuestion[] => {
  const form = dental.forms.suggestions.find((item) => item.key === key)
  if (!form) throw new Error(key)
  return formQuestionsOf([{ id: key, title: form.title, snapshot: form.schema, answers: {} }])
}
const numberOf = (questions: DictationFormQuestion[], fieldId: string) => questions.find((item) => item.fieldId === fieldId)?.number ?? 0
const answer = (questions: DictationFormQuestion[], fieldId: string, value: string, said: string) => ({ kind: "ficha", payload: { question: numberOf(questions, fieldId), answer: value }, sourceText: said })
const FDI = dental.site
/** Lo que vería el profesional en «No pude usar esto», con lo que Clío propuso y la comprobación del servidor. */
const noticesOf = (drafts: ReturnType<typeof answer>[], questions: DictationFormQuestion[], transcript: string) =>
  formDropNotices(
    drafts.map((draft) => ({ draft, ready: prepareFormAnswer(draft, questions, FDI, transcript) !== null })),
    new Set(),
    questions,
    { site: FDI, transcript },
  )

describe("la red avisa el número que nombra su pregunta por la unidad (v08)", () => {
  const pedia = formOf("ficha-de-odontopediatria")
  const peso = numberOf(pedia, "peso")
  const V08 =
    "buah ya mi amor Tranquila ya casi terminamos beso 18 kg me duele descarriados uno con extracción indicada dos obturados no quiero mamá mamá como un león eso bua higiene oral regular tiene placa en los molares"

  it("sin respuesta de Clío, «18 kg» se lee otra vez como el peso: el kg es solo del peso", () => {
    expect(formNetMisses([], pedia, FDI, V08).some((miss) => miss.questions.includes(peso))).toBe(true)
  })

  it("con lo demás respondido, «18 kg» no se pierde en silencio", () => {
    const drafts = [answer(pedia, "ceod_e", "1", "uno con extracción indicada"), answer(pedia, "ceod_o", "2", "dos obturados"), answer(pedia, "higiene", "Regular", "higiene oral regular")]
    expect(noticesOf(drafts, pedia, V08).some((notice) => notice.questions.includes(peso))).toBe(true)
  })

  it("respondido, no se avisa; y sin número, la unidad sola no nombra nada", () => {
    expect(noticesOf([answer(pedia, "peso", "18", "18 kg")], pedia, V08).some((notice) => notice.questions.includes(peso))).toBe(false)
    expect(formNetMisses([], pedia, FDI, "unos kilos de más").some((miss) => miss.questions.includes(peso))).toBe(false)
  })

  it("la unidad que tienen dos preguntas de la ficha no nombra ninguna", () => {
    const ortho = formOf("ficha-de-ortodoncia")
    // overjet, overbite y la desviación de la línea media van en mm.
    expect(formNetMisses([], ortho, FDI, "déjame ver 3 mm").length).toBe(0)
  })
})

describe("la red avisa lo dicho entre dos hermanas sin decir cuál (v11)", () => {
  const estomato = formOf("ficha-odontoestomatologica")
  const V11 = "para confirmarse 6 perdidos 2 obturados 4 simplificado 1,8"
  const cpodO = numberOf(estomato, "cpod_o")
  const ceodO = numberOf(estomato, "ceod_o")

  it("«2 obturados» sin CPOD ni ceod: se avisa entre las dos, aunque Clío no lo proponga", () => {
    const drafts = [answer(estomato, "cpod_p", "2", "perdidos 2"), answer(estomato, "ihos", "1.8", "obturados 4 simplificado 1,8")]
    const notice = noticesOf(drafts, estomato, V11).find((item) => item.questions.includes(cpodO))
    expect(notice?.questions).toEqual(expect.arrayContaining([cpodO, ceodO]))
    // El mismo aviso que si Clío lo hubiera propuesto sin decir cuál.
    expect(notice?.why).toBe("No quedó claro si era «CPOD · O, obturados» o «ceod · o, obturados»: nómbrala o escríbela en la ficha.")
    expect(formNetMisses(drafts, estomato, FDI, V11).some((miss) => miss.questions.includes(cpodO) && miss.questions.includes(ceodO))).toBe(true)
  })

  it("si Clío ya respondió una de las dos, la otra no se avisa", () => {
    const drafts = [answer(estomato, "cpod_o", "4", "CPOD obturados 4")]
    expect(noticesOf(drafts, estomato, "CPOD obturados 4").some((notice) => notice.questions.includes(ceodO))).toBe(false)
  })

  it("lo que dice cuál de las dos no avisa a la otra", () => {
    const molar = formOf("ficha-de-ortodoncia")
    const derecha = answer(molar, "clase_molar_derecha", "Clase II división 1", "molar derecha clase 2 división 1")
    const izquierda = numberOf(molar, "clase_molar_izquierda")
    expect(noticesOf([derecha], molar, "molar derecha clase 2 división 1").some((notice) => notice.questions.includes(izquierda))).toBe(false)
  })
})
