// Adaptador Microsoft 365 (Outlook) por Microsoft Graph delegado: OAuth 2.0
// con PKCE, lectura incremental con delta del Inbox y respuesta con hilo
// preservado (acción reply de Graph). Sin webhook: solo polling durable con
// el deltaLink como cursor.
// Referencias: https://learn.microsoft.com/en-us/graph/delta-query-messages
// y https://learn.microsoft.com/en-us/graph/api/message-delta
import { isAutomatedEmail, splitColdSubject } from "./protocol.js"
import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  ChannelProvider,
  NormalizedInbound,
  OutboundMessage,
  WebhookParseResult,
} from "./protocol.js"

export const MICROSOFT365_PROVIDER: ChannelProvider = "microsoft365"

/** Scopes mínimos delegados: offline para refresh, leer/enviar correo y perfil básico. */
export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Mail.Read", "Mail.Send"] as const

const GRAPH_API = "https://graph.microsoft.com/v1.0"

/** Config cifrada de la conexión (nunca a la UI ni a logs). */
export interface Microsoft365ConnectionConfig {
  refreshToken: string
  emailAddress: string
  accessToken?: string
  accessTokenExpiresAt?: string
}

export interface MicrosoftOAuthClient {
  clientId: string
  clientSecret: string
  redirectUri: string
  /** Directorio: "common" por defecto; admite tenant id o "organizations". */
  tenant?: string
}

export interface MicrosoftTokenSet {
  accessToken: string
  refreshToken: string | null
  expiresIn: number
  scope: string
}

/** El deltaLink caducó (410/resync): hay que resincronizar completo. */
export class MicrosoftResyncRequired extends Error {
  constructor() {
    super("Checkpoint de Microsoft 365 caducado: se requiere resincronización")
    this.name = "MicrosoftResyncRequired"
  }
}

/** Auth inválida (consentimiento revocado): el buzón debe reconectarse. */
export class MicrosoftAuthError extends Error {
  constructor(detail: string) {
    super(`Microsoft 365 auth inválida: ${detail}`)
    this.name = "MicrosoftAuthError"
  }
}

function tenantOf(client: MicrosoftOAuthClient): string {
  return client.tenant?.trim() || "common"
}

function authorizeUrl(client: MicrosoftOAuthClient): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantOf(client))}/oauth2/v2.0/authorize`
}

function tokenUrl(client: MicrosoftOAuthClient): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantOf(client))}/oauth2/v2.0/token`
}

function getMailboxConfig(config: Record<string, unknown>): Microsoft365ConnectionConfig {
  const refreshToken = config["refreshToken"]
  const emailAddress = config["emailAddress"]
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error("Buzón Microsoft 365 sin refresh token: reconecta el correo")
  }
  if (typeof emailAddress !== "string" || !emailAddress.includes("@")) {
    throw new Error("Buzón Microsoft 365 sin dirección: reconecta el correo")
  }
  const accessToken = config["accessToken"]
  const accessTokenExpiresAt = config["accessTokenExpiresAt"]
  return {
    refreshToken,
    emailAddress,
    ...(typeof accessToken === "string" && accessToken.length > 0 ? { accessToken } : {}),
    ...(typeof accessTokenExpiresAt === "string" ? { accessTokenExpiresAt } : {}),
  }
}

function requireAccessToken(
  config: Record<string, unknown>,
): { cfg: Microsoft365ConnectionConfig; accessToken: string } {
  const cfg = getMailboxConfig(config)
  if (!cfg.accessToken) {
    throw new Error("Buzón Microsoft 365 sin token vigente: espera al próximo sondeo o reconecta")
  }
  return { cfg, accessToken: cfg.accessToken }
}

/** Frontera JSON de red: objeto plano o null (nunca array ni primitivo). */
function asRecord(json: unknown): Record<string, unknown> | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null
  const rec = json as Record<string, unknown> // objeto ya verificado arriba
  return rec
}

function tokenString(json: unknown, key: string): string | null {
  const value = asRecord(json)?.[key]
  return typeof value === "string" ? value : null
}

function tokenNumber(json: unknown, key: string): number {
  const value = asRecord(json)?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 3600
}

export function buildMicrosoftAuthUrl(
  client: MicrosoftOAuthClient,
  input: { state: string; codeChallenge: string; scopes?: readonly string[] },
): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: [...(input.scopes ?? MICROSOFT_SCOPES)].join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  })
  return `${authorizeUrl(client)}?${params.toString()}`
}

async function tokenForm(
  client: MicrosoftOAuthClient,
  body: Record<string, string>,
  deps: ChannelAdapterDeps,
): Promise<{ status: number; json: unknown }> {
  const res = await deps.fetch(tokenUrl(client), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  })
  const json: unknown = await res.json().catch(() => null)
  return { status: res.status, json }
}

function describeTokenError(status: number, json: unknown): string {
  const err = tokenString(json, "error") ?? `http-${status}`
  const desc = tokenString(json, "error_description") ?? ""
  return desc ? `${err}: ${desc}` : err
}

function isInvalidGrant(status: number, json: unknown): boolean {
  return (
    status === 400 || status === 401 || tokenString(json, "error") === "invalid_grant"
  )
}

/** Intercambia el code OAuth por tokens (PKCE con el verifier del servidor). */
export async function exchangeMicrosoftCode(
  client: MicrosoftOAuthClient,
  input: { code: string; codeVerifier: string },
  deps: ChannelAdapterDeps,
): Promise<MicrosoftTokenSet> {
  const { status, json } = await tokenForm(
    client,
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: client.redirectUri,
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
    },
    deps,
  )
  const accessToken = tokenString(json, "access_token")
  if (status >= 400 || !accessToken) {
    throw new Error(`Microsoft 365: intercambio de código falló (${describeTokenError(status, json)})`)
  }
  return {
    accessToken,
    refreshToken: tokenString(json, "refresh_token"),
    expiresIn: tokenNumber(json, "expires_in"),
    scope: tokenString(json, "scope") ?? "",
  }
}

/** Refresca el access token con el refresh cifrado en la conexión. */
export async function refreshMicrosoftAccessToken(
  client: MicrosoftOAuthClient,
  refreshToken: string,
  deps: ChannelAdapterDeps,
): Promise<{ accessToken: string; expiresIn: number; refreshToken: string | null }> {
  const { status, json } = await tokenForm(
    client,
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: [...MICROSOFT_SCOPES].join(" "),
    },
    deps,
  )
  const accessToken = tokenString(json, "access_token")
  if (!accessToken || isInvalidGrant(status, json)) {
    throw new MicrosoftAuthError(describeTokenError(status, json))
  }
  if (status >= 400) {
    throw new Error(`Microsoft 365: refresh falló (${describeTokenError(status, json)})`)
  }
  return {
    accessToken,
    expiresIn: tokenNumber(json, "expires_in"),
    refreshToken: tokenString(json, "refresh_token"),
  }
}

// Azure no expone revocación de tokens delegados por endpoint: desconectar es
// borrar los tokens locales (lo hace el servicio mailbox). Se documenta para
// no fingir una revocación remota que no existe.

async function graphApi(
  accessToken: string,
  url: string,
  deps: ChannelAdapterDeps,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  const res = await deps.fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  const json: unknown = await res.json().catch(() => null)
  if (res.status === 401) throw new MicrosoftAuthError("token rechazado por Microsoft")
  return { status: res.status, json }
}

function graphErrorDetail(json: unknown): string {
  const inner = asRecord(asRecord(json)?.["error"])?.["message"]
  if (typeof inner === "string" && inner.length > 0) return inner.slice(0, 300)
  return "sin detalle"
}

function graphApiError(op: string, status: number, json: unknown): string {
  if (status === 410) return `Microsoft 365 ${op}: checkpoint caducado`
  return `Microsoft 365 ${op} falló: ${status} ${graphErrorDetail(json)}`
}

export async function getMicrosoftProfile(
  accessToken: string,
  deps: ChannelAdapterDeps,
): Promise<{ emailAddress: string; displayName: string }> {
  const { status, json } = await graphApi(
    accessToken,
    `${GRAPH_API}/me?$select=mail,userPrincipalName,displayName`,
    deps,
  )
  if (status >= 400) throw new Error(graphApiError("me", status, json))
  const rec = asRecord(json)
  const mail = rec?.["mail"]
  const upn = rec?.["userPrincipalName"]
  const displayName = rec?.["displayName"]
  const emailAddress =
    (typeof mail === "string" && mail.includes("@") ? mail : null) ??
    (typeof upn === "string" && upn.includes("@") ? upn : null)
  if (!emailAddress) throw new Error("Microsoft 365: perfil sin dirección de correo")
  return {
    emailAddress,
    displayName: typeof displayName === "string" && displayName ? displayName : emailAddress,
  }
}

/* ------------------------- Parse de mensajes ------------------------- */

interface GraphEmailAddress {
  address?: string
  name?: string
}
interface GraphAttachment {
  id?: string
  name?: string
  contentType?: string
  size?: number
  isInline?: boolean
  contentBytes?: string
  "@odata.type"?: string
}
export interface GraphMessage {
  id: string
  conversationId?: string
  subject?: string
  bodyPreview?: string
  body?: { contentType?: string; content?: string }
  from?: { emailAddress?: GraphEmailAddress }
  receivedDateTime?: string
  sentDateTime?: string
  isRead?: boolean
  hasAttachments?: boolean
  internetMessageId?: string
  "@removed"?: unknown
}

const BODY_MAX_CHARS = 20000
const MAX_ATTACHMENTS_PER_MESSAGE = 5
const POLL_MAX_MESSAGES = 25

/** Guarda de frontera: mensaje Graph mínimo tratable. */
function isGraphMessage(value: unknown): value is GraphMessage {
  const rec = asRecord(value)
  return !!rec && typeof rec["id"] === "string" && rec["@removed"] === undefined
}

function senderOf(msg: GraphMessage): { email: string; display: string } {
  const addr = msg.from?.emailAddress
  const email = (addr?.address ?? "").trim().toLowerCase()
  return { email, display: (addr?.name ?? "").trim() || email }
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim()
}

function extractBody(msg: GraphMessage): string | null {
  const body = msg.body
  if (body?.content) {
    const text =
      body.contentType === "html" ? stripHtml(body.content) : body.content.trim()
    if (text) return text.slice(0, BODY_MAX_CHARS)
  }
  const preview = (msg.bodyPreview ?? "").trim()
  return preview ? preview.slice(0, BODY_MAX_CHARS) : null
}

function threadIdOf(msg: GraphMessage): string {
  return `m365-conv:${msg.conversationId ?? msg.id}`
}

/**
 * Normaliza un mensaje delta: un evento de texto (si hay cuerpo) y un evento
 * media por adjunto, todos en el mismo hilo de conversación.
 */
export function graphMessageToEvents(
  msg: GraphMessage,
  selfEmail: string,
): NormalizedInbound[] {
  const { email: fromEmail, display } = senderOf(msg)
  if (!fromEmail || fromEmail === selfEmail.toLowerCase()) return []
  const threadId = threadIdOf(msg)
  const sentAt = msg.receivedDateTime ?? msg.sentDateTime ?? new Date().toISOString()
  // La consulta delta no pide encabezados: decide el remitente.
  const automated = isAutomatedEmail({ from: fromEmail })
  const events: NormalizedInbound[] = []
  const body = extractBody(msg)
  if (body) {
    events.push({
      externalEventId: `m365:${msg.id}`,
      externalMessageId: `m365:${msg.id}`,
      externalThreadId: threadId,
      senderExternalId: `mail:${fromEmail}`,
      senderDisplayName: display || fromEmail,
      content: { type: "text", text: body },
      sentAt,
    })
  }
  return automated ? events.map((event) => ({ ...event, automated: true })) : events
}

function attachmentEvents(
  msg: GraphMessage,
  attachments: GraphAttachment[],
  selfEmail: string,
): NormalizedInbound[] {
  const { email: fromEmail, display } = senderOf(msg)
  if (!fromEmail || fromEmail === selfEmail.toLowerCase()) return []
  const threadId = threadIdOf(msg)
  const sentAt = msg.receivedDateTime ?? msg.sentDateTime ?? new Date().toISOString()
  const events: NormalizedInbound[] = []
  for (const [i, att] of attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE).entries()) {
    if (typeof att.id !== "string" || att.isInline) continue
    events.push({
      externalEventId: `m365:${msg.id}#att${i}`,
      externalMessageId: `m365:${msg.id}#att${i}`,
      externalThreadId: threadId,
      senderExternalId: `mail:${fromEmail}`,
      senderDisplayName: display || fromEmail,
      content: {
        type: "media",
        mediaExternalId: `m365-att:${msg.id}:${att.id}`,
        mimeType: att.contentType ?? "application/octet-stream",
        caption: att.name ?? `adjunto-${i}`,
      },
      sentAt,
    })
  }
  return events
}

async function listAttachments(
  accessToken: string,
  messageId: string,
  deps: ChannelAdapterDeps,
): Promise<GraphAttachment[]> {
  const { status, json } = await graphApi(
    accessToken,
    `${GRAPH_API}/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline&$top=10`,
    deps,
  )
  if (status === 404) return []
  if (status >= 400) throw new Error(graphApiError(`attachments.list ${messageId}`, status, json))
  const raw = asRecord(json)?.["value"]
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is GraphAttachment => asRecord(a)?.["id"] !== undefined)
}

/* ------------------------- Poll incremental ------------------------- */

export interface MicrosoftPollInput {
  accessToken: string
  emailAddress: string
  /**
   * Cursor persistido (URL completa): el deltaLink de una ronda terminada o
   * el nextLink de una ronda a medias; null = primera sincronización.
   */
  cursor: string | null
  /** Reloj inyectable para la primera sincronización (pruebas). */
  now?: Date
}

export interface MicrosoftPollResult {
  events: NormalizedInbound[]
  nextCursor: string
}

const DELTA_SELECT =
  "$select=id,conversationId,subject,bodyPreview,body,from,receivedDateTime,sentDateTime,isRead,hasAttachments,internetMessageId&$top=25"

/** Páginas por vuelta aunque no se llegue al tope (p. ej. solo propios o eliminados). */
const POLL_MAX_PAGES = 10

/**
 * La primera ronda delta recorre la carpeta entera; con el filtro por fecha
 * (el único que admite delta de mensajes: receivedDateTime ge) solo sigue lo
 * que llega desde ahora, así no se importa historial ni se queda a medias.
 */
function initialDeltaUrl(now: Date): string {
  const filter = encodeURIComponent(`receivedDateTime ge ${now.toISOString()}`)
  return `${GRAPH_API}/me/mailFolders/inbox/messages/delta?${DELTA_SELECT}&$filter=${filter}`
}

async function messageEvents(
  msg: GraphMessage,
  fromEmail: string,
  display: string,
  accessToken: string,
  selfEmail: string,
  deps: ChannelAdapterDeps,
): Promise<NormalizedInbound[]> {
  const threadId = threadIdOf(msg)
  const sentAt = msg.receivedDateTime ?? msg.sentDateTime ?? new Date().toISOString()
  const mine: NormalizedInbound[] = []
  const body = extractBody(msg)
  if (body) {
    mine.push({
      externalEventId: `m365:${msg.id}`,
      externalMessageId: `m365:${msg.id}`,
      externalThreadId: threadId,
      senderExternalId: `mail:${fromEmail}`,
      senderDisplayName: display || fromEmail,
      content: { type: "text", text: body },
      sentAt,
    })
  }
  if (msg.hasAttachments) {
    const atts = await listAttachments(accessToken, msg.id, deps)
    mine.push(...attachmentEvents(msg, atts, selfEmail))
  }
  if (mine.length === 0) {
    mine.push({
      externalEventId: `m365:${msg.id}`,
      externalMessageId: `m365:${msg.id}`,
      externalThreadId: threadId,
      senderExternalId: `mail:${fromEmail}`,
      senderDisplayName: display || fromEmail,
      content: {
        type: "text",
        text: msg.subject ? `(sin cuerpo) ${msg.subject}` : "(correo sin contenido)",
      },
      sentAt,
    })
  }
  // La consulta delta no pide encabezados: decide el remitente.
  return isAutomatedEmail({ from: fromEmail }) ? mine.map((event) => ({ ...event, automated: true })) : mine
}

/**
 * Lee la ronda delta página a página sin perder ningún mensaje: procesa
 * páginas completas hasta juntar POLL_MAX_MESSAGES de otros remitentes (los
 * propios no cuentan) y, si la ronda sigue, devuelve como cursor el nextLink
 * pendiente; la próxima vuelta continúa desde esa página. Solo al terminar la
 * ronda el cursor es el deltaLink. Repetir un mensaje no duplica: el worker
 * deduplica por id. Si el checkpoint caducó lanza MicrosoftResyncRequired.
 */
export async function pollMicrosoftMailbox(
  input: MicrosoftPollInput,
  deps: ChannelAdapterDeps,
): Promise<MicrosoftPollResult> {
  let url = input.cursor ?? initialDeltaUrl(input.now ?? new Date())
  const selfEmail = input.emailAddress.toLowerCase()
  const seen = new Set<string>()
  const events: NormalizedInbound[] = []
  let processed = 0
  for (let pages = 1; ; pages++) {
    const { status, json } = await graphApi(input.accessToken, url, deps)
    if (status === 410) throw new MicrosoftResyncRequired()
    if (status >= 400) throw new Error(graphApiError("messages.delta", status, json))
    const rec = asRecord(json)
    const raw = rec?.["value"]
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!isGraphMessage(item) || seen.has(item.id)) continue
      seen.add(item.id)
      const { email: fromEmail, display } = senderOf(item)
      if (!fromEmail || fromEmail === selfEmail) continue
      processed += 1
      events.push(...(await messageEvents(item, fromEmail, display, input.accessToken, selfEmail, deps)))
    }
    const next = rec?.["@odata.nextLink"]
    const delta = rec?.["@odata.deltaLink"]
    if (typeof next === "string") {
      // Ronda a medias: el cursor es la página que falta, nunca el final.
      if (processed >= POLL_MAX_MESSAGES || pages >= POLL_MAX_PAGES) return { events, nextCursor: next }
      url = next
      continue
    }
    if (typeof delta === "string") return { events, nextCursor: delta }
    throw new Error("Microsoft 365 delta sin nextLink ni deltaLink: reintenta el sondeo")
  }
}

/* ------------------------- Envío con hilo ------------------------- */

async function latestInboundInConversation(
  accessToken: string,
  conversationId: string,
  deps: ChannelAdapterDeps,
): Promise<string | null> {
  const filter = encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)
  const { status, json } = await graphApi(
    accessToken,
    `${GRAPH_API}/me/messages?$filter=${filter}&$orderby=receivedDateTime desc&$top=1&$select=id,from`,
    deps,
  )
  if (status >= 400) throw new Error(graphApiError("messages.list conversación", status, json))
  const raw = asRecord(json)?.["value"]
  if (!Array.isArray(raw)) return null
  const first = raw.find(isGraphMessage)
  return first ? first.id : null
}

async function downloadOutboundMedia(
  url: string,
  deps: ChannelAdapterDeps,
): Promise<Uint8Array> {
  const res = await deps.fetch(url)
  if (!res.ok) throw new Error(`No se pudo leer el adjunto para enviar (${res.status})`)
  const buf = await res.arrayBuffer()
  if (buf.byteLength > 20 * 1024 * 1024) throw new Error("Adjunto mayor a 20 MB: Graph lo rechaza")
  return new Uint8Array(buf)
}

function coldAddress(to: string): string | null {
  if (!to.startsWith("mail:")) return null
  const address = to.slice("mail:".length).trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("Microsoft 365: dirección de destino inválida")
  return address
}


/* ------------------------- Adaptador ------------------------- */

export const microsoft365Adapter: ChannelAdapter = {
  provider: MICROSOFT365_PROVIDER,
  capabilities: {
    templates: false,
    media: true,
    interactive: false,
    readReceipts: false,
    edit: false,
  },

  // Sin webhook: solo polling autenticado con cursor. Aceptar un POST sin
  // firma sería un webhook falsificado.
  verifyWebhook(): boolean {
    return false
  },

  parseWebhook(): WebhookParseResult {
    return { messages: [], statuses: [] }
  },

  async sendMessage(config, msg: OutboundMessage, deps) {
    const { accessToken } = requireAccessToken(config)
    if (msg.kind.type === "template") throw new Error("Microsoft 365 no soporta plantillas")
    // Envío en frío (Fase 7 Finanzas): `to: mail:<destino>` crea y envía un
    // mensaje nuevo con el asunto de la primera línea del texto.
    if (!msg.to.startsWith("m365-conv:")) {
      const to = coldAddress(msg.to)
      if (!to) throw new Error("Microsoft 365: hilo inválido para responder")
      if (msg.kind.type === "text") {
        if (!msg.kind.text.trim()) throw new Error("El texto del mensaje es obligatorio")
        const { subject, body } = splitColdSubject(msg.kind.text)
        const { status, json } = await graphApi(accessToken, `${GRAPH_API}/me/sendMail`, deps, {
          method: "POST",
          body: {
            message: {
              subject,
              body: { contentType: "Text", content: body },
              toRecipients: [{ emailAddress: { address: to } }],
            },
          },
        })
        if (status >= 400 && status !== 202) throw new Error(graphApiError("messages.send", status, json))
        return { externalId: `m365-send:${to}:${Date.now()}` }
      }
      if (msg.kind.type !== "media") throw new Error("Tipo de mensaje no soportado por Microsoft 365")
      const { subject, body } = splitColdSubject(msg.kind.media.caption ?? "")
      const bytes = await downloadOutboundMedia(msg.kind.media.url, deps)
      const { status, json } = await graphApi(accessToken, `${GRAPH_API}/me/sendMail`, deps, {
        method: "POST",
        body: {
          message: {
            subject,
            body: { contentType: "Text", content: body },
            toRecipients: [{ emailAddress: { address: to } }],
            attachments: [
              {
                "@odata.type": "#microsoft.graph.fileAttachment",
                name: msg.kind.media.filename,
                contentType: msg.kind.media.mimeType,
                contentBytes: Buffer.from(bytes).toString("base64"),
              },
            ],
          },
        },
      })
      if (status >= 400 && status !== 202) throw new Error(graphApiError("messages.send", status, json))
      return { externalId: `m365-send:${to}:${Date.now()}` }
    }
    const conversationId = msg.to.slice("m365-conv:".length)
    const replyToId = await latestInboundInConversation(accessToken, conversationId, deps)
    if (!replyToId) throw new Error("Microsoft 365: sin mensaje previo para responder en el hilo")
    if (msg.kind.type === "text") {
      if (!msg.kind.text.trim()) throw new Error("El texto del mensaje es obligatorio")
      // Acción reply: envía de inmediato preservando el hilo de la conversación.
      const { status, json } = await graphApi(
        accessToken,
        `${GRAPH_API}/me/messages/${encodeURIComponent(replyToId)}/reply`,
        deps,
        {
          method: "POST",
          body: { message: { body: { contentType: "Text", content: msg.kind.text } } },
        },
      )
      if (status >= 400 && status !== 202) {
        throw new Error(graphApiError("messages.reply", status, json))
      }
      return { externalId: `m365-reply:${replyToId}:${Date.now()}` }
    }
    if (msg.kind.type !== "media") throw new Error("Tipo de mensaje no soportado por Microsoft 365")
    // Con adjunto: createReply (borrador) + adjunto + send, todo en el hilo.
    const created = await graphApi(
      accessToken,
      `${GRAPH_API}/me/messages/${encodeURIComponent(replyToId)}/createReply`,
      deps,
      { method: "POST", body: {} },
    )
    const draftId = asRecord(created.json)?.["id"]
    if (created.status >= 400 || typeof draftId !== "string") {
      throw new Error(graphApiError("messages.createReply", created.status, created.json))
    }
    const bytes = await downloadOutboundMedia(msg.kind.media.url, deps)
    const attached = await graphApi(
      accessToken,
      `${GRAPH_API}/me/messages/${encodeURIComponent(draftId)}/attachments`,
      deps,
      {
        method: "POST",
        body: {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: msg.kind.media.filename,
          contentType: msg.kind.media.mimeType,
          contentBytes: Buffer.from(bytes).toString("base64"),
        },
      },
    )
    if (attached.status >= 400 && attached.status !== 201) {
      throw new Error(graphApiError("messages.attach", attached.status, attached.json))
    }
    if (msg.kind.media.caption) {
      await graphApi(
        accessToken,
        `${GRAPH_API}/me/messages/${encodeURIComponent(draftId)}`,
        deps,
        {
          method: "PATCH",
          body: { body: { contentType: "Text", content: msg.kind.media.caption } },
        },
      )
    }
    const sent = await graphApi(
      accessToken,
      `${GRAPH_API}/me/messages/${encodeURIComponent(draftId)}/send`,
      deps,
      { method: "POST" },
    )
    if (sent.status >= 400 && sent.status !== 202) {
      throw new Error(graphApiError("messages.send", sent.status, sent.json))
    }
    return { externalId: `m365-draft:${draftId}` }
  },

  async fetchMedia(config, mediaExternalId, deps) {
    const { accessToken } = requireAccessToken(config)
    const match = mediaExternalId.match(/^m365-att:([^:]+):(.+)$/)
    const messageId = match?.[1]
    const attachmentId = match?.[2]
    if (!messageId || !attachmentId) throw new Error("Adjunto Microsoft 365 inválido")
    const { status, json } = await graphApi(
      accessToken,
      `${GRAPH_API}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?$select=id,name,contentType,contentBytes`,
      deps,
    )
    if (status >= 400) throw new Error(graphApiError("attachments.get", status, json))
    const rec = asRecord(json)
    const data = rec?.["contentBytes"]
    if (typeof data !== "string" || data.length === 0) {
      throw new Error("Adjunto Microsoft 365 sin datos (o demasiado grande para inline)")
    }
    const name = rec?.["name"]
    const contentType = rec?.["contentType"]
    return {
      bytes: new Uint8Array(Buffer.from(data, "base64")),
      mimeType: typeof contentType === "string" ? contentType : "application/octet-stream",
      filename: typeof name === "string" && name ? name : `${attachmentId}.bin`,
    }
  },

  async validateConnection(config, deps) {
    const { cfg, accessToken } = requireAccessToken(config)
    const profile = await getMicrosoftProfile(accessToken, deps)
    if (profile.emailAddress.toLowerCase() !== cfg.emailAddress.toLowerCase()) {
      throw new Error("El token pertenece a otro buzón: reconecta el correo")
    }
    return { externalId: profile.emailAddress, displayName: profile.displayName }
  },
}
