import { type ChannelProvider, channelAdapters } from "@odentia/channels"
import type { Db } from "@odentia/db"
import { channelConnection } from "@odentia/db/schema/crm"
import { and, asc, eq } from "drizzle-orm"
import { notFound, validation } from "./errors.js"
import { decryptConfig, encryptJson } from "./secrets.js"

export interface ConnectionPublic {
  id: string
  channel: string
  provider: string
  displayName: string
  externalId: string | null
  status: string
  createdAt: string
  updatedAt: string
}

function toPublic(row: typeof channelConnection.$inferSelect): ConnectionPublic {
  return {
    id: row.id,
    channel: row.channel,
    provider: row.provider,
    displayName: row.displayName,
    externalId: row.externalId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function requireAdapter(provider: string) {
  const adapter = channelAdapters[provider as ChannelProvider]
  if (!adapter) throw validation(`Proveedor desconocido: ${provider}`)
  return adapter
}

export async function listConnections(tx: Db, orgId: string): Promise<ConnectionPublic[]> {
  const rows = await tx
    .select()
    .from(channelConnection)
    .where(eq(channelConnection.organizationId, orgId))
    .orderBy(asc(channelConnection.createdAt))
  return rows.map(toPublic)
}

export interface CreateConnectionInput {
  channel: string
  provider: string
  displayName: string
  config: Record<string, unknown>
}

export interface ConnectionDeps {
  fetch: typeof fetch
  /** false en dev/e2e para no llamar al proveedor. */
  validateExternal?: boolean
}

/**
 * Crea la conexión: valida contra el proveedor (salvo validateExternal=false),
 * cifra la config y genera el webhookSecret. Nunca devuelve secretos.
 */
export async function createConnection(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  input: CreateConnectionInput,
  deps: ConnectionDeps,
): Promise<ConnectionPublic & { webhookSecret: string }> {
  const adapter = requireAdapter(input.provider)
  const displayName = input.displayName.trim()
  if (!displayName) throw validation("El nombre de la conexión es obligatorio")
  if (!input.config || typeof input.config !== "object") throw validation("Config inválida")
  let externalId: string | null = null
  if (deps.validateExternal !== false) {
    const checked = await adapter.validateConnection(input.config, { fetch: deps.fetch })
    externalId = checked.externalId
  }
  const [created] = await tx
    .insert(channelConnection)
    .values({
      organizationId: orgId,
      channel: input.channel,
      provider: input.provider,
      displayName,
      externalId,
      configEncrypted: encryptJson(secretsKey, input.config),
      webhookSecret: crypto.randomUUID(),
      status: "active",
    })
    .returning()
  if (!created) throw new Error("No se pudo crear la conexión")
  return { ...toPublic(created), webhookSecret: created.webhookSecret }
}

/** Conexión con config descifrada: solo worker/webhooks (nunca a la UI). */
export async function getConnectionSecrets(
  tx: Db,
  orgId: string,
  id: string,
  secretsKey: Buffer,
): Promise<{ row: typeof channelConnection.$inferSelect; config: Record<string, unknown> }> {
  const [row] = await tx
    .select()
    .from(channelConnection)
    .where(and(eq(channelConnection.id, id), eq(channelConnection.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conexión")
  return { row, config: decryptConfig(secretsKey, row.configEncrypted) }
}

export async function setConnectionStatus(
  tx: Db,
  orgId: string,
  id: string,
  status: "active" | "disabled",
): Promise<ConnectionPublic> {
  const [updated] = await tx
    .update(channelConnection)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(channelConnection.id, id), eq(channelConnection.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Conexión")
  return toPublic(updated)
}

/** Re-valida contra el proveedor y refresca externalId/displayName. */
export async function testConnection(
  tx: Db,
  orgId: string,
  id: string,
  secretsKey: Buffer,
  deps: ConnectionDeps,
): Promise<ConnectionPublic> {
  const { row, config } = await getConnectionSecrets(tx, orgId, id, secretsKey)
  const adapter = requireAdapter(row.provider)
  const checked = await adapter.validateConnection(config, { fetch: deps.fetch })
  const [updated] = await tx
    .update(channelConnection)
    .set({
      externalId: checked.externalId,
      displayName: checked.displayName,
      status: "active",
      updatedAt: new Date(),
    })
    .where(and(eq(channelConnection.id, id), eq(channelConnection.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Conexión")
  return toPublic(updated)
}

/** Persiste el offset de polling (modo dev Telegram). */
export async function savePollingOffset(
  tx: Db,
  orgId: string,
  id: string,
  offset: string,
): Promise<void> {
  const updated = await tx
    .update(channelConnection)
    .set({ pollingOffset: offset, updatedAt: new Date() })
    .where(and(eq(channelConnection.id, id), eq(channelConnection.organizationId, orgId)))
    .returning({ id: channelConnection.id })
  if (updated.length === 0) throw notFound("Conexión")
}

/** Plantillas autorizadas de la conexión (nombres, sin secretos). */
export async function getConnectionTemplates(
  tx: Db,
  orgId: string,
  id: string,
  secretsKey: Buffer,
): Promise<{ name: string; language: string }[]> {
  const { config } = await getConnectionSecrets(tx, orgId, id, secretsKey)
  const raw = config["templates"]
  if (!Array.isArray(raw)) return []
  const out: { name: string; language: string }[] = []
  for (const t of raw) {
    if (
      t &&
      typeof t === "object" &&
      "name" in t &&
      typeof t.name === "string" &&
      "language" in t &&
      typeof t.language === "string"
    ) {
      out.push({ name: t.name, language: t.language })
    }
  }
  return out
}
