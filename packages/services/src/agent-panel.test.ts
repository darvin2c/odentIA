import { randomUUID } from "node:crypto"
import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { agentRunLedger } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { patient, patientContact, treatmentBudget, treatmentPlan } from "@odentia/db/schema/clinical"
import { contact, crmTask, message } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { listAgentActivity } from "./agent-activity.js"
import {
  claimHandoff,
  countAwaitingContact,
  createHandoff,
  createProposal,
  getAgentPanelSummary,
  getAgentPatientSummary,
  listHandoffs,
} from "./agent-operations.js"
import { createConnection } from "./connections.js"
import { getConversationDetail, type IngestDeps, ingestInbound, sendOutbound } from "./conversations.js"
import { createOpportunity, setOpportunityTask } from "./opportunities.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { updateTask } from "./tasks.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Panel lateral del agente: lo que recepción ve y atiende desde cualquier
 * pantalla. Base propia por archivo, así los contadores son deterministas.
 */
setupTestDb()
const ORG = "org_a"
const OWNER = "panel-owner"
const RECEP = "panel-recep"
const KEY = secretsKeyFromEnv("dd".repeat(32))

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: OWNER, name: "Dueña", email: "owner@panel.test", emailVerified: true },
    { id: RECEP, name: "Recepción", email: "recep@panel.test", emailVerified: true },
  ])
  await ownerDb.insert(member).values([
    { id: `m-${OWNER}`, userId: OWNER, organizationId: ORG, role: "owner", createdAt: new Date() },
    { id: `m-${RECEP}`, userId: RECEP, organizationId: ORG, role: "reception", createdAt: new Date() },
  ])
})

const stubAdapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: { templates: false, media: true, interactive: false, readReceipts: false, edit: true },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "stub-1" }),
  validateConnection: async () => ({ externalId: "bot-1", displayName: "Bot" }),
}
const storageStub: Storage = {
  putAvatar: async () => { throw new Error("no usado") },
  deleteByUrl: async () => {},
  putAttachment: async () => { throw new Error("no usado") },
  attachmentUrl: async (key) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => { throw new Error("no usado") },
  putPatientAvatar: async () => { throw new Error("no usado") },
}
const deps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY }

function run<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return withOrgContext(appDb, ORG, fn)
}

let connId: string
async function openConversation(sender: string): Promise<{ conversationId: string; contactId: string }> {
  connId ??= await run((tx) =>
    createConnection(tx, ORG, KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } },
      { fetch, validateExternal: false }).then((c) => c.id))
  const event: NormalizedInbound = {
    externalEventId: `evt-${sender}`, externalMessageId: `evt-${sender}`,
    externalThreadId: `tg:${sender}`, senderExternalId: `tg:${sender}`, senderDisplayName: sender,
    content: { type: "text", text: "Hola" }, sentAt: new Date().toISOString(),
  }
  const job: InboundMessageJob = { orgId: ORG, connectionId: connId, event }
  const { conversationId } = await run((tx) => ingestInbound(tx, job, stubAdapter, deps))
  const contactId = await run(async (tx) => (await getConversationDetail(tx, ORG, conversationId)).contact.id)
  return { conversationId, contactId }
}

it("el resumen cuenta lo que espera al paciente y los casos por atender, y no cuenta fallos como intervenciones", async () => {
  const { conversationId } = await openConversation("resumen")
  // Espera al interlocutor: una cita propuesta en el hilo. Es lo único que queda pendiente.
  await run((tx) => createProposal(tx, ORG, {
    conversationId, action: "reservar_cita", idempotencyKey: "panel:cita-1",
    payload: { patientId: randomUUID(), dentistUserId: OWNER, chairId: randomUUID(), startsAt: "2026-11-02T15:00:00.000Z" },
  }))
  // Un mensaje del agente sale directo: no queda nada que decidir.
  const message = await run((tx) => createProposal(tx, ORG, {
    conversationId, action: "enviar_mensaje", idempotencyKey: "panel:mensaje-1", payload: { kind: "text", text: "Hola" },
  }))
  expect(message.status).toBe("ejecutada")
  // Lo que espera al equipo es un caso derivado.
  await run((tx) => createHandoff(tx, ORG, null, {
    conversationId, reason: "Pide hablar con una persona", summary: "Prefiere atención humana", createdBy: "agent",
  }))
  await ownerDb.insert(agentRunLedger).values([
    { organizationId: ORG, model: "prueba", status: "ok", startedAt: new Date() },
    { organizationId: ORG, model: "prueba", status: "handoff", startedAt: new Date() },
    { organizationId: ORG, model: "prueba", status: "error", startedAt: new Date() },
    { organizationId: ORG, model: "prueba", status: "sin_respuesta", startedAt: new Date() },
    { organizationId: ORG, model: "prueba", status: "omitida", startedAt: new Date() },
  ])
  expect(await run((tx) => countAwaitingContact(tx, ORG))).toBe(1)
  const summary = await run((tx) => getAgentPanelSummary(tx, ORG, RECEP))
  expect(summary).toMatchObject({
    awaitingContact: 1, openHandoffs: 1, interventionsToday: 2, failedToday: 2, enabled: false,
  })
  expect(summary).not.toHaveProperty("pendingProposals")
  expect(summary.timezone).toBeTruthy()
  expect(summary.locale).toBeTruthy()
})

it("la actividad muestra la entrega real de lo enviado y solo lo que hizo el agente", async () => {
  const { conversationId } = await openConversation("actividad")
  const proposal = await run((tx) => createProposal(tx, ORG, {
    conversationId, action: "enviar_mensaje", payload: { kind: "text", text: "Te confirmo la cita." }, idempotencyKey: "panel:act-1",
  }))
  expect(proposal.status).toBe("ejecutada")
  const messageId = proposal.result?.["messageId"]
  expect(typeof messageId).toBe("string")
  // Un recordatorio automático también sale con sender_kind=agent, pero no es obra del agente.
  const automation = await run((tx) => sendOutbound(tx, ORG, {
    conversationId, senderKind: "agent", content: { type: "text", text: "Recordatorio automático" },
  }))
  const human = await run((tx) => createHandoff(tx, ORG, OWNER, {
    conversationId, reason: "Lo derivo yo", summary: "Derivación manual", createdBy: "user",
  }))
  const byAgent = await run((tx) => createHandoff(tx, ORG, null, {
    conversationId, reason: "Pide hablar con una persona", summary: "Prefiere atención humana", createdBy: "agent",
  }))

  let items = await run((tx) => listAgentActivity(tx, ORG, {}))
  const sent = items.find((i) => i.id === proposal.id)
  expect(sent).toMatchObject({ kind: "mensaje", status: "queued", title: "Mensaje pendiente de envío", conversationId })
  expect(items.find((i) => i.id === automation.id)).toBeUndefined()
  expect(items.find((i) => i.id === human.id)).toBeUndefined()
  expect(items.find((i) => i.id === byAgent.id)).toMatchObject({ kind: "derivacion", status: "abierta", title: "Te pasó el caso" })

  // El proveedor rechaza el envío: la actividad deja de afirmar «envió».
  await ownerDb.update(message).set({ status: "failed" }).where(eq(message.id, messageId as string))
  items = await run((tx) => listAgentActivity(tx, ORG, {}))
  expect(items.find((i) => i.id === proposal.id)).toMatchObject({ kind: "mensaje", status: "failed", title: "No pudo enviar un mensaje" })
  await ownerDb.update(message).set({ status: "delivered" }).where(eq(message.id, messageId as string))
  items = await run((tx) => listAgentActivity(tx, ORG, {}))
  expect(items.find((i) => i.id === proposal.id)).toMatchObject({ kind: "mensaje", status: "delivered", title: "Envió un mensaje" })
})

it("una derivación resuelta no se toma, y la de un seguimiento comercial asigna la oportunidad", async () => {
  const resolved = await openConversation("resuelta")
  const handoff = await run((tx) => createHandoff(tx, ORG, null, {
    conversationId: resolved.conversationId, reason: "Pide una persona", summary: "Pide una persona", createdBy: "agent",
  }))
  expect(handoff.status).toBe("abierta")
  await run((tx) => updateTask(tx, ORG, handoff.taskId as string, { status: "done", actorUserId: OWNER }))
  expect((await run((tx) => listHandoffs(tx, ORG, { open: true }))).map((h) => h.id)).not.toContain(handoff.id)
  expect((await run((tx) => listHandoffs(tx, ORG, {}))).find((h) => h.id === handoff.id)?.status).toBe("resuelta")
  await expect(run((tx) => claimHandoff(tx, ORG, RECEP, handoff.id))).rejects.toThrow("ya se resolvió")

  // La tarea de una oportunidad sin responsable (Recepción): tomar el caso que
  // la usa se la asigna a quien lo toma, sin otra tarea.
  const commercial = await openConversation("comercial")
  const opportunity = await run((tx) => createOpportunity(tx, ORG, {
    contactId: commercial.contactId, conversationId: commercial.conversationId, title: "Implante",
  }, { userId: null }))
  await run((tx) => setOpportunityTask(tx, ORG, opportunity.id, {
    title: "Llamar", dueAt: new Date(Date.now() + 86_400_000).toISOString(),
  }, { userId: null, createdBy: "agent" }))
  expect(opportunity.assignedUserId).toBeNull()
  const [followUp] = await run((tx) => tx.select().from(crmTask)
    .where(and(eq(crmTask.organizationId, ORG), eq(crmTask.opportunityId, opportunity.id), eq(crmTask.status, "open"))))
  expect(followUp?.area).toBe("recepcion")
  const derived = await run((tx) => createHandoff(tx, ORG, null, {
    conversationId: commercial.conversationId, taskId: followUp?.id, reason: "La coordinación no pudo completarse",
    summary: "Dos intentos sin respuesta", createdBy: "agent",
  }))
  expect(derived.status).toBe("abierta")
  const claimed = await run((tx) => claimHandoff(tx, ORG, RECEP, derived.id))
  expect(claimed.assigneeUserId).toBe(RECEP)
  expect(claimed.status).toBe("tomada")
  const [task] = await run((tx) => tx.select().from(crmTask).where(eq(crmTask.id, followUp?.id as string)))
  expect(task?.assigneeUserId).toBe(RECEP)
})

it("el resumen del agente excluye los presupuestos en borrador", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `agente-${orgId.slice(0, 8)}`)
  const [who] = await ownerDb.insert(contact).values({ organizationId: orgId, displayName: "Contacto agente" }).returning({ id: contact.id })
  const [ficha] = await ownerDb.insert(patient).values({ organizationId: orgId, displayName: "Paciente agente", patientNumber: 1 }).returning({ id: patient.id })
  await ownerDb.insert(patientContact).values({ organizationId: orgId, patientId: ficha!.id, contactId: who!.id, relationship: "self" })
  const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: orgId, patientId: ficha!.id, title: "Plan general" }).returning({ id: treatmentPlan.id })
  await ownerDb.insert(treatmentBudget).values([
    { organizationId: orgId, patientId: ficha!.id, planId: plan!.id, budgetNumber: 1, title: "Propuesta presentada", currency: "PEN", status: "presentado" },
    { organizationId: orgId, patientId: ficha!.id, planId: plan!.id, budgetNumber: 2, title: "Borrador interno", currency: "PEN", status: "borrador" },
  ])
  const summary = await withOrgContext(appDb, orgId, tx => getAgentPatientSummary(tx, orgId, who!.id, ficha!.id))
  expect(summary.budgets.map(budget => budget.status)).toEqual(["presentado"])
})
