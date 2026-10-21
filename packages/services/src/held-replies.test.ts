import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { agentHandoff } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import {
  agentConfig,
  channelConnection,
  channelTemplate,
  contact,
  contactIdentity,
  conversation,
  crmTask,
  message,
} from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, asc, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { createHandoff } from "./agent-operations.js"
import { upsertAgentConfig } from "./agentConfig.js"
import { handleAutomationReply } from "./automation.js"
import { replyId } from "./automation-messages.js"
import { resumeConversationBySystem } from "./clinic-messages.js"
import { deliverHeldReplies } from "./conversations.js"
import { getInboxConversationDetail } from "./inbox.js"
import { offerPendingHeldReplies } from "./held-replies.js"
import { replyByWhatsApp, replyToTopic, sendTeamReply } from "./topic-reply.js"
import { retakeForgottenTopics, retakeText } from "./topic-retake.js"
import { getWorkspaceHome } from "./workspace.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Fase 3 del pulido de la Bandeja: responder pasadas las 24 horas (R1,
 * «Ver respuesta»), Instagram y Messenger con la ventana cerrada («Escribirle
 * por WhatsApp»), responder desde Inicio (R3 y decisión 3) y «Sofi se ofrece»
 * (decisión 5). Lima es UTC−5, el 12 de octubre de 2026 es lunes y la clínica
 * de prueba escribe de lunes a viernes de 8:00 a 20:00 (el horario que viene).
 */
setupTestDb()

const HOUR = 3_600_000
const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR)

async function clinic() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `pulido-${orgId}`)
  await ownerDb.insert(agentConfig).values({ organizationId: orgId, enabled: true })
  const ownerId = `owner-${orgId}`
  const receptionId = `recep-${orgId}`
  const cashierId = `caja-${orgId}`
  await ownerDb.insert(user).values([
    { id: ownerId, name: "Dueña", email: `${ownerId}@pulido.test`, emailVerified: true },
    { id: receptionId, name: "Rita de Recepción", email: `${receptionId}@pulido.test`, emailVerified: true },
    { id: cashierId, name: "Carla de Caja", email: `${cashierId}@pulido.test`, emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() },
    { id: `m-${receptionId}`, userId: receptionId, organizationId: orgId, role: "reception", createdAt: new Date() },
    { id: `m-${cashierId}`, userId: cashierId, organizationId: orgId, role: "cashier", createdAt: new Date() },
  ])
  const connect = async (provider: "whatsapp_cloud_api" | "instagram") => {
    const [row] = await ownerDb
      .insert(channelConnection)
      .values({
        organizationId: orgId,
        channel: provider === "instagram" ? "instagram" : "whatsapp",
        provider,
        displayName: provider,
        configEncrypted: "config",
        webhookSecret: "secret",
        status: "active",
      })
      .returning()
    return row!.id
  }
  const whatsappId = await connect("whatsapp_cloud_api")
  const run = <T,>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const person = async (name: string) => {
    // La base arma el nombre visible con nombres y apellidos.
    const [given, ...family] = name.split(" ")
    const [row] = await ownerDb.insert(contact).values({ organizationId: orgId, displayName: name, givenNames: given, familyName: family.join(" ") || null }).returning()
    return row!.id
  }
  const thread = async (contactId: string, connectionId: string, values: Partial<typeof conversation.$inferInsert> = {}) => {
    const [row] = await ownerDb
      .insert(conversation)
      .values({ organizationId: orgId, contactId, channelConnectionId: connectionId, externalThreadId: `t:${randomUUID()}`, ...values })
      .returning()
    return row!.id
  }
  const say = async (conversationId: string, body: string, createdAt: Date) => {
    const [row] = await ownerDb
      .insert(message)
      .values({ organizationId: orgId, conversationId, direction: "in", senderKind: "contact", body, createdAt, status: "received", externalId: `ext-${randomUUID()}` })
      .returning()
    return row!.id
  }
  const messages = (conversationId: string) =>
    ownerDb.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(asc(message.createdAt))
  const taskOf = async (taskId: string | null) => (await ownerDb.select().from(crmTask).where(eq(crmTask.id, taskId!)))[0]
  /** Meta aprobó «Ver respuesta» en el WhatsApp de la clínica. */
  const approveAnswerReady = () =>
    ownerDb.insert(channelTemplate).values({
      organizationId: orgId,
      connectionId: whatsappId,
      name: "odentia_ver_respuesta_v1",
      language: "es",
      status: "aprobada",
      category: "utility",
      body: "Hola, {{1}}. {{2}} respondió tu consulta. Toca «Ver respuesta» para leerla.",
      variables: 2,
    })
  return { orgId, ownerId, receptionId, cashierId, whatsappId, connect, run, person, thread, say, messages, taskOf, approveAnswerReady }
}

describe("R1: responder pasadas las 24 horas de WhatsApp", () => {
  it("la respuesta queda por entregar, el tema se resuelve, sale un solo «Ver respuesta» y al tocarlo llegan en orden", async () => {
    const c = await clinic()
    await c.approveAnswerReady()
    const carlos = await c.person("Carlos Paredes")
    const conv = await c.thread(carlos, c.whatsappId, { lastInboundAt: hoursAgo(30) })
    const asked = await c.say(conv, "¿Cuánto cuesta una extracción?", hoursAgo(30))
    const topic = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv, reason: "Precio", summary: "Precio", createdBy: "agent", kind: "precio" }))
    const first = await c.run((tx) => sendTeamReply(tx, c.orgId, {
      conversationId: conv, userId: c.receptionId, content: { type: "text", text: "La simple está en S/ 180" }, replyToMessageId: asked,
    }))
    expect(first).toMatchObject({ status: "held", held: true, replyToMessageId: asked, topicResolved: true })
    // Para el equipo ya está hecho (decisión 4): no depende de que la persona toque el botón.
    expect((await c.taskOf(topic.taskId))?.status).toBe("done")
    const second = await c.run((tx) => sendTeamReply(tx, c.orgId, {
      conversationId: conv, userId: c.receptionId, content: { type: "text", text: "La quirúrgica la ve la doctora" }, replyToMessageId: asked,
    }))
    expect(second.status).toBe("held")
    // Dos respuestas pendientes salen con un solo «Ver respuesta», con el botón de su conversación.
    const offers = (await c.messages(conv)).filter((row) => row.contentType === "template")
    expect(offers).toHaveLength(1)
    expect(offers[0]).toMatchObject({
      templateName: "odentia_ver_respuesta_v1",
      templateParams: ["Carlos", expect.any(String)],
      replyButtons: [{ id: replyId("ver_respuesta", conv), title: "Ver respuesta" }],
      status: "queued",
    })
    expect(offers[0]?.body).toMatch(/^Hola, Carlos\. .+ respondió tu consulta\. Toca «Ver respuesta» para leerla\.$/)
    // El botón de otra conversación no vale aquí.
    const other = await c.thread(carlos, c.whatsappId)
    expect(await c.run((tx) => handleAutomationReply(tx, c.orgId, { conversationId: other, replyId: replyId("ver_respuesta", conv), text: "Ver respuesta" }))).toBe(false)
    // Toca «Ver respuesta»: es una respuesta al botón, no una pregunta; salen las dos en el orden en que se escribieron.
    await ownerDb.update(conversation).set({ lastInboundAt: new Date() }).where(eq(conversation.id, conv))
    expect(await c.run((tx) => handleAutomationReply(tx, c.orgId, { conversationId: conv, replyId: replyId("ver_respuesta", conv), text: "Ver respuesta" }))).toBe(true)
    const replies = (await c.messages(conv)).filter((row) => row.held)
    expect(replies.map((row) => [row.body, row.status])).toEqual([
      ["La simple está en S/ 180", "queued"],
      ["La quirúrgica la ve la doctora", "queued"],
    ])
    // Tocarlo otra vez no repite nada.
    expect(await c.run((tx) => deliverHeldReplies(tx, c.orgId, conv))).toBe(0)
  })

  it("sin «Ver respuesta» aprobado la respuesta espera; el ciclo lo envía cuando Meta lo aprueba y dentro del horario para escribir", async () => {
    const c = await clinic()
    const lucia = await c.person("Lucía Fernández")
    const conv = await c.thread(lucia, c.whatsappId, { lastInboundAt: hoursAgo(40) })
    const asked = await c.say(conv, "¿Atienden los sábados?", hoursAgo(40))
    await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv, reason: "Horario", summary: "Horario", createdBy: "agent" }))
    const sent = await c.run((tx) => sendTeamReply(tx, c.orgId, {
      conversationId: conv, userId: c.receptionId, content: { type: "text", text: "Sí, de 9:00 a 13:00" }, replyToMessageId: asked,
    }))
    expect(sent.status).toBe("held")
    expect((await c.messages(conv)).some((row) => row.contentType === "template")).toBe(false)
    // La zona de escritura lo dice antes: la respuesta saldrá cuando Meta lo apruebe o cuando vuelva a escribir.
    expect((await c.run((tx) => getInboxConversationDetail(tx, c.orgId, conv))).lateReply).toEqual({ answerReady: false, metaWindow: null })
    const tick = (now: Date) => c.run((tx) => offerPendingHeldReplies(tx, c.orgId, now))
    expect(await tick(new Date("2026-10-13T15:00:00Z"))).toBe(0)
    await c.approveAnswerReady()
    // Lunes a las 23:00 de Lima no se escribe por cuenta propia; el martes a las 10:00, sí, y una sola vez.
    expect(await tick(new Date("2026-10-13T04:00:00Z"))).toBe(0)
    expect(await tick(new Date("2026-10-13T15:00:00Z"))).toBe(1)
    expect(await tick(new Date("2026-10-13T15:01:00Z"))).toBe(0)
    // Si vuelve a escribir sin tocar el botón, la respuesta sale igual.
    expect(await c.run((tx) => deliverHeldReplies(tx, c.orgId, conv))).toBe(1)
    expect((await c.messages(conv)).find((row) => row.held)?.status).toBe("queued")
  })

  it("sin citar una pregunta no se guarda nada: WhatsApp solo deja un mensaje aprobado", async () => {
    const c = await clinic()
    const conv = await c.thread(await c.person("Nora Paz"), c.whatsappId, { lastInboundAt: hoursAgo(30) })
    await expect(c.run((tx) => sendTeamReply(tx, c.orgId, { conversationId: conv, userId: c.receptionId, content: { type: "text", text: "Hola" } })))
      .rejects.toMatchObject({ code: "WINDOW_CLOSED" })
  })
})

describe("Instagram y Messenger pasadas las 24 horas (tablero 4b)", () => {
  it("«Escribirle por WhatsApp» guarda la respuesta en su WhatsApp con «Ver respuesta» y resuelve el tema de Instagram", async () => {
    const c = await clinic()
    await c.approveAnswerReady()
    const instagramId = await c.connect("instagram")
    const lucia = await c.person("Lucía Fernández")
    const igThread = await c.thread(lucia, instagramId, { lastInboundAt: hoursAgo(28) })
    const asked = await c.say(igThread, "¿Hacen descuento si vamos dos?", hoursAgo(28))
    const topic = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: igThread, reason: "Descuento", summary: "Descuento", createdBy: "agent" }))
    // Sin WhatsApp marcado como suyo no se ofrece ni se puede.
    expect((await c.run((tx) => getInboxConversationDetail(tx, c.orgId, igThread))).lateReply.metaWindow).toMatchObject({ open: false, whatsapp: false })
    await expect(c.run((tx) => replyByWhatsApp(tx, c.orgId, { conversationId: igThread, userId: c.receptionId, text: "Sí", replyToMessageId: asked })))
      .rejects.toMatchObject({ code: "NO_WHATSAPP" })
    await ownerDb.insert(contactIdentity).values({ organizationId: c.orgId, contactId: lucia, channel: "whatsapp", externalUserId: "wa:51987654305", isPrimary: true })
    expect((await c.run((tx) => getInboxConversationDetail(tx, c.orgId, igThread))).lateReply.metaWindow).toMatchObject({ open: false, whatsapp: true, whatsappOpen: false })
    // «Retomar» dice que es Instagram quien no deja, no WhatsApp.
    const resumed = await c.run((tx) => resumeConversationBySystem(tx, c.orgId, Buffer.alloc(32), igThread, new Date("2026-10-13T15:00:00Z")))
    expect(resumed).toEqual({ sent: false, waiting: expect.stringContaining("Instagram no deja escribirle hasta que vuelva a escribir") })
    const sent = await c.run((tx) => replyByWhatsApp(tx, c.orgId, {
      conversationId: igThread, userId: c.receptionId, text: "Sí: 10 % para cada una", replyToMessageId: asked,
    }))
    expect(sent).toMatchObject({ status: "held", held: true, topicResolved: true })
    expect(sent.conversationId).not.toBe(igThread)
    expect((await c.messages(sent.conversationId)).map((row) => [row.contentType, row.status])).toEqual([
      ["text", "held"],
      ["template", "queued"],
    ])
    expect((await c.taskOf(topic.taskId))?.status).toBe("done")
  })
})

describe("R3 y decisión 3: responder un tema desde Inicio", () => {
  const access = {
    patients: false, appointments: false, conversations: false, tasks: true, finance: true, clinical: false, crm: false,
    agent: false, allTasks: false, configure: false, ownAppointments: false, topics: true,
  }

  it("caja ve los pagos con su pregunta y los responde sin ver la Bandeja; lo demás no le llega ni lo puede tomar", async () => {
    const c = await clinic()
    const andres = await c.person("Andrés Vega")
    const conv = await c.thread(andres, c.whatsappId, { lastInboundAt: hoursAgo(1) })
    const asked = await c.say(conv, "Ya les transferí S/ 180, ¿les llegó?", hoursAgo(1))
    const payment = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv, reason: "Transferencia", summary: "Transferencia", createdBy: "agent", kind: "pago" }))
    await c.say(conv, "¿Y cuánto cuesta el blanqueamiento?", new Date())
    const price = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv, reason: "Precio", summary: "Precio", createdBy: "agent", kind: "precio" }))
    // Un pago va a caja (R3).
    expect((await c.taskOf(payment.taskId))?.area).toBe("caja")
    const home = await c.run((tx) => getWorkspaceHome(tx, c.orgId, c.cashierId, access))
    const cases = home.waiting.filter((row) => row.kind === "case")
    expect(cases).toEqual([expect.objectContaining({ id: payment.id, canReply: true, quote: "Ya les transferí S/ 180, ¿les llegó?", topicKind: "pago" })])
    // Lo que no es un pago no se lo pueden pasar ni lo responde.
    await expect(c.run((tx) => replyToTopic(tx, c.orgId, { topicId: price.id, userId: c.cashierId, text: "Hola" }))).rejects.toThrow("Esa persona no atiende conversaciones")
    const sent = await c.run((tx) => replyToTopic(tx, c.orgId, { topicId: payment.id, userId: c.cashierId, text: "Sí, ya nos llegó. ¡Gracias!" }))
    expect(sent).toMatchObject({ replyToMessageId: asked, topicResolved: true, senderUserId: c.cashierId })
    const [taken] = await ownerDb.select().from(agentHandoff).where(eq(agentHandoff.id, payment.id))
    expect(taken?.assigneeUserId).toBe(c.cashierId)
    expect((await c.taskOf(payment.taskId))?.status).toBe("done")
    // Un tema que tiene otra persona no se responde desde aquí.
    const other = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv, reason: "Otro pago", summary: "Otro pago", createdBy: "agent", kind: "pago", assigneeUserId: c.receptionId }))
    await expect(c.run((tx) => replyToTopic(tx, c.orgId, { topicId: other.id, userId: c.cashierId, text: "Hola" }))).rejects.toMatchObject({ code: "TOPIC_TAKEN" })
  })
})

describe("decisión 5: Sofi se ofrece al día siguiente", () => {
  // El ejemplo del lienzo: el sábado a las 18:30 la clínica ya cerró; el lunes
  // a las 8:30 de Lima es la primera hora del horario para escribir.
  const SATURDAY_EVENING = new Date("2026-10-10T23:30:00Z")
  const OPENING = new Date("2026-10-12T13:30:00Z")

  async function forgotten(c: Awaited<ReturnType<typeof clinic>>, name: string, kind: "cita" | "precio" | "clinico", text: string, lastInboundAt: Date) {
    const conv = await c.thread(await c.person(name), c.whatsappId, { lastInboundAt })
    await c.say(conv, text, SATURDAY_EVENING)
    const topic = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv, reason: text, summary: text, createdBy: "agent", kind, assigneeUserId: c.receptionId }))
    await ownerDb.update(agentHandoff).set({ createdAt: SATURDAY_EVENING }).where(eq(agentHandoff.id, topic.id))
    return { conv, topic }
  }

  it("a la hora de apertura retoma una cita o un precio de un día anterior; nunca una duda clínica ni lo que el equipo ya contestó", async () => {
    const c = await clinic()
    // Escribió hace poco: la ventana de 24 horas sigue abierta (el envío la mira con la hora real).
    const window = hoursAgo(2)
    const carlos = await forgotten(c, "Carlos Paredes", "precio", "¿Cuánto cuesta una extracción de muela del juicio?", window)
    const elena = await forgotten(c, "Elena Huamán", "cita", "Quiero reservar una limpieza", window)
    const rosa = await forgotten(c, "Rosa Quispe", "clinico", "¿Puedo tomar ibuprofeno?", window)
    const jorge = await forgotten(c, "Jorge Mamani", "cita", "¿Tienen el sábado?", window)
    await ownerDb.insert(message).values({ organizationId: c.orgId, conversationId: jorge.conv, direction: "out", senderKind: "user", senderUserId: c.receptionId, body: "Te confirmo en un rato", status: "sent", createdAt: new Date("2026-10-11T00:00:00Z") })
    // A las 10:00 ya no es la hora de apertura: no retoma nada.
    expect(await c.run((tx) => retakeForgottenTopics(tx, c.orgId, new Date("2026-10-12T15:00:00Z"), { secretsKey: Buffer.alloc(32) }))).toBe(0)
    expect(await c.run((tx) => retakeForgottenTopics(tx, c.orgId, OPENING, { secretsKey: Buffer.alloc(32) }))).toBe(2)
    const said = (await c.messages(carlos.conv)).at(-1)
    expect(said).toMatchObject({ direction: "out", senderKind: "agent" })
    expect(said?.body).toBe("Hola, Carlos. El sábado quedó pendiente tu consulta: «¿Cuánto cuesta una extracción de muela del juicio?». ¿Te ayudo con eso ahora? Si quieres, también te reservo una evaluación.")
    expect((await c.messages(elena.conv)).at(-1)?.body).toContain("¿Te ayudo a reservar tu cita? Dime qué día te queda mejor.")
    // El tema queda «Lo retomó Sofi» y quien lo tenía recibe el aviso.
    expect(await c.taskOf(carlos.topic.taskId)).toMatchObject({ status: "done", settledReason: "Lo retomó Sofi: el equipo no alcanzó a responder" })
    const notices = await ownerDb.select().from(workspaceNotification).where(and(eq(workspaceNotification.organizationId, c.orgId), eq(workspaceNotification.userId, c.receptionId)))
    expect(notices.map((row) => row.title).sort()).toEqual(["Sofi retomó el tema de Carlos Paredes", "Sofi retomó el tema de Elena Huamán"])
    const audits = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.organizationId, c.orgId), eq(auditEvent.action, "agent.handoff_retaken")))
    expect(audits).toHaveLength(2)
    // La duda clínica y la cita que el equipo ya contestó siguen con el equipo.
    expect((await c.taskOf(rosa.topic.taskId))?.status).toBe("open")
    expect((await c.taskOf(jorge.topic.taskId))?.status).toBe("open")
    // Un tema retomado no se retoma otra vez.
    expect(await c.run((tx) => retakeForgottenTopics(tx, c.orgId, new Date("2026-10-12T13:45:00Z"), { secretsKey: Buffer.alloc(32) }))).toBe(0)
  })

  it("un precio solo si Sofi puede decir precios; con la ventana cerrada y sin «Retomar» aprobado, el tema sigue con el equipo", async () => {
    const c = await clinic()
    const precio = await forgotten(c, "Carlos Paredes", "precio", "¿Cuánto cuesta?", hoursAgo(2))
    await c.run((tx) => upsertAgentConfig(tx, c.orgId, { disabledFunctions: ["informar"] }))
    const closed = await forgotten(c, "Elena Huamán", "cita", "Quiero una cita", new Date("2026-10-11T12:00:00Z"))
    expect(await c.run((tx) => retakeForgottenTopics(tx, c.orgId, OPENING, { secretsKey: Buffer.alloc(32) }))).toBe(0)
    expect((await c.taskOf(precio.topic.taskId))?.status).toBe("open")
    expect((await c.taskOf(closed.topic.taskId))?.status).toBe("open")
  })

  it("habla en la voz de la clínica", () => {
    expect(retakeText({ treatment: "usted", tone: "formal", emojis: "no" }, null, { day: "ayer", quote: null, kind: "cita" }))
      .toBe("Hola. Ayer quedó pendiente su consulta. ¿Le ayudo a reservar su cita? Dígame qué día le queda mejor.")
  })
})
