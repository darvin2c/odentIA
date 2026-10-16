// Buzones de correo de la organización (Gmail / Microsoft 365): OAuth con
// state firmado + verifier PKCE en servidor, tokens cifrados en reposo y
// conexión como channel_connection (channel "email").
// Sin credenciales del proveedor en env: el prestador queda deshabilitado
// explícito, nunca simulado.
import {
  buildGmailAuthUrl,
  buildMicrosoftAuthUrl,
  exchangeGmailCode,
  exchangeMicrosoftCode,
  getGmailProfile,
  getMicrosoftProfile,
  GmailAuthError,
  MicrosoftAuthError,
  refreshGmailAccessToken,
  refreshMicrosoftAccessToken,
  revokeGmailToken,
  sha256B64Url,
} from "@odentia/channels"
import type { Db } from "@odentia/db"
import { channelConnection } from "@odentia/db/schema/crm"
import { mailboxOauthState } from "@odentia/db/schema/mailbox"
import { member } from "@odentia/db/schema/auth"
import { auditEvent } from "@odentia/db/schema/org"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import { decryptConfig, encryptJson } from "./secrets.js"
// Conectar o desconectar un buzón no avisa en la campana: lo hace quien lo ve
// en su pantalla, y la campana no avisa a nadie de lo que hizo (ADR 0025).

export const MAILBOX_CHANNEL = "email"

export type MailboxProvider = "gmail" | "microsoft365"

export const MAILBOX_PROVIDERS: { provider: MailboxProvider; label: string }[] = [
  { provider: "gmail", label: "Gmail" },
  { provider: "microsoft365", label: "Microsoft 365" },
]

export interface MailboxOAuthClient {
  clientId: string
  clientSecret: string
  redirectUri: string
  /** Solo Microsoft: tenant ("common" por defecto). */
  tenant?: string
}

export interface MailboxEnv {
  gmail?: MailboxOAuthClient
  microsoft365?: MailboxOAuthClient
}

export interface MailboxDeps {
  fetch: typeof fetch
}

function parseProvider(raw: string): MailboxProvider {
  if (raw === "gmail" || raw === "microsoft365") return raw
  throw validation("Proveedor de correo inválido: solo gmail o microsoft365")
}

/** Cliente OAuth o null si el env externo no está configurado (deshabilita sin mock). */
function oauthClient(env: MailboxEnv, provider: MailboxProvider): MailboxOAuthClient | null {
  const client = env[provider]
  if (!client?.clientId || !client.clientSecret || !client.redirectUri) return null
  return client
}

function requireOAuthClient(env: MailboxEnv, provider: MailboxProvider): MailboxOAuthClient {
  const client = oauthClient(env, provider)
  if (!client) {
    const vars =
      provider === "gmail"
        ? "GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET/GMAIL_REDIRECT_URI"
        : "MICROSOFT_MAIL_CLIENT_ID/MICROSOFT_MAIL_CLIENT_SECRET/MICROSOFT_MAIL_REDIRECT_URI"
    throw new ServiceError(
      "MAILBOX_NOT_CONFIGURED",
      503,
      `Correo ${provider} no configurado en este entorno (falta ${vars}): la conexión queda deshabilitada`,
    )
  }
  return client
}

export function mailboxProviderStatus(env: MailboxEnv): {
  provider: MailboxProvider
  label: string
  channel: string
  configured: boolean
}[] {
  return MAILBOX_PROVIDERS.map(({ provider, label }) => ({
    provider,
    label,
    channel: MAILBOX_CHANNEL,
    configured: oauthClient(env, provider) !== null,
  }))
}

/* ------------------------- State firmado + PKCE ------------------------- */

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

function hmacHex(secretsKey: Buffer, nonce: string): string {
  return createHmac("sha256", secretsKey).update(`mailbox-oauth:${nonce}`, "utf8").digest("hex")
}

/** `state` que viaja al proveedor: nonce pública + firma HMAC (verificable sin sesión). */
export function buildOauthStateParam(secretsKey: Buffer, nonce: string): string {
  return `${Buffer.from(nonce, "utf8").toString("base64url")}.${hmacHex(secretsKey, nonce)}`
}

/** Nonce si la firma es válida; null si el state fue forjado o manipulado. */
export function parseOauthStateParam(secretsKey: Buffer, state: string): string | null {
  const dot = state.lastIndexOf(".")
  if (dot <= 0) return null
  let nonce: string
  try {
    nonce = Buffer.from(state.slice(0, dot), "base64url").toString("utf8")
  } catch {
    return null
  }
  if (!nonce || nonce.length > 128) return null
  const expected = hmacHex(secretsKey, nonce)
  const given = state.slice(dot + 1)
  if (expected.length !== given.length) return null
  try {
    if (!timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given, "utf8"))) return null
  } catch {
    return null
  }
  return nonce
}

/** Verifier PKCE (86 caracteres): alta entropía, solo servidor. */
export function newCodeVerifier(): string {
  return randomBytes(64).toString("base64url")
}

/* ------------------------- Inicio OAuth ------------------------- */

export interface MailboxOAuthStart {
  url: string
  expiresAt: string
}

/**
 * Inicia OAuth: persiste nonce + verifier (10 min, vinculado usuario/org) y
 * devuelve la URL del proveedor. Requiere env configurado o 503 explícito.
 */
export async function beginMailboxOAuth(
  tx: Db,
  orgId: string,
  userId: string,
  secretsKey: Buffer,
  env: MailboxEnv,
  providerRaw: string,
): Promise<MailboxOAuthStart> {
  const provider = parseProvider(providerRaw)
  const client = requireOAuthClient(env, provider)
  const nonce = randomBytes(32).toString("hex")
  const verifier = newCodeVerifier()
  const challenge = await sha256B64Url(verifier)
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS)
  await tx.insert(mailboxOauthState).values({
    nonce,
    organizationId: orgId,
    userId,
    provider,
    codeVerifier: verifier,
    redirectUri: client.redirectUri,
    expiresAt,
  })
  const state = buildOauthStateParam(secretsKey, nonce)
  const url =
    provider === "gmail"
      ? buildGmailAuthUrl(client, { state, codeChallenge: challenge })
      : buildMicrosoftAuthUrl(client, { state, codeChallenge: challenge })
  return { url, expiresAt: expiresAt.toISOString() }
}

/* ------------------------- Callback OAuth ------------------------- */

export interface MailboxOAuthComplete {
  connectionId: string
  provider: MailboxProvider
  emailAddress: string
  /** true si el buzón ya existía y solo se refrescaron sus tokens. */
  reconnected: boolean
}

async function requireMembership(ownerDb: Db, orgId: string, userId: string): Promise<void> {
  const [row] = await ownerDb
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  if (!row) throw new ServiceError("FORBIDDEN", 403, "No eres miembro de esta organización")
}

/** Guarda de frontera: violación de unicidad Postgres (p. ej. buzón en otra org). */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  return "code" in error && error.code === "23505"
}

async function auditMailbox(
  tx: Db,
  orgId: string,
  userId: string,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: userId,
    action,
    entity: "channel_connection",
    entityId,
    metadata,
  })
}

/**
 * Completa OAuth: verifica firma del state, consume el nonce (un solo uso),
 * intercambia el code con PKCE y crea o reconecta el channel_connection.
 * ownerDb = rol owner (lectura del nonce y membresía sin contexto de org);
 * withOrgContext = inserción RLS de la conexión.
 */
export async function completeMailboxOAuth(
  ownerDb: Db,
  withOrgContext: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>,
  secretsKey: Buffer,
  env: MailboxEnv,
  deps: MailboxDeps,
  input: { state: string; code: string; userId: string },
): Promise<MailboxOAuthComplete> {
  const nonce = parseOauthStateParam(secretsKey, input.state)
  if (!nonce) throw new ServiceError("FORBIDDEN", 403, "Estado OAuth inválido o manipulado")
  const [pending] = await ownerDb
    .select()
    .from(mailboxOauthState)
    .where(eq(mailboxOauthState.nonce, nonce))
    .limit(1)
  // Consumir primero: el code del proveedor es de un solo uso y el reintento
  // legítimo reinicia el flujo; así un callback repetido nunca reutiliza nada.
  if (pending) {
    await ownerDb.delete(mailboxOauthState).where(eq(mailboxOauthState.nonce, nonce))
  }
  if (!pending) throw new ServiceError("FORBIDDEN", 403, "Flujo OAuth caducado o ya usado")
  if (pending.expiresAt.getTime() < Date.now()) {
    throw new ServiceError("FORBIDDEN", 403, "Flujo OAuth caducado: reinicia la conexión")
  }
  if (pending.userId !== input.userId) {
    throw new ServiceError("FORBIDDEN", 403, "El flujo OAuth pertenece a otro usuario")
  }
  const provider = parseProvider(pending.provider)
  const client = requireOAuthClient(env, provider)
  await requireMembership(ownerDb, pending.organizationId, input.userId)
  const tokens =
    provider === "gmail"
      ? await exchangeGmailCode(client, { code: input.code, codeVerifier: pending.codeVerifier }, deps)
      : await exchangeMicrosoftCode(
          client,
          { code: input.code, codeVerifier: pending.codeVerifier },
          deps,
        )
  if (!tokens.refreshToken) {
    throw new ServiceError(
      "OAUTH_NO_REFRESH",
      502,
      "El proveedor no devolvió refresh token: reintenta la conexión aceptando acceso permanente",
    )
  }
  // Ambos perfiles exponen emailAddress: sin casts, acceso directo tipado.
  const profile =
    provider === "gmail"
      ? await getGmailProfile(tokens.accessToken, deps)
      : await getMicrosoftProfile(tokens.accessToken, deps)
  const emailAddress = profile.emailAddress
  const sealed = (accessToken: string): string =>
    encryptJson(secretsKey, {
      refreshToken: tokens.refreshToken,
      emailAddress,
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
    })
  return withOrgContext(pending.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(channelConnection)
      .where(
        and(
          eq(channelConnection.organizationId, pending.organizationId),
          eq(channelConnection.provider, provider),
          eq(channelConnection.externalId, emailAddress),
        ),
      )
      .limit(1)
    if (existing) {
      await tx
        .update(channelConnection)
        .set({ configEncrypted: sealed(tokens.accessToken), status: "active", updatedAt: new Date() })
        .where(eq(channelConnection.id, existing.id))
      await auditMailbox(tx, pending.organizationId, input.userId, "mailbox.reconnected", existing.id, {
        provider,
        emailAddress,
      })
      return { connectionId: existing.id, provider, emailAddress, reconnected: true }
    }
    let created: { id: string } | undefined
    try {
      const rows = await tx
        .insert(channelConnection)
        .values({
          organizationId: pending.organizationId,
          channel: MAILBOX_CHANNEL,
          provider,
          displayName: emailAddress,
          externalId: emailAddress,
          configEncrypted: sealed(tokens.accessToken),
          webhookSecret: crypto.randomUUID(),
          status: "active",
        })
        .returning({ id: channelConnection.id })
      created = rows[0]
    } catch (error) {
      // unique (provider, external_id) global: el buzón vive en otra org.
      if (isUniqueViolation(error)) {
        throw new ServiceError(
          "MAILBOX_TAKEN",
          409,
          "Este buzón ya está conectado en otra organización",
        )
      }
      throw error
    }
    if (!created) throw new Error("No se pudo crear la conexión de correo")
    await auditMailbox(tx, pending.organizationId, input.userId, "mailbox.connected", created.id, {
      provider,
      emailAddress,
    })
    return { connectionId: created.id, provider, emailAddress, reconnected: false }
  })
}

/* ------------------------- Lectura de estado ------------------------- */

export interface MailboxConnectionItem {
  id: string
  provider: MailboxProvider
  email: string | null
  displayName: string
  status: string
  /** true si ya sincronizó al menos una vez (cursor persistido). */
  synced: boolean
  createdAt: string
  updatedAt: string
}

export async function listMailboxConnections(
  tx: Db,
  orgId: string,
): Promise<MailboxConnectionItem[]> {
  const rows = await tx
    .select()
    .from(channelConnection)
    .where(
      and(eq(channelConnection.organizationId, orgId), eq(channelConnection.channel, MAILBOX_CHANNEL)),
    )
  return rows.map((row) => ({
    id: row.id,
    provider: parseProvider(row.provider),
    email: row.externalId,
    displayName: row.displayName,
    status: row.status,
    synced: row.pollingOffset !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }))
}

/* ------------------------- Refresh de tokens ------------------------- */

export interface MailboxTokenRefresh {
  accessToken: string
  /** Config lista para re-cifrar si el token rotó (null = sin cambios). */
  nextConfig: Record<string, unknown> | null
}

function isTokenFresh(config: Record<string, unknown>): string | null {
  const accessToken = config["accessToken"]
  const expiresAt = config["accessTokenExpiresAt"]
  if (typeof accessToken !== "string" || accessToken.length === 0) return null
  if (typeof expiresAt === "string") {
    const exp = new Date(expiresAt).getTime()
    if (Number.isFinite(exp) && exp - Date.now() > 5 * 60 * 1000) return accessToken
    if (Number.isFinite(exp)) return null
  }
  return accessToken
}

/**
 * Access token vigente para el worker: reutiliza el cacheado si le quedan
 * más de 5 min; si no, refresca con el refresh cifrado. Lanza
 * GmailAuthError/MicrosoftAuthError si el consentimiento se revocó (el worker
 * desactiva el buzón y avisa en ese caso).
 */
export async function ensureMailboxAccessToken(
  config: Record<string, unknown>,
  provider: MailboxProvider,
  client: MailboxOAuthClient,
  deps: MailboxDeps,
): Promise<MailboxTokenRefresh> {
  const fresh = isTokenFresh(config)
  if (fresh) return { accessToken: fresh, nextConfig: null }
  const refreshToken = config["refreshToken"]
  const emailAddress = config["emailAddress"]
  if (typeof refreshToken !== "string" || typeof emailAddress !== "string") {
    throw new ServiceError("MAILBOX_NO_TOKEN", 409, "Buzón sin tokens: reconecta el correo")
  }
  if (provider === "gmail") {
    const { accessToken, expiresIn } = await refreshGmailAccessToken(
      client,
      refreshToken,
      deps,
    )
    return {
      accessToken,
      nextConfig: {
        ...config,
        accessToken,
        accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      },
    }
  }
  const rotated = await refreshMicrosoftAccessToken(client, refreshToken, deps)
  return {
    accessToken: rotated.accessToken,
    nextConfig: {
      ...config,
      refreshToken: rotated.refreshToken ?? refreshToken,
      accessToken: rotated.accessToken,
      accessTokenExpiresAt: new Date(Date.now() + rotated.expiresIn * 1000).toISOString(),
    },
  }
}

export function isMailboxAuthError(error: unknown): boolean {
  return error instanceof GmailAuthError || error instanceof MicrosoftAuthError
}

/* ------------------------- Probar y desconectar ------------------------- */

/** Revalida contra el proveedor con un token fresco y persiste el cache. */
export async function testMailboxConnection(
  tx: Db,
  orgId: string,
  id: string,
  secretsKey: Buffer,
  client: MailboxOAuthClient,
  deps: MailboxDeps,
): Promise<{ emailAddress: string; displayName: string }> {
  const [row] = await tx
    .select()
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.id, id),
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, MAILBOX_CHANNEL),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Conexión de correo")
  const provider = parseProvider(row.provider)
  const config = decryptConfig(secretsKey, row.configEncrypted)
  const { accessToken, nextConfig } = await ensureMailboxAccessToken(config, provider, client, deps)
  // Ambos perfiles exponen emailAddress: sin casts, acceso directo tipado.
  const profile =
    provider === "gmail"
      ? await getGmailProfile(accessToken, deps)
      : await getMicrosoftProfile(accessToken, deps)
  const emailAddress = profile.emailAddress
  await tx
    .update(channelConnection)
    .set({
      externalId: emailAddress,
      displayName: emailAddress,
      ...(nextConfig ? { configEncrypted: encryptJson(secretsKey, nextConfig) } : {}),
      status: "active",
      updatedAt: new Date(),
    })
    .where(eq(channelConnection.id, id))
  return { emailAddress, displayName: emailAddress }
}

export interface MailboxDisconnect {
  provider: MailboxProvider
  emailAddress: string | null
  /** true si el proveedor confirmó (o ya había invalidado) la revocación. */
  revoked: boolean
}

/**
 * Desconecta: revoca en el proveedor cuando existe endpoint (Gmail) y borra
 * la fila con sus tokens. Microsoft no expone revocación delegada: borrar es
 * la desconexión (documentado en la UI).
 */
export async function disconnectMailbox(
  tx: Db,
  orgId: string,
  id: string,
  userId: string,
  secretsKey: Buffer,
  deps: MailboxDeps,
): Promise<MailboxDisconnect> {
  const [row] = await tx
    .select()
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.id, id),
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, MAILBOX_CHANNEL),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Conexión de correo")
  const provider = parseProvider(row.provider)
  let revoked = provider !== "gmail"
  try {
    const config = decryptConfig(secretsKey, row.configEncrypted)
    if (provider === "gmail" && typeof config["refreshToken"] === "string") {
      revoked = await revokeGmailToken(config["refreshToken"], deps)
    }
  } catch {
    // Sin config legible no hay nada que revocar: igual se borra la fila.
    revoked = false
  }
  await tx.delete(channelConnection).where(eq(channelConnection.id, id))
  await auditMailbox(tx, orgId, userId, "mailbox.disconnected", id, {
    provider,
    emailAddress: row.externalId,
    revoked,
  })
  return { provider, emailAddress: row.externalId, revoked }
}
