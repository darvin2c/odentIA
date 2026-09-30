import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { agentProposal } from "@odentia/db/schema/agent"
import { eq } from "drizzle-orm"
import { member, user } from "@odentia/db/schema/auth"
import { beforeAll, describe, expect, it } from "vitest"
import {
  buildAgentProposalKey,
  confirmProposalByContact,
  createProposal,
  decideProposal,
  executeProposal,
  getProposal,
  updateAutonomyPolicy,
} from "./agent-operations.js"
import { createConnection } from "./connections.js"
import { getConversationDetail, type IngestDeps, ingestInbound, listMessages } from "./conversations.js"
import { createOpportunity, getOpportunity, listOpportunities, moveOpportunity, updateOpportunity } from "./opportunities.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()
beforeAll(async () => {
  await ownerDb.insert(user).values({ id: "owner-1", name: "Operador de prueba", email: "owner@crm-behavior.test", emailVerified: true })
  await ownerDb.insert(member).values({ id: "owner-membership", userId: "owner-1", organizationId: "org_a", role: "owner", createdAt: new Date() })
})

const KEY = secretsKeyFromEnv("cc".repeat(32))
const ORG = "org_a"

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
  putAttachment: async ({ orgId, conversationId, bytes, contentType }) => ({
    objectKey: `${orgId}/${conversationId}/f.bin`, mimeType: contentType, filename: "f.bin", size: bytes.byteLength,
  }),
  attachmentUrl: async (key) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async ({ orgId, patientId, bytes, contentType }) => ({
    objectKey: `patients/${orgId}/${patientId}/f.bin`, mimeType: contentType, filename: "f.bin", size: bytes.byteLength,
  }),
  putPatientAvatar: async () => { throw new Error("no usado") },
}

const deps: IngestDeps = { storage: storageStub, fetch, secretsKey: KEY }

function textEvent(sender: string, eventId: string, text: string): NormalizedInbound {
  return {
    externalEventId: eventId,
    externalMessageId: eventId,
    externalThreadId: `tg:${sender}`,
    senderExternalId: `tg:${sender}`,
    senderDisplayName: sender,
    content: { type: "text", text },
    sentAt: new Date().toISOString(),
  }
}

async function connectionId(): Promise<string> {
  return withOrgContext(appDb, ORG, (tx) =>
    createConnection(tx, ORG, KEY,
      { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } },
      { fetch, validateExternal: false }).then((c) => c.id),
  )
}

async function inbound(sender: string, connId: string, eventId: string, text: string): Promise<string> {
  const job: InboundMessageJob = { orgId: ORG, connectionId: connId, event: textEvent(sender, eventId, text) }
  const ingested = await withOrgContext(appDb, ORG, (tx) => ingestInbound(tx, job, stubAdapter, deps))
  return ingested.conversationId
}

async function openConversation(sender: string, eventId: string): Promise<{ conversationId: string; contactId: string; connectionId: string }> {
  const connId = await connectionId()
  const conversationId = await inbound(sender, connId, eventId, "Hola")
  const contactId = await withOrgContext(appDb, ORG, async (tx) => {
    const full = await getConversationDetail(tx, ORG, conversationId)
    return full.contact.id
  })
  return { conversationId, contactId, connectionId: connId }
}

async function openStages(): Promise<{ openA: string; openB: string }> {
  return withOrgContext(appDb, ORG, async (tx) => {
    const { stages } = await ensureDefaultPipeline(tx, ORG)
    const open = stages.filter((s) => s.kind === "open")
    if (!open[0] || !open[1]) throw new Error("El pipeline semilla no trae dos etapas abiertas")
    return { openA: open[0].id, openB: open[1].id }
  })
}

function run<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
  return withOrgContext(appDb, ORG, fn)
}


describe("clave de idempotencia", () => {
  it("es estable ante el mismo trigger y cambia con otro trigger", () => {
    const payload = { kind: "text", text: "Hola" }
    const first = buildAgentProposalKey({ conversationId: "conv-1", triggerMessageId: "msg-1", tool: "send_reply", payload })
    const replay = buildAgentProposalKey({ conversationId: "conv-1", triggerMessageId: "msg-1", tool: "send_reply", payload })
    const other = buildAgentProposalKey({ conversationId: "conv-1", triggerMessageId: "msg-2", tool: "send_reply", payload })
    expect(replay).toBe(first)
    expect(other).not.toBe(first)
  })
})

describe("recorrido comercial con aprobación del equipo", () => {
  it("crear_oportunidad se aprueba y ejecuta una sola vez aunque se reintente", async () => {
    const { conversationId, contactId } = await openConversation("comercial-1", "evt-com-1")
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { crear_oportunidad: "aprobar_equipo" }))
    const created = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "crear_oportunidad",
        payload: { title: "Ortodoncia — seguimiento" },
        idempotencyKey: "test:crm-agent:crear-1",
      }),
    )
    expect(created.status).toBe("propuesta")
    expect(created.mode).toBe("aprobar_equipo")
    const approved = await run((tx) => decideProposal(tx, ORG, "owner-1", created.id, { decision: "aprobada" }))
    expect(approved.status).toBe("ejecutada")
    const again = await run((tx) => executeProposal(tx, ORG, "owner-1", created.id))
    expect(again.status).toBe("ejecutada")
    const { items } = await run((tx) => listOpportunities(tx, ORG, { contactId, status: "open" }))
    expect(items.filter((o) => o.title === "Ortodoncia — seguimiento")).toHaveLength(1)
    expect(again.context.opportunityTitle).toBe("Ortodoncia — seguimiento")
    expect(again.context.contactName).not.toBeNull()
  })

  it("replay con la misma clave devuelve la propuesta sin reenviar el mensaje", async () => {
    const { conversationId } = await openConversation("comercial-2", "evt-com-2")
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { enviar_mensaje: "directo" }))
    const first = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "enviar_mensaje",
        payload: { kind: "text", text: "Te confirmamos tu visita de mañana." },
        idempotencyKey: "test:crm-agent:replay-1",
      }),
    )
    expect(first.status).toBe("ejecutada")
    const replay = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "enviar_mensaje",
        payload: { kind: "text", text: "Te confirmamos tu visita de mañana." },
        idempotencyKey: "test:crm-agent:replay-1",
      }),
    )
    expect(replay.id).toBe(first.id)
    const { items } = await run((tx) => listMessages(tx, ORG, conversationId, {}))
    expect(items.filter((m) => m.direction === "out")).toHaveLength(1)
  })

  it("la oportunidad de otro interlocutor queda fallida sin tocarla (autoridad por contacto)", async () => {
    const { conversationId } = await openConversation("comercial-3", "evt-com-3")
    const other = await openConversation("comercial-4", "evt-com-4")
    const foreign = await run((tx) =>
      createOpportunity(tx, ORG, { contactId: other.contactId, title: "Ajena" }, { userId: null }),
    )
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { cerrar_oportunidad: "aprobar_equipo" }))
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "cerrar_oportunidad",
        payload: { opportunityId: foreign.id, outcome: "won", reason: "Motivo válido" },
        idempotencyKey: "test:crm-agent:cross-1",
      }),
    )
    const decided = await run((tx) => decideProposal(tx, ORG, "owner-1", proposal.id, { decision: "aprobada" }))
    expect(decided.status).toBe("fallida")
    expect(decided.error).toMatch(/^VALIDATION: /)
    expect(decided.error).toContain("este interlocutor")
    expect(decided.result).toMatchObject({ errorCode: "VALIDATION" })
    const untouched = await run(tx => getOpportunity(tx, ORG, foreign.id))
    expect(untouched.status).toBe("open")
    await expect(
      run((tx) => executeProposal(tx, ORG, "owner-1", proposal.id)),
    ).rejects.toMatchObject({ code: "PROPOSAL_NOT_APPROVED", status: 409 })
    const reread = await run(tx => getProposal(tx, ORG, proposal.id))
    expect(reread.status).toBe("fallida")
    expect(reread.result).toMatchObject({ errorCode: "VALIDATION" })
  })

  it("en confirmar_usuario el equipo no aprueba y ejecuta: solo rechaza o confirma el paciente", async () => {
    const { conversationId } = await openConversation("comercial-5", "evt-com-5")
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { crear_oportunidad: "confirmar_usuario" }))
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "crear_oportunidad",
        payload: { title: "Brackets metálicos" },
        idempotencyKey: "test:crm-agent:policy-1",
      }),
    )
    expect(proposal.mode).toBe("confirmar_usuario")
    await expect(
      run((tx) => decideProposal(tx, ORG, "owner-1", proposal.id, { decision: "aprobada" })),
    ).rejects.toMatchObject({ code: "PROPOSAL_NEEDS_CONTACT_CONFIRM", status: 409 })
    const rejected = await run((tx) => decideProposal(tx, ORG, "owner-1", proposal.id, { decision: "rechazada" }))
    expect(rejected.status).toBe("rechazada")
  })

  it("confirmación explícita del paciente ejecuta el seguimiento propuesto", async () => {
    const sender = "comercial-6"
    const { conversationId, contactId, connectionId: connId } = await openConversation(sender, "evt-com-6")
    const { openA } = await openStages()
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Limpieza", stageId: openA }, { userId: null }),
    )
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { actualizar_seguimiento: "confirmar_usuario" }))
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "actualizar_seguimiento",
        payload: { opportunityId: opp.id, nextActionNote: "Llamar para confirmar asistencia" },
        idempotencyKey: "test:crm-agent:confirm-1",
      }),
    )
    expect(proposal.status).toBe("propuesta")
    await inbound(sender, connId, "evt-com-6-si", "Sí, confirmo")
    const confirmed = await run((tx) => confirmProposalByContact(tx, ORG, contactId, proposal.id))
    expect(confirmed.status).toBe("ejecutada")
    expect((await run(tx => getOpportunity(tx, ORG, opp.id))).nextActionNote).toBe("Llamar para confirmar asistencia")
    const reread = await run((tx) => getProposal(tx, ORG, proposal.id))
    expect(reread.result).toMatchObject({ opportunityId: opp.id })
  })
})

describe("evidencia congelada de lo aprobado", () => {
  it("el seguimiento pendiente muestra el antes original y el después nuevo", async () => {
    const { conversationId, contactId } = await openConversation("evidencia-1", "evt-evi-1")
    const { openA } = await openStages()
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Ortodoncia", stageId: openA, nextActionNote: "Nota original" }, { userId: null }),
    )
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { actualizar_seguimiento: "aprobar_equipo" }))
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "actualizar_seguimiento",
        payload: { opportunityId: opp.id, nextActionNote: "Nota nueva" },
        idempotencyKey: "test:crm-agent:evi-1",
      }),
    )
    expect(proposal.status).toBe("propuesta")
    expect(proposal.context.beforeSummary).toContain("Nota original")
    expect(proposal.context.afterSummary).toContain("Nota nueva")
    expect(typeof proposal.context.afterSummary).toBe("string")
  })

  it("la ejecución y cambios posteriores no reescriben la evidencia", async () => {
    const { conversationId, contactId } = await openConversation("evidencia-2", "evt-evi-2")
    const { openA } = await openStages()
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Implante", stageId: openA, nextActionNote: "Nota base" }, { userId: null }),
    )
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { actualizar_seguimiento: "aprobar_equipo" }))
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "actualizar_seguimiento",
        payload: { opportunityId: opp.id, nextActionNote: "Nota aprobada" },
        idempotencyKey: "test:crm-agent:evi-2",
      }),
    )
    const pendingBefore = proposal.context.beforeSummary
    const pendingAfter = proposal.context.afterSummary
    const approved = await run((tx) => decideProposal(tx, ORG, "owner-1", proposal.id, { decision: "aprobada" }))
    expect(approved.status).toBe("ejecutada")
    expect(approved.context.beforeSummary).toBe(pendingBefore)
    expect(approved.context.afterSummary).toBe(pendingAfter)
    await run((tx) => updateOpportunity(tx, ORG, opp.id, { nextActionNote: "Nota posterior" }, { userId: null }))
    const reread = await run((tx) => getProposal(tx, ORG, proposal.id))
    expect(reread.context.beforeSummary).toBe(pendingBefore)
    expect(reread.context.afterSummary).toBe(pendingAfter)
    expect(reread.context.beforeSummary).toContain("Nota base")
  })

  it("el replay con la misma clave conserva los mismos snapshots", async () => {
    const { conversationId, contactId } = await openConversation("evidencia-3", "evt-evi-3")
    const { openA } = await openStages()
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Endodoncia", stageId: openA }, { userId: null }),
    )
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { cerrar_oportunidad: "aprobar_equipo" }))
    const first = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "cerrar_oportunidad",
        payload: { opportunityId: opp.id, outcome: "won", reason: "Aceptó el tratamiento" },
        idempotencyKey: "test:crm-agent:evi-3",
      }),
    )
    const replay = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "cerrar_oportunidad",
        payload: { opportunityId: opp.id, outcome: "won", reason: "Aceptó el tratamiento" },
        idempotencyKey: "test:crm-agent:evi-3",
      }),
    )
    expect(replay.id).toBe(first.id)
    expect(replay.context.beforeSummary).toBe(first.context.beforeSummary)
    expect(replay.context.afterSummary).toBe(first.context.afterSummary)
    expect(first.context.afterSummary).toContain("Ganada")
  })

  it("el legado sin snapshot no reconstruye el estado previo desde el actual", async () => {
    const { conversationId, contactId } = await openConversation("evidencia-4", "evt-evi-4")
    const { openA } = await openStages()
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Legada", stageId: openA }, { userId: null }),
    )
    await run((tx) =>
      tx.insert(agentProposal).values({
        organizationId: ORG, conversationId, contactId,
        action: "cerrar_oportunidad",
        payload: { opportunityId: opp.id, outcome: "won", reason: "Motivo legado" },
        idempotencyKey: "test:crm-agent:evi-legacy-1",
      }),
    )
    const legacy = await run(async (tx) => getProposal(tx, ORG,
      (await tx.select().from(agentProposal).then((rows) => rows.find((r) => r.idempotencyKey === "test:crm-agent:evi-legacy-1")!)).id,
    ))
    expect(legacy.context.beforeSummary).toBeNull()
  })
})

describe("el hilo nunca se silencia: mensajes y caducidad", () => {
  it("una propuesta comercial pendiente no bloquea comunicar en modo directo", async () => {
    const { conversationId, contactId } = await openConversation("hilo-1", "evt-hilo-1")
    const { openA } = await openStages()
    await run((tx) =>
      updateAutonomyPolicy(tx, ORG, "owner-1", { actualizar_seguimiento: "aprobar_equipo", enviar_mensaje: "directo" }),
    )
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Evaluación", stageId: openA }, { userId: null }),
    )
    const followup = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "actualizar_seguimiento",
        payload: { opportunityId: opp.id, nextActionNote: "Llamar mañana" },
        idempotencyKey: "test:crm-agent:hilo-1",
      }),
    )
    expect(followup.status).toBe("propuesta")
    const message = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "enviar_mensaje",
        payload: { kind: "text", text: "El equipo revisará el cambio de horario." },
        idempotencyKey: "test:crm-agent:hilo-2",
      }),
    )
    expect(message.status).toBe("ejecutada")
    expect(message.result).toMatchObject({ kind: "text" })
    const pending = await run((tx) => getProposal(tx, ORG, followup.id))
    expect(pending.status).toBe("propuesta")
  })

  it("un mensaje pendiente no frena la propuesta comercial", async () => {
    const { conversationId, contactId } = await openConversation("hilo-2", "evt-hilo-2")
    await run((tx) =>
      updateAutonomyPolicy(tx, ORG, "owner-1", { enviar_mensaje: "aprobar_equipo", crear_oportunidad: "aprobar_equipo" }),
    )
    const message = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "enviar_mensaje",
        payload: { kind: "text", text: "Te escribimos de la clínica." },
        idempotencyKey: "test:crm-agent:hilo-3",
      }),
    )
    expect(message.status).toBe("propuesta")
    const commercial = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "crear_oportunidad",
        payload: { title: "Interés en ortodoncia" },
        idempotencyKey: "test:crm-agent:hilo-4",
      }),
    )
    expect(commercial.status).toBe("propuesta")
    expect(commercial.contactId).toBe(contactId)
  })

  it("las propuestas viejas caducan, persisten y no bloquean la conversación", async () => {
    const { conversationId, contactId } = await openConversation("hilo-3", "evt-hilo-3")
    const { openA } = await openStages()
    await run((tx) =>
      updateAutonomyPolicy(tx, ORG, "owner-1", { actualizar_seguimiento: "aprobar_equipo" }),
    )
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Limpieza", stageId: openA }, { userId: null }),
    )
    const old = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "actualizar_seguimiento",
        payload: { opportunityId: opp.id, nextActionNote: "Nota vieja" },
        idempotencyKey: "test:crm-agent:hilo-5",
      }),
    )
    await run((tx) =>
      tx.update(agentProposal).set({ createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) }).where(eq(agentProposal.id, old.id)),
    )
    // Confirmar una vencida devuelve el estado real (HTTP 200) y lo persiste
    // en esa misma tx, sin lectura previa.
    const done = await run((tx) => confirmProposalByContact(tx, ORG, contactId, old.id))
    expect(done.status).toBe("expirada")
    const reread = await run((tx) => getProposal(tx, ORG, old.id))
    expect(reread.status).toBe("expirada")
    const fresh = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "actualizar_seguimiento",
        payload: { opportunityId: opp.id, nextActionNote: "Nota nueva" },
        idempotencyKey: "test:crm-agent:hilo-6",
      }),
    )
    expect(fresh.status).toBe("propuesta")
  })

  it("decidir una propuesta vencida no ejecuta y devuelve expirada", async () => {
    const { conversationId, contactId } = await openConversation("hilo-4", "evt-hilo-4")
    const { openA } = await openStages()
    await run((tx) =>
      updateAutonomyPolicy(tx, ORG, "owner-1", { actualizar_seguimiento: "aprobar_equipo" }),
    )
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Frenillos", stageId: openA, nextActionNote: "Nota base" }, { userId: null }),
    )
    const old = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "actualizar_seguimiento",
        payload: { opportunityId: opp.id, nextActionNote: "Nota vencida" },
        idempotencyKey: "test:crm-agent:hilo-7",
      }),
    )
    await run((tx) =>
      tx.update(agentProposal).set({ createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) }).where(eq(agentProposal.id, old.id)),
    )
    const decided = await run((tx) => decideProposal(tx, ORG, "owner-1", old.id, { decision: "aprobada" }))
    expect(decided.status).toBe("expirada")
    const kept = await run((tx) => getOpportunity(tx, ORG, opp.id))
    expect(kept.nextActionNote).toBe("Nota base")
  })

  it("una sola propuesta espera confirmación del paciente por hilo", async () => {
    const { conversationId, contactId } = await openConversation("hilo-5", "evt-hilo-5")
    const { openA } = await openStages()
    await run((tx) =>
      updateAutonomyPolicy(tx, ORG, "owner-1", { actualizar_seguimiento: "confirmar_usuario", enviar_mensaje: "confirmar_usuario" }),
    )
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Blanqueamiento", stageId: openA }, { userId: null }),
    )
    const first = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "actualizar_seguimiento",
        payload: { opportunityId: opp.id, nextActionNote: "Llamar hoy" },
        idempotencyKey: "test:crm-agent:hilo-8",
      }),
    )
    expect(first.status).toBe("propuesta")
    await expect(
      run((tx) =>
        createProposal(tx, ORG, {
          conversationId, action: "enviar_mensaje",
          payload: { kind: "text", text: "Confirmamos tu cita." },
          idempotencyKey: "test:crm-agent:hilo-9",
        }),
      ),
    ).rejects.toMatchObject({ code: "PROPOSAL_PENDING", status: 409 })
    // En modo directo el mensaje sí coexiste con la espera de confirmación.
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { enviar_mensaje: "directo" }))
    const direct = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "enviar_mensaje",
        payload: { kind: "text", text: "Te avisaremos por aquí." },
        idempotencyKey: "test:crm-agent:hilo-10",
      }),
    )
    expect(direct.status).toBe("ejecutada")
  })
})

describe("obsolescencia y fallo transaccional", () => {
  it("mover tras la decisión humana queda fallida sin pisarla", async () => {
    const { conversationId, contactId } = await openConversation("stale-1", "evt-stale-1")
    const { openA, openB } = await openStages()
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { mover_oportunidad: "aprobar_equipo" }))
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Ortodoncia", stageId: openA }, { userId: null }),
    )
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "mover_oportunidad",
        payload: { opportunityId: opp.id, stageId: openB },
        idempotencyKey: "test:crm-agent:stale-1",
      }),
    )
    expect(proposal.status).toBe("propuesta")
    expect(proposal.context.isStale).toBe(false)
    await run((tx) => moveOpportunity(tx, ORG, opp.id, openB, { userId: null }))
    const decided = await run((tx) => decideProposal(tx, ORG, "owner-1", proposal.id, { decision: "aprobada" }))
    expect(decided.status).toBe("fallida")
    expect(decided.error).toMatch(/^PROPOSAL_STALE: /)
    expect(decided.error).toContain("obsoleta")
    expect(decided.result).toMatchObject({ errorCode: "PROPOSAL_STALE" })
    expect(decided.context.isStale).toBe(true)
    expect(decided.context.currentSummary).toContain("Etapa actual")
    const kept = await run((tx) => getOpportunity(tx, ORG, opp.id))
    expect(kept.stageId).toBe(openB)
    const reread = await run((tx) => getProposal(tx, ORG, proposal.id))
    expect(reread.status).toBe("fallida")
    expect(reread.context.isStale).toBe(true)
  })

  it("el seguimiento cambiado por un humano no se sobrescribe", async () => {
    const { conversationId, contactId } = await openConversation("stale-2", "evt-stale-2")
    const { openA } = await openStages()
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { actualizar_seguimiento: "aprobar_equipo" }))
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Implante", stageId: openA, nextActionNote: "Nota original" }, { userId: null }),
    )
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "actualizar_seguimiento",
        payload: { opportunityId: opp.id, nextActionNote: "Nota propuesta" },
        idempotencyKey: "test:crm-agent:stale-2",
      }),
    )
    await run((tx) => updateOpportunity(tx, ORG, opp.id, { nextActionNote: "Nota humana" }, { userId: null }))
    const decided = await run((tx) => decideProposal(tx, ORG, "owner-1", proposal.id, { decision: "aprobada" }))
    expect(decided.status).toBe("fallida")
    expect(decided.result).toMatchObject({ errorCode: "PROPOSAL_STALE" })
    expect(decided.context.currentSummary).toContain("Nota humana")
    const kept = await run((tx) => getOpportunity(tx, ORG, opp.id))
    expect(kept.nextActionNote).toBe("Nota humana")
  })

  it("una propuesta sin evidencia de estado no ejecuta a ciegas", async () => {
    const { conversationId, contactId } = await openConversation("stale-3", "evt-stale-3")
    const { openA } = await openStages()
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { cerrar_oportunidad: "aprobar_equipo" }))
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Corona", stageId: openA }, { userId: null }),
    )
    await run((tx) =>
      tx.insert(agentProposal).values({
        organizationId: ORG, conversationId, contactId,
        action: "cerrar_oportunidad",
        payload: { opportunityId: opp.id, outcome: "won", reason: "Motivo sin evidencia" },
        idempotencyKey: "test:crm-agent:stale-legacy-1",
      }),
    )
    const legacy = await run(async (tx) => getProposal(tx, ORG,
      (await tx.select().from(agentProposal).then((rows) => rows.find((r) => r.idempotencyKey === "test:crm-agent:stale-legacy-1")!)).id,
    ))
    expect(legacy.status).toBe("propuesta")
    expect(legacy.context.isStale).toBe(true)
    const decided = await run((tx) => decideProposal(tx, ORG, "owner-1", legacy.id, { decision: "aprobada" }))
    expect(decided.status).toBe("fallida")
    expect(decided.error).toContain("evidencia de estado")
    const kept = await run((tx) => getOpportunity(tx, ORG, opp.id))
    expect(kept.status).toBe("open")
  })

  it("la evidencia congelada no se reescribe por SQL directo", async () => {
    const { conversationId, contactId } = await openConversation("stale-4", "evt-stale-4")
    const { openA, openB } = await openStages()
    await run((tx) => updateAutonomyPolicy(tx, ORG, "owner-1", { mover_oportunidad: "aprobar_equipo" }))
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Puente", stageId: openA }, { userId: null }),
    )
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "mover_oportunidad",
        payload: { opportunityId: opp.id, stageId: openB },
        idempotencyKey: "test:crm-agent:stale-4",
      }),
    )
    await expect(
      run((tx) =>
        tx.update(agentProposal).set({ expectedState: { manipulated: true } }).where(eq(agentProposal.id, proposal.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } })
    const intact = await run((tx) => getProposal(tx, ORG, proposal.id))
    expect(intact.status).toBe("propuesta")
    expect(intact.context.isStale).toBe(false)
  })
})
