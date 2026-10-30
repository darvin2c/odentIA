import { createStubFetch, gmailAdapter, microsoft365Adapter, splitColdSubject } from "@odentia/channels"
import { withOrgContext } from "@odentia/db"
import {
  patientCharge,
  patientContact,
  patientPayment,
  patientPaymentApplication,
  patientResponsibility,
  paymentTicket,
} from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { contact } from "@odentia/db/schema/crm"
import { expect, it } from "vitest"
import { budgetFormat } from "./budget-pdf.js"
import { ticketFormat } from "./financial-document-pdf.js"
import { getDocumentSendOptions, listDocumentRecipients, proposeChannel, sendFinancialDocument } from "./financial-documents.js"
import { nextPatientNumber } from "./patients.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"
import { eq } from "drizzle-orm"

setupTestDb()

const storageThrow: Storage = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async () => {
    throw new Error("no debe adjuntar sin destinatario válido")
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

it("propone correo si hay conexión utilizable, si no el preferido", () => {
  const base = [
    { channel: "email", usable: true, hasThread: false, connectionId: "c1" },
    { channel: "whatsapp", usable: true, hasThread: true, connectionId: "c2" },
  ]
  expect(
    proposeChannel(base, { email: "p@example.com", preferredChannel: "whatsapp", lastChannel: "whatsapp" })?.channel,
  ).toBe("email")
  expect(
    proposeChannel(base, { email: null, preferredChannel: "whatsapp", lastChannel: "email" })?.channel,
  ).toBe("whatsapp")
  expect(
    proposeChannel(base, { email: null, preferredChannel: null, lastChannel: "whatsapp" })?.channel,
  ).toBe("whatsapp")
  expect(proposeChannel(base, { email: null, preferredChannel: null, lastChannel: null })?.connectionId).toBe("c1")
  expect(proposeChannel([], { email: "p@example.com", preferredChannel: null, lastChannel: null })).toBeNull()
  const unusable = base.map((o) => ({ ...o, usable: false }))
  expect(proposeChannel(unusable, { email: "p@example.com", preferredChannel: null, lastChannel: null })).toBeNull()
})

it("parte el asunto del envío en frío en primera línea", async () => {
  expect(splitColdSubject("Ticket de cobro · Clínica\n\nTe enviamos tu ticket.")).toEqual({
    subject: "Ticket de cobro · Clínica",
    body: "Te enviamos tu ticket.",
  })
  await expect(async () => splitColdSubject("   \n  ")).rejects.toThrow()
})

it("gmail abre un hilo nuevo para mail: con adjunto", async () => {
  const captured: { url: string; method: string; body: unknown }[] = []
  const fetch = createStubFetch([{ ignored: true }, { id: "m123" }], captured)
  const result = await gmailAdapter.sendMessage(
    { refreshToken: "r", emailAddress: "clinica@example.com", accessToken: "a" },
    {
      to: "mail:paciente@example.com",
      kind: {
        type: "media",
        media: {
          url: "https://signed.example.com/x.pdf",
          mimeType: "application/pdf",
          filename: "Ticket.pdf",
          caption: "Ticket de cobro · Clínica\n\nTe enviamos tu ticket.",
        },
      },
    },
    { fetch },
  )
  expect(result).toEqual({ externalId: "gmail:m123" })
  const send = captured[1]?.body as { raw?: string; threadId?: string }
  expect(send?.raw).toBeTypeOf("string")
  expect(send).not.toHaveProperty("threadId")
})

it("microsoft 365 envía nuevo con adjunto para mail:", async () => {
  const captured: { url: string; method: string; body: unknown }[] = []
  const fetch = createStubFetch([{}], captured)
  const result = await microsoft365Adapter.sendMessage(
    { refreshToken: "r", emailAddress: "clinica@example.com", accessToken: "a" },
    {
      to: "mail:paciente@example.com",
      kind: {
        type: "media",
        media: {
          url: "https://signed.example.com/x.pdf",
          mimeType: "application/pdf",
          filename: "Ticket.pdf",
          caption: "Ticket de cobro · Clínica\n\nTe enviamos tu ticket.",
        },
      },
    },
    { fetch },
  )
  expect(result.externalId.startsWith("m365-send:paciente@example.com:")).toBe(true)
  // captured[0] es la descarga del adjunto; el envío es captured[1].
  const body = captured[1]?.body as { message?: { subject?: string; toRecipients?: unknown[]; attachments?: unknown[] } }
  expect(body?.message?.subject).toBe("Ticket de cobro · Clínica")
  expect(body?.message?.toRecipients).toHaveLength(1)
  expect(body?.message?.attachments).toHaveLength(1)
})

async function seedRecipients(orgId: string) {
  // La persona del paciente (su vínculo propio lo pone la base), con correo.
  const [person] = await insertTestPatients(ownerDb, {
      organizationId: orgId,
      displayName: "Paciente doctos",
      email: "pac@example.com",
      patientNumber: await nextPatientNumber(ownerDb, orgId),
    })
  const [self] = await ownerDb.select().from(contact).where(eq(contact.id, person!.personId))
  const [payer] = await ownerDb
    .insert(contact)
    .values({ organizationId: orgId, displayName: "Pagadora", email: "pag@example.com" })
    .returning()
  await ownerDb.insert(patientContact).values({
    organizationId: orgId,
    patientId: person!.id,
    contactId: payer!.id,
    relationship: "family",
  })
  await ownerDb.insert(patientResponsibility).values({
    organizationId: orgId,
    patientId: person!.id,
    contactId: payer!.id,
    kind: "responsable_economico",
    startsAt: "2026-01-01",
  })
  const [stranger] = await ownerDb
    .insert(contact)
    .values({ organizationId: orgId, displayName: "Extraña" })
    .returning()
  const [branchRow] = await ownerDb
    .insert(branch)
    .values({ organizationId: orgId, name: "Sede doctos" })
    .returning()
  const [ticket] = await ownerDb
    .insert(paymentTicket)
    .values({
      organizationId: orgId,
      patientId: person!.id,
      branchId: branchRow!.id,
      ticketNumber: 1,
      currency: "PEN",
      totalCents: 45000,
      payerContactId: payer!.id,
      snapshot: {},
    })
    .returning()
  const [charge] = await ownerDb
    .insert(patientCharge)
    .values({
      organizationId: orgId,
      patientId: person!.id,
      description: "Resina compuesta, pieza 16",
      amountCents: 45000,
      currency: "PEN",
    })
    .returning()
  const [payment] = await ownerDb
    .insert(patientPayment)
    .values({
      organizationId: orgId,
      patientId: person!.id,
      ticketId: ticket!.id,
      payerContactId: payer!.id,
      amountCents: 45000,
      currency: "PEN",
      paidAt: new Date("2026-10-11T12:00:00-05:00"),
      methodName: "Efectivo",
    })
    .returning()
  await ownerDb.insert(patientPaymentApplication).values({
    organizationId: orgId,
    patientId: person!.id,
    paymentId: payment!.id,
    chargeId: charge!.id,
    ticketId: ticket!.id,
    amountCents: 45000,
  })
  return { patientId: person!.id, selfId: self!.id, payerId: payer!.id, strangerId: stranger!.id, ticketId: ticket!.id }
}

it("lista a la persona y al pagador, y rechaza a un tercero", async () => {
  const seed = await seedRecipients("org_a")
  const recipients = await withOrgContext(appDb, "org_a", (tx) =>
    listDocumentRecipients(tx, "org_a", seed.patientId, seed.payerId),
  )
  expect(recipients.map((r) => r.contactId).sort()).toEqual([seed.payerId, seed.selfId].sort())
  expect(recipients.find((r) => r.contactId === seed.payerId)?.isDefault).toBe(true)
  expect(recipients.find((r) => r.contactId === seed.payerId)?.relation).toBe("responsable_economico")
  const options = await withOrgContext(appDb, "org_a", (tx) =>
    getDocumentSendOptions(tx, "org_a", seed.patientId, { documentType: "ticket", documentId: seed.ticketId }),
  )
  expect(options.document.label).toBe("Ticket N.º 000001")
  expect(options.document.statusLabel).toBe("Vigente")
  expect(options.recipient.contactId).toBe(seed.payerId)
  expect(options.proposed).toBeNull()
  await expect(
    withOrgContext(appDb, "org_a", (tx) =>
      sendFinancialDocument(
        tx,
        "org_a",
        "actor",
        "cashier",
        {
          patientId: seed.patientId,
          documentType: "ticket",
          documentId: seed.ticketId,
          recipientContactId: seed.strangerId,
          connectionId: "00000000-0000-0000-0000-000000000000",
        },
        { storage: storageThrow },
      ),
    ),
  ).rejects.toMatchObject({ code: "DOCUMENT_RECIPIENT_NOT_AUTHORIZED", status: 403 })
})

it("respeta el papel configurado en el perfil", () => {
  const base = {
    tradeName: "Clínica",
    legalName: "Clínica",
    address: null,
    phone: null,
    branchName: null,
    currency: "PEN",
    locale: "es-PE",
    timezone: "America/Lima",
    ticketFooter: "Recibo interno.",
    receiptWidth: "58",
    sheetSize: "A4",
  }
  expect(ticketFormat(base).width).toBeCloseTo((58 * 72) / 25.4, 1)
  expect(ticketFormat(base).exactFit).toBe(true)
  expect(ticketFormat(base, "A4").width).toBeCloseTo(595.28, 0)
  expect(budgetFormat({ ...base, sheetSize: "Letter" }).width).toBe(612)
  expect(budgetFormat(base).width).toBeCloseTo(595.28, 0)
})
