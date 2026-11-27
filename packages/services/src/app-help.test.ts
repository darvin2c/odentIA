import { HELP_GUIDE_MAX_OPTIONS, type HelpAskQuestion } from "@odentia/contract"
import { appAiUsage, appHelpAsk } from "@odentia/db/schema/admin-accounts"
import { desc, eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import type { AdminAnswer } from "./admin-request.js"
import { APP_HELP_DAILY_LIMIT, answerAppHelp, recordAppAiUsage } from "./app-help.js"
import { HELP_AREA_QUESTION, HELP_DATA_QUESTION, HELP_SELECT_MAX_OPTIONS, HELP_SELECT_QUESTION, type HelpDecider } from "./help-decision.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * La Ayuda de una app que es otro sistema (`CONTRACT_PATHS.help`): la misma Ariadna de las
 * clínicas, con la guía que manda la app, y responde con ids de esa guía.
 */

setupTestDb()

const GUIDE: HelpAskQuestion["guide"] = [
  {
    id: "pedidos",
    path: "/pedidos",
    title: "Pedidos",
    parent: null,
    purpose: "Los pedidos de la tienda: verlos, cobrarlos y anularlos.",
    terms: ["ventas", "órdenes"],
    faqs: [
      { id: "pedido-anular", q: "¿Cómo anulo un pedido?", a: "Abre el pedido y toca «Anular»." },
      { id: "pedido-cobrar", q: "¿Cómo cobro un pedido?", a: "Abre el pedido y toca «Cobrar»." },
    ],
  },
  {
    id: "productos",
    path: "/productos",
    title: "Productos",
    parent: null,
    purpose: "Lo que vende la tienda, con su precio y su stock.",
    terms: ["catálogo"],
    faqs: [{ id: "producto-precio", q: "¿Cómo cambio el precio de un producto?", a: "En Productos, abre el producto." }],
  },
]

const ask = (question: string, more: Partial<HelpAskQuestion> = {}): HelpAskQuestion => ({
  question,
  screen: "/pedidos/123",
  previous: null,
  guide: GUIDE,
  ...more,
})

/**
 * Un Jev de prueba: la categoría de Pedidos segura y, al elegir la respuesta, las
 * probabilidades que se le dan por la pregunta frecuente (por su texto). Anota lo que recibe.
 */
function fakeJev(picks: Record<string, number>) {
  const seen: Array<{ id: string; state: string; instructions: string }> = []
  const chosen = (id: string, probabilities: Record<string, number>): AdminAnswer => ({
    id,
    kind: "choice",
    choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none",
    confidence: null,
    probabilities,
  })
  const decider: HelpDecider = {
    async decide(state, questions) {
      const question = questions[0]
      if (!question) throw new Error("Sin pregunta")
      seen.push({ id: question.id, state, instructions: question.instructions })
      const done = (answer: AdminAnswer) => ({ answers: [answer], model: "jev-prueba", usage: null })
      if (question.kind === "yesno") return done({ id: question.id, kind: "yesno", probability: 0 })
      if (question.id === HELP_AREA_QUESTION) {
        const pedidos = question.options.find((option) => option.description?.startsWith("Pedidos:"))
        if (!pedidos) throw new Error("La guía no tiene la categoría Pedidos")
        return done(chosen(question.id, { [pedidos.value]: 1 }))
      }
      if (question.id !== HELP_SELECT_QUESTION) throw new Error(`No conoce ${question.id}`)
      const probabilities = Object.fromEntries(
        Object.entries(picks).map(([q, probability]) => {
          const option = question.options.find((candidate) => candidate.description?.includes(q))
          if (!option) throw new Error(`La guía no tiene ${q}`)
          return [option.value, probability]
        }),
      )
      return done(chosen(question.id, probabilities))
    },
  }
  return { decider, seen }
}

const lastAsk = async () =>
  (await ownerDb.select().from(appHelpAsk).where(eq(appHelpAsk.app, "gestoria")).orderBy(desc(appHelpAsk.createdAt)).limit(1))[0]

describe("la Ayuda de una app", () => {
  it("segura: muestra la pregunta frecuente por su id, con las palabras de la app", async () => {
    const jev = fakeJev({ "¿Cómo anulo un pedido?": 0.96 })
    const answer = await answerAppHelp(ownerDb, "gestoria", ask("quiero anular una venta"), jev.decider)
    expect(answer).toEqual({ via: "jev", verdict: "seguro", shown: ["faq:pedido-anular"], offered: [], written: null })
    // Jev lee la pantalla por su nombre (nunca la ruta con su id) y el producto de la app.
    const select = jev.seen.find((item) => item.id === HELP_SELECT_QUESTION)
    expect(select?.state).toContain("Pantalla: Pedidos")
    expect(select?.state).not.toContain("123")
    expect(select?.instructions).toContain("Ayuda de gestorIA")
    expect(select?.instructions).toContain("una tienda")
    expect(jev.seen.some((item) => item.id === HELP_DATA_QUESTION)).toBe(true)
    // Queda constancia de cómo se decidió, sin el texto.
    expect(await lastAsk()).toMatchObject({ via: "jev", verdict: "seguro" })
  })

  it("en duda: ofrece las más probables por su id", async () => {
    const jev = fakeJev({ "¿Cómo anulo un pedido?": 0.5, "¿Cómo cobro un pedido?": 0.4 })
    const answer = await answerAppHelp(ownerDb, "gestoria", ask("¿qué hago con un pedido?"), jev.decider)
    expect(answer.via).toBe("jev")
    expect(answer.verdict).toBe("duda")
    expect(answer.shown).toEqual([])
    expect(answer.offered).toEqual(["faq:pedido-anular", "faq:pedido-cobrar"])
  })

  it("sin Jev: responden las palabras (respaldo)", async () => {
    const answer = await answerAppHelp(ownerDb, "gestoria", ask("¿Cómo anulo un pedido?"), null)
    expect(answer.via).toBe("respaldo")
    expect(answer.offered).toEqual([])
    expect(answer.shown).toEqual(answer.verdict === "seguro" ? ["faq:pedido-anular"] : [])
    expect(await lastAsk()).toMatchObject({ via: "respaldo", verdict: null })
  })

  it("lo que solo es el dato de una persona no viaja a Jev: no está en la guía", async () => {
    const jev = fakeJev({ "¿Cómo anulo un pedido?": 0.96 })
    const answer = await answerAppHelp(ownerDb, "gestoria", ask("ana@correo.com 987 654 321"), jev.decider)
    expect(answer).toEqual({ via: "respaldo", verdict: "ninguna", shown: [], offered: [], written: null })
    expect(jev.seen).toEqual([])
  })

  it("la pregunta anterior viaja sin el dato de una persona", async () => {
    const jev = fakeJev({ "¿Cómo anulo un pedido?": 0.96 })
    await answerAppHelp(
      ownerDb,
      "gestoria",
      ask("¿y cómo lo anulo?", { previous: { question: "busco el pedido de ana@correo.com", where: "Pedidos" } }),
      jev.decider,
    )
    const state = jev.seen.find((item) => item.id === HELP_SELECT_QUESTION)?.state ?? ""
    expect(state).toContain("Antes preguntó:")
    expect(state).not.toContain("ana@correo.com")
  })

  it("lo que cuestan los modelos queda por app, con origen «ayuda»", async () => {
    await ownerDb.transaction((tx) =>
      recordAppAiUsage(tx as typeof ownerDb, "gestoria", "ayuda", [
        { provider: "jev", model: "jev-1.13.0", calls: 3, inputTokens: 900, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: 0, audioSeconds: null, costMicros: 38 },
        { provider: "openai", model: "sin-precio", calls: 0, inputTokens: null, cachedInputTokens: null, cacheWriteTokens: null, outputTokens: null, audioSeconds: null, costMicros: null },
      ]),
    )
    const rows = await ownerDb.select().from(appAiUsage).where(eq(appAiUsage.app, "gestoria"))
    expect(rows).toEqual([expect.objectContaining({ origin: "ayuda", provider: "jev", calls: 3, inputTokens: 900, costMicros: 38 })])
  })

  it("cada app tiene su tope diario", async () => {
    await ownerDb.execute(sql`insert into app_help_ask (app) select 'gestoria' from generate_series(1, ${APP_HELP_DAILY_LIMIT})`)
    try {
      await expect(answerAppHelp(ownerDb, "gestoria", ask("¿Cómo anulo un pedido?"), null)).rejects.toMatchObject({ code: "HELP_LIMIT", status: 429 })
    } finally {
      await ownerDb.delete(appHelpAsk)
    }
  })

  it("una guía con más respuestas que dos tandas de Jev se rechaza sin contarla ni preguntar", async () => {
    expect(HELP_GUIDE_MAX_OPTIONS).toBe(2 * HELP_SELECT_MAX_OPTIONS)
    const big: HelpAskQuestion["guide"] = Array.from({ length: 7 }, (_, t) => ({
      id: `t${t}`,
      path: `/t${t}`,
      title: `Tema ${t}`,
      parent: null,
      purpose: "Una pantalla.",
      terms: [],
      faqs: Array.from({ length: 71 }, (_, f) => ({ id: `t${t}-f${f}`, q: `¿Pregunta ${f}?`, a: "Respuesta." })),
    }))
    const jev = fakeJev({})
    await expect(answerAppHelp(ownerDb, "gestoria", ask("¿Cómo anulo un pedido?", { guide: big }), jev.decider)).rejects.toMatchObject({
      status: 400,
      fields: { guide: expect.any(String) },
    })
    expect(jev.seen).toEqual([])
    expect(await ownerDb.select().from(appHelpAsk)).toEqual([])
  })
})
