/**
 * Pedidos sobre sus datos (issues 45 y 50, ADR 0080): un solo plazo de 10
 * días corridos, solo la propia persona o su representante legal, comprobar
 * antes de responder, «no recibir mensajes» que se cumple al registrarlo y la
 * copia de la historia que se envía sin mostrarla. El proveedor no participa:
 * el mensaje queda encolado para el worker.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { automationConsent } from "@odentia/db/schema/automation"
import { channelConnection, contact, message } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createContact } from "./contacts.js"
import {
  createDataRequest,
  dataRequestDueOn,
  denyDataRequest,
  dueDataRequests,
  listDataRequests,
  respondDataRequest,
  verifyDataRequest,
} from "./data-requests.js"
import { clinicToday } from "./inventory-stock.js"
import {
  loadPatientRecord,
  patientRecordFhirBundle,
  recordSendOptions,
  renderPatientRecordPdf,
  sendPatientRecordCopy,
} from "./patient-record.js"
import type { Storage } from "./storage.js"
import { setTestPatientIdentity } from "./test-patient.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function adult() {
  const f = await clinicalFixture()
  const run = f.run as <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
  await setTestPatientIdentity(ownerDb, f.patient.id, {
    email: `paciente-${randomUUID()}@example.com`,
    birthDate: "1990-05-14",
  })
  const [self] = await ownerDb.select().from(contact).where(eq(contact.id, f.patient.personId))
  return { f, run, selfId: self!.id, patientId: f.patient.id }
}

it("el plazo es de 10 días corridos desde el día siguiente, también al cambiar de mes", () => {
  expect(dataRequestDueOn("2026-10-22")).toBe("2026-11-01")
  expect(dataRequestDueOn("2026-12-28")).toBe("2027-01-07")
})

it("registrar, comprobar y responder; solo la persona o su representante; sin responder dos veces", async () => {
  const { f, run, selfId, patientId } = await adult()
  const created = await run((tx) =>
    createDataRequest(tx, "org_a", f.actor, patientId, {
      kind: "copia",
      requesterContactId: selfId,
      channel: "whatsapp",
      requestedOn: "2026-10-22",
      said: "Me cambio de clínica",
    }),
  )
  expect(created).toMatchObject({
    status: "pendiente",
    dueOn: "2026-11-01",
    requesterRelation: "paciente",
  })

  // Alguien que no es ella ni su representante no puede pedirlo.
  const other = await run((tx) => createContact(tx, "org_a", { displayName: "Vecina" }))
  await expect(
    run((tx) =>
      createDataRequest(tx, "org_a", f.actor, patientId, {
        kind: "copia",
        requesterContactId: other.id,
        channel: "clinica",
      }),
    ),
  ).rejects.toMatchObject({ status: 403 })
  // Ni con una fecha futura.
  await expect(
    run((tx) =>
      createDataRequest(tx, "org_a", f.actor, patientId, {
        kind: "corregir",
        requesterContactId: selfId,
        channel: "clinica",
        requestedOn: "2999-01-01",
      }),
    ),
  ).rejects.toMatchObject({ status: 400 })

  // Responder exige haber comprobado que es ella.
  await expect(
    run((tx) =>
      respondDataRequest(tx, "org_a", f.actor, patientId, created.id, { resolution: "Entregada" }),
    ),
  ).rejects.toMatchObject({ code: "DATA_REQUEST_NOT_VERIFIED" })
  const verified = await run((tx) =>
    verifyDataRequest(tx, "org_a", f.actor, patientId, created.id, { how: "documento" }),
  )
  expect(verified.verifiedHow).toBe("documento")
  const done = await run((tx) =>
    respondDataRequest(tx, "org_a", f.actor, patientId, created.id, {
      resolution: "Se entregó en mano",
    }),
  )
  expect(done).toMatchObject({ status: "respondida", resolution: "Se entregó en mano" })
  await expect(
    run((tx) =>
      denyDataRequest(tx, "org_a", f.actor, patientId, created.id, { reason: "Otra vez" }),
    ),
  ).rejects.toMatchObject({ code: "DATA_REQUEST_CLOSED" })

  // Denegar no exige comprobar (justamente cuando no se pudo).
  const second = await run((tx) =>
    createDataRequest(tx, "org_a", f.actor, patientId, {
      kind: "corregir",
      requesterContactId: selfId,
      channel: "correo",
    }),
  )
  const denied = await run((tx) =>
    denyDataRequest(tx, "org_a", f.actor, patientId, second.id, {
      reason: "No pudimos comprobar que es ella",
    }),
  )
  expect(denied.status).toBe("denegada")
  expect(
    (await run((tx) => listDataRequests(tx, "org_a", patientId))).map((r) => r.status).sort(),
  ).toEqual(["denegada", "respondida"])
})

it("«no recibir mensajes» se cumple al registrarlo y deja los avisos de sus citas", async () => {
  const { f, run, selfId, patientId } = await adult()
  const request = await run((tx) =>
    createDataRequest(tx, "org_a", f.actor, patientId, {
      kind: "mensajes",
      requesterContactId: selfId,
      channel: "clinica",
    }),
  )
  expect(request.status).toBe("respondida")
  const consents = await ownerDb
    .select({ purpose: automationConsent.purpose, status: automationConsent.status })
    .from(automationConsent)
    .where(
      and(eq(automationConsent.organizationId, "org_a"), eq(automationConsent.contactId, selfId)),
    )
  const byPurpose = Object.fromEntries(consents.map((c) => [c.purpose, c.status]))
  expect(byPurpose).toMatchObject({
    recordatorio: "revoked",
    seguimiento: "revoked",
    novedades: "revoked",
  })
  expect(byPurpose.avisos).not.toBe("revoked")
})

it("«Te espera» trae lo que vence dentro de 3 días o ya venció", async () => {
  const { f, run, selfId, patientId } = await adult()
  const today = await run((tx) => clinicToday(tx, "org_a"))
  const add = (days: number) => {
    const [y, m, d] = today.split("-").map(Number) as [number, number, number]
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
  }
  // Pedido hace 8 días: vence en 2. Hoy: vence en 10, no sale todavía.
  const soon = await run((tx) =>
    createDataRequest(tx, "org_a", f.actor, patientId, {
      kind: "copia",
      requesterContactId: selfId,
      channel: "clinica",
      requestedOn: add(-8),
    }),
  )
  const fresh = await run((tx) =>
    createDataRequest(tx, "org_a", f.actor, patientId, {
      kind: "corregir",
      requesterContactId: selfId,
      channel: "clinica",
    }),
  )
  const due = await run((tx) => dueDataRequests(tx, "org_a", today))
  expect(due.map((d) => d.id)).toContain(soon.id)
  expect(due.map((d) => d.id)).not.toContain(fresh.id)
})

it("la copia de la historia: PDF, paquete FHIR R4 y envío a la propia persona sin repetirlo", async () => {
  const { f, run, selfId, patientId } = await adult()
  const record = await run((tx) => loadPatientRecord(tx, "org_a", patientId))
  const pdf = await renderPatientRecordPdf(record, record.clinic)
  expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-")
  const bundle = patientRecordFhirBundle(record) as {
    resourceType: string
    type: string
    entry: Array<{ resource: { resourceType: string } }>
  }
  expect(bundle).toMatchObject({ resourceType: "Bundle", type: "collection" })
  const types = bundle.entry.map((e) => e.resource.resourceType)
  expect(types).toContain("Patient")
  expect(types).toContain("Encounter")

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
  const stored: string[] = []
  const storage = {
    putAttachment: async ({
      orgId,
      conversationId,
      bytes,
      contentType,
    }: {
      orgId: string
      conversationId: string
      bytes: Uint8Array
      contentType: string
    }) => {
      stored.push(contentType)
      return {
        objectKey: `${orgId}/${conversationId}/${stored.length}.pdf`,
        mimeType: contentType,
        filename: "x.pdf",
        size: bytes.byteLength,
      }
    },
    attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
  } as unknown as Storage
  const request = await run((tx) =>
    createDataRequest(tx, "org_a", f.actor, patientId, {
      kind: "copia",
      requesterContactId: selfId,
      channel: "correo",
    }),
  )
  const options = await run((tx) => recordSendOptions(tx, "org_a", patientId, request.id))
  expect(options.recipient?.contactId).toBe(selfId)
  // Sin comprobar que es ella, no sale.
  await expect(
    run((tx) =>
      sendPatientRecordCopy(
        tx,
        "org_a",
        f.actor,
        patientId,
        request.id,
        { connectionId: conn!.id },
        { storage },
      ),
    ),
  ).rejects.toMatchObject({ code: "DATA_REQUEST_NOT_VERIFIED" })
  await run((tx) =>
    verifyDataRequest(tx, "org_a", f.actor, patientId, request.id, { how: "documento" }),
  )
  const sent = await run((tx) =>
    sendPatientRecordCopy(
      tx,
      "org_a",
      f.actor,
      patientId,
      request.id,
      { connectionId: conn!.id },
      { storage },
    ),
  )
  expect(sent.request).toMatchObject({ status: "respondida" })
  expect(sent.request.resolution).toMatch(/correo/)
  expect(stored).toEqual(["application/pdf"])
  const [queued] = await ownerDb
    .select()
    .from(message)
    .where(eq(message.conversationId, sent.conversationId))
  expect(queued).toBeTruthy()
  // Un pedido respondido no se envía otra vez.
  await expect(
    run((tx) =>
      sendPatientRecordCopy(
        tx,
        "org_a",
        f.actor,
        patientId,
        request.id,
        { connectionId: conn!.id },
        { storage },
      ),
    ),
  ).rejects.toMatchObject({ code: "DATA_REQUEST_CLOSED" })
})
