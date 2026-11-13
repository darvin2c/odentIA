process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { createOwnerDb, type Db } from "@odentia/db"
import {
  saasClient,
  saasClientContact,
  saasClientFile,
  saasInboundEmail,
  saasOutreach,
} from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import type { Storage } from "@odentia/services"
import { eq } from "drizzle-orm"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { Hono } from "hono"
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  allowedInboundAttachment,
  createInboundEmailRoute,
  signInboundEmail,
} from "./inbound-email.js"

/**
 * El correo entrante firmado contra Postgres real: sin secreto 503; firma
 * mala, vieja o de otro cuerpo 401; el mismo Message-ID entra una sola vez;
 * solo se guardan los adjuntos permitidos, como documentos solo de
 * Administración que se borran a los 30 días.
 */

const IMAGE = "dentalagent-postgres:18.6"
const SECRET = "s".repeat(48)

let container: StartedTestContainer
let ownerDb: Db
let app: Hono
let disabled: Hono
let clientId: string

const objects = new Map<string, Uint8Array>()
const storage: Pick<Storage, "putAttachmentAt" | "deleteAttachment"> = {
  putAttachmentAt: async (key, bytes) => {
    objects.set(key, bytes)
  },
  deleteAttachment: async (key) => {
    objects.delete(key)
  },
}

const PDF = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64")
const EXE = Buffer.from("MZ\x90\x00ejecutable").toString("base64")
const CSV = Buffer.from("nombre;teléfono\nRosa;999\n", "latin1").toString("base64")

function email(messageId: string, extra: Record<string, unknown> = {}) {
  return {
    mailbox: "soporte",
    product: "dental",
    messageId,
    from: "Dra.Ana@Clinica-Correo.test",
    fromName: "Dra. Ana",
    to: "soporte@odentia32.com",
    subject: "Les mando los pacientes",
    text: "Adjunto el archivo.",
    receivedAt: new Date().toISOString(),
    attachments: [],
    senderVerified: true,
    ...extra,
  }
}

function send(body: unknown, opts: { timestamp?: number; signature?: string; target?: Hono } = {}) {
  const raw = JSON.stringify(body)
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000)
  return (opts.target ?? app).request("/api/inbound/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sallca-timestamp": String(timestamp),
      "x-sallca-signature": opts.signature ?? signInboundEmail(SECRET, raw, timestamp),
    },
    body: raw,
  })
}

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/** Un ZIP mínimo (sin comprimir) con esas entradas vacías: lo que trae un .xlsx o un .docx. */
function zipOf(names: string[]): Uint8Array {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const name of names) {
    const file = Buffer.from(name, "utf8")
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(file.length, 26)
    parts.push(local, file)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(file.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, file)
    offset += local.length + file.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(names.length, 8)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...parts, dir, end]))
}

async function code(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code
}

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: "dentalagent_app",
    })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_cron",
      "-c",
      "cron.database_name=dentalagent",
    ])
    .start()
  const url = `${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`
  ownerDb = createOwnerDb(`postgres://dentalagent:dentalagent@${url}`)
  await migrate(ownerDb, { migrationsFolder: "../../packages/db/drizzle" })
  app = new Hono().route(
    "/api/inbound",
    createInboundEmailRoute({ ownerDb, storage, secret: SECRET }),
  )
  disabled = new Hono().route(
    "/api/inbound",
    createInboundEmailRoute({ ownerDb, storage, secret: "" }),
  )
  const [client] = await ownerDb
    .insert(saasClient)
    .values({ name: "Clínica Correo (ficticia)", product: "dental" })
    .returning({ id: saasClient.id })
  clientId = client!.id
  await ownerDb
    .insert(saasClientContact)
    .values({ clientId, name: "Dra. Ana", email: "dra.ana@clinica-correo.test", isPrimary: true })
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

describe("la firma", () => {
  it("sin secreto configurado la ruta no está: 503", async () => {
    const response = await send(email("<sin-secreto@test>"), { target: disabled })
    expect(response.status).toBe(503)
    expect(await code(response)).toBe("INBOUND_EMAIL_DISABLED")
  })

  it("firma mala, de otro cuerpo o sin cabeceras: 401 y no se registra", async () => {
    const body = email("<firma-mala@test>")
    expect((await send(body, { signature: `sha256=${"0".repeat(64)}` })).status).toBe(401)
    const other = signInboundEmail(
      SECRET,
      JSON.stringify(email("<otro@test>")),
      Math.floor(Date.now() / 1000),
    )
    expect((await send(body, { signature: other })).status).toBe(401)
    const wrongSecret = signInboundEmail(
      "x".repeat(48),
      JSON.stringify(body),
      Math.floor(Date.now() / 1000),
    )
    expect((await send(body, { signature: wrongSecret })).status).toBe(401)
    const bare = await app.request("/api/inbound/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(bare.status).toBe(401)
    expect(await code(bare)).toBe("INBOUND_SIGNATURE_INVALID")
    const rows = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.messageId, "<firma-mala@test>"))
    expect(rows).toHaveLength(0)
  })

  it("una firma vieja (más de 5 minutos) o del futuro no vale, aunque sea correcta", async () => {
    const now = Math.floor(Date.now() / 1000)
    expect((await send(email("<vieja@test>"), { timestamp: now - 301 })).status).toBe(401)
    expect((await send(email("<futura@test>"), { timestamp: now + 301 })).status).toBe(401)
    expect(
      (
        await send(email("<justa@test>", { from: "otra@desconocida.test" }), {
          timestamp: now - 290,
        })
      ).status,
    ).toBe(201)
  })

  it("cambiar el instante de una firma válida no la rejuvenece", async () => {
    const body = email("<rejuvenecida@test>")
    const old = Math.floor(Date.now() / 1000) - 600
    const signature = signInboundEmail(SECRET, JSON.stringify(body), old)
    expect((await send(body, { signature })).status).toBe(401)
  })
})

describe("el correo", () => {
  it("entra con su cliente, sus adjuntos permitidos y su actividad; lo demás se descarta", async () => {
    const response = await send(
      email("<con-adjuntos@test>", {
        attachments: [
          { filename: "pacientes.pdf", contentType: "application/pdf", base64: PDF },
          { filename: "pacientes.csv", contentType: "application/octet-stream", base64: CSV },
          { filename: "factura.pdf.exe", contentType: "application/pdf", base64: EXE },
        ],
      }),
    )
    expect(response.status).toBe(201)
    const { data } = (await response.json()) as {
      data: { id: string; duplicate: boolean; stored: number; skipped: number }
    }
    expect(data).toMatchObject({ duplicate: false, stored: 2, skipped: 1 })
    const [row] = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.id, data.id))
    expect(row).toMatchObject({
      clientId,
      matchedBy: "contacto",
      fromAddress: "dra.ana@clinica-correo.test",
    })
    const files = await ownerDb
      .select()
      .from(saasClientFile)
      .where(eq(saasClientFile.clientId, clientId))
    expect(files).toHaveLength(2)
    for (const file of files) {
      expect(file).toMatchObject({ kind: "correo", adminOnly: true, source: "correo" })
      expect(file.deleteAfter).not.toBeNull()
      expect(objects.has(file.objectKey)).toBe(true)
    }
    expect(files.map((file) => file.contentType).sort()).toEqual(["application/pdf", "text/csv"])
    const activity = await ownerDb
      .select()
      .from(saasFollowUp)
      .where(eq(saasFollowUp.clientId, clientId))
    expect(activity).toHaveLength(1)
    expect(activity[0]).toMatchObject({ kind: "correo", direction: "entro" })
  })

  it("el mismo Message-ID dos veces (la misma entrega repetida) entra una sola vez", async () => {
    const body = email("<repetido@test>", {
      attachments: [{ filename: "a.pdf", contentType: "application/pdf", base64: PDF }],
    })
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = signInboundEmail(SECRET, JSON.stringify(body), timestamp)
    const first = await send(body, { timestamp, signature })
    expect(first.status).toBe(201)
    const objectsAfterFirst = objects.size
    const again = await send(body, { timestamp, signature })
    expect(again.status).toBe(200)
    const { data } = (await again.json()) as { data: { duplicate: boolean; stored: number } }
    expect(data).toMatchObject({ duplicate: true, stored: 0 })
    expect(objects.size).toBe(objectsAfterFirst)
    const rows = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.messageId, "<repetido@test>"))
    expect(rows).toHaveLength(1)
    // Otra entrega del mismo correo, firmada de nuevo, tampoco lo duplica.
    expect((await send(body)).status).toBe(200)
    const activity = await ownerDb
      .select()
      .from(saasFollowUp)
      .where(eq(saasFollowUp.clientId, clientId))
    expect(activity).toHaveLength(2)
  })

  it("sin cliente queda sin cliente, y sus adjuntos se guardan igual", async () => {
    const response = await send(
      email("<sin-cliente@test>", {
        from: "nadie@desconocida.test",
        attachments: [{ filename: "a.pdf", contentType: "application/pdf", base64: PDF }],
      }),
    )
    expect(response.status).toBe(201)
    const [row] = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.messageId, "<sin-cliente@test>"))
    expect(row?.clientId).toBeNull()
    expect(row?.attachments).toHaveLength(1)
  })

  it("si el worker no pudo verificar el remitente, no se liga al cliente aunque su correo coincida", async () => {
    const response = await send(
      email("<sin-verificar@test>", {
        senderVerified: false,
        attachments: [{ filename: "pacientes.pdf", contentType: "application/pdf", base64: PDF }],
      }),
    )
    expect(response.status).toBe(201)
    const [row] = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.messageId, "<sin-verificar@test>"))
    expect(row).toMatchObject({ clientId: null, senderVerified: false })
    // Sin el campo, tampoco: lo que no se sabe no se da por verificado.
    const { senderVerified: _omit, ...withoutFlag } = email("<sin-campo@test>")
    expect((await send(withoutFlag)).status).toBe(201)
    const [other] = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.messageId, "<sin-campo@test>"))
    expect(other?.clientId).toBeNull()
  })

  it("un cuerpo que no cumple se rechaza con su campo, ya firmado", async () => {
    const response = await send(email("<malo@test>", { mailbox: "ventas" }))
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { fields: Record<string, string> } }
    expect(body.error.fields).toHaveProperty("mailbox")
  })
})

describe("la dirección de una persona del equipo", () => {
  beforeAll(async () => {
    await ownerDb.insert(user).values([
      { id: "ie-ada", name: "Ada Lovelace", email: "ada@gmail.test" },
      { id: "ie-ido", name: "Gonzalo Ido", email: "gonzalo@gmail.test" },
      { id: "ie-beto", name: "Beto Paz", email: "beto@gmail.test" },
    ])
    // La base les pone su dirección al crear la fila: ada.lovelace y gonzalo.ido.
    await ownerDb.insert(adminStaff).values([
      { userId: "ie-ada", role: "admin", mailCopyTo: "ada.copia@gmail.test" },
      { userId: "ie-ido", role: "admin", active: false, mailCopyTo: "ido.copia@gmail.test" },
      { userId: "ie-beto", role: "admin", mailCopyTo: "beto.copia@gmail.test" },
    ])
    await ownerDb.insert(saasOutreach).values({
      clientId,
      channel: "correo",
      toAddress: "dra.ana@clinica-correo.test",
      subject: "Hola",
      body: "Hola, doctora.",
      fromAddress: "gonzalo.ido@odentia32.com",
      messageId: "<nuestro-1@odentia32.com>",
    })
  })

  const toPerson = (messageId: string, localPart: string, extra: Record<string, unknown> = {}) =>
    email(messageId, {
      mailbox: "persona",
      localPart,
      to: `${localPart}@odentia32.com`,
      ...extra,
    })

  it("existe: entra a su nombre y la API dice a dónde va su copia", async () => {
    const response = await send(toPerson("<a-ada@test>", "ada.lovelace"))
    expect(response.status).toBe(201)
    const { data } = (await response.json()) as { data: { copyTo: string | null } }
    expect(data.copyTo).toBe("ada.copia@gmail.test")
    const [row] = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.messageId, "<a-ada@test>"))
    expect(row).toMatchObject({ mailbox: "persona", staffUserId: "ie-ada" })
    // La misma entrega otra vez: también dice su copia.
    const again = await send(toPerson("<a-ada@test>", "ada.lovelace"))
    expect(((await again.json()) as { data: { copyTo: string | null } }).data.copyTo).toBe(
      "ada.copia@gmail.test",
    )
  })

  it("no es de nadie: 404 MAILBOX_UNKNOWN y no se guarda nada", async () => {
    const before = objects.size
    const response = await send(
      toPerson("<a-nadie@test>", "nadie", {
        attachments: [{ filename: "a.pdf", contentType: "application/pdf", base64: PDF }],
      }),
    )
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "MAILBOX_UNKNOWN",
    )
    expect(objects.size).toBe(before)
  })

  it("ya no está en el equipo: solo entra si responde un correo que salió con su dirección", async () => {
    expect((await send(toPerson("<a-ido-1@test>", "gonzalo.ido"))).status).toBe(404)
    const reply = await send(
      toPerson("<a-ido-2@test>", "gonzalo.ido", {
        inReplyTo: "<nuestro-1@odentia32.com>",
        references: "<otro@test> <nuestro-1@odentia32.com>",
      }),
    )
    expect(reply.status).toBe(201)
    const [row] = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.messageId, "<a-ido-2@test>"))
    // Responde un envío nuestro a ese mismo correo, con el remitente verificado: se liga por el hilo.
    expect(row).toMatchObject({
      staffUserId: "ie-ido",
      clientId,
      matchedBy: "hilo",
      inReplyTo: "<nuestro-1@odentia32.com>",
      references: "<otro@test> <nuestro-1@odentia32.com>",
    })
  })

  it("el mismo correo a otra dirección: primero quién es, y la copia es la de esa persona", async () => {
    // Un correo con copia a dos personas llega dos veces con el mismo Message-ID.
    const first = await send(toPerson("<a-dos@test>", "ada.lovelace"))
    expect(first.status).toBe(201)
    const second = await send(toPerson("<a-dos@test>", "beto.paz"))
    expect(second.status).toBe(200)
    expect(((await second.json()) as { data: { copyTo: string | null } }).data).toMatchObject({
      duplicate: true,
      copyTo: "beto.copia@gmail.test",
    })
    // A una dirección que no es de nadie, o de quien ya no está sin hilo: 404 aunque se repita.
    const nobody = await send(toPerson("<a-dos@test>", "nadie"))
    expect(nobody.status).toBe(404)
    expect((await send(toPerson("<a-dos@test>", "gonzalo.ido"))).status).toBe(404)
  })

  it("quien ya no está: su respuesta entra, pero sin copia", async () => {
    const reply = await send(
      toPerson("<a-ido-3@test>", "gonzalo.ido", { inReplyTo: "<nuestro-1@odentia32.com>" }),
    )
    expect(reply.status).toBe(201)
    expect(((await reply.json()) as { data: { copyTo: string | null } }).data.copyTo).toBeNull()
  })

  it("guarda el Reply-To y el aviso del Worker aparte del texto", async () => {
    const response = await send(
      email("<a-reply-to@test>", {
        replyTo: " Recepcion@Clinica-Correo.test ",
        text: "Les mando la lista.",
        notice: "No se guardaron por su tipo: lista.zip.",
      }),
    )
    expect(response.status).toBe(201)
    const [row] = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.messageId, "<a-reply-to@test>"))
    expect(row).toMatchObject({
      replyTo: "recepcion@clinica-correo.test",
      textBody: "Les mando la lista.",
      notice: "No se guardaron por su tipo: lista.zip.",
    })
  })

  it("la parte local va solo con la dirección de una persona", async () => {
    expect((await send(email("<a-mal-1@test>", { mailbox: "persona" }))).status).toBe(400)
    expect(
      (await send(email("<a-mal-2@test>", { mailbox: "hola", localPart: "ada.lovelace" }))).status,
    ).toBe(400)
    const hola = await send(email("<a-hola@test>", { mailbox: "hola", to: "hola@odentia32.com" }))
    expect(hola.status).toBe(201)
    expect(((await hola.json()) as { data: { copyTo: string | null } }).data.copyTo).toBeNull()
  })
})

describe("adjuntos permitidos", () => {
  const bytes = (text: string) => new Uint8Array(Buffer.from(text, "latin1"))
  it("decide por los bytes, no por lo que declara", () => {
    expect(
      allowedInboundAttachment(bytes("%PDF-1.7"), "x.bin", "application/octet-stream")?.ext,
    ).toBe("pdf")
    expect(allowedInboundAttachment(bytes("\xff\xd8\xff\xe0"), "foto", "")?.ext).toBe("jpg")
    const workbook = zipOf(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"])
    const letter = zipOf(["[Content_Types].xml", "word/document.xml"])
    expect(allowedInboundAttachment(workbook, "datos.xlsx", "")?.ext).toBe("xlsx")
    expect(allowedInboundAttachment(letter, "carta.docx", "")?.ext).toBe("docx")
    // Un ZIP cualquiera con el nombre o el tipo de Office no pasa.
    expect(allowedInboundAttachment(bytes("PK\x03\x04..."), "datos.xlsx", "")).toBeNull()
    expect(allowedInboundAttachment(zipOf(["app/Main.class"]), "nomina.xlsx", "")).toBeNull()
    expect(allowedInboundAttachment(zipOf(["META-INF/MANIFEST.MF"]), "x.jar", XLSX_TYPE)).toBeNull()
    // Con macros o con un ejecutable adentro, tampoco.
    expect(
      allowedInboundAttachment(
        zipOf(["[Content_Types].xml", "xl/workbook.xml", "xl/vbaProject.bin"]),
        "nomina.xlsx",
        "",
      ),
    ).toBeNull()
    expect(
      allowedInboundAttachment(
        zipOf(["[Content_Types].xml", "word/document.xml", "word/embeddings/setup.exe"]),
        "carta.docx",
        "",
      ),
    ).toBeNull()
    // El libro con extensión de carta no pasa por carta.
    expect(allowedInboundAttachment(workbook, "carta.docx", "")).toBeNull()
    expect(
      allowedInboundAttachment(bytes("PK\x03\x04..."), "todo.zip", "application/zip"),
    ).toBeNull()
    expect(
      allowedInboundAttachment(bytes("<svg onload=x>"), "logo.svg", "image/svg+xml"),
    ).toBeNull()
    expect(allowedInboundAttachment(bytes("<html>"), "pdf.pdf", "application/pdf")).toBeNull()
    expect(allowedInboundAttachment(bytes("a\x00b"), "datos.csv", "text/csv")).toBeNull()
    expect(allowedInboundAttachment(bytes("a;b\r\n1;2"), "datos.csv", "")?.ext).toBe("csv")
  })
})
