import { describe, expect, it } from "vitest"
import { FOLLOW_UP_MS, helpReply, previousOf } from "./help-panel"

const NOW = 1_800_000_000_000

/** Una respuesta como la entrega `/api/help/ask`, con lo mínimo de cada tipo. */
function reply(kind: "guia" | "estado" | "duda" | "nada" | "datos" | "charla", where: string[] = []) {
  return helpReply.parse({
    askId: "a",
    kind,
    say: null,
    written: null,
    answers: where.map((item) => ({ topicId: item, where: item, text: `En ${item}.`, path: null, restriction: null })),
    blockers: [],
    basedOn: "",
  })
}

function asked(question: string, kind: Parameters<typeof reply>[0], extra: { where?: string[]; ago?: number; helpful?: boolean } = {}) {
  return { question, reply: reply(kind, extra.where), answeredAt: NOW - (extra.ago ?? 60_000), helpful: extra.helpful }
}

describe("La pregunta anterior que viaja con una de seguimiento", () => {
  it("tras una respuesta de la guía viaja la pregunta y la pantalla de su primera respuesta", () => {
    expect(previousOf([asked("¿Qué es Tareas?", "guia", { where: ["Tareas", "Pacientes"] })], NOW)).toEqual({ question: "¿Qué es Tareas?", where: "Tareas" })
  })

  it("tras «por qué no puedo» viaja la pregunta; sin respuestas de la guía, sin pantalla", () => {
    expect(previousOf([asked("¿Por qué no puedo reservar?", "estado")], NOW)).toEqual({ question: "¿Por qué no puedo reservar?", where: null })
  })

  it("lo que no es de una pantalla viaja sin pantalla", () => {
    expect(previousOf([asked("¿Quién es Ariadna?", "guia", { where: [""] })], NOW)).toEqual({ question: "¿Quién es Ariadna?", where: null })
  })

  it("tras una duda, un «no está», las cifras o un saludo no viaja nada, aunque antes hubiera una respuesta", () => {
    for (const kind of ["duda", "nada", "datos", "charla"] as const) {
      expect(previousOf([asked("¿Qué es Tareas?", "guia", { where: ["Tareas"] }), asked("como anulo", kind)], NOW), kind).toBeUndefined()
    }
  })

  it("caduca: a los diez minutos la pregunta viaja sola", () => {
    expect(previousOf([asked("¿Qué es Tareas?", "guia", { where: ["Tareas"], ago: FOLLOW_UP_MS - 1 })], NOW)).toBeDefined()
    expect(previousOf([asked("¿Qué es Tareas?", "guia", { where: ["Tareas"], ago: FOLLOW_UP_MS })], NOW)).toBeUndefined()
  })

  it("si dijo que no le sirvió, la reformulación no arrastra ese tema", () => {
    expect(previousOf([asked("como anulo", "guia", { where: ["Citas"], helpful: false })], NOW)).toBeUndefined()
    expect(previousOf([asked("como anulo", "guia", { where: ["Citas"], helpful: true })], NOW)).toBeDefined()
  })

  it("una pregunta que no se pudo responder no cuenta: vale la última respondida", () => {
    const failed = { question: "¿y cómo la creo?", reply: null, answeredAt: null, helpful: undefined }
    expect(previousOf([asked("¿Qué es Tareas?", "guia", { where: ["Tareas"] }), failed], NOW)).toEqual({ question: "¿Qué es Tareas?", where: "Tareas" })
    expect(previousOf([failed], NOW)).toBeUndefined()
    expect(previousOf([], NOW)).toBeUndefined()
  })
})

describe("Lo que el panel acepta de /api/help/ask", () => {
  const base = { askId: "a", kind: "guia", answers: [{ topicId: "t", where: "Tareas", text: "En Tareas.", path: "/tasks", restriction: null }], blockers: [], basedOn: "" }

  it("una respuesta de un servidor anterior, sin `written` ni videos", () => {
    const parsed = helpReply.parse(base)
    expect(parsed.written).toBeUndefined()
    expect(parsed.answers[0]?.videos).toBeUndefined()
  })

  it("la redactada y los videos de una respuesta", () => {
    const parsed = helpReply.parse({
      ...base,
      written: "Abre Tareas y crea una.",
      answers: [{ ...base.answers[0], videos: [{ title: "Cómo crear una tarea", url: "https://youtu.be/x", minutes: null }] }],
    })
    expect(parsed.written).toBe("Abre Tareas y crea una.")
    expect(parsed.answers[0]?.videos).toEqual([{ title: "Cómo crear una tarea", url: "https://youtu.be/x", minutes: null }])
  })
})
