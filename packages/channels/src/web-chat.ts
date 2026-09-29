// Chat web embebible propio (widget): sin proveedor externo. La entrega al
// visitante ocurre por polling/SSE autorizado contra nuestra API; el adaptador
// solo normaliza el protocolo (verificación, parse, envío local) para que la
// ingesta y el outbound usen el mismo pipeline que el resto de canales.
//
// Entrega honesta: `sendMessage` acepta el mensaje para entrega local y, si la
// conexión configura `notifyUrl`, avisa con un POST al backend del sitio (útil
// para refrescar el widget). El visitante lo recibe al hacer poll/SSE y recién
// entonces el mensaje pasa a `delivered`. Nunca se finge lectura del visitante.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  NormalizedInbound,
  OutboundMessage,
  WebhookParseResult,
} from "./protocol.js"

/** Canal lógico de las identidades e hilos del widget. */
export const WEBCHAT_CHANNEL = "webchat"

/** El hilo y el remitente del visitante son su sesión: `webchat:<uuid>`. */
export function newWebchatSessionId(): string {
  return `webchat:${randomUUID()}`
}

/** ¿Identificador de sesión/hilo del widget con formato válido? */
export function isWebchatSessionId(value: string): boolean {
  return /^webchat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

export type WebchatConnectionConfig = {
  /** Orígenes permitidos a incrustar el widget. Exactos (`https://tienda.test`)
   * o `*.` + base (`https://*.odentia.localhost`, solo dev local). */
  allowedOrigins: string[]
  widgetTitle?: string
  widgetColor?: string
  greeting?: string
  /** Webhook opcional del sitio: POST al responder el operador/agente. */
  notifyUrl?: string
}
/** Sesión de visitante: 24 h de validez, alcance limitado a la sesión. */
export const WEBCHAT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

function readOrigins(config: Record<string, unknown>): string[] {
  const raw = config["allowedOrigins"]
  if (!Array.isArray(raw)) return []
  return raw.filter((o): o is string => typeof o === "string")
}

/** Normaliza un Origin (`https://tienda.test`, sin barra final, minúsculas). */
export function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, "")
}

/** ¿El Origin puede usar el widget de esta conexión? */
export function isOriginAllowed(config: Record<string, unknown>, origin: string): boolean {
  const want = normalizeOrigin(origin)
  if (!want) return false
  for (const entry of readOrigins(config)) {
    const allowed = normalizeOrigin(entry)
    if (allowed.startsWith("https://*.")) {
      const base = allowed.slice("https://*.".length)
      if (want.startsWith("https://") && (want === `https://${base}` || want.endsWith(`.${base}`))) {
        return true
      }
    } else if (want === allowed) {
      return true
    }
  }
  return false
}

function pickString(config: Record<string, unknown>, key: string): string | null {
  const v = config[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

function validOriginEntry(entry: string): boolean {
  const v = entry.trim()
  if (v.startsWith("https://*.")) return v.length > "https://*.".length && !v.includes("/", 9)
  try {
    const url = new URL(v)
    if (url.protocol !== "https:" && url.protocol !== "http:") return false
    // http solo en local: nunca un widget en claro en producción.
    if (url.protocol === "http:") {
      const host = url.hostname.toLowerCase()
      if (host !== "localhost" && host !== "127.0.0.1" && !host.endsWith(".localhost")) return false
    }
    return true
  } catch {
    return false
  }
}

/** Valida la config del widget; lanza con mensaje en español si es inválida. */
export function assertValidWebchatConfig(config: Record<string, unknown>): WebchatConnectionConfig {
  const origins = readOrigins(config).map((o) => o.trim()).filter(Boolean)
  if (origins.length === 0) {
    throw new Error("El chat web exige al menos un origen permitido (allowedOrigins)")
  }
  if (origins.length > 50) throw new Error("El chat web admite hasta 50 orígenes permitidos")
  for (const o of origins) {
    if (!validOriginEntry(o)) throw new Error(`Origen permitido inválido: ${o}`)
  }
  const notifyUrl = pickString(config, "notifyUrl")
  if (notifyUrl !== null) {
    try {
      const url = new URL(notifyUrl)
      if (url.protocol !== "https:") throw new Error()
    } catch {
      throw new Error("notifyUrl debe ser una URL https válida")
    }
  }
  const out: WebchatConnectionConfig = { allowedOrigins: [...new Set(origins)] }
  const title = pickString(config, "widgetTitle")
  const color = pickString(config, "widgetColor")
  const greeting = pickString(config, "greeting")
  if (title !== null) {
    if (title.length > 80) throw new Error("El título del widget admite hasta 80 caracteres")
    out.widgetTitle = title
  }
  if (color !== null) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("El color del widget debe ser hex (#rrggbb)")
    out.widgetColor = color
  }
  if (greeting !== null) {
    if (greeting.length > 500) throw new Error("El saludo del widget admite hasta 500 caracteres")
    out.greeting = greeting
  }
  if (notifyUrl !== null) out.notifyUrl = notifyUrl
  return out
}

/** Token de sesión: `v1.<sessionId>.<exp>.<hmac>` (clave = webhookSecret). */
export function createWebchatToken(
  webhookSecret: string,
  sessionId: string,
  ttlMs: number = WEBCHAT_TOKEN_TTL_MS,
): string {
  const exp = String(Date.now() + ttlMs)
  const sig = createHmac("sha256", webhookSecret).update(`${sessionId}.${exp}`, "utf8").digest("hex")
  return `v1.${sessionId}.${exp}.${sig}`
}

/** Verifica alcance (formato + firma + expiración). Null = inválido. */
export function verifyWebchatToken(
  webhookSecret: string,
  token: string,
): { sessionId: string; expiresAt: number } | null {
  const parts = token.split(".")
  if (parts.length !== 4 || parts[0] !== "v1" || !parts[1] || !parts[2] || !parts[3]) return null
  const sessionId = parts[1]
  const exp = Number(parts[2])
  if (!isWebchatSessionId(sessionId) || !Number.isInteger(exp) || exp <= Date.now()) return null
  const expected = createHmac("sha256", webhookSecret)
    .update(`${sessionId}.${parts[2]}`, "utf8")
    .digest("hex")
  if (expected.length !== parts[3].length) return null
  try {
    if (!timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(parts[3], "utf8"))) return null
  } catch {
    return null
  }
  return { sessionId, expiresAt: exp }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v
  }
  return undefined
}

/** Firma del cuerpo para el webhook opcional del sitio (`x-webchat-signature`). */
export function signWebchatBody(webhookSecret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", webhookSecret).update(rawBody, "utf8").digest("hex")}`
}

export interface WebchatVisitorPayload {
  clientMessageId: string
  text: string
  displayName?: string
  sentAt?: string
}

/** Normaliza un mensaje del visitante (misma conversación del pipeline). */
export function buildWebchatInbound(sessionId: string, payload: WebchatVisitorPayload): NormalizedInbound {
  const text = payload.text.trim()
  const externalMessageId = `webchat:${sessionId.slice("webchat:".length)}:${payload.clientMessageId}`
  let sentAt = new Date().toISOString()
  if (payload.sentAt) {
    const parsed = new Date(payload.sentAt)
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() <= Date.now() + 60_000) {
      sentAt = parsed.toISOString()
    }
  }
  return {
    externalEventId: externalMessageId,
    externalMessageId,
    externalThreadId: sessionId,
    senderExternalId: sessionId,
    ...(payload.displayName?.trim() ? { senderDisplayName: payload.displayName.trim().slice(0, 80) } : {}),
    content: { type: "text", text },
    sentAt,
  }
}

interface WebchatWireMessage {
  id?: unknown
  clientMessageId?: unknown
  text?: unknown
  displayName?: unknown
  sentAt?: unknown
}

function wireMessageOf(value: unknown): WebchatWireMessage | null {
  if (!value || typeof value !== "object") return null
  return value as WebchatWireMessage
}

function messageIdOf(m: WebchatWireMessage): string | null {
  const raw = m.id ?? m.clientMessageId
  if (typeof raw !== "string" || !raw.trim() || raw.length > 120) return null
  // El id lo genera el visitante: solo caracteres seguros, sin rutas ni SQL.
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(raw.trim())) return null
  return raw.trim()
}

export const webChatAdapter: ChannelAdapter = {
  provider: "web_chat",
  capabilities: {
    templates: false,
    media: false,
    interactive: false,
    readReceipts: true,
    edit: false,
  },

  verifyWebhook({ headers, rawBody, webhookSecret }) {
    if (!webhookSecret) return false
    const given = header(headers, "x-webchat-signature")
    if (!given || !given.startsWith("sha256=")) return false
    const expected = signWebchatBody(webhookSecret, rawBody)
    if (expected.length !== given.length) return false
    return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"))
  },

  parseWebhook({ rawBody }): WebhookParseResult {
    const empty: WebhookParseResult = { messages: [], statuses: [] }
    let body: unknown
    try {
      body = JSON.parse(rawBody) as unknown
    } catch {
      return empty
    }
    if (!body || typeof body !== "object") return empty
    const record = body as Record<string, unknown>
    const sessionId = record["sessionId"]
    if (typeof sessionId !== "string" || !isWebchatSessionId(sessionId)) return empty
    const wire: unknown[] = Array.isArray(record["messages"])
      ? (record["messages"] as unknown[])
      : record["message"] !== undefined
        ? [record["message"]]
        : []
    const messages: NormalizedInbound[] = []
    for (const item of wire) {
      const m = wireMessageOf(item)
      if (!m) continue
      const clientMessageId = messageIdOf(m)
      if (!clientMessageId) continue
      const text = typeof m.text === "string" ? m.text.trim() : ""
      if (!text || text.length > 2000) continue
      messages.push(
        buildWebchatInbound(sessionId, {
          clientMessageId,
          text,
          ...(typeof m.displayName === "string" ? { displayName: m.displayName } : {}),
          ...(typeof m.sentAt === "string" ? { sentAt: m.sentAt } : {}),
        }),
      )
    }
    return { messages, statuses: [] }
  },

  async sendMessage(config, msg: OutboundMessage, deps: ChannelAdapterDeps) {
    // Sin sesión válida no hay entrega: el worker ya persistió el mensaje en
    // `queued` antes de llamarnos; si el destino no es una sesión web, se
    // rechaza para reintento/auditoría en vez de fingir el envío.
    if (!isWebchatSessionId(msg.to)) {
      throw new Error("Chat web: destino sin sesión válida, no se envía")
    }
    if (msg.kind.type === "media" || msg.kind.type === "template") {
      throw new Error("Chat web: solo texto en esta versión")
    }
    const text = msg.kind.type === "text" ? msg.kind.text : ""
    if (!text.trim()) throw new Error("Chat web: texto vacío, no se envía")
    const notifyUrl = pickString(config, "notifyUrl")
    if (!notifyUrl) {
      // Sin push configurado el visitante lo recibe por polling/SSE; el id
      // local marca aceptación para entrega (delivered real al hacer poll).
      return { externalId: `webchat:local:${randomUUID()}` }
    }
    const sessionId = msg.to
    const payload = {
      event: "operator.message",
      to: sessionId,
      sessionId,
      text,
      at: new Date().toISOString(),
    }
    const rawBody = JSON.stringify(payload)
    let response: Response
    try {
      response = await deps.fetch(notifyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: rawBody,
      })
    } catch {
      throw new Error("Chat web: no se pudo avisar al sitio (notifyUrl inalcanzable)")
    }
    if (!response.ok) throw new Error(`Chat web: el sitio rechazó el aviso (${response.status})`)
    // El endpoint del sitio puede devolver su id de entrega para trazabilidad;
    // sin él se deriva uno estable del contenido (documentado en el servicio).
    let deliveryId: string | null = null
    try {
      const json = (await response.json()) as unknown
      if (json && typeof json === "object") {
        for (const key of ["deliveryId", "id", "messageId"]) {
          const v = (json as Record<string, unknown>)[key]
          if (typeof v === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(v)) {
            deliveryId = v
            break
          }
        }
      }
    } catch {
      deliveryId = null
    }
    if (!deliveryId) {
      deliveryId = createHash("sha256").update(`${sessionId}.${text}`, "utf8").digest("hex").slice(0, 16)
    }
    return { externalId: `webchat:${deliveryId}` }
  },

  async validateConnection(config) {
    const valid = assertValidWebchatConfig(config)
    // Sin red externa: la "validación" es la config de orígenes. El externalId
    // deriva del set canónico de orígenes (único por conexión típica; el índice
    // único provider+external lo protege ante duplicados exactos).
    const canonical = JSON.stringify([...valid.allowedOrigins].sort())
    const externalId = `webchat:${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16)}`
    return { externalId, displayName: valid.widgetTitle ?? "Chat web" }
  },
}
