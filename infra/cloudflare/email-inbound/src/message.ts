/**
 * Lo que hace el Worker con cada correo (el punto de entrada es `index.ts`).
 *
 * Correo entrante de Sallca (ADR 0185): un Email Worker de Cloudflare Email Routing para los
 * buzones (soporte@, contacto@, hola@, fundadores@) y, por el atrapa todo, la dirección de cada
 * persona del equipo, en odentia32.com, latidia72.com y vistia20.com.
 *
 * Qué hace con cada correo lo decide `deliver` (`flow.ts`): un buzón se reenvía a `FORWARD_TO`
 * y después va a la API; la dirección de una persona va primero a la API, que dice si es de
 * alguien y a dónde va su copia (si no es de nadie, se rechaza); lo que no tiene persona detrás
 * (respuestas automáticas, rebotes, nuestros no-reply@) solo se reenvía (`route.ts`). A la API
 * va leído con postal-mime y firmado a `${API_URL}/api/inbound/email`, donde la administración
 * lo liga a su cliente (`apps/api/src/routes/inbound-email.ts`) solo si el remitente está
 * verificado (`senderVerified`, de lo que comprobó Cloudflare: el From se puede falsificar).
 *
 * La API recibe cada correo una sola vez: si falla, se anota en el registro y no se reintenta.
 *
 * No se despliega desde el repositorio: los pasos están en el README.
 */
import PostalMime from "postal-mime"
import { CLOUDFLARE_AUTHSERV_ID, senderVerified } from "./auth.ts"
import { type ApiOutcome, deliver } from "./flow.ts"
import { type Mailbox, type Product, type Route, skipReason, threadHeaders } from "./route.ts"

export interface Env {
  /** Origen de la API, sin barra final: `https://api.odentia32.com`. */
  API_URL: string
  /** El mismo secreto que `INBOUND_EMAIL_SECRET` de la API. */
  INBOUND_EMAIL_SECRET: string
  /**
   * El buzón de siempre (o varios, separados por comas), verificado en Email Routing: la copia
   * de los buzones y, si la API no responde, de la dirección de una persona.
   */
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

/** Los adjuntos que se mandan a la API, sumados: lo que pasa se omite y se avisa aparte (`notice`). */
export const ATTACHMENTS_MAX_BYTES = 10 * 1024 * 1024
/** Cuántos adjuntos acepta la API (`INBOUND_ATTACHMENTS_MAX`). */
export const ATTACHMENTS_MAX_COUNT = 20
/** El texto que acepta la API. */
export const TEXT_MAX_CHARS = 200_000
/** El aviso que acepta la API. */
export const NOTICE_MAX_CHARS = 2000
/** El nombre y el tipo de un adjunto que acepta la API: lo que pasa se recorta, no se rechaza. */
export const FILENAME_MAX_CHARS = 1000
export const CONTENT_TYPE_MAX_CHARS = 200

/** A dónde va a la API: un buzón fijo o la dirección de una persona. */
type ApiRoute =
  | { kind: "buzon"; mailbox: Mailbox; product: Product }
  | { kind: "persona"; localPart: string; product: Product }

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

/** Un nombre de adjunto de hasta 1000 caracteres, con su extensión. */
function clipFilename(filename: string): string {
  if (filename.length <= FILENAME_MAX_CHARS) return filename
  const ext = /\.[a-z0-9]{1,8}$/i.exec(filename)?.[0] ?? ""
  return filename.slice(0, FILENAME_MAX_CHARS - ext.length) + ext
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
    const filename = clipFilename((attachment.filename ?? "adjunto").trim() || "adjunto")
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
      contentType: (attachment.mimeType || "application/octet-stream").slice(
        0,
        CONTENT_TYPE_MAX_CHARS,
      ),
      base64: attachment.content,
    })
  }
  return { kept, tooMuch, notAllowed }
}

/**
 * El aviso de los adjuntos que no se mandaron, aparte del texto: no se cita en la respuesta ni
 * viaja al modelo. Dice dónde está el correo completo según el camino: un buzón se reenvía al
 * buzón de siempre; la dirección de una persona, solo a su copia (si la tiene).
 */
export function omittedNote(
  tooMuch: readonly string[],
  notAllowed: readonly string[],
  kind: ApiRoute["kind"],
): string {
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
  const whole =
    kind === "buzon"
      ? "El correo completo llegó también al buzón de siempre."
      : "El correo completo llega solo a la copia de esa persona, si tiene una."
  const note = `${lines.join(" ")} ${whole}`
  return note.length > NOTICE_MAX_CHARS
    ? `${note.slice(0, NOTICE_MAX_CHARS - whole.length - 2)}… ${whole}`
    : note
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

/** El correo leído con postal-mime, para la API y para saber quién lo manda. */
type ParsedEmail = Awaited<ReturnType<typeof PostalMime.parse>>

function senderOf(
  email: ParsedEmail | null,
  envelopeFrom: string,
): { address: string; name: string | null } {
  const sender = email?.from?.address ? email.from : email?.from?.group?.[0]
  return {
    address: (sender?.address || envelopeFrom || "").trim().toLowerCase().slice(0, 254),
    name: sender?.name ? sender.name.slice(0, 500) : null,
  }
}

/**
 * La primera dirección del Reply-To (RFC 5322 §3.6.2), recortada; null si no trae. La respuesta
 * va ahí; el cliente se sigue ligando por el From verificado.
 */
function replyToOf(email: ParsedEmail): string | null {
  for (const entry of email.replyTo ?? []) {
    const address = entry.address || entry.group?.find((member) => member.address)?.address
    const clean = (address ?? "").trim().toLowerCase()
    if (clean && clean.length <= 254 && /^[^\s@<>]+@[^\s@<>]+$/.test(clean)) return clean
  }
  return null
}

/** El cuerpo que espera la API, armado desde el correo leído. */
export async function inboundBody(
  raw: Uint8Array,
  envelope: { from: string; to: string },
  route: ApiRoute,
  receivedAt: Date,
  authservId: string = CLOUDFLARE_AUTHSERV_ID,
  parsed?: ParsedEmail,
): Promise<string> {
  const email = parsed ?? (await PostalMime.parse(raw, { attachmentEncoding: "base64" }))
  const sender = senderOf(email, envelope.from)
  // Sin Message-ID, uno fijo por el contenido: el mismo correo no entra dos veces.
  const messageId =
    email.messageId?.trim() ||
    `<sin-id-${hex(await crypto.subtle.digest("SHA-256", raw))}@entrante.sallca>`
  const { kept, tooMuch, notAllowed } = pickAttachments(email.attachments)
  const note = omittedNote(tooMuch, notAllowed, route.kind)
  const text = (email.text ?? (email.html ? htmlToText(email.html) : "")).slice(0, TEXT_MAX_CHARS)
  const thread = threadHeaders(email.inReplyTo, email.references)
  return JSON.stringify({
    mailbox: route.kind === "persona" ? "persona" : route.mailbox,
    ...(route.kind === "persona" ? { localPart: route.localPart } : {}),
    product: route.product,
    messageId: messageId.slice(0, 998),
    from: sender.address,
    fromName: sender.name,
    to: envelope.to.trim().toLowerCase().slice(0, 254),
    subject: email.subject ? email.subject.slice(0, 5000) : null,
    text,
    notice: note || null,
    replyTo: replyToOf(email),
    receivedAt: receivedAt.toISOString(),
    attachments: kept,
    inReplyTo: thread.inReplyTo,
    references: thread.references,
    senderVerified: senderVerified(email.headers, sender.address, authservId),
  })
}

/**
 * Manda el correo a la API, una sola vez: `ok` con la copia de la persona (si la tiene),
 * `unknown` si la dirección no es de nadie (404 `MAILBOX_UNKNOWN`), `error` en lo demás.
 */
async function postToApi(body: string, env: Env): Promise<ApiOutcome> {
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
    const answer = (await response.json().catch(() => null)) as {
      data?: { copyTo?: string | null }
      error?: { code?: string }
    } | null
    if (response.ok) return { status: "ok", copyTo: answer?.data?.copyTo ?? null }
    if (response.status === 404 && answer?.error?.code === "MAILBOX_UNKNOWN")
      return { status: "unknown" }
    console.error(
      `correo entrante: la API respondió ${response.status} ${answer?.error?.code ?? ""}; no se reintenta`,
    )
    return { status: "error" }
  } catch (error) {
    console.error("correo entrante: no se pudo llegar a la API; no se reintenta", String(error))
    return { status: "error" }
  }
}

/**
 * El manejador del Worker. Lo exporta `index.ts` como `default`, y nada más: el runtime de
 * Cloudflare toma cada exportación del módulo principal como un punto de entrada y no arranca si
 * una no es un manejador (una constante, una función de ayuda).
 */
export const emailWorker = {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer())
    let parsed: ParsedEmail | null = null
    try {
      parsed = await PostalMime.parse(raw, { attachmentEncoding: "base64" })
    } catch (error) {
      console.error("correo entrante: no se pudo leer el correo", String(error))
    }
    await deliver(message.to, env, {
      forward: async (to) => {
        await message.forward(to)
      },
      reject: (reason) => message.setReject(reason),
      skipReason: () =>
        skipReason((name) => message.headers.get(name), senderOf(parsed, message.from).address),
      warn: (text) => console.error(text),
      post: async (route: Exclude<Route, { kind: "reenviar" }>) => {
        if (!env.API_URL || !env.INBOUND_EMAIL_SECRET) {
          console.error(
            "correo entrante: faltan API_URL o INBOUND_EMAIL_SECRET; no se mandó a la API",
          )
          return { status: "error" }
        }
        if (!parsed) return { status: "error" }
        return postToApi(
          await inboundBody(raw, message, route, new Date(), env.AUTHSERV_ID || undefined, parsed),
          env,
        )
      },
    })
  },
} satisfies ExportedHandler<Env>
