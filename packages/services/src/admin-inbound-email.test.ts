import {
  saasClient,
  saasClientContact,
  saasClientFile,
  saasInboundEmail,
} from "@odentia/db/schema/admin-arm"
import { member, user } from "@odentia/db/schema/auth"
import { saasFollowUp, saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { clientFileDeleteAfter, inboundAttachmentKey } from "./admin-client-files.js"
import type { AdminActor } from "./admin-core.js"
import {
  assignInboundEmail,
  type InboundEmailInput,
  ingestInboundEmail,
} from "./admin-inbound-email.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Correo entrante a soporte@ y contacto@: una vez por Message-ID, emparejado solo por correo exacto. */
setupTestDb()
const admin: AdminActor = { userId: "ie-admin", role: "admin" }
const support: AdminActor = { userId: "ie-support", role: "support" }
const ORG = "ie-org"
let byContact: string
let byRequest: string
let byMember: string
let twinA: string
let twinB: string
let lonely: string

async function client(name: string, organizationId?: string): Promise<string> {
  const [row] = await ownerDb
    .insert(saasClient)
    .values({ name, product: "dental", organizationId })
    .returning({ id: saasClient.id })
  if (!row) throw new Error("sin cliente")
  return row.id
}

function mail(overrides: Partial<InboundEmailInput> = {}): InboundEmailInput {
  return {
    mailbox: "soporte",
    product: "dental",
    messageId: `<${crypto.randomUUID()}@correo.test>`,
    from: "rosa@contacto.test",
    fromName: "Rosa Mamani",
    to: "soporte@odentia32.com",
    subject: "Les mando la agenda",
    text: "Hola, adjunto la agenda.",
    receivedAt: new Date(),
    attachments: [],
    senderVerified: true,
    ...overrides,
  }
}

async function activities(clientId: string) {
  return ownerDb
    .select({
      kind: saasFollowUp.kind,
      direction: saasFollowUp.direction,
      requestId: saasFollowUp.requestId,
      body: saasFollowUp.body,
    })
    .from(saasFollowUp)
    .where(eq(saasFollowUp.clientId, clientId))
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Administración", email: "ada@inbound.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@inbound.test" },
    { id: "ie-member", name: "Dra. Lucía", email: "Lucia@Miembro.test" },
  ])
  await insertOrg(ownerDb, ORG, "ie-clinica")
  await ownerDb.insert(member).values({
    id: "ie-m1",
    organizationId: ORG,
    userId: "ie-member",
    role: "owner",
    createdAt: new Date(),
  })
  byContact = await client("Clínica Contacto (ficticia)")
  byRequest = await client("Clínica Solicitud (ficticia)")
  byMember = await client("Clínica Miembro (ficticia)", ORG)
  twinA = await client("Clínica Gemela A (ficticia)")
  twinB = await client("Clínica Gemela B (ficticia)")
  lonely = await client("Clínica Sin Correo (ficticia)")
  await ownerDb.insert(saasClientContact).values([
    { clientId: byContact, name: "Rosa Mamani", email: "rosa@contacto.test", isPrimary: true },
    { clientId: twinA, name: "Pepe", email: "pepe@gemelas.test" },
    { clientId: twinB, name: "Pepe", email: "pepe@gemelas.test" },
  ])
  // La misma persona también pidió desde la web para otra clínica: el contacto manda.
  await ownerDb.insert(saasWaitlistRequest).values([
    {
      firstName: "Pepe",
      lastName: "Gemelo",
      email: "pepe@gemelas.test",
      phone: "+51987000111",
      clinicName: "Una tercera",
      countryCode: "PE",
      city: "Lima",
      professionals: "1",
      currentTool: "nada",
      clientId: byRequest,
    },
    {
      firstName: "Juana",
      lastName: "Web",
      email: "Juana@Solicitud.test",
      phone: "+51987000222",
      clinicName: "Clínica Solicitud",
      countryCode: "PE",
      city: "Cusco",
      professionals: "2-3",
      currentTool: "cuaderno_excel",
      clientId: byRequest,
    },
  ])
})

describe("ingestInboundEmail", () => {
  it("con contacto: deja la actividad que entró y los adjuntos como documentos de Administración", async () => {
    const receivedAt = new Date(Date.now() - 60_000)
    const key = inboundAttachmentKey("xlsx")
    const result = await ingestInboundEmail(
      ownerDb,
      mail({
        from: " ROSA@contacto.test ",
        receivedAt,
        attachments: [
          { filename: "C:\\fake\\agenda.xlsx", contentType: "text/csv", size: 120, fileKey: key },
        ],
      }),
    )
    expect(result).toMatchObject({ duplicate: false, clientId: byContact, matchedBy: "contacto" })
    expect(result.fileIds).toHaveLength(1)
    const [file] = await ownerDb
      .select()
      .from(saasClientFile)
      .where(eq(saasClientFile.id, result.fileIds[0] ?? ""))
    expect(file).toMatchObject({
      clientId: byContact,
      kind: "correo",
      filename: "agenda.xlsx",
      objectKey: key,
      adminOnly: true,
      source: "correo",
      deleteAfter: clientFileDeleteAfter(receivedAt),
    })
    // Sin `request_id`: un correo que llega no es un contacto nuestro ni mueve la fecha de volver.
    expect(await activities(byContact)).toEqual([
      {
        kind: "correo",
        direction: "entro",
        requestId: null,
        body: "Escribió a soporte@: Les mando la agenda (1 adjunto)",
      },
    ])
    const [row] = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.id, result.id))
    expect(row).toMatchObject({ fromAddress: "rosa@contacto.test", matchedBy: "contacto" })
    expect(row?.attachments).toEqual([
      {
        filename: "agenda.xlsx",
        contentType: "text/csv",
        size: 120,
        fileId: result.fileIds[0],
        objectKey: key,
      },
    ])
  })

  it("lo que llega a hola@ con adjuntos se guarda: no es la carga", async () => {
    const key = inboundAttachmentKey("pdf")
    const result = await ingestInboundEmail(
      ownerDb,
      mail({
        mailbox: "hola",
        to: "hola@odentia32.com",
        from: "rosa@contacto.test",
        subject: "Contrato firmado",
        attachments: [
          { filename: "contrato.pdf", contentType: "application/pdf", size: 120, fileKey: key },
        ],
      }),
    )
    const [file] = await ownerDb
      .select()
      .from(saasClientFile)
      .where(eq(saasClientFile.id, result.fileIds[0] ?? ""))
    expect(file).toMatchObject({ kind: "correo", adminOnly: true, deleteAfter: null })
  })

  it("el mismo Message-ID entra una sola vez", async () => {
    const input = mail({ from: "rosa@contacto.test", subject: "Repetido" })
    const first = await ingestInboundEmail(ownerDb, input)
    const again = await ingestInboundEmail(ownerDb, { ...input, subject: "Otra vez" })
    expect(again).toMatchObject({ id: first.id, duplicate: true, clientId: byContact, fileIds: [] })
    expect(
      (await activities(byContact)).filter((entry) => entry.body.includes("Repetido")),
    ).toHaveLength(1)
  })

  it("por solicitud y por miembro de la cuenta, con el correo exacto sin mayúsculas", async () => {
    expect(await ingestInboundEmail(ownerDb, mail({ from: "juana@solicitud.test" }))).toMatchObject(
      {
        clientId: byRequest,
        matchedBy: "solicitud",
      },
    )
    expect(
      await ingestInboundEmail(ownerDb, mail({ from: "lucia@miembro.test", mailbox: "contacto" })),
    ).toMatchObject({
      clientId: byMember,
      matchedBy: "miembro",
    })
  })

  it("si el correo es de dos clientes no elige, y no baja a la solicitud", async () => {
    const before = (await activities(byRequest)).length
    const result = await ingestInboundEmail(ownerDb, mail({ from: "pepe@gemelas.test" }))
    expect(result).toMatchObject({ clientId: null, matchedBy: null, fileIds: [] })
    expect(await activities(twinA)).toEqual([])
    expect(await activities(byRequest)).toHaveLength(before)
    expect(
      await ingestInboundEmail(ownerDb, mail({ from: "desconocida@nadie.test" })),
    ).toMatchObject({ clientId: null })
  })

  it("rechaza lo que no es un correo, diciendo el campo", async () => {
    await expect(ingestInboundEmail(ownerDb, mail({ from: "no-es-correo" }))).rejects.toMatchObject(
      {
        code: "VALIDATION",
        fields: { from: expect.any(String) },
      },
    )
    await expect(
      ingestInboundEmail(
        ownerDb,
        mail({
          attachments: [
            {
              filename: "x.pdf",
              contentType: "application/pdf",
              size: 1,
              fileKey: "clients/otro/x.pdf",
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" })
  })
})

describe("remitente sin verificar", () => {
  it("no se liga solo aunque el correo sea de un contacto: queda para que una persona diga de quién es", async () => {
    const key = inboundAttachmentKey("xlsx")
    const result = await ingestInboundEmail(
      ownerDb,
      mail({
        from: "rosa@contacto.test",
        subject: "pacientes.xlsx",
        senderVerified: false,
        attachments: [
          { filename: "pacientes.xlsx", contentType: "text/csv", size: 10, fileKey: key },
        ],
      }),
    )
    expect(result).toMatchObject({ clientId: null, matchedBy: null, fileIds: [] })
    const [row] = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.id, result.id))
    expect(row).toMatchObject({ clientId: null, senderVerified: false })
    expect((await activities(byContact)).map((a) => a.body)).not.toContain(
      "Escribió a soporte@: pacientes.xlsx (1 adjunto)",
    )
  })
})

describe("assignInboundEmail", () => {
  it("una persona lo asigna: adjuntos al cliente, actividad y no cambia de cliente después", async () => {
    const key = inboundAttachmentKey("pdf")
    const { id } = await ingestInboundEmail(
      ownerDb,
      mail({
        from: "anonima@nadie.test",
        subject: null,
        attachments: [
          { filename: "carta.pdf", contentType: "application/pdf", size: 10, fileKey: key },
        ],
      }),
    )
    // Soporte también asigna; los adjuntos los registra el sistema porque son de Administración.
    const result = await assignInboundEmail(ownerDb, support, id, lonely)
    expect(result.fileIds).toHaveLength(1)
    const [row] = await ownerDb.select().from(saasInboundEmail).where(eq(saasInboundEmail.id, id))
    expect(row).toMatchObject({
      clientId: lonely,
      matchedBy: "persona",
      matchedByUser: support.userId,
    })
    const [file] = await ownerDb
      .select()
      .from(saasClientFile)
      .where(eq(saasClientFile.objectKey, key))
    expect(file).toMatchObject({
      clientId: lonely,
      adminOnly: true,
      createdBy: null,
      source: "correo",
    })
    expect(await activities(lonely)).toEqual([
      {
        kind: "correo",
        direction: "entro",
        requestId: null,
        body: "Escribió a soporte@: (sin asunto) (1 adjunto)",
      },
    ])
    expect(await assignInboundEmail(ownerDb, admin, id, lonely)).toMatchObject({ fileIds: [] })
    await expect(assignInboundEmail(ownerDb, admin, id, byContact)).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await expect(
      assignInboundEmail(ownerDb, admin, "00000000-0000-4000-8000-000000000000", lonely),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(assignInboundEmail(ownerDb, null, id, lonely)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })
})
