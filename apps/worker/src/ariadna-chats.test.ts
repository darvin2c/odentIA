import {
  asAdminDecider,
  createFakeDecisionModel,
  createKairosSeller,
  fakeHelpWriter,
} from "@odentia/agent"
import type { Db } from "@odentia/db"
import {
  kairosChatTurn,
  kairosItem,
  saasChat,
  saasClient,
  saasInboundMessage,
  saasOutreach,
} from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import {
  type AdminActor,
  type AdminChannels,
  askHelpByChat,
  configurePublicLinks,
  getChat,
  ingestInboundChat,
  KAIROS_TURNS_PER_CHAT_DAY,
  kairosRulesPass,
  pauseChatKairos,
  prepareChatReply,
  setAriadnaChats,
  setKairosSells,
} from "@odentia/services"
import { and, asc, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type AriadnaChatResponder, runKairosSellsTick } from "./kairos-vende.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Ariadna en los chats (ADR 0191) contra Postgres real, con los dobles de la
 * Ayuda (`LLM_MODEL=fake`): atiende solo la conversación de una clínica con su
 * app (nunca la de Kairós), con su propio interruptor, una vez por mensaje, con
 * la pausa y los topes de siempre; pasa a Soporte lo de su cuenta y a
 * Administración los cobros, que Soporte no ve.
 */
setupTestDb()

const MIN = 60_000
const monday = new Date("2026-11-09T13:00:00Z")
const ana: AdminActor = { userId: "ar-ana", role: "admin" }
const sol: AdminActor = { userId: "ar-sol", role: "support" }

const channels: AdminChannels = {
  appSecret: "secreto",
  verifyToken: "reto",
  whatsapp: { phoneNumberId: "1111111111", accessToken: "wa-token" },
}

let wamids = 0
const fakeFetch = (async () => {
  wamids += 1
  return Response.json({ messages: [{ id: `wamid.ar${wamids}` }] })
}) as typeof fetch

const seller = createKairosSeller({ platform: { fake: true, maxRetries: 0 }, onUse: () => {} })
const asked: string[] = []
const ariadna: AriadnaChatResponder = {
  answer: async (_org, input) => {
    asked.push(input.question)
    return askHelpByChat(input, asAdminDecider(createFakeDecisionModel()), fakeHelpWriter())
  },
}

const tick = (now: Date) =>
  runKairosSellsTick({ ownerDb, seller, ariadna, channels, fetch: fakeFetch, now: () => now })
const tx = <T>(fn: (db: Db) => Promise<T>) => ownerDb.transaction((inner) => fn(inner as Db))

let seq = 0
async function write(address: string, body: string, at: Date): Promise<string> {
  seq += 1
  const result = await tx((db) =>
    ingestInboundChat(
      db,
      { channel: "whatsapp", address, externalId: `ar-${seq}`, body, receivedAt: at },
      at,
    ),
  )
  return result.chatId
}

const replies = (chatId: string) =>
  ownerDb
    .select()
    .from(saasOutreach)
    .where(eq(saasOutreach.chatId, chatId))
    .orderBy(asc(saasOutreach.createdAt))

const itemsOf = (chatId: string) =>
  ownerDb
    .select()
    .from(kairosItem)
    .where(
      and(
        eq(kairosItem.kind, "responder_chat"),
        eq(kairosItem.status, "espera"),
        sql`${kairosItem.payload} ->> 'chatId' = ${chatId}`,
      ),
    )

let clinicId = ""
/** Una conversación de la clínica con su app (`org_a`, subdominio «norte»), ligada por una persona. */
async function clinicChat(address: string, body: string, at: Date): Promise<string> {
  // Ya ligada antes de que escriba: lo que llega es de una clínica con su app (Soporte lo ve).
  await ownerDb.insert(saasChat).values({ channel: "whatsapp", address, clientId: clinicId })
  return write(address, body, at)
}

beforeAll(async () => {
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: ".odentia.test" })
  await ownerDb.insert(user).values([
    { id: ana.userId, name: "Ana Pérez", email: "ana@ar.test" },
    { id: sol.userId, name: "Sol Soporte", email: "sol@ar.test" },
  ])
  await ownerDb.insert(adminStaff).values([
    { userId: ana.userId, role: "admin" },
    { userId: sol.userId, role: "support" },
  ])
  await tx((db) => kairosRulesPass(db, monday))
  const [row] = await ownerDb
    .select()
    .from(saasClient)
    .where(eq(saasClient.organizationId, "org_a"))
  clinicId = row?.id ?? ""
  expect(clinicId).not.toBe("")
})

afterAll(() => configurePublicLinks(null))

describe("Ariadna en los chats", () => {
  it("apagada no responde y la conversación espera a Soporte en Hoy", async () => {
    const at = new Date(monday.getTime() + MIN)
    const chatId = await clinicChat("+51911000001", "¿cómo anulo una cita?", at)
    const now = new Date(at.getTime() + MIN)
    expect((await tick(now)).answered).toBe(0)
    expect(await replies(chatId)).toHaveLength(0)
    await tx((db) => kairosRulesPass(db, now))
    const [item] = await itemsOf(chatId)
    expect(item?.adminOnly).toBe(false)
  })

  it("prendida responde con la guía y el enlace, se presenta y firma; una vez por mensaje; Kairós no", async () => {
    await tx((db) => setAriadnaChats(db, ana, true, monday))
    const at = new Date(monday.getTime() + 5 * MIN)
    const chatId = await clinicChat("+51911000002", "¿cómo anulo una cita?", at)
    // Sin cliente es de Kairós, que está apagado: Ariadna no la toca.
    const sales = await write("+51911000003", "hola cuanto cuesta", at)
    const now = new Date(at.getTime() + MIN)
    const result = await tick(now)
    expect(result.errors).toEqual([])
    const [out] = await replies(chatId)
    expect(out).toMatchObject({
      byKairos: true,
      byAriadna: true,
      adminOnly: false,
      createdBy: null,
      status: "enviado",
    })
    expect(out?.body).toMatch(
      /^Soy Ariadna, la Ayuda de odentIA\.\s+Abre la cita y pulsa «Cancelar cita»/,
    )
    expect(out?.body).toContain("https://norte.odentia.test/agenda")
    expect(out?.body).toMatch(/— Ariadna · odentIA$/)
    expect(await replies(sales)).toHaveLength(0)
    const [turn] = await ownerDb
      .select()
      .from(kairosChatTurn)
      .where(eq(kairosChatTurn.chatId, chatId))
    expect(turn).toMatchObject({
      agent: "ariadna",
      outcome: "respondio",
      ariadnaReply: "respuesta",
    })
    // Otra pasada no repite.
    await tick(new Date(now.getTime() + MIN))
    expect(await replies(chatId)).toHaveLength(1)
    // Soporte la ve en el cajón con su nombre y que Ariadna la atiende.
    const seen = await tx((db) => getChat(db, sol, chatId, now))
    expect(seen.handledByAriadna).toBe(true)
    expect(seen.handledByKairos).toBe(false)
    expect(seen.entries.find((e) => e.kind === "salio")).toMatchObject({ byAriadna: true })
  })

  it("«no me deja»: ofrece la Ayuda o Soporte; con el sí pasa a Soporte y Soporte lo ve en Hoy", async () => {
    const at = new Date(monday.getTime() + 20 * MIN)
    const chatId = await clinicChat("+51911000004", "no me deja cobrar", at)
    await tick(new Date(at.getTime() + MIN))
    const [offer] = await replies(chatId)
    expect(offer?.body).toContain("¿quieres que te pase?")
    const later = new Date(at.getTime() + 3 * MIN)
    await write("+51911000004", "sí, por favor", later)
    const now = new Date(later.getTime() + MIN)
    expect((await tick(now)).handedOver).toBe(1)
    const out = await replies(chatId)
    expect(out[1]?.body).toContain("te paso con Soporte")
    const [chat] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, chatId))
    expect(chat?.kairosPausedAt).not.toBeNull()
    await tx((db) => kairosRulesPass(db, new Date(now.getTime() + MIN)))
    const [item] = await itemsOf(chatId)
    expect(item?.adminOnly).toBe(false)
    expect(item?.reason).toContain("Ariadna se lo pasó a Soporte")
    const seen = await tx((db) => getChat(db, sol, chatId, now))
    expect(seen.kairosHandover).toMatchObject({ agent: "ariadna", to: "soporte" })
  })

  it("«me cobraron dos veces» pasa a Administración: Soporte no lo ve y la respuesta nace «Solo administración»", async () => {
    const at = new Date(monday.getTime() + 40 * MIN)
    const chatId = await clinicChat("+51911000005", "¿por qué me cobraron dos veces?", at)
    const now = new Date(at.getTime() + MIN)
    expect((await tick(now)).handedOver).toBe(1)
    const [reply] = await replies(chatId)
    expect(reply).toMatchObject({ byAriadna: true, adminOnly: true })
    const [message] = await ownerDb
      .select()
      .from(saasInboundMessage)
      .where(eq(saasInboundMessage.chatId, chatId))
    expect(message?.adminOnly).toBe(true)
    await tx((db) => kairosRulesPass(db, new Date(now.getTime() + MIN)))
    const [item] = await itemsOf(chatId)
    expect(item?.adminOnly).toBe(true)
    expect(item?.reason).toContain("Ariadna se lo pasó a Administración")
    const seen = await tx((db) => getChat(db, sol, chatId, now))
    expect(seen.entries).toHaveLength(0)
    expect(seen.kairosHandover?.why).toBeNull()
    // Lo que responde Administración nace «Solo administración» si no dice otra cosa.
    const answer = await tx((db) =>
      prepareChatReply(db, ana, chatId, { body: "Ya lo revisamos." }, now),
    )
    const [row] = await ownerDb
      .select()
      .from(saasOutreach)
      .where(eq(saasOutreach.id, answer.outreachId))
    expect(row?.adminOnly).toBe(true)
  })

  it("pausada con «Lo atiendo yo» no responde; con Kairós prendido, Kairós tampoco toca la clínica", async () => {
    await tx((db) => setKairosSells(db, ana, true, monday))
    const at = new Date(monday.getTime() + 60 * MIN)
    const chatId = await clinicChat("+51911000006", "¿cómo anulo una cita?", at)
    await tx((db) => pauseChatKairos(db, ana, chatId, at))
    await tick(new Date(at.getTime() + MIN))
    expect(await replies(chatId)).toHaveLength(0)
    // Ariadna apagada y Kairós prendido: la clínica con su app sigue sin respuesta automática.
    await tx((db) => setAriadnaChats(db, ana, false, at))
    const other = await clinicChat("+51911000007", "¿cómo anulo una cita?", at)
    await tick(new Date(at.getTime() + 2 * MIN))
    expect(await replies(other)).toHaveLength(0)
    await tx((db) => setAriadnaChats(db, ana, true, at))
    await tx((db) => setKairosSells(db, ana, false, at))
  })

  it("pasado el tope del día en una conversación, pasa a Soporte sin llamar a Ariadna", async () => {
    const at = new Date(monday.getTime() + 100 * MIN)
    let chatId = await clinicChat("+51911000008", "hola", new Date(at.getTime() - 41 * MIN))
    for (let i = 1; i < KAIROS_TURNS_PER_CHAT_DAY; i += 1)
      chatId = await write("+51911000008", `hola ${i}`, new Date(at.getTime() - (40 - i) * MIN))
    const earlier = await ownerDb
      .select({ id: saasInboundMessage.id })
      .from(saasInboundMessage)
      .where(eq(saasInboundMessage.chatId, chatId))
    await ownerDb.insert(kairosChatTurn).values(
      earlier.map((row) => ({
        chatId,
        messageId: row.id,
        agent: "ariadna",
        outcome: "respondio" as const,
        createdAt: new Date(at.getTime() - 30 * MIN),
        updatedAt: new Date(at.getTime() - 30 * MIN),
      })),
    )
    await write("+51911000008", "¿sigues ahí?", at)
    await tick(new Date(at.getTime() + MIN))
    expect(asked.some((question) => question.includes("sigues"))).toBe(false)
    const [turn] = await ownerDb
      .select()
      .from(kairosChatTurn)
      .where(and(eq(kairosChatTurn.chatId, chatId), eq(kairosChatTurn.outcome, "paso")))
    expect(turn?.why).toContain("tope de 30 respuestas de Ariadna")
  })
})
