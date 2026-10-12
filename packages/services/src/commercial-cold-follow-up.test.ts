import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { agentHandoff, agentProposal, commercialFollowUpCoordination } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { automationConsent } from "@odentia/db/schema/automation"
import {
  agentConfig,
  channelConnection,
  contact,
  contactIdentity,
  conversation,
  crmTask,
  message,
  pipeline,
  pipelineStage,
} from "@odentia/db/schema/crm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { auditEvent } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  confirmProposalByContact,
  countPendingProposals,
  createProposal,
  decideProposal,
  getProposal,
  updateAutonomyPolicy,
} from "./agent-operations.js"
import { syncOverdueCommercialFollowUps } from "./automation.js"
import { recordCommercialFollowUpProposal } from "./commercial-coordination.js"
import { createConnection } from "./connections.js"
import { updateOpportunity } from "./opportunities.js"
import { encryptJson, secretsKeyFromEnv } from "./secrets.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Primer trabajo proactivo del agente: un seguimiento comercial vencido SIN
 * conversación se convierte en una propuesta determinista (abrir WhatsApp con
 * la plantilla de seguimiento aprobada) que el equipo decide desde el panel.
 * Sin canal apto sigue derivando a una persona, como antes.
 */
setupTestDb()
const KEY = secretsKeyFromEnv("ee".repeat(32))
const NOW = new Date("2026-10-03T15:00:00.000Z")
const DUE = new Date("2026-10-03T14:00:00.000Z")
const WA_CONFIG = { phoneNumberId: "P", wabaId: "W", accessToken: "T", appSecret: "S" }
const TEMPLATES = [
  { name: "bienvenida", language: "es_PE" },
  { name: "seguimiento_presupuesto", language: "es_PE" },
]

interface SeedInput {
  templates?: { name: string; language: string }[]
  consent?: boolean
  identity?: boolean
  /** Oportunidad y tarea ya vinculadas a un hilo de WhatsApp con ventana abierta. */
  thread?: boolean
}

async function seed(input: SeedInput = {}) {
  const orgId = randomUUID()
  const userId = `u-${orgId}`
  await insertOrg(ownerDb, orgId, `cold-${orgId}`)
  await ownerDb.insert(user).values({ id: userId, name: "Comercial", email: `${userId}@cold.test`, emailVerified: true })
  await ownerDb.insert(member).values({ id: `m-${userId}`, userId, organizationId: orgId, role: "owner", createdAt: new Date() })
  await ownerDb.insert(agentConfig).values({ organizationId: orgId, enabled: true })
  const [person] = await ownerDb.insert(contact).values({ organizationId: orgId, displayName: "Sin hilo" }).returning()
  if (!person) throw new Error("contacto")
  const phone = `51999${orgId.replace(/\D/g, "").slice(0, 6).padEnd(6, "0")}`
  const [identity] =
    input.identity === false
      ? []
      : await ownerDb
          .insert(contactIdentity)
          .values({ organizationId: orgId, contactId: person.id, channel: "whatsapp", externalUserId: phone, isPrimary: true })
          .returning()
  const connection = await withOrgContext(appDb, orgId, (tx) =>
    createConnection(tx, orgId, KEY, {
      channel: "whatsapp", provider: "whatsapp_cloud_api", displayName: "WA",
      config: { ...WA_CONFIG, templates: input.templates ?? TEMPLATES },
    }, { fetch, validateExternal: false }))
  if (input.consent !== false) {
    await ownerDb.insert(automationConsent).values({
      organizationId: orgId, contactId: person.id, purpose: "seguimiento", channel: "whatsapp", status: "granted", source: "prueba",
    })
  }
  const [thread] =
    input.thread && identity
      ? await ownerDb
          .insert(conversation)
          .values({
            organizationId: orgId, contactId: person.id, contactIdentityId: identity.id, channelConnectionId: connection.id,
            externalThreadId: phone, agentStatus: "on", lastInboundAt: new Date(),
          })
          .returning()
      : []
  const [pipe] = await ownerDb.insert(pipeline).values({ organizationId: orgId, name: "Comercial", isDefault: true }).returning()
  if (!pipe) throw new Error("pipeline")
  const [stage] = await ownerDb.insert(pipelineStage).values({ organizationId: orgId, pipelineId: pipe.id, name: "Contacto", position: 0 }).returning()
  if (!stage) throw new Error("etapa")
  const base = { orgId, userId, contactId: person.id, connectionId: connection.id, identityId: identity?.id ?? null, pipelineId: pipe.id, stageId: stage.id, threadId: thread?.id ?? null }
  const followUp = await addFollowUp(base, "Ortodoncia", DUE)
  return { ...base, ...followUp }
}

/** Oportunidad abierta con su tarea de seguimiento vencida (como las deja `syncOpportunityFollowUp`). */
async function addFollowUp(
  f: { orgId: string; userId: string; contactId: string; pipelineId: string; stageId: string; threadId: string | null },
  title: string,
  dueAt: Date,
) {
  const [opp] = await ownerDb.insert(opportunity).values({
    organizationId: f.orgId, contactId: f.contactId, conversationId: f.threadId, pipelineId: f.pipelineId, stageId: f.stageId,
    title, currency: "PEN", nextActionAt: dueAt, nextActionNote: "Retomar presupuesto", assignedUserId: f.userId,
  }).returning()
  if (!opp) throw new Error("oportunidad")
  const [task] = await ownerDb.insert(crmTask).values({
    organizationId: f.orgId, contactId: f.contactId, conversationId: f.threadId, opportunityId: opp.id,
    title: "Retomar presupuesto", dueAt, status: "open", kind: "opportunity_follow_up", createdBy: "user", assigneeUserId: f.userId,
  }).returning()
  if (!task) throw new Error("tarea")
  return { opportunityId: opp.id, taskId: task.id }
}

function tick(orgId: string, withKey = true) {
  return withOrgContext(appDb, orgId, (tx) =>
    syncOverdueCommercialFollowUps(tx, orgId, NOW, withKey ? { secretsKey: KEY } : {}))
}

function decide(f: { orgId: string; userId: string }, proposalId: string, decision: "aprobada" | "rechazada", reason?: string) {
  return withOrgContext(appDb, f.orgId, (tx) =>
    decideProposal(tx, f.orgId, f.userId, proposalId, { decision, reason }, { secretsKey: KEY }))
}

async function coordinationOf(orgId: string, taskId: string) {
  const [row] = await ownerDb.select().from(commercialFollowUpCoordination)
    .where(and(eq(commercialFollowUpCoordination.organizationId, orgId), eq(commercialFollowUpCoordination.taskId, taskId)))
  if (!row) throw new Error("sin coordinación")
  return row
}

async function proposalIdOf(orgId: string, taskId: string): Promise<string> {
  const id = (await coordinationOf(orgId, taskId)).result?.["proposalId"]
  if (typeof id !== "string") throw new Error("la coordinación no tiene propuesta")
  return id
}

const threadsOf = (orgId: string) => ownerDb.select().from(conversation).where(eq(conversation.organizationId, orgId))
const messagesOf = (orgId: string) => ownerDb.select().from(message).where(eq(message.organizationId, orgId))
const noticesOf = (coordinationId: string) =>
  ownerDb.select().from(workspaceNotification).where(eq(workspaceNotification.dedupeKey, `commercial-coordination:${coordinationId}`))

it("sin conversación pero con canal apto, propone al equipo abrir WhatsApp con la plantilla de seguimiento (una sola vez)", async () => {
  const f = await seed()
  // Dos ticks a la vez (dos réplicas): una sola coordinación y una sola propuesta.
  const [a, b] = await Promise.all([tick(f.orgId), tick(f.orgId)])
  expect((a?.programados ?? 0) + (b?.programados ?? 0)).toBe(1)
  expect(await tick(f.orgId)).toEqual({ programados: 0, omitidos: 0 })
  const coordination = await coordinationOf(f.orgId, f.taskId)
  expect(coordination.status).toBe("propuesta")
  expect(coordination.nextResponsibleKind).toBe("team")
  const proposalId = await proposalIdOf(f.orgId, f.taskId)
  expect(await ownerDb.select().from(agentProposal).where(eq(agentProposal.organizationId, f.orgId))).toHaveLength(1)
  const proposal = await withOrgContext(appDb, f.orgId, (tx) => getProposal(tx, f.orgId, proposalId))
  // La política por defecto de enviar_mensaje es «directo»; aun así espera al
  // equipo y así se presenta en panel, Aprobaciones e Inicio.
  expect(proposal.status).toBe("propuesta")
  expect(proposal.mode).toBe("aprobar_equipo")
  expect(await withOrgContext(appDb, f.orgId, (tx) => countPendingProposals(tx, f.orgId))).toEqual({ team: 1, contact: 0 })
  expect(proposal.conversationId).toBeNull()
  expect(proposal.contactId).toBe(f.contactId)
  expect(proposal.payload).toMatchObject({ kind: "template", name: "seguimiento_presupuesto", connectionId: f.connectionId, opportunityId: f.opportunityId })
  expect(proposal.context.channel).toBe("whatsapp")
  expect(proposal.context.opportunityTitle).toBe("Ortodoncia")
  expect(proposal.context.isStale).toBe(false)
  expect(proposal.reason).toContain("seguimiento_presupuesto")
  // Aislamiento: otra organización no ve la propuesta.
  expect(await withOrgContext(appDb, "org_b", (tx) => tx.select().from(agentProposal).where(eq(agentProposal.id, proposalId)))).toHaveLength(0)

  // Aprobar abre el hilo, encola la plantilla y cierra la coordinación con el mensaje.
  const executed = await decide(f, proposalId, "aprobada")
  expect(executed.status).toBe("ejecutada")
  expect(executed.conversationId).not.toBeNull()
  expect(typeof executed.result?.["messageId"]).toBe("string")
  const queued = await messagesOf(f.orgId)
  expect(queued).toHaveLength(1)
  expect(queued[0]).toMatchObject({ direction: "out", senderKind: "agent", status: "queued", conversationId: executed.conversationId })
  const closed = await coordinationOf(f.orgId, f.taskId)
  expect(closed.status).toBe("ejecutada")
  expect(closed.nextResponsibleKind).toBe("contact")
  expect((closed.result as Record<string, unknown>)?.["messageId"]).toBe(executed.result?.["messageId"])
  // El caso conserva su hilo y la apertura queda auditada a nombre de quien aprobó.
  const [opp] = await ownerDb.select().from(opportunity).where(eq(opportunity.id, f.opportunityId))
  const [task] = await ownerDb.select().from(crmTask).where(eq(crmTask.id, f.taskId))
  expect(opp?.conversationId).toBe(executed.conversationId)
  expect(task?.conversationId).toBe(executed.conversationId)
  const [started] = await ownerDb.select().from(auditEvent)
    .where(and(eq(auditEvent.organizationId, f.orgId), eq(auditEvent.action, "conversation.started")))
  expect(started?.actorUserId).toBe(f.userId)
  // Y el tick siguiente no vuelve a coordinar el mismo vencimiento.
  expect(await tick(f.orgId)).toEqual({ programados: 0, omitidos: 0 })
})

it("rechazar la propuesta proactiva deriva la coordinación al responsable", async () => {
  const f = await seed()
  await tick(f.orgId)
  const rejected = await decide(f, await proposalIdOf(f.orgId, f.taskId), "rechazada", "Mejor llamar")
  expect(rejected.status).toBe("rechazada")
  const coordination = await coordinationOf(f.orgId, f.taskId)
  expect(coordination.status).toBe("derivada")
  expect(coordination.nextResponsibleUserId).toBe(f.userId)
  const notices = await noticesOf(coordination.id)
  expect(notices).toHaveLength(1)
  expect(notices[0]?.userId).toBe(f.userId)
  expect(await threadsOf(f.orgId)).toHaveLength(0)
})

it("si el seguimiento se reprogramó mientras esperaba, la propuesta se marca obsoleta y aprobar no envía nada", async () => {
  const f = await seed()
  await tick(f.orgId)
  const proposalId = await proposalIdOf(f.orgId, f.taskId)
  await withOrgContext(appDb, f.orgId, (tx) =>
    updateOpportunity(tx, f.orgId, f.opportunityId, { nextActionAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }, { userId: f.userId }))
  const stale = await withOrgContext(appDb, f.orgId, (tx) => getProposal(tx, f.orgId, proposalId))
  expect(stale.context.isStale).toBe(true)
  const result = await decide(f, proposalId, "aprobada")
  expect(result.status).toBe("fallida")
  expect(result.result?.["errorCode"]).toBe("PROPOSAL_STALE")
  expect(result.conversationId).toBeNull()
  expect(await threadsOf(f.orgId)).toHaveLength(0)
  expect((await coordinationOf(f.orgId, f.taskId)).status).toBe("omitida")
})

it("una propuesta proactiva que nadie decide caduca y el siguiente tick deriva la coordinación", async () => {
  const f = await seed()
  await tick(f.orgId)
  const proposalId = await proposalIdOf(f.orgId, f.taskId)
  await ownerDb.update(agentProposal).set({ createdAt: new Date(Date.now() - 49 * 3_600_000) }).where(eq(agentProposal.id, proposalId))
  expect(await tick(f.orgId)).toEqual({ programados: 0, omitidos: 0 })
  const [proposal] = await ownerDb.select().from(agentProposal).where(eq(agentProposal.id, proposalId))
  expect(proposal?.status).toBe("expirada")
  const coordination = await coordinationOf(f.orgId, f.taskId)
  expect(coordination.status).toBe("derivada")
  expect(coordination.reason).toContain("expirada")
  expect(await noticesOf(coordination.id)).toHaveLength(1)
})

it("lo vigente al aprobar manda: consentimiento revocado, política endurecida o plantilla retirada no envían y derivan", async () => {
  // Consentimiento revocado entre la propuesta y la aprobación.
  const revoked = await seed()
  await tick(revoked.orgId)
  await ownerDb.delete(automationConsent).where(eq(automationConsent.organizationId, revoked.orgId))
  const noConsent = await decide(revoked, await proposalIdOf(revoked.orgId, revoked.taskId), "aprobada")
  expect(noConsent.status).toBe("fallida")
  expect(noConsent.result?.["errorCode"]).toBe("CONSENT_REQUIRED")

  // La política pasa a exigir al interlocutor: sin hilo nadie puede confirmar.
  const hardened = await seed()
  await tick(hardened.orgId)
  const hardenedId = await proposalIdOf(hardened.orgId, hardened.taskId)
  await withOrgContext(appDb, hardened.orgId, (tx) => updateAutonomyPolicy(tx, hardened.orgId, hardened.userId, { enviar_mensaje: "confirmar_usuario" }))
  await expect(withOrgContext(appDb, hardened.orgId, (tx) =>
    confirmProposalByContact(tx, hardened.orgId, hardened.contactId, hardenedId, { staffUserId: hardened.userId, secretsKey: KEY }),
  )).rejects.toThrow("la decide el equipo")
  expect(await withOrgContext(appDb, hardened.orgId, (tx) => countPendingProposals(tx, hardened.orgId))).toEqual({ team: 1, contact: 0 })
  const blocked = await decide(hardened, hardenedId, "aprobada")
  expect(blocked.status).toBe("fallida")
  expect(blocked.result?.["errorCode"]).toBe("POLICY_REQUIRES_CONTACT_CONFIRM")

  // La plantilla sale de la lista aprobada: el fallo llega con el hilo ya
  // abierto y todo lo parcial se deshace.
  const withdrawn = await seed()
  await tick(withdrawn.orgId)
  await ownerDb.update(channelConnection)
    .set({ configEncrypted: encryptJson(KEY, { ...WA_CONFIG, templates: [{ name: "bienvenida", language: "es_PE" }] }) })
    .where(eq(channelConnection.id, withdrawn.connectionId))
  const notAllowed = await decide(withdrawn, await proposalIdOf(withdrawn.orgId, withdrawn.taskId), "aprobada")
  expect(notAllowed.status).toBe("fallida")
  const [untouched] = await ownerDb.select().from(opportunity).where(eq(opportunity.id, withdrawn.opportunityId))
  expect(untouched?.conversationId).toBeNull()

  for (const f of [revoked, hardened, withdrawn]) {
    expect(await threadsOf(f.orgId), f.orgId).toHaveLength(0)
    expect(await messagesOf(f.orgId), f.orgId).toHaveLength(0)
    const coordination = await coordinationOf(f.orgId, f.taskId)
    expect(coordination.status, f.orgId).toBe("derivada")
    expect(await noticesOf(coordination.id), f.orgId).toHaveLength(1)
  }
})

it("una sola propuesta proactiva pendiente por contacto: el segundo seguimiento vencido se deriva", async () => {
  const f = await seed()
  const second = await addFollowUp(f, "Implante", new Date("2026-10-03T14:30:00.000Z"))
  expect(await tick(f.orgId)).toEqual({ programados: 1, omitidos: 1 })
  expect((await coordinationOf(f.orgId, f.taskId)).status).toBe("propuesta")
  const derived = await coordinationOf(f.orgId, second.taskId)
  expect(derived.status).toBe("derivada")
  expect(derived.reason).toContain("propuesta proactiva pendiente")
  expect(await ownerDb.select().from(agentProposal).where(eq(agentProposal.organizationId, f.orgId))).toHaveLength(1)
})

it("sin canal apto deriva como antes y nunca tumba el tick", async () => {
  const variants: { name: string; seed?: SeedInput; key?: boolean; prepare?: (f: Awaited<ReturnType<typeof seed>>) => Promise<unknown> }[] = [
    { name: "sin plantillas", seed: { templates: [] } },
    { name: "solo plantilla ajena al seguimiento", seed: { templates: [{ name: "cita_recordatorio", language: "es_PE" }] } },
    { name: "sin consentimiento", seed: { consent: false } },
    { name: "sin identidad", seed: { identity: false } },
    { name: "sin clave", key: false },
    {
      name: "política confirmar_usuario",
      prepare: (f) => withOrgContext(appDb, f.orgId, (tx) => updateAutonomyPolicy(tx, f.orgId, f.userId, { enviar_mensaje: "confirmar_usuario" })),
    },
    {
      name: "configuración de la conexión ilegible",
      prepare: (f) => ownerDb.update(channelConnection).set({ configEncrypted: "no-descifrable" }).where(eq(channelConnection.id, f.connectionId)),
    },
    {
      name: "contacto archivado",
      prepare: (f) => ownerDb.update(contact).set({ isActive: false }).where(eq(contact.id, f.contactId)),
    },
    {
      name: "el contacto ya conversa por ese canal",
      prepare: (f) => ownerDb.insert(conversation).values({
        organizationId: f.orgId, contactId: f.contactId, contactIdentityId: f.identityId, channelConnectionId: f.connectionId,
        externalThreadId: `hilo-${f.orgId}`, status: "closed",
      }),
    },
  ]
  for (const variant of variants) {
    const f = await seed(variant.seed)
    await variant.prepare?.(f)
    expect(await tick(f.orgId, variant.key !== false), variant.name).toEqual({ programados: 0, omitidos: 1 })
    const coordination = await coordinationOf(f.orgId, f.taskId)
    expect(coordination.status, variant.name).toBe("derivada")
    expect(coordination.reason, variant.name).toContain("no tiene una conversación vinculada")
    expect(await ownerDb.select().from(agentProposal).where(eq(agentProposal.organizationId, f.orgId)), variant.name).toHaveLength(0)
    expect(await messagesOf(f.orgId), variant.name).toHaveLength(0)
  }
})

it("con atraso acumulado, los vencimientos ya coordinados no tapan a los nuevos", async () => {
  const f = await seed({ identity: false })
  const older = new Date("2026-10-03T10:00:00.000Z")
  const opps = await ownerDb.insert(opportunity).values(
    Array.from({ length: 25 }, (_, i) => ({
      organizationId: f.orgId, contactId: f.contactId, pipelineId: f.pipelineId, stageId: f.stageId,
      title: `Atraso ${i}`, currency: "PEN", nextActionAt: older, nextActionNote: "Llamar",
    })),
  ).returning({ id: opportunity.id })
  await ownerDb.insert(crmTask).values(
    opps.map((opp) => ({
      organizationId: f.orgId, contactId: f.contactId, conversationId: null, opportunityId: opp.id,
      title: "Llamar", dueAt: older, status: "open", kind: "opportunity_follow_up", createdBy: "user",
    })),
  )
  // El primer lote se llena con los 25 más antiguos; el más reciente entra en el siguiente.
  expect(await tick(f.orgId)).toEqual({ programados: 0, omitidos: 25 })
  expect(await tick(f.orgId)).toEqual({ programados: 0, omitidos: 1 })
  expect((await coordinationOf(f.orgId, f.taskId)).status).toBe("derivada")
  expect(await tick(f.orgId)).toEqual({ programados: 0, omitidos: 0 })
})

/**
 * Recorrido con hilo: el agente propuso un mensaje y el equipo decide después.
 * La coordinación ya no queda en `propuesta` para siempre.
 */
async function threadedProposal() {
  const f = await seed({ thread: true })
  if (!f.threadId) throw new Error("hilo")
  const threadId = f.threadId
  await withOrgContext(appDb, f.orgId, (tx) => updateAutonomyPolicy(tx, f.orgId, f.userId, { enviar_mensaje: "aprobar_equipo" }))
  expect(await tick(f.orgId)).toEqual({ programados: 1, omitidos: 0 })
  const coordination = await coordinationOf(f.orgId, f.taskId)
  expect(coordination.status).toBe("pendiente")
  // Lo que hace la herramienta del agente al proponer el mensaje de seguimiento.
  const proposal = await withOrgContext(appDb, f.orgId, async (tx) => {
    const created = await createProposal(tx, f.orgId, {
      conversationId: threadId, action: "enviar_mensaje",
      payload: { kind: "text", text: "Hola, ¿retomamos tu presupuesto?" }, idempotencyKey: `coord:${coordination.id}`,
    })
    await recordCommercialFollowUpProposal(tx, f.orgId, coordination.id, created)
    return created
  })
  expect(proposal.status).toBe("propuesta")
  expect((await coordinationOf(f.orgId, f.taskId)).status).toBe("propuesta")
  return { ...f, threadId, proposalId: proposal.id }
}

it("con hilo, la decisión tardía del equipo cierra la coordinación: aprobar la ejecuta, rechazar avisa y caducar deriva", async () => {
  const approved = await threadedProposal()
  const executed = await decide(approved, approved.proposalId, "aprobada")
  expect(executed.status).toBe("ejecutada")
  const done = await coordinationOf(approved.orgId, approved.taskId)
  expect(done.status).toBe("ejecutada")
  expect((done.result as Record<string, unknown>)?.["messageId"]).toBe(executed.result?.["messageId"])

  // Rechazar: una persona ya decidió; avisa al responsable sin abrir una
  // derivación ni apagar el agente del hilo.
  const rejected = await threadedProposal()
  await decide(rejected, rejected.proposalId, "rechazada", "Ya lo llamé")
  const afterReject = await coordinationOf(rejected.orgId, rejected.taskId)
  expect(afterReject.status).toBe("derivada")
  expect(await noticesOf(afterReject.id)).toHaveLength(1)
  expect(await ownerDb.select().from(agentHandoff).where(eq(agentHandoff.organizationId, rejected.orgId))).toHaveLength(0)
  const [stillOn] = await ownerDb.select().from(conversation).where(eq(conversation.id, rejected.threadId))
  expect(stillOn?.agentStatus).toBe("on")

  // Caducar: nadie decidió; el caso pasa a la cola de derivadas.
  const expired = await threadedProposal()
  await ownerDb.update(agentProposal).set({ createdAt: new Date(Date.now() - 49 * 3_600_000) }).where(eq(agentProposal.id, expired.proposalId))
  await tick(expired.orgId)
  const afterExpiry = await coordinationOf(expired.orgId, expired.taskId)
  expect(afterExpiry.status).toBe("derivada")
  const handoffs = await ownerDb.select().from(agentHandoff).where(eq(agentHandoff.organizationId, expired.orgId))
  expect(handoffs).toHaveLength(1)
  expect(handoffs[0]?.taskId).toBe(expired.taskId)
})
