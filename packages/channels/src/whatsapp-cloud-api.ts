import { createHmac, timingSafeEqual } from "node:crypto"
import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  NormalizedInbound,
  NormalizedStatus,
  NormalizedTemplateCategory,
  NormalizedTemplateStatus,
  OutboundMessage,
  ProviderAccount,
  ProviderHealth,
  ProviderTemplate,
  TemplateCategory,
  TemplateStatus,
  TemplateUnsupported,
  WebhookParseResult,
} from "./protocol.js"
import { metaGraphVersion } from "./meta-graph.js"

export interface WhatsAppTemplateRef {
  name: string
  language: string
}

export interface WhatsAppCloudConfig {
  phoneNumberId: string
  wabaId: string
  accessToken: string
  /**
   * Clave secreta de la app de Meta de la clínica: firma los avisos que llegan a
   * la dirección de la conexión. Una conexión hecha con «Conectar con Facebook»
   * no la tiene: sus avisos llegan a la dirección de la app de odentIA, firmados
   * con la clave de esa app.
   */
  appSecret?: string
  /**
   * Solo para entornos sin proveedor (pruebas y desarrollo): las plantillas se
   * leen de la cuenta con `listTemplates`, no se escriben a mano.
   */
  templates: WhatsAppTemplateRef[]
}


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
  const appSecret = config["appSecret"]
  return {
    phoneNumberId: pick("phoneNumberId"),
    wabaId: pick("wabaId"),
    accessToken: pick("accessToken"),
    // Solo hace falta para verificar avisos (`verifyWebhook`); enviar y leer la cuenta no la usan.
    ...(typeof appSecret === "string" && appSecret.length > 0 ? { appSecret } : {}),
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

/** Error de un envío, en la respuesta o en el aviso de estado `failed`. */
interface WaError {
  code?: number
  title?: string
  message?: string
  error_data?: { details?: string }
}

interface WaStatus {
  id: string
  status: string
  timestamp: string
  errors?: WaError[]
}

interface WaValue {
  messaging_product?: string
  /** Número de la empresa al que pertenece el aviso. */
  metadata?: { display_phone_number?: string; phone_number_id?: string }
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
  const error = status === "failed" ? sendFailureText(s.errors?.[0]) : null
  const notOnWhatsApp = status === "failed" && s.errors?.[0]?.code === NOT_ON_WHATSAPP_CODE
  return { externalMessageId: s.id, status, ...(error ? { error } : {}), ...(notOnWhatsApp ? { notOnWhatsApp } : {}) }
}

/**
 * Envíos que Meta rechaza por algo que la clínica resuelve en su cuenta, dichos
 * en palabras: el motivo de Meta llega en inglés y no dice qué hacer. Un código
 * que no está aquí se entrega tal como lo dice Meta, con su número.
 * El error llega en la respuesta del envío o después, en el aviso de estado.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 */
/**
 * «Message undeliverable»: Meta no pudo entregarlo, sobre todo porque el número
 * no tiene WhatsApp. La ficha dice «Este número no tiene WhatsApp» (decisión 23).
 */
const NOT_ON_WHATSAPP_CODE = 131026

const WHATSAPP_SEND_ERROR_WORDS: Record<number, string> = {
  [NOT_ON_WHATSAPP_CODE]: "WhatsApp no pudo entregarlo: lo más probable es que este número no tenga WhatsApp.",
  // «Business eligibility payment issue»: la cuenta de WhatsApp Business no
  // tiene una forma de pago válida (o su línea de crédito no está activa).
  131042:
    "WhatsApp no envió el mensaje porque la cuenta de WhatsApp de la clínica no tiene una forma de pago. Agrégala en Meta (Configuración de pagos de WhatsApp Business) y vuelve a intentarlo.",
}

/** Por qué no salió un envío: en palabras si es un caso conocido; si no, `código: motivo de Meta`. */
function sendFailureText(error: WaError | undefined): string | null {
  if (!error) return null
  const code = typeof error.code === "number" ? error.code : null
  if (code !== null && WHATSAPP_SEND_ERROR_WORDS[code]) return WHATSAPP_SEND_ERROR_WORDS[code]
  const said = text(error.error_data?.details) ?? text(error.title) ?? text(error.message)
  if (!said) return code !== null ? String(code) : null
  return code !== null ? `${code}: ${said}` : said
}

/** El `error` de una respuesta del Graph API, si lo trae. */
function graphErrorOf(json: unknown): WaError | undefined {
  if (!json || typeof json !== "object" || !("error" in json)) return undefined
  return json.error && typeof json.error === "object" ? (json.error as WaError) : undefined
}

async function graphFetch(
  cfg: WhatsAppCloudConfig,
  path: string,
  init: { method?: string; body?: unknown },
  deps: ChannelAdapterDeps,
): Promise<{ status: number; json: unknown }> {
  const res = await deps.fetch(`https://graph.facebook.com/${metaGraphVersion()}/${path}`, {
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
          // El botón que abre un enlace va primero: su dato es lo que completa la dirección.
          ...(kind.link
            ? [{ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: kind.link }] }]
            : []),
          ...(kind.buttons ?? []).map((button, index) => ({
            type: "button",
            sub_type: "quick_reply",
            index: String(index + (kind.link ? 1 : 0)),
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

function connectionInfo(json: unknown): { id?: string; displayName?: string; account: ProviderAccount } {
  if (!json || typeof json !== "object") return { account: { name: null, number: null } }
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
    account: { name: verified ?? null, number: phone ?? null },
  }
}

/** Calidad del número en palabras; lo que Meta no califica (`NA`, `UNKNOWN`) queda sin dato. */
const META_QUALITY: Record<string, ProviderHealth["quality"]> = {
  GREEN: "alta",
  YELLOW: "media",
  RED: "baja",
}

/**
 * Tope diario de conversaciones que inicia la empresa: `TIER_250`, `TIER_2K`,
 * `TIER_10K`, `TIER_100K` o `TIER_UNLIMITED`. Un valor que no tenga esa forma
 * (`TIER_NOT_SET`, uno nuevo) queda sin dato: no se supone un número.
 */
function messagingLimit(value: unknown): Pick<ProviderHealth, "dailyLimit" | "unlimited"> {
  const tier = typeof value === "string" ? value.toUpperCase() : ""
  if (tier === "TIER_UNLIMITED") return { dailyLimit: null, unlimited: true }
  const match = /^TIER_(\d+)(K?)$/.exec(tier)
  if (!match) return { dailyLimit: null, unlimited: false }
  return { dailyLimit: Number(match[1]) * (match[2] ? 1000 : 1), unlimited: false }
}

const META_TEMPLATE_STATUS: Record<string, TemplateStatus> = {
  APPROVED: "aprobada",
  // Dejó de estar marcada o deshabilitada: vuelve a servir para enviar.
  REINSTATED: "aprobada",
  PENDING: "en_revision",
  IN_APPEAL: "en_revision",
  REJECTED: "rechazada",
  PAUSED: "pausada",
  FLAGGED: "pausada",
}

/**
 * Avisos que no dicen en qué estado quedó la plantilla (`LOCKED`: no se puede
 * editar; `UNARCHIVED`: volvió al estado que tenía). No cambian el catálogo; lo
 * que corresponda llega con la siguiente lectura de la cuenta.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update
 */
const META_TEMPLATE_EVENTS_WITHOUT_STATUS = new Set(["LOCKED", "UNARCHIVED"])

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
  let link: { title: string; url: string } | null = null
  // odentIA envía el cuerpo por posición, sin encabezado: un encabezado con
  // datos o con un archivo pide un parámetro que no se manda.
  let header = false
  const components = "components" in raw && Array.isArray(raw.components) ? raw.components : []
  for (const component of components) {
    if (!component || typeof component !== "object" || !("type" in component)) continue
    const type = typeof component.type === "string" ? component.type.toUpperCase() : ""
    if (type === "BODY" && "text" in component && typeof component.text === "string") body = component.text
    if (type === "HEADER") {
      const format = "format" in component && typeof component.format === "string" ? component.format.toUpperCase() : "TEXT"
      const headerText = "text" in component && typeof component.text === "string" ? component.text : ""
      if (format !== "TEXT" || /\{\{[^{}]+\}\}/.test(headerText)) header = true
    }
    if (type === "BUTTONS" && "buttons" in component && Array.isArray(component.buttons)) {
      for (const button of component.buttons) {
        if (!button || typeof button !== "object") continue
        const kind = "type" in button && typeof button.type === "string" ? button.type.toUpperCase() : ""
        if (kind === "QUICK_REPLY" && "text" in button && typeof button.text === "string") buttons.push(button.text)
        if (
          kind === "URL" &&
          !link &&
          "text" in button &&
          typeof button.text === "string" &&
          "url" in button &&
          typeof button.url === "string"
        )
          link = { title: button.text, url: button.url }
      }
    }
  }
  const positions = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]))
  // Datos por nombre (`{{nombre}}`, `parameter_format: NAMED`): odentIA los manda por posición.
  const named =
    ("parameter_format" in raw && typeof raw.parameter_format === "string" && raw.parameter_format.toUpperCase() === "NAMED") ||
    /\{\{\s*[^{}\d\s][^{}]*\}\}/.test(body)
  const unsupported: TemplateUnsupported | null = header ? "encabezado" : named ? "datos_por_nombre" : null
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
    link,
    unsupported,
  }
}

/**
 * Aviso de cambio de categoría (`template_category_update`). La categoría
 * nueva llega en `new_category`; el aviso previo a un cambio programado la trae
 * en `correct_category`.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/template_category_update
 */
function toTemplateCategory(value: unknown): NormalizedTemplateCategory | null {
  if (!value || typeof value !== "object") return null
  const name = "message_template_name" in value ? text(value.message_template_name) : null
  const language = "message_template_language" in value ? text(value.message_template_language) : null
  const next =
    "new_category" in value && typeof value.new_category === "string"
      ? value.new_category
      : "correct_category" in value && typeof value.correct_category === "string"
        ? value.correct_category
        : null
  if (!name || !language || !next) return null
  const id = "message_template_id" in value ? value.message_template_id : null
  const previous = "previous_category" in value && typeof value.previous_category === "string" ? value.previous_category : null
  return {
    externalId: typeof id === "string" || typeof id === "number" ? String(id) : null,
    name,
    language,
    category: templateCategory(next),
    previous: previous ? templateCategory(previous) : null,
  }
}

function toTemplateStatus(value: unknown): NormalizedTemplateStatus | null {
  if (!value || typeof value !== "object") return null
  const name = "message_template_name" in value ? text(value.message_template_name) : null
  const language = "message_template_language" in value ? text(value.message_template_language) : null
  if (!name || !language) return null
  const id = "message_template_id" in value ? value.message_template_id : null
  const event = "event" in value && typeof value.event === "string" ? value.event.toUpperCase() : ""
  if (META_TEMPLATE_EVENTS_WITHOUT_STATUS.has(event)) return null
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

/** Un cambio de un aviso de WhatsApp, ya normalizado, con a quién pertenece. */
interface WaChange {
  /** Cuenta de WhatsApp Business (`entry[].id`). */
  accountId: string | null
  /** Número de la empresa (`value.metadata.phone_number_id`); los cambios de plantilla no lo traen. */
  phoneNumberId: string | null
  messages: NormalizedInbound[]
  statuses: NormalizedStatus[]
  templateStatus: NormalizedTemplateStatus | null
  templateCategory: NormalizedTemplateCategory | null
}

/** Recorre `entry[].changes[]` de un aviso y normaliza cada cambio por separado. */
function readChanges(rawBody: string): WaChange[] {
  let body: unknown
  try {
    body = JSON.parse(rawBody) as unknown
  } catch {
    return []
  }
  if (!body || typeof body !== "object" || !("entry" in body) || !Array.isArray(body.entry)) return []
  const found: WaChange[] = []
  for (const entry of body.entry) {
    if (!entry || typeof entry !== "object" || !("changes" in entry) || !Array.isArray(entry.changes))
      continue
    const accountId = "id" in entry ? text(entry.id) : null
    for (const change of entry.changes) {
      if (!change || typeof change !== "object" || !("value" in change)) continue
      if ("field" in change && change.field === "message_template_status_update") {
        const update = toTemplateStatus(change.value)
        if (update) {
          found.push({ accountId, phoneNumberId: null, messages: [], statuses: [], templateStatus: update, templateCategory: null })
        }
        continue
      }
      if ("field" in change && change.field === "template_category_update") {
        const update = toTemplateCategory(change.value)
        if (update) {
          found.push({ accountId, phoneNumberId: null, messages: [], statuses: [], templateStatus: null, templateCategory: update })
        }
        continue
      }
      const value = change.value as WaValue
      if (!value || typeof value !== "object") continue
      const messages: NormalizedInbound[] = []
      const statuses: NormalizedStatus[] = []
      for (const m of value.messages ?? []) {
        const n = messageToNormalized(m, displayNameOf(value, m.from))
        if (n) messages.push(n)
      }
      for (const s of value.statuses ?? []) {
        const n = statusToNormalized(s)
        if (n) statuses.push(n)
      }
      found.push({
        accountId,
        phoneNumberId: text(value.metadata?.phone_number_id),
        messages,
        statuses,
        templateStatus: null,
        templateCategory: null,
      })
    }
  }
  return found
}

/** Lo que un aviso trae para un número: sus mensajes y los estados de lo que envió. */
export interface WhatsAppNumberDelivery {
  kind: "number"
  phoneNumberId: string
  accountId: string | null
  messages: NormalizedInbound[]
  statuses: NormalizedStatus[]
}

/** Lo que un aviso trae para una cuenta: los cambios de estado y de categoría de sus plantillas. */
export interface WhatsAppAccountDelivery {
  kind: "account"
  accountId: string
  templateStatuses: NormalizedTemplateStatus[]
  templateCategories: NormalizedTemplateCategory[]
}

export type WhatsAppDelivery = WhatsAppNumberDelivery | WhatsAppAccountDelivery

/**
 * Reparte un aviso que llega a la dirección de una app (una sola para todas las
 * cuentas suscritas, y puede traer cambios de varias en el mismo envío): los
 * mensajes y estados van al número que los recibió
 * (`value.metadata.phone_number_id`) y los cambios de plantilla, que no traen
 * número, a su cuenta (`entry[].id`). Lo que no dice de quién es se omite.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/message_template_status_update
 */
export function splitWhatsAppWebhook(rawBody: string): WhatsAppDelivery[] {
  const numbers = new Map<string, WhatsAppNumberDelivery>()
  const accounts = new Map<string, WhatsAppAccountDelivery>()
  for (const change of readChanges(rawBody)) {
    if (change.templateStatus || change.templateCategory) {
      if (!change.accountId) continue
      const account = accounts.get(change.accountId) ?? {
        kind: "account",
        accountId: change.accountId,
        templateStatuses: [],
        templateCategories: [],
      }
      if (change.templateStatus) account.templateStatuses.push(change.templateStatus)
      if (change.templateCategory) account.templateCategories.push(change.templateCategory)
      accounts.set(change.accountId, account)
      continue
    }
    if (!change.phoneNumberId || (change.messages.length === 0 && change.statuses.length === 0)) continue
    const number = numbers.get(change.phoneNumberId) ?? {
      kind: "number",
      phoneNumberId: change.phoneNumberId,
      accountId: change.accountId,
      messages: [],
      statuses: [],
    }
    number.messages.push(...change.messages)
    number.statuses.push(...change.statuses)
    numbers.set(change.phoneNumberId, number)
  }
  return [...numbers.values(), ...accounts.values()]
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
    const messages: NormalizedInbound[] = []
    const statuses: NormalizedStatus[] = []
    const templateStatuses: NormalizedTemplateStatus[] = []
    const templateCategories: NormalizedTemplateCategory[] = []
    for (const change of readChanges(rawBody)) {
      messages.push(...change.messages)
      statuses.push(...change.statuses)
      if (change.templateStatus) templateStatuses.push(change.templateStatus)
      if (change.templateCategory) templateCategories.push(change.templateCategory)
    }
    return {
      messages,
      statuses,
      ...(templateStatuses.length > 0 ? { templateStatuses } : {}),
      ...(templateCategories.length > 0 ? { templateCategories } : {}),
    }
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
      const code = graphErrorOf(json)?.code
      const words = typeof code === "number" ? WHATSAPP_SEND_ERROR_WORDS[code] : undefined
      throw new Error(words ?? `WhatsApp send falló: ${status} ${graphError(status, json)}`)
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
      `${cfg.wabaId}/message_templates?fields=id,name,language,status,category,components,rejected_reason,parameter_format&limit=100`
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
          ? `${cfg.wabaId}/message_templates?fields=id,name,language,status,category,components,rejected_reason,parameter_format&limit=100&after=${encodeURIComponent(after)}`
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
            ...(request.buttons.length > 0 || request.link
              ? [
                  {
                    type: "BUTTONS",
                    buttons: [
                      // Meta pide la dirección con su dato al final y un ejemplo completo.
                      ...(request.link
                        ? [{ type: "URL", text: request.link.title, url: request.link.url, example: [request.link.example] }]
                        : []),
                      ...request.buttons.map((title) => ({ type: "QUICK_REPLY", text: title })),
                    ],
                  },
                ]
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

  /**
   * Meta elimina por nombre todas las plantillas que lo llevan, en cualquier
   * idioma, y no deja eliminar una deshabilitada ni reutilizar durante 30 días
   * el nombre de una aprobada.
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management
   */
  async deleteTemplate(config, template, deps) {
    const cfg = getConfig(config)
    const { status, json } = await graphFetch(
      cfg,
      `${cfg.wabaId}/message_templates?name=${encodeURIComponent(template.name)}`,
      { method: "DELETE" },
      deps,
    )
    if (status >= 400) {
      throw new Error(`WhatsApp no eliminó la plantilla: ${graphError(status, json)}`)
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
      account: info.account,
    }
  },

  /**
   * Calidad del número y tope diario. El tope se lee de
   * `whatsapp_business_manager_messaging_limit`: `messaging_limit_tier` está en
   * desuso. Es del portafolio de la empresa, aunque Meta lo informe por número.
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
   * https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers
   */
  async readHealth(config, deps) {
    const cfg = getConfig(config)
    const { status, json } = await graphFetch(
      cfg,
      `${cfg.phoneNumberId}?fields=quality_rating,whatsapp_business_manager_messaging_limit`,
      {},
      deps,
    )
    if (status >= 400 || !json || typeof json !== "object") {
      throw new Error(`WhatsApp no entregó la salud del número: ${graphError(status, json)}`)
    }
    const rating = "quality_rating" in json && typeof json.quality_rating === "string" ? json.quality_rating : ""
    return {
      quality: META_QUALITY[rating.toUpperCase()] ?? null,
      ...messagingLimit(
        "whatsapp_business_manager_messaging_limit" in json ? json.whatsapp_business_manager_messaging_limit : null,
      ),
    }
  },
}
