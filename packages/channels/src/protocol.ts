// Protocolo puro del framework de canales: sin db, sin S3, sin env.
// Los adaptadores de proveedor (paso 2) implementan ChannelAdapter.

// Proveedores registrados: whatsapp/telegram (núcleo), messenger/instagram
// (Meta, este slice), gmail/microsoft365 (slice Email), web_chat (slice Web).
// Los adaptadores pendientes de esos slices se registran en channelAdapters.
export type ChannelProvider =
  | "whatsapp_cloud_api"
  | "telegram_bot_api"
  | "messenger"
  | "instagram"
  | "gmail"
  | "microsoft365"
  | "web_chat"

export interface ChannelCapabilities {
  templates: boolean
  media: boolean
  interactive: boolean
  readReceipts: boolean
  edit: boolean
}

/** Botón de respuesta: `id` vuelve tal cual cuando la persona lo toca. */
export interface ReplyButton {
  id: string
  title: string
}

export type InboundContent =
  // `replyId` viene cuando el texto es el botón que tocó la persona (o lo que eligió de una lista).
  | { type: "text"; text: string; replyId?: string }
  | { type: "media"; mediaExternalId: string; mimeType: string; caption?: string }
  // Una ubicación que mandó la persona; nombre y dirección si el proveedor los trae.
  | { type: "location"; latitude: number; longitude: number; name?: string; address?: string }
  /**
   * La persona reaccionó a un mensaje (👍, ❤️…). No es un mensaje: se pega al
   * reaccionado (`targetExternalMessageId`) y `emoji` nulo es que la quitó.
   */
  | { type: "reaction"; targetExternalMessageId: string; emoji: string | null }

export interface NormalizedInbound {
  externalEventId: string
  externalMessageId: string
  externalThreadId: string
  senderExternalId: string
  /**
   * El id que el proveedor le da a la persona para esta empresa y que llega
   * aunque oculte su número (WhatsApp: BSUID, `from_user_id`). Si lo oculta,
   * `externalThreadId` y `senderExternalId` lo llevan en lugar del número
   * (`wa:PE.1349…`); con él se le responde igual (ADR 0110).
   */
  senderUserId?: string
  senderDisplayName?: string
  content: InboundContent
  /** ISO-8601 del instante de envío según el proveedor. */
  sentAt: string
  /**
   * Lo escribió una máquina (correo noreply, respuesta automática, boletín):
   * entra a la bandeja, pero el agente no lo atiende (ADR 0031).
   */
  automated?: boolean
  /** La persona respondió citando este mensaje (el id del proveedor). */
  replyToExternalId?: string
  /** Lo reenvió: no lo escribió la persona (WhatsApp `context.forwarded`, Telegram `forward_origin`). */
  forwarded?: boolean
  /**
   * Lo escribió el equipo desde la app WhatsApp Business del celular, con el
   * número conectado en coexistencia (`smb_message_echoes`, o el historial).
   * Sale de la clínica, no de la persona: hilo y remitente son los de la
   * persona a quien se escribió. No despierta al agente.
   */
  fromBusinessApp?: boolean
  /**
   * Llegó con el historial del celular al conectar (`history`): ya pasó. No
   * despierta al agente ni cuenta como sin leer, y conserva su hora (`sentAt`).
   */
  history?: boolean
  /** Hasta dónde llegó un mensaje del equipo del historial, si Meta lo dice. */
  historyStatus?: "sent" | "delivered" | "read"
  /**
   * Prueba del chat web desde Configuración: la conversación nace marcada como
   * prueba (no se cobra, no crea a nadie en Pacientes, se borra a los 7 días).
   */
  test?: boolean
}

/** Remitentes que por convención no leen respuestas. */
const MACHINE_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?)([+._-]|$)/i

/**
 * Correo que escribió una máquina y no una persona: remitente sin buzón de
 * respuesta, respuesta automática (`Auto-Submitted` distinto de `no`, RFC
 * 3834), lista o envío masivo (`List-Id` y `List-Unsubscribe`, RFC 2919 y
 * 2369; `Precedence: bulk | list | junk`). Sin encabezados decide solo el
 * remitente.
 */
export function isAutomatedEmail(input: { from: string; header?: (name: string) => string | null }): boolean {
  const local = input.from.split("@")[0] ?? ""
  if (MACHINE_SENDER.test(local)) return true
  const header = input.header
  if (!header) return false
  const autoSubmitted = header("Auto-Submitted")?.trim().toLowerCase()
  if (autoSubmitted && autoSubmitted !== "no") return true
  if (header("List-Id") || header("List-Unsubscribe")) return true
  return /^(bulk|list|junk)$/i.test(header("Precedence")?.trim() ?? "")
}

export interface NormalizedStatus {
  externalMessageId: string
  status: "delivered" | "read" | "failed"
  /**
   * Por qué falló, si el proveedor lo dice: en palabras cuando el adaptador
   * conoce el caso; si no, `código: lo que dijo el proveedor`.
   */
  error?: string
  /**
   * El proveedor no pudo entregarlo porque el número no tiene WhatsApp
   * (decisión 23, caso 1). Solo lo marca el adaptador que lo sabe.
   */
  notOnWhatsApp?: boolean
}

/** Estado de una plantilla en el proveedor, en palabras del sistema. */
export const TEMPLATE_STATUSES = [
  "en_revision",
  "aprobada",
  "rechazada",
  "pausada",
  "deshabilitada",
] as const
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number]

export const TEMPLATE_CATEGORIES = ["utility", "marketing", "authentication"] as const
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

/** Plantilla tal como la tiene el proveedor. */
export interface ProviderTemplate {
  externalId: string | null
  name: string
  language: string
  category: TemplateCategory
  status: TemplateStatus
  /** Motivo del proveedor cuando la rechaza o la pausa. */
  reason: string | null
  /** Cuerpo con sus variables por posición: `{{1}}`, `{{2}}`… */
  body: string
  variables: number
  /** Títulos de los botones de respuesta rápida, en orden. */
  buttons: string[]
  /**
   * Botón que abre una dirección, con su parte variable al final (`{{1}}`):
   * «Su enlace» de cada persona. Nulo si la plantilla no lo tiene.
   */
  link?: { title: string; url: string } | null
  /**
   * Por qué odentIA no sabe enviarla: lleva un encabezado con datos o con un
   * archivo (`encabezado`), o sus datos van por nombre (`datos_por_nombre`).
   * Nulo o ausente: se puede enviar.
   */
  unsupported?: TemplateUnsupported | null
}

/** Lo que odentIA no sabe enviar de una plantilla que ya estaba en la cuenta. */
export const TEMPLATE_UNSUPPORTED = ["encabezado", "datos_por_nombre"] as const
export type TemplateUnsupported = (typeof TEMPLATE_UNSUPPORTED)[number]

/** Lo que se pide aprobar: texto, un ejemplo por variable y botones. */
export interface TemplateRequest {
  name: string
  language: string
  category: TemplateCategory
  body: string
  examples: string[]
  buttons: string[]
  /**
   * Botón que abre una dirección fija con un dato al final (`…?token={{1}}`),
   * con un ejemplo de la dirección completa. Va antes de los de respuesta.
   */
  link?: { title: string; url: string; example: string }
}

/** Aviso del proveedor: una plantilla cambió de estado. */
export interface NormalizedTemplateStatus {
  externalId: string | null
  name: string
  language: string
  status: TemplateStatus
  reason: string | null
}

/**
 * Aviso del proveedor: cambió la categoría de una plantilla (en WhatsApp,
 * `template_category_update`). Un aviso de servicio que pasa a promoción solo
 * sale a quien aceptó novedades (ADR 0040).
 */
export interface NormalizedTemplateCategory {
  externalId: string | null
  name: string
  language: string
  category: TemplateCategory
  previous: TemplateCategory | null
}

/**
 * Un contacto de la agenda de la app WhatsApp Business del celular
 * (`smb_app_state_sync`). Solo pone nombre a quien ya escribió por ese canal:
 * nunca crea a una persona ni la identifica por su teléfono.
 */
export interface NormalizedAppContact {
  /** Identidad del canal (`wa:<número>`), la misma con la que llegan sus mensajes. */
  externalUserId: string
  name: string | null
  /** Lo quitó de la agenda del celular. */
  removed: boolean
}

/**
 * Por qué el proveedor cortó la conexión de una cuenta:
 * - `access_removed`: la clínica le quitó el acceso a la app de odentIA.
 * - `disconnected_in_app`: se desconectó desde la app WhatsApp Business del celular.
 * - `primary_inactivity`: el celular principal no abrió la app en unos 14 días.
 * - `companion_inactivity`: un dispositivo vinculado no se usó en unos 30 días.
 * - `business_downgrade`: la cuenta del celular dejó de ser de empresa.
 * - `number_changed`: se cambió el número en la app del celular.
 * - `re_registered`: el número se volvió a registrar o pasó a otro celular.
 */
export type AccountRemovalReason =
  | "access_removed"
  | "disconnected_in_app"
  | "primary_inactivity"
  | "companion_inactivity"
  | "business_downgrade"
  | "number_changed"
  | "re_registered"

/**
 * Aviso del proveedor sobre la cuenta entera (en WhatsApp, `account_update`):
 * se cortó su conexión con la app de odentIA o se volvió a hacer.
 */
export interface NormalizedAccountEvent {
  kind: "removed" | "reconnected"
  /** Por qué se cortó; nulo si no se cortó o el proveedor no dice un motivo que se conozca. */
  reason: AccountRemovalReason | null
  /** Lo hizo la clínica o el proveedor; nulo si no lo dice. */
  initiatedBy: "user" | "system" | null
  /** Cuándo lo avisó el proveedor; nulo si no lo dice. */
  at: string | null
}

export interface WebhookParseResult {
  messages: NormalizedInbound[]
  statuses: NormalizedStatus[]
  /** Contactos de la app WhatsApp Business del celular (coexistencia). */
  appContacts?: NormalizedAppContact[]
  /** La clínica no quiso compartir el historial del celular al conectar. */
  historyDeclined?: boolean
  templateStatuses?: NormalizedTemplateStatus[]
  templateCategories?: NormalizedTemplateCategory[]
  /** La conexión de la cuenta con la app de odentIA se cortó o se volvió a hacer. */
  accountEvents?: NormalizedAccountEvent[]
}

export interface OutboundMessage {
  to: string
  /**
   * Correo automático: el enlace de baja que va en la cabecera
   * `List-Unsubscribe` (RFC 2369). Los adaptadores que no pueden poner
   * cabeceras propias lo ignoran; el pie del correo lleva el enlace igual.
   */
  listUnsubscribe?: string
  /**
   * Responde citando este mensaje (el id del proveedor, ADR 0050). Quien no
   * sabe citar lo ignora: el texto sale igual.
   */
  replyToExternalId?: string
  kind:
    | { type: "text"; text: string; buttons?: ReplyButton[] }
    // `buttons`: lo que devuelve cada botón de respuesta rápida, por posición.
    // `link`: la parte variable de la dirección del botón que abre un enlace (va primero).
    | { type: "template"; name: string; language: string; params: string[]; buttons?: ReplyButton[]; link?: string }
    // `url` es una URL firmada que el proveedor descarga al enviar.
    | {
        type: "media"
        media: { url: string; mimeType: string; filename: string; caption?: string }
      }
}

/**
 * El proveedor contestó que no acepta el envío: no salió. A diferencia de una
 * caída de la red o de un error del proveedor, no es un efecto ambiguo y el
 * mensaje queda como no entregado, con este motivo.
 */
export class ProviderRejectedError extends Error {
  override readonly name: string = "ProviderRejectedError"
}

/**
 * El proveedor no aceptó el envío por un límite de ritmo (demasiados mensajes
 * seguidos): no salió, y por eso volver a intentarlo más tarde no lo duplica.
 */
export class ProviderThrottledError extends ProviderRejectedError {
  override readonly name: string = "ProviderThrottledError"
}

/** El dato de una conexión que el proveedor no aceptó: la clave o el identificador de la cuenta. */
export type ConnectionRejectedPart = "token" | "id"

/**
 * El proveedor respondió que no acepta los datos de una conexión (no es que
 * no respondiera). `part` dice cuál, cuando su respuesta lo distingue; nulo si
 * puede ser cualquiera de los dos.
 */
export class ConnectionRejectedError extends Error {
  override readonly name: string = "ConnectionRejectedError"
  constructor(
    message: string,
    readonly part: ConnectionRejectedPart | null = null,
  ) {
    super(message)
  }
}

export interface ChannelAdapterDeps {
  fetch: typeof fetch
  /** Clave de la conexión para firmar lo que se envía a un tercero (el aviso al sitio del chat web). */
  webhookSecret?: string
}

/** La cuenta que el proveedor reconoce con unas credenciales. */
export interface ProviderAccount {
  /** Nombre verificado de la cuenta. */
  name: string | null
  /** Número o dirección tal como la muestra el proveedor. */
  number: string | null
}

/** Calidad de la cuenta y tope diario de conversaciones que inicia la empresa. */
export interface ProviderHealth {
  quality: "alta" | "media" | "baja" | null
  dailyLimit: number | null
  /** El proveedor no pone tope diario. */
  unlimited: boolean
}

export interface ChannelAdapter {
  provider: ChannelProvider
  capabilities: ChannelCapabilities
  verifyWebhook(input: {
    headers: Record<string, string>
    rawBody: string
    config: Record<string, unknown>
    webhookSecret: string
  }): boolean
  parseWebhook(input: {
    headers: Record<string, string>
    rawBody: string
    config: Record<string, unknown>
  }): WebhookParseResult
  sendMessage(
    config: Record<string, unknown>,
    msg: OutboundMessage,
    deps: ChannelAdapterDeps,
  ): Promise<{ externalId: string }>
  fetchMedia?(
    config: Record<string, unknown>,
    mediaExternalId: string,
    deps: ChannelAdapterDeps,
  ): Promise<{ bytes: Uint8Array; mimeType: string; filename: string }>
  /**
   * Comprueba las credenciales contra el proveedor. `account` dice qué cuenta
   * encontró (nombre verificado y número), cuando el proveedor lo entrega.
   */
  validateConnection(
    config: Record<string, unknown>,
    deps: ChannelAdapterDeps,
  ): Promise<{ externalId: string; displayName: string; account?: ProviderAccount }>
  /**
   * Salud de la cuenta según el proveedor (solo quien la publica). Cada dato
   * que el proveedor no entrega queda nulo: no se supone ninguno.
   */
  readHealth?(config: Record<string, unknown>, deps: ChannelAdapterDeps): Promise<ProviderHealth>
  /** Plantillas de la cuenta con su estado (solo canales con plantillas). */
  listTemplates?(config: Record<string, unknown>, deps: ChannelAdapterDeps): Promise<ProviderTemplate[]>
  /**
   * Pide al proveedor la aprobación de una plantilla. El proveedor decide el
   * estado y puede cambiar la categoría: se devuelve lo que respondió.
   */
  requestTemplate?(
    config: Record<string, unknown>,
    request: TemplateRequest,
    deps: ChannelAdapterDeps,
  ): Promise<{ externalId: string | null; status: TemplateStatus; category: TemplateCategory }>
  /**
   * Elimina del proveedor una plantilla por su nombre (en todos sus idiomas).
   * Lanza si el proveedor no la elimina; quien llama comprueba antes que exista.
   */
  deleteTemplate?(
    config: Record<string, unknown>,
    template: { name: string },
    deps: ChannelAdapterDeps,
  ): Promise<void>
  /**
   * Bloquea o desbloquea números para la cuenta (WhatsApp, Block Users API).
   * Devuelve los que el proveedor confirmó y los que no: el proveedor decide
   * por número (Meta solo bloquea a quien escribió en las últimas 24 horas).
   */
  setBlocked?(
    config: Record<string, unknown>,
    input: { users: string[]; blocked: boolean },
    deps: ChannelAdapterDeps,
  ): Promise<{ done: string[]; failed: string[] }>
}

/**
 * Asunto/cuerpo del envío de correo en frío (`to: mail:<destino>`): la
 * primera línea no vacía del texto es el asunto, el resto el cuerpo.
 * Lo genera el servicio de documentos (caption con asunto primero).
 */
export function splitColdSubject(caption: string): { subject: string; body: string } {
  const lines = caption.split("\n")
  const first = lines.findIndex((l) => l.trim().length > 0)
  if (first === -1) throw new Error("El texto del mensaje es obligatorio")
  const subject = lines[first]!.trim().slice(0, 200)
  const body = lines.slice(first + 1).join("\n").trim()
  return { subject, body }
}
