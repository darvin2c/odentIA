// Chat web embebible propio (widget): sin proveedor externo. La entrega al
// visitante ocurre por polling autorizado contra nuestra API; el adaptador
// solo normaliza el protocolo (verificación, parse, envío local) para que la
// ingesta y el outbound usen el mismo pipeline que el resto de canales.
//
// Entrega honesta: `sendMessage` acepta el mensaje para entrega local y, si la
// conexión configura `notifyUrl`, avisa con un POST firmado al backend del
// sitio (útil para refrescar el widget). El visitante lo recibe al hacer poll y
// recién entonces el mensaje pasa a `delivered`. Nunca se finge lectura del
// visitante.
//
// Un solo chat por clínica (decisión 7 del pulido de la Bandeja), servido desde
// su dirección: los sitios donde responde los guarda `webchat_site`, no la
// configuración.
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

/**
 * El hilo y el remitente del visitante son su sesión: `webchat:<uuid>`. La
 * prueba desde Configuración lleva `webchat:prueba:<uuid>`: así lo sabe todo el
 * camino (ingesta, aviso al sitio) sin consultar nada.
 */
export function newWebchatSessionId(opts: { test?: boolean } = {}): string {
  return `webchat:${opts.test ? "prueba:" : ""}${randomUUID()}`
}

/** ¿Identificador de sesión/hilo del widget con formato válido? */
export function isWebchatSessionId(value: string): boolean {
  return /^webchat:(prueba:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

/** ¿Es una sesión de prueba de Configuración? */
export function isWebchatTestSession(value: string): boolean {
  return value.startsWith("webchat:prueba:")
}

export type WebchatConnectionConfig = {
  /** Color del botón y de la cabecera del chat (#rrggbb). */
  widgetColor?: string
  /** El saludo: la primera burbuja de Sofi. */
  greeting?: string
  /** Aviso opcional al sitio: POST firmado al responder el equipo o Sofi. */
  notifyUrl?: string
  /**
   * La clave anterior tras «Generar un código nuevo», con cuándo se cambió:
   * los visitantes que ya estaban siguen en su conversación 30 días.
   */
  previousSecret?: string
  rotatedAt?: string
}
/** Sesión de visitante: el chat la recuerda en su navegador 30 días (fase 6 del pulido). */
export const WEBCHAT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * El sitio donde se cargó el chat, como lo dice el navegador (`location.origin`):
 * esquema, dominio y puerto, en minúsculas. Nulo si no es una dirección web; en
 * claro (`http:`) solo para pruebas locales.
 */
export function normalizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin.trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (url.protocol === "http:") {
      const host = url.hostname.toLowerCase()
      if (host !== "localhost" && host !== "127.0.0.1" && !host.endsWith(".localhost")) return null
    }
    return url.origin.toLowerCase()
  } catch {
    return null
  }
}

function pickString(config: Record<string, unknown>, key: string): string | null {
  const v = config[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

/**
 * Valida la config del widget; lanza con mensaje en español si es inválida. Lo
 * que ya no se usa (orígenes y título: el chat se llama como la clínica y los
 * sitios están en `webchat_site`) se descarta sin error.
 */
export function assertValidWebchatConfig(config: Record<string, unknown>): WebchatConnectionConfig {
  const notifyUrl = pickString(config, "notifyUrl")
  if (notifyUrl !== null) {
    try {
      const url = new URL(notifyUrl)
      if (url.protocol !== "https:") throw new Error()
    } catch {
      throw new Error("La dirección del aviso al sitio debe empezar con https://")
    }
  }
  const out: WebchatConnectionConfig = {}
  const color = pickString(config, "widgetColor")
  const greeting = pickString(config, "greeting")
  const previousSecret = pickString(config, "previousSecret")
  const rotatedAt = pickString(config, "rotatedAt")
  if (previousSecret !== null && rotatedAt !== null) {
    out.previousSecret = previousSecret
    out.rotatedAt = rotatedAt
  }
  if (color !== null) {
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error("Elige un color de la lista")
    out.widgetColor = color
  }
  if (greeting !== null) {
    if (greeting.length > 500) throw new Error("El saludo admite hasta 500 caracteres")
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

/**
 * La sesión de un token con la clave vigente o, hasta 30 días después de
 * «Generar un código nuevo», con la anterior (`renew`: la ruta le entrega uno
 * nuevo). Así nadie pierde su conversación por cambiar el código.
 */
export function readWebchatToken(
  config: Pick<WebchatConnectionConfig, "previousSecret" | "rotatedAt">,
  webhookSecret: string,
  token: string,
  now: number = Date.now(),
): { sessionId: string; expiresAt: number; renew: boolean } | null {
  const current = verifyWebchatToken(webhookSecret, token)
  if (current) return { ...current, renew: false }
  if (!config.previousSecret || !config.rotatedAt) return null
  if (now - Date.parse(config.rotatedAt) > WEBCHAT_TOKEN_TTL_MS) return null
  const previous = verifyWebchatToken(config.previousSecret, token)
  return previous ? { ...previous, renew: true } : null
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
  const externalMessageId = `webchat:${sessionId.slice("webchat:".length).replace("prueba:", "prueba-")}:${payload.clientMessageId}`
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
    // Sin pedirle el nombre (decisión 9): mientras no lo diga, es un visitante del chat.
    senderDisplayName: payload.displayName?.trim()
      ? payload.displayName.trim().slice(0, 80)
      : isWebchatTestSession(sessionId)
        ? "Prueba del chat web"
        : "Visitante del chat web",
    content: { type: "text", text },
    sentAt,
    ...(isWebchatTestSession(sessionId) ? { test: true } : {}),
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
    // Una prueba de Configuración nunca avisa al sitio (fase 6 del pulido).
    if (!notifyUrl || isWebchatTestSession(msg.to)) {
      // Sin push configurado el visitante lo recibe por polling; el id
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
      // Firmado con la clave de la conexión (`x-webchat-signature`, la misma
      // firma que se exige al sitio cuando escribe): el sitio sabe que es nuestro.
      response = await deps.fetch(notifyUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(deps.webhookSecret ? { "x-webchat-signature": signWebchatBody(deps.webhookSecret, rawBody) } : {}),
        },
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
    assertValidWebchatConfig(config)
    // Sin red externa ni cuenta de proveedor: un id propio, sin choques entre clínicas.
    return { externalId: `webchat:${randomUUID()}`, displayName: "Chat web" }
  },
}
