// Adaptadores oficiales Meta: Messenger (Messenger Platform, Facebook Login)
// e Instagram (Instagram API con Instagram Login). Cada uno usa su host,
// token y permisos: no se mezclan flujos.
// Docs primarias (consultadas 2026-09-28):
// - Messenger webhooks: https://developers.facebook.com/docs/messenger-platform/webhooks/
// - Messenger Send: https://developers.facebook.com/docs/messenger-platform/send-messages/
// - Send API ref: https://developers.facebook.com/docs/messenger-platform/reference/send-api/
// - IG mensajes: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/
// - IG webhooks: https://developers.facebook.com/docs/instagram-platform/webhooks/
// Messenger: host graph.facebook.com, token de página, permiso pages_messaging,
// envío POST /{PAGE-ID}/messages con messaging_type RESPONSE.
// Instagram Login: host graph.instagram.com, token de usuario de Instagram,
// permisos instagram_business_basic + instagram_business_manage_messages,
// envío POST /{IG-ID}/messages (sin messaging_type), texto máx. 1000 bytes,
// media imagen/audio/video/pdf. Inicio solo por la persona; ventana 24 h.
// Los adjuntos entrantes ya traen `payload.url`: mediaExternalId es esa URL y
// fetchMedia la descarga directa (URLs pre-autenticadas de corta vida).
// Sin credenciales reales no hay llamada externa: validateConnection y
// sendMessage exigen token/ids y fallan con error explícito.
import { createHmac, timingSafeEqual } from "node:crypto"
import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  NormalizedInbound,
  NormalizedStatus,
  OutboundMessage,
  WebhookParseResult,
} from "./protocol.js"
import { ConnectionRejectedError, ProviderRejectedError, ProviderThrottledError } from "./protocol.js"
import { graphRejectedPart, metaGraphVersion } from "./meta-graph.js"

const GRAPH_HOST = "https://graph.facebook.com"
const IG_HOST = "https://graph.instagram.com"

export interface MessengerConfig {
  pageId: string
  pageAccessToken: string
  appSecret: string
}

export interface InstagramConfig {
  /** ID de la cuenta profesional de Instagram (IG-ID). */
  instagramId: string
  /** Token de usuario de Instagram con instagram_business_manage_messages. */
  accessToken: string
  appSecret: string
}

function pick(config: Record<string, unknown>, key: string, label: string): string {
  const v = config[key]
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${label}: falta ${key} en la configuración de la conexión`)
  }
  return v
}

function messengerConfig(config: Record<string, unknown>): MessengerConfig {
  return {
    pageId: pick(config, "pageId", "Messenger"),
    pageAccessToken: pick(config, "pageAccessToken", "Messenger"),
    appSecret: pick(config, "appSecret", "Messenger"),
  }
}

function instagramConfig(config: Record<string, unknown>): InstagramConfig {
  return {
    instagramId: pick(config, "instagramId", "Instagram"),
    accessToken: pick(config, "accessToken", "Instagram"),
    appSecret: pick(config, "appSecret", "Instagram"),
  }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v
  }
  return undefined
}

/** Verifica la firma HMAC-SHA256 del raw body con el app secret (Meta). */
export function verifyMetaSignature(
  headers: Record<string, string>,
  rawBody: string,
  appSecret: string,
): boolean {
  if (!appSecret) return false
  const given = header(headers, "x-hub-signature-256")
  if (!given || !given.startsWith("sha256=")) return false
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`
  if (expected.length !== given.length) return false
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"))
}

/**
 * Reto de verificación de Meta (GET del webhook). `hub.verify_token` debe ser
 * el webhookSecret generado al crear la conexión. Devuelve el challenge o null.
 */
export function verifyMetaChallenge(
  query: { mode: string | null; token: string | null; challenge: string | null },
  webhookSecret: string,
): string | null {
  if (
    query.mode === "subscribe" &&
    query.token &&
    webhookSecret &&
    query.token === webhookSecret &&
    query.challenge
  ) {
    return query.challenge
  }
  return null
}

interface MetaAttachment {
  type?: string
  payload?: { url?: string }
}

interface MetaMessage {
  mid?: string
  text?: string
  attachments?: MetaAttachment[]
  is_echo?: boolean
  quick_reply?: { payload?: string }
}

interface MetaMessaging {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: MetaMessage
  postback?: { payload?: string; title?: string }
  delivery?: { mids?: string[] }
  read?: { watermark?: number }
}

interface MetaEntry {
  id?: string
  messaging?: MetaMessaging[]
}

function parseBody(rawBody: string): { object?: string; entries: MetaEntry[] } {
  try {
    const body = JSON.parse(rawBody) as { object?: unknown; entry?: unknown }
    if (!body || typeof body !== "object" || !Array.isArray(body.entry)) {
      return { entries: [] }
    }
    return {
      object: typeof body.object === "string" ? body.object : undefined,
      entries: body.entry as MetaEntry[],
    }
  } catch {
    return { entries: [] }
  }
}

const INBOUND_MIME: Record<string, string> = {
  image: "image/jpeg",
  audio: "audio/mpeg",
  video: "video/mp4",
  file: "application/octet-stream",
}

/** Traduce un evento de mensajería Meta al núcleo normalizado. */
function toNormalized(
  expectedObject: "page" | "instagram",
  actualObject: string | undefined,
  prefix: "msgr" | "ig",
  expectedRecipient: string,
  ev: MetaMessaging,
  messages: NormalizedInbound[],
  statuses: NormalizedStatus[],
): void {
  if (actualObject !== expectedObject) return
  const senderId = ev.sender?.id
  if (!senderId) return
  // El webhook es por conexión: ignora eventos de otra página/cuenta.
  if (ev.recipient?.id && ev.recipient.id !== expectedRecipient) return
  const sentAt =
    typeof ev.timestamp === "number" ? new Date(ev.timestamp).toISOString() : new Date().toISOString()
  if (ev.delivery?.mids) {
    for (const mid of ev.delivery.mids) {
      if (typeof mid === "string" && mid) statuses.push({ externalMessageId: mid, status: "delivered" })
    }
    return
  }
  // `read` solo trae watermark (sin mid): no se puede atribuir a un mensaje.
  const msg = ev.message
  if (msg) {
    // Ecos propios (mensajes enviados por la página): nunca se ingieren.
    if (msg.is_echo) return
    if (typeof msg.mid !== "string" || !msg.mid) return
    const base = {
      externalEventId: msg.mid,
      externalMessageId: msg.mid,
      externalThreadId: `${prefix}:${senderId}`,
      senderExternalId: `${prefix}:${senderId}`,
      sentAt,
    }
    const text = typeof msg.text === "string" ? msg.text : ""
    const quick = msg.quick_reply?.payload
    if (text || quick) {
      messages.push({ ...base, content: { type: "text", text: text || String(quick) } })
      return
    }
    const [att] = msg.attachments ?? []
    const url = att?.payload?.url
    if (att && typeof url === "string" && url) {
      const kind = att.type ?? "file"
      messages.push({
        ...base,
        content: {
          type: "media",
          mediaExternalId: url,
          mimeType: INBOUND_MIME[kind] ?? "application/octet-stream",
        },
      })
    }
    // Adjuntos sin URL o tipos no mensaje (stickers sin texto, etc.): se ignoran.
    return
  }
  if (ev.postback && typeof ev.postback.payload === "string" && ev.postback.payload) {
    messages.push({
      externalEventId: `${ev.postback.payload}:${ev.timestamp ?? ""}`,
      externalMessageId: `${ev.postback.payload}:${ev.timestamp ?? ""}`,
      externalThreadId: `${prefix}:${senderId}`,
      senderExternalId: `${prefix}:${senderId}`,
      sentAt,
      content: { type: "text", text: ev.postback.payload },
    })
  }
}

async function graphCall(
  path: string,
  token: string,
  init: { method?: string; body?: unknown },
  deps: ChannelAdapterDeps,
  base: string = `${GRAPH_HOST}/${metaGraphVersion()}`,
): Promise<{ status: number; json: unknown }> {
  const res = await deps.fetch(`${base}/${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  const json: unknown = await res.json().catch(() => null)
  return { status: res.status, json }
}

function graphError(status: number, json: unknown): string {
  if (json && typeof json === "object" && "error" in json) {
    const err = json.error as { message?: unknown; code?: unknown }
    return `${status} ${String(err.message ?? err.code ?? "error")}`
  }
  return String(status)
}

/**
 * Límites de ritmo del Graph de Meta: de la app (4), de quien usa la app (17),
 * de la página (32), del método (613) y por caso de uso de páginas, Instagram y
 * Messenger (80001, 80002, 80006). El envío no salió y se reintenta más tarde.
 * https://developers.facebook.com/docs/graph-api/overview/rate-limiting
 */
const GRAPH_THROTTLE_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80006])

/** El `error` de una respuesta del Graph, si lo trae. */
function graphErrorOf(json: unknown): { code?: unknown } | undefined {
  if (!json || typeof json !== "object" || !("error" in json)) return undefined
  return json.error && typeof json.error === "object" ? json.error : undefined
}

function sentMessageId(json: unknown): string | null {
  if (json && typeof json === "object" && "message_id" in json && typeof json.message_id === "string") {
    return json.message_id
  }
  return null
}

type MetaAttachmentType = "image" | "audio" | "video" | "file"

function attachmentTypeOf(mimeType: string): MetaAttachmentType {
  if (mimeType.startsWith("image/")) return "image"
  if (mimeType.startsWith("audio/")) return "audio"
  if (mimeType.startsWith("video/")) return "video"
  return "file"
}
function stripPrefix(to: string, prefix: string): string {
  return to.startsWith(`${prefix}:`) ? to.slice(prefix.length + 1) : to
}

async function sendViaGraph(
  label: "Messenger" | "Instagram",
  base: string,
  path: string,
  token: string,
  recipientId: string,
  kind: OutboundMessage["kind"],
  deps: ChannelAdapterDeps,
  messagingType: "RESPONSE" | null,
): Promise<{ externalId: string }> {
  // Lo que no se puede enviar no sale: no es un envío ambiguo.
  if (kind.type === "template") {
    throw new ProviderRejectedError(`${label} no admite plantillas: responde dentro de la ventana de 24 h`)
  }
  // Instagram Login limita el texto a 1000 bytes UTF-8 (docs messaging-api).
  if (kind.type === "text" && label === "Instagram" && Buffer.byteLength(kind.text, "utf8") > 1000) {
    throw new ProviderRejectedError("Instagram limita el texto a 1000 bytes")
  }
  const message: Record<string, unknown> =
    kind.type === "text"
      ? { text: kind.text }
      : {
          attachment: {
            type: attachmentTypeOf(kind.media.mimeType),
            payload: { url: kind.media.url, is_reusable: false },
          },
        }
  const { status, json } = await graphCall(
    path,
    token,
    {
      method: "POST",
      body: {
        recipient: { id: recipientId },
        ...(messagingType ? { messaging_type: messagingType } : {}),
        message,
      },
    },
    deps,
    base,
  )
  const id = sentMessageId(json)
  if (status >= 400 || !id) {
    const detail = `${label} send falló: ${graphError(status, json)}`
    // Meta contestó con su error: no lo aceptó. Un 5xx o una respuesta sin id
    // no dicen si salió, y se tratan como ambiguos.
    const error = graphErrorOf(json)
    if (status >= 400 && status < 500 && error) {
      if (typeof error.code === "number" && GRAPH_THROTTLE_CODES.has(error.code)) throw new ProviderThrottledError(detail)
      throw new ProviderRejectedError(detail)
    }
    throw new Error(detail)
  }
  return { externalId: id }
}

async function downloadMedia(
  label: string,
  url: string,
  deps: ChannelAdapterDeps,
): Promise<{ bytes: Uint8Array; mimeType: string; filename: string }> {
  const res = await deps.fetch(url)
  if (!res.ok) throw new Error(`${label} descarga de media falló: ${res.status}`)
  const mimeType = res.headers.get("content-type") ?? "application/octet-stream"
  const bytes = new Uint8Array(await res.arrayBuffer())
  const last = url.split("?")[0]?.split("/").at(-1)
  return { bytes, mimeType, filename: last && last.includes(".") ? last : "adjunto" }
}

export const messengerAdapter: ChannelAdapter = {
  provider: "messenger",
  capabilities: { templates: false, media: true, interactive: false, readReceipts: true, edit: false },

  verifyWebhook({ headers, rawBody, config }) {
    const secret = typeof config["appSecret"] === "string" ? config["appSecret"] : ""
    return verifyMetaSignature(headers, rawBody, secret)
  },

  parseWebhook({ rawBody, config }) {
    const empty: WebhookParseResult = { messages: [], statuses: [] }
    const { object, entries } = parseBody(rawBody)
    let recipient = ""
    try {
      recipient = messengerConfig(config).pageId
    } catch {
      return empty
    }
    for (const entry of entries) {
      for (const ev of entry.messaging ?? []) {
        toNormalized("page", object, "msgr", recipient, ev, empty.messages, empty.statuses)
      }
    }
    return empty
  },

  async sendMessage(config, msg, deps) {
    const cfg = messengerConfig(config)
    return sendViaGraph(
      "Messenger",
      `${GRAPH_HOST}/${metaGraphVersion()}`,
      `${cfg.pageId}/messages`,
      cfg.pageAccessToken,
      stripPrefix(msg.to, "msgr"),
      msg.kind,
      deps,
      "RESPONSE",
    )
  },

  async fetchMedia(_config, mediaExternalId, deps) {
    return downloadMedia("Messenger", mediaExternalId, deps)
  },

  async validateConnection(config, deps) {
    const cfg = messengerConfig(config)
    const { status, json } = await graphCall(
      `${cfg.pageId}?fields=id,name`,
      cfg.pageAccessToken,
      {},
      deps,
    )
    if (status >= 500) throw new Error(`Messenger no respondió al comprobar la página: ${graphError(status, json)}`)
    if (status >= 400 || !json || typeof json !== "object" || !("id" in json)) {
      throw new ConnectionRejectedError("Messenger validate falló: token o página inválida", graphRejectedPart(json))
    }
    const id = typeof json.id === "string" ? json.id : cfg.pageId
    const name = "name" in json && typeof json.name === "string" ? json.name : id
    return { externalId: id, displayName: name }
  },
}



export const instagramAdapter: ChannelAdapter = {
  provider: "instagram",
  capabilities: { templates: false, media: true, interactive: false, readReceipts: true, edit: false },

  verifyWebhook({ headers, rawBody, config }) {
    const secret = typeof config["appSecret"] === "string" ? config["appSecret"] : ""
    return verifyMetaSignature(headers, rawBody, secret)
  },

  parseWebhook({ rawBody, config }) {
    const empty: WebhookParseResult = { messages: [], statuses: [] }
    const { object, entries } = parseBody(rawBody)
    let recipient = ""
    try {
      recipient = instagramConfig(config).instagramId
    } catch {
      return empty
    }
    for (const entry of entries) {
      for (const ev of entry.messaging ?? []) {
        toNormalized("instagram", object, "ig", recipient, ev, empty.messages, empty.statuses)
      }
    }
    return empty
  },

  async sendMessage(config, msg, deps) {
    const cfg = instagramConfig(config)
    return sendViaGraph(
      "Instagram",
      `${IG_HOST}/${metaGraphVersion()}`,
      `${cfg.instagramId}/messages`,
      cfg.accessToken,
      stripPrefix(msg.to, "ig"),
      msg.kind,
      deps,
      null,
    )
  },

  async fetchMedia(_config, mediaExternalId, deps) {
    return downloadMedia("Instagram", mediaExternalId, deps)
  },

  async validateConnection(config, deps) {
    const cfg = instagramConfig(config)
    const { status, json } = await graphCall(
      `${cfg.instagramId}?fields=id,username`,
      cfg.accessToken,
      {},
      deps,
      `${IG_HOST}/${metaGraphVersion()}`,
    )
    if (status >= 500) throw new Error(`Instagram no respondió al comprobar la cuenta: ${graphError(status, json)}`)
    if (status >= 400 || !json || typeof json !== "object" || !("id" in json)) {
      throw new ConnectionRejectedError("Instagram validate falló: token o cuenta inválido", graphRejectedPart(json))
    }
    const id = typeof json.id === "string" ? json.id : cfg.instagramId
    const username =
      "username" in json && typeof json.username === "string" ? `@${json.username}` : id
    return { externalId: id, displayName: username }
  },
}
