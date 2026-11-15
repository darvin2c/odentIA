import { kairosItem, saasChat, saasClient, saasClientContact } from "@odentia/db/schema/admin-arm"
import { user } from "@odentia/db/schema/auth"
import { and, eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { inboundAttachmentKey } from "./admin-client-files.js"
import type { AdminActor } from "./admin-core.js"
import {
  assignChat,
  type InboundChatInput,
  ingestInboundChat,
  markChatNotClinic,
  markChatOutreachFailed,
  prepareChatReply,
} from "./admin-inbound-chat.js"
import {
  chatAddressWords,
  decideKairosItem,
  type KairosExecutors,
  kairosRulesPass,
  listKairosItems,
  todayForStaff,
} from "./admin-kairos.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Kairós pone en Hoy lo que llega por WhatsApp, Instagram y Messenger. */
setupTestDb()
const NOW = new Date()
const HOUR = 3_600_000
const DAY = 86_400_000
const admin: AdminActor = { userId: "kc-admin", role: "admin" }
const support: AdminActor = { userId: "kc-support", role: "support" }
const ORG = "kc-org"
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
let sales: string
let clinic: string
let quispe: string
let rosa: string

let phoneSeq = 0
/** Un celular peruano distinto por prueba. */
function phone(): string {
  phoneSeq += 1
  return `+5195422${String(phoneSeq).padStart(4, "0")}`
}

function message(overrides: Partial<InboundChatInput> = {}): InboundChatInput {
  return {
    channel: "whatsapp",
    address: phone(),
    waId: null,
    displayName: null,
    externalId: `wamid.${crypto.randomUUID()}`,
    body: "Hola, quiero saber de odentIA",
    media: [],
    receivedAt: new Date(NOW.getTime() - HOUR),
    ...overrides,
  }
}

async function client(name: string, organizationId?: string): Promise<string> {
  const [row] = await ownerDb
    .insert(saasClient)
    .values({ name, product: "dental", organizationId })
    .returning({ id: saasClient.id })
  if (!row) throw new Error("sin cliente")
  return row.id
}

async function contact(clientId: string, name: string, phoneNumber: string | null) {
  const [row] = await ownerDb
    .insert(saasClientContact)
    .values({ clientId, name, phone: phoneNumber })
    .returning({ id: saasClientContact.id })
  if (!row) throw new Error("sin contacto")
  return row.id
}

const pass = (at = NOW) => ownerDb.transaction((tx) => kairosRulesPass(tx, at))

async function itemsOf(
  chatId: string,
  kind?: "chat_sin_cliente" | "responder_chat" | "posible_carga",
) {
  return ownerDb
    .select()
    .from(kairosItem)
    .where(
      and(
        kind ? eq(kairosItem.kind, kind) : undefined,
        sql`${kairosItem.payload} ->> 'chatId' = ${chatId}`,
      ),
    )
    .orderBy(kairosItem.createdAt)
}

const waiting = async (chatId: string, kind: "chat_sin_cliente" | "responder_chat") =>
  (await itemsOf(chatId, kind)).filter((item) => item.status === "espera")

const unused = () => {
  throw new Error("no se ejecuta")
}
/** Las operaciones de la pantalla: solo «¿De quién es?» se usa aquí, y es la de verdad. */
const executors: KairosExecutors = {
  prepareOutreach: unused,
  updateClient: unused,
  linkContactToUser: unused,
  assignInboundEmail: unused,
  assignChat: (tx, actor, chatId, input) => assignChat(tx, actor, chatId, input, NOW),
  prepareEmailReply: unused,
  recordPresentation: unused,
  createProposal: unused,
  markClientFileCarga: unused,
}
const decide = (actor: AdminActor, id: string, input: Parameters<typeof decideKairosItem>[3]) =>
  ownerDb.transaction((tx) => decideKairosItem(tx, actor, id, input, executors, NOW))

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Lovelace", email: "ada@kc.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@kc.test" },
  ])
  await insertOrg(ownerDb, ORG, "kc-clinica")
  sales = await client("Clínica en venta (ficticia)")
  clinic = await client("Clínica con app (ficticia)", ORG)
  quispe = await client("Odontología Quispe (ficticia)")
  rosa = await contact(quispe, "Rosa Quispe", "+51954220318")
})

describe("chat_sin_cliente", () => {
  it("un WhatsApp sin cliente sale una vez, con la sugerencia del único contacto con ese celular", async () => {
    const chat = await ingestInboundChat(
      ownerDb,
      message({ address: "+51954220318", body: "Hola, soy Rosa" }),
      NOW,
    )
    await pass()
    await pass()
    const items = await itemsOf(chat.chatId, "chat_sin_cliente")
    expect(items).toHaveLength(1)
    const [item] = items
    expect(item).toMatchObject({
      status: "espera",
      adminOnly: true,
      clientId: null,
      title: "WhatsApp sin cliente: +51 954 220 318",
    })
    expect(item?.payload).toMatchObject({
      chatId: chat.chatId,
      channel: "whatsapp",
      address: "+51954220318",
      displayName: null,
      messageId: chat.messageId,
      lastBody: "Hola, soy Rosa",
      suggestion: {
        contactId: rosa,
        contactName: "Rosa Quispe",
        clientId: quispe,
        clientName: "Odontología Quispe (ficticia)",
      },
    })
    expect(item?.reason).toContain(
      "Ese celular es de Rosa Quispe, de Odontología Quispe (ficticia).",
    )
    // Soporte no lo ve.
    const forSupport = await listKairosItems(ownerDb, support, { status: "espera" }, NOW)
    expect(forSupport.items.some((row) => row.id === item?.id)).toBe(false)
  })

  it("con dos contactos con el mismo celular no sugiere a nadie", async () => {
    const address = phone()
    await contact(sales, "Pepe Uno", address)
    await contact(clinic, "Pepe Dos", address)
    const chat = await ingestInboundChat(ownerDb, message({ address }), NOW)
    await pass()
    const [item] = await itemsOf(chat.chatId, "chat_sin_cliente")
    expect(item?.payload.suggestion).toBeNull()
    expect(item?.reason).not.toContain("Ese celular es de")
  })

  it("Instagram y Messenger se nombran por su @usuario o su nombre, sin sugerencia", async () => {
    const ig = await ingestInboundChat(
      ownerDb,
      message({
        channel: "instagram",
        address: "17841400000000001",
        displayName: "@dra.melissa.ortodoncia",
        body: "¿Sirve para ortodoncia? Tengo consultorio en Trujillo",
      }),
      NOW,
    )
    const fb = await ingestInboundChat(
      ownerDb,
      message({ channel: "messenger", address: "2400000000000001", displayName: "Lucía Rojas" }),
      NOW,
    )
    await pass()
    const [igItem] = await itemsOf(ig.chatId, "chat_sin_cliente")
    const [fbItem] = await itemsOf(fb.chatId, "chat_sin_cliente")
    expect(igItem?.title).toBe("Instagram sin cliente: @dra.melissa.ortodoncia")
    expect(igItem?.payload).toMatchObject({ channel: "instagram", suggestion: null })
    expect(fbItem?.title).toBe("Messenger sin cliente: Lucía Rojas")
  })

  it("un Excel en un mensaje sin cliente se dice: puede ser la carga", async () => {
    const chat = await ingestInboundChat(
      ownerDb,
      message({
        body: null,
        media: [
          {
            objectKey: inboundAttachmentKey("xlsx"),
            mimeType: XLSX,
            filename: "pacientes.xlsx",
            size: 10,
          },
        ],
      }),
      NOW,
    )
    await pass()
    const [item] = await itemsOf(chat.chatId, "chat_sin_cliente")
    expect(item?.reason).toContain("puede ser la carga de datos")
    expect(item?.payload).toMatchObject({ lastBody: "Mandó un archivo", maybeCarga: true })
  })

  it("si vuelve a escribir, el mismo ítem pasa al mensaje nuevo", async () => {
    const address = phone()
    const first = await ingestInboundChat(ownerDb, message({ address, body: "Uno" }), NOW)
    await pass()
    const second = await ingestInboundChat(
      ownerDb,
      message({ address, body: "Dos", receivedAt: new Date(NOW.getTime() - HOUR / 2) }),
      NOW,
    )
    await pass()
    const items = await itemsOf(first.chatId, "chat_sin_cliente")
    expect(items).toHaveLength(1)
    expect(items[0]?.payload).toMatchObject({ messageId: second.messageId, lastBody: "Dos" })
  })

  it("al responder se retira, y vuelve cuando escribe otra vez", async () => {
    const address = phone()
    const chat = await ingestInboundChat(ownerDb, message({ address }), NOW)
    await pass()
    expect(await waiting(chat.chatId, "chat_sin_cliente")).toHaveLength(1)
    await ownerDb.transaction((tx) =>
      prepareChatReply(
        tx,
        admin,
        chat.chatId,
        { body: "Hola, ¿de qué clínica nos escribes?" },
        NOW,
      ),
    )
    expect(await waiting(chat.chatId, "chat_sin_cliente")).toHaveLength(0)
    await pass()
    expect(await waiting(chat.chatId, "chat_sin_cliente")).toHaveLength(0)
    const later = new Date(NOW.getTime() + 10 * 60_000)
    const again = await ingestInboundChat(
      ownerDb,
      message({ address, body: "De la Clínica Norte", receivedAt: later }),
      later,
    )
    await pass(later)
    const open = await waiting(chat.chatId, "chat_sin_cliente")
    expect(open).toHaveLength(1)
    expect(open[0]?.payload.messageId).toBe(again.messageId)
  })

  it("descartado no vuelve por el mismo mensaje", async () => {
    const chat = await ingestInboundChat(ownerDb, message(), NOW)
    await pass()
    const [item] = await waiting(chat.chatId, "chat_sin_cliente")
    await decide(admin, item?.id ?? "", { action: "descartar" })
    await pass()
    expect(await waiting(chat.chatId, "chat_sin_cliente")).toHaveLength(0)
  })

  it("«No es una clínica» lo retira y lo que escribe después no sale", async () => {
    const address = phone()
    const chat = await ingestInboundChat(ownerDb, message({ address }), NOW)
    await pass()
    await ownerDb.transaction((tx) => markChatNotClinic(tx, admin, chat.chatId, NOW))
    expect(await waiting(chat.chatId, "chat_sin_cliente")).toHaveLength(0)
    await ingestInboundChat(
      ownerDb,
      message({ address, receivedAt: new Date(NOW.getTime() - 60_000) }),
      NOW,
    )
    await pass()
    expect(await waiting(chat.chatId, "chat_sin_cliente")).toHaveLength(0)
  })

  it("aprobar con el cliente (y su contacto) liga la conversación; Soporte no lo aprueba", async () => {
    const address = phone()
    const person = await contact(sales, "Marta Ruiz", null)
    const chat = await ingestInboundChat(ownerDb, message({ address }), NOW)
    await pass()
    const [item] = await waiting(chat.chatId, "chat_sin_cliente")
    await expect(
      decide(support, item?.id ?? "", { action: "aprobar", edited: { clientId: sales } }),
    ).rejects.toMatchObject({ status: 404 })
    await expect(decide(admin, item?.id ?? "", { action: "aprobar" })).rejects.toMatchObject({
      status: 400,
    })
    const decision = await decide(admin, item?.id ?? "", {
      action: "aprobar",
      edited: { clientId: sales, contactId: person },
    })
    expect(decision).toMatchObject({
      status: "ejecutada",
      result: { chatId: chat.chatId, clientId: sales, contactId: person },
    })
    const [row] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, chat.chatId))
    expect(row).toMatchObject({ clientId: sales, contactId: person, matchedByUser: admin.userId })
    // Ya tiene cliente: no vuelve como «sin cliente»; ahora es «por responder».
    await pass()
    expect(await waiting(chat.chatId, "chat_sin_cliente")).toHaveLength(0)
    expect(await waiting(chat.chatId, "responder_chat")).toHaveLength(1)
  })
})

describe("responder_chat", () => {
  it("de una clínica con su app lo ve Soporte, también en Hoy; no se aprueba y se cierra al responder", async () => {
    const address = phone()
    const luis = await contact(clinic, "Luis Paredes", null)
    const chat = await ingestInboundChat(ownerDb, message({ address, body: "¿Me ayudan?" }), NOW)
    await ownerDb.transaction((tx) =>
      assignChat(tx, admin, chat.chatId, { clientId: clinic, contactId: luis }, NOW),
    )
    await pass()
    const [item] = await waiting(chat.chatId, "responder_chat")
    expect(item).toMatchObject({
      clientId: clinic,
      adminOnly: false,
      title: "Luis Paredes · Clínica con app (ficticia)",
    })
    expect(item?.payload).toMatchObject({
      chatId: chat.chatId,
      channel: "whatsapp",
      clientId: clinic,
      lastBody: "¿Me ayudan?",
      freeUntil: new Date(NOW.getTime() - HOUR + DAY).toISOString(),
    })
    const listed = await listKairosItems(ownerDb, support, { status: "espera" }, NOW)
    expect(listed.items.some((row) => row.id === item?.id)).toBe(true)
    const today = await todayForStaff(ownerDb, support, { who: "todas" }, NOW)
    expect(today.kairosReady.items.some((row) => row.id === item?.id)).toBe(true)
    // «Responder» abre la conversación: aprobar aquí no hace nada y el ítem sigue.
    await expect(decide(support, item?.id ?? "", { action: "aprobar" })).rejects.toMatchObject({
      code: "KAIROS_ITEM_IN_CHAT",
      status: 409,
    })
    expect(await waiting(chat.chatId, "responder_chat")).toHaveLength(1)
    const reply = await ownerDb.transaction((tx) =>
      prepareChatReply(tx, support, chat.chatId, { body: "Claro, cuéntanos" }, NOW),
    )
    expect(await waiting(chat.chatId, "responder_chat")).toHaveLength(0)
    await pass()
    expect(await waiting(chat.chatId, "responder_chat")).toHaveLength(0)
    // La respuesta no salió: vuelve a pedirla.
    await ownerDb.transaction((tx) =>
      markChatOutreachFailed(tx, reply.outreachId, "rechazado", NOW),
    )
    await pass()
    expect(await waiting(chat.chatId, "responder_chat")).toHaveLength(1)
  })

  it("de un cliente en venta es solo de Administración", async () => {
    const chat = await ingestInboundChat(ownerDb, message({ displayName: "Ana" }), NOW)
    await ownerDb.transaction((tx) => assignChat(tx, admin, chat.chatId, { clientId: sales }, NOW))
    await pass()
    const [item] = await waiting(chat.chatId, "responder_chat")
    expect(item).toMatchObject({ adminOnly: true, title: "Ana · Clínica en venta (ficticia)" })
    const listed = await listKairosItems(ownerDb, support, { status: "espera" }, NOW)
    expect(listed.items.some((row) => row.id === item?.id)).toBe(false)
  })

  it("si la conversación pasa a otra clínica, se retira y sale para la nueva", async () => {
    const chat = await ingestInboundChat(ownerDb, message(), NOW)
    await ownerDb.transaction((tx) => assignChat(tx, admin, chat.chatId, { clientId: sales }, NOW))
    await pass()
    await ownerDb.transaction((tx) => assignChat(tx, admin, chat.chatId, { clientId: clinic }, NOW))
    await pass()
    const open = await waiting(chat.chatId, "responder_chat")
    expect(open).toHaveLength(1)
    expect(open[0]?.clientId).toBe(clinic)
  })
})

describe("posible_carga por WhatsApp", () => {
  it("un Excel que llega en una conversación con cliente es una posible carga, como el del correo", async () => {
    const chat = await ingestInboundChat(ownerDb, message(), NOW)
    await ownerDb.transaction((tx) => assignChat(tx, admin, chat.chatId, { clientId: clinic }, NOW))
    const received = new Date(NOW.getTime() - 26 * DAY)
    const withFile = await ingestInboundChat(
      ownerDb,
      message({
        address: (await ownerDb.select().from(saasChat).where(eq(saasChat.id, chat.chatId)))[0]
          ?.address,
        body: "Les mando los pacientes",
        media: [
          {
            objectKey: inboundAttachmentKey("xlsx"),
            mimeType: XLSX,
            filename: "pacientes.xlsx",
            size: 10,
          },
        ],
        receivedAt: received,
      }),
      NOW,
    )
    expect(withFile.chatId).toBe(chat.chatId)
    await pass()
    const [item] = await itemsOf(chat.chatId, "posible_carga")
    expect(item).toMatchObject({
      status: "espera",
      adminOnly: true,
      clientId: clinic,
      title: "¿Es la carga de datos? pacientes.xlsx",
    })
    expect(item?.payload).toMatchObject({
      source: "whatsapp",
      chatId: chat.chatId,
      inboundMessageId: withFile.messageId,
      inboundEmailId: null,
      urgent: true,
    })
    expect(item?.reason).toMatch(/^Llegó por WhatsApp el /)
    // Vence a los 30 días de llegar, como el del correo.
    expect(item?.expiresAt.getTime()).toBe(received.getTime() + 30 * DAY)
  })

  it("el formato del celular solo agrupa los del Perú", () => {
    expect(chatAddressWords("whatsapp", "+51954220318")).toBe("+51 954 220 318")
    expect(chatAddressWords("whatsapp", "+528112345678")).toBe("+528112345678")
    expect(chatAddressWords("instagram", "1784")).toBe("1784")
  })
})
