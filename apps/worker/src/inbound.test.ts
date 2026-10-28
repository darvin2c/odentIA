import type { NormalizedInbound } from "@odentia/channels"
import { type InboundMessageJob, withOrgContext } from "@odentia/db"
import { conversation, message } from "@odentia/db/schema/crm"
import { closeConversationWith } from "@odentia/services"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { consumeInbound, processInbound } from "./inbound.js"
import {
  appDb,
  KEY,
  ownerDb,
  queueDepth,
  setupTestDb,
  storageStub,
  tgConnId,
} from "./test-setup.js"

setupTestDb()

const deps = { storage: storageStub, fetch, secretsKey: KEY }

function job(
  eventId: string,
  thread = "tg:555",
  text = `Hola (${eventId})`,
  sender = "tg:555",
): { msg_id: number; read_ct: number; message: InboundMessageJob } {
  // Cada mensaje dice algo distinto: el mismo texto cinco veces en una hora es spam (ADR 0054).
  const event: NormalizedInbound = {
    externalEventId: eventId,
    externalMessageId: eventId,
    externalThreadId: thread,
    senderExternalId: sender,
    senderDisplayName: "Ana",
    content: { type: "text", text },
    sentAt: new Date().toISOString(),
  }
  return { msg_id: 1, read_ct: 0, message: { orgId: "org_a", connectionId: tgConnId, event } }
}

async function messageCount(): Promise<number> {
  return withOrgContext(appDb, "org_a", async (tx) => {
    const rows = await tx.select({ id: message.id }).from(message)
    return rows.length
  })
}

it("ingesta visible solo en su org y reingesta idempotente", async () => {
  await consumeInbound(appDb, deps, job("evt-a1"))
  expect(await messageCount()).toBe(1)
  const otherOrg = await withOrgContext(appDb, "org_b", (tx) =>
    tx.select({ id: message.id }).from(message),
  )
  expect(otherOrg).toEqual([])
  // Reintento del mismo evento: no duplica.
  await consumeInbound(appDb, deps, job("evt-a1"))
  expect(await messageCount()).toBe(1)
})

it("con agente habilitado encola agent_runs", async () => {
  await ownerDb.execute(
    sql`insert into "agent_config" ("organization_id", "enabled") values ('org_a', true)`,
  )
  await consumeInbound(appDb, deps, job("evt-a2", "tg:556"))
  expect(await queueDepth("agent_runs")).toBe(1)
  await ownerDb.execute(sql`delete from "agent_config" where "organization_id" = 'org_a'`)
})

it("la corrida del agente se encola con la ventana de ráfaga como retardo", async () => {
  await ownerDb.execute(
    sql`insert into "agent_config" ("organization_id", "enabled") values ('org_a', true)`,
  )
  try {
    await ownerDb.execute(sql`select pgmq.purge_queue('agent_runs')`)
    const delayed = async () => {
      const rows = (await ownerDb.execute(
        sql`select count(*)::int as n from pgmq.q_agent_runs where vt > now() + interval '20 seconds'`,
      )) as unknown as { n: number }[]
      return rows[0]?.n ?? 0
    }
    // Sin ventana, la corrida es visible de inmediato.
    await consumeInbound(appDb, deps, job("evt-a3", "tg:557"))
    expect(await queueDepth("agent_runs")).toBe(1)
    expect(await delayed()).toBe(0)
    // Con ventana, queda diferida: da tiempo a que llegue el resto de la ráfaga.
    await consumeInbound(appDb, { ...deps, agentBurstWindowSeconds: 30 }, job("evt-a4", "tg:557"))
    expect(await queueDepth("agent_runs")).toBe(2)
    expect(await delayed()).toBe(1)
  } finally {
    await ownerDb.execute(sql`delete from "agent_config" where "organization_id" = 'org_a'`)
  }
})

it("conexión inexistente audita y hace ack (sin reintento infinito)", async () => {
  const bad = job("evt-bad")
  bad.message.connectionId = "00000000-0000-0000-0000-000000000000"
  bad.read_ct = 0
  expect(await processInbound(appDb, deps, bad)).toBe("done")
})

it("veneno tras 5 entregas hace ack", async () => {
  const poison = job("evt-poison")
  poison.message.connectionId = "00000000-0000-0000-0000-000000000000"
  poison.read_ct = 5
  expect(await processInbound(appDb, deps, poison)).toBe("done")
})

it("un entrante a una conversación cerrada la reabre y el agente la atiende (ADR 0024)", async () => {
  await ownerDb.execute(sql`insert into "agent_config" ("organization_id", "enabled") values ('org_a', true)`)
  try {
    await ownerDb.execute(sql`select pgmq.purge_queue('agent_runs')`)
    await consumeInbound(appDb, deps, job("evt-cerrada-1", "tg:558"))
    const [thread] = await ownerDb.select().from(conversation).where(eq(conversation.externalThreadId, "tg:558"))
    await withOrgContext(appDb, "org_a", (tx) => closeConversationWith(tx, "org_a", thread!.id, { reason: "sin_respuesta", byUserId: null }))
    await ownerDb.execute(sql`select pgmq.purge_queue('agent_runs')`)
    await consumeInbound(appDb, deps, job("evt-cerrada-2", "tg:558"))
    const [reopened] = await ownerDb.select().from(conversation).where(eq(conversation.id, thread!.id))
    expect(reopened).toMatchObject({ status: "open", closeReason: null, closedAt: null, agentStatus: "on", nudgedAt: null })
    expect(reopened!.attentionStartedAt.getTime()).toBeGreaterThan(thread!.attentionStartedAt.getTime())
    expect(await queueDepth("agent_runs")).toBe(1)
  } finally {
    await ownerDb.execute(sql`delete from "agent_config" where "organization_id" = 'org_a'`)
  }
})

it("el mismo texto cinco veces en una hora va a Spam y ya no encola corrida; a un bloqueado tampoco (ADR 0054)", async () => {
  await ownerDb.execute(sql`insert into "agent_config" ("organization_id", "enabled") values ('org_a', true)`)
  try {
    for (let i = 1; i <= 5; i += 1) {
      await ownerDb.execute(sql`select pgmq.purge_queue('agent_runs')`)
      await consumeInbound(appDb, deps, job(`evt-bot-${i}`, "tg:bot", "GANA DINERO YA", "tg:bot"))
      expect(await queueDepth("agent_runs")).toBe(i < 5 ? 1 : 0)
    }
    const [bot] = await ownerDb.execute<{ screen: string | null }>(sql`select c.screen from contact c
      join conversation cv on cv.contact_id = c.id where cv.external_thread_id = 'tg:bot'`)
    expect(bot?.screen).toBe("spam")

    await consumeInbound(appDb, deps, job("evt-bloq-1", "tg:bloq", "Hola", "tg:bloq"))
    await ownerDb.execute(sql`insert into "user" (id, name, email, email_verified) values ('u_worker_bloq', 'Carla', 'carla@worker.test', true) on conflict (id) do nothing`)
    await ownerDb.execute(sql`update contact set screen = 'blocked', screened_at = now(), screened_by_user_id = 'u_worker_bloq',
      screen_reason = 'acoso', screen_note = 'Insultos' where id = (select contact_id from conversation where external_thread_id = 'tg:bloq')`)
    await ownerDb.execute(sql`select pgmq.purge_queue('agent_runs')`)
    await consumeInbound(appDb, deps, job("evt-bloq-2", "tg:bloq", "¿Hola?", "tg:bloq"))
    expect(await queueDepth("agent_runs")).toBe(0)
  } finally {
    await ownerDb.execute(sql`delete from "agent_config" where "organization_id" = 'org_a'`)
  }
})

it("coexistencia: lo escrito desde el celular queda como del equipo y no despierta al agente", async () => {
  await ownerDb.execute(sql`insert into "agent_config" ("organization_id", "enabled") values ('org_a', true)`)
  try {
    await ownerDb.execute(sql`select pgmq.purge_queue('agent_runs')`)
    await consumeInbound(appDb, deps, job("evt-co1", "tg:770"))
    expect(await queueDepth("agent_runs")).toBe(1)
    const echo = job("evt-co2", "tg:770", "Te esperamos mañana")
    echo.message.event = { ...echo.message.event, fromBusinessApp: true }
    await consumeInbound(appDb, deps, echo)
    // La persona no escribió: no hay otra corrida.
    expect(await queueDepth("agent_runs")).toBe(1)
    const rows = await withOrgContext(appDb, "org_a", (tx) =>
      tx
        .select({ direction: message.direction, senderKind: message.senderKind, senderUserId: message.senderUserId, status: message.status, fromBusinessApp: message.fromBusinessApp, unread: conversation.unreadCount })
        .from(message)
        .innerJoin(conversation, eq(conversation.id, message.conversationId))
        .where(eq(message.externalId, "evt-co2")),
    )
    expect(rows).toEqual([{ direction: "out", senderKind: "user", senderUserId: null, status: "sent", fromBusinessApp: true, unread: 1 }])
  } finally {
    await ownerDb.execute(sql`delete from "agent_config" where "organization_id" = 'org_a'`)
  }
})

it("coexistencia: el historial conserva su hora, no reabre la conversación ni cuenta como sin leer", async () => {
  await consumeInbound(appDb, deps, job("evt-hi1", "tg:771"))
  const [conv] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ id: conversation.id }).from(conversation).where(eq(conversation.externalThreadId, "tg:771")),
  )
  await withOrgContext(appDb, "org_a", (tx) => closeConversationWith(tx, "org_a", conv!.id, { reason: "manual", byUserId: null }))
  const then = "2026-01-15T10:00:00.000Z"
  const theirs = job("evt-hi2", "tg:771", "¿Tienen cita el lunes?")
  theirs.message.event = { ...theirs.message.event, history: true, sentAt: then }
  const ours = job("evt-hi3", "tg:771", "Sí, a las 10")
  ours.message.event = { ...ours.message.event, history: true, fromBusinessApp: true, historyStatus: "read", sentAt: then }
  await consumeInbound(appDb, deps, theirs)
  await consumeInbound(appDb, deps, ours)
  const rows = await withOrgContext(appDb, "org_a", (tx) =>
    tx
      .select({ id: message.externalId, direction: message.direction, status: message.status, createdAt: message.createdAt })
      .from(message)
      .where(eq(message.conversationId, conv!.id)),
  )
  expect(rows.filter((row) => row.id !== "evt-hi1").map((row) => [row.id, row.direction, row.status, row.createdAt.toISOString()])).toEqual([
    ["evt-hi2", "in", "received", then],
    ["evt-hi3", "out", "read", then],
  ])
  const [after] = await withOrgContext(appDb, "org_a", (tx) =>
    tx.select({ status: conversation.status, unread: conversation.unreadCount }).from(conversation).where(eq(conversation.id, conv!.id)),
  )
  expect(after).toEqual({ status: "closed", unread: 1 })
})
