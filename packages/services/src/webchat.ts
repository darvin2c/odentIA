import { randomUUID } from "node:crypto"
import {
  assertValidWebchatConfig,
  createWebchatToken,
  isWebchatSessionId,
  newWebchatSessionId,
  verifyWebchatToken,
  WEBCHAT_CHANNEL,
  type WebchatConnectionConfig,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { channelConnection, conversation, message } from "@odentia/db/schema/crm"
import { webchatRateLimit } from "@odentia/db/schema/webchat"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, gt, or, sql } from "drizzle-orm"
import { createConnection, setConnectionStatus } from "./connections.js"
import { listMessages, type MessageItem } from "./conversations.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { decryptConfig, encryptJson } from "./secrets.js"

/** Proveedor del chat web embebible propio (sin red externa). */
export const WEBCHAT_PROVIDER = "web_chat"

/** Re-export del canal lógico para rutas y seeds. */
export { WEBCHAT_CHANNEL }
export type { WebchatConnectionConfig }

/** Vista admin de una conexión webchat (la config no tiene secretos). */
export interface WebchatAdminItem {
  id: string
  displayName: string
  externalId: string | null
  status: string
  createdAt: string
  updatedAt: string
  config: WebchatConnectionConfig
}

function toAdminItem(row: typeof channelConnection.$inferSelect, config: WebchatConnectionConfig): WebchatAdminItem {
  return {
    id: row.id,
    displayName: row.displayName,
    externalId: row.externalId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    config,
  }
}

/**
 * Config descifrada de la conexión (AES-256-GCM con SECRETS_KEY, igual que el
 * resto de conexiones). La config del widget son orígenes públicos, pero el
 * cifrado uniforme evita una vía lateral y mantiene el `decrypt` del worker.
 */
function readConfig(
  row: typeof channelConnection.$inferSelect,
  secretsKey: Buffer,
): WebchatConnectionConfig {
  try {
    return assertValidWebchatConfig(decryptConfig(secretsKey, row.configEncrypted))
  } catch (e) {
    // Config corrupta = fallo interno (500 vía onError): ServiceError solo
    // modela 400/404/409 y esto nunca es culpa del visitante ni del admin.
    throw new Error(e instanceof Error ? e.message : "Configuración del chat web ilegible")
  }
}

export interface WebchatPoll {
  status: "open" | "closed" | null
  items: MessageItem[]
  nextCursor: string | null
  delivered: number
}

export interface WebchatConfigInput {
  allowedOrigins: string[]
  widgetTitle?: string
  widgetColor?: string
  greeting?: string
  notifyUrl?: string
}

/** Valida el input admin (nombres y límites en español). */
export function parseWebchatConfigInput(input: unknown): WebchatConnectionConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw validation("Configuración del chat web inválida")
  }
  const raw = input as Record<string, unknown>
  const origins = raw["allowedOrigins"]
  if (!Array.isArray(origins) || origins.length === 0) {
    throw validation("Indica al menos un origen permitido (https://tu-sitio.test)")
  }
  const config: Record<string, unknown> = { allowedOrigins: origins }
  for (const key of ["widgetTitle", "widgetColor", "greeting", "notifyUrl"] as const) {
    const v = raw[key]
    if (v !== undefined && v !== null && v !== "") config[key] = v
  }
  try {
    return assertValidWebchatConfig(config)
  } catch (e) {
    throw validation(e instanceof Error ? e.message : "Configuración del chat web inválida")
  }
}

/** Fila interna con secreto: solo rutas públicas (token) y worker. Nunca a la UI. */
export async function requireWebchatRow(
  db: Db,
  orgId: string,
  connectionId: string,
): Promise<typeof channelConnection.$inferSelect> {
  const [row] = await db
    .select()
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.id, connectionId),
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.provider, WEBCHAT_PROVIDER),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Conexión de chat web")
  return row
}

export async function listWebchatConnections(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
): Promise<WebchatAdminItem[]> {
  const rows = await tx
    .select()
    .from(channelConnection)
    .where(and(eq(channelConnection.organizationId, orgId), eq(channelConnection.provider, WEBCHAT_PROVIDER)))
    .orderBy(asc(channelConnection.createdAt))
  return rows.map((row) => toAdminItem(row, readConfig(row, secretsKey)))
}

export async function getWebchatConnection(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  connectionId: string,
): Promise<WebchatAdminItem> {
  const row = await requireWebchatRow(tx, orgId, connectionId)
  return toAdminItem(row, readConfig(row, secretsKey))
}

export async function createWebchatConnection(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  actorUserId: string | null,
  input: { displayName: string; config: unknown },
  deps: { fetch: typeof fetch },
): Promise<WebchatAdminItem & { webhookSecret: string }> {
  const config = parseWebchatConfigInput(input.config)
  const displayName = input.displayName.trim()
  if (!displayName) throw validation("El nombre de la conexión es obligatorio")
  if (displayName.length > 120) throw validation("El nombre admite hasta 120 caracteres")
  // Cifrado AES-256-GCM uniforme (createConnection): la misma vía que el
  // worker usa al descifrar para media/push. Sin reescrituras en claro.
  // Sin cuenta de proveedor no hay externalId: se omite (null) para no colisionar
  // entre orgs con los mismos orígenes. La validación ya la hizo el parse.
  const created = await createConnection(
    tx,
    orgId,
    secretsKey,
    { channel: WEBCHAT_CHANNEL, provider: WEBCHAT_PROVIDER, displayName, config },
    { fetch: deps.fetch, validateExternal: false },
  )
  const [row] = await tx
    .select()
    .from(channelConnection)
    .where(and(eq(channelConnection.id, created.id), eq(channelConnection.organizationId, orgId)))
    .limit(1)
  if (!row) throw new Error("No se pudo crear la conexión de chat web")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "webchat.created",
    entity: "channel_connection",
    entityId: row.id,
    metadata: { displayName },
  })
  return { ...toAdminItem(row, config), webhookSecret: row.webhookSecret }
}

export async function updateWebchatConnection(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  actorUserId: string | null,
  connectionId: string,
  patch: { displayName?: string; config?: unknown },
): Promise<WebchatAdminItem> {
  const row = await requireWebchatRow(tx, orgId, connectionId)
  const current = readConfig(row, secretsKey)
  const next: Record<string, unknown> = { ...current }
  let displayName = row.displayName
  if (patch.displayName !== undefined) {
    displayName = patch.displayName.trim()
    if (!displayName) throw validation("El nombre de la conexión es obligatorio")
    if (displayName.length > 120) throw validation("El nombre admite hasta 120 caracteres")
  }
  if (patch.config !== undefined) {
    const parsed = parseWebchatConfigInput(patch.config)
    for (const key of Object.keys(next)) delete next[key]
    Object.assign(next, parsed)
  }
  const valid = assertValidWebchatConfig(next)
  const [updated] = await tx
    .update(channelConnection)
    .set({ displayName, configEncrypted: encryptJson(secretsKey, valid), updatedAt: new Date() })
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Conexión de chat web")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "webchat.updated",
    entity: "channel_connection",
    entityId: connectionId,
    metadata: { displayName },
  })
  return toAdminItem(updated, valid)
}

export async function setWebchatConnectionStatus(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  connectionId: string,
  status: "active" | "disabled",
): Promise<WebchatAdminItem> {
  await requireWebchatRow(tx, orgId, connectionId)
  await setConnectionStatus(tx, orgId, connectionId, status)
  const row = await requireWebchatRow(tx, orgId, connectionId)
  return toAdminItem(row, readConfig(row, secretsKey))
}

/** Conexión pública del widget: org por slug + conexión activa del mismo tenant. */
export interface PublicWebchatConnection {
  orgId: string
  orgName: string
  connection: typeof channelConnection.$inferSelect
  config: WebchatConnectionConfig
}

export async function findPublicWebchatConnection(
  db: Db,
  secretsKey: Buffer,
  orgSlug: string,
  connectionId: string,
): Promise<PublicWebchatConnection> {
  const [org] = await db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(eq(organization.slug, orgSlug))
    .limit(1)
  if (!org) throw notFound("Organización")
  const [connection] = await db
    .select()
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.id, connectionId),
        eq(channelConnection.organizationId, org.id),
        eq(channelConnection.provider, WEBCHAT_PROVIDER),
      ),
    )
    .limit(1)
  if (!connection) throw notFound("Chat web no disponible")
  if (connection.status !== "active") {
    throw new ServiceError("WEBCHAT_DISABLED", 409, "El chat web está desactivado")
  }
  return { orgId: org.id, orgName: org.name, connection, config: readConfig(connection, secretsKey) }
}

/** Config pública del widget: solo presentación, nunca orígenes ni secretos. */
export function toWidgetConfig(input: {
  orgName: string
  displayName: string
  config: WebchatConnectionConfig
}): { orgName: string; title: string; color: string; greeting: string | null } {
  return {
    orgName: input.orgName,
    title: input.config.widgetTitle ?? input.displayName,
    color: input.config.widgetColor ?? "#0f766e",
    greeting: input.config.greeting ?? null,
  }
}

/** Emite una sesión de visitante (token con alcance y expiración). */
export function issueWebchatSession(
  connection: typeof channelConnection.$inferSelect,
  ttlMs?: number,
): { sessionId: string; token: string; expiresAt: number } {
  const sessionId = newWebchatSessionId()
  const token = createWebchatToken(connection.webhookSecret, sessionId, ttlMs)
  const verified = verifyWebchatToken(connection.webhookSecret, token)
  if (!verified) throw new Error("No se pudo emitir la sesión del chat")
  return { sessionId, token, expiresAt: verified.expiresAt }
}

/**
 * Límite de ráfaga persistido en DB (multiproceso): cubeta por clave y ventana
 * fija. Upsert atómico: las peticiones concurrentes incrementan sin perderse.
 * Limpia cubetas vencidas de paso (tabla operativa pequeña).
 */
export async function checkWebchatRateLimit(
  db: Db,
  key: string,
  max: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const rows = (await db.execute(sql`
    insert into "webchat_rate_limit" ("key", "window_start", "count")
    values (${key}, now(), 1)
    on conflict ("key") do update set
      "window_start" = case
        when "webchat_rate_limit"."window_start" < now() - (${windowMs}::bigint * interval '1 millisecond')
        then now()
        else "webchat_rate_limit"."window_start"
      end,
      "count" = case
        when "webchat_rate_limit"."window_start" < now() - (${windowMs}::bigint * interval '1 millisecond')
        then 1
        else "webchat_rate_limit"."count" + 1
      end
    returning "count" as "count", "window_start" as "windowStart"
  `)) as unknown as Array<{ count: number; windowStart: Date }>
  const first = rows[0]
  if (!first) throw new Error("No se pudo aplicar el límite del chat web")
  await db
    .delete(webchatRateLimit)
    .where(sql`"window_start" < now() - (${windowMs}::bigint * interval '1 millisecond')`)
    .catch(() => {})
  if (first.count <= max) return { allowed: true, retryAfter: 0 }
  const retryAfter = Math.max(
    1,
    Math.ceil((new Date(first.windowStart).getTime() + windowMs - Date.now()) / 1000),
  )
  return { allowed: false, retryAfter }
}

/**
 * Rota el secreto de la conexión: revoca todas las sesiones de visitante
 * emitidas (sus HMAC dejan de verificar) sin cambiar la config. Expiración
 * natural: 24 h (WEBCHAT_TOKEN_TTL_MS); la rotación es la revocación manual.
 * Desactivar la conexión también invalida de inmediato (el resolve la exige).
 */
export async function rotateWebchatSecret(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  actorUserId: string | null,
  connectionId: string,
): Promise<WebchatAdminItem> {
  const row = await requireWebchatRow(tx, orgId, connectionId)
  const config = readConfig(row, secretsKey)
  const [updated] = await tx
    .update(channelConnection)
    .set({ webhookSecret: randomUUID(), updatedAt: new Date() })
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Conexión de chat web")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "webchat.secret_rotated",
    entity: "channel_connection",
    entityId: connectionId,
    metadata: {},
  })
  return toAdminItem(updated, config)
}

/**
 * Sesión del visitante desde su token. Null = inválida o vencida (la ruta
 * responde 401: ServiceError solo modela 400/404/409 y el 401 va en la ruta).
 */
export function readWebchatSession(
  connection: typeof channelConnection.$inferSelect,
  token: string,
): { sessionId: string; expiresAt: number } | null {
  const verified = verifyWebchatToken(connection.webhookSecret, token)
  if (!verified || !isWebchatSessionId(verified.sessionId)) return null
  return verified
}

export interface WebchatPoll {
  status: "open" | "closed" | null
  items: MessageItem[]
  nextCursor: string | null
  delivered: number
}

/**
 * Lee la conversación de la sesión y marca `sent → delivered` lo que el
 * visitante acaba de recibir. Sin conversación aún: lista vacía (el primer
 * mensaje del visitante la crea vía ingesta).
 */
export async function pollWebchat(
  tx: Db,
  orgId: string,
  connectionId: string,
  sessionId: string,
  input: { before?: string; limit?: number },
): Promise<WebchatPoll> {
  const [conv] = await tx
    .select({ id: conversation.id, status: conversation.status })
    .from(conversation)
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.channelConnectionId, connectionId),
        eq(conversation.externalThreadId, sessionId),
      ),
    )
    .limit(1)
  if (!conv) return { status: null, items: [], nextCursor: null, delivered: 0 }
  const { items, nextCursor } = await listMessages(tx, orgId, conv.id, input)
  let delivered = 0
  if (!input.before) {
    const updated = await tx
      .update(message)
      .set({ status: "delivered" })
      .where(
        and(
          eq(message.conversationId, conv.id),
          eq(message.direction, "out"),
          eq(message.status, "sent"),
        ),
      )
      .returning({ id: message.id })
    delivered = updated.length
    if (delivered > 0) {
      await tx.execute(
        sql`select pg_notify('org_events', ${JSON.stringify({
          orgId,
          kind: "message.updated",
          conversationId: conv.id,
          at: new Date().toISOString(),
        })})`,
      )
    }
  }
  return { status: conv.status === "closed" ? "closed" : "open", items, nextCursor, delivered }
}

/** Mensajes nuevos desde un cursor (ts,id) para el stream SSE del widget. */
export async function listWebchatNew(
  tx: Db,
  orgId: string,
  connectionId: string,
  sessionId: string,
  since: { ts: string; id: string } | null,
  limit = 20,
): Promise<{ status: "open" | "closed" | null; items: WebchatPoll["items"] }> {
  const [conv] = await tx
    .select({ id: conversation.id, status: conversation.status })
    .from(conversation)
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.channelConnectionId, connectionId),
        eq(conversation.externalThreadId, sessionId),
      ),
    )
    .limit(1)
  if (!conv) return { status: null, items: [] }
  const conditions = [eq(message.conversationId, conv.id)]
  if (since) {
    const ts = new Date(since.ts)
    if (!Number.isNaN(ts.getTime())) {
      conditions.push(or(gt(message.createdAt, ts), and(eq(message.createdAt, ts), gt(message.id, since.id)))!)
    }
  }
  const rows = await tx
    .select()
    .from(message)
    .where(and(...conditions))
    .orderBy(asc(message.createdAt), asc(message.id))
    .limit(Math.min(Math.max(limit, 1), 50))
  if (!since) {
    await tx
      .update(message)
      .set({ status: "delivered" })
      .where(and(eq(message.conversationId, conv.id), eq(message.direction, "out"), eq(message.status, "sent")))
  }
  return {
    status: conv.status === "closed" ? "closed" : "open",
    items: rows.map((row) => ({
      id: row.id,
      direction: row.direction,
      senderKind: row.senderKind,
      senderUserId: row.senderUserId,
      contentType: row.contentType,
      body: row.body,
      attachments: row.attachments,
      externalId: row.externalId,
      status: row.status,
      error: row.error,
      templateName: row.templateName,
      templateLanguage: row.templateLanguage,
      templateParams:
        Array.isArray(row.templateParams) &&
        row.templateParams.every((p): p is string => typeof p === "string")
          ? row.templateParams
          : null,
      // El visitante del chat web no recibe mensajes de las líneas del Administrador.
      automatic: null,
      createdAt: row.createdAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null,
    })),
  }
}
