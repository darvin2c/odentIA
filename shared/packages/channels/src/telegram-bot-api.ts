import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  NormalizedInbound,
  OutboundMessage,
  WebhookParseResult,
} from "./protocol.js"
import { ConnectionRejectedError, ProviderRejectedError, ProviderThrottledError } from "./protocol.js"

export interface TelegramBotConfig {
  botToken: string
}

function getConfig(config: Record<string, unknown>): TelegramBotConfig {
  const botToken = config["botToken"]
  if (typeof botToken !== "string" || botToken.length === 0) {
    throw new Error("Telegram: falta botToken en la configuración de la conexión")
  }
  return { botToken }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v
  }
  return undefined
}

interface TelegramUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
}

interface TelegramMessage {
  message_id: number
  date: number
  chat: { id: number }
  from?: TelegramUser
  text?: string
  caption?: string
  photo?: { file_id: string }[]
  document?: TelegramFile
  voice?: TelegramFile
  audio?: TelegramFile
  video?: TelegramFile
  /** Video redondo: Telegram no dice su tipo; siempre es MPEG-4. */
  video_note?: TelegramFile
  /** Mensaje que la persona citó al responder. */
  reply_to_message?: { message_id: number }
  /** Viene reenviado de otro chat (Bot API 7: `forward_origin`; antes, `forward_date`). */
  forward_origin?: unknown
  forward_date?: number
  location?: { latitude: number; longitude: number }
  /** Un lugar con nombre: trae su ubicación, título y dirección. */
  venue?: { location?: { latitude: number; longitude: number }; title?: string; address?: string }
}

/** Archivo de Bot API (Document, Voice, Audio, Video, VideoNote). */
interface TelegramFile {
  file_id: string
  mime_type?: string
}

interface TelegramUpdate {
  update_id?: unknown
  message?: TelegramMessage
  edited_message?: TelegramMessage
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return !!value && typeof value === "object"
}

function displayNameOf(from?: TelegramUser): string | undefined {
  if (!from) return undefined
  const full = [from.first_name, from.last_name].filter(Boolean).join(" ").trim()
  if (full) return full
  return from.username ? `@${from.username}` : undefined
}

/**
 * Archivo que trae el mensaje y su tipo MIME. Telegram declara `mime_type` en
 * documento, voz, audio y video, pero es opcional: si falta se usa el formato
 * que Bot API documenta para cada clase (voz OGG/Opus, audio MP3, video y
 * video redondo MPEG-4, foto JPEG). Un documento sin tipo queda genérico.
 */
function mediaOf(msg: TelegramMessage): { fileId: string; mimeType: string } | null {
  const photo = msg.photo?.at(-1)
  if (photo) return { fileId: photo.file_id, mimeType: "image/jpeg" }
  const candidates: [TelegramFile | undefined, string][] = [
    [msg.document, "application/octet-stream"],
    [msg.voice, "audio/ogg"],
    [msg.audio, "audio/mpeg"],
    [msg.video, "video/mp4"],
    [msg.video_note, "video/mp4"],
  ]
  for (const [file, fallback] of candidates) {
    if (file && typeof file.file_id === "string" && file.file_id) {
      return { fileId: file.file_id, mimeType: file.mime_type || fallback }
    }
  }
  return null
}

function toNormalized(updateId: number, msg: TelegramMessage): NormalizedInbound | null {
  const threadId = msg.chat.id
  const sender = msg.from
  const base = {
    externalEventId: `tg:${updateId}`,
    externalMessageId: `tg:${threadId}:${msg.message_id}`,
    externalThreadId: `tg:${threadId}`,
    senderExternalId: sender ? `tg:${sender.id}` : `tg:${threadId}`,
    sentAt: new Date(msg.date * 1000).toISOString(),
  }
  const name = displayNameOf(sender)
  const withName = {
    ...(name ? { senderDisplayName: name } : {}),
    ...(msg.reply_to_message
      ? { replyToExternalId: `tg:${threadId}:${msg.reply_to_message.message_id}` }
      : {}),
    ...(msg.forward_origin || msg.forward_date ? { forwarded: true } : {}),
  }
  // Un lugar (con nombre y dirección) o una ubicación suelta.
  const place = msg.venue?.location ?? msg.location
  if (place && typeof place.latitude === "number" && typeof place.longitude === "number") {
    return {
      ...base,
      ...withName,
      content: {
        type: "location",
        latitude: place.latitude,
        longitude: place.longitude,
        ...(msg.venue?.title ? { name: msg.venue.title } : {}),
        ...(msg.venue?.address ? { address: msg.venue.address } : {}),
      },
    }
  }
  if (typeof msg.text === "string" && msg.text) {
    return { ...base, ...withName, content: { type: "text", text: msg.text } }
  }
  const media = mediaOf(msg)
  if (media) {
    const caption = msg.caption ? { caption: msg.caption } : {}
    return {
      ...base,
      ...withName,
      content: {
        type: "media",
        mediaExternalId: media.fileId,
        mimeType: media.mimeType,
        ...caption,
      },
    }
  }
  // Sin texto ni media soportada (sticker, encuesta, contacto…):
  // no entra a la bandeja ni despierta al agente.
  return null
}

/**
 * Tipo de lo descargado. El servidor de archivos de Telegram suele responder
 * `application/octet-stream` (las notas de voz llegan como `.oga`); en ese caso
 * se toma de la extensión que Telegram pone en `file_path`, para que quien
 * guarda o transcribe sepa qué es.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
}

function mimeOfDownload(contentType: string | null, filePath: string): string {
  const declared = contentType?.split(";")[0]?.trim().toLowerCase()
  if (declared && declared !== "application/octet-stream") return declared
  const ext = filePath.split(".").at(-1)?.toLowerCase() ?? ""
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream"
}

function isOkResult(json: unknown): json is { ok: true; result: unknown } {
  return !!json && typeof json === "object" && "ok" in json && json.ok === true && "result" in json
}

function failureReason(json: unknown, httpStatus: number): string {
  if (
    json &&
    typeof json === "object" &&
    "description" in json &&
    typeof json.description === "string"
  ) {
    return json.description
  }
  return `HTTP ${httpStatus}`
}

async function telegramCall(
  cfg: TelegramBotConfig,
  method: string,
  payload: Record<string, unknown>,
  deps: ChannelAdapterDeps,
): Promise<unknown> {
  const res = await deps.fetch(`https://api.telegram.org/bot${cfg.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok || !isOkResult(json)) {
    const detail = `Telegram ${method} falló: ${failureReason(json, res.status)}`
    // Telegram contestó con su error: no lo aceptó, y con 429 pide esperar. Un
    // 5xx o una respuesta que no es suya no dicen si salió.
    const answered = !!json && typeof json === "object" && "ok" in json && json.ok === false
    if (answered && res.status >= 400 && res.status < 500) {
      if (res.status === 429) throw new ProviderThrottledError(detail)
      throw new ProviderRejectedError(detail)
    }
    throw new Error(detail)
  }
  return json.result
}

function resultMessageId(result: unknown): number {
  if (
    result &&
    typeof result === "object" &&
    "message_id" in result &&
    typeof result.message_id === "number"
  ) {
    return result.message_id
  }
  throw new Error("Telegram sendMessage sin message_id")
}

function getMeInfo(json: unknown): { id: number; username?: string; first_name?: string } {
  if (!json || typeof json !== "object" || !("result" in json)) {
    throw new Error("Telegram getMe falló: token inválido")
  }
  const result = json.result
  if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "number") {
    throw new Error("Telegram getMe falló: token inválido")
  }
  const username =
    "username" in result && typeof result.username === "string" ? result.username : undefined
  const firstName =
    "first_name" in result && typeof result.first_name === "string" ? result.first_name : undefined
  return {
    id: result.id,
    ...(username ? { username } : {}),
    ...(firstName ? { first_name: firstName } : {}),
  }
}

export const telegramBotApiAdapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: {
    templates: false,
    media: true,
    interactive: false,
    readReceipts: false,
    edit: true,
  },

  verifyWebhook({ headers, webhookSecret }) {
    if (!webhookSecret) return false
    return header(headers, "x-telegram-bot-api-secret-token") === webhookSecret
  },

  parseWebhook({ rawBody }): WebhookParseResult {
    const empty: WebhookParseResult = { messages: [], statuses: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody) as unknown
    } catch {
      return empty
    }
    if (!isTelegramUpdate(parsed) || typeof parsed.update_id !== "number") return empty
    const msg = parsed.message ?? parsed.edited_message
    if (!msg || typeof msg.message_id !== "number" || !msg.chat) return empty
    const normalized = toNormalized(parsed.update_id, msg)
    if (!normalized) return empty
    return { messages: [normalized], statuses: [] }
  },

  async sendMessage(config, msg: OutboundMessage, deps) {
    const cfg = getConfig(config)
    if (msg.kind.type === "template") {
      throw new ProviderRejectedError("Telegram no soporta plantillas")
    }
    // `to` es el externalThreadId del parse (`tg:<chatId>`).
    const chatId = msg.to.startsWith("tg:") ? msg.to.slice("tg:".length) : msg.to
    // Respuesta citada (ADR 0050): el id propio es `tg:<chat>:<message_id>`.
    const quoted = msg.replyToExternalId?.startsWith(`tg:${chatId}:`) ? Number(msg.replyToExternalId.split(":")[2]) : NaN
    const reply = Number.isInteger(quoted) ? { reply_parameters: { message_id: quoted, allow_sending_without_reply: true } } : {}
    if (msg.kind.type === "text") {
      const result = await telegramCall(
        cfg,
        "sendMessage",
        { chat_id: chatId, text: msg.kind.text, ...reply },
        deps,
      )
      return { externalId: `tg:${chatId}:${resultMessageId(result)}` }
    }
    const { media } = msg.kind
    const [method, field] = media.mimeType.startsWith("image/")
      ? ["sendPhoto", "photo"]
      : media.mimeType.startsWith("audio/")
        ? ["sendAudio", "audio"]
        : ["sendDocument", "document"]
    const result = await telegramCall(
      cfg,
      method,
      { chat_id: chatId, [field]: media.url, ...(media.caption ? { caption: media.caption } : {}) },
      deps,
    )
    return { externalId: `tg:${chatId}:${resultMessageId(result)}` }
  },

  async fetchMedia(config, mediaExternalId, deps) {
    const cfg = getConfig(config)
    const result = await telegramCall(cfg, "getFile", { file_id: mediaExternalId }, deps)
    const filePath =
      result &&
      typeof result === "object" &&
      "file_path" in result &&
      typeof result.file_path === "string"
        ? result.file_path
        : null
    if (!filePath) throw new Error("Telegram getFile sin file_path")
    const url = `https://api.telegram.org/file/bot${cfg.botToken}/${filePath}`
    const res = await deps.fetch(url)
    if (!res.ok) throw new Error(`Telegram descarga de media falló: ${res.status}`)
    const mimeType = mimeOfDownload(res.headers.get("content-type"), filePath)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const filename = filePath.split("/").at(-1) ?? mediaExternalId
    return { bytes, mimeType, filename }
  },

  async validateConnection(config, deps) {
    const cfg = getConfig(config)
    const res = await deps.fetch(`https://api.telegram.org/bot${cfg.botToken}/getMe`)
    const json: unknown = await res.json().catch(() => null)
    if (res.status >= 500) throw new Error(`Telegram no respondió al comprobar el bot: ${res.status}`)
    const refused = json !== null && typeof json === "object" && "ok" in json && json.ok === false
    if (!res.ok || refused) throw new ConnectionRejectedError("Telegram getMe falló: token inválido", "token")
    const info = getMeInfo(json)
    return {
      externalId: String(info.id),
      displayName: info.username ? `@${info.username}` : (info.first_name ?? String(info.id)),
      account: { name: info.first_name ?? null, number: info.username ? `@${info.username}` : null },
    }
  },
}

/**
 * Registra ante Telegram la dirección a la que avisa cada mensaje del bot. Sin
 * este registro una conexión real no recibe nada: se llama al conectar, al
 * cambiar la clave y al reactivar.
 */
export async function setTelegramWebhook(
  config: Record<string, unknown>,
  url: string,
  secret: string,
  deps: ChannelAdapterDeps,
): Promise<void> {
  const cfg = getConfig(config)
  await telegramCall(
    cfg,
    "setWebhook",
    { url, secret_token: secret, allowed_updates: ["message", "edited_message"] },
    deps,
  )
}
