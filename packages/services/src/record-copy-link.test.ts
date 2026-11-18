/**
 * La copia de su historia por su enlace (mesa del 18 nov): el envío pone dentro del PDF
 * (nunca en el texto del mensaje) un token propio, de un solo propósito, que no es «Su
 * enlace», y deja el pedido sirviendo la copia hasta el final del día del envío + 7;
 * «Enviar de nuevo» es la misma operación y reemplaza el token. La página pública pide su
 * documento (como la firma a distancia), cuenta cada intento antes de comparar (como el
 * PIN del portal), tiene un tope de descargas, deja cada una registrada y, vencida,
 * reemplazada, bloqueada o inválida, responde lo mismo. El mensaje queda encolado.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { patientDataRequest, patientRecordDownload } from "@odentia/db/schema/clinical"
import { channelConnection, contact, message } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, expect, it } from "vitest"
import { issuePersonalLink } from "./booking-links.js"
import { listClinicalAccess } from "./clinical-access.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  createDataRequest,
  listDataRequests,
  RECORD_COPY_ATTEMPTS,
  RECORD_COPY_DOWNLOADS,
  verifyDataRequest,
} from "./data-requests.js"
import { sendPatientRecordCopy } from "./patient-record.js"
import { configurePublicLinks } from "./public-links.js"
import { issueRecordCopyLink } from "./record-copy-link.js"
import {
  checkRecordCopyDocument,
  getRecordCopyView,
  reserveRecordCopyAttempt,
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

/** Una paciente adulta con su documento, su correo y su pedido de copia comprobado y enviado. */
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
  // El token viaja solo dentro del PDF: la prueba lo pide a la misma operación del envío,
  // que lo reemplaza (el del PDF deja de servir, como con «Enviar de nuevo»).
  const issue = async () => {
    const link = await run((tx) => issueRecordCopyLink(tx, "org_a", { requestId: request.id }))
    return new URL(link!.url).searchParams.get("token")!
  }
  const token = await issue()
  // Como la ruta: el intento se cuenta en su propia transacción y después se compara.
  const attempt = async <T>(fn: (tx: Db) => Promise<T>) => {
    await run((tx) => reserveRecordCopyAttempt(tx, "org_a", token))
    return run(fn)
  }
  return { f, run, selfId, request, sent, send, stored, storage, doc, token, issue, attempt }
}

/** «2026-11-25, 23:59» en la zona de la clínica de prueba (Lima). */
const lima = (at: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at)

it("el envío pone un token propio en el PDF y no en el mensaje, hasta el final del día + 7, y «Enviar de nuevo» lo reemplaza", async () => {
  const { f, run, request, sent, send, stored, storage, token, issue, selfId } = await sentCopy()
  expect(token).toMatch(/^[0-9a-f]{64}$/)
  expect(sent.request.status).toBe("respondida")
  expect(sent.request.resolution).toMatch(/enlace para bajar la copia completa/)
  expect(sent.request.copy).toMatchObject({ downloads: 0, lastDownloadAt: null })
  // «Hasta el 25 de noviembre» sirve todo ese día en la zona de la clínica.
  const until = new Date(sent.request.copy!.until)
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
  const [y, m, d] = today.split("-").map(Number) as [number, number, number]
  const day = (plus: number) => new Date(Date.UTC(y, m - 1, d + plus)).toISOString().slice(0, 10)
  expect(lima(until)).toBe(`${day(7)}, 23:59`)
  expect(lima(new Date(until.getTime() + 1))).toBe(`${day(8)}, 00:00`)
  // El texto del mensaje lo ve recepción: no lleva el enlace ni el token.
  const [queued] = await ownerDb
    .select()
    .from(message)
    .where(eq(message.conversationId, sent.conversationId))
  const text = JSON.stringify(queued!)
  expect(text).not.toContain(token)
  expect(text).not.toMatch(/abre=copia|token=/)
  expect(text).toMatch(/En su primera página está el enlace/)
  expect(stored).toHaveLength(1)
  // Ninguna ruta del equipo devuelve el token ni su huella: la fila dice solo hasta cuándo y si la bajó.
  const [listed] = await run((tx) =>
    listDataRequests(tx, "org_a", f.patient.id, { id: request.id }),
  )
  expect(JSON.stringify(listed)).not.toMatch(/token|hash/i)

  // «Su enlace» (el que recepción muestra o copia) no abre la copia.
  const personal = await run((tx) =>
    issuePersonalLink(
      tx,
      "org_a",
      { contactId: selfId, patientId: f.patient.id, createdBy: f.actor },
      { secretsKey },
    ),
  )
  await expect(
    run((tx) => getRecordCopyView(tx, "org_a", personal.token, { storage })),
  ).rejects.toMatchObject({ status: 404 })
  await expect(
    run((tx) => reserveRecordCopyAttempt(tx, "org_a", personal.token)),
  ).rejects.toMatchObject({ status: 404 })
  await expect(
    run((tx) => getRecordCopyView(tx, "org_a", token, { storage })),
  ).resolves.toBeTruthy()

  // Un token nuevo reemplaza al anterior.
  const replaced = await issue()
  await expect(
    run((tx) => getRecordCopyView(tx, "org_a", token, { storage })),
  ).rejects.toMatchObject({ status: 404 })
  await expect(
    run((tx) => getRecordCopyView(tx, "org_a", replaced, { storage })),
  ).resolves.toBeTruthy()

  // «Enviar de nuevo»: sigue respondido, otro token (el de antes ya no sirve) y vuelve a contar los intentos.
  await ownerDb
    .update(patientDataRequest)
    .set({ copyFailedAttempts: 3 })
    .where(eq(patientDataRequest.id, request.id))
  const [before] = await ownerDb
    .select()
    .from(patientDataRequest)
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
  expect(row!.copyTokenHash).not.toBe(before!.copyTokenHash)
  await expect(
    run((tx) => getRecordCopyView(tx, "org_a", replaced, { storage })),
  ).rejects.toMatchObject({ status: 404 })
})

it("la página: abrir no registra; su documento abre la descarga, que queda registrada y en «Consultas a la historia clínica»", async () => {
  const { f, run, request, storage, doc, token, attempt } = await sentCopy()
  const view = await run((tx) => getRecordCopyView(tx, "org_a", token, { storage }))
  expect(view).toMatchObject({
    firstName: "Rosa",
    patientFirstName: null,
    canDownload: true,
    documentLabel: "DNI",
    timezone: "America/Lima",
    downloadsLeft: RECORD_COPY_DOWNLOADS,
  })
  expect(
    await ownerDb
      .select()
      .from(patientRecordDownload)
      .where(eq(patientRecordDownload.dataRequestId, request.id)),
  ).toEqual([])
  const failed = async () =>
    (
      await ownerDb.select().from(patientDataRequest).where(eq(patientDataRequest.id, request.id))
    )[0]!.copyFailedAttempts

  // Un documento que no es el suyo se dice en su campo y queda contado; el suyo (con puntos) no cuenta.
  await expect(
    attempt((tx) => checkRecordCopyDocument(tx, "org_a", token, "11111111")),
  ).rejects.toMatchObject({
    code: "RECORD_COPY_DOCUMENT",
    fields: { docNumber: expect.any(String) },
  })
  expect(await failed()).toBe(1)
  const dotted = `${doc.slice(0, 2)}.${doc.slice(2, 5)}.${doc.slice(5)}`
  await expect(
    attempt((tx) => checkRecordCopyDocument(tx, "org_a", token, dotted)),
  ).resolves.toEqual({ ok: true })
  expect(await failed()).toBe(1)

  const copy = await attempt((tx) =>
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
  expect(await failed()).toBe(1)
  const downloads = await ownerDb
    .select()
    .from(patientRecordDownload)
    .where(eq(patientRecordDownload.dataRequestId, request.id))
  expect(downloads).toHaveLength(1)
  expect(downloads[0]).toMatchObject({ patientId: f.patient.id, ip: "203.0.113.5" })
  const [listed] = await run((tx) =>
    listDataRequests(tx, "org_a", f.patient.id, { id: request.id }),
  )
  expect(listed!.copy).toMatchObject({ downloads: 1 })
  expect(listed!.copy?.lastDownloadAt).not.toBeNull()
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
  await expect(
    attempt((tx) =>
      startRecordCopyDownload(tx, "org_a", token, { docNumber: "999" }, {}, { storage }),
    ),
  ).rejects.toMatchObject({ code: "RECORD_COPY_DOCUMENT" })
})

it("cada intento se cuenta antes de comparar: muchos a la vez no pasan del tope", async () => {
  const { run, storage, token } = await sentCopy()
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, () => run((tx) => reserveRecordCopyAttempt(tx, "org_a", token))),
  )
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(RECORD_COPY_ATTEMPTS)
  await expect(
    run((tx) => getRecordCopyView(tx, "org_a", token, { storage })),
  ).rejects.toMatchObject({ status: 404 })
})

it("tope de descargas (también al comprobar); vencida, bloqueada o inválida responden lo mismo", async () => {
  const { f, run, request, storage, doc, token, selfId, attempt } = await sentCopy()
  for (let i = 0; i < RECORD_COPY_DOWNLOADS; i++)
    await attempt((tx) =>
      startRecordCopyDownload(tx, "org_a", token, { docNumber: doc }, {}, { storage }),
    )
  // Agotadas, «Descargar» lo dice al comprobar (la página lo muestra), sin contar un intento.
  await expect(run((tx) => reserveRecordCopyAttempt(tx, "org_a", token))).rejects.toMatchObject({
    code: "RECORD_COPY_LIMIT",
  })
  await expect(run((tx) => checkRecordCopyDocument(tx, "org_a", token, doc))).rejects.toMatchObject(
    { code: "RECORD_COPY_LIMIT" },
  )
  expect(
    (await run((tx) => getRecordCopyView(tx, "org_a", token, { storage }))).downloadsLeft,
  ).toBe(0)
  await ownerDb
    .delete(patientRecordDownload)
    .where(eq(patientRecordDownload.dataRequestId, request.id))

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
  await expect(run((tx) => reserveRecordCopyAttempt(tx, "org_a", token))).rejects.toMatchObject({
    status: 404,
  })
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
  await expect(
    run((tx) => getRecordCopyView(tx, "org_a", token, { storage })),
  ).resolves.toBeTruthy()
})

it("sin documento en su ficha, la copia se recibe en la clínica", async () => {
  const { f, run, storage, doc, token, attempt } = await sentCopy()
  await setTestPatientIdentity(ownerDb, f.patient.id, { docNumber: null, docType: null })
  const view = await run((tx) => getRecordCopyView(tx, "org_a", token, { storage }))
  expect(view.canDownload).toBe(false)
  await expect(
    attempt((tx) => checkRecordCopyDocument(tx, "org_a", token, doc)),
  ).rejects.toMatchObject({
    code: "RECORD_COPY_IN_CLINIC",
  })
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
