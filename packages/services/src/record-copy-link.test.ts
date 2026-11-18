/**
 * La copia de su historia por «Su enlace» (mesa del 18 nov): el envío pone el enlace dentro
 * del PDF (nunca en el texto del mensaje) y deja el pedido sirviendo la copia siete días;
 * «Enviar de nuevo» es la misma operación. La página pública pide su documento (como la
 * firma a distancia), cuenta los mal escritos como el PIN del portal, tiene un tope de
 * descargas, deja cada una registrada y, vencida, quitada, bloqueada o inválida, responde
 * lo mismo. El proveedor no participa: el mensaje queda encolado para el worker.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { patientDataRequest, patientRecordDownload } from "@odentia/db/schema/clinical"
import { channelConnection, contact, message } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"
import { livePersonalLinkToken, revokePersonalLinks } from "./booking-links.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { listClinicalAccess } from "./clinical-access.js"
import {
  createDataRequest,
  listDataRequests,
  RECORD_COPY_ATTEMPTS,
  RECORD_COPY_DOWNLOADS,
  verifyDataRequest,
} from "./data-requests.js"
import { sendPatientRecordCopy } from "./patient-record.js"
import { configurePublicLinks } from "./public-links.js"
import {
  checkRecordCopyDocument,
  getRecordCopyView,
  recordRecordCopyFailure,
  startRecordCopyDownload,
} from "./record-copy-public.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { setTestPatientIdentity } from "./test-patient.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const secretsKey = secretsKeyFromEnv("ab".repeat(32))
/** Un DNI distinto en cada prueba: el documento es único en la clínica. */
const newDoc = () => String(40_000_000 + Math.floor(Math.random() * 9_999_999))

beforeAll(() =>
  configurePublicLinks({ webURL: "https://app.odentia.test", cookieDomain: "odentia.test" }),
)
afterAll(() => configurePublicLinks(null))

/** Lo que guarda el envío: el PDF en el almacenamiento del mensaje. */
function sendStorage() {
  const stored: Uint8Array[] = []
  const storage = {
    putAttachment: async ({
      orgId,
      conversationId,
      bytes,
    }: {
      orgId: string
      conversationId: string
      bytes: Uint8Array
    }) => {
      stored.push(bytes)
      return {
        objectKey: `${orgId}/${conversationId}/${stored.length}.pdf`,
        mimeType: "application/pdf",
        filename: "x.pdf",
        size: bytes.byteLength,
      }
    },
    attachmentUrl: async (key: string) => `https://signed.example.com/${key}`,
    streamAttachment: async () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    getAttachment: async () => new Uint8Array(),
  } as unknown as Storage
  return { storage, stored }
}

/** Una paciente adulta con su documento, su correo y su pedido de copia comprobado. */
async function sentCopy() {
  const f = await clinicalFixture()
  const run = f.run as <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
  const doc = newDoc()
  await setTestPatientIdentity(ownerDb, f.patient.id, {
    givenNames: "Rosa",
    familyName: "Quispe",
    docType: "DNI",
    docNumber: doc,
    email: `rosa-${randomUUID()}@example.com`,
    birthDate: "1990-05-14",
  })
  const selfId = f.patient.personId
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
  const request = await run((tx) =>
    createDataRequest(tx, "org_a", f.actor, f.patient.id, {
      kind: "copia",
      requesterContactId: selfId,
      channel: "whatsapp",
    }),
  )
  await run((tx) =>
    verifyDataRequest(tx, "org_a", f.actor, f.patient.id, request.id, { how: "documento" }),
  )
  const { storage, stored } = sendStorage()
  const send = () =>
    run((tx) =>
      sendPatientRecordCopy(
        tx,
        "org_a",
        f.actor,
        f.patient.id,
        request.id,
        { connectionId: conn!.id },
        { storage, secretsKey },
      ),
    )
  const sent = await send()
  const token = await run((tx) =>
    livePersonalLinkToken(
      tx,
      "org_a",
      { contactId: selfId, patientId: f.patient.id },
      { secretsKey },
    ),
  )
  return { f, run, selfId, request, sent, send, stored, storage, doc, token: token! }
}

it("el envío pone el enlace en el PDF y no en el mensaje, responde el pedido y «Enviar de nuevo» es la misma operación", async () => {
  const { f, run, request, sent, send, stored, token } = await sentCopy()
  expect(token).toMatch(/^[0-9a-f]{64}$/)
  expect(sent.request.status).toBe("respondida")
  expect(sent.request.resolution).toMatch(/enlace para bajar la copia completa/)
  // La fila sabe hasta cuándo sirve y que todavía no la baja.
  expect(sent.request.copy).toMatchObject({ downloads: 0, lastDownloadAt: null })
  const days = (new Date(sent.request.copy!.until).getTime() - Date.now()) / 86_400_000
  expect(days).toBeGreaterThan(6.9)
  expect(days).toBeLessThanOrEqual(7)
  // El texto del mensaje lo ve recepción: no lleva el enlace ni el token, y no dice nada de su salud.
  const [queued] = await ownerDb
    .select()
    .from(message)
    .where(eq(message.conversationId, sent.conversationId))
  const text = JSON.stringify(queued!)
  expect(text).not.toContain(token)
  expect(text).not.toMatch(/pendientes\?|abre=copia/)
  expect(text).toMatch(/En su primera página está el enlace/)
  expect(stored).toHaveLength(1)

  // «Enviar de nuevo»: el pedido sigue respondido, el enlace sirve otra semana y vuelve a contar los intentos.
  await ownerDb
    .update(patientDataRequest)
    .set({ copyFailedAttempts: 3 })
    .where(eq(patientDataRequest.id, request.id))
  const again = await send()
  expect(again.request.status).toBe("respondida")
  expect(again.request.resolution).toBe(sent.request.resolution)
  expect(stored).toHaveLength(2)
  const [row] = await ownerDb
    .select()
    .from(patientDataRequest)
    .where(eq(patientDataRequest.id, request.id))
  expect(row!.copyFailedAttempts).toBe(0)
  // Un pedido respondido sin copia por enlace (entregada en mano) no se envía otra vez.
  const other = await run((tx) =>
    createDataRequest(tx, "org_a", f.actor, f.patient.id, {
      kind: "corregir",
      requesterContactId: f.patient.personId,
      channel: "clinica",
    }),
  )
  expect(other.copy).toBeNull()
})

it("la página: abrir no registra; su documento abre la descarga, que queda registrada y en «Consultas a la historia clínica»", async () => {
  const { f, run, request, storage, doc, token } = await sentCopy()
  const view = await run((tx) => getRecordCopyView(tx, "org_a", token, { storage }))
  expect(view).toMatchObject({
    firstName: "Rosa",
    patientFirstName: null,
    canDownload: true,
    documentLabel: "DNI",
    downloadsLeft: RECORD_COPY_DOWNLOADS,
  })
  // Abrirla no deja ninguna descarga.
  expect(
    await ownerDb
      .select()
      .from(patientRecordDownload)
      .where(eq(patientRecordDownload.dataRequestId, request.id)),
  ).toEqual([])

  // Un documento que no es el suyo se dice en su campo; el escrito con puntos o espacios vale.
  await expect(
    run((tx) => checkRecordCopyDocument(tx, "org_a", token, "11111111")),
  ).rejects.toMatchObject({
    code: "RECORD_COPY_DOCUMENT",
    fields: { docNumber: expect.any(String) },
  })
  const dotted = `${doc.slice(0, 2)}.${doc.slice(2, 5)}.${doc.slice(5)}`
  await expect(run((tx) => checkRecordCopyDocument(tx, "org_a", token, dotted))).resolves.toEqual({
    ok: true,
  })

  const copy = await run((tx) =>
    startRecordCopyDownload(
      tx,
      "org_a",
      token,
      { docNumber: doc },
      { ip: "203.0.113.5", userAgent: "Prueba" },
      { storage },
    ),
  )
  expect(copy.entries.length).toBeGreaterThan(0)
  const downloads = await ownerDb
    .select()
    .from(patientRecordDownload)
    .where(eq(patientRecordDownload.dataRequestId, request.id))
  expect(downloads).toHaveLength(1)
  expect(downloads[0]).toMatchObject({ patientId: f.patient.id, ip: "203.0.113.5" })
  // La fila del pedido dice que la bajó; la bitácora, quién y desde su enlace.
  const [listed] = await run((tx) =>
    listDataRequests(tx, "org_a", f.patient.id, { id: request.id }),
  )
  expect(listed!.copy).toMatchObject({ downloads: 1 })
  expect(listed!.copy!.lastDownloadAt).not.toBeNull()
  const access = await run((tx) => listClinicalAccess(tx, "org_a", f.patient.id))
  expect(access).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        resource: "descarga_enlace",
        userId: null,
        personName: "Rosa Quispe",
      }),
    ]),
  )
  // Con el documento mal escrito, la descarga tampoco sale.
  await expect(
    run((tx) => startRecordCopyDownload(tx, "org_a", token, { docNumber: "999" }, {}, { storage })),
  ).rejects.toMatchObject({ code: "RECORD_COPY_DOCUMENT" })
})

it("tope de descargas y de documentos mal escritos; vencida, quitada, bloqueada o inválida responden lo mismo", async () => {
  const { f, run, request, storage, doc, token, selfId } = await sentCopy()
  for (let i = 0; i < RECORD_COPY_DOWNLOADS; i++)
    await run((tx) =>
      startRecordCopyDownload(tx, "org_a", token, { docNumber: doc }, {}, { storage }),
    )
  await expect(
    run((tx) => startRecordCopyDownload(tx, "org_a", token, { docNumber: doc }, {}, { storage })),
  ).rejects.toMatchObject({ code: "RECORD_COPY_LIMIT" })
  expect(
    (await run((tx) => getRecordCopyView(tx, "org_a", token, { storage }))).downloadsLeft,
  ).toBe(0)

  // Los documentos mal escritos se cuentan fuera de la transacción que los rechaza; con el tope, ya no sirve.
  for (let i = 0; i < RECORD_COPY_ATTEMPTS; i++)
    await run((tx) => recordRecordCopyFailure(tx, "org_a", token))
  await expect(
    run((tx) => getRecordCopyView(tx, "org_a", token, { storage })),
  ).rejects.toMatchObject({ status: 404 })
  await ownerDb
    .update(patientDataRequest)
    .set({ copyFailedAttempts: 0 })
    .where(eq(patientDataRequest.id, request.id))
  await expect(
    run((tx) => getRecordCopyView(tx, "org_a", token, { storage })),
  ).resolves.toBeTruthy()

  // Vencida: lo mismo que inválida.
  await ownerDb
    .update(patientDataRequest)
    .set({ copyUntil: new Date(Date.now() - 1000) })
    .where(eq(patientDataRequest.id, request.id))
  const expired = await run((tx) => getRecordCopyView(tx, "org_a", token, { storage })).catch(
    (error: unknown) => error,
  )
  const invalid = await run((tx) =>
    getRecordCopyView(tx, "org_a", "f".repeat(64), { storage }),
  ).catch((error: unknown) => error)
  expect(expired).toMatchObject({ status: 404 })
  expect(invalid).toMatchObject({ status: 404 })
  expect((expired as Error).message).toBe((invalid as Error).message)
  await ownerDb
    .update(patientDataRequest)
    .set({ copyUntil: new Date(Date.now() + 86_400_000) })
    .where(eq(patientDataRequest.id, request.id))

  // Bloqueada (o borrada, que la bloquea): la historia no existe para el enlace.
  // (bloqueada es archivada y con quién la bloqueó: `contact_record_locked_check`).
  await ownerDb
    .update(contact)
    .set({ recordLockedAt: new Date(), recordLockedBy: f.actor, isActive: false })
    .where(eq(contact.id, selfId))
  await expect(
    run((tx) => getRecordCopyView(tx, "org_a", token, { storage })),
  ).rejects.toMatchObject({ status: 404 })
  await ownerDb
    .update(contact)
    .set({ recordLockedAt: null, recordLockedBy: null, isActive: true })
    .where(eq(contact.id, selfId))

  // «Quitar enlace» la corta también.
  await run((tx) => revokePersonalLinks(tx, "org_a", f.actor, f.patient.id))
  await expect(
    run((tx) => getRecordCopyView(tx, "org_a", token, { storage })),
  ).rejects.toMatchObject({ status: 404 })
})

it("sin documento en su ficha, la copia se recibe en la clínica", async () => {
  const { f, run, storage, doc, token } = await sentCopy()
  await setTestPatientIdentity(ownerDb, f.patient.id, { docNumber: null, docType: null })
  const view = await run((tx) => getRecordCopyView(tx, "org_a", token, { storage }))
  expect(view.canDownload).toBe(false)
  await expect(run((tx) => checkRecordCopyDocument(tx, "org_a", token, doc))).rejects.toMatchObject(
    {
      code: "RECORD_COPY_IN_CLINIC",
    },
  )
  expect(
    await ownerDb
      .select()
      .from(patientRecordDownload)
      .where(
        and(
          eq(patientRecordDownload.organizationId, "org_a"),
          eq(patientRecordDownload.patientId, f.patient.id),
        ),
      ),
  ).toEqual([])
})
