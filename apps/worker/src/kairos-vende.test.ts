import { createKairosSeller, type KairosChatModel } from "@odentia/agent"
import type { Db } from "@odentia/db"
import {
  kairosChatTurn,
  kairosItem,
  kairosProposal,
  saasChat,
  saasClient,
  saasClientContact,
  saasOutreach,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import {
  type AdminActor,
  type AdminChannels,
  assignChat,
  ingestInboundChat,
  kairosRulesPass,
  pauseChatKairos,
  setKairosSells,
  setStaffHours,
  setStaffMeetingUrl,
} from "@odentia/services"
import { and, asc, eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { runKairosSellsTick } from "./kairos-vende.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Kairós vende en los chats (ADR 0189) contra Postgres real, con el doble de
 * Kairós (`LLM_MODEL=fake`) y un Graph de prueba: responde una vez por mensaje,
 * no responde apagado, pausado ni a una clínica con su app, pide el contacto
 * por Instagram antes de agendar, agenda con su confirmación, recuerda una vez,
 * pide otra hora una vez, falla con el aviso fijo y deja a Hoy en paz mientras
 * atiende.
 */
setupTestDb()

const MIN = 60_000
// Lunes 9 de noviembre de 2026, 08:00 de Lima (13:00 UTC). En el pasado: la auditoría usa la hora real.
const monday = new Date("2026-11-09T13:00:00Z")
const ana: AdminActor = { userId: "kv-ana", role: "admin" }

const channels: AdminChannels = {
  appSecret: "secreto",
  verifyToken: "reto",
  whatsapp: { phoneNumberId: "1111111111", accessToken: "wa-token" },
  messenger: { pageId: "2222222222", accessToken: "page-token" },
  instagram: { accountId: "3333333333", pageId: "2222222222", accessToken: "page-token" },
}

const sent: Array<{ url: string; body: Record<string, unknown> }> = []
let wamids = 0
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) })
  wamids += 1
  return Response.json({ messages: [{ id: `wamid.kv${wamids}` }], message_id: `mid.kv${wamids}` })
}) as typeof fetch

const fakeSeller = createKairosSeller({ platform: { fake: true, maxRetries: 0 }, onUse: () => {} })

function tick(now: Date, seller = fakeSeller) {
  return runKairosSellsTick({ ownerDb, seller, channels, fetch: fakeFetch, now: () => now })
}

const tx = <T>(fn: (db: Db) => Promise<T>) => ownerDb.transaction((inner) => fn(inner as Db))

let seq = 0
/** Lo que escribe alguien por un canal, `at`. */
async function write(
  channel: "whatsapp" | "instagram" | "messenger",
  address: string,
  body: string,
  at: Date,
): Promise<string> {
  seq += 1
  const result = await tx((db) =>
    ingestInboundChat(
      db,
      { channel, address, externalId: `kv-${seq}`, body, displayName: "Rosa", receivedAt: at },
      at,
    ),
  )
  return result.chatId
}

async function replies(chatId: string) {
  return ownerDb
    .select()
    .from(saasOutreach)
    .where(eq(saasOutreach.chatId, chatId))
    .orderBy(asc(saasOutreach.createdAt), asc(saasOutreach.id))
}

async function chatOf(chatId: string) {
  const [row] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, chatId))
  return row
}

async function itemsOf(chatId: string, kind: string) {
  return ownerDb
    .select()
    .from(kairosItem)
    .where(
      and(
        eq(kairosItem.kind, kind),
        eq(kairosItem.status, "espera"),
        sql`${kairosItem.payload} ->> 'chatId' = ${chatId}`,
      ),
    )
}

beforeAll(async () => {
  await ownerDb.insert(user).values({ id: ana.userId, name: "Ana Pérez", email: "ana@kv.test" })
  await ownerDb.insert(adminStaff).values({ userId: ana.userId, role: "admin" })
  // Ana presenta de lunes a viernes de 9 a 12, en su sala.
  await tx((db) =>
    setStaffHours(
      db,
      ana,
      ana.userId,
      [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 720 })),
    ),
  )
  await tx((db) => setStaffMeetingUrl(db, ana, ana.userId, "https://meet.example.com/ana"))
})

describe("Kairós vende en los chats", () => {
  it("apagado no responde nada", async () => {
    const chatId = await write(
      "whatsapp",
      "+51900000001",
      "Hola, quiero una presentación",
      new Date(monday.getTime() - MIN),
    )
    const result = await tick(monday)
    expect(result.answered).toBe(0)
    expect(await replies(chatId)).toHaveLength(0)
    // Apagado, Hoy sí pide decir de quién es.
    await tx((db) => kairosRulesPass(db, monday))
    expect(await itemsOf(chatId, "chat_sin_cliente")).toHaveLength(1)
  })

  it("prendido responde una vez por mensaje, registra la clínica y propone una hora", async () => {
    await tx((db) => setKairosSells(db, ana, true, monday))
    const at = new Date(monday.getTime() + 2 * MIN)
    const chatId = await write(
      "whatsapp",
      "+51900000002",
      "Hola, quiero una presentación. Mi clínica se llama Sonrisas del Norte",
      at,
    )
    // Mientras escribe (menos de 20 s), espera.
    await tick(new Date(at.getTime() + 5_000))
    expect(await replies(chatId)).toHaveLength(0)
    const now = new Date(at.getTime() + MIN)
    const first = await tick(now)
    expect(first.errors).toEqual([])
    expect(first.answered).toBeGreaterThanOrEqual(1)
    const out = await replies(chatId)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      byKairos: true,
      createdBy: null,
      status: "enviado",
      adminOnly: true,
    })
    expect(out[0]?.body).toContain("Hola, soy Kairós, el asistente de Sallca.")
    // Son las 08:03 de Lima: con 2 h de aviso, la primera hora de Ana es a las 10:30.
    expect(out[0]?.body).toContain("lunes, 9 de noviembre a las 10:30")
    expect(out[0]?.body).toMatch(/— Kairós · odentIA$/)
    // La clínica nueva, a nombre de Kairós, y la conversación ligada a ella.
    const chat = await chatOf(chatId)
    const [client] = await ownerDb
      .select()
      .from(saasClient)
      .where(eq(saasClient.id, chat?.clientId ?? ""))
    expect(client).toMatchObject({
      name: "Sonrisas del Norte",
      createdBy: null,
      origin: "whatsapp",
    })
    expect(chat?.matchedByUser).toBeNull()
    const [proposal] = await ownerDb
      .select()
      .from(kairosProposal)
      .where(eq(kairosProposal.chatId, chatId))
    expect(proposal?.status).toBe("pendiente")
    // Otra pasada no repite.
    const again = await tick(new Date(now.getTime() + MIN))
    expect(again.answered).toBe(0)
    expect(await replies(chatId)).toHaveLength(1)
    const turns = await ownerDb
      .select()
      .from(kairosChatTurn)
      .where(eq(kairosChatTurn.chatId, chatId))
    expect(turns.map((turn) => turn.outcome)).toEqual(["respondio"])

    // Con su sí, agenda y la confirmación dice día, hora de Lima, con quién y la sala.
    const yesAt = new Date(now.getTime() + 2 * MIN)
    await write("whatsapp", "+51900000002", "sí", yesAt)
    const booked = await tick(new Date(yesAt.getTime() + MIN))
    expect(booked.errors).toEqual([])
    const [task] = await ownerDb
      .select()
      .from(saasTask)
      .where(and(eq(saasTask.channelChatId, chatId), eq(saasTask.kind, "presentacion")))
    expect(task).toMatchObject({ status: "abierta", assigneeUserId: ana.userId, byKairos: true })
    expect(task?.dueAt?.toISOString()).toBe("2026-11-09T15:30:00.000Z")
    expect(task?.endsAt?.toISOString()).toBe("2026-11-09T16:15:00.000Z")
    const confirmation = (await replies(chatId)).at(-1)?.body ?? ""
    expect(confirmation).toContain("lunes, 9 de noviembre a las 10:30 (hora de Lima) con Ana Pérez")
    expect(confirmation).toContain("https://meet.example.com/ana")
  })

  it("con una clínica con su app, pausado o «No es una clínica» no responde", async () => {
    const at = new Date(monday.getTime() + 10 * MIN)
    // Clínica con su app: espera a Soporte.
    // La clínica de la cuenta de prueba (`org_a`): la pasada de Kairós ya le creó su cliente.
    await tx((db) => kairosRulesPass(db, at))
    const [withApp] = await ownerDb
      .select()
      .from(saasClient)
      .where(eq(saasClient.organizationId, "org_a"))
    const appChat = await write("whatsapp", "+51900000003", "Hola, no me carga la agenda", at)
    await tx((db) => assignChat(db, ana, appChat, { clientId: withApp?.id ?? "" }, at))
    await write("whatsapp", "+51900000003", "¿Me ayudan?", new Date(at.getTime() + MIN))
    // Pausado: «Lo atiendo yo».
    const paused = await write("whatsapp", "+51900000004", "Quiero una demo", at)
    await tx((db) => pauseChatKairos(db, ana, paused, at))
    const now = new Date(at.getTime() + 3 * MIN)
    await tick(now)
    expect(await replies(appChat)).toHaveLength(0)
    expect(await replies(paused)).toHaveLength(0)
    // Hoy sí los pide: Kairós no los atiende.
    await tx((db) => kairosRulesPass(db, now))
    expect(await itemsOf(appChat, "responder_chat")).toHaveLength(1)
    expect(await itemsOf(paused, "chat_sin_cliente")).toHaveLength(1)
  })

  it("por Instagram pide el WhatsApp o el correo antes de ofrecer horas, y lo guarda", async () => {
    const at = new Date(monday.getTime() + 20 * MIN)
    const chatId = await write(
      "instagram",
      "1789000000000001",
      "Hola, quiero una demo. Mi clínica se llama Dental Andes",
      at,
    )
    await tick(new Date(at.getTime() + MIN))
    const first = (await replies(chatId)).at(-1)?.body ?? ""
    expect(first).toContain("WhatsApp")
    expect(
      await ownerDb.select().from(kairosProposal).where(eq(kairosProposal.chatId, chatId)),
    ).toHaveLength(0)
    const chat = await chatOf(chatId)
    expect(chat?.clientId).not.toBeNull()

    const again = new Date(at.getTime() + 3 * MIN)
    await write("instagram", "1789000000000001", "Mi WhatsApp es 987 654 321", again)
    await tick(new Date(again.getTime() + MIN))
    const [contact] = await ownerDb
      .select()
      .from(saasClientContact)
      .where(eq(saasClientContact.id, (await chatOf(chatId))?.contactId ?? ""))
    expect(contact?.phone).toBe("+51987654321")
    const offer = (await replies(chatId)).at(-1)?.body ?? ""
    expect(offer).toContain("a las ")
    expect(
      await ownerDb.select().from(kairosProposal).where(eq(kairosProposal.chatId, chatId)),
    ).toHaveLength(1)
  })

  it("un nombre parecido a otra clínica crea la nueva y deja «¿Es la misma que…?»", async () => {
    const at = new Date(monday.getTime() + 30 * MIN)
    const chatId = await write(
      "whatsapp",
      "+51900000005",
      "Hola. Mi clínica se llama Sonrisas del Norte",
      at,
    )
    await tick(new Date(at.getTime() + MIN))
    const chat = await chatOf(chatId)
    const clients = await ownerDb
      .select()
      .from(saasClient)
      .where(eq(saasClient.name, "Sonrisas del Norte"))
    expect(clients).toHaveLength(2)
    const older = clients.find((row) => row.id !== chat?.clientId)
    expect(older).toBeTruthy()
    const [item] = await ownerDb
      .select()
      .from(kairosItem)
      .where(and(eq(kairosItem.kind, "duplicado"), eq(kairosItem.clientId, chat?.clientId ?? "")))
    expect(item?.title).toBe("¿Es la misma que Sonrisas del Norte?")
    expect(item?.payload).toMatchObject({ keepId: older?.id, dropId: chat?.clientId })
  })

  it("si el modelo falla sale el aviso fijo, se pausa y Hoy lo muestra con el motivo", async () => {
    const broken: KairosChatModel = {
      invoke: async () => {
        throw new Error("503")
      },
      bindTools: () => ({
        invoke: async () => {
          throw new Error("503")
        },
      }),
    }
    const seller = createKairosSeller({
      platform: { openai: { apiKey: "clave-sintetica" }, maxRetries: 0 },
      createModel: async () => broken,
      onUse: () => {},
    })
    const at = new Date(monday.getTime() + 40 * MIN)
    const chatId = await write("whatsapp", "+51900000006", "¿Qué incluye?", at)
    const now = new Date(at.getTime() + MIN)
    const result = await tick(now, seller)
    expect(result.failed).toBeGreaterThanOrEqual(1)
    const out = await replies(chatId)
    expect(out.at(-1)?.body).toContain(
      "Gracias por escribir. Alguien del equipo te responde pronto.",
    )
    expect((await chatOf(chatId))?.kairosPausedAt).not.toBeNull()
    await tx((db) => kairosRulesPass(db, now))
    const [item] = await itemsOf(chatId, "chat_sin_cliente")
    expect(item?.reason).toContain("Kairós se lo pasó al equipo")
  })

  it("mientras Kairós atiende, «Responder» no sale; si lo pasa al equipo, sí", async () => {
    const at = new Date(monday.getTime() + 50 * MIN)
    const [client] = await ownerDb
      .insert(saasClient)
      .values({ name: "Clínica Venta (ficticia)", product: "dental" })
      .returning()
    const chatId = await write("whatsapp", "+51900000007", "Hola", at)
    await tx((db) => assignChat(db, ana, chatId, { clientId: client?.id ?? "" }, at))
    await write("whatsapp", "+51900000007", "¿Cuánto cuesta?", new Date(at.getTime() + MIN))
    // Aún no responde (escribió hace segundos): Hoy no lo pide.
    const soon = new Date(at.getTime() + MIN + 5_000)
    await tx((db) => kairosRulesPass(db, soon))
    expect(await itemsOf(chatId, "responder_chat")).toHaveLength(0)
    // Responde, y Hoy sigue sin pedirlo.
    const later = new Date(at.getTime() + 2 * MIN)
    await tick(later)
    await tx((db) => kairosRulesPass(db, later))
    expect(await itemsOf(chatId, "responder_chat")).toHaveLength(0)
    // Pide un descuento: lo pasa al equipo con el mensaje fijo y Hoy lo pide.
    const ask = new Date(at.getTime() + 3 * MIN)
    await write("whatsapp", "+51900000007", "¿Me hacen un descuento?", ask)
    const handed = await tick(new Date(ask.getTime() + MIN))
    expect(handed.handedOver).toBe(1)
    expect((await replies(chatId)).at(-1)?.body).toContain("Eso lo ve alguien del equipo de Sallca")
    await tx((db) => kairosRulesPass(db, new Date(ask.getTime() + 2 * MIN)))
    const [item] = await itemsOf(chatId, "responder_chat")
    expect(item?.reason).toContain("Pide un descuento")
  })

  it("recuerda la presentación el día anterior una vez, y pide otra hora una vez", async () => {
    // Una presentación agendada por un chat hace días, para el martes 10 a las 10:00 de Lima.
    const old = new Date("2026-11-05T15:00:00Z")
    const chatId = await write("whatsapp", "+51900000008", "Hola", old)
    const [client] = await ownerDb
      .insert(saasClient)
      .values({ name: "Clínica Recuerda (ficticia)", product: "dental" })
      .returning()
    const [contact] = await ownerDb
      .insert(saasClientContact)
      .values({
        clientId: client?.id ?? "",
        name: "Lucía Rojas",
        phone: "+51900000008",
        isPrimary: true,
      })
      .returning()
    await tx((db) =>
      assignChat(
        db,
        ana,
        chatId,
        { clientId: client?.id ?? "", contactId: contact?.id ?? null },
        old,
      ),
    )
    const [task] = await ownerDb
      .insert(saasTask)
      .values({
        clientId: client?.id ?? "",
        kind: "presentacion",
        title: "Presentación",
        dueOn: "2026-11-10",
        dueAt: new Date("2026-11-10T15:00:00Z"),
        endsAt: new Date("2026-11-10T15:45:00Z"),
        assigneeUserId: ana.userId,
        contactId: contact?.id ?? null,
        channelChatId: chatId,
        byKairos: true,
        createdAt: old,
        updatedAt: old,
      })
      .returning()
    // Lunes 09:30 de Lima: ya es el día anterior desde las 09:00. Fuera de las 24 h: la plantilla.
    const remind = new Date("2026-11-09T14:30:00Z")
    sent.length = 0
    const first = await tick(remind)
    expect(first.notices).toBe(1)
    const template = sent.find((call) =>
      JSON.stringify(call.body).includes("recordatorio_presentacion"),
    )
    expect(template).toBeTruthy()
    expect(JSON.stringify(template?.body)).toContain("https://meet.example.com/ana")
    expect((await tick(new Date(remind.getTime() + MIN))).notices).toBe(0)

    // «Pedir otra hora»: Kairós le escribe una vez.
    await ownerDb
      .update(saasTask)
      .set({ needsNewTimeAt: remind })
      .where(eq(saasTask.id, task?.id ?? ""))
    sent.length = 0
    const asked = await tick(new Date(remind.getTime() + 2 * MIN))
    expect(asked.notices).toBe(1)
    expect(JSON.stringify(sent[0]?.body)).toContain("retomar_conversacion")
    expect((await tick(new Date(remind.getTime() + 3 * MIN))).notices).toBe(0)
    const out = await replies(chatId)
    expect(out.filter((row) => row.byKairos && row.template)).toHaveLength(2)
  })
})
