// Adaptador Gmail (Google Workspace) por API REST: OAuth 2.0 con PKCE,
// lectura incremental con users.history.list y envío con hilo preservado.
// Sin webhook: Gmail empuja por Pub/Sub (falsificable sin verificación de
// JWT de Google); este slice usa polling durable con historyId como cursor.
// Referencias: https://developers.google.com/workspace/gmail/api/guides/sync
// y https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list
import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  ChannelProvider,
  NormalizedInbound,
  OutboundMessage,
  WebhookParseResult,
} from "./protocol.js"

export const GMAIL_PROVIDER: ChannelProvider = "gmail"

/** Scopes mínimos: leer correo + enviar. Sin acceso a Drive ni perfil amplio. */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
] as const

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1"

/** Config cifrada de la conexión (nunca a la UI ni a logs). */
export interface GmailConnectionConfig {
  refreshToken: string
  emailAddress: string
  /** Access token cacheado por el worker (vive ~1h); se refresca con el refresh. */
  accessToken?: string
  accessTokenExpiresAt?: string
}

export interface GmailOAuthClient {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface GmailTokenSet {
  accessToken: string
  refreshToken: string | null
  expiresIn: number
  scope: string
}

/** El checkpoint historyId caducó (404): hay que resincronizar completo. */
export class GmailResyncRequired extends Error {
  constructor() {
    super("Checkpoint de Gmail caducado: se requiere resincronización")
    this.name = "GmailResyncRequired"
  }
}

/** Auth inválida (revocada/caducada): el buzón debe reconectarse. */
export class GmailAuthError extends Error {
  constructor(detail: string) {
    super(`Gmail auth inválida: ${detail}`)
    this.name = "GmailAuthError"
  }
}

function getMailboxConfig(config: Record<string, unknown>): GmailConnectionConfig {
  const refreshToken = config["refreshToken"]
  const emailAddress = config["emailAddress"]
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new Error("Buzón Gmail sin refresh token: reconecta el correo")
  }
  if (typeof emailAddress !== "string" || !emailAddress.includes("@")) {
    throw new Error("Buzón Gmail sin dirección: reconecta el correo")
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

function requireAccessToken(
  config: Record<string, unknown>,
): { cfg: GmailConnectionConfig; accessToken: string } {
  const cfg = getMailboxConfig(config)
  if (!cfg.accessToken) {
    throw new Error("Buzón Gmail sin token vigente: espera al próximo sondeo o reconecta")
  }
  return { cfg, accessToken: cfg.accessToken }
}

function b64urlDecode(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64"))
}

function b64urlEncodeText(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url")
}

function b64urlEncodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

/** PKCE S256: el state firmado viaja en `state`; el verifier queda en servidor. */
export async function sha256B64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return b64urlEncodeBytes(new Uint8Array(digest))
}

export function buildGmailAuthUrl(
  client: Pick<GmailOAuthClient, "clientId" | "redirectUri">,
  input: { state: string; codeChallenge: string; scopes?: readonly string[] },
): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: [...(input.scopes ?? GMAIL_SCOPES)].join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  })
  return `${GOOGLE_AUTH_URL}?${params.toString()}`
}

async function tokenForm(
  body: Record<string, string>,
  deps: ChannelAdapterDeps,
): Promise<{ status: number; json: unknown }> {
  const res = await deps.fetch(GOOGLE_TOKEN_URL, {
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

/** Intercambia el code OAuth por tokens (PKCE con el verifier del servidor). */
export async function exchangeGmailCode(
  client: GmailOAuthClient,
  input: { code: string; codeVerifier: string },
  deps: ChannelAdapterDeps,
): Promise<GmailTokenSet> {
  const { status, json } = await tokenForm(
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
    throw new Error(`Gmail: intercambio de código falló (${describeTokenError(status, json)})`)
  }
  return {
    accessToken,
    refreshToken: tokenString(json, "refresh_token"),
    expiresIn: tokenNumber(json, "expires_in"),
    scope: tokenString(json, "scope") ?? "",
  }
}

/** Refresca el access token con el refresh cifrado en la conexión. */
export async function refreshGmailAccessToken(
  client: GmailOAuthClient,
  refreshToken: string,
  deps: ChannelAdapterDeps,
): Promise<{ accessToken: string; expiresIn: number }> {
  const { status, json } = await tokenForm(
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    deps,
  )
  const accessToken = tokenString(json, "access_token")
  // Solo invalid_grant (credencial revocada/caducada) desactiva el buzón;
  // el resto (500, red, forma inesperada) es transitorio y reintenta.
  if (status === 400 || status === 401 || tokenString(json, "error") === "invalid_grant") {
    throw new GmailAuthError(describeTokenError(status, json))
  }
  if (status >= 400 || !accessToken) {
    throw new Error(`Gmail: refresh falló (${describeTokenError(status, json)})`)
  }
  return { accessToken, expiresIn: tokenNumber(json, "expires_in") }
}

/** Revoca el token en Google (best-effort: true si quedó revocado o ya era inválido). */
export async function revokeGmailToken(
  token: string,
  deps: ChannelAdapterDeps,
): Promise<boolean> {
  const res = await deps.fetch(GOOGLE_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  }).catch(() => null)
  return res === null || res.ok || res.status === 400
}

async function gmailApi(
  accessToken: string,
  path: string,
  deps: ChannelAdapterDeps,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  const res = await deps.fetch(`${GMAIL_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  const json: unknown = await res.json().catch(() => null)
  if (res.status === 401) throw new GmailAuthError("token rechazado por Google")
  return { status: res.status, json }
}

function gmailApiError(op: string, status: number, json: unknown): string {
  const detail = asRecord(json)?.["error"]
  const msg = detail === undefined ? `http-${status}` : JSON.stringify(detail).slice(0, 300)
  return `Gmail ${op} falló: ${status} ${msg}`
}

export async function getGmailProfile(
  accessToken: string,
  deps: ChannelAdapterDeps,
): Promise<{ emailAddress: string; historyId: string }> {
  const { status, json } = await gmailApi(accessToken, "/users/me/profile", deps)
  if (status >= 400) throw new Error(gmailApiError("profile", status, json))
  const rec = asRecord(json)
  const emailAddress = rec?.["emailAddress"]
  const historyId = rec?.["historyId"]
  if (typeof emailAddress !== "string" || typeof historyId !== "string") {
    throw new Error("Gmail profile sin emailAddress/historyId")
  }
  return { emailAddress, historyId }
}

/* ------------------------- Parse de mensajes ------------------------- */

interface GmailHeader {
  name: string
  value: string
}
interface GmailPart {
  mimeType?: string
  filename?: string
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: GmailPart[]
  headers?: GmailHeader[]
}
export interface GmailFullMessage {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate?: string
  payload?: GmailPart
  snippet?: string
}

const BODY_MAX_CHARS = 20000
const MAX_ATTACHMENTS_PER_MESSAGE = 5

function headerOf(msg: GmailFullMessage, name: string): string | null {
  const headers = msg.payload?.headers ?? []
  const found = headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return found ? found.value : null
}

function parseFrom(raw: string): { email: string; display: string } {
  const m = raw.match(/^(.*)<([^<>@\s]+@[^<>@\s]+)>\s*$/)
  if (m) {
    const display = (m[1] ?? "").trim().replace(/^"|"$/g, "")
    return { email: (m[2] ?? "").toLowerCase(), display: display || (m[2] ?? "") }
  }
  const email = raw.trim().toLowerCase()
  return { email, display: raw.trim() }
}

function collectParts(part: GmailPart | undefined, out: GmailPart[]): void {
  if (!part) return
  out.push(part)
  for (const child of part.parts ?? []) collectParts(child, out)
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

function extractBody(msg: GmailFullMessage): string | null {
  const parts: GmailPart[] = []
  collectParts(msg.payload, parts)
  for (const p of parts) {
    if ((p.mimeType === "text/plain" || (!p.mimeType && !p.filename)) && p.body?.data) {
      try {
        const text = Buffer.from(b64urlDecode(p.body.data)).toString("utf8").trim()
        if (text) return text.slice(0, BODY_MAX_CHARS)
      } catch {
        continue
      }
    }
  }
  for (const p of parts) {
    if (p.mimeType === "text/html" && p.body?.data) {
      try {
        const text = stripHtml(Buffer.from(b64urlDecode(p.body.data)).toString("utf8"))
        if (text) return text.slice(0, BODY_MAX_CHARS)
      } catch {
        continue
      }
    }
  }
  return msg.snippet?.trim() ? (msg.snippet.trim().slice(0, BODY_MAX_CHARS) ?? null) : null
}

interface GmailAttachmentRef {
  attachmentId: string
  filename: string
  mimeType: string
}

function extractAttachments(msg: GmailFullMessage): GmailAttachmentRef[] {
  const parts: GmailPart[] = []
  collectParts(msg.payload, parts)
  const out: GmailAttachmentRef[] = []
  for (const p of parts) {
    const attachmentId = p.body?.attachmentId
    if (!attachmentId || !p.filename) continue
    out.push({
      attachmentId,
      filename: p.filename,
      mimeType: p.mimeType ?? "application/octet-stream",
    })
    if (out.length >= MAX_ATTACHMENTS_PER_MESSAGE) break
  }
  return out
}

function sentAtOf(msg: GmailFullMessage): string {
  const internal = msg.internalDate ? Number(msg.internalDate) : NaN
  if (Number.isFinite(internal) && internal > 0) return new Date(internal).toISOString()
  const dateHeader = headerOf(msg, "Date")
  if (dateHeader) {
    const parsed = new Date(dateHeader)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return new Date().toISOString()
}

/**
 * Normaliza un mensaje completo. Emite un evento de texto (si hay cuerpo) y
 * un evento media por adjunto, todos en el mismo hilo: la bandeja solo
 * conoce contenido simple y así no se pierde nada del correo original.
 */
export function gmailMessageToEvents(
  msg: GmailFullMessage,
  selfEmail: string,
): NormalizedInbound[] {
  const labels = msg.labelIds ?? []
  if (labels.includes("SENT") || labels.includes("DRAFT")) return []
  const fromRaw = headerOf(msg, "From") ?? ""
  const { email: fromEmail, display } = parseFrom(fromRaw)
  if (!fromEmail || fromEmail === selfEmail.toLowerCase()) return []
  const threadId = `gmail-thread:${msg.threadId}`
  const sentAt = sentAtOf(msg)
  const events: NormalizedInbound[] = []
  const body = extractBody(msg)
  if (body) {
    events.push({
      externalEventId: `gmail:${msg.id}`,
      externalMessageId: `gmail:${msg.id}`,
      externalThreadId: threadId,
      senderExternalId: `mail:${fromEmail}`,
      senderDisplayName: display || fromEmail,
      content: { type: "text", text: body },
      sentAt,
    })
  }
  for (const [i, att] of extractAttachments(msg).entries()) {
    events.push({
      externalEventId: `gmail:${msg.id}#att${i}`,
      externalMessageId: `gmail:${msg.id}#att${i}`,
      externalThreadId: threadId,
      senderExternalId: `mail:${fromEmail}`,
      senderDisplayName: display || fromEmail,
      content: {
        type: "media",
        mediaExternalId: `gmail-att:${msg.id}:${att.attachmentId}`,
        mimeType: att.mimeType,
        caption: att.filename,
      },
      sentAt,
    })
  }
  // Correo vacío sin adjuntos: conservar al menos el asunto como texto.
  if (events.length === 0) {
    const subject = headerOf(msg, "Subject")?.trim()
    events.push({
      externalEventId: `gmail:${msg.id}`,
      externalMessageId: `gmail:${msg.id}`,
      externalThreadId: threadId,
      senderExternalId: `mail:${fromEmail}`,
      senderDisplayName: display || fromEmail,
      content: { type: "text", text: subject ? `(sin cuerpo) ${subject}` : "(correo sin contenido)" },
      sentAt,
    })
  }
  return events
}

/* ------------------------- Poll incremental ------------------------- */

export interface GmailPollInput {
  accessToken: string
  emailAddress: string
  /** historyId persistido; null = primera sincronización. */
  cursor: string | null
}

export interface GmailPollResult {
  events: NormalizedInbound[]
  nextCursor: string
}

const POLL_MAX_MESSAGES = 25

/** Guarda de frontera: mensaje completo mínimo (id + hilo). */
function isFullMessage(value: unknown): value is GmailFullMessage {
  const rec = asRecord(value)
  return !!rec && typeof rec["id"] === "string" && typeof rec["threadId"] === "string"
}

async function getFullMessage(
  accessToken: string,
  id: string,
  deps: ChannelAdapterDeps,
): Promise<GmailFullMessage | null> {
  const { status, json } = await gmailApi(
    accessToken,
    `/users/me/messages/${encodeURIComponent(id)}?format=full`,
    deps,
  )
  if (status === 404) return null
  if (status >= 400 || !isFullMessage(json)) {
    throw new Error(gmailApiError(`messages.get ${id}`, status, json))
  }
  return json
}

async function initialSync(
  input: GmailPollInput,
  deps: ChannelAdapterDeps,
): Promise<GmailPollResult> {
  const profile = await getGmailProfile(input.accessToken, deps)
  const { status, json } = await gmailApi(
    input.accessToken,
    "/users/me/messages?maxResults=10&q=in%3Ainbox",
    deps,
  )
  if (status >= 400) throw new Error(gmailApiError("messages.list", status, json))
  const rawList = asRecord(json)?.["messages"]
  const ids: string[] = []
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      const id = asRecord(item)?.["id"]
      if (typeof id === "string" && id.length > 0) ids.push(id)
    }
  }
  const events: NormalizedInbound[] = []
  for (const id of ids.slice(0, POLL_MAX_MESSAGES)) {
    const full = await getFullMessage(input.accessToken, id, deps)
    if (full) events.push(...gmailMessageToEvents(full, input.emailAddress))
  }
  return { events, nextCursor: profile.historyId }
}

/**
 * Lee cambios desde el cursor y avanza SOLO con el historyId devuelto por
 * Google tras procesar todas las páginas. Si el checkpoint caducó lanza
 * GmailResyncRequired (el worker hace sync inicial sin perder ingesta).
 */
export async function pollGmailMailbox(
  input: GmailPollInput,
  deps: ChannelAdapterDeps,
): Promise<GmailPollResult> {
  if (!input.cursor) return initialSync(input, deps)
  const addedIds: string[] = []
  let pageToken: string | undefined
  let historyId = input.cursor
  for (;;) {
    const params = new URLSearchParams({
      startHistoryId: input.cursor,
      historyTypes: "messageAdded",
    })
    if (pageToken) params.set("pageToken", pageToken)
    const { status, json } = await gmailApi(input.accessToken, `/users/me/history?${params}`, deps)
    if (status === 404) throw new GmailResyncRequired()
    if (status >= 400) throw new Error(gmailApiError("history.list", status, json))
    const page = asRecord(json)
    const rawHistory = page?.["history"]
    if (Array.isArray(rawHistory)) {
      for (const item of rawHistory) {
        const added = asRecord(item)?.["messagesAdded"]
        if (!Array.isArray(added)) continue
        for (const entry of added) {
          const id = asRecord(asRecord(entry)?.["message"])?.["id"]
          if (typeof id === "string" && id.length > 0) addedIds.push(id)
        }
      }
    }
    const nextHistory = page?.["historyId"]
    if (typeof nextHistory === "string") historyId = nextHistory
    const next = page?.["nextPageToken"]
    if (typeof next !== "string") break
    pageToken = next
  }
  const events: NormalizedInbound[] = []
  for (const id of addedIds.slice(0, POLL_MAX_MESSAGES)) {
    const full = await getFullMessage(input.accessToken, id, deps)
    if (full) events.push(...gmailMessageToEvents(full, input.emailAddress))
  }
  return { events, nextCursor: historyId }
}

/* ------------------------- Envío con hilo ------------------------- */

interface ThreadResolution {
  to: string
  subject: string
  inReplyTo: string | null
  references: string | null
}

async function resolveReplyTarget(
  accessToken: string,
  threadId: string,
  selfEmail: string,
  deps: ChannelAdapterDeps,
): Promise<ThreadResolution> {
  const { status, json } = await gmailApi(
    accessToken,
    `/users/me/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Date`,
    deps,
  )
  if (status >= 400) {
    throw new Error(gmailApiError(`threads.get ${threadId}`, status, json))
  }
  const rawMessages = asRecord(json)?.["messages"]
  const messages = Array.isArray(rawMessages) ? rawMessages.filter(isFullMessage) : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const { email } = parseFrom(headerOf(msg, "From") ?? "")
    if (!email || email === selfEmail.toLowerCase()) continue
    // Responder va al Reply-To cuando existe (listas, buzones compartidos);
    // la identidad del hilo sigue siendo el From (dedupe por remitente real).
    const replyTo = parseFrom(headerOf(msg, "Reply-To") ?? "").email
    const to =
      replyTo.includes("@") && replyTo !== selfEmail.toLowerCase() ? replyTo : email
    const subject = headerOf(msg, "Subject")?.trim() || "(sin asunto)"
    return {
      to,
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      inReplyTo: headerOf(msg, "Message-ID"),
      references: [headerOf(msg, "References"), headerOf(msg, "Message-ID")]
        .filter(Boolean)
        .join(" "),
    }
  }
  throw new Error("Gmail: el hilo no tiene destinatario para responder")
}

function asciiHeader(value: string): string {
  // Cabeceras MIME: plegar a ASCII seguro sin romper el hilo.
  return value.replace(/[\r\n]/g, " ").trim()
}

function buildTextMime(input: {
  from: string
  to: string
  subject: string
  inReplyTo: string | null
  references: string | null
  text: string
}): string {
  const lines = [
    `From: ${asciiHeader(input.from)}`,
    `To: ${asciiHeader(input.to)}`,
    `Subject: ${asciiHeader(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
  ]
  if (input.inReplyTo) lines.push(`In-Reply-To: ${asciiHeader(input.inReplyTo)}`)
  if (input.references) lines.push(`References: ${asciiHeader(input.references)}`)
  const encoded = Buffer.from(input.text, "utf8").toString("base64")
  return `${lines.join("\r\n")}\r\n\r\n${encoded}`
}

function buildMultipartMime(input: {
  from: string
  to: string
  subject: string
  inReplyTo: string | null
  references: string | null
  text: string
  attachments: { filename: string; mimeType: string; bytes: Uint8Array }[]
}): string {
  const boundary = `odentia-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
  const lines = [
    `From: ${asciiHeader(input.from)}`,
    `To: ${asciiHeader(input.to)}`,
    `Subject: ${asciiHeader(input.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ]
  if (input.inReplyTo) lines.push(`In-Reply-To: ${asciiHeader(input.inReplyTo)}`)
  if (input.references) lines.push(`References: ${asciiHeader(input.references)}`)
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.text, "utf8").toString("base64"),
  ]
  for (const att of input.attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mimeType}; name="${asciiHeader(att.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${asciiHeader(att.filename)}"`,
      "",
      Buffer.from(att.bytes).toString("base64"),
    )
  }
  parts.push(`--${boundary}--`, "")
  return `${lines.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`
}

async function downloadOutboundMedia(
  url: string,
  deps: ChannelAdapterDeps,
): Promise<Uint8Array> {
  // URL firmada del storage propio (corta duración); el proveedor la descarga.
  const res = await deps.fetch(url)
  if (!res.ok) throw new Error(`No se pudo leer el adjunto para enviar (${res.status})`)
  const buf = await res.arrayBuffer()
  if (buf.byteLength > 20 * 1024 * 1024) throw new Error("Adjunto mayor a 20 MB: Gmail lo rechaza")
  return new Uint8Array(buf)
}

async function sendThreadMessage(
  accessToken: string,
  threadId: string,
  raw: string,
  deps: ChannelAdapterDeps,
): Promise<string> {
  const { status, json } = await gmailApi(accessToken, "/users/me/messages/send", deps, {
    method: "POST",
    body: { raw: b64urlEncodeText(raw), threadId },
  })
  if (status >= 400) {
    throw new Error(gmailApiError("messages.send", status, json))
  }
  const sentId = asRecord(json)?.["id"]
  if (typeof sentId !== "string" || sentId.length === 0) {
    throw new Error(gmailApiError("messages.send sin id", status, json))
  }
  return `gmail:${sentId}`
}

/* ------------------------- Adaptador ------------------------- */

export const gmailAdapter: ChannelAdapter = {
  provider: GMAIL_PROVIDER,
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
    const { cfg, accessToken } = requireAccessToken(config)
    const threadId = msg.to.startsWith("gmail-thread:")
      ? msg.to.slice("gmail-thread:".length)
      : null
    if (!threadId) throw new Error("Gmail: hilo inválido para responder")
    if (msg.kind.type === "template") throw new Error("Gmail no soporta plantillas")
    const target = await resolveReplyTarget(accessToken, threadId, cfg.emailAddress, deps)
    if (msg.kind.type === "text") {
      if (!msg.kind.text.trim()) throw new Error("El texto del mensaje es obligatorio")
      const raw = buildTextMime({ from: cfg.emailAddress, ...target, text: msg.kind.text })
      return { externalId: await sendThreadMessage(accessToken, threadId, raw, deps) }
    }
    if (msg.kind.type !== "media") throw new Error("Tipo de mensaje no soportado por Gmail")
    const bytes = await downloadOutboundMedia(msg.kind.media.url, deps)
    const raw = buildMultipartMime({
      from: cfg.emailAddress,
      ...target,
      text: msg.kind.media.caption ?? "",
      attachments: [
        { filename: msg.kind.media.filename, mimeType: msg.kind.media.mimeType, bytes },
      ],
    })
    return { externalId: await sendThreadMessage(accessToken, threadId, raw, deps) }
  },

  async fetchMedia(config, mediaExternalId, deps) {
    const { accessToken } = requireAccessToken(config)
    const match = mediaExternalId.match(/^gmail-att:([^:]+):(.+)$/)
    const messageId = match?.[1]
    const attachmentId = match?.[2]
    if (!messageId || !attachmentId) throw new Error("Adjunto Gmail inválido")
    const full = await getFullMessage(accessToken, messageId, deps)
    if (!full) throw new Error("Mensaje Gmail no encontrado para el adjunto")
    const parts: GmailPart[] = []
    collectParts(full.payload, parts)
    const part = parts.find((p) => p.body?.attachmentId === attachmentId)
    if (!part) throw new Error("Adjunto Gmail no encontrado en el mensaje")
    const { status, json } = await gmailApi(
      accessToken,
      `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      deps,
    )
    if (status >= 400) {
      throw new Error(gmailApiError("attachments.get", status, json))
    }
    const data = asRecord(json)?.["data"]
    if (typeof data !== "string") throw new Error("Adjunto Gmail sin datos")
    return {
      bytes: b64urlDecode(data),
      mimeType: part.mimeType ?? "application/octet-stream",
      filename: part.filename ?? `${attachmentId}.bin`,
    }
  },

  async validateConnection(config, deps) {
    const { cfg, accessToken } = requireAccessToken(config)
    const profile = await getGmailProfile(accessToken, deps)
    if (profile.emailAddress.toLowerCase() !== cfg.emailAddress.toLowerCase()) {
      throw new Error("El token pertenece a otro buzón: reconecta el correo")
    }
    return { externalId: profile.emailAddress, displayName: profile.emailAddress }
  },
}
