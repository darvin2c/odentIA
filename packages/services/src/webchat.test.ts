import { randomUUID } from "node:crypto"
import { buildWebchatInbound, createWebchatToken, webChatAdapter } from "@odentia/channels"
import { type Db, withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import {
  agentConfig,
  channelConnection,
  channelTemplate,
  contact,
  conversation,
  message,
} from "@odentia/db/schema/crm"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, asc, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { createHandoff } from "./agent-operations.js"
import { type IngestDeps, ingestInbound } from "./conversations.js"
import { listPeople } from "./people.js"
import { countConversationAction } from "./saas-actions.js"
import type { Storage } from "./storage.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { sendTeamReply } from "./topic-reply.js"
import {
  admitWebchatSite,
  decideWebchatSite,
  deleteWebchatTest,
  findClinicWebchat,
  getClinicWebchat,
  openWebchatTest,
  pollWebchatVisitor,
  purgeOldWebchatTests,
  readVisitorSession,
  rotateClinicWebchatSecret,
  saveWebchatVisitorContact,
  webchatFrameAncestors,
} from "./webchat.js"

/**
 * El chat web de la clínica (fase 6 del pulido de la Bandeja): uno por
 * clínica, los sitios donde responde, lo que recibe el visitante, «¿Dónde te
 * avisamos?» (R4) y la prueba que no se cobra ni cuenta.
 */
setupTestDb()

const KEY = Buffer.alloc(32, 7)
const unused = async () => {
  throw new Error("no usado")
}
const storage: Storage = {
  putAvatar: unused,
  deleteByUrl: async () => {},
  putAttachment: unused,
  attachmentUrl: unused,
  deleteAttachment: async () => {},
  putPatientDocument: unused,
  putPatientAvatar: unused,
}
const deps: IngestDeps = { storage, fetch, secretsKey: KEY }

async function clinic() {
  const orgId = randomUUID()
  const slug = `chat-${orgId.slice(0, 8)}`
  await insertOrg(ownerDb, orgId, slug)
  await ownerDb.insert(agentConfig).values({ organizationId: orgId, enabled: true })
  const ownerId = `owner-${orgId}`
  const receptionId = `recep-${orgId}`
  await ownerDb.insert(user).values([
    { id: ownerId, name: "Dueña", email: `${ownerId}@chat.test`, emailVerified: true },
    {
      id: receptionId,
      name: "Rita de Recepción",
      email: `${receptionId}@chat.test`,
      emailVerified: true,
    },
  ])
  await ownerDb.insert(member).values([
    {
      id: `m-${ownerId}`,
      userId: ownerId,
      organizationId: orgId,
      role: "owner",
      createdAt: new Date(),
    },
    {
      id: `m-${receptionId}`,
      userId: receptionId,
      organizationId: orgId,
      role: "reception",
      createdAt: new Date(),
    },
  ])
  const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const chat = await run((tx) => getClinicWebchat(tx, orgId, KEY, ownerId))
  /** Lo que escribe el visitante, por la misma ingesta de todos los canales. */
  const visitorSays = (sessionId: string, text: string) =>
    run((tx) =>
      ingestInbound(
        tx,
        {
          orgId,
          connectionId: chat.id,
          event: buildWebchatInbound(sessionId, {
            clientMessageId: randomUUID().replace(/-/g, ""),
            text,
          }),
        },
        webChatAdapter,
        deps,
      ),
    )
  return { orgId, slug, ownerId, receptionId, chat, run, visitorSays }
}

describe("un solo chat por clínica y los sitios donde responde (decisiones 7 y 8)", () => {
  it("el primer sitio se registra solo; otro espera el sí de quien administra y el navegador solo deja los permitidos", async () => {
    const c = await clinic()
    // Abrir la página otra vez no crea otro chat.
    expect((await c.run((tx) => getClinicWebchat(tx, c.orgId, KEY, c.ownerId))).id).toBe(c.chat.id)
    expect(await c.run((tx) => webchatFrameAncestors(tx, c.orgId, c.chat.id))).toBeNull()
    expect(
      await c.run((tx) => admitWebchatSite(tx, c.orgId, c.chat.id, "https://Sonrisa.pe/contacto")),
    ).toEqual({ origin: "https://sonrisa.pe", status: "permitido" })
    expect(
      await c.run((tx) => admitWebchatSite(tx, c.orgId, c.chat.id, "https://promo-dental.net")),
    ).toEqual({ origin: "https://promo-dental.net", status: "pendiente" })
    expect(
      await c.run((tx) => admitWebchatSite(tx, c.orgId, c.chat.id, "javascript:alert(1)")),
    ).toBeNull()
    const notices = await ownerDb
      .select()
      .from(workspaceNotification)
      .where(eq(workspaceNotification.organizationId, c.orgId))
    expect(notices.map((row) => [row.userId, row.title])).toEqual([
      [c.ownerId, "El chat de tu sitio apareció en promo-dental.net"],
    ])
    expect(await c.run((tx) => webchatFrameAncestors(tx, c.orgId, c.chat.id))).toEqual([
      "https://sonrisa.pe",
    ])
    const view = await c.run((tx) => getClinicWebchat(tx, c.orgId, KEY, c.ownerId))
    expect(view).toMatchObject({
      active: true,
      installedOn: "https://sonrisa.pe",
      sites: [
        { first: true, status: "permitido" },
        { first: false, status: "pendiente" },
      ],
    })
    const pending = view.sites[1]!
    const allowed = await c.run((tx) =>
      decideWebchatSite(tx, c.orgId, KEY, c.ownerId, pending.id, "permitido"),
    )
    expect(allowed.sites[1]).toMatchObject({ status: "permitido", decidedByName: "Dueña" })
    expect(await c.run((tx) => webchatFrameAncestors(tx, c.orgId, c.chat.id))).toEqual([
      "https://sonrisa.pe",
      "https://promo-dental.net",
    ])
  })
})

describe("lo que ve el visitante", () => {
  it("su conversación sin nada interno, «escribiendo…» y, con un tema, dónde avisarle (R4)", async () => {
    const c = await clinic()
    const found = (await findClinicWebchat(ownerDb, KEY, c.slug))!
    const sessionId = `webchat:${randomUUID()}`
    const asked = await c.visitorSays(sessionId, "¿Hacen ortodoncia invisible?")
    const [thread] = await ownerDb
      .select()
      .from(conversation)
      .where(eq(conversation.id, asked.conversationId))
    const [person] = await ownerDb.select().from(contact).where(eq(contact.id, thread!.contactId))
    // Sin pedirle el nombre (decisión 9).
    expect(person?.displayName).toBe("Visitante del chat web")
    let poll = await c.run((tx) => pollWebchatVisitor(tx, c.orgId, found.connection.id, sessionId))
    expect(poll).toMatchObject({ typing: true, askContact: false, contact: null })
    expect(poll.messages).toEqual([
      {
        key: expect.any(String),
        from: "visitante",
        author: null,
        text: "¿Hacen ortodoncia invisible?",
        at: expect.any(String),
      },
    ])
    // La respuesta del equipo: firmada como la clínica, nunca con quién escribió por dentro.
    await ownerDb.insert(message).values({
      organizationId: c.orgId,
      conversationId: asked.conversationId,
      direction: "out",
      senderKind: "user",
      senderUserId: c.receptionId,
      body: "Sí, la hacemos.",
      status: "sent",
      error: null,
      externalId: "webchat:local:1",
    })
    await c.run((tx) =>
      createHandoff(tx, c.orgId, null, {
        conversationId: asked.conversationId,
        reason: "Precio",
        summary: "Precio",
        createdBy: "agent",
        kind: "precio",
      }),
    )
    poll = await c.run((tx) => pollWebchatVisitor(tx, c.orgId, found.connection.id, sessionId))
    expect(poll.messages.at(-1)).toEqual({
      key: expect.stringMatching(/^c[0-9a-f]{12}$/),
      from: "clinica",
      author: expect.stringContaining("Clínica"),
      text: "Sí, la hacemos.",
      at: expect.any(String),
    })
    expect(JSON.stringify(poll)).not.toContain(c.receptionId)
    expect(poll).toMatchObject({ typing: false, askContact: true })
    // Lo que recibió pasa a entregado.
    const [delivered] = await ownerDb
      .select({ status: message.status })
      .from(message)
      .where(eq(message.externalId, "webchat:local:1"))
    expect(delivered?.status).toBe("delivered")
    // «¿Dónde te avisamos?»: su WhatsApp con el código del país de la clínica.
    await expect(
      c.run((tx) => saveWebchatVisitorContact(tx, c.orgId, found.connection.id, sessionId, {})),
    ).rejects.toThrow("Escribe tu WhatsApp o tu correo.")
    await expect(
      c.run((tx) =>
        saveWebchatVisitorContact(tx, c.orgId, found.connection.id, sessionId, {
          email: "sin-arroba",
        }),
      ),
    ).rejects.toThrow("Revisa tu correo")
    expect(
      await c.run((tx) =>
        saveWebchatVisitorContact(tx, c.orgId, found.connection.id, sessionId, {
          whatsapp: "987 654 321",
        }),
      ),
    ).toEqual({ whatsapp: "•••• 4321", email: null })
    const [saved] = await ownerDb
      .select({ phone: contact.phone })
      .from(contact)
      .where(eq(contact.id, thread!.contactId))
    expect(saved?.phone).toBe("+51987654321")
    poll = await c.run((tx) => pollWebchatVisitor(tx, c.orgId, found.connection.id, sessionId))
    expect(poll).toMatchObject({ askContact: false, contact: { whatsapp: "•••• 4321" } })
  })

  it("«Generar un código nuevo» no deja a nadie sin su conversación: la clave anterior vale y se renueva", async () => {
    const c = await clinic()
    const before = (await findClinicWebchat(ownerDb, KEY, c.slug))!
    const sessionId = `webchat:${randomUUID()}`
    const token = createWebchatToken(before.connection.webhookSecret, sessionId)
    await c.run((tx) => rotateClinicWebchatSecret(tx, c.orgId, KEY, c.ownerId))
    const after = (await findClinicWebchat(ownerDb, KEY, c.slug))!
    const read = readVisitorSession(after, token)
    expect(read).toMatchObject({ sessionId, renewed: expect.any(String) })
    expect(readVisitorSession(after, read!.renewed!)).toEqual({ sessionId, renewed: null })
  })

  it("la respuesta del equipo a un tema sale también por el WhatsApp que dejó, por entregar y con «Ver respuesta»", async () => {
    const c = await clinic()
    const [whatsapp] = await ownerDb
      .insert(channelConnection)
      .values({
        organizationId: c.orgId,
        channel: "whatsapp",
        provider: "whatsapp_cloud_api",
        displayName: "WA",
        configEncrypted: "x",
        webhookSecret: "s",
        status: "active",
      })
      .returning()
    await ownerDb.insert(channelTemplate).values({
      organizationId: c.orgId,
      connectionId: whatsapp!.id,
      name: "odentia_ver_respuesta_v1",
      language: "es",
      status: "aprobada",
      category: "utility",
      body: "Hola, {{1}}. {{2}} respondió tu consulta.",
      variables: 2,
    })
    const sessionId = `webchat:${randomUUID()}`
    const asked = await c.visitorSays(sessionId, "¿Cuánto cuesta el blanqueamiento?")
    const askedMessage = asked.messageId
    await c.run((tx) =>
      createHandoff(tx, c.orgId, null, {
        conversationId: asked.conversationId,
        reason: "Precio",
        summary: "Precio",
        createdBy: "agent",
        kind: "precio",
      }),
    )
    await c.run((tx) =>
      saveWebchatVisitorContact(tx, c.orgId, c.chat.id, sessionId, { whatsapp: "+51 912 345 678" }),
    )
    await c.run((tx) =>
      sendTeamReply(tx, c.orgId, {
        conversationId: asked.conversationId,
        userId: c.receptionId,
        content: { type: "text", text: "Está en S/ 350." },
        replyToMessageId: askedMessage,
      }),
    )
    const [thread] = await ownerDb
      .select()
      .from(conversation)
      .where(
        and(
          eq(conversation.organizationId, c.orgId),
          eq(conversation.channelConnectionId, whatsapp!.id),
        ),
      )
    const sent = await ownerDb
      .select()
      .from(message)
      .where(eq(message.conversationId, thread!.id))
      .orderBy(asc(message.createdAt))
    expect(sent.map((row) => [row.contentType, row.status, row.body?.slice(0, 15)])).toEqual([
      ["text", "held", "Está en S/ 350."],
      ["template", "queued", expect.stringContaining("Hola")],
    ])
  })
})

describe("la prueba de Configuración no se cobra ni cuenta", () => {
  it("nace marcada, no se cobra, no sale en Pacientes, se borra con «Borrar esta prueba» y sola a los 7 días", async () => {
    const c = await clinic()
    // Funciona aunque el chat esté desactivado.
    await ownerDb
      .update(channelConnection)
      .set({ status: "disabled" })
      .where(eq(channelConnection.id, c.chat.id))
    const { sessionId } = await c.run((tx) => openWebchatTest(tx, c.orgId, KEY, c.ownerId))
    expect(sessionId.startsWith("webchat:prueba:")).toBe(true)
    const said = await c.visitorSays(sessionId, "Hola, es una prueba")
    const [thread] = await ownerDb
      .select()
      .from(conversation)
      .where(eq(conversation.id, said.conversationId))
    expect(thread?.isTest).toBe(true)
    expect(
      await c.run((tx) =>
        countConversationAction(tx, c.orgId, {
          conversationId: said.conversationId,
          at: new Date(),
        }),
      ),
    ).toBe(false)
    const people = await c.run((tx) => listPeople(tx, c.orgId, { view: "todos" }, () => true))
    expect(people.items.some((item) => item.id === thread!.contactId)).toBe(false)
    expect(await c.run((tx) => deleteWebchatTest(tx, c.orgId, { sessionId }))).toBe(true)
    expect(
      await ownerDb.select().from(conversation).where(eq(conversation.id, said.conversationId)),
    ).toEqual([])
    expect(await ownerDb.select().from(contact).where(eq(contact.id, thread!.contactId))).toEqual(
      [],
    )
    // Desactivado, un visitante de verdad no escribe; activado, su conversación no se borra por aquí.
    await expect(c.visitorSays(`webchat:${randomUUID()}`, "Hola")).rejects.toMatchObject({
      code: "CONNECTION_DISABLED",
    })
    await ownerDb
      .update(channelConnection)
      .set({ status: "active" })
      .where(eq(channelConnection.id, c.chat.id))
    const real = await c.visitorSays(`webchat:${randomUUID()}`, "Hola")
    await expect(
      c.run((tx) => deleteWebchatTest(tx, c.orgId, { conversationId: real.conversationId })),
    ).rejects.toMatchObject({ code: "NOT_A_TEST" })
    // A los 7 días se borra sola.
    const old = await c.visitorSays(
      (await c.run((tx) => openWebchatTest(tx, c.orgId, KEY, c.ownerId))).sessionId,
      "Otra prueba",
    )
    expect(
      await c.run((tx) => purgeOldWebchatTests(tx, c.orgId, new Date(Date.now() + 6 * 86_400_000))),
    ).toBe(0)
    expect(
      await c.run((tx) => purgeOldWebchatTests(tx, c.orgId, new Date(Date.now() + 8 * 86_400_000))),
    ).toBe(1)
    expect(
      await ownerDb.select().from(conversation).where(eq(conversation.id, old.conversationId)),
    ).toEqual([])
  })
})
