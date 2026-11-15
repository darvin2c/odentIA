import {
  saasChat,
  saasClient,
  saasClientContact,
  saasClientFile,
  saasInboundMessage,
  saasOutreach,
  saasProposal,
} from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { inboundAttachmentKey, markClientFileCarga } from "./admin-client-files.js"
import { clientTimeline } from "./admin-clients.js"
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
  openChatForContact,
  prepareChatMessage,
  prepareChatReply,
  undoChatNotClinic,
} from "./admin-inbound-chat.js"
import { resolveOutreach } from "./admin-sales.js"
import { createSaasPlan } from "./saas-billing.js"
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

    // El Historial abre la conversación desde lo que entró y lo que salió, también desde
    // una respuesta incierta que una persona marcó «Salió».
    const unsure = await prepareChatReply(ownerDb, admin, first.chatId, { body: "¿Seguimos?" })
    await markChatOutreachUncertain(ownerDb, unsure.outreachId)
    await resolveOutreach(ownerDb, admin, unsure.outreachId, "salio")
    const timeline = await clientTimeline(ownerDb, admin, sales)
    const chatRows = timeline.items.filter(
      (entry) => entry.link?.kind === "chat" && entry.link.id === first.chatId,
    )
    expect(chatRows.map((entry) => entry.title).sort()).toEqual([
      "Le escribimos por WhatsApp",
      "Le escribimos por WhatsApp",
      "Nos escribió por WhatsApp",
    ])
    // Lo que entró lo escribió quien escribe (sin contacto, el nombre que dio Meta), no un autor perdido.
    expect(chatRows.find((entry) => entry.title === "Nos escribió por WhatsApp")?.who).toEqual({
      kind: "clinica",
      name: "Rosa",
    })
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
    const appAddress = phone()
    const withApp = await ingestInboundChat(
      ownerDb,
      message({
        address: appAddress,
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
    // Lo que llegó antes de decir de quién era quedó de la venta; lo que llega ahora lo ve Soporte.
    const afterAssign = await ingestInboundChat(
      ownerDb,
      message({
        address: appAddress,
        media: [
          {
            objectKey: inboundAttachmentKey("csv"),
            mimeType: "text/csv",
            filename: "agenda.csv",
            size: 3,
          },
        ],
      }),
    )

    for (const id of [lonely.chatId, forSale.chatId])
      await expect(getChat(ownerDb, support, id)).rejects.toMatchObject({ status: 404 })
    await expect(
      prepareChatReply(ownerDb, support, forSale.chatId, { body: "Hola" }),
    ).rejects.toMatchObject({ status: 404 })

    const seen = await getChat(ownerDb, support, withApp.chatId)
    expect(seen.client).toMatchObject({ id: clinic, hasAccount: true })
    expect(seen.contact).toMatchObject({ id: clinicContact, name: "Luis Paredes" })
    expect(seen.files).toEqual([])
    expect(seen.entries[0]).toMatchObject({
      kind: "entro",
      id: afterAssign.messageId,
      media: [],
      mediaCount: 1,
    })

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
    expect(adminView.files).toHaveLength(2)
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
    // Lo que entró antes de saber de quién era es de la venta; la respuesta ya en la clínica con app, no.
    expect(activities.map((row) => [row.direction, row.adminOnly])).toEqual([
      ["entro", true],
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

describe("prepareChatMessage: escribirle primero a una persona del cliente", () => {
  it("dentro de las 24 h, el texto con su propuesta; al salir, la propuesta queda enviada", async () => {
    const number = phone()
    const target = await client("Clínica con propuesta (ficticia)")
    const person = await contact(target, "Rosa Quispe", number)
    const plan = await createSaasPlan(ownerDb, admin.userId, {
      code: "wa-plan",
      name: "Plan WA",
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationMicros: 500_000,
      consultationMicros: 400_000,
      recoveryMicros: 4_000_000,
      trialCreditCents: 10_000,
      trialMaxCreditCents: 10_000,
      trialDays: 30,
      showOnWeb: false,
    })
    const [proposal] = await ownerDb
      .insert(saasProposal)
      .values({
        clientId: target,
        version: 1,
        planId: plan.id,
        listPriceCents: 2900,
        currency: "USD",
        validUntil: "2099-12-31",
      })
      .returning({ id: saasProposal.id })
    if (!proposal) throw new Error("sin propuesta")
    const wrote = await ingestInboundChat(
      ownerDb,
      message({ address: number, waId: number.slice(1) }),
    )
    // Ya escribió sin decir de quién es: el celular no la liga; primero se dice en Hoy.
    await expect(
      prepareChatMessage(ownerDb, admin, target, { contactId: person, body: "Hola" }),
    ).rejects.toMatchObject({ code: "CHAT_UNASSIGNED", fields: { chatId: wrote.chatId } })
    await assignChat(ownerDb, admin, wrote.chatId, { clientId: target, contactId: person })
    // Una propuesta que no es de este cliente no va.
    await expect(
      prepareChatMessage(ownerDb, admin, target, {
        contactId: person,
        body: "Hola",
        proposalId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ fields: { proposalId: expect.any(String) } })
    const reply = await prepareChatMessage(ownerDb, admin, target, {
      contactId: person,
      body: "Le preparé la propuesta",
      proposalId: proposal.id,
    })
    expect(reply).toMatchObject({ template: null, clientId: target, to: number })
    expect(await outreachOf(reply.outreachId)).toMatchObject({
      chatId: reply.chatId,
      proposalId: proposal.id,
      status: "pendiente",
    })
    await markChatOutreachSent(ownerDb, reply.outreachId, `wamid.${crypto.randomUUID()}`)
    const [after] = await ownerDb
      .select()
      .from(saasProposal)
      .where(eq(saasProposal.id, proposal.id))
    expect(after?.status).toBe("enviada")
    const activities = await activitiesOfChat(reply.chatId)
    expect(activities.at(-1)).toMatchObject({ direction: "salio", proposalId: proposal.id })
  })

  it("si nunca escribió, la plantilla para retomar, sin la propuesta; Soporte no lo hace en una venta", async () => {
    const number = phone()
    const target = await client("Clínica que nunca escribió (ficticia)")
    const person = await contact(target, "Ana Ruiz", number)
    const reply = await prepareChatMessage(ownerDb, admin, target, {
      contactId: person,
      body: "Hola Ana",
    })
    expect(reply).toMatchObject({ template: "retomar_conversacion", templateParams: ["Ada"] })
    expect(await outreachOf(reply.outreachId)).toMatchObject({
      template: "retomar_conversacion",
      proposalId: null,
    })
    await expect(
      prepareChatMessage(ownerDb, support, target, { contactId: person, body: "Hola" }),
    ).rejects.toMatchObject({ code: "CHAT_ADMIN_ONLY", status: 409 })
  })
})

describe("lo que la revisión encontró", () => {
  it("ligar un Instagram o un Messenger no pone su id como celular de la persona", async () => {
    const person = await contact(other, "Sin celular (ficticia)", null)
    for (const channel of ["instagram", "messenger"] as const) {
      const { chatId } = await ingestInboundChat(
        ownerDb,
        message({ channel, address: `${channel}-${crypto.randomUUID().slice(0, 8)}` }),
      )
      await assignChat(ownerDb, admin, chatId, { clientId: other, contactId: person })
    }
    const [row] = await ownerDb
      .select({ phone: saasClientContact.phone })
      .from(saasClientContact)
      .where(eq(saasClientContact.id, person))
    expect(row?.phone).toBeNull()
    // En WhatsApp sí: el celular es el de la conversación.
    const address = phone()
    const { chatId } = await ingestInboundChat(ownerDb, message({ address }))
    await assignChat(ownerDb, admin, chatId, { clientId: other, contactId: person })
    const [after] = await ownerDb
      .select({ phone: saasClientContact.phone })
      .from(saasClientContact)
      .where(eq(saasClientContact.id, person))
    expect(after?.phone).toBe(address)
  })

  it("el celular nunca liga: si ya escribió sin decir de quién es, 409 con la conversación", async () => {
    const address = phone()
    const target = await client("Clínica del celular (ficticia)")
    const person = await contact(target, "Rosa Celular", address)
    const { chatId } = await ingestInboundChat(ownerDb, message({ address }))
    for (const actor of [admin, support]) {
      const opened = ownerDb.transaction((tx) =>
        prepareChatMessage(tx, actor, target, { contactId: person, body: "Hola" }),
      )
      if (actor === support) {
        await expect(opened).rejects.toMatchObject({ code: "CHAT_ADMIN_ONLY", status: 409 })
        continue
      }
      await expect(opened).rejects.toMatchObject({
        code: "CHAT_UNASSIGNED",
        status: 409,
        message: "Ese celular ya nos escribió y falta decir de quién es. Dilo primero en Hoy.",
        fields: { chatId },
      })
    }
    // «No es una clínica» tampoco se deshace solo por el celular.
    await markChatNotClinic(ownerDb, admin, chatId)
    await expect(
      ownerDb.transaction((tx) =>
        prepareChatMessage(tx, admin, target, { contactId: person, body: "Hola" }),
      ),
    ).rejects.toMatchObject({ code: "CHAT_UNASSIGNED", fields: { chatId } })
    const [row] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, chatId))
    expect(row).toMatchObject({ clientId: null, notClinicAt: expect.any(Date) })
    expect(
      await ownerDb.select().from(saasOutreach).where(eq(saasOutreach.chatId, chatId)),
    ).toHaveLength(0)
  })

  it("lo que llegó o salió antes de ser de una clínica con app no lo ve Soporte después", async () => {
    const address = phone()
    const before = await ingestInboundChat(ownerDb, message({ address, body: "Precio, por favor" }))
    const sale = await prepareChatReply(ownerDb, admin, before.chatId, { body: "Son 29 dólares" })
    expect((await outreachOf(sale.outreachId)).adminOnly).toBe(true)
    await assignChat(ownerDb, admin, before.chatId, { clientId: clinic })
    const after = await ingestInboundChat(ownerDb, message({ address, body: "Ya tengo la app" }))
    const visible = await prepareChatReply(ownerDb, admin, before.chatId, { body: "¡Genial!" })
    expect((await outreachOf(visible.outreachId)).adminOnly).toBe(false)
    const seen = await getChat(ownerDb, support, before.chatId)
    expect(seen.entries.map((entry) => entry.id)).toEqual([after.messageId, visible.outreachId])
    const [message0] = await ownerDb
      .select({ adminOnly: saasInboundMessage.adminOnly })
      .from(saasInboundMessage)
      .where(eq(saasInboundMessage.id, before.messageId))
    expect(message0?.adminOnly).toBe(true)
    // La actividad de lo que llegó antes también es solo de Administración.
    const activities = await activitiesOfChat(before.chatId)
    expect(activities.find((row) => row.direction === "entro")?.adminOnly).toBe(true)
  })

  it("al pasar a un cliente sin app, sus mensajes, respuestas y actividades suben a solo Administración", async () => {
    const address = phone()
    const person = await contact(clinic, "Luis Mover (ficticio)", address)
    const opened = await openChatForContact(ownerDb, admin, {
      clientId: clinic,
      contactId: person,
      channel: "whatsapp",
    })
    const inbound = await ingestInboundChat(ownerDb, message({ address }))
    const reply = await prepareChatReply(ownerDb, admin, opened.chatId, { body: "Hola" })
    await markChatOutreachSent(ownerDb, reply.outreachId, `wamid.${crypto.randomUUID()}`)
    expect((await getChat(ownerDb, support, opened.chatId)).entries).toHaveLength(2)
    await assignChat(ownerDb, admin, opened.chatId, { clientId: sales })
    const [row] = await ownerDb
      .select({ adminOnly: saasInboundMessage.adminOnly })
      .from(saasInboundMessage)
      .where(eq(saasInboundMessage.id, inbound.messageId))
    expect(row?.adminOnly).toBe(true)
    expect((await outreachOf(reply.outreachId)).adminOnly).toBe(true)
    expect((await activitiesOfChat(opened.chatId)).every((entry) => entry.adminOnly)).toBe(true)
    await expect(getChat(ownerDb, support, opened.chatId)).rejects.toMatchObject({ status: 404 })
    // Volver a una clínica con app no lo baja.
    await assignChat(ownerDb, admin, opened.chatId, { clientId: clinic })
    expect((await getChat(ownerDb, support, opened.chatId)).entries).toHaveLength(0)
  })

  it("«¿Salió?» no se resuelve en un envío pendiente de menos de 10 minutos", async () => {
    const { chatId } = await ingestInboundChat(ownerDb, message({ address: phone() }))
    const now = new Date()
    const reply = await prepareChatReply(ownerDb, admin, chatId, { body: "Hola" }, now)
    await expect(
      resolveOutreach(ownerDb, admin, reply.outreachId, "salio", new Date(now.getTime() + 60_000)),
    ).rejects.toMatchObject({ code: "OUTREACH_IN_FLIGHT", status: 409 })
    const settled = await resolveOutreach(
      ownerDb,
      admin,
      reply.outreachId,
      "no_salio",
      new Date(now.getTime() + 11 * 60_000),
    )
    expect(settled.status).toBe("no_salio")
  })
})
