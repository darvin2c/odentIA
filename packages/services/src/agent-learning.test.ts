import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { agentLesson, agentReviewItem } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { message } from "@odentia/db/schema/crm"
import { and, desc, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { recordAnswerTrace } from "./agent-case.js"
import {
  approveLesson,
  correctAnswer,
  countLearningPending,
  discardLesson,
  flagAnswerForReview,
  formatLessonExamples,
  formatLessonRules,
  getLearningOverview,
  getLesson,
  LESSON_RULE_LIMIT,
  lessonImpact,
  lessonsForTurn,
  listReviewItems,
  listTestCases,
  markReviewOk,
  noteLessonUse,
  restoreLesson,
  saveTestCase,
  syncReviewQueue,
  updateLesson,
  withdrawLesson,
} from "./agent-learning.js"
import { createConnection } from "./connections.js"
import { type IngestDeps, ingestInbound, sendOutbound } from "./conversations.js"
import { createKnowledgeEntry, getKnowledgeEntry, listActiveKnowledge, setKnowledgeStatus, updateKnowledgeEntry } from "./knowledge.js"
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
    const lesson = await run((tx) => markReviewOk(tx, ORG, OWNER, item.id, { asExample: true }))
    expect(lesson).toMatchObject({
      kind: "ejemplo", scope: "recepcion", agent: "recepcion", status: "propuesta",
      origin: "respuesta_buena", contactName: "ejemplo-bueno", body: "Sí, aceptamos tarjeta de crédito y débito.",
    })
    await run((tx) => discardLesson(tx, ORG, OWNER, lesson!.id))
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
    await expect(run((tx) => updateLesson(tx, ORG, OWNER, lesson.id, { kind: "inventada" }))).rejects.toThrow(/Clase/)

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
