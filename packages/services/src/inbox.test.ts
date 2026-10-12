import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { agentPolicy, agentProposal } from "@odentia/db/schema/agent"
import { agentConfig, channelConnection, contact, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createHandoff } from "./agent-operations.js"
import { getInboxConversationDetail, listInboxConversations, summarizeInbox } from "./inbox.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { getWorkspaceHome } from "./workspace.js"

/**
 * Bandeja: cada conversación trae lo que espera del equipo o del agente, y los
 * totales de las vistas se cuentan en servidor con los mismos filtros.
 */
setupTestDb()

async function seedInbox() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `inbox-${orgId}`)
  await ownerDb.insert(agentConfig).values({ organizationId: orgId, enabled: true })
  // Mensajes exigen al interlocutor; el resto de actos, al equipo (por defecto).
  await ownerDb.insert(agentPolicy).values({ organizationId: orgId, modes: { enviar_mensaje: "confirmar_usuario" } })
  const [connection] = await ownerDb.insert(channelConnection).values({
    organizationId: orgId, channel: "telegram", provider: "telegram_bot_api", displayName: "Bot",
    configEncrypted: "config", webhookSecret: "secret", status: "active",
  }).returning()
  if (!connection) throw new Error("conexión")
  const thread = async (name: string, values: Partial<typeof conversation.$inferInsert> = {}) => {
    const [person] = await ownerDb.insert(contact).values({ organizationId: orgId, displayName: name }).returning()
    if (!person) throw new Error("contacto")
    const [row] = await ownerDb.insert(conversation).values({
      organizationId: orgId, contactId: person.id, channelConnectionId: connection.id,
      externalThreadId: `tg:${randomUUID()}`, agentStatus: "on", lastMessageAt: new Date(), ...values,
    }).returning()
    if (!row) throw new Error("conversación")
    return { id: row.id, contactId: person.id }
  }
  const proposal = (conv: { id: string; contactId: string }, action: string, createdAt = new Date()) =>
    ownerDb.insert(agentProposal).values({
      organizationId: orgId, contactId: conv.contactId, conversationId: conv.id, action,
      payload: action === "enviar_mensaje" ? { kind: "text", text: "Hola" } : { title: "Ortodoncia" },
      afterSummary: "Cambio previsto", idempotencyKey: randomUUID(), createdAt,
    })
  const handoff = (conv: { id: string }, priority: string) =>
    withOrgContext(appDb, orgId, (tx) =>
      createHandoff(tx, orgId, null, { conversationId: conv.id, reason: "Pide una persona", summary: "Pide una persona", priority, createdBy: "agent" }))
  return { orgId, thread, proposal, handoff }
}

it("cada conversación trae su estado de atención y las vistas cuentan con las mismas reglas", async () => {
  const { orgId, thread, proposal, handoff } = await seedInbox()
  // Espera respuesta y la atiende el agente.
  const waiting = await thread("Espera respuesta")
  await ownerDb.insert(message).values({ organizationId: orgId, conversationId: waiting.id, direction: "in", senderKind: "contact", body: "Hola", status: "received" })
  // Una persona la tomó y tiene dos derivaciones abiertas: manda la más alta.
  const derived = await thread("Derivada", { agentStatus: "off" })
  await handoff(derived, "baja")
  await handoff(derived, "alta")
  // Derivación ya resuelta (su tarea se completó): deja de contar.
  const resolved = await thread("Resuelta")
  const done = await handoff(resolved, "media")
  await ownerDb.update(crmTask).set({ status: "done" }).where(eq(crmTask.id, done.taskId as string))
  // Propuesta que decide el equipo, otra que espera al interlocutor y una vencida.
  const approval = await thread("Por aprobar")
  await proposal(approval, "crear_oportunidad")
  await proposal(approval, "enviar_mensaje")
  await proposal(approval, "crear_oportunidad", new Date(Date.now() - 49 * 3_600_000))
  const closed = await thread("Cerrada", { status: "closed" })
  // Hilo cuya única propuesta ya venció aunque su fila siga `propuesta`.
  const stale = await thread("Vencida")
  await proposal(stale, "crear_oportunidad", new Date(Date.now() - 49 * 3_600_000))
  // Hilo cerrado que conserva una derivación sin resolver.
  const closedCase = await thread("Cerrada con caso")
  await handoff(closedCase, "media")
  await ownerDb.update(conversation).set({ status: "closed" }).where(eq(conversation.id, closedCase.id))

  const list = (input: Parameters<typeof listInboxConversations>[2] = {}) =>
    withOrgContext(appDb, orgId, (tx) => listInboxConversations(tx, orgId, input))
  const { items } = await list()
  const of = (id: string) => items.find((item) => item.id === id)?.attention
  expect(of(waiting.id)).toEqual({ agentAttending: true, pendingTeam: 0, pendingContact: 0, handoffPriority: null })
  expect(of(derived.id)).toEqual({ agentAttending: false, pendingTeam: 0, pendingContact: 0, handoffPriority: "alta" })
  // Derivar apaga el agente en el hilo; resolver la derivación no lo reactiva solo.
  expect(of(resolved.id)).toEqual({ agentAttending: false, pendingTeam: 0, pendingContact: 0, handoffPriority: null })
  expect(of(approval.id)).toEqual({ agentAttending: true, pendingTeam: 1, pendingContact: 1, handoffPriority: null })
  expect(of(closed.id)?.agentAttending).toBe(false)
  expect(of(stale.id)).toEqual({ agentAttending: true, pendingTeam: 0, pendingContact: 0, handoffPriority: null })
  expect(of(closedCase.id)).toEqual({ agentAttending: false, pendingTeam: 0, pendingContact: 0, handoffPriority: "media" })
  // El hilo abierto recibe la misma atención aunque su fila no esté en la lista cargada.
  const detail = await withOrgContext(appDb, orgId, (tx) => getInboxConversationDetail(tx, orgId, approval.id))
  expect(detail.attention).toEqual(of(approval.id))

  expect((await list({ view: "handoff", status: "open" })).items.map((item) => item.id)).toEqual([derived.id])
  expect((await list({ view: "handoff" })).items.map((item) => item.id).sort()).toEqual([derived.id, closedCase.id].sort())
  expect((await list({ view: "agent" })).items.map((item) => item.id).sort()).toEqual([waiting.id, approval.id, stale.id].sort())
  expect((await list({ view: "unanswered", status: "open" })).items.map((item) => item.id)).toEqual([waiting.id])
  // «Por aprobar» usa la misma vigencia: la vencida sin marcar no cuenta.
  expect((await list({ view: "approval" })).items.map((item) => item.id)).toEqual([approval.id])

  const summary = (input: Parameters<typeof summarizeInbox>[2]) =>
    withOrgContext(appDb, orgId, (tx) => summarizeInbox(tx, orgId, input))
  expect(await summary({ status: "open" })).toEqual({ all: 5, waiting: 1, withAgent: 3, handoffs: 1 })
  expect(await summary({ status: "open", q: "Deriv" })).toEqual({ all: 1, waiting: 0, withAgent: 0, handoffs: 1 })
  expect(await summary({ status: "closed" })).toEqual({ all: 2, waiting: 0, withAgent: 0, handoffs: 1 })
  // Desde el contexto de otra organización, ni pidiendo esta se ve o se cuenta nada.
  expect(await withOrgContext(appDb, "org_b", (tx) => summarizeInbox(tx, orgId, {}))).toEqual({ all: 0, waiting: 0, withAgent: 0, handoffs: 0 })
  expect((await withOrgContext(appDb, "org_b", (tx) => listInboxConversations(tx, orgId, {}))).items).toEqual([])

  // «Te espera» de Inicio cuenta las conversaciones sin responder como la bandeja.
  const home = await withOrgContext(appDb, orgId, (tx) =>
    getWorkspaceHome(tx, orgId, "nadie", { patients: false, appointments: false, conversations: true, tasks: false, allTasks: false, finance: false, clinical: false, crm: false, agent: true, configure: false, ownAppointments: false }))
  // Solo abiertas: coincide con el chip «Sin responder» de la bandeja por defecto.
  const waitingRow = home.waiting.find((row) => row.kind === "conversations")
  expect(waitingRow?.kind === "conversations" ? waitingRow.waiting : 0).toBe((await summary({ status: "open" })).waiting)

  // Con el agente desactivado en la organización nadie está «con el agente».
  await ownerDb.update(agentConfig).set({ enabled: false }).where(eq(agentConfig.organizationId, orgId))
  expect((await summary({ status: "open" })).withAgent).toBe(0)
  expect((await list()).items.every((item) => !item.attention.agentAttending)).toBe(true)
})
