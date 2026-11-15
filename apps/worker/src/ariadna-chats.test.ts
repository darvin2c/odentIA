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
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
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
  resumeChatKairos,
  setAriadnaChats,
  setKairosSells,
} from "@odentia/services"
import { and, asc, desc, eq, sql } from "drizzle-orm"
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
    const chatId = await clinicChat("+51911000001", "¿cómo cancelo una cita?", at)
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
    const chatId = await clinicChat("+51911000002", "¿cómo cancelo una cita?", at)
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
    // Soporte no sabe que se pasó: ni a quién, ni que está en pausa, ni puede devolverla a Ariadna.
    expect(seen.kairosHandover).toBeNull()
    expect(seen.kairosPausedAt).toBeNull()
    expect(seen.ariadnaAvailable).toBe(false)
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
    const chatId = await clinicChat("+51911000006", "¿cómo cancelo una cita?", at)
    await tx((db) => pauseChatKairos(db, ana, chatId, at))
    await tick(new Date(at.getTime() + MIN))
    expect(await replies(chatId)).toHaveLength(0)
    // Ariadna apagada y Kairós prendido: la clínica con su app sigue sin respuesta automática.
    await tx((db) => setAriadnaChats(db, ana, false, at))
    const other = await clinicChat("+51911000007", "¿cómo cancelo una cita?", at)
    await tick(new Date(at.getTime() + 2 * MIN))
    expect(await replies(other)).toHaveLength(0)
    await tx((db) => setAriadnaChats(db, ana, true, at))
    await tx((db) => setKairosSells(db, ana, false, at))
  })

  it("si Soporte escribe a mano, Ariadna deja de responder en esa conversación", async () => {
    const at = new Date(monday.getTime() + 80 * MIN)
    const chatId = await clinicChat("+51911000009", "¿cómo cancelo una cita?", at)
    await tx((db) => prepareChatReply(db, sol, chatId, { body: "Hola, te ayudo yo." }, at))
    const [chat] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, chatId))
    expect(chat).toMatchObject({ kairosPausedBy: sol.userId })
    expect(chat?.kairosPausedAt).not.toBeNull()
    await write("+51911000009", "gracias, ¿y cómo la muevo?", new Date(at.getTime() + MIN))
    await tick(new Date(at.getTime() + 2 * MIN))
    const out = await replies(chatId)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ byAriadna: false, createdBy: sol.userId })
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

  it("un cobro tras varios mensajes: todo lo que respondió y su actividad quedan solo para Administración", async () => {
    const at = new Date(monday.getTime() + 120 * MIN)
    const address = "+51911000010"
    const chatId = await clinicChat(address, "hola, una consulta", at)
    await write(address, "¿por qué me cobraron dos veces?", new Date(at.getTime() + 5_000))
    expect((await tick(new Date(at.getTime() + MIN))).handedOver).toBe(1)
    const messages = await ownerDb
      .select()
      .from(saasInboundMessage)
      .where(eq(saasInboundMessage.chatId, chatId))
    expect(messages).toHaveLength(2)
    expect(messages.every((m) => m.adminOnly)).toBe(true)
    const activity = await ownerDb
      .select()
      .from(saasFollowUp)
      .where(and(eq(saasFollowUp.chatId, chatId), eq(saasFollowUp.direction, "entro")))
    expect(activity).toHaveLength(2)
    expect(activity.every((row) => row.adminOnly)).toBe(true)
    expect((await tx((db) => getChat(db, sol, chatId, at))).entries).toHaveLength(0)
  })

  it("lo que llega después del pase a Administración nace solo para ella, también en Hoy; Soporte no la devuelve", async () => {
    const at = new Date(monday.getTime() + 140 * MIN)
    const address = "+51911000011"
    const chatId = await clinicChat(address, "necesito la factura de mi plan", at)
    expect((await tick(new Date(at.getTime() + MIN))).handedOver).toBe(1)
    const later = new Date(at.getTime() + 3 * MIN)
    await write(address, "hola, ¿ya lo vieron?", later)
    const [last] = await ownerDb
      .select()
      .from(saasInboundMessage)
      .where(eq(saasInboundMessage.chatId, chatId))
      .orderBy(desc(saasInboundMessage.createdAt))
      .limit(1)
    expect(last).toMatchObject({ body: "hola, ¿ya lo vieron?", adminOnly: true })
    const activity = await ownerDb
      .select()
      .from(saasFollowUp)
      .where(and(eq(saasFollowUp.chatId, chatId), eq(saasFollowUp.direction, "entro")))
    expect(activity).toHaveLength(2)
    expect(activity.every((row) => row.adminOnly)).toBe(true)
    await tx((db) => kairosRulesPass(db, new Date(later.getTime() + MIN)))
    const items = await itemsOf(chatId)
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.adminOnly)).toBe(true)
    const seen = await tx((db) => getChat(db, sol, chatId, later))
    expect(seen.entries).toHaveLength(0)
    expect(seen.kairosHandover).toBeNull()
    await expect(tx((db) => resumeChatKairos(db, sol, chatId, later))).rejects.toMatchObject({
      status: 409,
    })
    const [still] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, chatId))
    expect(still?.kairosPausedAt).not.toBeNull()
    // Administración la ve con a quién se pasó.
    const mine = await tx((db) => getChat(db, ana, chatId, later))
    expect(mine.kairosHandover).toMatchObject({ agent: "ariadna", to: "administracion" })
  })

  it("pasada a Administración, cada respuesta sale «Solo administración» aunque llegue sin marcar; quitarlo se dice aparte", async () => {
    const at = new Date(monday.getTime() + 160 * MIN)
    const chatId = await clinicChat("+51911000012", "quiero cambiar de plan", at)
    expect((await tick(new Date(at.getTime() + MIN))).handedOver).toBe(1)
    const now = new Date(at.getTime() + 2 * MIN)
    const flagOf = async (id: string) =>
      (await ownerDb.select().from(saasOutreach).where(eq(saasOutreach.id, id)))[0]?.adminOnly
    const first = await tx((db) =>
      prepareChatReply(db, ana, chatId, { body: "Te ayudo con el plan.", adminOnly: false }, now),
    )
    expect(await flagOf(first.outreachId)).toBe(true)
    const second = await tx((db) =>
      prepareChatReply(db, ana, chatId, { body: "¿Qué plan quieres?", adminOnly: false }, now),
    )
    expect(await flagOf(second.outreachId)).toBe(true)
    const shown = await tx((db) =>
      prepareChatReply(
        db,
        ana,
        chatId,
        { body: "Listo.", adminOnly: false, adminOnlyOverride: true },
        now,
      ),
    )
    expect(await flagOf(shown.outreachId)).toBe(false)
  })

  it("en el tope o si Ariadna falla, un cobro va a Administración (solo para ella), no a Soporte", async () => {
    // El tope: la conversación ya tiene sus 30 turnos de hoy.
    const at = new Date(monday.getTime() + 180 * MIN)
    const address = "+51911000013"
    let chatId = await clinicChat(address, "hola", new Date(at.getTime() - 41 * MIN))
    for (let i = 1; i < KAIROS_TURNS_PER_CHAT_DAY; i += 1)
      chatId = await write(address, `hola ${i}`, new Date(at.getTime() - (40 - i) * MIN))
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
    await write(address, "me cobraron dos veces", at)
    await tick(new Date(at.getTime() + MIN))
    const [capped] = await ownerDb
      .select()
      .from(kairosChatTurn)
      .where(and(eq(kairosChatTurn.chatId, chatId), eq(kairosChatTurn.outcome, "paso")))
    expect(capped).toMatchObject({ ariadnaReply: "administracion" })
    expect(capped?.why).toContain("tope")
    const [reply] = await replies(chatId)
    expect(reply).toMatchObject({ adminOnly: true, byAriadna: true })
    expect((await tx((db) => getChat(db, sol, chatId, at))).kairosHandover).toBeNull()

    // Ariadna falla: el cobro tampoco va a Soporte.
    const failing: AriadnaChatResponder = {
      answer: async () => {
        throw new Error("Jev no respondió")
      },
    }
    const other = new Date(monday.getTime() + 200 * MIN)
    const failed = await clinicChat("+51911000014", "necesito la factura de mi plan", other)
    await runKairosSellsTick({
      ownerDb,
      seller,
      ariadna: failing,
      channels,
      fetch: fakeFetch,
      now: () => new Date(other.getTime() + MIN),
    })
    const [turn] = await ownerDb
      .select()
      .from(kairosChatTurn)
      .where(eq(kairosChatTurn.chatId, failed))
    expect(turn).toMatchObject({ outcome: "fallo", ariadnaReply: "administracion" })
    const [out] = await replies(failed)
    expect(out).toMatchObject({ adminOnly: true })
    const [message] = await ownerDb
      .select()
      .from(saasInboundMessage)
      .where(eq(saasInboundMessage.chatId, failed))
    expect(message?.adminOnly).toBe(true)
  })

  it("si una persona mueve la conversación a otro cliente mientras Ariadna responde, no escribe", async () => {
    await ownerDb.execute(
      sql`insert into "organization" ("id", "name", "slug", "created_at") values ('org_m', 'Otra', 'otra', now()) on conflict do nothing`,
    )
    const [moved] = await ownerDb
      .insert(saasClient)
      .values({ name: "Otra clínica", product: "dental", organizationId: "org_m" })
      .returning()
    const at = new Date(monday.getTime() + 220 * MIN)
    const chatId = await clinicChat("+51911000015", "¿cómo cancelo una cita?", at)
    const moving: AriadnaChatResponder = {
      answer: async (org, input) => {
        expect(org).toBe("org_a")
        await ownerDb.update(saasChat).set({ clientId: moved?.id }).where(eq(saasChat.id, chatId))
        return askHelpByChat(input)
      },
    }
    await runKairosSellsTick({
      ownerDb,
      seller,
      ariadna: moving,
      channels,
      fetch: fakeFetch,
      now: () => new Date(at.getTime() + MIN),
    })
    expect(await replies(chatId)).toHaveLength(0)
    const [turn] = await ownerDb
      .select()
      .from(kairosChatTurn)
      .where(eq(kairosChatTurn.chatId, chatId))
    expect(turn).toMatchObject({ outcome: "omitido" })
    expect(turn?.why).toContain("otro cliente")
  })
})
