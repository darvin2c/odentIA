import { agentTextsFor, helpTopicsFor } from "@odentia/services"
import { describe, expect, it } from "vitest"
import {
  HELP_CONFIDENT,
  HELP_OFFERED,
  HELP_SELECT_MAX_OPTIONS,
  HELP_SELECT_QUESTION,
  helpAnswerText,
  helpCandidates,
  type HelpOption,
  helpOptions,
  helpQuestion,
  helpScreenName,
  helpState,
  readHelpSelection,
} from "./help.js"
import { KNOWLEDGE_SELECT_MAX_OPTIONS } from "./knowledge.js"
import type { DecisionResult } from "./port.js"

/** La pregunta `help.v1` y la lectura de su resultado, sin proveedor: las probabilidades las escribe la prueba. */
const TOPICS = helpTopicsFor("dental")
const OPTIONS = helpOptions(TOPICS)
const QUESTION = helpQuestion(OPTIONS, agentTextsFor("dental"))
const values = QUESTION.kind === "choice" ? QUESTION.options.map((option) => option.value) : []

const faq = (q: string): number => OPTIONS.findIndex((option) => option.kind === "faq" && option.faq.q === q)
const screen = (id: string): number => OPTIONS.findIndex((option) => option.kind === "tema" && option.topic.id === id)
const ENLACE = faq("¿Qué es «Su enlace»?")
const PORTAL = faq("¿Cómo le doy acceso al portal?")
const TAREAS = faq("¿Por qué no veo las tareas de los demás?")
const PIPELINES = screen("pipelines")

/** Un resultado de Jev con estas probabilidades, por índice de opción o por «none» y «data». */
function result(probabilities: Array<[number | "none" | "data", number]>, choice?: string): DecisionResult {
  const named = Object.fromEntries(probabilities.map(([key, p]) => [typeof key === "number" ? values[key]! : key, p]))
  const top = Object.entries(named).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none"
  return {
    answers: [{ id: HELP_SELECT_QUESTION, kind: "choice", choice: choice ?? top, probabilities: named, confidence: null }],
    model: "jev-1.13.0",
    usage: { inputTokens: 5000, outputTokens: 0 },
    latencyMs: 300,
  }
}

const read = (r: DecisionResult, at?: number) => readHelpSelection(r, OPTIONS, at)
const names = (options: HelpOption[]) => options.map((option) => (option.kind === "faq" ? option.faq.q : option.topic.id))

describe("la pregunta help.v1", () => {
  it("ofrece toda la guía, «datos» y «ninguna», dentro del límite de knowledge.v1", () => {
    expect(QUESTION.kind).toBe("choice")
    expect(ENLACE).toBeGreaterThanOrEqual(0)
    expect(PIPELINES).toBeGreaterThanOrEqual(0)
    expect(values.length).toBe(OPTIONS.length + 2)
    expect(values).toContain("none")
    expect(values).toContain("data")
    expect(new Set(values).size).toBe(values.length)
    expect(values.length).toBeLessThanOrEqual(KNOWLEDGE_SELECT_MAX_OPTIONS + 1)
    for (const option of QUESTION.kind === "choice" ? QUESTION.options : []) expect(option.description?.length ?? 0).toBeLessThanOrEqual(240)
  })

  it("describe la pregunta frecuente con su pantalla y la pantalla con el comienzo de su párrafo", () => {
    const options = QUESTION.kind === "choice" ? QUESTION.options : []
    expect(options[TAREAS]?.description).toBe("Tareas: ¿Por qué no veo las tareas de los demás?")
    expect(options[PIPELINES]?.description).toMatch(/^Pantalla Configuración › Etapas de venta: Los cuatro pasos del tablero/)
  })

  it("en latidIA habla de latidIA con su guía", () => {
    const medical = helpQuestion(helpOptions(helpTopicsFor("medical")), agentTextsFor("medical"))
    expect(medical.instructions).toContain("latidIA")
    expect(JSON.stringify(medical)).not.toContain("odentIA")
  })

  it("con más opciones de las que caben, se queda con las más parecidas sin cambiar su orden", () => {
    const many = Array.from({ length: 3 }, () => OPTIONS.map((option) => ({ ...option }))).flat()
    expect(many.length).toBeGreaterThan(HELP_SELECT_MAX_OPTIONS)
    const kept = helpCandidates(many, "¿Qué es «Su enlace»?")
    expect(kept).toHaveLength(HELP_SELECT_MAX_OPTIONS)
    expect(kept.some((option) => option.kind === "faq" && option.faq.q === "¿Qué es «Su enlace»?")).toBe(true)
    expect(kept.map((option) => many.indexOf(option))).toEqual([...kept.map((option) => many.indexOf(option))].sort((a, b) => a - b))
    expect(helpCandidates(OPTIONS, "lo que sea")).toEqual(OPTIONS)
  })

  it("al proveedor viajan la pregunta y el nombre de la pantalla, nunca su ruta", () => {
    const name = helpScreenName("/people/8f14e45f-ceea-467f-a0e6-6d8f6b1b2c3d", TOPICS)
    expect(name).toBe("Personas › Pacientes")
    const state = helpState("¿Cómo le doy acceso?", name)
    expect(state).toBe("Pantalla: Personas › Pacientes\nPregunta: ¿Cómo le doy acceso?")
    expect(state).not.toContain("8f14e45f")
    expect(helpState("¿Cómo le doy acceso?", helpScreenName("/no-existe", TOPICS))).toBe("Pregunta: ¿Cómo le doy acceso?")
  })
})

describe("leer lo que eligió", () => {
  it("seguro: muestra la respuesta tal cual está en la guía", () => {
    const selection = read(result([[TAREAS, 0.86], ["none", 0.08], [ENLACE, 0.06]]))
    expect(selection.verdict).toBe("seguro")
    expect(names(selection.shown)).toEqual(["¿Por qué no veo las tareas de los demás?"])
    expect(selection.shown[0]).toBe(OPTIONS[TAREAS])
    expect(selection.top).toBe(0.86)
    expect(helpAnswerText(selection.shown[0]!)).toBe(OPTIONS[TAREAS]?.kind === "faq" ? OPTIONS[TAREAS].faq.a : "")
  })

  it("una pregunta de dos partes muestra las dos respuestas", () => {
    const selection = read(result([[ENLACE, 0.62], [PORTAL, 0.3], ["none", 0.08]]))
    expect(selection.verdict).toBe("seguro")
    expect(names(selection.shown)).toEqual(["¿Qué es «Su enlace»?", "¿Cómo le doy acceso al portal?"])
  })

  it("la segunda no se muestra si es poco probable", () => {
    const selection = read(result([[ENLACE, 0.75], [PORTAL, 0.2], ["none", 0.05]]))
    expect(names(selection.shown)).toEqual(["¿Qué es «Su enlace»?"])
  })

  it("el párrafo de una pantalla se muestra con su nombre", () => {
    const selection = read(result([[PIPELINES, 0.9], ["none", 0.1]]))
    expect(selection.verdict).toBe("seguro")
    const topic = TOPICS.find((item) => item.id === "pipelines")!
    expect(helpAnswerText(selection.shown[0]!)).toBe(`En Configuración › Etapas de venta. ${topic.purpose}`)
  })

  it("duda: ofrece como mucho tres, de la más probable a la menos, sin mostrar ninguna", () => {
    const selection = read(result([[ENLACE, 0.35], [PORTAL, 0.25], ["none", 0.2], [TAREAS, 0.1], [PIPELINES, 0.06], [0, 0.04]]))
    expect(selection.verdict).toBe("duda")
    expect(selection.shown).toEqual([])
    expect(selection.offered).toHaveLength(HELP_OFFERED)
    expect(names(selection.offered)).toEqual(["¿Qué es «Su enlace»?", "¿Cómo le doy acceso al portal?", "¿Por qué no veo las tareas de los demás?"])
  })

  it("«ninguna» y «datos» con certeza no muestran ni ofrecen nada", () => {
    expect(read(result([["none", 0.9], [TAREAS, 0.1]]))).toEqual({ verdict: "ninguna", shown: [], offered: [], top: 0.9 })
    expect(read(result([["data", 0.8], [TAREAS, 0.2]]))).toEqual({ verdict: "datos", shown: [], offered: [], top: 0.8 })
  })

  it("«ninguna» o «datos» sin certeza es duda y ofrece lo de la guía", () => {
    const selection = read(result([["none", 0.4], [ENLACE, 0.35], ["data", 0.15], [TAREAS, 0.1]]))
    expect(selection.verdict).toBe("duda")
    expect(names(selection.offered)).toEqual(["¿Qué es «Su enlace»?", "¿Por qué no veo las tareas de los demás?"])
  })

  it("«ninguna» y «datos» juntas con el umbral dicen que no está en la guía", () => {
    expect(read(result([["none", 0.35], ["data", 0.33], [ENLACE, 0.32]]))).toEqual({ verdict: "ninguna", shown: [], offered: [], top: 0.35 })
    // Para salir a Argos, «datos» necesita su propia certeza.
    expect(read(result([["data", 0.45], ["none", 0.25], [ENLACE, 0.3]])).verdict).toBe("ninguna")
    expect(read(result([["none", 0.3], ["data", 0.25], [ENLACE, 0.45]])).verdict).toBe("duda")
  })

  it("una respuesta de la guía con el umbral gana a «ninguna» y «datos» sumadas", () => {
    const selection = read(result([[TAREAS, 0.5], ["none", 0.3], ["data", 0.2]]), 0.5)
    expect(selection.verdict).toBe("seguro")
  })

  it("las mismas respuestas se leen con cualquier umbral", () => {
    const answer = result([[TAREAS, 0.55], ["none", 0.45]])
    expect(read(answer, 0.5).verdict).toBe("seguro")
    expect(read(answer, HELP_CONFIDENT).verdict).toBe("duda")
  })

  it("sin probabilidades nunca está seguro: ofrece lo elegido", () => {
    const answer = result([[TAREAS, 1]])
    const first = answer.answers[0]!
    const baseline: DecisionResult = { ...answer, answers: [{ ...first, kind: "choice", choice: values[TAREAS]!, probabilities: null, confidence: null }] }
    expect(read(baseline)).toEqual({ verdict: "duda", shown: [], offered: [OPTIONS[TAREAS]], top: null })
  })

  it("si se negó o no respondió esa pregunta, es duda sin nada que ofrecer", () => {
    const declined: DecisionResult = { answers: [{ id: HELP_SELECT_QUESTION, kind: "declined" }], model: "jev-1.13.0", usage: null, latencyMs: 1 }
    expect(read(declined)).toEqual({ verdict: "duda", shown: [], offered: [], top: null })
    expect(read({ ...declined, answers: [] })).toEqual({ verdict: "duda", shown: [], offered: [], top: null })
  })

  it("lo que no es una opción no se muestra", () => {
    const selection = read({ ...result([[TAREAS, 0.2]]), answers: [{ id: HELP_SELECT_QUESTION, kind: "choice", choice: "f999", probabilities: { f999: 0.8, [values[TAREAS]!]: 0.2 }, confidence: null }] })
    expect(selection.verdict).toBe("duda")
    expect(names(selection.offered)).toEqual(["¿Por qué no veo las tareas de los demás?"])
  })
})
