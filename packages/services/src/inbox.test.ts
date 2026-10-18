import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { agentProposal } from "@odentia/db/schema/agent"
import { agentConfig, channelConnection, contact, conversation, crmTask, message } from "@odentia/db/schema/crm"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { createHandoff } from "./agent-operations.js"
import { getInboxConversationDetail, listInboxConversations, summarizeInbox } from "./inbox.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { getWorkspaceHome } from "./workspace.js"

/**
 * Bandeja: cada conversación trae lo que espera del equipo, del agente o del
 * paciente y cómo se cerró, y los totales de las vistas se cuentan en servidor
 * con los mismos filtros (ADR 0024).
 */
setupTestDb()

async function seedInbox() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `inbox-${orgId}`)
  await ownerDb.insert(agentConfig).values({ organizationId: orgId, enabled: true })
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
      payload: action === "reservar_cita"
        ? { patientId: randomUUID(), dentistUserId: "dentista", chairId: randomUUID(), startsAt: new Date(Date.now() + 86_400_000).toISOString() }
        : { title: "Ortodoncia" },
      afterSummary: "Cambio previsto", idempotencyKey: randomUUID(), createdAt,
    })
  const handoff = (conv: { id: string }, priority: string) =>
    withOrgContext(appDb, orgId, (tx) =>
      createHandoff(tx, orgId, null, { conversationId: conv.id, reason: "Pide una persona", summary: "Pide una persona", priority, createdBy: "agent" }))
  return { orgId, thread, proposal, handoff }
}

it("cada conversación trae su estado de atención y su cierre, y las vistas cuentan con las mismas reglas", async () => {
  const { orgId, thread, proposal, handoff } = await seedInbox()
  const closedValues = { status: "closed", closeReason: "manual", closedAt: new Date() } as const
  // Espera respuesta y la atiende el agente.
  const waiting = await thread("Espera respuesta")
  await ownerDb.insert(message).values({ organizationId: orgId, conversationId: waiting.id, direction: "in", senderKind: "contact", body: "Hola", status: "received" })
  // Se le respondió (saliente aceptado) y no contesta: espera al paciente.
  const answered = await thread("Respondida", { nudgedAt: new Date("2026-10-15T12:00:00Z") })
  const outAt = new Date(Date.now() - 60_000)
  await ownerDb.insert(message).values({ organizationId: orgId, conversationId: answered.id, direction: "in", senderKind: "contact", body: "¿Precio?", status: "received", createdAt: new Date(Date.now() - 120_000) })
  await ownerDb.insert(message).values({ organizationId: orgId, conversationId: answered.id, direction: "out", senderKind: "agent", body: "Son 100", status: "sent", externalId: "wa-1", createdAt: outAt })
  // Una persona la tomó y tiene dos derivaciones abiertas: manda la más alta.
  const derived = await thread("Derivada", { agentStatus: "off" })
  await handoff(derived, "baja")
  await handoff(derived, "alta")
  // Tema cuya tarea se completó directo en la base: derivar no apagó al agente (ADR 0050), así que vuelve a él.
  const resolved = await thread("Resuelta")
  const done = await handoff(resolved, "media")
  await ownerDb.update(crmTask).set({ status: "done" }).where(eq(crmTask.id, done.taskId as string))
  // Una cita que espera al interlocutor y otra vencida: lo único pendiente es lo que confirma él.
  const approval = await thread("Espera al interlocutor")
  await proposal(approval, "reservar_cita")
  await proposal(approval, "reservar_cita", new Date(Date.now() - 49 * 3_600_000))
  const closed = await thread("Cerrada", closedValues)
  // Hilo cuya única propuesta ya venció aunque su fila siga `propuesta`.
  const stale = await thread("Vencida")
  await proposal(stale, "reservar_cita", new Date(Date.now() - 49 * 3_600_000))
  // Hilo cerrado que conserva una derivación sin resolver.
  const closedCase = await thread("Cerrada con caso")
  await handoff(closedCase, "media")
  await ownerDb.update(conversation).set(closedValues).where(eq(conversation.id, closedCase.id))

  const list = (input: Parameters<typeof listInboxConversations>[2] = {}) =>
    withOrgContext(appDb, orgId, (tx) => listInboxConversations(tx, orgId, input))
  const { items } = await list()
  const of = (id: string) => items.find((item) => item.id === id)?.attention
  const base = { pendingContact: 0, handoffPriority: null, unanswered: false, awaitingPatientSince: null, nudgedAt: null, outOfHours: false, assignedName: null, teamLive: false, topics: [] }
  expect(of(waiting.id)).toEqual({ ...base, agentAttending: true, unanswered: true })
  expect(of(answered.id)).toEqual({ ...base, agentAttending: true, awaitingPatientSince: outAt.toISOString(), nudgedAt: "2026-10-15T12:00:00.000Z" })
  // Sus dos temas, el urgente primero; sin mensajes no hay mensaje citado.
  expect(of(derived.id)).toMatchObject({
    ...base,
    agentAttending: false,
    handoffPriority: "alta",
    topics: [
      expect.objectContaining({ priority: "alta", urgent: true, createdBy: "agent", source: null }),
      expect.objectContaining({ priority: "baja", urgent: false }),
    ],
  })
  expect(of(resolved.id)).toEqual({ ...base, agentAttending: true })
  expect(of(approval.id)).toEqual({ ...base, agentAttending: true, pendingContact: 1 })
  expect(of(closed.id)?.agentAttending).toBe(false)
  expect(of(stale.id)).toEqual({ ...base, agentAttending: true })
  expect(of(closedCase.id)).toMatchObject({ ...base, agentAttending: false, handoffPriority: "media", topics: [expect.objectContaining({ priority: "media" })] })
  // El cierre viaja con la fila: motivo, cuándo y quién (nulo si no fue una persona).
  expect(items.find((item) => item.id === closed.id)?.closure).toEqual({ reason: "manual", at: closedValues.closedAt.toISOString(), byName: null })
  expect(items.find((item) => item.id === waiting.id)?.closure).toBeNull()
  // El hilo abierto recibe la misma atención aunque su fila no esté en la lista cargada.
  const detail = await withOrgContext(appDb, orgId, (tx) => getInboxConversationDetail(tx, orgId, approval.id))
  expect(detail.attention).toEqual(of(approval.id))
  expect(detail.closure).toBeNull()

  const ids = async (input: Parameters<typeof listInboxConversations>[2]) => (await list(input)).items.map((item) => item.id).sort()
  // Cuatro vistas que no se superponen (ADR 0050): cada conversación cae en una sola.
  expect(await ids({ view: "attend" })).toEqual([derived.id])
  expect(await ids({ view: "agent" })).toEqual([waiting.id, resolved.id, stale.id].sort())
  // «Esperan al paciente» usa la misma vigencia: la vencida sin marcar no cuenta.
  expect(await ids({ view: "awaiting_patient" })).toEqual([answered.id, approval.id].sort())
  expect(await ids({ view: "closed" })).toEqual([closed.id, closedCase.id].sort())

  const summary = (input: Parameters<typeof summarizeInbox>[2]) =>
    withOrgContext(appDb, orgId, (tx) => summarizeInbox(tx, orgId, input))
  const totals = { open: 6, attend: 1, agent: 3, awaitingPatient: 2, closed: 2 }
  // El estado no cambia los totales: cada chip ya dice si cuenta abiertas o cerradas.
  expect(await summary({})).toEqual(totals)
  expect(await summary({ status: "open" })).toEqual(totals)
  expect(await summary({ q: "Deriv" })).toEqual({ open: 1, attend: 1, agent: 0, awaitingPatient: 0, closed: 0 })
  // Desde el contexto de otra organización, ni pidiendo esta se ve o se cuenta nada.
  expect(await withOrgContext(appDb, "org_b", (tx) => summarizeInbox(tx, orgId, {}))).toEqual({ open: 0, attend: 0, agent: 0, awaitingPatient: 0, closed: 0 })
  expect((await withOrgContext(appDb, "org_b", (tx) => listInboxConversations(tx, orgId, {}))).items).toEqual([])

  // «Te espera» de Inicio cuenta las conversaciones sin responder como la bandeja.
  const home = await withOrgContext(appDb, orgId, (tx) =>
    getWorkspaceHome(tx, orgId, "nadie", { patients: false, appointments: false, conversations: true, tasks: false, allTasks: false, finance: false, clinical: false, crm: false, agent: true, configure: false, ownAppointments: false }))
  const waitingRow = home.waiting.find((row) => row.kind === "conversations")
  // Sin contar las que tienen un tema abierto: esas son su propia fila.
  expect(waitingRow?.kind === "conversations" ? waitingRow.waiting : 0).toBe(1)

  // Fuera del horario del agente lo que espera respuesta queda para cuando abra
  // (de 10:00 a 11:00 en Lima; a las 03:00 está cerrado).
  await ownerDb.update(agentConfig).set({ activeFromMin: 600, activeUntilMin: 660 }).where(eq(agentConfig.organizationId, orgId))
  const night = (await list({ now: new Date("2026-10-15T08:00:00Z") })).items
  expect(night.find((item) => item.id === waiting.id)?.attention.outOfHours).toBe(true)
  expect(night.find((item) => item.id === answered.id)?.attention.outOfHours).toBe(false)
  const morning = (await list({ now: new Date("2026-10-15T15:30:00Z") })).items
  expect(morning.find((item) => item.id === waiting.id)?.attention.outOfHours).toBe(false)

  // Con el agente desactivado en la organización nadie está «con el agente».
  await ownerDb.update(agentConfig).set({ enabled: false }).where(eq(agentConfig.organizationId, orgId))
  expect(await ids({ view: "agent" })).toEqual([])
  expect((await list()).items.every((item) => !item.attention.agentAttending)).toBe(true)
})

it("las vistas viejas y un estado desconocido no se aceptan", async () => {
  const { orgId } = await seedInbox()
  for (const view of ["human", "approval", "handoff"]) {
    await expect(
      withOrgContext(appDb, orgId, (tx) => listInboxConversations(tx, orgId, { view: view as never })),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  }
  await expect(withOrgContext(appDb, orgId, (tx) => listInboxConversations(tx, orgId, { status: "archivada" }))).rejects.toMatchObject({ code: "VALIDATION" })
})
