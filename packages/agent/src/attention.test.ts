import { describe, expect, it } from "vitest"
import { attentionLines, attentionProgress, fitHistory, HISTORY_CHARS, HISTORY_HEAD, nameQuestionsIn } from "./attention"

describe("pedir el nombre dos veces en un mensaje (auditoría del ADR 0104)", () => {
  it("cuenta las preguntas que piden su nombre, no las menciones", () => {
    expect(nameQuestionsIn("¿Cuál horario te conviene? Y para registrarte, ¿me dices tus nombres y apellidos? ¿Con quién tengo el gusto?")).toBe(2)
    expect(nameQuestionsIn("Para registrarte, ¿me dices tus nombres y apellidos?")).toBe(1)
    expect(nameQuestionsIn("Te registro con tu nombre. ¿Te la reservo?")).toBe(0)
  })
})

const said = (count: number, size = 20) => Array.from({ length: count }, (_, i) => ({ id: i, body: `${i}`.padEnd(size, ".") }))

describe("lo que Sofi lee de la atención (ADR 0104)", () => {
  it("una atención normal entra entera, por larga que sea en pedazos", () => {
    const items = said(150)
    expect(fitHistory(items)).toEqual({ items, omitted: 0 })
  })

  it("si no cabe, conserva cómo empezó y lo último, y cuenta lo que deja fuera", () => {
    const items = said(100, 500)
    const fitted = fitHistory(items)
    expect(fitted.omitted).toBeGreaterThan(0)
    expect(fitted.items.length + fitted.omitted).toBe(100)
    expect(fitted.items.slice(0, HISTORY_HEAD).map((item) => item.id)).toEqual([0, 1, 2, 3])
    expect(fitted.items.at(-1)?.id).toBe(99)
    // Sin huecos en lo último: es lo que se está conversando.
    const tail = fitted.items.slice(HISTORY_HEAD).map((item) => item.id)
    expect(tail).toEqual(Array.from({ length: tail.length }, (_, i) => 100 - tail.length + i))
    const size = fitted.items.reduce((sum, item) => sum + item.body.length + 40, 0)
    expect(size).toBeLessThanOrEqual(HISTORY_CHARS)
  })

  it("el último mensaje va siempre, aunque solo él pase del tope", () => {
    const items = [...said(6), { id: 99, body: "x".repeat(HISTORY_CHARS * 2) }]
    const fitted = fitHistory(items)
    expect(fitted.items.at(-1)?.id).toBe(99)
    expect(fitted.items.slice(0, HISTORY_HEAD).map((item) => item.id)).toEqual([0, 1, 2, 3])
    expect(fitted.omitted).toBe(2)
  })
})

describe("cómo va la atención, contado por el código (ADR 0104)", () => {
  const startedAt = "2026-10-28T15:00:00.000Z"
  const at = (minutes: number) => new Date(Date.parse(startedAt) + minutes * 60_000).toISOString()
  const empty = { pending: [], recent: [], lookups: [] }
  const proposal = (status: string, minutes: number, action = "reservar_cita") => ({
    id: "p", action, label: "Reservar cita", summary: "Cita: lunes 2 de noviembre, 9:00", status, detail: null, at: at(minutes), expiresAt: null,
  })

  it("sin respuestas propias, es la primera: se presenta; después no", () => {
    const first = attentionProgress({ items: [{ direction: "in", senderKind: "contact", body: "hola", createdAt: at(0) }], startedAt, state: empty, promotions: [] })
    expect(first.replies).toBe(0)
    expect(attentionLines(first, "Sofi", { name: "Rosa" })).toEqual([
      "Es tu primera respuesta en esta atención: preséntate como Sofi en una frase.",
      "Se llama Rosa: aún no le hablaste por su nombre en esta atención; hazlo en esta respuesta.",
    ])
    const later = attentionProgress({
      items: [
        // Lo que respondió en la atención anterior no cuenta.
        { direction: "out", senderKind: "agent", body: "Hola, soy Sofi.", createdAt: at(-600) },
        { direction: "in", senderKind: "contact", body: "hola", createdAt: at(0) },
        { direction: "out", senderKind: "agent", body: "Hola, soy Sofi. ¿En qué te ayudo?", createdAt: at(1) },
      ],
      startedAt,
      state: empty,
      promotions: [],
    })
    expect(later.replies).toBe(1)
    expect(attentionLines(later, "Sofi")[0]).toBe("Ya le respondiste en esta atención: no te presentes ni vuelvas a saludar; ve directo a lo que pide.")
  })

  it("la promoción que ya nombró, aunque fuera en negrita, queda dicha; la de otra atención no", () => {
    const progress = attentionProgress({
      items: [
        { direction: "out", senderKind: "agent", body: "Tenemos la *Limpieza de Octubre* a S/ 90.", createdAt: at(2) },
        { direction: "out", senderKind: "agent", body: "También el Blanqueamiento Express.", createdAt: at(-600) },
      ],
      startedAt,
      state: empty,
      promotions: ["Limpieza de octubre", "Blanqueamiento express", "Ortodoncia"],
    })
    expect(progress.promotions).toEqual(["Limpieza de octubre"])
    expect(attentionLines(progress, "Sofi")).toContain(
      "Ya le ofreciste en esta atención la promoción «Limpieza de octubre»: no la repitas salvo que vuelva a preguntar por el precio.",
    )
  })

  it("los horarios ofrecidos, la cita que espera su sí y la que ya quedó salen del estado del caso", () => {
    const progress = attentionProgress({
      items: [],
      startedAt,
      state: {
        pending: [proposal("propuesta", 5)],
        recent: [proposal("ejecutada", 3, "cancelar_cita"), proposal("ejecutada", -600)],
        lookups: [{ tool: "buscar_huecos", text: "- lunes 9:00", at: at(4) }],
      },
      promotions: [],
    })
    expect(progress).toMatchObject({
      offered: true,
      pending: "Reservar cita — Cita: lunes 2 de noviembre, 9:00",
      done: "Reservar cita — Cita: lunes 2 de noviembre, 9:00",
    })
    // Lo hecho en la atención anterior no es de esta.
    const before = attentionProgress({ items: [], startedAt, state: { ...empty, recent: [proposal("ejecutada", -600)] }, promotions: [] })
    expect(before.done).toBeNull()
    expect(before.offered).toBe(false)
  })

  it("cuenta cuántas veces le preguntó su nombre: una vez más solo si hace falta, y después no; «te registro con tu nombre» no es preguntar", () => {
    const out = (body: string, minutes = 1) => ({ direction: "out", senderKind: "agent", body, createdAt: at(minutes) })
    const unknown = attentionProgress({ items: [out("Hola, soy Sofi. Te registro con tu nombre. ¿Te la reservo?")], startedAt, state: empty, promotions: [] })
    expect(unknown.namesAsked).toBe(0)
    expect(attentionLines(unknown, "Sofi", { saves: true })[1]).toBe(
      "Aún no sabes cómo se llama quien escribe ni se lo preguntaste en esta atención: si ya te lo dijo en la conversación, guárdalo con update_contact en este mismo paso y háblale por su nombre; si no, pregúntaselo al final de esta respuesta, sin frenar lo que pidió.",
    )
    for (const asked of ["¿Con quién tengo el gusto?", "Para registrarte, ¿me indicas tus nombres y apellidos?", "May I have your full name?"]) {
      const progress = attentionProgress({ items: [out(`Tengo el jueves a las 10:00. ${asked}`)], startedAt, state: empty, promotions: [] })
      expect(progress.namesAsked).toBe(1)
      expect(attentionLines(progress, "Sofi")[1]).toContain("pídeselo una vez más, con naturalidad, solo cuando haga falta")
    }
    const twice = attentionProgress({ items: [out("¿Con quién tengo el gusto?"), out("¿Me dices tu nombre?", 2)], startedAt, state: empty, promotions: [] })
    expect(attentionLines(twice, "Sofi")[1]).toBe("Ya le preguntaste cómo se llama 2 veces en esta atención: no se lo vuelvas a preguntar. Si ya te lo dijo, háblale por su nombre.")
    // Lo que preguntó en la atención anterior no cuenta.
    expect(attentionProgress({ items: [out("¿Con quién tengo el gusto?", -600)], startedAt, state: empty, promotions: [] }).namesAsked).toBe(0)
  })

  it("con su nombre en la ficha, se le pide usarlo hasta que lo usa, sin tildes ni el segundo nombre", () => {
    const progress = attentionProgress({
      items: [{ direction: "out", senderKind: "agent", body: "Hola, María, soy Sofi.", createdAt: at(1) }],
      startedAt,
      state: empty,
      promotions: [],
      name: "Maria José",
    })
    expect(progress.usedName).toBe(true)
    expect(attentionLines(progress, "Sofi", { name: "Maria José" })).toHaveLength(1)
    // «Mariana» no es «María».
    const other = attentionProgress({ items: [{ direction: "out", senderKind: "agent", body: "Gracias, Mariana.", createdAt: at(1) }], startedAt, state: empty, promotions: [], name: "María" })
    expect(other.usedName).toBe(false)
  })
})
