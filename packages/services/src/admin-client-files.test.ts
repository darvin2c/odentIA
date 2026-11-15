import { AGREEMENT_VERSION } from "@odentia/auth/legal"
import type { Db } from "@odentia/db"
import { saasClient, saasClientFile, saasInboundEmail } from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import { and, eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import {
  cargaDeleteAfter,
  clearDueCargaNow,
  clientFileDeleteAfter,
  clientFileKey,
  clientFileUrl,
  deleteClientFile,
  dueClientFileDeletions,
  isLikelyCarga,
  likelyCargaSql,
  listClientFiles,
  markClientFileCarga,
  purgeDueClientFiles,
  registerClientFile,
  type StoredInboundAttachment,
} from "./admin-client-files.js"
import type { AdminActor } from "./admin-core.js"
import { limaDate } from "./peru-business-days.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Documentos de un cliente del ARM: quién ve qué, la URL firmada y el borrado a los 30 días. */
setupTestDb()
const admin: AdminActor = { userId: "cf-admin", role: "admin" }
const support: AdminActor = { userId: "cf-support", role: "support" }
const ORG = "cf-org"
const DAY = 86_400_000
let clientId: string
let otherClientId: string

/** Un almacenamiento de prueba que recuerda lo que borró y puede fallar con una clave. */
function fakeStorage(failOn?: string) {
  const deleted: string[] = []
  return {
    deleted,
    async attachmentUrl(key: string) {
      return `https://bucket.test/${key}?firma=1`
    },
    async deleteAttachment(key: string) {
      if (key === failOn) throw new Error("se cortó")
      deleted.push(key)
    },
  }
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Administración", email: "ada@files.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@files.test" },
  ])
  await insertOrg(ownerDb, ORG, "cf-clinica")
  const [a] = await ownerDb
    .insert(saasClient)
    .values({ name: "Clínica Documentos (ficticia)", product: "dental", organizationId: ORG })
    .returning({ id: saasClient.id })
  const [b] = await ownerDb
    .insert(saasClient)
    .values({ name: "Óptica Otra (ficticia)", product: "optical" })
    .returning({ id: saasClient.id })
  if (!a || !b) throw new Error("sin clientes")
  clientId = a.id
  otherClientId = b.id
  await ownerDb
    .insert(processingAgreementAcceptance)
    .values({ organizationId: ORG, version: AGREEMENT_VERSION, acceptedBy: admin.userId })
})

describe("registrar", () => {
  it("lo que manda la clínica es solo de Administración y se borra a los 30 días", async () => {
    const now = new Date()
    const file = await registerClientFile(
      ownerDb,
      admin,
      {
        clientId,
        kind: "archivo_clinica",
        filename: "../agenda exportada.xlsx",
        objectKey: clientFileKey(clientId, "xlsx"),
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 2048,
        adminOnly: false,
        deleteAfter: null,
      },
      now,
    )
    expect(file).toMatchObject({
      adminOnly: true,
      filename: "agenda exportada.xlsx",
      source: "persona",
    })
    expect(file.deleteAfter).toBe(clientFileDeleteAfter(now))
    expect(file.createdBy).toEqual({ userId: admin.userId, name: "Ada Administración" })
  })

  it("Soporte no registra la carga ni lo de la clínica; sí lo que puede ver", async () => {
    await expect(
      registerClientFile(ownerDb, support, {
        clientId,
        kind: "archivo_clinica",
        filename: "pacientes.csv",
        objectKey: clientFileKey(clientId, "csv"),
        contentType: "text/csv",
        sizeBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    const shared = await registerClientFile(ownerDb, support, {
      clientId,
      kind: "presentacion",
      filename: "presentacion.pdf",
      objectKey: clientFileKey(clientId, "pdf"),
      contentType: "application/pdf",
      sizeBytes: 10,
      adminOnly: false,
    })
    expect(shared).toMatchObject({ adminOnly: false, deleteAfter: null })
  })

  it("la clave tiene que ser de ese cliente", async () => {
    await expect(
      registerClientFile(ownerDb, admin, {
        clientId,
        kind: "otro",
        filename: "x.pdf",
        objectKey: clientFileKey(otherClientId, "pdf"),
        contentType: "application/pdf",
        sizeBytes: 1,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", fields: { objectKey: expect.any(String) } })
    expect(() => clientFileKey(clientId, "p/df")).toThrow()
  })
})

describe("listar, descargar y borrar", () => {
  it("Soporte no ve lo admin_only; el contrato de encargo sale de su aceptación", async () => {
    const forAdmin = await listClientFiles(ownerDb, admin, clientId)
    const forSupport = await listClientFiles(ownerDb, support, clientId)
    expect(forAdmin.items.some((item) => item.kind === "archivo_clinica")).toBe(true)
    expect(forSupport.items.every((item) => !item.adminOnly)).toBe(true)
    expect(forSupport.items.map((item) => item.kind)).toEqual(["presentacion"])
    expect(forAdmin.agreement).toMatchObject({
      version: AGREEMENT_VERSION,
      acceptedBy: "Ada Administración",
    })
    expect((await listClientFiles(ownerDb, admin, otherClientId)).agreement).toBeNull()
    await expect(
      listClientFiles(ownerDb, admin, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("la URL firmada deja auditoría; lo de Administración no existe para Soporte", async () => {
    const storage = fakeStorage()
    const secret = (await listClientFiles(ownerDb, admin, clientId)).items.find(
      (item) => item.kind === "archivo_clinica",
    )
    if (!secret) throw new Error("sin archivo")
    await expect(clientFileUrl(ownerDb, support, storage, secret.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const { url, filename } = await clientFileUrl(ownerDb, admin, storage, secret.id)
    expect(url).toContain(`clients/${clientId}/`)
    expect(filename).toBe("agenda exportada.xlsx")
    const audits = await ownerDb
      .select({ actor: adminAudit.actorUserId })
      .from(adminAudit)
      .where(
        and(eq(adminAudit.action, "client_file.downloaded"), eq(adminAudit.entityId, secret.id)),
      )
    expect(audits).toEqual([{ actor: admin.userId }])
  })

  it("borrar es solo de Administración: queda marcado y sale de la lista", async () => {
    const [target] = (await listClientFiles(ownerDb, support, clientId)).items
    if (!target) throw new Error("sin archivo")
    await expect(deleteClientFile(ownerDb, support, target.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    const { objectKey } = await deleteClientFile(ownerDb, admin, target.id)
    expect(objectKey).toMatch(new RegExp(`^clients/${clientId}/`))
    expect(
      (await listClientFiles(ownerDb, admin, clientId)).items.some((item) => item.id === target.id),
    ).toBe(false)
    await expect(deleteClientFile(ownerDb, admin, target.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })
})

/** Un correo a soporte@ con un adjunto ya registrado como documento del cliente (`correo`, sin marcar). */
async function emailWithAttachment(
  messageId: string,
  receivedAt: Date,
  filename = "pacientes.xlsx",
  client: string = clientId,
) {
  const objectKey = clientFileKey(client, "xlsx")
  const [email] = await ownerDb
    .insert(saasInboundEmail)
    .values({
      clientId: client,
      mailbox: "soporte",
      product: "dental",
      messageId,
      fromAddress: "clinica@files.test",
      toAddress: "soporte@odentia32.com",
      textBody: "Rosa Díaz, DNI 12345678, 999 888 777",
      notice: "Un adjunto no entró: lista.zip",
      receivedAt,
      attachments: [],
    })
    .returning({ id: saasInboundEmail.id })
  if (!email) throw new Error("sin correo")
  const file = await registerClientFile(ownerDb, null, {
    clientId: client,
    kind: "correo",
    filename,
    objectKey,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 5,
    deleteAfter: null,
    source: "correo",
    receivedAt,
    inboundEmailId: email.id,
  })
  const attachments: StoredInboundAttachment[] = [
    {
      filename,
      contentType: file.contentType,
      size: 5,
      fileId: file.id,
      objectKey,
    },
  ]
  await ownerDb
    .update(saasInboundEmail)
    .set({ attachments })
    .where(eq(saasInboundEmail.id, email.id))
  return { emailId: email.id, fileId: file.id, objectKey }
}

async function emailRow(id: string) {
  const [row] = await ownerDb.select().from(saasInboundEmail).where(eq(saasInboundEmail.id, id))
  return row
}

async function fileRow(id: string) {
  const [row] = await ownerDb.select().from(saasClientFile).where(eq(saasClientFile.id, id))
  return row
}

describe("borrado a los 30 días", () => {
  it("solo se borra la carga vencida; un adjunto con fecha o un correo sin cliente se guardan; lo que falla vuelve a salir", async () => {
    const now = new Date()
    const old = new Date(now.getTime() - 31 * DAY)
    const register = (
      kind: "archivo_clinica" | "correo",
      key: string,
      deleteAfter: string | null,
    ) =>
      registerClientFile(
        ownerDb,
        admin,
        {
          clientId,
          kind,
          filename: "adjunto.pdf",
          objectKey: key,
          contentType: "application/pdf",
          sizeBytes: 5,
          deleteAfter,
          receivedAt: old,
        },
        now,
      )
    const expiredKey = clientFileKey(clientId, "pdf")
    const failingKey = clientFileKey(clientId, "pdf")
    const legacyKey = clientFileKey(clientId, "pdf")
    // La carga que llegó hace 31 días ya pasó su día; el adjunto con fecha lo registró el código anterior.
    const expired = await register("archivo_clinica", expiredKey, null)
    await register("archivo_clinica", failingKey, null)
    await register("correo", legacyKey, limaDate(old))
    expect(expired.deleteAfter).toBe(cargaDeleteAfter(old, now))
    const orphanAttachments: StoredInboundAttachment[] = [
      {
        filename: "datos.xlsx",
        contentType: "text/csv",
        size: 3,
        fileId: null,
        objectKey: "inbound/huerfano.csv",
      },
    ]
    await ownerDb.insert(saasInboundEmail).values({
      mailbox: "soporte",
      product: "dental",
      messageId: "<huerfano@files.test>",
      fromAddress: "nadie@files.test",
      toAddress: "soporte@odentia32.com",
      receivedAt: old,
      attachments: orphanAttachments,
    })

    const due = await dueClientFileDeletions(ownerDb, now)
    expect(due.map((item) => item.objectKey).sort()).toEqual([expiredKey, failingKey].sort())

    const storage = fakeStorage(failingKey)
    expect(await purgeDueClientFiles(ownerDb, storage, now)).toMatchObject({
      deleted: 1,
      failed: 1,
    })
    expect(storage.deleted).toEqual([expiredKey])
    const rows = await ownerDb
      .select({ key: saasClientFile.objectKey, deletedAt: saasClientFile.deletedAt })
      .from(saasClientFile)
      .where(eq(saasClientFile.clientId, clientId))
    expect(rows.find((row) => row.key === expiredKey)?.deletedAt).not.toBeNull()
    expect(rows.find((row) => row.key === failingKey)?.deletedAt).toBeNull()
    expect(rows.find((row) => row.key === legacyKey)?.deletedAt).toBeNull()
    // La auditoría dice qué archivos y de qué clientes («Se borraron sin cargar»).
    const [audit] = await ownerDb
      .select({ metadata: adminAudit.metadata })
      .from(adminAudit)
      .where(eq(adminAudit.action, "kairos.client_files_expired"))
    expect(audit?.metadata).toEqual({ count: 1, fileIds: [expired.id], clientIds: [clientId] })

    // Lo que no se pudo borrar sale en la próxima pasada; lo demás ya no.
    expect((await dueClientFileDeletions(ownerDb, now)).map((item) => item.objectKey)).toEqual([
      failingKey,
    ])
    await purgeDueClientFiles(ownerDb, fakeStorage(), now)
    expect(await dueClientFileDeletions(ownerDb, now)).toEqual([])
  })

  it("el plazo de la carga se topa a los 30 días de llegar, aunque pidan más", async () => {
    const now = new Date()
    const receivedAt = new Date(now.getTime() - 10 * DAY)
    const file = await registerClientFile(
      ownerDb,
      admin,
      {
        clientId,
        kind: "archivo_clinica",
        filename: "agenda.csv",
        objectKey: clientFileKey(clientId, "csv"),
        contentType: "text/csv",
        sizeBytes: 5,
        deleteAfter: "2099-01-01",
        receivedAt,
      },
      now,
    )
    expect(file.deleteAfter).toBe(cargaDeleteAfter(receivedAt, now))
    expect(file.receivedAt).toEqual(receivedAt)
    expect(file.cargaAt).toEqual(now)
    // Lo que dice llegar en el futuro cuenta desde ahora.
    expect(cargaDeleteAfter(new Date(now.getTime() + 5 * DAY), now)).toBe(
      clientFileDeleteAfter(now),
    )
  })
})

describe("el texto del correo", () => {
  it("solo el del correo con un adjunto marcado como la carga se borra a los 30 días; lo demás se queda", async () => {
    const now = new Date()
    const old = new Date(now.getTime() - 31 * DAY)
    const marked = await emailWithAttachment("<texto-carga@files.test>", old)
    const freshMarked = await emailWithAttachment(
      "<texto-carga-nuevo@files.test>",
      new Date(now.getTime() - 2 * DAY),
    )
    const unmarked = await emailWithAttachment("<texto-sin-marcar@files.test>", old)
    // Se marcan en la base (sin `markClientFileCarga`, que lo borraría al marcarlo).
    for (const id of [marked.fileId, freshMarked.fileId])
      await ownerDb
        .update(saasClientFile)
        .set({ kind: "archivo_clinica", cargaAt: now, deleteAfter: limaDate(now) })
        .where(eq(saasClientFile.id, id))
    const [orphan] = await ownerDb
      .insert(saasInboundEmail)
      .values({
        mailbox: "soporte",
        product: "dental",
        messageId: "<texto-viejo-solo@files.test>",
        fromAddress: "clinica@files.test",
        toAddress: "soporte@odentia32.com",
        textBody: "Rosa Díaz, DNI 12345678",
        receivedAt: old,
        attachments: [
          { filename: "pacientes.xlsx", contentType: "text/csv", size: 3, fileId: null },
        ],
      })
      .returning({ id: saasInboundEmail.id })
    const result = await purgeDueClientFiles(ownerDb, fakeStorage(), now)
    expect(result.textsCleared).toBe(1)
    expect(await emailRow(marked.emailId)).toMatchObject({ textBody: null, notice: null })
    expect((await emailRow(freshMarked.emailId))?.textBody).toContain("Rosa")
    expect((await emailRow(unmarked.emailId))?.textBody).toContain("Rosa")
    expect((await emailRow(orphan?.id ?? ""))?.textBody).toContain("Rosa")
    // El objeto borrado ya no está en el correo; el adjunto sigue nombrado.
    expect((await emailRow(marked.emailId))?.attachments).toEqual([
      {
        filename: "pacientes.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 5,
        fileId: marked.fileId,
      },
    ])
  })
})

describe("es la carga de datos", () => {
  it("a los 5 días de llegar: pasa a la carga, se borra a los 30 días y queda anotado quién", async () => {
    const now = new Date()
    const receivedAt = new Date(now.getTime() - 5 * DAY)
    const { fileId, objectKey } = await emailWithAttachment("<carga-5@files.test>", receivedAt)
    const before = (await listClientFiles(ownerDb, admin, clientId, now)).items.find(
      (item) => item.id === fileId,
    )
    // La pantalla dice el día con la cuenta del servidor, antes de marcarlo.
    expect(before).toMatchObject({
      kind: "correo",
      deleteAfter: null,
      cargaDeleteAfter: cargaDeleteAfter(receivedAt, now),
      cargaDueNow: false,
    })
    const out = await markClientFileCarga(ownerDb, admin, fileId, now)
    expect(out).toMatchObject({ dueNow: false, objectKey })
    expect(out.file).toMatchObject({
      kind: "archivo_clinica",
      adminOnly: true,
      deleteAfter: cargaDeleteAfter(receivedAt, now),
      cargaDeleteAfter: null,
    })
    expect(out.file.cargaAt).toEqual(now)
    const audits = await ownerDb
      .select({ actor: adminAudit.actorUserId, metadata: adminAudit.metadata })
      .from(adminAudit)
      .where(
        and(eq(adminAudit.action, "client_file.marked_carga"), eq(adminAudit.entityId, fileId)),
      )
    expect(audits).toEqual([
      {
        actor: admin.userId,
        metadata: expect.objectContaining({ clientId, deletedNow: false }),
      },
    ])
    // Dos veces es lo mismo, sin otra auditoría.
    expect(await markClientFileCarga(ownerDb, admin, fileId, now)).toMatchObject({
      dueNow: false,
      file: { kind: "archivo_clinica" },
    })
    expect(
      await ownerDb
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(
          and(eq(adminAudit.action, "client_file.marked_carga"), eq(adminAudit.entityId, fileId)),
        ),
    ).toHaveLength(1)
  })

  it("Soporte no marca, una carta no es la carga y lo ya borrado no existe", async () => {
    const { fileId } = await emailWithAttachment("<carga-roles@files.test>", new Date())
    await expect(markClientFileCarga(ownerDb, support, fileId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    const letter = await registerClientFile(ownerDb, admin, {
      clientId,
      kind: "carta",
      filename: "carta.pdf",
      objectKey: clientFileKey(clientId, "pdf"),
      contentType: "application/pdf",
      sizeBytes: 5,
    })
    await expect(markClientFileCarga(ownerDb, admin, letter.id)).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { fileId: expect.any(String) },
    })
    await deleteClientFile(ownerDb, admin, fileId)
    await expect(markClientFileCarga(ownerDb, admin, fileId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("a los 31 días se borra al marcarlo: el texto en la misma transacción y el objeto después; si falla, la pasada siguiente", async () => {
    const now = new Date()
    const old = new Date(now.getTime() - 31 * DAY)
    const { emailId, fileId, objectKey } = await emailWithAttachment("<carga-31@files.test>", old)
    const before = (await listClientFiles(ownerDb, admin, clientId, now)).items.find(
      (item) => item.id === fileId,
    )
    expect(before?.cargaDueNow).toBe(true)
    const out = await ownerDb.transaction((tx) => markClientFileCarga(tx as Db, admin, fileId, now))
    expect(out.dueNow).toBe(true)
    expect(await emailRow(emailId)).toMatchObject({ textBody: null, notice: null })
    expect((await fileRow(fileId))?.deletedAt).toBeNull()
    // El almacenamiento falla al borrar ahora: queda vencido y lo toma la limpieza.
    await expect(
      clearDueCargaNow(ownerDb, fakeStorage(objectKey), fileId, objectKey, now),
    ).rejects.toThrow()
    expect((await fileRow(fileId))?.deletedAt).toBeNull()
    expect((await dueClientFileDeletions(ownerDb, now)).map((item) => item.fileId)).toContain(
      fileId,
    )
    const storage = fakeStorage()
    await purgeDueClientFiles(ownerDb, storage, now)
    expect(storage.deleted).toContain(objectKey)
    expect((await fileRow(fileId))?.deletedAt).not.toBeNull()
  })

  it("borrar ahora lo marcado vencido: objeto, registro y clave del correo", async () => {
    const now = new Date()
    const old = new Date(now.getTime() - 40 * DAY)
    const { emailId, fileId, objectKey } = await emailWithAttachment("<carga-40@files.test>", old)
    const out = await markClientFileCarga(ownerDb, admin, fileId, now)
    const storage = fakeStorage()
    await clearDueCargaNow(ownerDb, storage, fileId, out.objectKey, now)
    expect(storage.deleted).toEqual([objectKey])
    expect((await fileRow(fileId))?.deletedAt).not.toBeNull()
    expect((await emailRow(emailId))?.attachments).toEqual([
      expect.not.objectContaining({ objectKey: expect.anything() }),
    ])
  })
})

describe("lo que puede ser la carga", () => {
  it("Excel, CSV o Word, por su tipo o su nombre; en TS y en SQL igual", async () => {
    expect(isLikelyCarga({ contentType: "text/csv", filename: "x" })).toBe(true)
    expect(
      isLikelyCarga({ contentType: "application/octet-stream", filename: "Pacientes.XLSX" }),
    ).toBe(true)
    expect(isLikelyCarga({ contentType: "application/pdf", filename: "contrato.pdf" })).toBe(false)
    expect(isLikelyCarga({ contentType: "image/png", filename: "captura.png" })).toBe(false)
    const rows = (await ownerDb.execute(
      sql`select f.filename, f.content_type, ${likelyCargaSql("f")} as likely
      from admin.saas_client_file f where f.client_id = ${clientId}`,
    )) as unknown as Array<{ filename: string; content_type: string; likely: boolean }>
    expect(rows.some((row) => row.likely)).toBe(true)
    expect(rows.some((row) => !row.likely)).toBe(true)
    for (const row of rows)
      expect(row.likely, row.filename).toBe(
        isLikelyCarga({ filename: row.filename, contentType: row.content_type }),
      )
    expect(() => likelyCargaSql("f; drop")).toThrow()
  })
})
