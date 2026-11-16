import { describe, expect, it } from "vitest"
// Por el índice, que carga primero los productos (ver `index.ts`).
import "./index.js"
import { type DictationFormQuestion, formDropNotices, formNetMisses, formQuestionsOf, prepareFormAnswer } from "../dictation-forms.js"
import { productHooksFor } from "../products.js"

/**
 * Lo que encontró la séptima prueba con voz del 16 nov (corrida c7, sobre 6a4a5f38), tal como lo oyó
 * Chrome, con lo que respondió Clío al repetir cada tramo con el modelo real.
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

const V03 =
  "Sí señor este paciente que viene a su control de ortodoncia va en el primer año de tratamiento prefiere que hace como una semana Se le soltó un bracket de abajo y está maltratando el carrillo te duele cuando Comes por favor cuando mastico al examen Claro que sí volar derecha clase 2 división 1 la izquierda también clase dos división 1 clase canina derecha clase 2 izquierda clase dos Sí señora a ver déjame medir 7 mm over byte de 4 succión por favor mordida Cruzada no tiene hábitos respiración bucal o sea duerme con la boca abierta y se come las uñas diagnóstico mala oclusión clase 2 división 1 con protrusión de incisivos superiores hoy reglamentamos el bracket de la 4-2 no de la 41 y cambiamos el arco"

describe("el número dicho antes de nombrar otra pregunta es de la suya (v03)", () => {
  const ortho = formOf("ficha-de-ortodoncia")

  it("«7 mm over byte de 4» propone el overjet 7 por revisar, con la frase del 7", () => {
    // Clío citó la frase hasta el overbite; el 7 no es del overbite, que es 4.
    expect(prepareFormAnswer(answer(ortho, "overjet", "7", "7 mm over byte de 4"), ortho, FDI, V03)).toMatchObject({
      status: "por_revisar",
      payload: { value: 7 },
      said: "7 mm over",
      note: "Dijiste «7 mm over» sin nombrar «Overjet»: revísala.",
    })
  })

  it("el número de la otra no es de esta, y lo que empieza por la otra tampoco", () => {
    expect(prepareFormAnswer(answer(ortho, "overjet", "4", "7 mm over byte de 4"), ortho, FDI, V03)).toBeNull()
    expect(prepareFormAnswer(answer(ortho, "overjet", "4", "over byte de 4"), ortho, FDI, V03)).toBeNull()
    // «Overbite de tres, no, perdón, de dos y medio» no responde el overjet (medición del 15 nov, orto-21).
    expect(prepareFormAnswer(answer(ortho, "overjet", "2.5", "Overbite de tres, no, perdón, de dos y medio"), ortho, FDI, "Overbite de tres, no, perdón, de dos y medio")).toBeNull()
  })

  it("las opciones citadas en pedazos con «...» se comprueban cada una en el suyo: la onicofagia no se pierde", () => {
    const draft = { ...answer(ortho, "habitos", "", "hábitos respiración bucal"), payload: { question: numberOf(ortho, "habitos"), answers: ["Respiración bucal", "Onicofagia"] } }
    // Solo con el pedazo más largo, la onicofagia no se dijo ahí.
    expect(prepareFormAnswer(draft, ortho, FDI, V03)).toMatchObject({ status: "lista", payload: { value: ["Respiración bucal"] } })
    expect(prepareFormAnswer({ ...draft, pieces: ["hábitos respiración bucal", "y se come las uñas"] }, ortho, FDI, V03)).toMatchObject({
      status: "lista",
      payload: { value: ["Respiración bucal", "Onicofagia"] },
      said: "hábitos respiración bucal … y se come las uñas",
    })
    // Lo que ningún pedazo dice no entra.
    const invented = { ...draft, payload: { ...draft.payload, answers: ["Respiración bucal", "Succión digital"] }, pieces: ["hábitos respiración bucal", "y se come las uñas"] }
    expect(prepareFormAnswer(invented, ortho, FDI, V03)?.payload["value"]).toEqual(["Respiración bucal"])
  })

  it("«Ninguno» no queda junto a un hallazgo que sí se dijo (v06, al repetir el tramo)", () => {
    const endo = formOf("evaluacion-de-endodoncia")
    const said = "En la radiografía se ve ensanchamiento del ligamento periodontal sin radio lucidez"
    const draft = { kind: "ficha", payload: { question: numberOf(endo, "hallazgo_radiografico"), answers: ["Ensanchamiento del ligamento periodontal", "Ninguno"] }, sourceText: said }
    expect(prepareFormAnswer(draft, endo, FDI, `sondaje 2 mm ${said} diagnóstico pulpar`)).toMatchObject({ status: "lista", payload: { value: ["Ensanchamiento del ligamento periodontal"] } })
  })

  it("no se pierde en silencio: queda propuesto con el overbite", () => {
    const drafts = [answer(ortho, "overjet", "7", "7 mm over byte de 4"), answer(ortho, "overbite", "4", "over byte de 4")]
    expect(drafts.map((draft) => prepareFormAnswer(draft, ortho, FDI, V03)?.status)).toEqual(["por_revisar", "lista"])
    expect(noticesOf(drafts, ortho, V03).some((notice) => notice.questions.includes(numberOf(ortho, "overjet")))).toBe(false)
  })
})

describe("la pregunta de número nombrada sin un número no se pierde en silencio (v10)", () => {
  const pedia = formOf("ficha-de-odontopediatria")
  const ceodO = numberOf(pedia, "ceod_o")
  // Chrome oyó «ser» por «cero»: el número no se puede saber, pero «obturados» se dijo.
  const V10 = "niño de 4 años primera consulta la mamá refiere que le duelen las muelitas cuando come dulces peso 15 kg y medio sé o d cinco cariados dos con extracción indicada ser obturados"
  const rest = [answer(pedia, "peso", "15.5", "peso 15 kg y medio"), answer(pedia, "ceod_c", "5", "cinco cariados"), answer(pedia, "ceod_e", "2", "dos con extracción indicada")]
  const expected = { said: "ser obturados", why: "No alcanzó para responder «o, obturados»: dilo con el valor o escríbelo en la ficha.", questions: [ceodO] }

  it("Clío lo respondió con otra frase («sé o d»): se avisa con lo que la oración dice de ella", () => {
    const wrong = answer(pedia, "ceod_o", "0", "sé o d")
    expect(prepareFormAnswer(wrong, pedia, FDI, V10)).toBeNull()
    expect(noticesOf([...rest, wrong], pedia, V10)).toContainEqual(expect.objectContaining(expected))
  })

  it("Clío no lo respondió: también se avisa, sin pagar otra lectura", () => {
    expect(noticesOf(rest, pedia, V10)).toContainEqual(expect.objectContaining(expected))
    expect(formNetMisses(rest, pedia, FDI, V10)).toEqual([])
  })

  it("con su número, o ya propuesta en otra pausa, no se avisa", () => {
    const said = "cinco cariados dos con extracción indicada cero obturados"
    const all = [answer(pedia, "ceod_c", "5", "cinco cariados"), answer(pedia, "ceod_e", "2", "dos con extracción indicada"), answer(pedia, "ceod_o", "0", "cero obturados")]
    expect(noticesOf(all, pedia, said)).toEqual([])
    const notices = formDropNotices(
      rest.map((draft) => ({ draft, ready: prepareFormAnswer(draft, pedia, FDI, V10) !== null })),
      new Set(),
      pedia,
      { site: FDI, transcript: V10 },
      new Map<number, unknown>([[ceodO, 0]]),
    )
    expect(notices.some((notice) => notice.questions.includes(ceodO))).toBe(false)
  })

  it("«sondaje no lo pude medir bien» se avisa aunque Clío no lo proponga (v07)", () => {
    const endo = formOf("evaluacion-de-endodoncia")
    const said = "sondaje no lo pude medir bien después lo vemos radiográficamente radio lucidez periapical necrosis pulpar con absceso apical crónico"
    expect(noticesOf([], endo, said)).toContainEqual(expect.objectContaining({ said: "sondaje no lo pude medir bien", questions: [numberOf(endo, "sondaje")] }))
    // Lo de antes que es de otra pregunta no va en la frase (el tramo como lo cortó la pausa en c6).
    const c6 = `sin respuesta también percusión negativa palpación positiva ${said}`
    const tests = [answer(endo, "percusion", "Negativa", "percusión negativa"), answer(endo, "palpacion", "Positiva", "palpación positiva")]
    expect(noticesOf(tests, endo, c6)).toContainEqual(expect.objectContaining({ said: "sondaje no lo pude medir bien", questions: [numberOf(endo, "sondaje")] }))
    // Lo que no es de número no avisa por nombrarse solo: «percusión igual que la vez pasada».
    expect(noticesOf([], endo, "percusión igual que la vez pasada")).toEqual([])
    // «periodontitis» es de una opción del diagnóstico apical, no el «Sondaje periodontal» (banco, endo-6).
    expect(noticesOf([], endo, "con periodontitis apical sintomática.")).toEqual([])
  })
})
