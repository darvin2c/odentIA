import { createHmac, timingSafeEqual } from "node:crypto"
import { CLINICAL_PRODUCTS } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { SAAS_INBOUND_MAILBOXES, saasInboundEmail } from "@odentia/db/schema/admin-arm"
import {
  INBOUND_ATTACHMENTS_MAX,
  inboundAttachmentKey,
  inboundPersonOf,
  ingestInboundEmail,
  type Storage,
  threadMessageIds,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { errorBody } from "../lib/error.js"
import { serviceErrorResponse, validationError } from "./helpers.js"

/**
 * Correo que llega a los buzones de los tres productos (soporte@, contacto@,
 * hola@, fundadores@) y a la dirección de cada persona del equipo (`persona`,
 * con su `localPart`). Lo recibe el worker de Cloudflare Email Routing
 * (`infra/cloudflare/email-inbound`), que lo reenvía y además lo manda aquí
 * firmado. Montaje público, sin cookie ni `Origin`: vale solo con la firma.
 *
 * La dirección de una persona que no es de nadie responde 404
 * `MAILBOX_UNKNOWN` sin guardar nada (el worker rechaza el correo); si es de
 * alguien, la respuesta dice `copyTo`, el buzón donde el worker deja su copia.
 *
 * Firma (contrato con el worker):
 * - `x-sallca-timestamp`: segundos Unix de cuando se firmó; se acepta ±5 min.
 * - `x-sallca-signature`: `sha256=` + hex de HMAC-SHA256(INBOUND_EMAIL_SECRET,
 *   `${timestamp}.${cuerpo crudo}`). El instante va dentro de lo firmado: una
 *   petición vieja no se rejuvenece cambiando la cabecera.
 * La misma petición repetida dentro de la ventana no registra nada dos veces:
 * el correo entra una sola vez por su `Message-ID`.
 *
 * Adjuntos: solo PDF, imagen (JPG, PNG, WebP, GIF), xlsx, csv y docx, según sus
 * bytes y no solo lo que declaran; lo demás se descarta y se cuenta. Se guardan
 * en el bucket privado (`inbound/<uuid>.<ext>`) como documentos solo de
 * Administración que se borran a los 30 días; nadie ni nada los abre ni los
 * manda al modelo.
 */
export interface InboundEmailDeps {
  /** Conexión propietaria: las tablas del ARM viven en `admin`, sin GRANT a la app. */
  ownerDb: Db
  storage: Pick<Storage, "putAttachmentAt" | "deleteAttachment">
  /** INBOUND_EMAIL_SECRET. Sin él la ruta responde 503. */
  secret?: string | null
  /** Reloj, para las pruebas. */
  now?: () => Date
}

/** Ventana de la firma. */
export const INBOUND_SIGNATURE_WINDOW_SECONDS = 300
/** Un correo con sus adjuntos en base64. */
export const INBOUND_EMAIL_BODY_MAX = 20 * 1024 * 1024

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const BASE64 = /^[A-Za-z0-9+/\r\n]*={0,2}[\r\n]*$/

const attachmentBody = z.object({
  filename: z.string().trim().min(1, "Falta el nombre del adjunto").max(1000),
  contentType: z.string().trim().max(200).default("application/octet-stream"),
  base64: z.string().regex(BASE64, "El adjunto va en base64"),
})

const emailBody = z.object({
  mailbox: z.enum(SAAS_INBOUND_MAILBOXES, "Buzón no válido"),
  /** Solo con `persona`: la parte local del destinatario, sin `+etiqueta`. */
  localPart: z.string().trim().toLowerCase().max(64).nullish(),
  /** Las cabeceras del hilo, recortadas por el worker. */
  inReplyTo: z.string().max(998).nullish(),
  references: z.string().max(8000).nullish(),
  product: z.enum(CLINICAL_PRODUCTS, "Producto no válido"),
  messageId: z.string().trim().min(1, "Falta el Message-ID").max(998, "Message-ID demasiado largo"),
  from: z.string().trim().min(3).max(254),
  fromName: z.string().max(500).nullish(),
  to: z.string().trim().min(3).max(254),
  subject: z.string().max(5000).nullish(),
  text: z.string().max(200_000).nullish(),
  /** La primera dirección del Reply-To; una que no es un correo se ignora (la respuesta va al From). */
  replyTo: z.string().max(1000).nullish(),
  /** El aviso del worker (adjuntos que no se mandaron), aparte del texto. */
  notice: z.string().max(2000).nullish(),
  receivedAt: z.iso.datetime({ offset: true, message: "Fecha de llegada no válida" }),
  attachments: z
    .array(attachmentBody)
    .max(INBOUND_ATTACHMENTS_MAX, "Demasiados adjuntos")
    .default([]),
  /**
   * El worker verificó el remitente con lo que agregó Cloudflare (DMARC, o SPF
   * o DKIM alineados con el From). Sin el campo, no se da por verificado.
   */
  senderVerified: z.boolean().default(false),
})

type AttachmentKind = { contentType: string; ext: string }

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.byteLength >= prefix.length && prefix.every((byte, i) => bytes[i] === byte)
}

function extOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim())
  return match?.[1]?.toLowerCase() ?? ""
}

/** Texto plano: sin bytes de control salvo tabulador y saltos de línea (UTF-8 o Latin-1 de Excel). */
function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 65_536)
  for (const byte of head) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
    if (byte < 0x20 || byte === 0x7f) return false
  }
  return true
}

/** Lo que nunca va dentro de un libro o una carta que se guarda: macros y ejecutables. */
const OFFICE_FORBIDDEN =
  /(^|\/)vbaproject\.bin$|\.(exe|dll|com|scr|bat|cmd|ps1|vbs|js|jar|class|msi|sh)$/i

/**
 * Los nombres del directorio central de un ZIP, o null si no se puede leer
 * entero (truncado, ZIP64 o con más de 10 000 entradas): lo que no se puede
 * comprobar se descarta.
 */
function zipEntryNames(bytes: Uint8Array): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // El final del directorio central: 22 bytes más un comentario de hasta 64 KiB.
  let end = -1
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) return null
  const count = view.getUint16(end + 10, true)
  const size = view.getUint32(end + 12, true)
  const start = view.getUint32(end + 16, true)
  if (count === 0xffff || start === 0xffffffff || count > 10_000 || start + size > end) return null
  const names: string[] = []
  const decoder = new TextDecoder()
  let at = start
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) return null
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    if (at + 46 + nameLength > end) return null
    names.push(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)))
    at += 46 + nameLength + extraLength + commentLength
  }
  return names
}

/** «xlsx» o «docx» si el ZIP trae sus partes de Office y nada prohibido; null si no. */
function officeKindOf(bytes: Uint8Array): "xlsx" | "docx" | null {
  const names = zipEntryNames(bytes)
  if (!names || !names.includes("[Content_Types].xml")) return null
  if (names.some((name) => OFFICE_FORBIDDEN.test(name))) return null
  const workbook = names.includes("xl/workbook.xml")
  const document = names.includes("word/document.xml")
  if (workbook === document) return null
  return workbook ? "xlsx" : "docx"
}

/**
 * El tipo real de un adjunto permitido, por sus bytes (y por su extensión en
 * los de Office, que son un ZIP con sus partes, y en el CSV, que es texto);
 * null si no es de los permitidos. Nunca se confía solo en el tipo que declara el correo.
 */
export function allowedInboundAttachment(
  bytes: Uint8Array,
  filename: string,
  declared: string,
): AttachmentKind | null {
  if (bytes.byteLength === 0) return null
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]))
    return { contentType: "application/pdf", ext: "pdf" }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", ext: "jpg" }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { contentType: "image/png", ext: "png" }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.byteLength >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return { contentType: "image/webp", ext: "webp" }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { contentType: "image/gif", ext: "gif" }
  const ext = extOf(filename)
  const type = declared.trim().toLowerCase()
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // Un .xlsx o un .docx es un ZIP con sus partes de Office; uno cualquiera, con macros o con
    // un ejecutable adentro no pasa aunque se llame así.
    const kind = officeKindOf(bytes)
    if (kind === "xlsx" && (ext === "xlsx" || type === XLSX))
      return { contentType: XLSX, ext: "xlsx" }
    if (kind === "docx" && (ext === "docx" || type === DOCX))
      return { contentType: DOCX, ext: "docx" }
    return null
  }
  if ((ext === "csv" || type === "text/csv") && looksLikeText(bytes))
    return { contentType: "text/csv", ext: "csv" }
  return null
}

/** Compara la firma en tiempo constante; cualquier falla es la misma respuesta. */
export function verifyInboundSignature(
  secret: string,
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
  now: Date,
): boolean {
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false
  const age = Math.abs(now.getTime() / 1000 - Number(timestamp))
  if (!(age <= INBOUND_SIGNATURE_WINDOW_SECONDS)) return false
  const given = signature.trim().toLowerCase()
  if (!/^sha256=[0-9a-f]{64}$/.test(given)) return false
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")}`
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"))
}

/** Lo que firma el worker: útil para él y para las pruebas. */
export function signInboundEmail(secret: string, rawBody: string, timestamp: number): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")}`
}

export function createInboundEmailRoute(deps: InboundEmailDeps) {
  const app = new Hono()
  const clock = deps.now ?? (() => new Date())

  const tooLarge = (c: Context) =>
    c.json(errorBody(c, "BODY_TOO_LARGE", "El correo pesa más de 20 MB"), 413)

  app.post(
    "/email",
    bodyLimit({ maxSize: INBOUND_EMAIL_BODY_MAX, onError: tooLarge }),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const secret = deps.secret?.trim()
      if (!secret)
        return c.json(
          errorBody(c, "INBOUND_EMAIL_DISABLED", "El correo entrante no está configurado"),
          503,
        )
      const raw = await c.req.text().catch(() => "")
      const now = clock()
      if (
        !verifyInboundSignature(
          secret,
          raw,
          c.req.header("x-sallca-timestamp"),
          c.req.header("x-sallca-signature"),
          now,
        )
      )
        return c.json(
          errorBody(c, "INBOUND_SIGNATURE_INVALID", "La firma del correo no vale o venció"),
          401,
        )
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        return c.json(errorBody(c, "VALIDATION", "El cuerpo no es JSON"), 400)
      }
      const parsed = emailBody.safeParse(json)
      if (!parsed.success) return validationError(c, parsed.error.issues)
      const email = parsed.data
      if ((email.mailbox === "persona") !== Boolean(email.localPart))
        return c.json(
          errorBody(c, "VALIDATION", "La dirección de una persona va con su parte local", {
            localPart: "La dirección de una persona va con su parte local, y solo ella",
          }),
          400,
        )

      // La dirección de una persona: antes de nada (también antes de ver si se repite), que sea
      // de alguien. Un correo con copia a dos personas llega dos veces con el mismo Message-ID:
      // cada entrega dice la copia de su persona, y la de nadie se rechaza aunque se repita.
      let person: { copyTo: string | null } | null = null
      if (email.localPart) {
        try {
          person = await inboundPersonOf(
            deps.ownerDb,
            email.localPart,
            threadMessageIds(email.inReplyTo, email.references),
          )
        } catch (error) {
          const response = serviceErrorResponse(c, error)
          if (response) return response
          throw error
        }
      }

      // Ya llegó: no se sube nada otra vez (la repetición de una misma entrega).
      const [known] = await deps.ownerDb
        .select({ id: saasInboundEmail.id })
        .from(saasInboundEmail)
        .where(eq(saasInboundEmail.messageId, email.messageId))
        .limit(1)
      if (known)
        return c.json(
          {
            data: {
              id: known.id,
              duplicate: true,
              stored: 0,
              skipped: 0,
              copyTo: person?.copyTo ?? null,
            },
          },
          200,
        )

      const accepted: { filename: string; kind: AttachmentKind; bytes: Uint8Array }[] = []
      let skipped = 0
      for (const attachment of email.attachments) {
        const bytes = new Uint8Array(Buffer.from(attachment.base64, "base64"))
        const kind = allowedInboundAttachment(bytes, attachment.filename, attachment.contentType)
        if (kind) accepted.push({ filename: attachment.filename, kind, bytes })
        else skipped += 1
      }
      if (accepted.length > 0 && !deps.storage.putAttachmentAt)
        return c.json(
          errorBody(c, "STORAGE_UNAVAILABLE", "El almacenamiento no está disponible"),
          503,
        )

      // Fuera de la transacción: primero se sube, después se registra.
      const uploaded: { filename: string; contentType: string; size: number; fileKey: string }[] =
        []
      const removeUploaded = async () => {
        for (const file of uploaded)
          await deps.storage.deleteAttachment(file.fileKey).catch(() => {})
      }
      try {
        for (const file of accepted) {
          const fileKey = inboundAttachmentKey(file.kind.ext)
          await deps.storage.putAttachmentAt?.(fileKey, file.bytes, file.kind.contentType)
          uploaded.push({
            filename: file.filename,
            contentType: file.kind.contentType,
            size: file.bytes.byteLength,
            fileKey,
          })
        }
      } catch (error) {
        console.error("inbound-email: no se pudo guardar un adjunto", error)
        await removeUploaded()
        // El worker de Cloudflare no reintenta: lo anota en su registro y el correo igual llega
        // al buzón de siempre por el reenvío. Si alguien lo vuelve a mandar, el Message-ID
        // evita que entre dos veces.
        return c.json(
          errorBody(c, "STORAGE_UNAVAILABLE", "No se pudieron guardar los adjuntos"),
          503,
        )
      }

      try {
        const result = await deps.ownerDb.transaction((tx) =>
          ingestInboundEmail(
            tx as Db,
            {
              mailbox: email.mailbox,
              localPart: email.localPart ?? null,
              inReplyTo: email.inReplyTo ?? null,
              references: email.references ?? null,
              product: email.product,
              messageId: email.messageId,
              from: email.from,
              fromName: email.fromName ?? null,
              to: email.to,
              subject: email.subject ?? null,
              text: email.text ?? null,
              replyTo: email.replyTo ?? null,
              notice: email.notice ?? null,
              receivedAt: new Date(email.receivedAt),
              attachments: uploaded,
              senderVerified: email.senderVerified,
            },
            now,
          ),
        )
        // Otra entrega del mismo correo ganó la carrera: lo subido aquí sobra.
        if (result.duplicate) await removeUploaded()
        return c.json(
          {
            data: {
              id: result.id,
              duplicate: result.duplicate,
              stored: result.duplicate ? 0 : uploaded.length,
              skipped,
              copyTo: result.copyTo,
            },
          },
          result.duplicate ? 200 : 201,
        )
      } catch (error) {
        await removeUploaded()
        const response = serviceErrorResponse(c, error)
        if (response) return response
        throw error
      }
    },
  )

  return app
}
