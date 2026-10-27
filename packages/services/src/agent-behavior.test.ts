import { randomUUID } from "node:crypto"
import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { type Db, type InboundMessageJob, withOrgContext } from "@odentia/db"
import { agentProposal } from "@odentia/db/schema/agent"
import { eq, sql } from "drizzle-orm"
import { member, user } from "@odentia/db/schema/auth"
import { beforeAll, describe, expect, it } from "vitest"
import {
  buildAgentProposalKey,
  confirmProposalByContact,
  createProposal,
  executeProposal,
  getProposal,
  proposalReplyOf,
} from "./agent-operations.js"
import { createConnection } from "./connections.js"
import { getConversationDetail, type IngestDeps, ingestInbound, listMessages } from "./conversations.js"
import { createOpportunity, getOpportunity, listOpportunities, setOpportunityTask } from "./opportunities.js"
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
    const open = stages.filter((s) => s.moment !== "decidio")
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
    const first = buildAgentProposalKey({ conversationId: "conv-1", triggerId: "msg-1", tool: "send_reply", payload })
    const replay = buildAgentProposalKey({ conversationId: "conv-1", triggerId: "msg-1", tool: "send_reply", payload })
    const other = buildAgentProposalKey({ conversationId: "conv-1", triggerId: "msg-2", tool: "send_reply", payload })
    expect(replay).toBe(first)
    expect(other).not.toBe(first)
  })
})

/**
 * Una cita propuesta en el hilo: el único acto que espera el sí del paciente
 * (ADR 0021). Los datos solo tienen que pasar la validación; nadie la ejecuta.
 */
function booking(startsAt = "2026-11-02T15:00:00.000Z"): Record<string, unknown> {
  return { patientId: randomUUID(), professionalUserId: "owner-1", roomId: randomUUID(), startsAt }
}

describe("recorrido comercial directo", () => {
  it("crear_oportunidad va directo y se ejecuta una sola vez aunque se reintente", async () => {
    const { conversationId, contactId } = await openConversation("comercial-1", "evt-com-1")
    const created = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "crear_oportunidad",
        payload: { title: "Ortodoncia — seguimiento" },
        idempotencyKey: "test:crm-agent:crear-1",
      }),
    )
    expect(created.status).toBe("ejecutada")
    expect(created.mode).toBe("directo")
    const again = await run((tx) => executeProposal(tx, ORG, "owner-1", created.id))
    expect(again.status).toBe("ejecutada")
    const { items } = await run((tx) => listOpportunities(tx, ORG, { contactId, status: "open" }))
    expect(items.filter((o) => o.title === "Ortodoncia — seguimiento")).toHaveLength(1)
    expect(again.context.opportunityTitle).toBe("Ortodoncia — seguimiento")
    expect(again.context.contactName).not.toBeNull()
  })

  it("un «hola» no crea una oportunidad; el agente no duplica una abierta del mismo interés y la deja en Recepción", async () => {
    const { conversationId, contactId } = await openConversation("comercial-hola", "evt-com-hola")
    const before = await run((tx) => listOpportunities(tx, ORG, { contactId }))
    expect(before.items).toEqual([])
    const first = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "crear_oportunidad",
        payload: { title: "Blanqueamiento" },
        idempotencyKey: "test:crm-agent:crear-unica-1",
      }),
    )
    const second = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "crear_oportunidad",
        payload: { title: "  blanqueamiento " },
        idempotencyKey: "test:crm-agent:crear-unica-2",
      }),
    )
    expect(first.status).toBe("ejecutada")
    expect(second.status).toBe("ejecutada")
    expect(second.result).toMatchObject({ opportunityId: (first.result as { opportunityId: string }).opportunityId, reused: true })
    const { items } = await run((tx) => listOpportunities(tx, ORG, { contactId, status: "open" }))
    expect(items).toHaveLength(1)
    // Sin responsable: es de Recepción. El historial dice que la creó el agente.
    const detail = await run((tx) => getOpportunity(tx, ORG, items[0]!.id))
    expect(detail).toMatchObject({ assignedUserId: null, moment: "interesado", conversationId })
    expect(detail.history[0]).toMatchObject({ origin: "agente", who: "Sofi" })
  })

  it("replay con la misma clave devuelve la propuesta sin reenviar el mensaje", async () => {
    const { conversationId } = await openConversation("comercial-2", "evt-com-2")
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
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "cerrar_oportunidad",
        payload: { opportunityId: foreign.id, outcome: "won", reason: "Motivo válido" },
        idempotencyKey: "test:crm-agent:cross-1",
      }),
    )
    expect(proposal.status).toBe("fallida")
    expect(proposal.error).toMatch(/^VALIDATION: /)
    expect(proposal.error).toContain("este interlocutor")
    expect(proposal.result).toMatchObject({ errorCode: "VALIDATION" })
    const untouched = await run(tx => getOpportunity(tx, ORG, foreign.id))
    expect(untouched.status).toBe("open")
    await expect(
      run((tx) => executeProposal(tx, ORG, "owner-1", proposal.id)),
    ).rejects.toMatchObject({ code: "PROPOSAL_NOT_APPROVED", status: 409 })
    const reread = await run(tx => getProposal(tx, ORG, proposal.id))
    expect(reread.status).toBe("fallida")
    expect(reread.result).toMatchObject({ errorCode: "VALIDATION" })
  })

  it("una cita la confirma el paciente: sin su sí no se ejecuta, y nadie del equipo la aprueba por él", async () => {
    const { conversationId, contactId } = await openConversation("comercial-5", "evt-com-5")
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "reservar_cita",
        payload: booking(),
        idempotencyKey: "test:crm-agent:policy-1",
      }),
    )
    expect(proposal.status).toBe("propuesta")
    expect(proposal.mode).toBe("confirmar_usuario")
    // Registrar la confirmación exige un sí del paciente en el chat posterior a la propuesta.
    await expect(
      run((tx) => confirmProposalByContact(tx, ORG, contactId, proposal.id, { staffUserId: "owner-1" })),
    ).rejects.toMatchObject({ code: "PROPOSAL_NOT_CONFIRMED", status: 409 })
    expect((await run((tx) => getProposal(tx, ORG, proposal.id))).status).toBe("propuesta")
  })

  it("el sí que entendió el modelo de decisión vale solo si es de la persona y posterior a la propuesta", async () => {
    const { conversationId, contactId, connectionId: connId } = await openConversation("comercial-6", "evt-com-6")
    const [before] = (await run((tx) => listMessages(tx, ORG, conversationId, { limit: 10 }))).items
    const proposal = await run((tx) =>
      createProposal(tx, ORG, { conversationId, action: "reservar_cita", payload: booking(), idempotencyKey: "test:crm-agent:intent-1" }),
    )
    // «Me sirve, ahí estaré el lunes temprano» no es un sí por palabras: lo entiende el modelo de decisión.
    await inbound("comercial-6", connId, "evt-com-6b", "Me sirve, ahí estaré el lunes temprano")
    const pending = await run((tx) => proposalReplyOf(tx, ORG, contactId, proposal.id))
    expect(pending.reply?.body).toBe("Me sirve, ahí estaré el lunes temprano")
    await expect(run((tx) => confirmProposalByContact(tx, ORG, contactId, proposal.id))).rejects.toMatchObject({ code: "PROPOSAL_NOT_CONFIRMED" })
    // Un mensaje de antes de la propuesta no confirma, aunque se lo pase.
    await expect(
      run((tx) => confirmProposalByContact(tx, ORG, contactId, proposal.id, { understoodMessageId: before!.id })),
    ).rejects.toMatchObject({ code: "PROPOSAL_NOT_CONFIRMED" })
    const done = await run((tx) => confirmProposalByContact(tx, ORG, contactId, proposal.id, { understoodMessageId: pending.reply!.id }))
    expect(done.status).not.toBe("propuesta")
    const [audit] = await ownerDb.execute<{ metadata: { understood: string } }>(
      sql`select metadata from audit_event where entity_id = ${proposal.id} and action = 'agent.proposal_confirmed'`,
    )
    expect(audit?.metadata.understood).toBe("modelo_de_decision")
  })
})

describe("evidencia congelada de lo aprobado", () => {
  it("el seguimiento muestra el antes original y el después nuevo", async () => {
    const { conversationId, contactId } = await openConversation("evidencia-1", "evt-evi-1")
    const { openA } = await openStages()
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Ortodoncia" }, { userId: null }),
    )
    await run((tx) => setOpportunityTask(tx, ORG, opp.id, { title: "Nota original" }, { userId: null, createdBy: "user" }))
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "actualizar_seguimiento",
        payload: { opportunityId: opp.id, nextActionNote: "Nota nueva" },
        idempotencyKey: "test:crm-agent:evi-1",
      }),
    )
    expect(proposal.status).toBe("ejecutada")
    expect(proposal.context.beforeSummary).toContain("Nota original")
    expect(proposal.context.afterSummary).toContain("Nota nueva")
    expect(typeof proposal.context.afterSummary).toBe("string")
  })

  it("los cambios posteriores a la ejecución no reescriben la evidencia", async () => {
    const { conversationId, contactId } = await openConversation("evidencia-2", "evt-evi-2")
    const { openA } = await openStages()
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Implante" }, { userId: null }),
    )
    await run((tx) => setOpportunityTask(tx, ORG, opp.id, { title: "Nota base" }, { userId: null, createdBy: "user" }))
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "actualizar_seguimiento",
        payload: { opportunityId: opp.id, nextActionNote: "Nota aprobada" },
        idempotencyKey: "test:crm-agent:evi-2",
      }),
    )
    expect(proposal.status).toBe("ejecutada")
    const executedBefore = proposal.context.beforeSummary
    const executedAfter = proposal.context.afterSummary
    await run((tx) => setOpportunityTask(tx, ORG, opp.id, { title: "Nota posterior" }, { userId: null, createdBy: "user" }))
    const reread = await run((tx) => getProposal(tx, ORG, proposal.id))
    expect(reread.context.beforeSummary).toBe(executedBefore)
    expect(reread.context.afterSummary).toBe(executedAfter)
    expect(reread.context.beforeSummary).toContain("Nota base")
  })

  it("el replay con la misma clave conserva los mismos snapshots", async () => {
    const { conversationId, contactId } = await openConversation("evidencia-3", "evt-evi-3")
    const { openA } = await openStages()
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Endodoncia" }, { userId: null }),
    )
    const first = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "cerrar_oportunidad",
        payload: { opportunityId: opp.id, outcome: "won", reason: "acepto" },
        idempotencyKey: "test:crm-agent:evi-3",
      }),
    )
    const replay = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "cerrar_oportunidad",
        payload: { opportunityId: opp.id, outcome: "won", reason: "acepto" },
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
      createOpportunity(tx, ORG, { contactId, title: "Legada" }, { userId: null }),
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
  it("una cita esperando el sí deja salir los mensajes, la reemplaza otra cita y frena lo comercial", async () => {
    const { conversationId } = await openConversation("hilo-1", "evt-hilo-1")
    const first = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "reservar_cita", payload: booking(), idempotencyKey: "test:crm-agent:hilo-1",
      }),
    )
    expect(first.status).toBe("propuesta")
    // «Mejor el martes a las 10»: la nueva reemplaza a la que nunca recibió su sí,
    // y un «confirmo» ya no puede ejecutar la vieja.
    const waiting = await run((tx) => createProposal(tx, ORG, {
      conversationId, action: "reservar_cita", payload: booking("2026-11-03T15:00:00.000Z"),
      idempotencyKey: "test:crm-agent:hilo-1-otra",
    }))
    expect(waiting.status).toBe("propuesta")
    expect((await run((tx) => getProposal(tx, ORG, first.id))).status).toBe("expirada")
    await expect(run((tx) => createProposal(tx, ORG, {
      conversationId, action: "crear_oportunidad", payload: { title: "Otra consulta pendiente" },
      idempotencyKey: "test:crm-agent:hilo-1-comercial",
    }))).rejects.toMatchObject({ code: "PROPOSAL_PENDING_CONFIRM", status: 409 })
    const message = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "enviar_mensaje",
        payload: { kind: "text", text: "Te avisaremos por aquí." },
        idempotencyKey: "test:crm-agent:hilo-2",
      }),
    )
    expect(message.status).toBe("ejecutada")
    expect(message.result).toMatchObject({ kind: "text" })
    expect((await run((tx) => getProposal(tx, ORG, waiting.id))).status).toBe("propuesta")
  })

  it("las propuestas viejas caducan, persisten y no bloquean la conversación", async () => {
    const { conversationId, contactId } = await openConversation("hilo-3", "evt-hilo-3")
    const old = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "reservar_cita", payload: booking(), idempotencyKey: "test:crm-agent:hilo-5",
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
        conversationId, action: "reservar_cita", payload: booking(), idempotencyKey: "test:crm-agent:hilo-6",
      }),
    )
    expect(fresh.status).toBe("propuesta")
  })
})

describe("obsolescencia y fallo transaccional", () => {
  it("una propuesta sin evidencia de estado no ejecuta a ciegas", async () => {
    const { conversationId, contactId } = await openConversation("stale-3", "evt-stale-3")
    const { openA } = await openStages()
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Corona" }, { userId: null }),
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
    await run((tx) => tx.update(agentProposal).set({ status: "aprobada" }).where(eq(agentProposal.id, legacy.id)))
    const decided = await run((tx) => executeProposal(tx, ORG, "owner-1", legacy.id))
    expect(decided.status).toBe("fallida")
    expect(decided.error).toContain("evidencia de estado")
    const kept = await run((tx) => getOpportunity(tx, ORG, opp.id))
    expect(kept.status).toBe("open")
  })

  it("la evidencia congelada no se reescribe por SQL directo", async () => {
    const { conversationId, contactId } = await openConversation("stale-4", "evt-stale-4")
    const { openA, openB } = await openStages()
    const opp = await run((tx) =>
      createOpportunity(tx, ORG, { contactId, title: "Puente" }, { userId: null }),
    )
    const proposal = await run((tx) =>
      createProposal(tx, ORG, {
        conversationId, action: "mover_oportunidad",
        payload: { opportunityId: opp.id, stageId: openB },
        idempotencyKey: "test:crm-agent:stale-4",
      }),
    )
    expect(proposal.status).toBe("ejecutada")
    await expect(
      run((tx) =>
        tx.update(agentProposal).set({ expectedState: { manipulated: true } }).where(eq(agentProposal.id, proposal.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } })
    const intact = await run((tx) => getProposal(tx, ORG, proposal.id))
    expect(intact.status).toBe("ejecutada")
  })
})
