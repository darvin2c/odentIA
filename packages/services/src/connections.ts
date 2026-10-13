import { type ChannelProvider, channelAdapters } from "@odentia/channels"
import type { Db } from "@odentia/db"
import { channelConnection } from "@odentia/db/schema/crm"
import { and, asc, eq } from "drizzle-orm"
import { declareConfigTemplates, listChannelTemplates, syncConnectionTemplates } from "./channel-templates.js"
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
  // Registro parcial (cada slice dueño registra el suyo): sin adaptador no
  // hay validación externa posible; nunca se crea una conexión "activa" ciega.
  if (!adapter) throw validation(`Proveedor desconocido o no registrado: ${provider}`)
  return adapter
}

/** Canal esperado por proveedor conocido; otros proveedores los valida su slice. */
const KNOWN_PROVIDER_CHANNELS: Record<string, string> = {
  whatsapp_cloud_api: "whatsapp",
  telegram_bot_api: "telegram",
  messenger: "messenger",
  instagram: "instagram",
}

function assertChannelMatches(provider: string, channel: string): void {
  const expected = KNOWN_PROVIDER_CHANNELS[provider]
  if (expected && channel !== expected) {
    throw validation(`El proveedor ${provider} exige el canal "${expected}"`)
  }
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
 *
 * Si el canal usa plantillas, deja su catálogo: leído de la cuenta o, sin
 * proveedor, con las que declare la configuración. Si la cuenta no deja
 * leerlas (el token no puede administrar plantillas), la conexión se crea
 * igual y `templatesError` dice qué corregir.
 */
export async function createConnection(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  input: CreateConnectionInput,
  deps: ConnectionDeps,
): Promise<ConnectionPublic & { webhookSecret: string; templatesError?: string }> {
  const adapter = requireAdapter(input.provider)
  assertChannelMatches(input.provider, input.channel)
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
  let templatesError: string | undefined
  if (adapter.capabilities.templates) {
    if (deps.validateExternal === false) {
      await declareConfigTemplates(tx, orgId, created.id, input.config["templates"])
    } else {
      try {
        await syncConnectionTemplates(tx, orgId, created.id, secretsKey, { fetch: deps.fetch })
      } catch (error) {
        templatesError = error instanceof Error ? error.message : "No se pudieron leer las plantillas"
      }
    }
  }
  return {
    ...toPublic(created),
    webhookSecret: created.webhookSecret,
    ...(templatesError ? { templatesError } : {}),
  }
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


/**
 * Plantillas que la conexión puede enviar hoy: las aprobadas del catálogo, con
 * su texto y cuántos datos llevan. Las demás (en revisión, rechazadas,
 * pausadas) se ven en `listChannelTemplates`, no aquí.
 */
export async function getConnectionTemplates(
  tx: Db,
  orgId: string,
  id: string,
  _secretsKey?: Buffer,
): Promise<{ name: string; language: string; body: string; variables: number; buttons: string[] }[]> {
  const templates = await listChannelTemplates(tx, orgId, id)
  return templates
    .filter((template) => template.status === "aprobada")
    .map(({ name, language, body, variables, buttons }) => ({ name, language, body, variables, buttons }))
}
