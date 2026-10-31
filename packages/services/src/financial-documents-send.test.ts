/**
 * Enviar un documento al paciente: el ticket sale por correo con su PDF, queda
 * en la conversación de la persona y repetir el envío no lo duplica. El
 * proveedor no participa aquí: el mensaje queda encolado para el worker, así
 * que esto acredita lo que hace odentIA, no la entrega real del correo.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { channelConnection, contact, contactIdentity, conversation, message } from "@odentia/db/schema/crm"
import { patientContact } from "@odentia/db/schema/clinical"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { livePersonalLinkToken } from "./booking-links.js"
import { createBudget, deliverBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createContact, updateContact } from "./contacts.js"
import { addPlanItem } from "./plan.js"
import { getRefundReceiptPdf } from "./financial-document-pdf.js"
import { getDocumentSendOptions, saveRecipientEmail, sendFinancialDocument, sendReceiptInConversation } from "./financial-documents.js"
import { grantResponsibility } from "./responsibilities.js"
import { collectCharge, createCharge, getAccountSummary, refundCredit } from "./payments.js"
import { createPaymentMethod } from "./payment-methods.js"
import type { Storage } from "./storage.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
import { setTestPatientIdentity } from "./test-patient.js"
setupTestDb()

function capturingStorage() {
  const stored: Array<{ contentType: string; bytes: Uint8Array }> = []
  const storage: Storage = {
    putAvatar: async () => {
      throw new Error("no usado")
    },
    deleteByUrl: async () => {},
    putAttachment: async ({ orgId, conversationId, bytes, contentType }) => {
      stored.push({ contentType, bytes })
      return {
        objectKey: `${orgId}/${conversationId}/${stored.length}.pdf`,
        mimeType: contentType,
        filename: "adjunto.pdf",
        size: bytes.byteLength,
      }
    },
    attachmentUrl: async (key) => `https://signed.example.com/${key}`,
    deleteAttachment: async () => {},
    putPatientDocument: async () => {
      throw new Error("no usado")
    },
    putPatientAvatar: async () => {
      throw new Error("no usado")
    },
  }
  return { storage, stored }
}

async function paidTicket() {
  const f = await clinicalFixture()
  const run = f.run as <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
  // La persona del paciente, con correo.
  await setTestPatientIdentity(ownerDb, f.patient.id, { email: `paciente-${randomUUID()}@example.com` })
  const [self] = await ownerDb.select().from(contact).where(eq(contact.id, f.patient.personId))
  const [sede] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede envío ${randomUUID()}` })
    .returning()
  const cash = await run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  await run((tx) =>
    createCharge(tx, ...f.args, { description: "Profilaxis", amountCents: 12000, currency: "PEN", branchId: sede!.id }),
  )
  const paid = await run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId: sede!.id,
      payments: [{ paymentMethodId: cash.id, amountCents: 12000 }],
      requestId: randomUUID(),
    }),
  )
  return { f, run, selfId: self!.id, ticket: paid.ticket }
}

async function connectEmail(): Promise<string> {
  const [conn] = await ownerDb
    .insert(channelConnection)
    .values({
      organizationId: "org_a",
      channel: "email",
      provider: "gmail",
      displayName: "Correo de la clínica",
      externalId: `clinica-${randomUUID()}@example.com`,
      configEncrypted: "prueba",
      webhookSecret: "prueba",
      status: "active",
    })
    .returning()
  return conn!.id
}

it("el presupuesto entregado sale con su enlace para responder; a una dirección escrita a mano, sin él", async () => {
  const f = await clinicalFixture()
  const run = f.run as <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
  const secretsKey = Buffer.alloc(32, 9)
  await setTestPatientIdentity(ownerDb, f.patient.id, { email: `paciente-${randomUUID()}@example.com` })
  const item = await run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await run((tx) => deliverBudget(tx, ...f.args, budget.id))
  const connectionId = await connectEmail()
  const { storage } = capturingStorage()
  const contactId = f.patient.personId
  const link = () =>
    run((tx) => livePersonalLinkToken(tx, "org_a", { contactId, patientId: f.patient.id }, { secretsKey }))
  const send = (extra: { otherEmail?: string; confirmOtherEmail?: boolean }) =>
    run((tx) =>
      sendFinancialDocument(
        tx,
        "org_a",
        f.actor,
        "admin",
        {
          patientId: f.patient.id,
          documentType: "budget",
          documentId: budget.id,
          recipientContactId: contactId,
          connectionId,
          ...extra,
        },
        { storage, secretsKey },
      ),
    )

  await send({ otherEmail: "otra@example.com", confirmOtherEmail: true })
  expect(await link()).toBeNull()

  await send({})
  expect(await link()).toBeTruthy()
})

it("el ticket se envía por correo con su PDF, queda en la conversación de la persona y no se duplica", async () => {
  const { f, run, selfId, ticket } = await paidTicket()
  const connectionId = await connectEmail()
  const { storage, stored } = capturingStorage()

  // Con correo en la ficha y un buzón conectado, se propone el correo.
  const options = await run((tx) =>
    getDocumentSendOptions(tx, "org_a", f.patient.id, { documentType: "ticket", documentId: ticket.id }),
  )
  expect(options.recipient.contactId).toBe(selfId)
  expect(options.proposed?.channel).toBe("email")

  const requestId = randomUUID()
  const send = () =>
    run((tx) =>
      sendFinancialDocument(
        tx,
        "org_a",
        f.actor,
        "cashier",
        {
          patientId: f.patient.id,
          documentType: "ticket",
          documentId: ticket.id,
          recipientContactId: selfId,
          connectionId,
          requestId,
        },
        { storage },
      ),
    )
  const sent = await send()
  expect(sent).toMatchObject({ status: "queued", channel: "email" })

  // El adjunto es el PDF del ticket.
  expect(stored).toHaveLength(1)
  expect(stored[0]!.contentType).toBe("application/pdf")
  expect(Buffer.from(stored[0]!.bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-")

  // Queda como mensaje saliente con adjunto en la conversación de esa persona.
  const [thread] = await ownerDb.select().from(conversation).where(eq(conversation.id, sent.conversationId))
  expect(thread?.contactId).toBe(selfId)
  expect(thread?.channelConnectionId).toBe(connectionId)
  const messages = await ownerDb
    .select()
    .from(message)
    .where(and(eq(message.organizationId, "org_a"), eq(message.conversationId, sent.conversationId)))
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ id: sent.messageId, direction: "out", senderKind: "user" })
  const attachments = messages[0]!.attachments as Array<{ filename?: string; mimeType?: string }>
  expect(attachments).toHaveLength(1)
  expect(attachments[0]?.filename).toMatch(/^Ticket-\d{6}\.pdf$/)

  // Reenviar el mismo intento (doble clic, reintento) no manda otro correo.
  const again = await send()
  expect(again.messageId).toBe(sent.messageId)
  expect(again.conversationId).toBe(sent.conversationId)
  expect(stored).toHaveLength(1)
  const after = await ownerDb
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.organizationId, "org_a"), eq(message.conversationId, sent.conversationId)))
  expect(after).toHaveLength(1)

  // La misma clave con otro documento es un error, no un envío silencioso.
  await expect(
    run((tx) =>
      sendFinancialDocument(
        tx,
        "org_a",
        f.actor,
        "cashier",
        {
          patientId: f.patient.id,
          documentType: "ticket",
          documentId: randomUUID(),
          recipientContactId: selfId,
          connectionId,
          requestId,
        },
        { storage },
      ),
    ),
  ).rejects.toBeTruthy()
})

it("el medio preferido solo puede ser uno que la clínica tenga conectado", async () => {
  const { run, selfId } = await paidTicket()
  // Hay correo conectado (del caso anterior); mensajería no.
  await connectEmail()
  const viaEmail = await run((tx) =>
    updateContact(tx, "org_a", selfId, { preferredChannel: "email" }, { userId: null }),
  )
  expect(viaEmail.preferredChannel).toBe("email")
  await expect(
    run((tx) => updateContact(tx, "org_a", selfId, { preferredChannel: "telegram" }, { userId: null })),
  ).rejects.toThrow(/no tiene conectado/)
  // Un valor que no es un canal sigue rechazándose.
  await expect(
    run((tx) => updateContact(tx, "org_a", selfId, { preferredChannel: "paloma" }, { userId: null })),
  ).rejects.toThrow()
  const cleared = await run((tx) => updateContact(tx, "org_a", selfId, { preferredChannel: null }, { userId: null }))
  expect(cleared.preferredChannel).toBeNull()
})

it("propone el mensaje, envía a otro correo solo con confirmación y deja registrado a cuál", async () => {
  const { f, run, selfId, ticket } = await paidTicket()
  const connectionId = await connectEmail()
  const { storage, stored } = capturingStorage()

  // El servidor compone el mensaje: la interfaz solo lo deja editar.
  const options = await run((tx) =>
    getDocumentSendOptions(tx, "org_a", f.patient.id, { documentType: "ticket", documentId: ticket.id }),
  )
  expect(options.message).toMatch(/^Hola, Paciente de prueba\. Te enviamos el ticket de tu pago/)

  const otherEmail = `Otro-${randomUUID()}@Example.com`
  const requestId = randomUUID()
  const send = (confirmOtherEmail: boolean) =>
    run((tx) =>
      sendFinancialDocument(
        tx,
        "org_a",
        f.actor,
        "cashier",
        {
          patientId: f.patient.id,
          documentType: "ticket",
          documentId: ticket.id,
          recipientContactId: selfId,
          connectionId,
          requestId,
          otherEmail,
          confirmOtherEmail,
        },
        { storage },
      ),
    )
  // Sin la confirmación explícita no sale nada.
  await expect(send(false)).rejects.toThrow(/Confirma/)
  expect(stored).toHaveLength(0)

  const sent = await send(true)
  expect(sent.sentToEmail).toBe(otherEmail.toLowerCase())
  // El hilo es el de esa dirección y sigue siendo de la misma persona.
  const [thread] = await ownerDb.select().from(conversation).where(eq(conversation.id, sent.conversationId))
  expect(thread?.contactId).toBe(selfId)
  expect(thread?.externalThreadId).toBe(`mail:${otherEmail.toLowerCase()}`)
  // El correo registrado de la persona no cambia por enviar a otro.
  const [person] = await ownerDb.select().from(contact).where(eq(contact.id, selfId))
  expect(person?.email).not.toBe(otherEmail.toLowerCase())
  // Auditoría: a qué dirección, que no era la registrada y quién lo decidió.
  const [audit] = await ownerDb
    .select()
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.organizationId, "org_a"),
        eq(auditEvent.action, "financial_document.sent"),
        eq(auditEvent.entityId, sent.messageId),
      ),
    )
  expect(audit?.metadata).toMatchObject({
    sentToEmail: otherEmail.toLowerCase(),
    otherEmail: true,
    decidedBy: f.actor,
    registeredEmail: person?.email,
  })

  // El mismo intento repetido no envía otra vez.
  const again = await send(true)
  expect(again.messageId).toBe(sent.messageId)
  expect(again.sentToEmail).toBe(otherEmail.toLowerCase())
  expect(stored).toHaveLength(1)
})

it("«Agregar correo» lo guarda en la persona y habilita el envío por correo", async () => {
  const { f, run, selfId, ticket } = await paidTicket()
  await connectEmail()
  await ownerDb.update(contact).set({ email: null }).where(eq(contact.id, selfId))
  const before = await run((tx) =>
    getDocumentSendOptions(tx, "org_a", f.patient.id, { documentType: "ticket", documentId: ticket.id }),
  )
  expect(before.channels.filter((c) => c.channel === "email").every((c) => !c.usable)).toBe(true)

  await expect(
    run((tx) => saveRecipientEmail(tx, "org_a", f.actor, f.patient.id, { recipientContactId: selfId, email: "no-es-correo" })),
  ).rejects.toThrow(/formato/)
  const email = `nuevo-${randomUUID()}@example.com`
  await run((tx) => saveRecipientEmail(tx, "org_a", f.actor, f.patient.id, { recipientContactId: selfId, email }))
  const [person] = await ownerDb.select().from(contact).where(eq(contact.id, selfId))
  expect(person?.email).toBe(email)
  const after = await run((tx) =>
    getDocumentSendOptions(tx, "org_a", f.patient.id, { documentType: "ticket", documentId: ticket.id }),
  )
  expect(after.proposed?.channel).toBe("email")
  // Quien no es la persona ni un responsable vigente no recibe correo por esta vía.
  await expect(
    run((tx) => saveRecipientEmail(tx, "org_a", f.actor, f.patient.id, { recipientContactId: randomUUID(), email })),
  ).rejects.toBeTruthy()
})

it("la cuenta dice quién es, cómo quedó cada cobro y de qué adelanto viene el saldo; la devolución tiene constancia en PDF", async () => {
  const { f, run, ticket } = await paidTicket()
  const [sede] = await ownerDb.select().from(branch).where(eq(branch.id, ticket.branchId))
  const cash = await run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo 2", typeCode: "10" }))
  const advance = await run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId: sede!.id,
      advanceCents: 5000,
      payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
      cashReceivedCents: 10000,
      requestId: randomUUID(),
    }),
  )
  const account = await run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(account.patient.displayName).toBe(f.patient.displayName)
  const cobro = account.cobros.find((c) => c.ticketId === advance.ticket.id)
  expect(cobro).toMatchObject({ cashReceivedCents: 10000, changeCents: 5000, voidedAt: null, closedAfter: false })
  expect(account.aFavorOrigen).toHaveLength(1)
  expect(account.aFavorOrigen[0]).toMatchObject({
    ticketId: advance.ticket.id,
    ticketNumber: advance.ticket.ticketNumber,
    availableCents: 5000,
    advance: true,
  })

  const refund = await run((tx) =>
    refundCredit(tx, ...f.args, { branchId: sede!.id, amountCents: 2000, paymentMethodId: cash.id, reason: "Ya no hará el tratamiento" }),
  )
  const pdf = await run((tx) => getRefundReceiptPdf(tx, "org_a", f.patient.id, refund.receiptId))
  expect(Buffer.from(pdf.bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-")
  // La constancia es del paciente al que se le devolvió: con otro id no existe.
  await expect(run((tx) => getRefundReceiptPdf(tx, "org_a", f.patient.id, randomUUID()))).rejects.toBeTruthy()
  const later = await run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(later.aFavorOrigen[0]?.availableCents).toBe(3000)
})

it("por el chat el comprobante solo va a quien decide: quien fue su representante de niño ya no lo recibe al cumplir 18", async () => {
  const { f, run } = await paidTicket()
  // La paciente ya es mayor de edad; su madre fue su representante legal desde niña y sigue vinculada.
  await setTestPatientIdentity(ownerDb, f.patient.id, { birthDate: "1995-03-10" })
  const former = await run((tx) => createContact(tx, "org_a", { displayName: "Madre De Antes", email: `madre-${randomUUID()}@example.com` }))
  await ownerDb.insert(patientContact).values({ organizationId: "org_a", patientId: f.patient.id, contactId: former.id, relationship: "guardian" })
  await run((tx) => grantResponsibility(tx, "org_a", f.actor, f.patient.id, { contactId: former.id, kind: "representante_legal", startsAt: "2000-01-01" }))
  // La madre escribe por su chat y pide el comprobante de su hija.
  const [conn] = await ownerDb
    .insert(channelConnection)
    .values({
      organizationId: "org_a",
      channel: "telegram",
      provider: "telegram_bot_api",
      displayName: "Bot",
      configEncrypted: "prueba",
      webhookSecret: "prueba",
      status: "active",
    })
    .returning()
  const externalId = `tg:${randomUUID()}`
  const [identity] = await ownerDb
    .insert(contactIdentity)
    .values({ organizationId: "org_a", contactId: former.id, channel: "telegram", externalUserId: externalId })
    .returning()
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: "org_a",
      contactId: former.id,
      channelConnectionId: conn!.id,
      externalThreadId: externalId,
      contactIdentityId: identity!.id,
      lastInboundAt: new Date(),
    })
    .returning()
  const { storage, stored } = capturingStorage()
  const sent = await run((tx) => sendReceiptInConversation(tx, "org_a", { conversationId: thread!.id, patientId: f.patient.id }, { storage }))
  expect(sent).toBeNull()
  expect(stored).toEqual([])
  const messages = await ownerDb.select().from(message).where(eq(message.conversationId, thread!.id))
  expect(messages).toEqual([])
})
