import { AGREEMENT_VERSION } from "@odentia/auth/legal"
import { saasClient, saasClientFile, saasInboundEmail } from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import {
  clientFileDeleteAfter,
  clientFileKey,
  clientFileUrl,
  deleteClientFile,
  dueClientFileDeletions,
  listClientFiles,
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

describe("borrado a los 30 días", () => {
  it("borra lo vencido y los adjuntos de un correo sin cliente; lo que falla vuelve a salir", async () => {
    const now = new Date()
    const old = new Date(now.getTime() - 31 * DAY)
    const expiredKey = clientFileKey(clientId, "pdf")
    const failingKey = clientFileKey(clientId, "pdf")
    const keepKey = clientFileKey(clientId, "pdf")
    // Dos llegaron hace 31 días; el otro, hoy (lo de la clínica nunca pasa de 30 días desde que llega).
    for (const [key, deleteAfter, at] of [
      [expiredKey, limaDate(old), old],
      [failingKey, limaDate(old), old],
      [keepKey, null, now],
    ] as const)
      await registerClientFile(
        ownerDb,
        admin,
        {
          clientId,
          kind: "correo",
          filename: "adjunto.pdf",
          objectKey: key,
          contentType: "application/pdf",
          sizeBytes: 5,
          deleteAfter,
        },
        at,
      )
    const orphanAttachments: StoredInboundAttachment[] = [
      {
        filename: "datos.xlsx",
        contentType: "text/csv",
        size: 3,
        fileId: null,
        objectKey: "inbound/huerfano.csv",
      },
    ]
    const [orphan] = await ownerDb
      .insert(saasInboundEmail)
      .values({
        mailbox: "soporte",
        product: "dental",
        messageId: "<huerfano@files.test>",
        fromAddress: "nadie@files.test",
        toAddress: "soporte@odentia32.com",
        receivedAt: old,
        attachments: orphanAttachments,
      })
      .returning({ id: saasInboundEmail.id })
    if (!orphan) throw new Error("sin correo")

    const due = await dueClientFileDeletions(ownerDb, now)
    expect(due.map((item) => item.objectKey).sort()).toEqual(
      [expiredKey, failingKey, "inbound/huerfano.csv"].sort(),
    )

    const storage = fakeStorage(failingKey)
    expect(await purgeDueClientFiles(ownerDb, storage, now)).toEqual({ deleted: 2, failed: 1 })
    expect(storage.deleted.sort()).toEqual([expiredKey, "inbound/huerfano.csv"].sort())
    const rows = await ownerDb
      .select({ key: saasClientFile.objectKey, deletedAt: saasClientFile.deletedAt })
      .from(saasClientFile)
      .where(eq(saasClientFile.clientId, clientId))
    expect(rows.find((row) => row.key === expiredKey)?.deletedAt).not.toBeNull()
    expect(rows.find((row) => row.key === failingKey)?.deletedAt).toBeNull()
    expect(rows.find((row) => row.key === keepKey)?.deletedAt).toBeNull()
    const [email] = await ownerDb
      .select({ attachments: saasInboundEmail.attachments })
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.id, orphan.id))
    expect(email?.attachments).toEqual([
      { filename: "datos.xlsx", contentType: "text/csv", size: 3, fileId: null },
    ])

    // Lo que no se pudo borrar sale en la próxima pasada; lo demás ya no.
    expect((await dueClientFileDeletions(ownerDb, now)).map((item) => item.objectKey)).toEqual([
      failingKey,
    ])
  })
})

describe("el texto del correo", () => {
  it("se borra a los 30 días de llegar, con o sin cliente; el de hoy se queda", async () => {
    const now = new Date()
    const old = new Date(now.getTime() - 31 * DAY)
    const insert = async (messageId: string, receivedAt: Date, client: string | null) => {
      const [row] = await ownerDb
        .insert(saasInboundEmail)
        .values({
          clientId: client,
          mailbox: "soporte",
          product: "dental",
          messageId,
          fromAddress: "clinica@files.test",
          toAddress: "soporte@odentia32.com",
          textBody: "Rosa Díaz, DNI 12345678, 999 888 777",
          receivedAt,
        })
        .returning({ id: saasInboundEmail.id })
      return row?.id ?? ""
    }
    const oldWithClient = await insert("<texto-viejo@files.test>", old, clientId)
    const oldOrphan = await insert("<texto-viejo-solo@files.test>", old, null)
    const fresh = await insert("<texto-nuevo@files.test>", now, clientId)
    await purgeDueClientFiles(ownerDb, fakeStorage(), now)
    const text = async (id: string) =>
      (
        await ownerDb
          .select({ text: saasInboundEmail.textBody })
          .from(saasInboundEmail)
          .where(eq(saasInboundEmail.id, id))
      )[0]?.text
    expect(await text(oldWithClient)).toBeNull()
    expect(await text(oldOrphan)).toBeNull()
    expect(await text(fresh)).toContain("Rosa")
  })
})
