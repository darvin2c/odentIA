import {
  saasChat,
  saasClient,
  saasClientContact,
  saasClientFile,
  saasInboundMessage,
  saasOutreach,
} from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { inboundAttachmentKey, markClientFileCarga } from "./admin-client-files.js"
import type { AdminActor } from "./admin-core.js"
import {
  applyChatStatus,
  assignChat,
  chatSuggestion,
  getChat,
  type InboundChatInput,
  ingestInboundChat,
  markChatNotClinic,
  markChatOutreachFailed,
  markChatOutreachSent,
  markChatOutreachUncertain,
  prepareChatReply,
  undoChatNotClinic,
} from "./admin-inbound-chat.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** El WhatsApp de la administración: entra como el correo, nunca se liga solo por el teléfono. */
setupTestDb()
const admin: AdminActor = { userId: "wa-admin", role: "admin" }
const support: AdminActor = { userId: "wa-support", role: "support" }
const ORG = "wa-org"
let sales: string
let clinic: string
let other: string
let clinicContact: string
let salesContact: string

let phoneSeq = 0
/** Un número E.164 distinto por prueba. */
function phone(): string {
  phoneSeq += 1
  return `+5198700${String(phoneSeq).padStart(4, "0")}`
}

function message(overrides: Partial<InboundChatInput> = {}): InboundChatInput {
  return {
    channel: "whatsapp",
    address: "+51987000000",
    waId: "51987000000",
    displayName: "Rosa",
    externalId: `wamid.${crypto.randomUUID()}`,
    body: "Hola, quiero saber de odentIA",
    media: [],
    receivedAt: new Date(Date.now() - 60_000),
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

async function activitiesOfChat(chatId: string) {
  return ownerDb
    .select()
    .from(saasFollowUp)
    .where(eq(saasFollowUp.chatId, chatId))
    .orderBy(saasFollowUp.happenedAt)
}

async function outreachOf(id: string) {
  const [row] = await ownerDb.select().from(saasOutreach).where(eq(saasOutreach.id, id))
  if (!row) throw new Error("sin envío")
  return row
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Lovelace", email: "ada@wa.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@wa.test" },
  ])
  await insertOrg(ownerDb, ORG, "wa-clinica")
  sales = await client("Clínica en venta (ficticia)")
  clinic = await client("Clínica con app (ficticia)", ORG)
  other = await client("Otra clínica (ficticia)")
  clinicContact = await contact(clinic, "Luis Paredes", null)
  salesContact = await contact(sales, "Rosa Quispe", null)
})

describe("ingestInboundChat", () => {
  it("un mensaje repetido entra una sola vez y la conversación es una por número", async () => {
    const address = phone()
    const first = message({ address })
    const a = await ingestInboundChat(ownerDb, first)
    const b = await ingestInboundChat(ownerDb, first)
    const c = await ingestInboundChat(ownerDb, message({ address, body: "¿Siguen ahí?" }))
    expect(a.duplicate).toBe(false)
    expect(b).toEqual({ ...a, duplicate: true })
    expect(c.chatId).toBe(a.chatId)
    expect(c.clientId).toBeNull()
    const rows = await ownerDb
      .select()
      .from(saasInboundMessage)
      .where(eq(saasInboundMessage.chatId, a.chatId))
    expect(rows).toHaveLength(2)
  })

  it("no se liga por el teléfono aunque sea el celular exacto de un contacto", async () => {
    const address = phone()
    await contact(other, "Pepe Celular", address)
    const result = await ingestInboundChat(ownerDb, message({ address }))
    expect(result.clientId).toBeNull()
    expect(await chatSuggestion(ownerDb, address)).toMatchObject({
      clientId: other,
      contactName: "Pepe Celular",
    })
  })

  it("los archivos solo pasan a documentos cuando la conversación tiene cliente", async () => {
    const address = phone()
    const key = inboundAttachmentKey("xlsx")
    const before = await ingestInboundChat(
      ownerDb,
      message({
        address,
        body: null,
        media: [{ objectKey: key, mimeType: "text/csv", filename: "pacientes.xlsx", size: 99 }],
      }),
    )
    const none = await ownerDb
      .select()
      .from(saasClientFile)
      .where(eq(saasClientFile.inboundMessageId, before.messageId))
    expect(none).toHaveLength(0)
    expect(await activitiesOfChat(before.chatId)).toHaveLength(0)

    const assigned = await assignChat(ownerDb, admin, before.chatId, {
      clientId: sales,
      contactId: salesContact,
    })
    expect(assigned.fileIds).toHaveLength(1)
    const [file] = await ownerDb
      .select()
      .from(saasClientFile)
      .where(eq(saasClientFile.inboundMessageId, before.messageId))
    expect(file).toMatchObject({
      clientId: sales,
      kind: "correo",
      source: "whatsapp",
      adminOnly: true,
      deleteAfter: null,
      objectKey: key,
    })
    // El contacto no tenía celular: queda este.
    const [person] = await ownerDb
      .select({ phone: saasClientContact.phone })
      .from(saasClientContact)
      .where(eq(saasClientContact.id, salesContact))
    expect(person?.phone).toBe(address)

    // Ya con cliente, lo que llega se registra al llegar.
    const key2 = inboundAttachmentKey("pdf")
    const after = await ingestInboundChat(
      ownerDb,
      message({
        address,
        body: "Les mando la lista",
        media: [{ objectKey: key2, mimeType: "application/pdf", filename: "lista.pdf", size: 10 }],
      }),
    )
    expect(after.clientId).toBe(sales)
    const files = await ownerDb
      .select()
      .from(saasClientFile)
      .where(eq(saasClientFile.inboundMessageId, after.messageId))
    expect(files).toHaveLength(1)
    const activities = await activitiesOfChat(before.chatId)
    expect(activities.map((row) => [row.kind, row.direction, row.body, row.adminOnly])).toEqual([
      ["whatsapp", "entro", "Mandó 1 archivo", true],
      ["whatsapp", "entro", "Les mando la lista (1 archivo)", true],
    ])
    expect(activities[0]?.contactId).toBe(salesContact)

    // Lo de WhatsApp también puede ser la carga de datos.
    const marked = await markClientFileCarga(ownerDb, admin, file?.id ?? "")
    expect(marked.file).toMatchObject({
      kind: "archivo_clinica",
      inboundMessageId: before.messageId,
    })
  })
})

describe("assignChat", () => {
  it("lo respondido antes de saber de quién era pasa al cliente con su actividad", async () => {
    const address = phone()
    const first = await ingestInboundChat(ownerDb, message({ address }))
    const reply = await prepareChatReply(ownerDb, admin, first.chatId, { body: "¡Hola! Te cuento" })
    expect(reply.clientId).toBeNull()
    expect(reply.body).toBe("¡Hola! Te cuento\n\n— Ada · odentIA")
    await markChatOutreachSent(ownerDb, reply.outreachId, "wamid.salida-1")
    expect(await activitiesOfChat(first.chatId)).toHaveLength(0)

    await expect(
      assignChat(ownerDb, support, first.chatId, { clientId: sales }),
    ).rejects.toMatchObject({ status: 403 })
    await assignChat(ownerDb, admin, first.chatId, { clientId: sales })
    expect(await outreachOf(reply.outreachId)).toMatchObject({
      clientId: sales,
      status: "enviado",
      externalId: "wamid.salida-1",
    })
    const activities = await activitiesOfChat(first.chatId)
    expect(activities.map((row) => [row.direction, row.clientId])).toEqual([
      ["entro", sales],
      ["salio", sales],
    ])
    expect(activities[1]).toMatchObject({ authorUserId: admin.userId, adminOnly: true })
  })

  it("mover a otra clínica mueve actividades, archivos y respuestas, con su auditoría", async () => {
    const address = phone()
    const key = inboundAttachmentKey("csv")
    const first = await ingestInboundChat(
      ownerDb,
      message({
        address,
        media: [{ objectKey: key, mimeType: "text/csv", filename: "agenda.csv", size: 5 }],
      }),
    )
    await assignChat(ownerDb, admin, first.chatId, { clientId: sales, contactId: salesContact })
    const reply = await prepareChatReply(ownerDb, admin, first.chatId, { body: "Recibido" })
    await markChatOutreachSent(ownerDb, reply.outreachId, `wamid.${crypto.randomUUID()}`)

    const moved = await assignChat(ownerDb, admin, first.chatId, { clientId: other })
    expect(moved.movedFrom).toBe(sales)
    expect(moved.fileIds).toHaveLength(1)
    const activities = await activitiesOfChat(first.chatId)
    expect(activities).toHaveLength(2)
    expect(activities.every((row) => row.clientId === other && row.contactId === null)).toBe(true)
    expect(await outreachOf(reply.outreachId)).toMatchObject({ clientId: other, contactId: null })
    const [file] = await ownerDb
      .select({ clientId: saasClientFile.clientId })
      .from(saasClientFile)
      .where(eq(saasClientFile.inboundMessageId, first.messageId))
    expect(file?.clientId).toBe(other)
    const [audit] = await ownerDb
      .select()
      .from(adminAudit)
      .where(and(eq(adminAudit.action, "chat.moved"), eq(adminAudit.entityId, first.chatId)))
    expect(audit?.metadata).toMatchObject({ from: sales, to: other, activities: 2, files: 1 })
    // La entrada no cambia de conversación.
    await expect(
      ownerDb
        .update(saasFollowUp)
        .set({
          chatId: (await ingestInboundChat(ownerDb, message({ address: phone() }))).chatId,
        })
        .where(eq(saasFollowUp.id, activities[0]?.id ?? "")),
    ).rejects.toThrow()
  })

  it("«No es una clínica» se marca, se deshace y no aplica a una con cliente", async () => {
    const address = phone()
    const { chatId } = await ingestInboundChat(ownerDb, message({ address }))
    await expect(markChatNotClinic(ownerDb, support, chatId)).rejects.toMatchObject({
      status: 403,
    })
    const marked = await markChatNotClinic(ownerDb, admin, chatId)
    expect(marked.notClinicAt).toBeInstanceOf(Date)
    // Sus mensajes siguen entrando.
    await ingestInboundChat(ownerDb, message({ address, body: "¿Hola?" }))
    expect((await getChat(ownerDb, admin, chatId)).entries).toHaveLength(2)
    await undoChatNotClinic(ownerDb, admin, chatId)
    const [row] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, chatId))
    expect(row).toMatchObject({ notClinicAt: null, notClinicBy: null })
    const actions = await ownerDb
      .select({ action: adminAudit.action })
      .from(adminAudit)
      .where(eq(adminAudit.entityId, chatId))
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(["chat.not_clinic", "chat.not_clinic_undone"]),
    )
    await assignChat(ownerDb, admin, chatId, { clientId: other })
    await expect(markChatNotClinic(ownerDb, admin, chatId)).rejects.toMatchObject({
      status: 409,
    })
  })
})

describe("getChat y quién la ve", () => {
  it("Soporte no ve una conversación sin cliente ni de venta, y sí la de una clínica con su app", async () => {
    const lonely = await ingestInboundChat(ownerDb, message({ address: phone() }))
    const forSale = await ingestInboundChat(ownerDb, message({ address: phone() }))
    await assignChat(ownerDb, admin, forSale.chatId, { clientId: sales })
    const withApp = await ingestInboundChat(
      ownerDb,
      message({
        address: phone(),
        media: [
          {
            objectKey: inboundAttachmentKey("xlsx"),
            mimeType: "text/csv",
            filename: "pacientes de la clínica.xlsx",
            size: 7,
          },
        ],
      }),
    )
    await assignChat(ownerDb, admin, withApp.chatId, { clientId: clinic, contactId: clinicContact })

    for (const id of [lonely.chatId, forSale.chatId])
      await expect(getChat(ownerDb, support, id)).rejects.toMatchObject({ status: 404 })
    await expect(
      prepareChatReply(ownerDb, support, forSale.chatId, { body: "Hola" }),
    ).rejects.toMatchObject({ status: 404 })

    const seen = await getChat(ownerDb, support, withApp.chatId)
    expect(seen.client).toMatchObject({ id: clinic, hasAccount: true })
    expect(seen.contact).toMatchObject({ id: clinicContact, name: "Luis Paredes" })
    expect(seen.files).toEqual([])
    expect(seen.entries[0]).toMatchObject({ kind: "entro", media: [], mediaCount: 1 })

    // Lo que Administración marca «Solo administración» no le llega a Soporte.
    const hidden = await prepareChatReply(ownerDb, admin, withApp.chatId, {
      body: "Sobre el cobro",
      adminOnly: true,
    })
    const visible = await prepareChatReply(ownerDb, admin, withApp.chatId, { body: "Ya lo vemos" })
    const supportSees = (await getChat(ownerDb, support, withApp.chatId)).entries
      .filter((entry) => entry.kind === "salio")
      .map((entry) => entry.id)
    expect(supportSees).toEqual([visible.outreachId])
    const adminView = await getChat(ownerDb, admin, withApp.chatId)
    expect(adminView.entries.filter((entry) => entry.kind === "salio").map((e) => e.id)).toEqual([
      hidden.outreachId,
      visible.outreachId,
    ])
    expect(adminView.files).toHaveLength(1)
    expect(adminView.canReplyFreely).toBe(true)
  })

  it("sugiere solo cuando un único contacto de un cliente vivo tiene ese número", async () => {
    const one = phone()
    await contact(other, "Única", one)
    const archived = await client("Archivada (ficticia)")
    await ownerDb
      .update(saasClient)
      .set({ archivedAt: new Date() })
      .where(eq(saasClient.id, archived))
    await contact(archived, "En archivada", one)
    expect(await chatSuggestion(ownerDb, one)).toEqual({
      contactId: expect.any(String),
      contactName: "Única",
      clientId: other,
      clientName: "Otra clínica (ficticia)",
    })
    const two = phone()
    await contact(other, "Una", two)
    await contact(sales, "Otra", two)
    expect(await chatSuggestion(ownerDb, two)).toBeNull()
    const { chatId } = await ingestInboundChat(ownerDb, message({ address: two }))
    expect((await getChat(ownerDb, admin, chatId)).suggestion).toBeNull()
  })
})

describe("prepareChatReply y su resultado", () => {
  it("fuera de las 24 h no deja texto libre; sí la plantilla", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60_000)
    const { chatId } = await ingestInboundChat(
      ownerDb,
      message({ address: phone(), receivedAt: old }),
    )
    const view = await getChat(ownerDb, admin, chatId)
    expect(view.canReplyFreely).toBe(false)
    expect(view.freeUntil?.getTime()).toBe(old.getTime() + 24 * 60 * 60_000)
    await expect(prepareChatReply(ownerDb, admin, chatId, { body: "Hola" })).rejects.toMatchObject({
      status: 409,
      code: "CHAT_WINDOW_CLOSED",
      fields: { body: expect.stringContaining("24 horas") },
    })
    const reply = await prepareChatReply(ownerDb, admin, chatId, {
      template: "retomar_conversacion",
    })
    expect(reply).toMatchObject({ template: "retomar_conversacion", templateParams: ["Ada"] })
    await expect(
      prepareChatReply(ownerDb, admin, chatId, { template: "otra_cosa" }),
    ).rejects.toMatchObject({ status: 400, fields: { template: expect.any(String) } })
  })

  it("lo incierto nunca se reintenta y pasa a enviado si Meta avisa después que salió", async () => {
    const { chatId } = await ingestInboundChat(ownerDb, message({ address: phone() }))
    await assignChat(ownerDb, admin, chatId, { clientId: clinic })
    const reply = await prepareChatReply(ownerDb, admin, chatId, { body: "Te escribo" })
    expect((await markChatOutreachUncertain(ownerDb, reply.outreachId)).changed).toBe(true)
    // Repetido no cambia nada; nunca vuelve a pendiente.
    expect(await markChatOutreachUncertain(ownerDb, reply.outreachId)).toMatchObject({
      status: "incierto",
      changed: false,
    })
    expect(await activitiesOfChat(chatId)).toHaveLength(1)
    const late = await applyChatStatus(ownerDb, {
      outreachId: reply.outreachId,
      externalId: "wamid.tarde",
      status: "delivered",
    })
    expect(late).toMatchObject({ status: "enviado", changed: true })
    expect(await outreachOf(reply.outreachId)).toMatchObject({
      status: "enviado",
      externalId: "wamid.tarde",
    })
    const activities = await activitiesOfChat(chatId)
    expect(activities.map((row) => [row.direction, row.adminOnly])).toEqual([
      ["entro", false],
      ["salio", false],
    ])
    // Un «read» después no deja otra actividad.
    expect(
      await applyChatStatus(ownerDb, { externalId: "wamid.tarde", status: "read" }),
    ).toMatchObject({ changed: false })
    expect(await activitiesOfChat(chatId)).toHaveLength(2)
  })

  it("«failed» después de salir no cambia nada; antes, no salió y es final", async () => {
    const { chatId } = await ingestInboundChat(ownerDb, message({ address: phone() }))
    const sent = await prepareChatReply(ownerDb, admin, chatId, { body: "Uno" })
    await markChatOutreachSent(ownerDb, sent.outreachId, "wamid.uno")
    expect(
      await applyChatStatus(ownerDb, { externalId: "wamid.uno", status: "failed" }),
    ).toMatchObject({ status: "enviado", changed: false })

    const pending = await prepareChatReply(ownerDb, admin, chatId, { body: "Dos" })
    expect(
      await applyChatStatus(ownerDb, { outreachId: pending.outreachId, status: "failed" }),
    ).toMatchObject({ status: "no_salio", changed: true })
    expect(
      await applyChatStatus(ownerDb, { outreachId: pending.outreachId, status: "delivered" }),
    ).toMatchObject({ status: "no_salio", changed: false })

    const rejected = await prepareChatReply(ownerDb, admin, chatId, { body: "Tres" })
    expect(
      await markChatOutreachFailed(ownerDb, rejected.outreachId, "131026: no es de WhatsApp"),
    ).toMatchObject({ status: "no_salio", changed: true })
    expect(await applyChatStatus(ownerDb, { externalId: "wamid.nadie", status: "sent" })).toBeNull()
  })
})

describe("Instagram y Messenger", () => {
  it("entran con su id de Meta, sin sugerencia ni plantilla, y su estado lo resuelve una persona", async () => {
    const igsid = "17841400000000001"
    // Aunque el id se parezca a un número, no es un teléfono: no se sugiere a nadie.
    await contact(other, "Con ese número", "+17841400000")
    const key = inboundAttachmentKey("jpg")
    const first = await ingestInboundChat(
      ownerDb,
      message({
        channel: "instagram",
        address: igsid,
        waId: "no-va",
        displayName: "@clinica.sonrisa",
        media: [{ objectKey: key, mimeType: "image/jpeg", filename: "foto.jpg", size: 3 }],
      }),
    )
    const [chat] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, first.chatId))
    expect(chat).toMatchObject({ channel: "instagram", address: igsid, waId: null })
    expect((await getChat(ownerDb, admin, first.chatId)).suggestion).toBeNull()
    // El mismo id en Messenger es otra conversación; un contacto puede tener las dos.
    const messenger = await ingestInboundChat(
      ownerDb,
      message({ channel: "messenger", address: igsid }),
    )
    expect(messenger.chatId).not.toBe(first.chatId)
    await assignChat(ownerDb, admin, first.chatId, { clientId: clinic, contactId: clinicContact })
    await assignChat(ownerDb, admin, messenger.chatId, {
      clientId: clinic,
      contactId: clinicContact,
    })
    const [file] = await ownerDb
      .select({ source: saasClientFile.source })
      .from(saasClientFile)
      .where(eq(saasClientFile.inboundMessageId, first.messageId))
    expect(file?.source).toBe("instagram")
    expect((await activitiesOfChat(first.chatId)).map((row) => row.kind)).toEqual(["instagram"])
    expect((await activitiesOfChat(messenger.chatId)).map((row) => row.kind)).toEqual(["messenger"])

    await expect(
      prepareChatReply(ownerDb, admin, first.chatId, { template: "retomar_conversacion" }),
    ).rejects.toMatchObject({ status: 400, fields: { template: expect.any(String) } })
    const reply = await prepareChatReply(ownerDb, admin, first.chatId, { body: "¡Gracias!" })
    expect((await outreachOf(reply.outreachId)).channel).toBe("instagram")
    await markChatOutreachUncertain(ownerDb, reply.outreachId)
    expect(
      await applyChatStatus(ownerDb, { outreachId: reply.outreachId, status: "delivered" }),
    ).toBeNull()
    expect((await outreachOf(reply.outreachId)).status).toBe("incierto")

    await expect(
      ingestInboundChat(ownerDb, message({ channel: "whatsapp", address: igsid })),
    ).rejects.toMatchObject({ status: 400, fields: { address: expect.any(String) } })
  })

  it("fuera de las 24 h dice que escriba un correo o por WhatsApp", async () => {
    const { chatId } = await ingestInboundChat(
      ownerDb,
      message({
        channel: "messenger",
        address: "PSID-9000001",
        receivedAt: new Date(Date.now() - 25 * 60 * 60_000),
      }),
    )
    await expect(prepareChatReply(ownerDb, admin, chatId, { body: "Hola" })).rejects.toMatchObject({
      status: 409,
      fields: { body: expect.stringContaining("Messenger ya no deja responderle") },
    })
  })
})
