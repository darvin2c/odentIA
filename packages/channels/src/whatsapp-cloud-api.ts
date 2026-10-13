import { createHmac, timingSafeEqual } from "node:crypto"
import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  NormalizedInbound,
  NormalizedStatus,
  NormalizedTemplateStatus,
  OutboundMessage,
  ProviderTemplate,
  TemplateCategory,
  TemplateStatus,
  WebhookParseResult,
} from "./protocol.js"

export interface WhatsAppTemplateRef {
  name: string
  language: string
}

export interface WhatsAppCloudConfig {
  phoneNumberId: string
  wabaId: string
  accessToken: string
  appSecret: string
  /**
   * Solo para entornos sin proveedor (pruebas y desarrollo): las plantillas se
   * leen de la cuenta con `listTemplates`, no se escriben a mano.
   */
  templates: WhatsAppTemplateRef[]
}

const GRAPH_VERSION = "v21.0"

function getConfig(config: Record<string, unknown>): WhatsAppCloudConfig {
  const pick = (k: string): string => {
    const v = config[k]
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`WhatsApp: falta ${k} en la configuración de la conexión`)
    }
    return v
  }
  const rawTemplates = config["templates"]
  const templates: WhatsAppTemplateRef[] = []
  if (Array.isArray(rawTemplates)) {
    for (const t of rawTemplates) {
      if (
        t &&
        typeof t === "object" &&
        "name" in t &&
        typeof t.name === "string" &&
        "language" in t &&
        typeof t.language === "string"
      ) {
        templates.push({ name: t.name, language: t.language })
      }
    }
  }
  return {
    phoneNumberId: pick("phoneNumberId"),
    wabaId: pick("wabaId"),
    accessToken: pick("accessToken"),
    appSecret: pick("appSecret"),
    templates,
  }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v
  }
  return undefined
}

interface WaMedia {
  id: string
  mime_type?: string
  caption?: string
}

interface WaMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body?: string }
  image?: WaMedia
  document?: WaMedia
  audio?: WaMedia
  /** Respuesta rápida de una plantilla. */
  button?: { payload?: string; text?: string }
  /** Botón de un mensaje interactivo enviado dentro de la ventana. */
  interactive?: { type?: string; button_reply?: { id?: string; title?: string } }
}

interface WaStatus {
  id: string
  status: string
  timestamp: string
}

interface WaValue {
  messaging_product?: string
  contacts?: { profile?: { name?: string }; wa_id?: string }[]
  messages?: WaMessage[]
  statuses?: WaStatus[]
}

function displayNameOf(value: WaValue, from: string): string | undefined {
  return value.contacts?.find((c) => c.wa_id === from)?.profile?.name
}

function messageToNormalized(
  m: WaMessage,
  displayName: string | undefined,
): NormalizedInbound | null {
  const base = {
    externalEventId: m.id,
    externalMessageId: m.id,
    externalThreadId: `wa:${m.from}`,
    senderExternalId: `wa:${m.from}`,
    sentAt: new Date(Number(m.timestamp) * 1000).toISOString(),
  }
  const withName = displayName ? { senderDisplayName: displayName } : {}
  if (m.type === "text" && typeof m.text?.body === "string") {
    return { ...base, ...withName, content: { type: "text", text: m.text.body } }
  }
  // Un botón llega como texto (lo que la persona ve que respondió) con el
  // identificador que se le puso al enviarlo.
  if (m.type === "button" && typeof m.button?.text === "string") {
    const replyId = typeof m.button.payload === "string" ? { replyId: m.button.payload } : {}
    return { ...base, ...withName, content: { type: "text", text: m.button.text, ...replyId } }
  }
  const reply = m.type === "interactive" ? m.interactive?.button_reply : undefined
  if (reply && typeof reply.title === "string") {
    const replyId = typeof reply.id === "string" ? { replyId: reply.id } : {}
    return { ...base, ...withName, content: { type: "text", text: reply.title, ...replyId } }
  }
  const media: WaMedia | undefined =
    m.type === "image"
      ? m.image
      : m.type === "document"
        ? m.document
        : m.type === "audio"
          ? m.audio
          : undefined
  if (media) {
    const withCaption = typeof media.caption === "string" ? { caption: media.caption } : {}
    return {
      ...base,
      ...withName,
      content: {
        type: "media",
        mediaExternalId: media.id,
        mimeType: media.mime_type ?? "application/octet-stream",
        ...withCaption,
      },
    }
  }
  // Tipos no soportados (reaction, sticker, location…): se ignoran.
  return null
}

function statusToNormalized(s: WaStatus): NormalizedStatus | null {
  const map: Record<string, NormalizedStatus["status"]> = {
    delivered: "delivered",
    read: "read",
    failed: "failed",
  }
  const status = map[s.status]
  // 'sent' y otros no tienen equivalente local.
  if (!status) return null
  return { externalMessageId: s.id, status }
}

async function graphFetch(
  cfg: WhatsAppCloudConfig,
  path: string,
  init: { method?: string; body?: unknown },
  deps: ChannelAdapterDeps,
): Promise<{ status: number; json: unknown }> {
  const res = await deps.fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  const json: unknown = await res.json().catch(() => null)
  return { status: res.status, json }
}

function graphError(status: number, json: unknown): string {
  if (
    json &&
    typeof json === "object" &&
    "error" in json &&
    json.error &&
    typeof json.error === "object"
  ) {
    const err = json.error
    const message = "message" in err && typeof err.message === "string" ? err.message : null
    if (message) return message
  }
  return `HTTP ${status}`
}

function sentMessageId(json: unknown): string | null {
  if (!json || typeof json !== "object" || !("messages" in json) || !Array.isArray(json.messages))
    return null
  const first = json.messages[0]
  if (!first || typeof first !== "object" || !("id" in first)) return null
  return typeof first.id === "string" ? first.id : null
}

function mediaInfo(json: unknown): { url: string; mimeType: string } | null {
  if (!json || typeof json !== "object" || !("url" in json) || typeof json.url !== "string")
    return null
  const mimeType =
    "mime_type" in json && typeof json.mime_type === "string"
      ? json.mime_type
      : "application/octet-stream"
  return { url: json.url, mimeType }
}

/** WhatsApp admite hasta tres botones de respuesta de 20 caracteres. */
const MAX_REPLY_BUTTONS = 3
const MAX_REPLY_TITLE = 20

export function buildBody(to: string, kind: OutboundMessage["kind"]): Record<string, unknown> {
  if (kind.type === "text") {
    const buttons = (kind.buttons ?? []).slice(0, MAX_REPLY_BUTTONS)
    if (buttons.length > 0) {
      return {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: kind.text },
          action: {
            buttons: buttons.map((button) => ({
              type: "reply",
              reply: { id: button.id, title: button.title.slice(0, MAX_REPLY_TITLE) },
            })),
          },
        },
      }
    }
    return {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: kind.text, preview_url: false },
    }
  }
  if (kind.type === "template") {
    return {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: kind.name,
        language: { code: kind.language },
        components: [
          // Sin variables no se envía el componente: Meta rechaza uno vacío.
          ...(kind.params.length > 0
            ? [{ type: "body", parameters: kind.params.map((text) => ({ type: "text", text })) }]
            : []),
          ...(kind.buttons ?? []).map((button, index) => ({
            type: "button",
            sub_type: "quick_reply",
            index: String(index),
            parameters: [{ type: "payload", payload: button.id }],
          })),
        ],
      },
    }
  }
  const { media } = kind
  const waType = media.mimeType.startsWith("image/")
    ? "image"
    : media.mimeType.startsWith("audio/")
      ? "audio"
      : "document"
  // WhatsApp no admite caption en audio; filename solo en document.
  return {
    messaging_product: "whatsapp",
    to,
    type: waType,
    [waType]: {
      link: media.url,
      ...(media.caption && waType !== "audio" ? { caption: media.caption } : {}),
      ...(waType === "document" ? { filename: media.filename } : {}),
    },
  }
}

function connectionInfo(json: unknown): { id?: string; displayName?: string } {
  if (!json || typeof json !== "object") return {}
  const id = "id" in json && typeof json.id === "string" ? json.id : undefined
  const verified =
    "verified_name" in json && typeof json.verified_name === "string"
      ? json.verified_name
      : undefined
  const phone =
    "display_phone_number" in json && typeof json.display_phone_number === "string"
      ? json.display_phone_number
      : undefined
  return {
    ...(id ? { id } : {}),
    ...((verified ?? phone) ? { displayName: verified ?? phone } : {}),
  }
}

const META_TEMPLATE_STATUS: Record<string, TemplateStatus> = {
  APPROVED: "aprobada",
  PENDING: "en_revision",
  IN_APPEAL: "en_revision",
  REJECTED: "rechazada",
  PAUSED: "pausada",
  FLAGGED: "pausada",
}

/** Lo que Meta no declara aprobado, en revisión, rechazado o pausado ya no sirve para enviar. */
function templateStatus(value: unknown): TemplateStatus {
  return (typeof value === "string" && META_TEMPLATE_STATUS[value.toUpperCase()]) || "deshabilitada"
}

function templateCategory(value: unknown): TemplateCategory {
  const category = typeof value === "string" ? value.toLowerCase() : ""
  return category === "marketing" || category === "authentication" ? category : "utility"
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Motivo legible: Meta usa `NONE` cuando no hay ninguno. */
function templateReason(value: unknown): string | null {
  const reason = text(value)
  return reason && reason.toUpperCase() !== "NONE" ? reason : null
}

function toProviderTemplate(raw: unknown): ProviderTemplate | null {
  if (!raw || typeof raw !== "object") return null
  const name = "name" in raw ? text(raw.name) : null
  const language = "language" in raw ? text(raw.language) : null
  if (!name || !language) return null
  let body = ""
  const buttons: string[] = []
  const components = "components" in raw && Array.isArray(raw.components) ? raw.components : []
  for (const component of components) {
    if (!component || typeof component !== "object" || !("type" in component)) continue
    const type = typeof component.type === "string" ? component.type.toUpperCase() : ""
    if (type === "BODY" && "text" in component && typeof component.text === "string") body = component.text
    if (type === "BUTTONS" && "buttons" in component && Array.isArray(component.buttons)) {
      for (const button of component.buttons) {
        if (!button || typeof button !== "object") continue
        const kind = "type" in button && typeof button.type === "string" ? button.type.toUpperCase() : ""
        if (kind === "QUICK_REPLY" && "text" in button && typeof button.text === "string") buttons.push(button.text)
      }
    }
  }
  const positions = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]))
  return {
    externalId: "id" in raw ? text(raw.id) : null,
    name,
    language,
    category: templateCategory("category" in raw ? raw.category : null),
    status: templateStatus("status" in raw ? raw.status : null),
    reason: templateReason("rejected_reason" in raw ? raw.rejected_reason : null),
    body,
    variables: positions.length > 0 ? Math.max(...positions) : 0,
    buttons,
  }
}

function toTemplateStatus(value: unknown): NormalizedTemplateStatus | null {
  if (!value || typeof value !== "object") return null
  const name = "message_template_name" in value ? text(value.message_template_name) : null
  const language = "message_template_language" in value ? text(value.message_template_language) : null
  if (!name || !language) return null
  const id = "message_template_id" in value ? value.message_template_id : null
  return {
    externalId: typeof id === "string" || typeof id === "number" ? String(id) : null,
    name,
    language,
    status: templateStatus("event" in value ? value.event : null),
    reason: templateReason("reason" in value ? value.reason : null),
  }
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
}

export const whatsappCloudApiAdapter: ChannelAdapter = {
  provider: "whatsapp_cloud_api",
  capabilities: {
    templates: true,
    media: true,
    interactive: true,
    readReceipts: true,
    edit: false,
  },

  verifyWebhook({ headers, rawBody, config }) {
    const appSecret = config["appSecret"]
    if (typeof appSecret !== "string" || appSecret.length === 0) return false
    const given = header(headers, "x-hub-signature-256")
    if (!given || !given.startsWith("sha256=")) return false
    const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`
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
    if (!body || typeof body !== "object" || !("entry" in body) || !Array.isArray(body.entry))
      return empty
    const messages: NormalizedInbound[] = []
    const statuses: NormalizedStatus[] = []
    const templateStatuses: NormalizedTemplateStatus[] = []
    for (const entry of body.entry) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !("changes" in entry) ||
        !Array.isArray(entry.changes)
      )
        continue
      for (const change of entry.changes) {
        if (!change || typeof change !== "object" || !("value" in change)) continue
        if ("field" in change && change.field === "message_template_status_update") {
          const update = toTemplateStatus(change.value)
          if (update) templateStatuses.push(update)
          continue
        }
        const value = change.value as WaValue
        if (!value || typeof value !== "object") continue
        for (const m of value.messages ?? []) {
          const n = messageToNormalized(m, displayNameOf(value, m.from))
          if (n) messages.push(n)
        }
        for (const s of value.statuses ?? []) {
          const n = statusToNormalized(s)
          if (n) statuses.push(n)
        }
      }
    }
    return { messages, statuses, ...(templateStatuses.length > 0 ? { templateStatuses } : {}) }
  },

  async sendMessage(config, msg: OutboundMessage, deps) {
    const cfg = getConfig(config)
    // `to` es el externalThreadId del parse (`wa:<phone>`).
    const to = msg.to.startsWith("wa:") ? msg.to.slice("wa:".length) : msg.to
    const body = buildBody(to, msg.kind)
    const { status, json } = await graphFetch(
      cfg,
      `${cfg.phoneNumberId}/messages`,
      { method: "POST", body },
      deps,
    )
    const id = sentMessageId(json)
    if (status >= 400 || !id) {
      throw new Error(`WhatsApp send falló: ${status} ${graphError(status, json)}`)
    }
    return { externalId: id }
  },

  async fetchMedia(config, mediaExternalId, deps) {
    const cfg = getConfig(config)
    const { status, json } = await graphFetch(cfg, mediaExternalId, {}, deps)
    const info = mediaInfo(json)
    if (status >= 400 || !info) {
      throw new Error(`WhatsApp media lookup falló: ${status}`)
    }
    const dl = await deps.fetch(info.url, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
    })
    if (!dl.ok) throw new Error(`WhatsApp descarga de media falló: ${dl.status}`)
    const bytes = new Uint8Array(await dl.arrayBuffer())
    const ext = EXT_BY_MIME[info.mimeType] ?? "bin"
    return { bytes, mimeType: info.mimeType, filename: `${mediaExternalId}.${ext}` }
  },

  async listTemplates(config, deps) {
    const cfg = getConfig(config)
    const found: ProviderTemplate[] = []
    let path: string | null =
      `${cfg.wabaId}/message_templates?fields=id,name,language,status,category,components,rejected_reason&limit=100`
    // Tope de páginas: una cuenta no tiene miles de plantillas y el cursor no debe colgar la lectura.
    for (let page = 0; path && page < 10; page++) {
      const { status, json }: { status: number; json: unknown } = await graphFetch(cfg, path, {}, deps)
      if (status >= 400) throw new Error(`WhatsApp plantillas falló: ${graphError(status, json)}`)
      const data = json && typeof json === "object" && "data" in json && Array.isArray(json.data) ? json.data : []
      for (const raw of data) {
        const template = toProviderTemplate(raw)
        if (template) found.push(template)
      }
      const paging = json && typeof json === "object" && "paging" in json ? json.paging : null
      const cursors = paging && typeof paging === "object" && "cursors" in paging ? paging.cursors : null
      const after = cursors && typeof cursors === "object" && "after" in cursors ? text(cursors.after) : null
      const more = paging && typeof paging === "object" && "next" in paging && typeof paging.next === "string"
      path =
        more && after
          ? `${cfg.wabaId}/message_templates?fields=id,name,language,status,category,components,rejected_reason&limit=100&after=${encodeURIComponent(after)}`
          : null
    }
    return found
  },

  async requestTemplate(config, request, deps) {
    const cfg = getConfig(config)
    const { status, json } = await graphFetch(
      cfg,
      `${cfg.wabaId}/message_templates`,
      {
        method: "POST",
        body: {
          name: request.name,
          language: request.language,
          category: request.category.toUpperCase(),
          components: [
            {
              type: "BODY",
              text: request.body,
              // Meta exige un valor de ejemplo por cada variable del cuerpo.
              ...(request.examples.length > 0 ? { example: { body_text: [request.examples] } } : {}),
            },
            ...(request.buttons.length > 0
              ? [{ type: "BUTTONS", buttons: request.buttons.map((title) => ({ type: "QUICK_REPLY", text: title })) }]
              : []),
          ],
        },
      },
      deps,
    )
    if (status >= 400 || !json || typeof json !== "object") {
      throw new Error(`WhatsApp no aceptó la solicitud de plantilla: ${graphError(status, json)}`)
    }
    return {
      externalId: "id" in json ? text(json.id) : null,
      status: templateStatus("status" in json ? json.status : "PENDING"),
      category: templateCategory("category" in json ? json.category : request.category),
    }
  },

  async validateConnection(config, deps) {
    const cfg = getConfig(config)
    const { status, json } = await graphFetch(
      cfg,
      `${cfg.phoneNumberId}?fields=display_phone_number,verified_name`,
      {},
      deps,
    )
    if (status >= 400) {
      throw new Error("WhatsApp validate falló: token o phone_number_id inválido")
    }
    const info = connectionInfo(json)
    return {
      externalId: info.id ?? cfg.phoneNumberId,
      displayName: info.displayName ?? cfg.phoneNumberId,
    }
  },
}
