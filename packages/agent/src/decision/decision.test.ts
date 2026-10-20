import { once } from "node:events"
import { createServer, type Server } from "node:http"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { expect, it } from "vitest"
import { createBaselineDecisionModel } from "./baseline.js"
import { createFakeDecisionModel } from "./fake.js"
import { createJevDecisionModel } from "./jev.js"
import { TRIAGE_QUESTIONS, triageOutcome, triageState } from "./points.js"
import { answerOf, DecisionError } from "./port.js"

async function mockProvider(handler: (body: unknown) => { status: number; body: unknown }) {
  const seen: Array<{ url: string; authorization: string | undefined; body: unknown }> = []
  const server: Server = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    seen.push({ url: request.url ?? "", authorization: request.headers.authorization, body })
    const reply = handler(body)
    response.writeHead(reply.status, { "content-type": "application/json" })
    response.end(JSON.stringify(reply.body))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("sin puerto")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

it("el adaptador de Jev envía el contrato documentado y traduce noul/choice/score", async () => {
  const provider = await mockProvider(() => ({
    status: 200,
    body: {
      model: "jev-1.13.0",
      answers: {
        requires_reply: { type: "noul", noul: 0.93 },
        handoff: { type: "noul", noul: 0.05 },
        urgency: { type: "score", score: 1.2, legend: ["low", "medium", "high"], probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 }, confidence: 0.55 },
        intent: { type: "choice", choice: "appointment_request", probabilities: { appointment_request: 0.9, other: 0.1 }, confidence: 0.88 },
      },
      usage: { input_tokens: 120, output_tokens: 20 },
    },
  }))
  try {
    const jev = createJevDecisionModel({ apiKey: "clave-jev", baseUrl: provider.baseUrl, model: "jev-1.13.0" })
    const result = await jev.decide("Contact (latest): quiero una cita mañana", TRIAGE_QUESTIONS)
    expect(provider.seen[0]?.url).toBe("/v1/systemone")
    expect(provider.seen[0]?.authorization).toBe("Bearer clave-jev")
    const sent = provider.seen[0]?.body as { model: string; state: string; questions: Record<string, { type: string; criteria?: unknown }> }
    expect(sent.model).toBe("jev-1.13.0")
    expect(sent.questions.requires_reply?.type).toBe("noul")
    expect(sent.questions.intent?.type).toBe("choice")
    expect(Object.keys(sent.questions.intent?.criteria as Record<string, unknown>)).toContain("other")
    expect(sent.questions.urgency?.type).toBe("score")
    expect(Array.isArray(sent.questions.urgency?.criteria)).toBe(true)
    expect(answerOf(result, "requires_reply", "yesno")?.probability).toBe(0.93)
    expect(answerOf(result, "intent", "choice")).toMatchObject({ choice: "appointment_request", confidence: 0.88 })
    expect(answerOf(result, "urgency", "score")).toMatchObject({ score: 1.2, probabilities: [0.1, 0.6, 0.3] })
    // Una pregunta sin respuesta nunca se inventa.
    expect(answerOf(result, "unsubscribe", "yesno")).toBeNull()
    expect(result.answers.find((a) => a.id === "unsubscribe")?.kind).toBe("declined")
    expect(result).toMatchObject({ model: "jev-1.13.0", usage: { inputTokens: 120, outputTokens: 20 } })
  } finally {
    await provider.close()
  }
})

it("un rechazo del proveedor no reintenta, no lanza el cuerpo y se clasifica como configuración", async () => {
  const provider = await mockProvider(() => ({ status: 401, body: { error: { message: "bad key sk-secreta" } } }))
  try {
    const jev = createJevDecisionModel({ apiKey: "x", baseUrl: provider.baseUrl })
    const failure = await jev.decide("estado", TRIAGE_QUESTIONS).then(() => null, (e: unknown) => e as DecisionError)
    expect(failure).toBeInstanceOf(DecisionError)
    expect(failure?.code).toBe("CONFIG")
    expect(failure?.message).not.toContain("sk-secreta")
    expect(provider.seen).toHaveLength(1)
  } finally {
    await provider.close()
  }
})

it("una respuesta de tipo distinto a la pregunta o fuera de sus opciones rompe el contrato (SHAPE)", async () => {
  const provider = await mockProvider(() => ({
    status: 200,
    body: { model: "jev-1.13.0", answers: { urgency: { type: "noul", noul: 0.3 } } },
  }))
  try {
    const jev = createJevDecisionModel({ apiKey: "x", baseUrl: provider.baseUrl })
    const failure = await jev.decide("estado", TRIAGE_QUESTIONS).then(() => null, (e: unknown) => e as DecisionError)
    expect(failure?.code).toBe("SHAPE")
  } finally {
    await provider.close()
  }
  const second = await mockProvider(() => ({
    status: 200,
    body: { model: "jev-1.13.0", answers: { intent: { type: "choice", choice: "inventada", probabilities: { inventada: 1 } } } },
  }))
  try {
    const jev = createJevDecisionModel({ apiKey: "x", baseUrl: second.baseUrl })
    const failure = await jev.decide("estado", TRIAGE_QUESTIONS).then(() => null, (e: unknown) => e as DecisionError)
    expect(failure?.code).toBe("SHAPE")
  } finally {
    await second.close()
  }
})

it("el plazo cubre también la lectura del cuerpo: un proveedor que no termina la respuesta no cuelga", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.write("{\"model\":\"jev-1.13.0\",")
    // Nunca cierra la respuesta.
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("sin puerto")
  try {
    const jev = createJevDecisionModel({ apiKey: "x", baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 300 })
    const startedAt = Date.now()
    const failure = await jev.decide("estado", TRIAGE_QUESTIONS).then(() => null, (e: unknown) => e as DecisionError)
    expect(failure?.code).toBe("PROVIDER")
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/** LLM guionizado que devuelve JSON fijo y guarda lo que recibió. */
class JsonModel extends BaseChatModel {
  readonly seen: BaseMessage[][] = []
  constructor(private readonly json: string) {
    super({})
  }
  _llmType(): string {
    return "json-chat"
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages)
    const message = new AIMessage({ content: this.json })
    return { generations: [{ text: this.json, message }] }
  }
}

it("la línea base responde sin probabilidades y descarta valores fuera de las opciones", async () => {
  const chat = new JsonModel('{"requires_reply": true, "handoff": false, "urgency": 1, "intent": "price_or_service_info", "unsubscribe": "no"}')
  const baseline = createBaselineDecisionModel(chat, "modelo-prueba")
  expect(baseline.reportsProbabilities).toBe(false)
  const result = await baseline.decide("Contact (latest): ¿cuánto cuesta una limpieza?", TRIAGE_QUESTIONS)
  // Recibe los mismos criterios de sí o no que Jev: cuando la respalda, decide con la misma regla.
  const system = String(chat.seen[0]?.[0]?.content ?? "")
  expect(system).toContain("True: The contact asks something, requests something or expects an answer.")
  expect(system).toContain("False: A closing, thanks or acknowledgement that needs no reply.")
  expect(answerOf(result, "requires_reply", "yesno")?.probability).toBe(1)
  expect(answerOf(result, "intent", "choice")).toMatchObject({ choice: "price_or_service_info", probabilities: null, confidence: null })
  expect(answerOf(result, "urgency", "score")?.score).toBe(1)
  expect(result.answers.find((a) => a.id === "unsubscribe")?.kind).toBe("declined")
})

it("varios mensajes seguidos del contacto viajan juntos y se leen como uno solo", () => {
  // Uno solo: el estado de siempre.
  expect(triageState([], "¿Cuánto cuesta una limpieza?")).toBe("Contact (latest): ¿Cuánto cuesta una limpieza?")
  // Ráfaga: lo importante puede estar en el primero.
  const state = triageState(
    [{ direction: "in", body: "Gracias por la cita de ayer" }],
    "¿Me pueden ayudar?",
    ["Tengo la cara hinchada desde anoche", "No puedo abrir la boca", null, "Hola"],
  )
  expect(state).toBe(
    [
      "Contact: Gracias por la cita de ayer",
      "Contact (latest, 5 messages sent in a row; read them together as one message):",
      "1. Tengo la cara hinchada desde anoche",
      "2. No puedo abrir la boca",
      "3. [attachment]",
      "4. Hola",
      "5. ¿Me pueden ayudar?",
    ].join("\n"),
  )
  // Acotado: como mucho ocho mensajes, contando el último.
  const long = triageState([], "último", Array.from({ length: 12 }, (_, index) => `m${index + 1}`))
  expect(long.split("\n")).toHaveLength(9)
  expect(long).toContain("1. m6")
  expect(long).not.toContain("m5")
})

it("el modelo falso es determinista y el estado del triaje no lleva datos del contacto", () => {
  const state = triageState([{ direction: "out", body: "Hola, ¿en qué te ayudo?" }], "Quiero hablar con una persona, me duele mucho")
  expect(state).toBe("Clinic: Hola, ¿en qué te ayudo?\nContact (latest): Quiero hablar con una persona, me duele mucho")
  return createFakeDecisionModel()
    .decide(state, TRIAGE_QUESTIONS)
    .then((result) => {
      expect(answerOf(result, "handoff", "yesno")?.probability).toBeGreaterThan(0.7)
      expect(triageOutcome(result)).toMatchObject({ wouldHandoff: true, wouldSkipReply: false })
    })
})

it("lo que no es de la clínica va al texto fijo solo si el modelo de decisión está muy seguro", async () => {
  const { offTopicReply, readRoute, ROUTE_OFF_TOPIC } = await import("./route.js")
  const route = (p: number, handoff = 0.05) =>
    readRoute({
      answers: [
        { id: "handoff", kind: "yesno", probability: handoff },
        { id: "intent", kind: "choice", choice: "off_topic", probabilities: { off_topic: p, other: 1 - p }, confidence: p },
      ],
      model: "prueba",
      usage: null,
      latencyMs: 1,
    }).path
  expect(route(ROUTE_OFF_TOPIC)).toBe("fuera_de_tema")
  // Con duda (medido: «se me cayó una calza mientras comía» salió con 0.64) va al camino abierto.
  expect(route(0.64)).toBe("abierto")
  // Pedir una persona manda sobre todo lo demás.
  expect(route(0.99, 0.95)).toBe("derivar")
  expect(TRIAGE_QUESTIONS.find((q) => q.id === "intent")).toMatchObject({ options: expect.arrayContaining([expect.objectContaining({ value: "off_topic" })]) })
  expect(offTopicReply("usted", "Sofi", "Dental Smile")).toBe(
    "Soy Sofi, asistente virtual de Dental Smile. Solo puedo ayudarle con temas de la clínica: citas, tratamientos, precios o sedes. ¿En qué le ayudo?",
  )
  expect(offTopicReply(null, "Vale", "Dental Smile")).toContain("Soy Vale, asistente virtual de Dental Smile. Solo puedo ayudarte")
})

it("la respuesta fija no duplica el punto de una razón social", async () => {
  const { offTopicReply } = await import("./route.js")
  expect(offTopicReply("tu", "Sofi", "Dental Smile S.A.C.")).toMatch(/^Soy Sofi, asistente virtual de Dental Smile S\.A\.C\. Solo puedo/)
})

it("la regla de la ráfaga solo cambia el camino «saludo» y solo con más de un mensaje", async () => {
  const { guardBurst } = await import("./route.js")
  const route = (path: "saludo" | "cita") => ({ path, intent: null, handoff: null, confidence: null, urgency: null })
  expect(guardBurst(route("saludo"), 1).path).toBe("saludo")
  expect(guardBurst(route("saludo"), 2).path).toBe("abierto")
  expect(guardBurst(route("cita"), 4).path).toBe("cita")
})

it("spam solo con el modelo de decisión muy seguro y nunca si habla de la clínica o pide una persona (ADR 0054)", async () => {
  const { readRoute, ROUTE_SPAM } = await import("./route.js")
  const spamOf = (notSpam: number, intent = "other", intentP = 0.7, handoff = 0.05) =>
    readRoute({
      answers: [
        { id: "handoff", kind: "yesno", probability: handoff },
        { id: "intent", kind: "choice", choice: intent, probabilities: { [intent]: intentP, other: 1 - intentP }, confidence: intentP },
        {
          id: "spam",
          kind: "choice",
          choice: notSpam >= 0.5 ? "not_spam" : "scam",
          probabilities: { not_spam: notSpam, scam: (1 - notSpam) * 0.8, advertising: (1 - notSpam) * 0.2 },
          confidence: 0.9,
        },
      ],
      model: "prueba",
      usage: null,
      latencyMs: 1,
    }).spam
  expect(spamOf(0.02)).toEqual({ probability: 0.98, reason: "estafa" })
  expect((spamOf(0.02)?.probability ?? 0) >= ROUTE_SPAM).toBe(true)
  expect((spamOf(0.3)?.probability ?? 0) >= ROUTE_SPAM).toBe(false)
  // Hablar de una cita, un precio o reclamar nunca es spam, diga lo que diga la pregunta de spam.
  expect(spamOf(0.02, "appointment_request")).toBeNull()
  expect(spamOf(0.02, "complaint")).toBeNull()
  // Pedir una persona tampoco.
  expect(spamOf(0.02, "other", 0.7, 0.95)).toBeNull()
  expect(TRIAGE_QUESTIONS.find((q) => q.id === "spam")).toMatchObject({ kind: "choice", options: expect.arrayContaining([expect.objectContaining({ value: "not_spam" })]) })
})
