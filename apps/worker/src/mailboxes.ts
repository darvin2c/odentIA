// Sondeo durable de buzones (Gmail / Microsoft 365): cada tick refresca el
// token, lee cambios desde el cursor persistido e ingiere a la bandeja.
// Reglas: el cursor (pollingOffset) avanza SOLO en la misma transacción donde
// los inbound quedan encolados; dedupe por inbound_event antes de encolar;
// el primer sondeo solo fija el checkpoint (no importa historial); ante
// consentimiento revocado se desactiva el buzón y se avisa al usuario.
// No crea pools: usa el db/ownerDb compartidos del worker (los pasa el padre).
import {
  GmailResyncRequired,
  MicrosoftResyncRequired,
  type NormalizedInbound,
  pollGmailMailbox,
  pollMicrosoftMailbox,
} from "@odentia/channels"
import { type Db, sendInboundMessage, withOrgContext } from "@odentia/db"
import { channelConnection, inboundEvent } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import {
  decryptConfig,
  encryptJson,
  ensureMailboxAccessToken,
  isMailboxAuthError,
  type MailboxOAuthClient,
  type MailboxProvider,
} from "@odentia/services"
import { and, eq, inArray } from "drizzle-orm"

export interface MailboxTickDeps {
  /** Rol app compartido del worker (RLS por withOrgContext). */
  db: Db
  /** Rol owner compartido del worker (lista de conexiones sin org). */
  ownerDb: Db
  secretsKey: Buffer
  fetch: typeof fetch
  /** Ausente = proveedor deshabilitado (se omite, nunca simulado). */
  gmail?: MailboxOAuthClient
  microsoft365?: MailboxOAuthClient
}

export interface MailboxTickResult {
  polled: number
  ingested: number
  disabled: string[]
}

export const MAILBOX_TICK_DEFAULT_INTERVAL_MS = 60_000

const PROVIDERS = ["gmail", "microsoft365"] as const

function clientOf(deps: MailboxTickDeps, provider: MailboxProvider): MailboxOAuthClient | null {
  const client = deps[provider]
  if (!client?.clientId || !client.clientSecret || !client.redirectUri) return null
  return client
}

// Sin destinatario conocido en el worker: la desactivación queda en auditoría
// y en el estado visible en Correo (el aviso dirigido lo emite la API, donde
// sí hay usuario actuante). Sin PII en el log: solo ids y motivo.
async function disableRevoked(
  tx: Db,
  orgId: string,
  connectionId: string,
  detail: string,
): Promise<void> {
  await tx
    .update(channelConnection)
    .set({ status: "disabled", updatedAt: new Date() })
    .where(eq(channelConnection.id, connectionId))
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: null,
    action: "mailbox.disabled",
    entity: "channel_connection",
    entityId: connectionId,
    metadata: { reason: "auth-revocada", detail: detail.slice(0, 200) },
  })
}

async function pollOne(
  deps: MailboxTickDeps,
  row: { id: string; organizationId: string; provider: string },
): Promise<{ ingested: number; disabled: boolean }> {
  const provider = row.provider as MailboxProvider
  if (provider !== "gmail" && provider !== "microsoft365") return { ingested: 0, disabled: false }
  const client = clientOf(deps, provider)
  if (!client) {
    console.error(`mailboxes: proveedor ${provider} sin configurar, se omite ${row.id}`)
    return { ingested: 0, disabled: false }
  }
  const orgId = row.organizationId
  const connectionId = row.id
  let ingested = 0
  let disabled = false
  await withOrgContext(deps.db, orgId, async (tx) => {
    const [conn] = await tx
      .select()
      .from(channelConnection)
      .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
      .limit(1)
    if (!conn || conn.status !== "active") return
    let config: Record<string, unknown>
    try {
      config = decryptConfig(deps.secretsKey, conn.configEncrypted)
    } catch {
      console.error(`mailboxes: config ilegible en ${connectionId}, se omite`)
      return
    }
    let accessToken: string
    try {
      const refreshed = await ensureMailboxAccessToken(config, provider, client, {
        fetch: deps.fetch,
      })
      accessToken = refreshed.accessToken
      if (refreshed.nextConfig) {
        await tx
          .update(channelConnection)
          .set({ configEncrypted: encryptJson(deps.secretsKey, refreshed.nextConfig) })
          .where(eq(channelConnection.id, connectionId))
      }
    } catch (error) {
      if (isMailboxAuthError(error)) {
        await disableRevoked(tx, orgId, connectionId, error instanceof Error ? error.message : "")
        disabled = true
        return
      }
      throw error
    }
    const firstSync = conn.pollingOffset === null
    const poll = async (
      cursor: string | null,
    ): Promise<{ events: NormalizedInbound[]; nextCursor: string }> =>
      provider === "gmail"
        ? pollGmailMailbox(
            { accessToken, emailAddress: String(config["emailAddress"] ?? ""), cursor },
            { fetch: deps.fetch },
          )
        : pollMicrosoftMailbox(
            { accessToken, emailAddress: String(config["emailAddress"] ?? ""), cursor },
            { fetch: deps.fetch },
          )
    let result: { events: NormalizedInbound[]; nextCursor: string }
    try {
      result = await poll(conn.pollingOffset)
    } catch (error) {
      if (error instanceof GmailResyncRequired || error instanceof MicrosoftResyncRequired) {
        result = await poll(null)
      } else {
        throw error
      }
    }
    // Primer sondeo: solo fija el checkpoint, no importa historial.
    const toIngest = firstSync ? [] : result.events
    for (const event of toIngest) {
      const inserted = await tx
        .insert(inboundEvent)
        .values({ provider, externalEventId: event.externalEventId })
        .onConflictDoNothing()
        .returning({ id: inboundEvent.id })
      if (inserted.length === 0) continue
      await sendInboundMessage(tx, { orgId, connectionId, event })
      ingested += 1
    }
    await tx
      .update(channelConnection)
      .set({ pollingOffset: result.nextCursor, updatedAt: new Date() })
      .where(eq(channelConnection.id, connectionId))
  }).catch(async (error: unknown) => {
    if (isMailboxAuthError(error)) {
      await withOrgContext(deps.db, orgId, (tx) =>
        disableRevoked(tx, orgId, connectionId, error instanceof Error ? error.message : ""),
      ).catch(() => {})
      disabled = true
      return
    }
    throw error
  })
  return { ingested, disabled }
}

/**
 * Un tick de buzones: recorre conexiones email activas y sondea cada una.
 * Los fallos por buzón se aíslan (log sin secretos) y no tumban el tick.
 * El padre lo agenda cada MAILBOX_POLL_INTERVAL_MS en el loop del worker.
 */
export async function tickMailboxes(deps: MailboxTickDeps): Promise<MailboxTickResult> {
  const rows = await deps.ownerDb
    .select({
      id: channelConnection.id,
      organizationId: channelConnection.organizationId,
      provider: channelConnection.provider,
    })
    .from(channelConnection)
    .where(
      and(eq(channelConnection.channel, "email"), eq(channelConnection.status, "active"), inArray(
        channelConnection.provider,
        [...PROVIDERS],
      )),
    )
  let ingested = 0
  let polled = 0
  const disabled: string[] = []
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const got = await pollOne(deps, row)
      polled += 1
      ingested += got.ingested
      if (got.disabled) disabled.push(row.id)
    } catch (error) {
      console.error(
        `mailboxes: sondeo falló para ${row.id}`,
        error instanceof Error ? error.message : error,
      )
    }
  }
  return { polled, ingested, disabled }
}
