import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { agentKnowledgeGap, agentLesson, agentReviewItem } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { conversation, message } from "@odentia/db/schema/crm"
import { and, desc, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { recordAnswerTrace } from "./agent-case.js"
import {
  addReviewToAnswer,
  approveLesson,
  correctAnswer,
  countLearningPending,
  discardLesson,
  flagAnswerForReview,
  formatLessonExamples,
  formatLessonRules,
  getAnswerConversation,
  getLearningOverview,
  getLesson,
  getReviewConversation,
  LESSON_KIND_BY_FAILURE,
  LESSON_RULE_LIMIT,
  lessonImpact,
  lessonsForTurn,
  listReviewItems,
  listTestCases,
  markReviewOk,
  noteLessonUse,
  proposeExampleFromReview,
  reopenReviewItem,
  restoreLesson,
  saveTestCase,
  syncReviewQueue,
  updateLesson,
  withdrawLesson,
} from "./agent-learning.js"
import { createConnection } from "./connections.js"
import { type IngestDeps, ingestInbound, sendOutbound } from "./conversations.js"
import {
  createKnowledgeEntry,
  getKnowledgeEntry,
  listActiveKnowledge,
  recordKnowledgeGap,
  searchPublishedKnowledge,
  setKnowledgeStatus,
  updateKnowledgeEntry,
} from "./knowledge.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Aprender: lo que entra a revisión, la corrección, la lección que se aprueba y cómo se retira. */
setupTestDb()
const ORG = "org_a"
const OTHER = "org_b"
const OWNER = "learn-owner"
const KEY = secretsKeyFromEnv("ab".repeat(32))

beforeAll(async () => {
  await ownerDb.insert(user).values([{ id: OWNER, name: "Carmen", email: "carmen@learn.test", emailVerified: true }])
  await ownerDb.insert(member).values([
    { id: `m-${OWNER}`, userId: OWNER, organizationId: ORG, role: "owner", createdAt: new Date() },
  ])
})

function run<T>(fn: (tx: Db) => Promise<T>, org = ORG): Promise<T> {
  return withOrgContext(appDb, org, fn)
}

const stubAdapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: { templates: false, media: true, interactive: false, readReceipts: false, edit: true },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "stub-1" }),
  validateConnection: async () => ({ externalId: "bot-1", displayName: "Bot" }),
}
const unused = async (): Promise<never> => {
  throw new Error("no usado")
}
const storageStub: Storage = {
  putAvatar: unused,
  deleteByUrl: async () => {},
  putAttachment: unused,
  attachmentUrl: async (key) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: unused,
  putPatientAvatar: unused,
}
const deps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY }

let connId: string
let events = 0

/** Un mensaje entrante del interlocutor; devuelve la conversación y el mensaje. */
async function inbound(sender: string, text: string): Promise<{ conversationId: string; messageId: string }> {
  connId ??= await run((tx) =>
    createConnection(tx, ORG, KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } },
      { fetch, validateExternal: false }).then((c) => c.id))
  events += 1
  const event: NormalizedInbound = {
    externalEventId: `evt-learn-${events}`, externalMessageId: `evt-learn-${events}`,
    externalThreadId: `tg:${sender}`, senderExternalId: `tg:${sender}`, senderDisplayName: sender,
    content: { type: "text", text }, sentAt: new Date().toISOString(),
  }
  const job: InboundMessageJob = { orgId: ORG, connectionId: connId, event }
  const { conversationId } = await run((tx) => ingestInbound(tx, job, stubAdapter, deps))
  const [last] = await run((tx) =>
    tx.select({ id: message.id }).from(message)
      .where(and(eq(message.conversationId, conversationId), eq(message.direction, "in")))
      .orderBy(desc(message.createdAt)).limit(1))
  return { conversationId, messageId: last!.id }
}

/** El agente responde: su mensaje y la traza de en qué se basó. */
async function agentReplies(conversationId: string, triggerMessageId: string, text: string): Promise<string> {
  const sent = await run((tx) => sendOutbound(tx, ORG, { conversationId, senderKind: "agent", content: { type: "text", text } }))
  return run((tx) =>
    recordAnswerTrace(tx, ORG, {
      conversationId, triggerMessageId, messageId: sent.id, outcome: "enviada", replyText: text, basis: [], checks: [],
    }))
}

async function reviewOf(traceId: string) {
  const [row] = await ownerDb.select().from(agentReviewItem).where(eq(agentReviewItem.traceId, traceId))
  return row ?? null
}

describe("por revisar", () => {
  it("entra lo que el equipo retomó y lo que el interlocutor tuvo que repetir; lo demás no", async () => {
    const taken = await inbound("lucia", "¿Atienden a niños de 2 años?")
    const takenTrace = await agentReplies(taken.conversationId, taken.messageId, "Sí, atendemos niños. ¿Te busco una cita?")
    await run((tx) => sendOutbound(tx, ORG, {
      conversationId: taken.conversationId, senderKind: "user", senderUserId: OWNER,
      content: { type: "text", text: "Atendemos niños desde los 3 años." },
    }))

    const repeated = await inbound("andres", "¿Tienen estacionamiento para autos?")
    const repeatedTrace = await agentReplies(repeated.conversationId, repeated.messageId, "Nuestra sede está en Av. Larco 345.")
    await inbound("andres", "Pero ¿tienen estacionamiento para autos o no?")

    const fine = await inbound("elena", "¿Cuánto cuesta una limpieza?")
    const fineTrace = await agentReplies(fine.conversationId, fine.messageId, "La profilaxis cuesta S/ 90.00.")
    await inbound("elena", "Perfecto, gracias.")

    await run((tx) => syncReviewQueue(tx, ORG))
    expect(await reviewOf(takenTrace)).toMatchObject({
      reason: "equipo_tomo", status: "pendiente",
      question: "¿Atienden a niños de 2 años?", teamReply: "Atendemos niños desde los 3 años.",
    })
    expect(await reviewOf(repeatedTrace)).toMatchObject({ reason: "repitio_pregunta", teamReply: null })
    // Una respuesta normal solo entra por muestra al azar, nunca por estas dos señales.
    expect((await reviewOf(fineTrace))?.reason ?? "muestra").toBe("muestra")

    // Conciliar otra vez no duplica ni cambia lo que ya estaba.
    const before = await ownerDb.select({ id: agentReviewItem.id }).from(agentReviewItem)
    expect(await run((tx) => syncReviewQueue(tx, ORG))).toBe(0)
    expect(await ownerDb.select({ id: agentReviewItem.id }).from(agentReviewItem)).toHaveLength(before.length)

    const listed = await run((tx) => listReviewItems(tx, ORG))
    expect(listed.find((item) => item.traceId === takenTrace)).toMatchObject({ contactName: "lucia", channel: "telegram" })
    // Otra organización no ve nada.
    expect(await run((tx) => listReviewItems(tx, OTHER), OTHER)).toEqual([])
  })

  it("«estuvo bien» la quita de la lista y no propone nada", async () => {
    const asked = await inbound("ok-case", "¿Abren los feriados?")
    const traceId = await agentReplies(asked.conversationId, asked.messageId, "Los feriados no atendemos.")
    const item = await run((tx) => flagAnswerForReview(tx, ORG, OWNER, traceId))
    expect(item).toMatchObject({ reason: "marcada", status: "pendiente", question: "¿Abren los feriados?" })
    // Marcar dos veces devuelve la misma entrada.
    expect((await run((tx) => flagAnswerForReview(tx, ORG, OWNER, traceId))).id).toBe(item.id)
    await run((tx) => markReviewOk(tx, ORG, OWNER, item.id))
    expect((await reviewOf(traceId))?.status).toBe("bien")
    await expect(run((tx) => markReviewOk(tx, ORG, OWNER, item.id))).rejects.toMatchObject({ code: "REVIEW_NOT_PENDING" })
    expect(await ownerDb.select().from(agentLesson).where(eq(agentLesson.reviewItemId, item.id))).toEqual([])
  })

  it("«estuvo bien» como ejemplo propone la respuesta tal cual y dice que sale de una respuesta buena", async () => {
    const asked = await inbound("ejemplo-bueno", "¿Aceptan pago con tarjeta?")
    const traceId = await agentReplies(asked.conversationId, asked.messageId, "Sí, aceptamos tarjeta de crédito y débito.")
    const item = await run((tx) => flagAnswerForReview(tx, ORG, OWNER, traceId))
    // Primero se da por buena; el ejemplo se propone después, desde su aviso.
    await run((tx) => markReviewOk(tx, ORG, OWNER, item.id))
    const lesson = await run((tx) => proposeExampleFromReview(tx, ORG, OWNER, item.id))
    expect(lesson).toMatchObject({
      kind: "ejemplo", source: "aprendida", scope: "recepcion", agent: "recepcion", status: "propuesta",
      origin: "respuesta_buena", contactName: "ejemplo-bueno", body: "Sí, aceptamos tarjeta de crédito y débito.",
    })
    // Una sola vez, y con su lección ya no se puede deshacer.
    await expect(run((tx) => proposeExampleFromReview(tx, ORG, OWNER, item.id))).rejects.toMatchObject({ code: "REVIEW_NOT_PENDING" })
    await expect(run((tx) => reopenReviewItem(tx, ORG, OWNER, item.id))).rejects.toMatchObject({ code: "REVIEW_NOT_REOPENABLE" })
    await run((tx) => discardLesson(tx, ORG, OWNER, lesson.id))
  })

  it("«deshacer» la devuelve a la lista, y una respuesta dada por buena todavía se puede corregir", async () => {
    const asked = await inbound("deshacer", "¿Atienden los domingos?")
    const traceId = await agentReplies(asked.conversationId, asked.messageId, "Sí, todos los días.")
    const item = await run((tx) => flagAnswerForReview(tx, ORG, OWNER, traceId))
    await run((tx) => markReviewOk(tx, ORG, OWNER, item.id))
    await run((tx) => reopenReviewItem(tx, ORG, OWNER, item.id))
    expect(await reviewOf(traceId)).toMatchObject({ status: "pendiente", decidedBy: null, decidedAt: null })
    // Solo se deshace lo que estaba como bien.
    await expect(run((tx) => reopenReviewItem(tx, ORG, OWNER, item.id))).rejects.toMatchObject({ code: "REVIEW_NOT_REOPENABLE" })

    await run((tx) => markReviewOk(tx, ORG, OWNER, item.id))
    const lesson = await run((tx) => correctAnswer(tx, ORG, OWNER, { traceId, failure: "dato_equivocado", correctedReply: "Los domingos no atendemos." }))
    expect(lesson).toMatchObject({ kind: "respuesta_oficial", status: "propuesta" })
    expect((await reviewOf(traceId))?.status).toBe("corregida")
    await run((tx) => discardLesson(tx, ORG, OWNER, lesson.id))
  })

  it("lo corto dice lo que se le dijo antes, y lo escrito seguido se muestra entero", async () => {
    const asked = await inbound("seguido", "Hola")
    await agentReplies(asked.conversationId, asked.messageId, "¿Le envío el enlace para elegir su cita?")
    const yes = await inbound("seguido", "Si")
    const yesTrace = await agentReplies(yes.conversationId, yes.messageId, "Aquí tiene su enlace.")
    const item = await run((tx) => flagAnswerForReview(tx, ORG, OWNER, yesTrace))
    const listed = (await run((tx) => listReviewItems(tx, ORG))).find((row) => row.id === item.id)
    expect(listed).toMatchObject({ question: "Si", before: "¿Le envío el enlace para elegir su cita?", query: null, asked: null })

    // La conversación alrededor: lo anterior, lo que escribió, la respuesta y lo que el equipo escribió después.
    await run((tx) => sendOutbound(tx, ORG, {
      conversationId: yes.conversationId, senderKind: "user", senderUserId: OWNER,
      content: { type: "text", text: "Te escribo yo." },
    }))
    const around = await run((tx) => getAnswerConversation(tx, ORG, yesTrace))
    expect(around.messages.map((row) => [row.role, row.from, row.body])).toEqual([
      ["antes", "agente", "¿Le envío el enlace para elegir su cita?"],
      ["escribio", "persona", "Si"],
      ["respondio", "agente", "Aquí tiene su enlace."],
      ["equipo", "equipo", "Te escribo yo."],
    ])
    expect(around.lessonKinds).toEqual(LESSON_KIND_BY_FAILURE)
    expect((await run((tx) => getReviewConversation(tx, ORG, item.id))).messages).toEqual(around.messages)
    await expect(run((tx) => getReviewConversation(tx, OTHER, item.id), OTHER)).rejects.toMatchObject({ code: "NOT_FOUND" })

    // Lo que entra por una señal lleva todo lo que escribió seguido, no solo el último mensaje.
    const first = await inbound("rafaga", "¿Tienen alineadores?")
    const second = await inbound("rafaga", "¿Y brackets?")
    const burstTrace = await agentReplies(second.conversationId, second.messageId, "Sí, brackets metálicos.")
    expect(first.conversationId).toBe(second.conversationId)
    await run((tx) => sendOutbound(tx, ORG, {
      conversationId: second.conversationId, senderKind: "user", senderUserId: OWNER,
      content: { type: "text", text: "Alineadores no." },
    }))
    await run((tx) => syncReviewQueue(tx, ORG))
    expect((await reviewOf(burstTrace))?.question).toBe("¿Tienen alineadores?\n¿Y brackets?")
  })
})

describe("lo que buscó y no encontró", () => {
  const gapsOf = (reviewItemId: string) =>
    ownerDb.select().from(agentKnowledgeGap).where(eq(agentKnowledgeGap.reviewItemId, reviewItemId))
  const rowOf = async (query: string) => (await run((tx) => listReviewItems(tx, ORG))).find((row) => row.query === query)

  it("entra a «Por revisar» aunque su aviso sea un pase al equipo, sin traza, y se cuenta sin abrir la lista", async () => {
    const asked = await inbound("sin-traza", "¿Tienen estacionamiento para motos?")
    await run((tx) => recordKnowledgeGap(tx, ORG, {
      conversationId: asked.conversationId, triggerMessageId: asked.messageId,
      question: "¿Tienen estacionamiento para motos?", query: "estacionamiento motos",
    }))
    const pending = (await run((tx) => countLearningPending(tx, ORG))).review
    // Sofi aún no responde: la fila espera su respuesta, y el número también.
    await run((tx) => syncReviewQueue(tx, ORG))
    expect(await rowOf("estacionamiento motos")).toBeUndefined()
    expect((await run((tx) => countLearningPending(tx, ORG))).review).toBe(pending)

    // El aviso de un pase sale como cualquier mensaje del agente y no deja traza.
    await run((tx) => sendOutbound(tx, ORG, {
      conversationId: asked.conversationId, senderKind: "agent",
      content: { type: "text", text: "Se lo confirma el equipo por aquí." },
    }))
    expect((await run((tx) => countLearningPending(tx, ORG))).review).toBe(pending + 1)
    await run((tx) => syncReviewQueue(tx, ORG))
    const row = await rowOf("estacionamiento motos")
    expect(row).toMatchObject({
      reason: "no_encontro", traceId: null, status: "pendiente", question: "¿Tienen estacionamiento para motos?",
      reply: "Se lo confirma el equipo por aquí.", asked: { total: 1, week: 1 }, contactName: "sin-traza",
    })
    // El mismo número antes y después de abrir la lista.
    expect((await run((tx) => countLearningPending(tx, ORG))).review).toBe(pending + 1)
    expect((await run((tx) => getReviewConversation(tx, ORG, row!.id))).messages.map((message) => message.role)).toEqual(["escribio", "respondio"])
    // Conciliar otra vez no duplica.
    expect(await run((tx) => syncReviewQueue(tx, ORG))).toBe(0)
  })

  it("no se queda esperando para siempre: pasado el plazo entra sin respuesta", async () => {
    const asked = await inbound("sin-respuesta", "¿Hacen implantes cigomáticos?")
    const id = await run((tx) => recordKnowledgeGap(tx, ORG, {
      conversationId: asked.conversationId, triggerMessageId: asked.messageId,
      question: "¿Hacen implantes cigomáticos?", query: "implantes cigomaticos",
    }))
    await ownerDb.update(agentKnowledgeGap).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(eq(agentKnowledgeGap.id, id!))
    await run((tx) => syncReviewQueue(tx, ORG))
    expect(await rowOf("implantes cigomaticos")).toMatchObject({ reason: "no_encontro", reply: "" })
  })

  it("la misma búsqueda de varias personas es una fila, con las veces que se preguntó", async () => {
    const first = await inbound("misma-1", "¿Tienen wifi?")
    const second = await inbound("misma-2", "¿Hay wifi?")
    const third = await inbound("misma-3", "¿Tienen wifi?")
    for (const [asked, question, query] of [
      [first, "¿Tienen wifi?", "wifi sede"],
      [second, "¿Hay wifi?", "wifi sede"],
      [third, "¿Tienen wifi?", "internet"],
    ] as const) {
      await run((tx) => recordKnowledgeGap(tx, ORG, { conversationId: asked.conversationId, triggerMessageId: asked.messageId, question, query }))
      await run((tx) => sendOutbound(tx, ORG, { conversationId: asked.conversationId, senderKind: "agent", content: { type: "text", text: "No tengo ese dato." } }))
    }
    await run((tx) => syncReviewQueue(tx, ORG))
    const rows = (await run((tx) => listReviewItems(tx, ORG))).filter((row) => row.query === "wifi sede" || row.query === "internet")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.asked).toEqual({ total: 3, week: 3 })
  })

  it("una respuesta que ya estaba por otra señal queda en esa fila, con este motivo", async () => {
    const asked = await inbound("ya-marcada", "¿Hacen carillas de porcelana?")
    const traceId = await agentReplies(asked.conversationId, asked.messageId, "No tengo ese dato.")
    const flagged = await run((tx) => flagAnswerForReview(tx, ORG, OWNER, traceId))
    await run((tx) => recordKnowledgeGap(tx, ORG, {
      conversationId: asked.conversationId, triggerMessageId: asked.messageId,
      question: "¿Hacen carillas de porcelana?", query: "carillas porcelana",
    }))
    await ownerDb.update(agentKnowledgeGap).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(agentKnowledgeGap.query, "carillas porcelana"))
    await run((tx) => syncReviewQueue(tx, ORG))
    expect(await reviewOf(traceId)).toMatchObject({ id: flagged.id, reason: "no_encontro", query: "carillas porcelana" })
    expect((await gapsOf(flagged.id)).map((gap) => gap.query)).toEqual(["carillas porcelana"])
  })

  it("una prueba del chat web no entra", async () => {
    const asked = await inbound("prueba-chat", "¿Tienen sala de juegos?")
    await run((tx) => recordKnowledgeGap(tx, ORG, {
      conversationId: asked.conversationId, triggerMessageId: asked.messageId, question: "¿Tienen sala de juegos?", query: "sala de juegos",
    }))
    await ownerDb.update(conversation).set({ isTest: true }).where(eq(conversation.id, asked.conversationId))
    const before = (await run((tx) => countLearningPending(tx, ORG))).review
    await ownerDb.update(agentKnowledgeGap).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(eq(agentKnowledgeGap.query, "sala de juegos"))
    await run((tx) => syncReviewQueue(tx, ORG))
    expect(await rowOf("sala de juegos")).toBeUndefined()
    expect((await run((tx) => countLearningPending(tx, ORG))).review).toBe(before)
  })

  /** Una fila lista para decidir. */
  async function searchedRow(sender: string, question: string, query: string) {
    const asked = await inbound(sender, question)
    await run((tx) => recordKnowledgeGap(tx, ORG, { conversationId: asked.conversationId, triggerMessageId: asked.messageId, question, query }))
    await run((tx) => sendOutbound(tx, ORG, { conversationId: asked.conversationId, senderKind: "agent", content: { type: "text", text: "No tengo ese dato." } }))
    await run((tx) => syncReviewQueue(tx, ORG))
    return (await rowOf(query))!
  }

  it("«estuvo bien» la cierra sin enseñar nada, y «deshacer» la vuelve a abrir", async () => {
    const row = await searchedRow("alineadores", "¿Trabajan con alineadores invisibles?", "alineadores invisibles")
    await run((tx) => markReviewOk(tx, ORG, OWNER, row.id))
    expect((await gapsOf(row.id))[0]).toMatchObject({ status: "descartada", resolvedBy: OWNER })
    expect(await rowOf("alineadores invisibles")).toBeUndefined()
    await run((tx) => reopenReviewItem(tx, ORG, OWNER, row.id))
    expect((await gapsOf(row.id))[0]).toMatchObject({ status: "abierta", resolvedBy: null, resolvedAt: null })
    expect(await rowOf("alineadores invisibles")).toMatchObject({ id: row.id })
    await run((tx) => markReviewOk(tx, ORG, OWNER, row.id))
    // Si vuelven a preguntar, vuelve a entrar: para que no vuelva, se le enseña.
    const again = await searchedRow("alineadores-2", "¿Tienen alineadores invisibles?", "alineadores invisibles")
    expect(again.id).not.toBe(row.id)
    await run((tx) => markReviewOk(tx, ORG, OWNER, again.id))
  })

  it("corregirla pasa por una lección: al aprobarla, lo buscado se encuentra y se retira desde «Lo aprendido»", async () => {
    const row = await searchedRow("ortodoncia", "¿Y una extracción de la muela del juicio?", "ortodoncia invisible")
    const lesson = await run((tx) => correctAnswer(tx, ORG, OWNER, {
      reviewItemId: row.id, failure: "falto_dato", question: "Ortodoncia invisible", correctedReply: "No trabajamos con ortodoncia invisible.",
    }))
    expect(lesson).toMatchObject({ kind: "respuesta_oficial", status: "propuesta", title: "Ortodoncia invisible", question: "Ortodoncia invisible" })
    expect((await gapsOf(row.id))[0]).toMatchObject({ status: "resuelta", resolvedEntryId: null })
    // Nada se publica hasta aprobarla.
    expect((await run((tx) => listActiveKnowledge(tx, ORG))).map((entry) => entry.title)).not.toContain("Ortodoncia invisible")

    const active = await run((tx) => approveLesson(tx, ORG, OWNER, lesson.id))
    expect((await gapsOf(row.id))[0]?.resolvedEntryId).toBe(active.knowledgeEntryId)
    const entry = await run((tx) => getKnowledgeEntry(tx, ORG, active.knowledgeEntryId!))
    // Lo buscado es igual a su título: no se repite como otra forma de preguntar.
    expect(entry.askForms).toEqual([])
    expect((await run((tx) => searchPublishedKnowledge(tx, ORG, "ortodoncia invisible")))[0]?.id).toBe(entry.id)
    expect((await run((tx) => getLearningOverview(tx, ORG))).learned.map((item) => item.id)).toContain(lesson.id)

    await run((tx) => withdrawLesson(tx, ORG, OWNER, lesson.id, { withdrawCase: true }))
    expect((await run((tx) => listActiveKnowledge(tx, ORG))).map((item) => item.title)).not.toContain("Ortodoncia invisible")
  })

  it("lo buscado queda como otra forma de preguntar, también al cambiar una respuesta que ya existía", async () => {
    const row = await searchedRow("bicis", "¿Dónde dejo mi bici?", "dejar bicicleta")
    const lesson = await run((tx) => correctAnswer(tx, ORG, OWNER, {
      reviewItemId: row.id, failure: "falto_dato", question: "Bicicletero", correctedReply: "Hay un bicicletero en la entrada.",
    }))
    const active = await run((tx) => approveLesson(tx, ORG, OWNER, lesson.id))
    const entry = await run((tx) => getKnowledgeEntry(tx, ORG, active.knowledgeEntryId!))
    expect(entry.askForms).toEqual(["dejar bicicleta"])
    await run((tx) => withdrawLesson(tx, ORG, OWNER, lesson.id, { withdrawCase: true }))
  })

  it("sumarla a una respuesta que ya existe no cambia su texto y no deja lección", async () => {
    const entry = await run((tx) => createKnowledgeEntry(tx, ORG, OWNER, { kind: "faq", title: "Convenios", body: "Trabajamos con Pacífico." }))
    await run((tx) => setKnowledgeStatus(tx, ORG, OWNER, entry.id, "publicada"))
    const row = await searchedRow("seguro", "¿Aceptan mi seguro?", "aceptan seguro privado")
    const linked = await run((tx) => addReviewToAnswer(tx, ORG, OWNER, row.id, entry.id))
    expect(linked).toMatchObject({ body: "Trabajamos con Pacífico.", version: 1, askForms: ["aceptan seguro privado"] })
    expect((await gapsOf(row.id))[0]).toMatchObject({ status: "resuelta", resolvedEntryId: entry.id, resolvedBy: OWNER })
    expect((await ownerDb.select().from(agentReviewItem).where(eq(agentReviewItem.id, row.id)))[0]?.status).toBe("corregida")
    expect(await ownerDb.select().from(agentLesson).where(eq(agentLesson.reviewItemId, row.id))).toEqual([])
    await expect(run((tx) => addReviewToAnswer(tx, ORG, OWNER, row.id, entry.id))).rejects.toMatchObject({ code: "REVIEW_NOT_PENDING" })
  })

  it("solo lo que no encontró se suma a una respuesta", async () => {
    const asked = await inbound("no-suma", "¿Abren tarde?")
    const traceId = await agentReplies(asked.conversationId, asked.messageId, "Hasta las 8.")
    const item = await run((tx) => flagAnswerForReview(tx, ORG, OWNER, traceId))
    await expect(run((tx) => addReviewToAnswer(tx, ORG, OWNER, item.id, item.id))).rejects.toMatchObject({ code: "VALIDATION" })
  })
})

describe("corregir propone una lección; nada cambia hasta aprobarla", () => {
  it("un dato que faltaba se propone como respuesta oficial y solo al aprobarla llega al conocimiento", async () => {
    const asked = await inbound("mateo", "¿Tienen bicicletero en la sede?")
    const traceId = await agentReplies(asked.conversationId, asked.messageId, "No tengo ese dato.")
    await expect(run((tx) => correctAnswer(tx, ORG, OWNER, { traceId, failure: "falto_dato" }))).rejects.toThrow(/cómo debió responder/)
    const lesson = await run((tx) =>
      correctAnswer(tx, ORG, OWNER, { traceId, failure: "falto_dato", correctedReply: "Sí, hay un bicicletero techado en la entrada." }))
    expect(lesson).toMatchObject({
      kind: "respuesta_oficial", scope: "clinica", status: "propuesta",
      title: "¿Tienen bicicletero en la sede?", originalReply: "No tengo ese dato.",
      knowledgeEntryId: null, proposedByName: "Carmen",
      // De dónde sale: una corrección a una respuesta de Recepción, la que recibió esa persona.
      agent: "recepcion", origin: "correccion", contactName: "mateo",
    })
    expect((await reviewOf(traceId))?.status).toBe("corregida")
    // La misma respuesta no se corrige dos veces.
    await expect(run((tx) => correctAnswer(tx, ORG, OWNER, { traceId, failure: "tono", correctedReply: "Otra" })))
      .rejects.toMatchObject({ code: "REVIEW_NOT_PENDING" })
    // Propuesta: el agente todavía no la conoce.
    const titles = async () => (await run((tx) => listActiveKnowledge(tx, ORG))).map((entry) => entry.title)
    expect(await titles()).not.toContain("¿Tienen bicicletero en la sede?")
    expect(await run((tx) => countLearningPending(tx, ORG))).toMatchObject({ lessons: 1 })

    const active = await run((tx) => approveLesson(tx, ORG, OWNER, lesson.id))
    expect(active).toMatchObject({ status: "activa", approvedByName: "Carmen", previousBody: null })
    expect(active.knowledgeEntry).toEqual({ title: "¿Tienen bicicletero en la sede?", body: "Sí, hay un bicicletero techado en la entrada." })
    expect(await titles()).toContain("¿Tienen bicicletero en la sede?")
    // Su pregunta queda como caso de prueba.
    expect(await run((tx) => listTestCases(tx, ORG))).toEqual([
      expect.objectContaining({ question: "¿Tienen bicicletero en la sede?", expected: "Sí, hay un bicicletero techado en la entrada.", lessonId: lesson.id }),
    ])
    await expect(run((tx) => approveLesson(tx, ORG, OWNER, lesson.id))).rejects.toMatchObject({ code: "LESSON_NOT_PROPOSED" })

    // Retirar la despublica al instante; restaurar la vuelve a publicar.
    const withdrawn = await run((tx) => withdrawLesson(tx, ORG, OWNER, lesson.id))
    expect(withdrawn.status).toBe("retirada")
    expect(await titles()).not.toContain("¿Tienen bicicletero en la sede?")
    expect(await run((tx) => listTestCases(tx, ORG))).toHaveLength(1)
    await run((tx) => restoreLesson(tx, ORG, OWNER, lesson.id))
    expect(await titles()).toContain("¿Tienen bicicletero en la sede?")
    await run((tx) => withdrawLesson(tx, ORG, OWNER, lesson.id, { withdrawCase: true }))
    expect(await run((tx) => listTestCases(tx, ORG))).toEqual([])
  })

  it("si ya había una respuesta oficial sobre eso, la lección la cambia y retirarla devuelve el texto anterior", async () => {
    const entry = await run((tx) => createKnowledgeEntry(tx, ORG, OWNER, { kind: "faq", title: "Atención a niños", body: "Sí, atendemos niños." }))
    await run((tx) => setKnowledgeStatus(tx, ORG, OWNER, entry.id, "publicada"))
    const asked = await inbound("ninos", "atención a niños")
    const traceId = await agentReplies(asked.conversationId, asked.messageId, "Sí, atendemos niños. ¿Te busco una cita?")
    const lesson = await run((tx) =>
      correctAnswer(tx, ORG, OWNER, { traceId, failure: "dato_equivocado", correctedReply: "Atendemos niños desde los 3 años." }))
    expect(lesson.knowledgeEntryId).toBe(entry.id)
    expect(lesson.knowledgeEntry).toEqual({ title: "Atención a niños", body: "Sí, atendemos niños." })

    const active = await run((tx) => approveLesson(tx, ORG, OWNER, lesson.id))
    expect(active.previousBody).toBe("Sí, atendemos niños.")
    expect((await run((tx) => getKnowledgeEntry(tx, ORG, entry.id))).body).toBe("Atendemos niños desde los 3 años.")
    await run((tx) => withdrawLesson(tx, ORG, OWNER, lesson.id))
    expect(await run((tx) => getKnowledgeEntry(tx, ORG, entry.id))).toMatchObject({ body: "Sí, atendemos niños.", status: "publicada" })

    // Si después una persona reescribe esa respuesta, retirar la lección ya no la toca.
    await run((tx) => restoreLesson(tx, ORG, OWNER, lesson.id))
    await run((tx) => updateKnowledgeEntry(tx, ORG, OWNER, entry.id, { body: "Atendemos desde los 4 años, con odontopediatra." }))
    await run((tx) => withdrawLesson(tx, ORG, OWNER, lesson.id))
    expect((await run((tx) => getKnowledgeEntry(tx, ORG, entry.id))).body).toBe("Atendemos desde los 4 años, con odontopediatra.")
  })

  it("una propuesta se edita o se descarta; una vez activa ya no se edita", async () => {
    const asked = await inbound("tono", "¿Cuánto cuesta el blanqueamiento dental?")
    const traceId = await agentReplies(asked.conversationId, asked.messageId, "Queda perfecto, te lo garantizo.")
    const lesson = await run((tx) =>
      correctAnswer(tx, ORG, OWNER, { traceId, failure: "tono", correctedReply: "El resultado depende de cada caso; te lo explica el odontólogo en la evaluación." }))
    expect(lesson).toMatchObject({ kind: "ejemplo", scope: "recepcion", title: "Cuando preguntan: ¿Cuánto cuesta el blanqueamiento dental?" })

    const edited = await run((tx) => updateLesson(tx, ORG, OWNER, lesson.id, { kind: "regla", title: "No prometer resultados", body: "No prometas resultados del blanqueamiento." }))
    expect(edited).toMatchObject({ kind: "regla", scope: "recepcion", title: "No prometer resultados", knowledgeEntryId: null })
    await expect(run((tx) => updateLesson(tx, ORG, OWNER, lesson.id, { kind: "inventada" }))).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { kind: expect.any(String) },
    })

    const other = await inbound("descartar", "¿Venden cepillos?")
    const otherTrace = await agentReplies(other.conversationId, other.messageId, "Sí.")
    const discarded = await run((tx) => correctAnswer(tx, ORG, OWNER, { traceId: otherTrace, failure: "no_debio_responder" }))
    expect(discarded).toMatchObject({ kind: "regla", body: expect.stringContaining("pasa el caso a una persona") })
    expect((await run((tx) => discardLesson(tx, ORG, OWNER, discarded.id))).status).toBe("descartada")
    await expect(run((tx) => approveLesson(tx, ORG, OWNER, discarded.id))).rejects.toMatchObject({ code: "LESSON_NOT_PROPOSED" })

    await run((tx) => approveLesson(tx, ORG, OWNER, lesson.id))
    await expect(run((tx) => updateLesson(tx, ORG, OWNER, lesson.id, { body: "Otra" }))).rejects.toMatchObject({ code: "LESSON_NOT_PROPOSED" })
    await run((tx) => withdrawLesson(tx, ORG, OWNER, lesson.id, { withdrawCase: true }))
  })
})

describe("lo aprendido dentro del turno", () => {
  it("las reglas activas van siempre; los ejemplos, solo si se parecen a la pregunta; retirar los quita", async () => {
    const make = async (sender: string, question: string, failure: "tono" | "no_debio_responder", corrected: string, patch?: { kind: "regla"; body: string }) => {
      const asked = await inbound(sender, question)
      const traceId = await agentReplies(asked.conversationId, asked.messageId, "Respuesta original")
      const lesson = await run((tx) => correctAnswer(tx, ORG, OWNER, { traceId, failure, correctedReply: corrected }))
      if (patch) await run((tx) => updateLesson(tx, ORG, OWNER, lesson.id, patch))
      return run((tx) => approveLesson(tx, ORG, OWNER, lesson.id))
    }
    const rule = await make("regla", "¿Tienen cita el domingo?", "tono", "Los domingos no agendamos.", { kind: "regla", body: "No ofrezcas citas en domingo." })
    const example = await make("ejemplo", "¿Cuánto cuesta la ortodoncia?", "tono", "La ortodoncia empieza con una evaluación de S/ 50.00.")

    const unrelated = await run((tx) => lessonsForTurn(tx, ORG, "recepcion", "Hola, ¿aceptan tarjeta?"))
    expect(unrelated.rules.map((item) => item.id)).toContain(rule.id)
    expect(unrelated.examples).toEqual([])
    expect(unrelated.matchedIds).toEqual([])

    const related = await run((tx) => lessonsForTurn(tx, ORG, "recepcion", "¿Y cuánto me cuesta la ortodoncia?"))
    expect(related.examples.map((item) => item.id)).toEqual([example.id])
    expect(related.matched).toEqual([{ id: example.id, kind: "ejemplo", title: example.title }])
    expect(formatLessonRules(related.rules)).toContain("- No ofrezcas citas en domingo.")
    expect(formatLessonExamples(related.examples)).toContain("Respuesta: «La ortodoncia empieza con una evaluación de S/ 50.00.»")
    // Otro agente no recibe lo de Recepción.
    expect((await run((tx) => lessonsForTurn(tx, ORG, "administrador", "¿Cuánto cuesta la ortodoncia?"))).rules).toEqual([])

    // Probar sin una lección, o con una aún no aprobada, sin tocar nada.
    const without = await run((tx) => lessonsForTurn(tx, ORG, "recepcion", "¿Tienen cita el domingo?", { skipIds: [rule.id] }))
    expect(without.rules.map((item) => item.id)).not.toContain(rule.id)
    const trial = await run((tx) =>
      lessonsForTurn(tx, ORG, "recepcion", "Hola", { extra: [{ id: "prueba", kind: "regla", title: "Nueva", question: "", body: "Saluda por el nombre." }] }))
    expect(trial.rules[0]).toMatchObject({ id: "prueba", body: "Saluda por el nombre." })

    await run((tx) => noteLessonUse(tx, ORG, { lessonIds: related.matchedIds }))
    expect((await run((tx) => getLesson(tx, ORG, example.id))).uses).toBe(1)

    // El caso de la regla toca el tema de una lección que hable de domingos.
    const impact = await run((tx) => lessonImpact(tx, ORG, { ...example, title: "Citas el domingo", question: "¿Atienden el domingo?", body: "No." }))
    expect(impact.touched.map((item) => item.question)).toEqual(["¿Tienen cita el domingo?"])
    expect(impact.total).toBeGreaterThanOrEqual(1)

    await run((tx) => withdrawLesson(tx, ORG, OWNER, rule.id))
    expect((await run((tx) => lessonsForTurn(tx, ORG, "recepcion", "¿Tienen cita el domingo?"))).rules.map((item) => item.id)).not.toContain(rule.id)
    const overview = await run((tx) => getLearningOverview(tx, ORG))
    expect(overview.withdrawn.map((item) => item.id)).toContain(rule.id)
    expect(overview.learned.map((item) => item.id)).toContain(example.id)
  })
})

describe("guardar una prueba como caso", () => {
  it("queda activo sin lección, no se duplica al guardarlo otra vez y no cruza de organización", async () => {
    const question = "¿Atienden los sábados?"
    const first = await run((tx) => saveTestCase(tx, OTHER, OWNER, { question: ` ${question} `, expected: "Sí, de 9:00 a 13:00." }), OTHER)
    expect(first).toMatchObject({ agent: "recepcion", question, expected: "Sí, de 9:00 a 13:00.", lessonId: null, status: "activo" })
    const again = await run((tx) => saveTestCase(tx, OTHER, OWNER, { question, expected: "Sí, los sábados de 9:00 a 13:00." }), OTHER)
    expect(again.id).toBe(first.id)
    const mine = await run((tx) => listTestCases(tx, OTHER, "recepcion"), OTHER)
    expect(mine.filter((item) => item.question === question)).toEqual([expect.objectContaining({ expected: "Sí, los sábados de 9:00 a 13:00." })])
    expect((await run((tx) => listTestCases(tx, ORG))).some((item) => item.id === first.id)).toBe(false)
    await expect(run((tx) => saveTestCase(tx, OTHER, OWNER, { question: "  ", expected: "x" }), OTHER)).rejects.toThrow("La pregunta es obligatorio")
  })
})

describe("las reglas aprendidas llegan todas (decisión 17 de la fase 4)", () => {
  it("van todas hasta el tope; pasado el tope van las más recientes y se dice cuántas quedaron fuera", async () => {
    const org = "org_reglas"
    await insertOrg(ownerDb, org, "org-reglas")
    const rule = (index: number) => ({
      organizationId: org,
      kind: "regla" as const,
      scope: "recepcion",
      title: `Regla ${index}`,
      body: `Regla número ${index}.`,
      status: "activa" as const,
      proposedBy: "agent",
      // La 0 es la más reciente.
      approvedAt: new Date(Date.now() - index * 60_000),
    })
    // Antes eran 20: con 25 llegan todas.
    await ownerDb.insert(agentLesson).values(Array.from({ length: 25 }, (_, i) => rule(i)))
    const some = await withOrgContext(appDb, org, (tx) => lessonsForTurn(tx, org, "recepcion", "Hola"))
    expect(some.rules).toHaveLength(25)
    expect(some.rulesLeftOut).toBe(0)
    expect(formatLessonRules(some.rules, some.rulesLeftOut)).not.toContain("no caben")
    await ownerDb.insert(agentLesson).values(Array.from({ length: LESSON_RULE_LIMIT - 25 + 2 }, (_, i) => rule(25 + i)))
    const over = await withOrgContext(appDb, org, (tx) => lessonsForTurn(tx, org, "recepcion", "Hola"))
    expect(over.rules).toHaveLength(LESSON_RULE_LIMIT)
    expect(over.rules[0]?.title).toBe("Regla 0")
    expect(over.rulesLeftOut).toBe(2)
    expect(formatLessonRules(over.rules, over.rulesLeftOut)).toContain("La clínica tiene 2 reglas más antiguas que no caben aquí")
    // «Aprender» sabe el tope para decirlo.
    expect((await withOrgContext(appDb, org, (tx) => getLearningOverview(tx, org))).ruleLimit).toBe(LESSON_RULE_LIMIT)
  })
})
