/**
 * Correo entrante de Sallca (ADR 0184): un Email Worker de Cloudflare Email Routing para
 * soporte@ y contacto@ de odentia32.com, latidia72.com y vistia20.com.
 *
 * Por cada correo:
 * 1. Lo reenvía a `FORWARD_TO`, el buzón de siempre, para no perder nada aunque falle lo demás.
 * 2. Lo lee con postal-mime y lo manda firmado a `${API_URL}/api/inbound/email`, donde la
 *    administración lo liga a su cliente (`apps/api/src/routes/inbound-email.ts`) solo si el
 *    remitente está verificado (`senderVerified`, de lo que comprobó Cloudflare: el From se
 *    puede falsificar).
 *
 * Si el envío a la API falla, el correo ya se reenvió: se anota en el registro y no se
 * reintenta (la API entra un correo una sola vez por su Message-ID, pero aquí no se repite).
 * Solo si fallan las dos cosas se rechaza, para que quien escribe sepa que no llegó.
 *
 * No se despliega desde el repositorio: los pasos están en el README.
 */
import PostalMime from "postal-mime"
import { CLOUDFLARE_AUTHSERV_ID, senderVerified } from "./auth"

export interface Env {
  /** Origen de la API, sin barra final: `https://api.odentia32.com`. */
  API_URL: string
  /** El mismo secreto que `INBOUND_EMAIL_SECRET` de la API. */
  INBOUND_EMAIL_SECRET: string
  /** El buzón de siempre (o varios, separados por comas), verificado en Email Routing. */
  FORWARD_TO: string
  /**
   * El servidor que firma lo que comprobó Cloudflare (`ARC-Authentication-Results`); por
   * defecto `mx.cloudflare.net`. Si no coincide, ningún remitente queda verificado.
   */
  AUTHSERV_ID?: string
}

/**
 * La firma, igual que `verifyInboundSignature` de la API: `x-sallca-timestamp` lleva los
 * segundos Unix y `x-sallca-signature` es `sha256=` + el hex de HMAC-SHA256 con
 * `INBOUND_EMAIL_SECRET` de `${timestamp}.${cuerpo crudo}`. La API acepta ±5 minutos.
 * Si la API cambia su esquema, se cambia solo esta función.
 */
export function signedMaterial(timestamp: number, body: string): string {
  return `${timestamp}.${body}`
}

export const SIGNATURE_HEADER = "x-sallca-signature"
export const TIMESTAMP_HEADER = "x-sallca-timestamp"

/** Los adjuntos que se mandan a la API, sumados: lo que pasa se omite y se avisa en el texto. */
export const ATTACHMENTS_MAX_BYTES = 10 * 1024 * 1024
/** Cuántos adjuntos acepta la API (`INBOUND_ATTACHMENTS_MAX`). */
export const ATTACHMENTS_MAX_COUNT = 20
/** El texto que acepta la API. */
export const TEXT_MAX_CHARS = 200_000

const MAILBOXES = ["soporte", "contacto"] as const
type Mailbox = (typeof MAILBOXES)[number]

/** Cada dominio con su producto (`CLINICAL_PRODUCTS`). */
const PRODUCTS: Record<string, "dental" | "medical" | "optical"> = {
  "odentia32.com": "dental",
  "latidia72.com": "medical",
  "vistia20.com": "optical",
}

/**
 * Lo que la API guarda (PDF, imagen, xlsx, csv, docx). La API lo vuelve a comprobar por sus
 * bytes; aquí solo se evita mandar lo que igual descartaría.
 */
const ALLOWED_EXTENSIONS = new Set([
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "xlsx",
  "csv",
  "docx",
])

/** «Soporte+algo@OdentIA32.com» → buzón «soporte» y producto «dental»; null si no es de los nuestros. */
export function routeOf(recipient: string): { mailbox: Mailbox; product: string } | null {
  const at = recipient.lastIndexOf("@")
  if (at < 1) return null
  const local = recipient.slice(0, at).toLowerCase().split("+")[0] ?? ""
  const domain = recipient
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, "")
  const product = PRODUCTS[domain]
  const mailbox = MAILBOXES.find((name) => name === local)
  return product && mailbox ? { mailbox, product } : null
}

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
}

/** El HTML de un correo en texto, para cuando no trae su parte de texto. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|table|ul|ol)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === "#") {
        const value =
          code[1]?.toLowerCase() === "x"
            ? Number.parseInt(code.slice(2), 16)
            : Number(code.slice(1))
        return Number.isFinite(value) && value > 0 && value < 0x110000
          ? String.fromCodePoint(value)
          : match
      }
      return ENTITIES[code.toLowerCase()] ?? match
    })
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Los bytes de un base64 sin decodificarlo. */
function base64Bytes(base64: string): number {
  const clean = base64.replace(/[\r\n]/g, "")
  return (
    Math.floor((clean.length * 3) / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0)
  )
}

export interface OutboundAttachment {
  filename: string
  contentType: string
  base64: string
}

interface ParsedAttachment {
  filename: string | null
  mimeType: string
  disposition: string | null
  related?: boolean
  content: ArrayBuffer | Uint8Array | string
}

/**
 * Los adjuntos que van a la API, en orden, hasta 10 MB y 20 en total; las imágenes de la
 * firma (en línea, sin nombre) no cuentan. Devuelve también lo que se omitió, para decirlo.
 */
export function pickAttachments(attachments: readonly ParsedAttachment[]): {
  kept: OutboundAttachment[]
  tooMuch: string[]
  notAllowed: string[]
} {
  const kept: OutboundAttachment[] = []
  const tooMuch: string[] = []
  const notAllowed: string[] = []
  let total = 0
  for (const attachment of attachments) {
    if (!attachment.filename && (attachment.related || attachment.disposition !== "attachment"))
      continue
    const filename = (attachment.filename ?? "adjunto").trim() || "adjunto"
    const ext = /\.([a-z0-9]{1,8})$/i.exec(filename)?.[1]?.toLowerCase() ?? ""
    if (!ALLOWED_EXTENSIONS.has(ext) || typeof attachment.content !== "string") {
      notAllowed.push(filename)
      continue
    }
    const size = base64Bytes(attachment.content)
    if (kept.length >= ATTACHMENTS_MAX_COUNT || total + size > ATTACHMENTS_MAX_BYTES) {
      tooMuch.push(filename)
      continue
    }
    total += size
    kept.push({
      filename,
      contentType: attachment.mimeType || "application/octet-stream",
      base64: attachment.content,
    })
  }
  return { kept, tooMuch, notAllowed }
}

/** El aviso que va al final del texto cuando algún adjunto no se mandó. */
export function omittedNote(tooMuch: readonly string[], notAllowed: readonly string[]): string {
  const lines: string[] = []
  if (tooMuch.length)
    lines.push(
      `Se omitieron ${tooMuch.length} adjunto(s) porque los adjuntos pasan de 10 MB o de ${ATTACHMENTS_MAX_COUNT} en total: ${tooMuch.join(", ")}.`,
    )
  if (notAllowed.length)
    lines.push(
      `No se guardaron por su tipo (solo PDF, imagen, xlsx, csv y docx): ${notAllowed.join(", ")}.`,
    )
  if (!lines.length) return ""
  return `\n\n[Aviso del correo entrante] ${lines.join(" ")} El correo completo llegó también al buzón de siempre.`
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** `sha256=` + hex de HMAC-SHA256 de lo firmado. */
export async function signature(secret: string, timestamp: number, body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(signedMaterial(timestamp, body)))
  return `sha256=${hex(mac)}`
}

/** El cuerpo que espera la API, armado desde el correo leído. */
export async function inboundBody(
  raw: Uint8Array,
  envelope: { from: string; to: string },
  route: { mailbox: Mailbox; product: string },
  receivedAt: Date,
  authservId: string = CLOUDFLARE_AUTHSERV_ID,
): Promise<string> {
  const email = await PostalMime.parse(raw, { attachmentEncoding: "base64" })
  const sender = email.from?.address ? email.from : email.from?.group?.[0]
  // Sin Message-ID, uno fijo por el contenido: el mismo correo no entra dos veces.
  const messageId =
    email.messageId?.trim() ||
    `<sin-id-${hex(await crypto.subtle.digest("SHA-256", raw))}@entrante.sallca>`
  const { kept, tooMuch, notAllowed } = pickAttachments(email.attachments)
  const note = omittedNote(tooMuch, notAllowed)
  const text = (email.text ?? (email.html ? htmlToText(email.html) : "")).slice(
    0,
    TEXT_MAX_CHARS - note.length,
  )
  const from = (sender?.address || envelope.from).trim().toLowerCase().slice(0, 254)
  return JSON.stringify({
    mailbox: route.mailbox,
    product: route.product,
    messageId: messageId.slice(0, 998),
    from,
    fromName: sender?.name ? sender.name.slice(0, 500) : null,
    to: envelope.to.trim().toLowerCase().slice(0, 254),
    subject: email.subject ? email.subject.slice(0, 5000) : null,
    text: text + note,
    receivedAt: receivedAt.toISOString(),
    attachments: kept,
    senderVerified: senderVerified(email.headers, from, authservId),
  })
}

/** Manda el correo a la API, una sola vez. Devuelve si la API lo recibió. */
async function postToApi(body: string, env: Env): Promise<boolean> {
  const timestamp = Math.floor(Date.now() / 1000)
  try {
    const response = await fetch(`${env.API_URL.replace(/\/+$/, "")}/api/inbound/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_HEADER]: await signature(env.INBOUND_EMAIL_SECRET, timestamp, body),
      },
      body,
    })
    if (response.ok) return true
    const answer = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
    console.error(
      `correo entrante: la API respondió ${response.status} ${answer?.error?.code ?? ""}; no se reintenta`,
    )
    return false
  } catch (error) {
    console.error("correo entrante: no se pudo llegar a la API; no se reintenta", String(error))
    return false
  }
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer())

    // 1. Primero el reenvío de siempre: así nada se pierde.
    let forwarded = false
    const destinations = (env.FORWARD_TO ?? "")
      .split(",")
      .map((address) => address.trim())
      .filter(Boolean)
    if (!destinations.length) console.error("correo entrante: falta FORWARD_TO; no se reenvió")
    for (const destination of destinations) {
      try {
        await message.forward(destination)
        forwarded = true
      } catch (error) {
        console.error("correo entrante: no se pudo reenviar a un destino", String(error))
      }
    }

    // 2. Después, a la administración.
    const route = routeOf(message.to)
    if (!route) {
      console.log(
        "correo entrante: no es soporte@ ni contacto@ de un dominio nuestro; solo se reenvió",
      )
      return
    }
    let posted = false
    if (!env.API_URL || !env.INBOUND_EMAIL_SECRET)
      console.error("correo entrante: faltan API_URL o INBOUND_EMAIL_SECRET; no se mandó a la API")
    else {
      try {
        posted = await postToApi(
          await inboundBody(raw, message, route, new Date(), env.AUTHSERV_ID || undefined),
          env,
        )
      } catch (error) {
        console.error("correo entrante: no se pudo leer el correo", String(error))
      }
    }
    if (!forwarded && !posted)
      message.setReject("No pudimos recibir su correo en este momento. Inténtelo más tarde.")
  },
} satisfies ExportedHandler<Env>
