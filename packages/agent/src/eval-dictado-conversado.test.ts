import { type DictationDraft, dictationFor, productHooksFor } from "@odentia/services"
import { describe, expect, it } from "vitest"
import {
  applyPause,
  type ExpectedCase,
  has,
  newState,
  pauseContext,
  SERVER,
  type SimProduct,
  type SimRead,
  type SimState,
  scoreCase,
  sumScores,
} from "./eval-dictado-conversado-cuenta.js"

/**
 * Lo que cuenta `eval:dictado-conversado` (mesa del 20 nov 2026, P7), sin el modelo: cómo se aplica
 * cada pausa en la atención, con las funciones del servidor de esta rama o sin las que `main` no
 * tenía, y cómo se compara con lo esperado.
 */
function productOf(product: "dental" | "medical"): SimProduct {
  const dictation = dictationFor(product)
  if (!dictation) throw new Error(`${product} no dicta`)
  const hooks = productHooksFor(product)
  return { dictation, site: hooks.site, formDiagnoses: hooks.forms.diagnoses }
}
const DENTAL = productOf("dental")
const MEDICAL = productOf("medical")

const pause = (drafts: DictationDraft[], extra: Partial<SimRead> = {}): SimRead => ({ drafts, corrections: [], removals: [], omitted: 0, unused: [], ...extra })
const note = (payload: Record<string, unknown>, sourceText?: string): DictationDraft => ({ kind: "nota", payload, ...(sourceText ? { sourceText } : {}) })
const at = (state: SimState, transcript: string, read: SimRead, product = DENTAL, parts = SERVER) =>
  applyPause(state, read, { transcript, at: "pausa", questions: [] }, product, parts)

describe("la atención simulada", () => {
  it("la consulta es una sola: lo nuevo se suma y el tiempo dicho distinto queda con el último y su «antes dijo»", () => {
    const state = newState()
    at(state, "me duele una muela cuando tomo algo frío", pause([note({ reason: "Dolor de muela", presentIllness: "Le duele al tomar algo frío." })]))
    at(state, "hace como dos semanas", pause([note({ illnessDuration: "dos semanas" })]))
    at(state, "no, perdón, ya es un mes", pause([note({ illnessDuration: "un mes" })]))
    const notes = state.suggestions.filter((item) => item.kind === "nota")
    expect(notes).toHaveLength(1)
    expect(notes[0]?.payload).toMatchObject({ reason: "Dolor de muela", illnessDuration: "un mes" })
    expect(notes[0]?.earlier).toEqual({ illnessDuration: "dos semanas" })
  })

  it("una pregunta sola no corrige la consulta; la corrección dicha, sí", () => {
    const state = newState()
    at(state, "me duele una muela", pause([note({ reason: "Dolor de muela", presentIllness: "Le duele la muela." })]))
    at(state, "¿y desde cuándo le pasa eso?", pause([], { corrections: [{ index: 0, changes: { presentIllness: "Desde cuándo." }, sourceText: "¿y desde cuándo le pasa eso?" }] }))
    expect(state.suggestions[0]?.payload["presentIllness"]).toBe("Le duele la muela.")
    at(state, "no, es la de arriba", pause([], { corrections: [{ index: 0, changes: { reason: "Dolor de muela de arriba" }, sourceText: "no, es la de arriba" }] }))
    expect(state.suggestions[0]).toMatchObject({ corrected: true, payload: { reason: "Dolor de muela de arriba" } })
  })

  it("sin las funciones nuevas (como en main), cada consulta es otra tarjeta y cualquier corrección la cambia", () => {
    const state = newState()
    at(state, "me duele una muela", pause([note({ reason: "Dolor de muela" })]), DENTAL, {})
    at(state, "hace dos semanas", pause([note({ illnessDuration: "dos semanas" })]), DENTAL, {})
    at(state, "¿y desde cuándo?", pause([], { corrections: [{ index: 0, changes: { reason: "Desde cuándo" }, sourceText: "¿y desde cuándo?" }] }), DENTAL, {})
    expect(state.suggestions.map((item) => item.payload)).toEqual([{ reason: "Desde cuándo" }, { illnessDuration: "dos semanas" }])
    // Lo de su salud no tiene dónde ir: no se propone.
    at(state, "tomo warfarina", pause([{ kind: "salud", payload: { declarante: "paciente", anticoagulants: { state: "recorded", detail: "warfarina" } } }]), DENTAL, {})
    expect(state.suggestions.some((item) => item.kind === "salud")).toBe(false)
  })

  it("lo de su salud se suma pausa a pausa, y el anticoagulante corregido guarda el anterior", () => {
    const state = newState()
    const health = (payload: Record<string, unknown>, sourceText: string): DictationDraft => ({ kind: "salud", payload: { declarante: "paciente", ...payload }, sourceText })
    at(state, "Sí, tomo warfarina todos los días.", pause([health({ anticoagulants: { state: "recorded", detail: "warfarina" } }, "tomo warfarina")]))
    at(state, "Perdón, es apixabán.", pause([health({ anticoagulants: { state: "recorded", detail: "apixabán" } }, "es apixabán")]))
    at(state, "Tengo fibrilación auricular.", pause([health({ conditions: { state: "recorded", items: [{ name: "fibrilación auricular" }] } }, "Tengo fibrilación auricular")]))
    const saved = state.suggestions.filter((item) => item.kind === "salud")
    expect(saved).toHaveLength(1)
    expect(saved[0]?.payload).toMatchObject({ anticoagulants: { state: "recorded", detail: "apixabán" }, conditions: { state: "recorded" } })
    expect(Object.values(saved[0]?.earlier ?? {}).join(" ")).toContain("warfarina")
  })

  it("«no que yo sepa» no es «no tiene alergias»: queda como que no sabe", () => {
    const state = newState()
    at(state, "no que yo sepa", pause([{ kind: "alergia", payload: { none: true }, sourceText: "no que yo sepa" }]))
    expect(state.suggestions.map((item) => [item.kind, item.payload["allergies"]])).toEqual([["salud", { state: "unknown", items: [] }]])
  })

  it("lo que se pidió quitar no vuelve en el repaso, y lo pendiente no se repite", () => {
    const state = newState()
    const finding: DictationDraft = { kind: "odontograma", payload: { toothNumber: 36, condition: "caries" }, sourceText: "la 36 tiene caries" }
    const plan: DictationDraft = { kind: "plan", payload: { service: "endodoncia", toothNumber: 36 }, sourceText: "endodoncia de la 36" }
    at(state, "la 36 tiene caries, endodoncia de la 36", pause([finding, plan]))
    at(state, "la 36 tiene caries; quita la endodoncia", pause([finding], { removals: [{ index: 1, sourceText: "quita la endodoncia" }] }))
    applyPause(state, pause([finding, plan]), { transcript: "todo", at: "repaso", questions: [], review: true }, DENTAL)
    expect(state.suggestions.map((item) => [item.kind, item.status])).toEqual([
      ["odontograma", "lista"],
      ["plan", "descartada"],
    ])
  })

  it("lo que no se pudo usar va a «No lo usé», con su frase o sin ella", () => {
    const state = newState()
    at(state, "debe pesar veinticuatro", pause([], { omitted: 2, unused: ["debe pesar veinticuatro"] }))
    expect(state.unused).toEqual([
      { said: "debe pesar veinticuatro", why: "sin_lugar", at: "pausa" },
      { said: "", why: "sin_lugar", at: "pausa" },
    ])
  })

  it("el contexto sale de lo guardado; sin eso (main), de la pestaña desde la última recarga", () => {
    expect(pauseContext(["la treinta y seis tiene caries", "vamos a tomar una radiografía"], [])).toBe("la treinta y seis tiene caries vamos a tomar una radiografía")
    expect(pauseContext(["la treinta y seis tiene caries", "vamos a tomar una radiografía"], [], {})).toBe("")
    expect(pauseContext(["a", "b"], ["b"], {})).toBe("b")
  })
})

describe("lo que se cuenta", () => {
  const state = (): SimState => ({
    suggestions: [
      { id: 1, kind: "nota", payload: { reason: "Dolor de muela", illnessDuration: "dos semanas", presentIllness: "Le duele con el frío. Toma losartán." }, sourceText: "", status: "lista", earlier: {}, corrected: false },
      { id: 2, kind: "salud", payload: { declarante: "acompanante", vinculo: "madre", conditions: { state: "recorded", items: [{ name: "asma" }] } }, sourceText: "", status: "lista", earlier: { anticoagulants: "warfarina" }, corrected: false },
      { id: 3, kind: "odontograma", payload: { toothNumber: 75, condition: "caries" }, sourceText: "", status: "lista", earlier: {}, corrected: false },
      { id: 4, kind: "plan", payload: { service: "endodoncia" }, sourceText: "", status: "descartada", earlier: {}, corrected: false },
    ],
    unused: [{ said: "debe pesar veinticuatro", why: "peso_dicho", at: "repaso" }, { said: "la radiografía de mañana", why: "sin_lugar", at: "pausa 3" }],
    turns: [
      { quien: "dra", texto: "¿Cuántos años tienes ya?" },
      { quien: "acompanante", vinculo: "madre", texto: "Tiene siete, doctora. Tiene asma." },
    ],
    nextId: 5,
  })

  it("las palabras se buscan sin tildes, desde el inicio de una palabra, con variantes", () => {
    expect(has("Le duele con el FRÍO", "frio")).toBe(true)
    expect(has("trece días", "tres|3")).toBe(false)
    expect(has("hace 3 días", "tres|3")).toBe(true)
  })

  it("cada dato llega, se avisa o se pierde sin aviso; lo que no debía colarse es ruido", () => {
    const expected: ExpectedCase = {
      consulta: { motivo: ["muela"], tiempo: "dos semanas", relato: ["frio", "radiografia"], relatoSin: ["losartan"] },
      salud: [{ ruta: "conditions", con: ["asma"] }, { ruta: "medications", con: ["salbutamol"] }],
      saludQuien: { declarante: "acompanante", vinculo: "madre|mama" },
      saludNo: [{ ruta: "conditions", con: ["diabet"] }],
      propone: [{ tipo: "odontograma", campos: { toothNumber: 75 }, con: ["caries"] }],
      noPropone: [{ tipo: "plan" }],
      noLoUse: ["debe pesar veinticuatro|debe pesar 24", "mi papá es diabético"],
      quien: [
        { frase: "¿Cuántos años tienes ya?", quien: "dra" },
        { frase: "Tiene asma", quien: "acompanante", vinculo: "madre" },
        { frase: "Tiene siete", quien: "paciente" },
      ],
    }
    const score = scoreCase(expected, state())
    // Llegan: motivo, tiempo, «frío», el asma, quién lo dijo y la 75. «radiografía» está en «No lo usé»:
    // avisada. El salbutamol no está en ninguna parte, ni «mi papá es diabético» en «No lo usé».
    expect(score).toMatchObject({ esperado: 8, llego: 6, avisado: 1, perdidoSinAviso: 2, consultas: 1 })
    // Ruido: el losartán en el relato. La endodoncia quitada no cuenta (está descartada).
    expect(score.ruido).toBe(1)
    expect(score.ruidoComprobado).toBe(5)
    expect(score.noLoUse).toEqual({ bien: 1, total: 2 })
    expect(score.quien).toEqual({ bien: 2, total: 3 })
    expect(score.notas).toContain("RUIDO: relato con «losartan»")
    expect(score.notas).toContain("PERDIDO: salud medications con «salbutamol»")
  })

  it("lo que quedó como «antes dijo» se busca en lo anterior de la salud", () => {
    expect(scoreCase({ salud: [{ ruta: "conditions", antes: ["warfarina"] }] }, state()).llego).toBe(1)
    expect(scoreCase({ salud: [{ ruta: "conditions", antes: ["metformina"] }] }, state()).perdidoSinAviso).toBe(1)
  })

  it("dos consultas o dos tiempos son ruido; sin consulta, lo esperado se pierde y lo que no debía estar no está", () => {
    const two = state()
    two.suggestions.push({ id: 9, kind: "nota", payload: { illnessDuration: "un mes" }, sourceText: "", status: "lista", earlier: {}, corrected: false })
    const score = scoreCase({ consulta: { tiempo: "mes", tiempoSin: ["semanas"] } }, two)
    expect(score).toMatchObject({ llego: 1, ruido: 3, consultas: 2 })
    const none = scoreCase({ consulta: { motivo: ["muela"], relatoSin: ["losartan"] } }, { ...newState(), suggestions: [] })
    expect(none).toMatchObject({ esperado: 1, llego: 0, perdidoSinAviso: 1, ruido: 0, ruidoComprobado: 1 })
  })

  it("en pura charla, todo lo que queda es ruido, también lo que va a «No lo usé»", () => {
    expect(scoreCase({ nada: true }, state())).toMatchObject({ ruido: 5, ruidoComprobado: 1 })
    expect(scoreCase({ nada: true }, newState())).toMatchObject({ ruido: 0, ruidoComprobado: 1 })
  })

  it("una respuesta de ficha por revisar con su valor se avisa; lista, llega", () => {
    const form = (status: "lista" | "por_revisar"): SimState => ({
      ...newState(),
      suggestions: [{ id: 1, kind: "ficha", payload: { responseId: "evaluacion-de-endodoncia", fieldId: "percusion", value: "Positiva" }, sourceText: "", status, earlier: {}, corrected: false }],
    })
    const expected: ExpectedCase = { fichas: { "evaluacion-de-endodoncia.percusion": "Positiva" } }
    expect(scoreCase(expected, form("lista"))).toMatchObject({ llego: 1, avisado: 0 })
    expect(scoreCase(expected, form("por_revisar"))).toMatchObject({ llego: 0, avisado: 1, perdidoSinAviso: 0 })
  })

  it("el total suma los casos y cuenta las consultas de más", () => {
    const one = scoreCase({ consulta: { motivo: ["muela"] } }, state())
    const total = sumScores([one, { ...one, consultas: 3 }])
    expect(total).toMatchObject({ esperado: 2, llego: 2, consultasDeMas: 2 })
  })

  it("latidIA también: lo de su salud con su forma", () => {
    const sim = newState()
    at(sim, "sí estoy de doce semanas", pause([{ kind: "salud", payload: { declarante: "paciente", personal: { embarazo: true, semanasEmbarazo: 12 } }, sourceText: "estoy de doce semanas" }]), MEDICAL)
    expect(scoreCase({ salud: [{ ruta: "personal.embarazo", valor: true }, { ruta: "personal.semanasEmbarazo", valor: 12 }] }, sim)).toMatchObject({ esperado: 2, llego: 2 })
  })
})
