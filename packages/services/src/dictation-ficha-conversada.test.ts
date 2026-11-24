import { describe, expect, it } from "vitest"
import { type DictationFormQuestion, formDropNotices, formNetMisses, formQuestionsOf, prepareFormAnswer, withFormTwins } from "./dictation-forms.js"
import { productHooksFor } from "./products.js"

/**
 * La ficha abierta en una consulta conversada (mesa del 20 nov 2026, P6; QA C3 y caso C9): con la
 * «Evaluación de endodoncia» empezada, Clío solo propuso la pieza. La percusión y el frío se perdieron
 * en silencio, la frase de la radiografía se avisó en «Sondaje periodontal más profundo» y la del
 * diagnóstico solo en el apical. Lo que no se dijo sigue sin responderse.
 */

const site = productHooksFor("dental").site
const endo: DictationFormQuestion[] = (() => {
  const form = productHooksFor("dental").forms.suggestions.find((item) => item.key === "evaluacion-de-endodoncia")
  if (!form) throw new Error("falta la ficha de endodoncia")
  return formQuestionsOf([{ id: "endo", title: form.title, snapshot: form.schema, answers: {} }])
})()
const numberOf = (fieldId: string) => endo.find((item) => item.fieldId === fieldId)?.number ?? 0
const answer = (fieldId: string, value: string | string[], dicho: string, reread?: true) => ({
  kind: "ficha" as const,
  payload: { question: numberOf(fieldId), ...(Array.isArray(value) ? { answers: value } : { answer: value }) },
  sourceText: dicho,
  ...(reread ? { reread } : {}),
})
const check = (draft: ReturnType<typeof answer>, transcript: string) => {
  const ready = prepareFormAnswer(draft, endo, site, transcript)
  return ready ? { status: ready.status, value: ready.payload["value"] } : null
}
/** «No pude usar esto», como al guardar la pausa: la frase y las preguntas de su «Usar en…». */
const notices = (drafts: ReadonlyArray<ReturnType<typeof answer>>, transcript: string) => {
  const { drafts: expanded, twins } = withFormTwins(drafts, endo)
  const outcomes = expanded.map((draft) => ({ draft, ready: prepareFormAnswer(draft, endo, site, transcript) !== null }))
  return formDropNotices(outcomes, twins, endo, { site, transcript }).map((item) => ({ said: item.said, questions: item.questions.map((number) => endo.find((question) => question.number === number)?.fieldId) }))
}

/** Lo que se dijo en la QA del 20 nov, tal cual (una sola pausa, escrita). */
const QA =
  "Hola Lucía, cuénteme qué le pasa. Doctora, me duele mucho la muela de arriba a la izquierda, la 26, ya hace dos semanas, y anoche no pude dormir del dolor, me duele solo, sin tocar nada. Vamos a ver. Le golpeo suave la muela y le duele bastante a la percusión. Con el frío le dura el dolor más de un minuto. En la radiografía veo una caries profunda que llega a la pulpa y una lesión pequeña en el ápice de la raíz. Diagnóstico: pulpitis irreversible con periodontitis apical. Necesita endodoncia de la 26."

describe("la consulta conversada de la QA (C3): Clío solo propuso la pieza", () => {
  const tooth = answer("pieza", "26", "la 26")

  it("la red lleva cada oración a su pregunta, y la segunda lectura recibe esas", () => {
    const misses = formNetMisses([tooth], endo, site, QA).map((miss) => ({ said: miss.said, questions: miss.questions.map((number) => endo.find((question) => question.number === number)?.fieldId) }))
    expect(misses).toEqual([
      { said: expect.stringContaining("me duele solo, sin tocar nada"), questions: ["dolor"] },
      // Antes se perdían en silencio: «duele bastante a la percusión» y «le dura el dolor más de un minuto».
      { said: "Le golpeo suave la muela y le duele bastante a la percusión.", questions: ["percusion"] },
      { said: "Con el frío le dura el dolor más de un minuto.", questions: ["frio"] },
      // Antes: «Sondaje periodontal más profundo» por la caries profunda y «una lesión».
      { said: "En la radiografía veo una caries profunda que llega a la pulpa y una lesión pequeña en el ápice de la raíz.", questions: ["hallazgo_radiografico"] },
      // Antes solo el apical: «pulpitis irreversible» es del pulpar.
      { said: "Diagnóstico: pulpitis irreversible con periodontitis apical.", questions: ["diagnostico_pulpar", "diagnostico_apical"] },
    ])
  })

  it("lo que la segunda lectura responde con lo dicho queda por revisar; lo que no se dijo, no", () => {
    expect(check(answer("percusion", "Positiva", "le duele bastante a la percusión", true), QA)).toEqual({ status: "por_revisar", value: "Positiva" })
    expect(check(answer("frio", "Aumentada, persiste", "Con el frío le dura el dolor más de un minuto", true), QA)).toEqual({ status: "por_revisar", value: "Aumentada, persiste" })
    expect(check(answer("dolor", "Espontáneo", "me duele solo, sin tocar nada", true), QA)).toEqual({ status: "por_revisar", value: "Espontáneo" })
    // «Una lesión en el ápice» no dice radiolucidez, ni «pulpitis irreversible» si es sintomática.
    expect(check(answer("hallazgo_radiografico", ["Radiolucidez periapical"], "una lesión pequeña en el ápice de la raíz", true), QA)).toBeNull()
    expect(check(answer("diagnostico_pulpar", "Pulpitis irreversible sintomática", "pulpitis irreversible", true), QA)).toBeNull()
  })

  it("si Clío los responde de entrada, la percusión y el frío quedan listos y nada va a otra pregunta", () => {
    const drafts = [
      tooth,
      answer("percusion", "Positiva", "le duele bastante a la percusión"),
      answer("frio", "Aumentada, persiste", "Con el frío le dura el dolor más de un minuto"),
      answer("diagnostico_pulpar", "Pulpitis irreversible sintomática", "pulpitis irreversible"),
    ]
    expect(drafts.map((draft) => check(draft, QA))).toEqual([
      { status: "lista", value: 26 },
      { status: "lista", value: "Positiva" },
      { status: "lista", value: "Aumentada, persiste" },
      // Sin decir si es sintomática: «¿Cuál?», lo elige el profesional.
      { status: "por_revisar", value: null },
    ])
    expect(notices(drafts, QA).flatMap((item) => item.questions)).not.toContain("sondaje")
  })
})

/** El caso C9 del acta, conversado: pregunta, respuesta y el examen dicho. */
const C9 =
  "¿Le duele si golpeo? Sí, ahí. Percusión positiva. El frío le dura bastante, más de un minuto. En la radiografía hay una zona radiolúcida apical. Pulpitis irreversible sintomática."

describe("el caso C9 conversado", () => {
  it("lo dicho queda listo en su pregunta", () => {
    expect(check(answer("percusion", "Positiva", "Percusión positiva"), C9)).toEqual({ status: "lista", value: "Positiva" })
    expect(check(answer("frio", "Aumentada, persiste", "El frío le dura bastante, más de un minuto"), C9)).toEqual({ status: "lista", value: "Aumentada, persiste" })
    expect(check(answer("hallazgo_radiografico", ["Radiolucidez periapical"], "En la radiografía hay una zona radiolúcida apical"), C9)).toEqual({ status: "lista", value: ["Radiolucidez periapical"] })
    expect(check(answer("diagnostico_pulpar", "Pulpitis irreversible sintomática", "Pulpitis irreversible sintomática"), C9)).toEqual({ status: "lista", value: "Pulpitis irreversible sintomática" })
  })

  it("si Clío no responde nada, ninguna oración del examen se pierde en silencio", () => {
    const misses = formNetMisses([], endo, site, C9).flatMap((miss) => miss.questions.map((number) => endo.find((question) => question.number === number)?.fieldId))
    expect(misses).toEqual(["percusion", "frio", "hallazgo_radiografico", "diagnostico_pulpar"])
  })

  it("lo que no se dijo no se responde: la pregunta no es la respuesta, y lo pasajero no persiste", () => {
    // «¿Le duele si golpeo?» no dice la percusión; «Sí, ahí» tampoco la nombra.
    expect(check(answer("percusion", "Positiva", "¿Le duele si golpeo? Sí, ahí."), C9)).toBeNull()
    expect(check(answer("frio", "Aumentada, persiste", "con el frío le dura un segundo y se le pasa"), "Con el frío le dura un segundo y se le pasa.")).toBeNull()
    expect(check(answer("frio", "Aumentada, cede al retirar el estímulo", "con el frío le duele y se le pasa al toque"), "Con el frío le duele y se le pasa al toque.")).toEqual({
      status: "lista",
      value: "Aumentada, cede al retirar el estímulo",
    })
    expect(check(answer("calor", "Aumentada, persiste", "El frío le dura bastante, más de un minuto"), C9)).toBeNull()
  })
})
