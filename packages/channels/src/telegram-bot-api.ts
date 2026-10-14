import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  NormalizedInbound,
  OutboundMessage,
  WebhookParseResult,
} from "./protocol.js"

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
  document?: { file_id: string; mime_type?: string }
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

function toNormalized(updateId: number, msg: TelegramMessage): NormalizedInbound {
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
  const withName = name ? { senderDisplayName: name } : {}
  if (typeof msg.text === "string") {
    return { ...base, ...withName, content: { type: "text", text: msg.text } }
  }
  const photo = msg.photo?.at(-1)
  const fileId = photo?.file_id ?? msg.document?.file_id
  if (fileId) {
    const caption = msg.caption ? { caption: msg.caption } : {}
    return {
      ...base,
      ...withName,
      content: {
        type: "media",
        mediaExternalId: fileId,
        mimeType: msg.document?.mime_type ?? "image/jpeg",
        ...caption,
      },
    }
  }
  // Mensaje sin texto ni media soportada (sticker, poll, etc.): se ignora.
  return { ...base, ...withName, content: { type: "text", text: "" } }
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
    throw new Error(`Telegram ${method} falló: ${failureReason(json, res.status)}`)
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
    if (normalized.content.type === "text" && normalized.content.text === "") return empty
    return { messages: [normalized], statuses: [] }
  },

  async sendMessage(config, msg: OutboundMessage, deps) {
    const cfg = getConfig(config)
    if (msg.kind.type === "template") {
      throw new Error("Telegram no soporta plantillas")
    }
    // `to` es el externalThreadId del parse (`tg:<chatId>`).
    const chatId = msg.to.startsWith("tg:") ? msg.to.slice("tg:".length) : msg.to
    if (msg.kind.type === "text") {
      const result = await telegramCall(
        cfg,
        "sendMessage",
        { chat_id: chatId, text: msg.kind.text },
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
    const mimeType = res.headers.get("content-type") ?? "application/octet-stream"
    const bytes = new Uint8Array(await res.arrayBuffer())
    const filename = filePath.split("/").at(-1) ?? mediaExternalId
    return { bytes, mimeType, filename }
  },

  async validateConnection(config, deps) {
    const cfg = getConfig(config)
    const res = await deps.fetch(`https://api.telegram.org/bot${cfg.botToken}/getMe`)
    const json: unknown = await res.json().catch(() => null)
    if (!res.ok) throw new Error("Telegram getMe falló: token inválido")
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
