import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { agentCaseMemory, agentHandoff, agentProposal, agentRunLedger } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { agentConfig, channelConnection, contact, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { crmNote } from "@odentia/db/schema/crm-workspace"
import { auditEvent } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, asc, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { addAgentCaseNote, getAgentCaseState, formatAgentCaseForPrompt } from "./agent-case.js"
import { createHandoff } from "./agent-operations.js"
import { getAgentConfig, upsertAgentConfig } from "./agentConfig.js"
import { describeAuditEvent } from "./audit-words.js"
import {
  agentReplyBlockedReason,
  closeConversation,
  closeConversationWith,
  closurePendingReason,
  farewellText,
  getResolvePreview,
  getTaskResolvePreview,
  greetingName,
  nudgeText,
  releaseConversation,
  resolveConversationByTeam,
  takeConversation,
  tickConversationCare,
} from "./conversation-close.js"
import { reopenConversation, sendOutbound } from "./conversations.js"
import { askConfirmationAfterReaction, REACTION_CONFIRM_TEXT } from "./reactions.js"
import { answerToTeamMember, resolveTopic, sendTeamReply, takeTopic } from "./topic-reply.js"
import { recordTopicAskedAgain } from "./agent-operations.js"
import { listInboxConversations } from "./inbox.js"
import { completeTask } from "./tasks.js"
import { setWritingHours } from "./writing-hours.js"
import { getWorkspaceHome } from "./workspace.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Ninguna conversación queda abierta (ADR 0024): cerrar con su motivo y sus
 * efectos, escribir reabre, «Resolver», «Tomar» y «Devolver», y el ciclo que
 * insiste una vez y cierra por silencio dentro del «Horario de recontacto»
 * (ADR 0042). Lima es UTC−5 y el 12 de octubre de 2026 es lunes; la clínica de
 * prueba tiene el horario que viene: lunes a viernes de 8:00 a 20:00, sábado
 * de 8:00 a 14:00 y domingo sin mensajes.
 */
setupTestDb()

const HOUR = 3_600_000

async function clinic(options: { provider?: "telegram_bot_api" | "whatsapp_cloud_api"; enabled?: boolean } = {}) {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `cierre-${orgId}`)
  await ownerDb.insert(agentConfig).values({ organizationId: orgId, enabled: options.enabled ?? true })
  const ownerId = `owner-${orgId}`
  const receptionId = `recep-${orgId}`
  await ownerDb.insert(user).values([
    { id: ownerId, name: "Dueña", email: `${ownerId}@cierre.test`, emailVerified: true },
    { id: receptionId, name: "Rita de Recepción", email: `${receptionId}@cierre.test`, emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: `m-${ownerId}`, userId: ownerId, organizationId: orgId, role: "owner", createdAt: new Date() },
    { id: `m-${receptionId}`, userId: receptionId, organizationId: orgId, role: "reception", createdAt: new Date() },
  ])
  const provider = options.provider ?? "telegram_bot_api"
  const [connection] = await ownerDb
    .insert(channelConnection)
    .values({
      organizationId: orgId,
      channel: provider === "telegram_bot_api" ? "telegram" : "whatsapp",
      provider,
      displayName: "Canal",
      configEncrypted: "config",
      webhookSecret: "secret",
      status: "active",
    })
    .returning()
  const run = <T,>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const thread = async (name: string, values: Partial<typeof conversation.$inferInsert> = {}) => {
    const [person] = await ownerDb.insert(contact).values({ organizationId: orgId, displayName: name }).returning()
    const [row] = await ownerDb
      .insert(conversation)
      .values({ organizationId: orgId, contactId: person!.id, channelConnectionId: connection!.id, externalThreadId: `t:${randomUUID()}`, ...values })
      .returning()
    return { id: row!.id, contactId: person!.id }
  }
  const say = (conversationId: string, direction: "in" | "out", body: string, createdAt: Date, senderKind = direction === "in" ? "contact" : "agent") =>
    ownerDb.insert(message).values({
      organizationId: orgId, conversationId, direction, senderKind, body, createdAt,
      status: direction === "in" ? "received" : "sent",
      externalId: `ext-${randomUUID()}`,
    }).returning()
  const row = async (id: string) => (await ownerDb.select().from(conversation).where(eq(conversation.id, id)))[0]!
  const messages = (id: string) => ownerDb.select().from(message).where(eq(message.conversationId, id)).orderBy(asc(message.createdAt))
  return { orgId, ownerId, receptionId, run, thread, say, row, messages }
}

describe("la voz de la clínica al despedirse e insistir", () => {
  it("dice que estamos atentos, con el nombre si parece un nombre y el trato de la clínica", () => {
    expect(greetingName("Ana Paredes")).toBe("Ana")
    expect(greetingName("+51 987 654 321")).toBeNull()
    expect(farewellText({ treatment: "tu", tone: "cercano", emojis: "no" }, "Ana")).toBe("Ana, cuando quieras retomar, escríbenos por aquí: estamos atentos para ayudarte.")
    expect(farewellText({ treatment: "usted", tone: "formal", emojis: "pocos" }, null)).toBe("Cuando desee retomar, escríbanos por aquí: quedamos atentos.")
    expect(farewellText({ treatment: "tu", tone: "cercano", emojis: "pocos" }, null)).toBe("Cuando quieras retomar, escríbenos por aquí: estamos atentos para ayudarte. 😊")
    expect(nudgeText({ treatment: "tu", tone: "cercano", emojis: "no" }, "Ana", { action: "reservar_cita", when: "jueves 16 de octubre a las 10:00" }))
      .toBe("Ana, ¿te reservo el jueves 16 de octubre a las 10:00? Si prefieres otro horario, dime.")
    expect(nudgeText({ treatment: "usted", tone: "neutro", emojis: "no" }, null, null)).toBe("¿Pudo ver lo que le comenté? Si le queda alguna duda, aquí estoy para ayudarle.")
  })
})

describe("cerrar y reabrir", () => {
  it("al cerrar vencen las propuestas, se quita la asignación, se enciende el agente y las notas no pasan a la atención siguiente", async () => {
    const c = await clinic()
    const conv = await c.thread("Ana Paredes", { assignedUserId: c.receptionId, agentStatus: "off" })
    await ownerDb.insert(agentProposal).values({
      organizationId: c.orgId, conversationId: conv.id, contactId: conv.contactId, action: "reservar_cita",
      payload: { startsAt: "2026-10-16T15:00:00Z" }, afterSummary: "Cita", idempotencyKey: randomUUID(),
    })
    await c.run((tx) => addAgentCaseNote(tx, c.orgId, conv.id, "Prefiere las tardes"))
    expect(await c.run((tx) => closurePendingReason(tx, c.orgId, conv.id))).toMatch(/propuesta esperando el sí/)
    await c.run((tx) => closeConversationWith(tx, c.orgId, conv.id, { reason: "resuelta", byUserId: null, now: new Date("2026-10-12T17:00:00Z") }))
    expect(await c.row(conv.id)).toMatchObject({ status: "closed", closeReason: "resuelta", closedByUserId: null, assignedUserId: null, agentStatus: "on" })
    const [proposal] = await ownerDb.select().from(agentProposal).where(eq(agentProposal.conversationId, conv.id))
    expect(proposal?.status).toBe("expirada")
    const [memory] = await ownerDb.select().from(agentCaseMemory).where(eq(agentCaseMemory.conversationId, conv.id))
    expect(memory?.notes).toHaveLength(1)
    expect(memory?.notes[0]).toMatchObject({ kind: "atencion_anterior" })
    // La atención nueva recibe solo cómo terminó la anterior.
    const prompt = formatAgentCaseForPrompt(await c.run((tx) => getAgentCaseState(tx, c.orgId, conv.id)), { timezone: "America/Lima", locale: "es-PE" }, 20) ?? ""
    expect(prompt).toContain("Atención anterior: cerrada el")
    expect(prompt).toContain("se despidió y no quedaba nada pendiente")
    expect(prompt).not.toContain("Prefiere las tardes")
    // Cerrar dos veces no cambia nada; la auditoría dice que fue el agente y por qué.
    expect(await c.run((tx) => closeConversationWith(tx, c.orgId, conv.id, { reason: "manual", byUserId: c.ownerId }))).toBe(false)
    const [audit] = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.entityId, conv.id), eq(auditEvent.action, "conversation.closed_resuelta")))
    expect(describeAuditEvent(audit!.action, (audit!.metadata as { origin?: string }).origin)).toMatchObject({ author: "Sofi", what: "Cerró una conversación: terminó la atención" })
  })

  it("escribir a una cerrada la reabre con quién lo hizo; «Reabrir» también, sin mensaje", async () => {
    const c = await clinic()
    const conv = await c.thread("Bruno")
    await c.run((tx) => closeConversation(tx, c.orgId, conv.id, c.ownerId))
    expect(await c.row(conv.id)).toMatchObject({ status: "closed", closeReason: "manual", closedByUserId: c.ownerId })
    await c.run((tx) => sendOutbound(tx, c.orgId, { conversationId: conv.id, senderKind: "user", senderUserId: c.receptionId, content: { type: "text", text: "Hola Bruno" } }))
    const reopened = await c.row(conv.id)
    expect(reopened).toMatchObject({ status: "open", closedAt: null, closeReason: null, closedByUserId: null, nudgedAt: null })
    const [audit] = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.entityId, conv.id), eq(auditEvent.action, "conversation.reopened")))
    expect(audit).toMatchObject({ actorUserId: c.receptionId, metadata: { via: "envio" } })
    expect(describeAuditEvent("conversation.reopened").what).toBe("Reabrió una conversación")
    expect(describeAuditEvent("conversation.closed").what).toBe("Cerró una conversación")
    await c.run((tx) => closeConversation(tx, c.orgId, conv.id, c.ownerId))
    await c.run((tx) => reopenConversation(tx, c.orgId, conv.id, c.ownerId))
    expect((await c.row(conv.id)).status).toBe("open")
    expect((await c.row(conv.id)).attentionStartedAt.getTime()).toBeGreaterThanOrEqual(reopened.attentionStartedAt.getTime())
  })

  it("cerrar sin resolver deja los casos derivados resueltos con una nota en la ficha y no envía despedida", async () => {
    const c = await clinic()
    const conv = await c.thread("Carla")
    await c.say(conv.id, "in", "Quiero hablar con alguien", new Date())
    const handoff = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv.id, reason: "Pide una persona", summary: "Pide una persona", createdBy: "agent" }))
    await c.run((tx) => closeConversation(tx, c.orgId, conv.id, c.ownerId))
    const [task] = await ownerDb.select().from(crmTask).where(eq(crmTask.id, handoff.taskId!))
    expect(task?.status).toBe("done")
    const notes = await ownerDb.select().from(crmNote).where(eq(crmNote.conversationId, conv.id))
    expect(notes.map((note) => note.body)).toEqual(["Caso de Sofi cerrado sin resolver: se cerró la conversación."])
    expect((await c.messages(conv.id)).filter((item) => item.direction === "out")).toHaveLength(0)
  })
})

describe("«Resolver», «Tomar» y «Devolver al agente»", () => {
  it("resolver envía la despedida, resuelve los casos y cierra con el equipo; pasada la ventana no hay despedida", async () => {
    const c = await clinic({ provider: "whatsapp_cloud_api" })
    const conv = await c.thread("Diana Ríos", { lastInboundAt: new Date(Date.now() - HOUR) })
    await c.say(conv.id, "in", "Gracias por todo", new Date(Date.now() - HOUR))
    await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv.id, reason: "Reclamo", summary: "Reclamo", createdBy: "agent" }))
    expect(await c.run((tx) => getResolvePreview(tx, c.orgId, conv.id))).toEqual({
      farewell: true,
      farewellText: "Diana, cuando quieras retomar, escríbenos por aquí: estamos atentos para ayudarte.",
      handoffs: 1,
      pendingContact: 0,
    })
    await c.run((tx) => resolveConversationByTeam(tx, c.orgId, conv.id, c.receptionId))
    expect(await c.row(conv.id)).toMatchObject({ status: "closed", closeReason: "equipo", closedByUserId: c.receptionId, agentStatus: "on" })
    expect((await c.messages(conv.id)).at(-1)).toMatchObject({ direction: "out", senderUserId: c.receptionId, body: "Diana, cuando quieras retomar, escríbenos por aquí: estamos atentos para ayudarte." })
    const late = await c.thread("Eva", { lastInboundAt: new Date(Date.now() - 24 * HOUR) })
    expect(await c.run((tx) => getResolvePreview(tx, c.orgId, late.id))).toMatchObject({ farewell: false, farewellText: null })
  })

  it("completar la tarea de un tema no cierra la conversación: el agente sigue con lo demás (ADR 0050)", async () => {
    const c = await clinic()
    const conv = await c.thread("Fabio")
    await c.say(conv.id, "in", "Necesito ayuda", new Date())
    const first = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv.id, reason: "Uno", summary: "Uno", createdBy: "agent" }))
    const second = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv.id, reason: "Dos", summary: "Dos", createdBy: "agent" }))
    // Derivar no apaga al agente.
    expect(await c.row(conv.id)).toMatchObject({ agentStatus: "on" })
    await c.run((tx) => completeTask(tx, c.orgId, first.taskId!, { userId: c.receptionId }))
    await c.run((tx) => completeTask(tx, c.orgId, second.taskId!, { userId: c.receptionId }))
    expect(await c.row(conv.id)).toMatchObject({ status: "open", agentStatus: "on" })
    expect((await c.messages(conv.id)).filter((item) => item.direction === "out")).toHaveLength(0)
  })

  it("tomar pasa los temas a quien toma sin apagar al agente; volver a encenderlo no exige resolverlos", async () => {
    const c = await clinic()
    const conv = await c.thread("Gina")
    const handoff = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv.id, reason: "Pide una persona", summary: "Pide una persona", createdBy: "agent" }))
    await c.run((tx) => takeConversation(tx, c.orgId, conv.id, c.receptionId))
    expect(await c.row(conv.id)).toMatchObject({ assignedUserId: c.receptionId, agentStatus: "on" })
    const [claimed] = await ownerDb.select().from(agentHandoff).where(eq(agentHandoff.id, handoff.id))
    expect(claimed?.assigneeUserId).toBe(c.receptionId)
    await c.run((tx) => releaseConversation(tx, c.orgId, conv.id, c.receptionId))
    expect(await c.row(conv.id)).toMatchObject({ assignedUserId: null, agentStatus: "on" })
    // El tema sigue con su responsable.
    const [still] = await ownerDb.select().from(agentHandoff).where(eq(agentHandoff.id, handoff.id))
    expect(still?.assigneeUserId).toBe(c.receptionId)
  })

  it("tomar una cerrada la reabre antes: nunca queda una conversación cerrada a cargo de alguien", async () => {
    const c = await clinic()
    const conv = await c.thread("Hilda")
    await c.run((tx) => closeConversation(tx, c.orgId, conv.id, c.ownerId))
    await c.run((tx) => takeConversation(tx, c.orgId, conv.id, c.receptionId))
    expect(await c.row(conv.id)).toMatchObject({ status: "open", closedAt: null, closeReason: null, assignedUserId: c.receptionId, agentStatus: "on" })
    const [audit] = await ownerDb.select().from(auditEvent).where(and(eq(auditEvent.entityId, conv.id), eq(auditEvent.action, "conversation.reopened")))
    expect(audit).toMatchObject({ actorUserId: c.receptionId, metadata: { via: "equipo" } })
  })

  it("completar la tarea de un tema no tiene nada que advertir: no cierra la conversación", async () => {
    const c = await clinic({ provider: "whatsapp_cloud_api" })
    const conv = await c.thread("Lucía Paredes", { lastInboundAt: new Date(Date.now() - HOUR) })
    await c.say(conv.id, "in", "¿Me devuelven lo que pagué?", new Date(Date.now() - HOUR))
    const topic = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv.id, reason: "Reembolso", summary: "Reembolso", createdBy: "agent" }))
    expect(await c.run((tx) => getTaskResolvePreview(tx, c.orgId, topic.taskId!))).toBeNull()
  })
})

describe("el ciclo: insistir una vez y cerrar por silencio", () => {
  // Lunes 12 de octubre: entra a las 9:00 de Lima y el agente responde a las 9:01 con una pregunta.
  const IN = new Date("2026-10-12T14:00:00Z")
  const OUT = new Date("2026-10-12T14:01:00Z")
  const tick = (c: Awaited<ReturnType<typeof clinic>>, now: Date) => c.run((tx) => tickConversationCare(tx, c.orgId, now))
  /**
   * Lo que el ciclo envió sale con el reloj real: se lleva a la hora del ciclo
   * y se da por aceptado por el canal, como haría el envío a esa hora.
   */
  const settle = async (conversationId: string, at: Date) => {
    await ownerDb.update(message).set({ createdAt: at, externalId: `ext-${randomUUID()}`, status: "sent" }).where(and(eq(message.conversationId, conversationId), eq(message.status, "queued")))
    await ownerDb.update(conversation).set({ lastMessageAt: at, lastOutboundAt: at }).where(eq(conversation.id, conversationId))
  }

  it("insiste una vez a las 3 horas si preguntó algo, y cierra en el último momento para escribir antes de las 22 horas", async () => {
    const c = await clinic()
    const conv = await c.thread("Hugo Díaz", { lastInboundAt: IN, lastMessageAt: OUT, attentionStartedAt: IN })
    await c.say(conv.id, "in", "¿Atienden sábados?", IN)
    await c.say(conv.id, "out", "Sí, de 9 a 13. ¿Te busco un horario?", OUT)
    // A las 2 horas, nada.
    expect(await tick(c, new Date("2026-10-12T16:30:00Z"))).toEqual({ nudged: 0, closed: 0 })
    // A las 3 horas (12:05 en Lima), insiste.
    expect(await tick(c, new Date("2026-10-12T17:05:00Z"))).toMatchObject({ nudged: 1 })
    expect((await c.messages(conv.id)).at(-1)).toMatchObject({ senderKind: "agent", body: "Hugo, ¿pudiste ver lo que te comenté? Si te queda alguna duda, aquí estoy para ayudarte." })
    expect((await c.row(conv.id)).nudgedAt?.toISOString()).toBe("2026-10-12T17:05:00.000Z")
    // Una sola vez por atención, aunque el recordatorio ya salió.
    await settle(conv.id, new Date("2026-10-12T17:05:00Z"))
    expect(await tick(c, new Date("2026-10-12T20:30:00Z"))).toMatchObject({ nudged: 0, closed: 0 })
    // Las 22 horas caen el martes a las 7:00 (antes de las 8:00): se adelanta al lunes a las 19:59,
    // el último momento del «Horario de recontacto» (de 8:00 a 20:00), no el de atención.
    expect(await tick(c, new Date("2026-10-13T00:30:00Z"))).toMatchObject({ closed: 0 })
    expect(await tick(c, new Date("2026-10-13T01:00:00Z"))).toMatchObject({ closed: 1 })
    expect(await c.row(conv.id)).toMatchObject({ status: "closed", closeReason: "sin_respuesta", closedByUserId: null })
    expect((await c.messages(conv.id)).at(-1)?.body).toBe("Hugo, cuando quieras retomar, escríbenos por aquí: estamos atentos para ayudarte.")
  })

  it("sin algo por responder no insiste, fuera de horario tampoco, y cierra a la hora configurada", async () => {
    const c = await clinic()
    await c.run((tx) => upsertAgentConfig(tx, c.orgId, { closeAfterHours: 8 }))
    expect((await c.run((tx) => getAgentConfig(tx, c.orgId))).closeAfterHours).toBe(8)
    await expect(c.run((tx) => upsertAgentConfig(tx, c.orgId, { closeAfterHours: 24 }))).rejects.toMatchObject({ code: "VALIDATION" })
    const conv = await c.thread("Inés", { lastInboundAt: IN, lastMessageAt: OUT, attentionStartedAt: IN })
    await c.say(conv.id, "in", "Gracias por la info", IN)
    await c.say(conv.id, "out", "Con gusto.", OUT)
    const asked = await c.thread("Javier", { lastInboundAt: IN, lastMessageAt: OUT, attentionStartedAt: IN })
    await c.say(asked.id, "in", "¿Precio?", IN)
    await c.say(asked.id, "out", "Son 100 soles. ¿Quieres reservar?", OUT)
    expect(await tick(c, new Date("2026-10-12T17:05:00Z"))).toMatchObject({ nudged: 1 })
    await settle(asked.id, new Date("2026-10-12T17:05:00Z"))
    expect((await c.messages(conv.id)).at(-1)?.body).toBe("Con gusto.")
    // Las 8 horas desde las 9:00 son las 17:00 de Lima: oportuna, cierra a esa hora.
    expect(await tick(c, new Date("2026-10-12T21:59:00Z"))).toMatchObject({ closed: 0 })
    expect(await tick(c, new Date("2026-10-12T22:00:00Z"))).toMatchObject({ closed: 2 })
    // A las 22:30 de Lima ya no se insiste aunque haya algo por responder.
    const night = await c.thread("Karen", { lastInboundAt: new Date("2026-10-13T00:00:00Z"), lastMessageAt: new Date("2026-10-13T00:01:00Z"), attentionStartedAt: new Date("2026-10-13T00:00:00Z") })
    await c.say(night.id, "in", "¿Abren mañana?", new Date("2026-10-13T00:00:00Z"))
    await c.say(night.id, "out", "Sí, desde las 9. ¿Te reservo?", new Date("2026-10-13T00:01:00Z"))
    expect(await tick(c, new Date("2026-10-13T03:30:00Z"))).toMatchObject({ nudged: 0 })
  })

  it("con una propuesta esperando el sí, insiste por la cita", async () => {
    const c = await clinic()
    const conv = await c.thread("Lucía Paredes", { lastInboundAt: IN, lastMessageAt: OUT, attentionStartedAt: IN })
    await c.say(conv.id, "in", "El jueves a las 10", IN)
    await c.say(conv.id, "out", "Te propongo el jueves a las 10:00.", OUT)
    await ownerDb.insert(agentProposal).values({
      organizationId: c.orgId, conversationId: conv.id, contactId: conv.contactId, action: "reservar_cita",
      payload: { startsAt: "2026-10-15T15:00:00.000Z" }, afterSummary: "Cita", idempotencyKey: randomUUID(),
    })
    await ownerDb.insert(agentRunLedger).values({ organizationId: c.orgId, conversationId: conv.id, model: "fake", status: "ok", startedAt: IN, toolsUsed: ["proponer_cita"] })
    expect(await tick(c, new Date("2026-10-12T17:05:00Z"))).toMatchObject({ nudged: 1 })
    expect((await c.messages(conv.id)).at(-1)?.body).toBe("Lucía, ¿te reservo el jueves, 15 de octubre a las 10:00? Si prefieres otro horario, dime.")
  })

  it("al despedirse con una cita propuesta sin confirmar, dice que dejó libre ese horario (tablero 2c)", async () => {
    const c = await clinic()
    const conv = await c.thread("Pedro Ruiz", { lastInboundAt: IN, lastMessageAt: OUT, attentionStartedAt: IN })
    await c.say(conv.id, "in", "¿El jueves a las 10?", IN)
    await c.say(conv.id, "out", "Te propongo el jueves a las 10:00. ¿Te lo reservo?", OUT)
    await ownerDb.insert(agentProposal).values({
      organizationId: c.orgId, conversationId: conv.id, contactId: conv.contactId, action: "reservar_cita",
      payload: { startsAt: "2026-10-15T15:00:00.000Z" }, afterSummary: "Cita", idempotencyKey: randomUUID(),
    })
    // Lo que dice «Resolver» antes de cerrar, y lo que sale al cerrar por silencio: el mismo texto.
    const said = "Pedro, como no alcanzamos a confirmar, dejé libre el jueves, 15 de octubre a las 10:00. Cuando quieras una cita, escríbenos y te busco un horario: estamos atentos."
    await c.run((tx) => upsertAgentConfig(tx, c.orgId, { closeAfterHours: 8 }))
    expect(await tick(c, new Date("2026-10-12T22:00:00Z"))).toMatchObject({ closed: 1 })
    expect((await c.messages(conv.id)).at(-1)?.body).toBe(said)
    // De usted, con el trato de la clínica.
    await c.run((tx) => upsertAgentConfig(tx, c.orgId, { treatment: "usted" }))
    const other = await c.thread("Ana Gómez", { lastInboundAt: new Date(Date.now() - HOUR) })
    await ownerDb.insert(agentProposal).values({
      organizationId: c.orgId, conversationId: other.id, contactId: other.contactId, action: "reservar_cita",
      payload: { startsAt: "2026-10-15T15:00:00.000Z" }, afterSummary: "Cita", idempotencyKey: randomUUID(),
    })
    expect((await c.run((tx) => getResolvePreview(tx, c.orgId, other.id))).farewellText).toBe(
      "Ana, como no alcanzamos a confirmar, dejé libre el jueves, 15 de octubre a las 10:00. Cuando desee una cita, escríbanos y le busco un horario: estamos atentos.",
    )
  })

  it("insistir y despedirse siguen el «Horario de recontacto» de la clínica, por día", async () => {
    const c = await clinic()
    // El domingo no se escribe: con el horario que viene, el agente no insiste.
    const sunday = new Date("2026-10-11T14:00:00Z") // domingo 9:00 en Lima
    const conv = await c.thread("Sara", { lastInboundAt: sunday, lastMessageAt: new Date(sunday.getTime() + 60_000), attentionStartedAt: sunday })
    await c.say(conv.id, "in", "¿Precio de limpieza?", sunday)
    await c.say(conv.id, "out", "Son 80 soles. ¿Te reservo?", new Date(sunday.getTime() + 60_000))
    expect(await tick(c, new Date("2026-10-11T17:05:00Z"))).toMatchObject({ nudged: 0 })
    // La clínica abre el domingo para escribir: ahora sí insiste.
    await c.run((tx) => setWritingHours(tx, c.orgId, c.ownerId, [[[480, 1200]], [[480, 1200]], [[480, 1200]], [[480, 1200]], [[480, 1200]], [[480, 1200]], [[480, 840]]]))
    expect(await tick(c, new Date("2026-10-11T17:06:00Z"))).toMatchObject({ nudged: 1 })
  })

  it("sin ventana para escribir cierra sin mensaje", async () => {
    const c = await clinic({ provider: "whatsapp_cloud_api" })
    // Escribió hace tres días; la clínica le escribió el lunes a las 9:00 y no contestó.
    const conv = await c.thread("Mario", { lastInboundAt: new Date("2026-10-09T14:00:00Z"), lastMessageAt: OUT, attentionStartedAt: IN })
    await c.say(conv.id, "in", "Hola", new Date("2026-10-09T14:00:00Z"))
    await c.say(conv.id, "out", "Hola Mario, ¿confirmas tu cita?", OUT)
    const before = (await c.messages(conv.id)).length
    expect(await tick(c, new Date("2026-10-12T17:05:00Z"))).toMatchObject({ nudged: 0 })
    expect(await tick(c, new Date("2026-10-13T02:00:00Z"))).toMatchObject({ closed: 1 })
    expect(await c.row(conv.id)).toMatchObject({ status: "closed", closeReason: "sin_respuesta" })
    expect(await c.messages(conv.id)).toHaveLength(before)
  })

  it("con una persona a cargo no se cierra ni avisa en la campana: la muestra «Te espera» a quien la lleva", async () => {
    const c = await clinic()
    // Una persona la lleva entera: apagó al agente en el hilo (ADR 0050; asignar ya no lo hace).
    const mine = await c.thread("Nora Paz", { assignedUserId: c.ownerId, agentStatus: "off", lastInboundAt: IN, lastMessageAt: OUT, attentionStartedAt: IN })
    await c.say(mine.id, "in", "Hola", IN)
    await c.say(mine.id, "out", "Hola Nora", OUT, "user")
    const off = await c.thread("Omar", { agentStatus: "off", lastInboundAt: IN, lastMessageAt: IN, attentionStartedAt: IN })
    await c.say(off.id, "in", "¿Me ayudan?", IN)
    expect(await tick(c, new Date("2026-10-13T12:30:00Z"))).toEqual({ nudged: 0, closed: 0 })
    expect(await ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.organizationId, c.orgId))).toEqual([])
    expect((await c.row(mine.id)).status).toBe("open")
    expect((await c.row(off.id)).status).toBe("open")
    const access = { patients: false, appointments: false, conversations: true, tasks: false, finance: false, clinical: false, crm: false, agent: true, allTasks: false, configure: false, ownAppointments: false }
    // Nora la lleva la dueña: a ella le espera; a recepción no. Omar espera respuesta: es otra fila.
    const ownerHome = await c.run((tx) => getWorkspaceHome(tx, c.orgId, c.ownerId, access))
    expect(ownerHome.waiting.find((row) => row.kind === "stillOpen")).toMatchObject({ total: 1, conversationId: mine.id, contactName: "Nora Paz" })
    expect(ownerHome.waiting.find((row) => row.kind === "conversations")).toMatchObject({ waiting: 1 })
    const receptionHome = await c.run((tx) => getWorkspaceHome(tx, c.orgId, c.receptionId, access))
    expect(receptionHome.waiting.find((row) => row.kind === "stillOpen")).toBeUndefined()
    // Con Recepción apagada nada se cierra solo, así que no hay nada que recordar.
    await ownerDb.update(agentConfig).set({ enabled: false }).where(eq(agentConfig.organizationId, c.orgId))
    expect((await c.run((tx) => getWorkspaceHome(tx, c.orgId, c.ownerId, access))).waiting.find((row) => row.kind === "stillOpen")).toBeUndefined()
  })

  it("con Recepción apagada o una derivación abierta, el ciclo no toca la conversación", async () => {
    const c = await clinic({ enabled: false })
    const conv = await c.thread("Pía", { lastInboundAt: IN, lastMessageAt: OUT, attentionStartedAt: IN })
    await c.say(conv.id, "in", "Hola", IN)
    await c.say(conv.id, "out", "¿En qué te ayudo?", OUT)
    expect(await tick(c, new Date("2026-10-14T17:00:00Z"))).toEqual({ nudged: 0, closed: 0 })
    await ownerDb.update(agentConfig).set({ enabled: true }).where(eq(agentConfig.organizationId, c.orgId))
    await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv.id, reason: "Caso", summary: "Caso", createdBy: "agent" }))
    expect(await tick(c, new Date("2026-10-14T17:00:00Z"))).toEqual({ nudged: 0, closed: 0 })
  })
})

describe("lo que el agente redactó no sale si el equipo apagó al agente, conversa en vivo o la cerró", () => {
  it("abierta y con el agente: sale; apagado, con una persona escribiendo o cerrada: no sale y se dice por qué", async () => {
    const c = await clinic()
    const own = await c.thread("Ana Paredes")
    const taken = await c.thread("Bruno Díaz", { assignedUserId: c.receptionId, agentStatus: "off" })
    const closed = await c.thread("Carla Ríos", { status: "closed", closedAt: new Date(), closeReason: "manual" })
    const live = await c.thread("Dora Vega")
    await c.say(live.id, "out", "Hola Dora, te escribo yo", new Date(), "user")
    const earlier = await c.thread("Elsa Mora")
    await c.say(earlier.id, "out", "Te escribí hace rato", new Date(Date.now() - 20 * 60_000), "user")
    expect(await c.run((tx) => agentReplyBlockedReason(tx, c.orgId, own.id))).toBeNull()
    expect(await c.run((tx) => agentReplyBlockedReason(tx, c.orgId, taken.id))).toMatch(/apagó el agente/)
    expect(await c.run((tx) => agentReplyBlockedReason(tx, c.orgId, closed.id))).toMatch(/cerró la conversación/)
    // Una persona del equipo escribió hace menos de 15 minutos: el agente espera (ADR 0050).
    expect(await c.run((tx) => agentReplyBlockedReason(tx, c.orgId, live.id))).toMatch(/conversando/)
    expect(await c.run((tx) => agentReplyBlockedReason(tx, c.orgId, earlier.id))).toBeNull()
  })
})

describe("temas para el equipo: el agente nunca se calla (ADR 0050)", () => {
  const IN = new Date("2026-10-12T14:00:00Z")
  const OUT = new Date("2026-10-12T14:01:00Z")
  const tick = (c: Awaited<ReturnType<typeof clinic>>, now: Date) => c.run((tx) => tickConversationCare(tx, c.orgId, now))
  it("derivar crea un tema con el mensaje que lo originó y la conversación queda en «Por atender» sin apagar al agente", async () => {
    const c = await clinic()
    const conv = await c.thread("Rosa Quispe")
    const [asked] = await c.say(conv.id, "in", "¿Puedo tomar ibuprofeno con mi pastilla de la presión?", new Date())
    const topic = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv.id, reason: "Consulta clínica", summary: "Medicación", createdBy: "agent" }))
    const [stored] = await ownerDb.select().from(agentHandoff).where(eq(agentHandoff.id, topic.id))
    expect(stored?.sourceMessageId).toBe(asked!.id)
    expect(await c.row(conv.id)).toMatchObject({ agentStatus: "on" })
    const attend = await c.run((tx) => listInboxConversations(tx, c.orgId, { view: "attend" }))
    const item = attend.items.find((row) => row.id === conv.id)
    expect(item?.attention.topics).toEqual([
      expect.objectContaining({ id: topic.id, reason: "Consulta clínica", source: expect.objectContaining({ id: asked!.id, body: "¿Puedo tomar ibuprofeno con mi pastilla de la presión?" }) }),
    ])
  })

  it("responder citando el mensaje del tema lo toma y, con «Enviar y resolver», lo resuelve; «sigue pendiente» lo deja abierto", async () => {
    const c = await clinic()
    const conv = await c.thread("Carlos Paredes")
    const [asked] = await c.say(conv.id, "in", "¿Me hacen descuento si hago las dos extracciones?", new Date(Date.now() - 60_000))
    const topic = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv.id, reason: "Descuento", summary: "Descuento", createdBy: "agent" }))
    const pending = await c.run((tx) => sendTeamReply(tx, c.orgId, {
      conversationId: conv.id, userId: c.receptionId, content: { type: "text", text: "Lo consulto con la doctora y te confirmo hoy" },
      replyToMessageId: asked!.id, keepPending: true,
    }))
    expect(pending).toMatchObject({ topicId: topic.id, topicResolved: false, replyToMessageId: asked!.id })
    const [taken] = await ownerDb.select().from(agentHandoff).where(eq(agentHandoff.id, topic.id))
    expect(taken?.assigneeUserId).toBe(c.receptionId)
    expect((await ownerDb.select().from(crmTask).where(eq(crmTask.id, topic.taskId!)))[0]?.status).toBe("open")
    // Escribir no apaga al agente.
    expect(await c.row(conv.id)).toMatchObject({ agentStatus: "on" })
    const done = await c.run((tx) => sendTeamReply(tx, c.orgId, {
      conversationId: conv.id, userId: c.receptionId, content: { type: "text", text: "Sí: 10 % por las dos" }, replyToMessageId: asked!.id,
    }))
    expect(done).toMatchObject({ topicId: topic.id, topicResolved: true })
    expect((await ownerDb.select().from(crmTask).where(eq(crmTask.id, topic.taskId!)))[0]?.status).toBe("done")
    // Resolver el tema no cierra la conversación.
    expect((await c.row(conv.id)).status).toBe("open")
  })

  it("responder sin tema y «sigue pendiente» abre un tema a nombre de quien escribe", async () => {
    const c = await clinic()
    const conv = await c.thread("Lía")
    const [asked] = await c.say(conv.id, "in", "¿Tienen estacionamiento?", new Date())
    const sent = await c.run((tx) => sendTeamReply(tx, c.orgId, {
      conversationId: conv.id, userId: c.receptionId, content: { type: "text", text: "Te averiguo" }, replyToMessageId: asked!.id, keepPending: true,
    }))
    expect(sent.topicId).not.toBeNull()
    const [created] = await ownerDb.select().from(agentHandoff).where(eq(agentHandoff.id, sent.topicId!))
    expect(created).toMatchObject({ createdBy: "user", assigneeUserId: c.receptionId, sourceMessageId: asked!.id, reason: "¿Tienen estacionamiento?" })
  })

  it("«Tomar este tema» de otra persona no pide confirmación y le avisa; «Pasar este tema a…» avisa a quien lo recibe", async () => {
    const c = await clinic()
    const conv = await c.thread("Jorge Mamani")
    await c.say(conv.id, "in", "Quiero cotizar una endodoncia", new Date())
    const topic = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv.id, reason: "Cotización", summary: "Cotización", assigneeUserId: c.receptionId, createdBy: "agent" }))
    await c.run((tx) => takeTopic(tx, c.orgId, { conversationId: conv.id, topicId: topic.id, userId: c.ownerId }))
    expect((await ownerDb.select().from(agentHandoff).where(eq(agentHandoff.id, topic.id)))[0]?.assigneeUserId).toBe(c.ownerId)
    const toReception = await ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.userId, c.receptionId))
    expect(toReception.map((n) => n.title)).toEqual(["Dueña tomó el tema de Jorge Mamani"])
    await c.run((tx) => takeTopic(tx, c.orgId, { conversationId: conv.id, topicId: topic.id, userId: c.ownerId, toUserId: c.receptionId }))
    const again = await ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.userId, c.receptionId))
    expect(again.map((n) => n.title)).toContain("Dueña te pasó el tema de Jorge Mamani")
    // Un tema se contesta en la conversación: no se le pasa a quien no atiende conversaciones (caja).
    const cashierId = `caja-${c.orgId}`
    await ownerDb.insert(user).values({ id: cashierId, name: "Carla de Caja", email: `${cashierId}@cierre.test`, emailVerified: true })
    await ownerDb.insert(member).values({ id: `m-${cashierId}`, userId: cashierId, organizationId: c.orgId, role: "cashier", createdAt: new Date() })
    await expect(
      c.run((tx) => takeTopic(tx, c.orgId, { conversationId: conv.id, topicId: topic.id, userId: c.ownerId, toUserId: cashierId })),
    ).rejects.toThrow("Esa persona no atiende conversaciones")
    // Un tema de otra conversación no se toma por esta.
    const other = await c.thread("Otro")
    await expect(c.run((tx) => takeTopic(tx, c.orgId, { conversationId: other.id, topicId: topic.id, userId: c.ownerId }))).rejects.toMatchObject({ status: 404 })
    await c.run((tx) => resolveTopic(tx, c.orgId, { conversationId: conv.id, topicId: topic.id, userId: c.receptionId }))
    expect((await ownerDb.select().from(crmTask).where(eq(crmTask.id, topic.taskId!)))[0]?.status).toBe("done")
  })

  it("volver a preguntar por el tema se anota y avisa a quien lo tiene; citar a una persona del equipo va a su tema", async () => {
    const c = await clinic()
    const conv = await c.thread("Carlos")
    await c.say(conv.id, "in", "¿Y el descuento?", new Date(Date.now() - 60_000))
    const topic = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv.id, reason: "Descuento", summary: "Descuento", assigneeUserId: c.receptionId, createdBy: "agent" }))
    const [again] = await c.say(conv.id, "in", "¿Ya me pueden decir lo del descuento?", new Date())
    expect(await c.run((tx) => recordTopicAskedAgain(tx, c.orgId, { handoffId: topic.id, messageId: again!.id }))).toEqual({ assigneeName: "Rita de Recepción", reason: "Descuento" })
    const [row] = await ownerDb.select().from(agentHandoff).where(eq(agentHandoff.id, topic.id))
    expect(row?.askedMessageIds).toEqual([again!.id])
    expect((await ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.userId, c.receptionId))).map((n) => n.title))
      .toEqual(["Carlos volvió a preguntar por su tema"])
    // Cita lo que escribió la dueña: va a un tema de ella, no del agente.
    const [fromOwner] = await c.say(conv.id, "out", "Hola Carlos, soy la doctora", new Date(), "user")
    await ownerDb.update(message).set({ senderUserId: c.ownerId }).where(eq(message.id, fromOwner!.id))
    const [reply] = await c.say(conv.id, "in", "Gracias doctora", new Date())
    await c.run((tx) => answerToTeamMember(tx, c.orgId, { conversationId: conv.id, messageId: reply!.id, userId: c.ownerId }))
    const mine = await ownerDb.select().from(agentHandoff).where(and(eq(agentHandoff.conversationId, conv.id), eq(agentHandoff.assigneeUserId, c.ownerId)))
    expect(mine).toEqual([expect.objectContaining({ createdBy: "user", sourceMessageId: reply!.id })])
  })

  it("el ciclo da por resuelto el tema que el equipo ya respondió si la persona no volvió a preguntar", async () => {
    const c = await clinic()
    const conv = await c.thread("Nora", { lastInboundAt: IN, lastMessageAt: OUT, attentionStartedAt: IN })
    await c.say(conv.id, "in", "¿Qué pasta dental me recomiendan?", IN)
    const topic = await c.run((tx) => createHandoff(tx, c.orgId, null, { conversationId: conv.id, reason: "Consulta", summary: "Consulta", createdBy: "agent" }))
    await ownerDb.update(agentHandoff).set({ createdAt: IN }).where(eq(agentHandoff.id, topic.id))
    await c.say(conv.id, "out", "Una con flúor, Nora", OUT, "user")
    // Al día siguiente, pasadas las horas de silencio, el tema se resuelve y la conversación sigue el ciclo de siempre.
    await tick(c, new Date("2026-10-14T17:00:00Z"))
    const [task] = await ownerDb.select().from(crmTask).where(eq(crmTask.id, topic.taskId!))
    expect(task).toMatchObject({ status: "done", settledReason: "Respondido por el equipo; la persona no volvió a preguntar" })
  })
})

describe("una reacción no confirma una cita (decisión 7 de la Bandeja)", () => {
  it("un 👍 a la cita propuesta pide el sí una sola vez, con texto fijo; sin propuesta o quitada, no dice nada", async () => {
    const c = await clinic()
    const conv = await c.thread("Rosa Quispe", { lastInboundAt: new Date() })
    await c.say(conv.id, "in", "¿Tienen el viernes?", new Date(Date.now() - 120_000))
    const [offer] = await c.say(conv.id, "out", "¿Te acomoda el viernes 23 a las 15:00?", new Date(Date.now() - 60_000))
    // Sin propuesta esperando su sí, una reacción no despierta a nadie.
    expect(await c.run((tx) => askConfirmationAfterReaction(tx, c.orgId, { conversationId: conv.id, messageId: offer!.id, emoji: "👍" }))).toBe(false)
    await ownerDb.insert(agentProposal).values({
      organizationId: c.orgId,
      conversationId: conv.id,
      contactId: conv.contactId,
      action: "reservar_cita",
      payload: {},
      idempotencyKey: randomUUID(),
    })
    // Quitar la reacción tampoco.
    expect(await c.run((tx) => askConfirmationAfterReaction(tx, c.orgId, { conversationId: conv.id, messageId: offer!.id, emoji: null }))).toBe(false)
    expect(await c.run((tx) => askConfirmationAfterReaction(tx, c.orgId, { conversationId: conv.id, messageId: offer!.id, emoji: "👍" }))).toBe(true)
    const said = (await c.messages(conv.id)).filter((m) => m.direction === "out")
    expect(said.at(-1)).toMatchObject({ body: REACTION_CONFIRM_TEXT, senderKind: "agent" })
    // Otra reacción no lo repite; la propuesta sigue esperando, nada se confirmó.
    expect(await c.run((tx) => askConfirmationAfterReaction(tx, c.orgId, { conversationId: conv.id, messageId: offer!.id, emoji: "❤️" }))).toBe(false)
    expect((await ownerDb.select().from(agentProposal).where(eq(agentProposal.conversationId, conv.id)))[0]?.status).toBe("propuesta")
  })
})
