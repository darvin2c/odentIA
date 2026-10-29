import { randomUUID } from "node:crypto"
import { agentRunLedger } from "@odentia/db/schema/agent"
import { channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import { saasAction, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { createSaasPlan, updateSaasPlan } from "./saas-billing.js"
import { getClinicCostMargin } from "./saas-cost.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/** Informa por bloques de mensajes de la persona, en sombra (ADR 0105): qué cuenta y que nada se cobra. */
setupTestDb()
const ORG = "org_a"
const HOUR = 3_600_000
const DAY = 24 * HOUR
const at = new Date(Date.now() - 2 * DAY)
const later = (hours: number) => new Date(at.getTime() + hours * HOUR)
let planId: string
let channelId: string

beforeAll(async () => {
  const [plan] = await ownerDb
    .insert(saasPlan)
    .values({
      code: "bloques",
      name: "Plan odentIA",
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationMicros: 500_000,
      conversationInformMicros: 200_000,
      fixedPriceTiers: ["informa"],
      // Un tope pequeño para ver los bloques con pocos mensajes.
      informMessageLimit: 3,
      trialCreditCents: 0,
      trialMaxCreditCents: 0,
    })
    .returning()
  planId = plan!.id
  const active = {
    status: "activa",
    isDemo: false,
    planId,
    activatedAt: new Date(Date.now() - 10 * DAY),
    currentPeriodStart: new Date(Date.now() - 10 * DAY),
    currentPeriodEnd: new Date(Date.now() + 20 * DAY),
  }
  await ownerDb.insert(saasSubscription).values({ organizationId: ORG, ...active }).onConflictDoUpdate({ target: saasSubscription.organizationId, set: active })
  const [channel] = await ownerDb
    .insert(channelConnection)
    .values({ organizationId: ORG, channel: "whatsapp", provider: "prueba", displayName: "Canal", configEncrypted: "x", webhookSecret: "x" })
    .returning()
  channelId = channel!.id
})

async function person(displayName: string): Promise<string> {
  const [row] = await ownerDb.insert(contact).values({ organizationId: ORG, displayName }).returning()
  return row!.id
}

async function thread(contactId: string, isTest = false): Promise<string> {
  const [row] = await ownerDb
    .insert(conversation)
    .values({ organizationId: ORG, contactId, channelConnectionId: channelId, externalThreadId: randomUUID(), isTest })
    .returning()
  return row!.id
}

/** La conversación contada de esa persona en su ventana, como la deja `countConversationAction`. */
function counted(contactId: string, conversationId: string, tier = "informa", priceMicros = 200_000): typeof saasAction.$inferInsert {
  return {
    organizationId: ORG,
    kind: "conversacion",
    tier,
    occurredAt: at,
    contactId,
    conversationId,
    detail: "Atendió una conversación por WhatsApp",
    currency: "USD",
    basePriceMicros: priceMicros,
    priceMicros,
    dedupeKey: randomUUID(),
  }
}

/** Una fila del libro de corridas: cómo terminó la corrida de un mensaje y cuándo empezó. */
function ran(conversationId: string, startedAt: Date, status: string, error: string | null = null, messageId = randomUUID()): typeof agentRunLedger.$inferInsert {
  return { organizationId: ORG, conversationId, triggerMessageId: messageId, model: "gpt-6-luna", status, startedAt, endedAt: startedAt, llmCalls: status === "ok" ? 1 : 0, error }
}

describe("Informa por bloques, en sombra", () => {
  it("cuenta los mensajes de la persona que atendió Sofi y lo que costarían sus bloques, sin cobrarlos", async () => {
    const lucia = await person("Lucía Ramos")
    const luciaThread = await thread(lucia)
    const mario = await person("Mario Quispe")
    const marioThread = await thread(mario)
    const ana = await person("Ana Torres")
    const anaThread = await thread(ana)
    await ownerDb.insert(saasAction).values([
      counted(lucia, luciaThread),
      counted(mario, marioThread),
      // Gestiona no tiene tope: sus mensajes no se miran.
      counted(ana, anaThread, "gestiona", 500_000),
    ])
    const readTwice = randomUUID()
    await ownerDb.insert(agentRunLedger).values([
      // Lucía: dos mensajes en una corrida (uno leído en la ráfaga del otro), uno derivado y otro respondido.
      ran(luciaThread, at, "ok"),
      ran(luciaThread, at, "omitida", "burst-covered"),
      ran(luciaThread, later(1), "handoff", "handoff"),
      ran(luciaThread, later(2), "ok", null, readTwice),
      // El mismo mensaje leído otra vez en otra ráfaga cuenta una sola vez.
      ran(luciaThread, later(3), "omitida", "burst-covered", readTwice),
      // No cuentan: lo que calló porque siguió escribiendo, el error, la corrida sin respuesta,
      // lo de antes y lo de después de su ventana, ni la prueba del chat web.
      ran(luciaThread, later(4), "omitida", "persona-siguio-escribiendo"),
      ran(luciaThread, later(5), "error", "LLM: sin respuesta"),
      ran(luciaThread, later(6), "sin_respuesta"),
      ran(luciaThread, later(-1), "ok"),
      ran(luciaThread, later(24), "ok"),
      ran(await thread(lucia, true), later(1), "ok"),
      // Mario llega justo al tope: su Informa lo cubre.
      ran(marioThread, at, "ok"),
      ran(marioThread, later(1), "ok"),
      ran(marioThread, later(2), "ok"),
      ...[0, 1, 2, 3, 4].map((hours) => ran(anaThread, later(hours), "ok")),
    ])

    const cost = await getClinicCostMargin(ownerDb, ORG)
    expect(cost.informBlocks).toEqual({ messageLimit: 3, windows: 2, over: 1, extraInforma: 1, extraCents: 20, maxMessages: 4 })
    // Lo cobrado no cambia: cada persona, un Informa.
    expect(cost.lines.find((line) => line.key === "sofi:informa")).toMatchObject({ count: 2, chargedCents: 40 })

    // Tres mensajes más: siete son tres bloques, dos Informa de más.
    await ownerDb.insert(agentRunLedger).values([7, 8, 9].map((hours) => ran(luciaThread, later(hours), "ok")))
    expect((await getClinicCostMargin(ownerDb, ORG)).informBlocks).toEqual({
      messageLimit: 3,
      windows: 2,
      over: 1,
      extraInforma: 2,
      extraCents: 40,
      maxMessages: 7,
    })
    const rows = await ownerDb.select({ id: saasAction.id }).from(saasAction).where(eq(saasAction.organizationId, ORG))
    expect(rows).toHaveLength(3)
  })

  it("sin tope en el plan no hay sombra", async () => {
    await updateSaasPlan(ownerDb, "staff", planId, { informMessageLimit: null })
    expect((await getClinicCostMargin(ownerDb, ORG)).informBlocks).toBeNull()
    const saved = await updateSaasPlan(ownerDb, "staff", planId, { informMessageLimit: 25 })
    expect(saved.informMessageLimit).toBe(25)
  })

  it("el tope va de 1 a 1000 mensajes, o vacío", async () => {
    const plan = { code: "bloques-malo", name: "Plan", currency: "USD", priceCents: 2900 }
    await expect(createSaasPlan(ownerDb, "staff", { ...plan, informMessageLimit: 0 })).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(updateSaasPlan(ownerDb, "staff", planId, { informMessageLimit: 1001 })).rejects.toMatchObject({ code: "VALIDATION" })
    await expect(updateSaasPlan(ownerDb, "staff", planId, { informMessageLimit: 2.5 })).rejects.toMatchObject({ code: "VALIDATION" })
    const [row] = await ownerDb.select({ limit: saasPlan.informMessageLimit }).from(saasPlan).where(eq(saasPlan.id, planId))
    expect(row?.limit).toBe(25)
  })
})
