import { normalizeTags } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { patient, patientContact, patientRegistrationLink } from "@odentia/db/schema/clinical"
import {
  channelConnection,
  contact,
  contactIdentity,
  conversation,
  crmTask,
  customFieldDef,
} from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm"
import { decodeCursor } from "./cursors.js"
import { notFound, ServiceError, validation } from "./errors.js"

/** Normaliza etiquetas con el helper canónico; convierte Error a ServiceError validation. */
export function normalizeContactTags(tags: readonly string[]): string[] {
  try {
    return normalizeTags(tags)
  } catch (e) {
    throw validation(e instanceof Error ? e.message : "Etiquetas inválidas")
  }
}

export interface ContactListItem {
  id: string
  displayName: string
  phone: string | null
  email: string | null
  isActive: boolean
  tags: string[]
  assignedUserId: string | null
  lastInteractionAt: string | null
  channels: string[]
}

export interface ContactDetail extends ContactListItem {
  notes: string | null
  customFields: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null
}

function toListItem(row: typeof contact.$inferSelect, channels: string[]): ContactListItem {
  return {
    id: row.id,
    displayName: row.displayName,
    phone: row.phone,
    email: row.email,
    isActive: row.isActive,
    tags: row.tags,
    assignedUserId: row.assignedUserId,
    lastInteractionAt: iso(row.lastInteractionAt),
    channels,
  }
}
const PAGE_DEFAULT = 30

export interface ContactListFilters {
  q?: string
  /** true = solo activos (default), false = solo archivados, "all" = todos. */
  isActive?: boolean | "all"
  cursor?: string
  limit?: number
}

/** Huella de filtros: el cursor solo es válido con los mismos parámetros. */
function listingFingerprint(input: { q: string; isActive: boolean | "all" }): string {
  return JSON.stringify({ q: input.q, isActive: input.isActive })
}

function encodeListingCursor(ts: string, id: string, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ ts, id, f: fingerprint }), "utf8").toString("base64url")
}

function decodeListingCursor(cursor: string): { ts: string; id: string; f: string } | null {
  const base = decodeCursor(cursor)
  if (!base) return null
  try {
    const raw: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (!raw || typeof raw !== "object" || !("f" in raw)) return null
    const f: unknown = raw.f
    if (typeof f !== "string") return null
    return { ts: base.ts, id: base.id, f }
  } catch {
    return null
  }
}

export async function listContacts(
  tx: Db,
  orgId: string,
  input: ContactListFilters,
): Promise<{ items: ContactListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? PAGE_DEFAULT, 1), 100)
  const q = input.q?.trim() ? input.q.trim() : ""
  const active = input.isActive ?? true
  const fingerprint = listingFingerprint({ q, isActive: active })
  const conditions = [eq(contact.organizationId, orgId)]
  if (q) {
    const like = `%${q}%`
    conditions.push(
      or(
        ilike(contact.displayName, like),
        ilike(contact.phone, like),
        ilike(contact.email, like),
      )!,
    )
  }
  if (active !== "all") conditions.push(eq(contact.isActive, active))
  if (input.cursor) {
    const decoded = decodeListingCursor(input.cursor)
    if (!decoded || !/^[0-9a-f-]{36}$/i.test(decoded.id)) throw validation("Cursor inválido")
    if (decoded.f !== fingerprint)
      throw validation("El cursor no corresponde a los filtros actuales")
    if (decoded.ts === "") {
      // Cola de nulos (NULLS LAST): paginar solo por id.
      conditions.push(sql`"last_interaction_at" is null`)
      conditions.push(lt(contact.id, decoded.id))
    } else {
      const ts = new Date(decoded.ts)
      if (Number.isNaN(ts.getTime())) throw validation("Cursor inválido")
      conditions.push(
        or(
          lt(contact.lastInteractionAt, ts),
          and(eq(contact.lastInteractionAt, ts), lt(contact.id, decoded.id)),
          sql`"last_interaction_at" is null`,
        )!,
      )
    }
  }
  const rows = await tx
    .select()
    .from(contact)
    .where(and(...conditions))
    .orderBy(sql`"last_interaction_at" desc nulls last`, desc(contact.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const identities = page.length
    ? await tx
        .select()
        .from(contactIdentity)
        .where(
          and(
            eq(contactIdentity.organizationId, orgId),
            sql`"contact_id" in (${sql.join(
              page.map((r) => sql`${r.id}::uuid`),
              sql`, `,
            )})`,
          ),
        )
    : []
  const byContact = new Map<string, string[]>()
  for (const ident of identities) {
    const list = byContact.get(ident.contactId) ?? []
    if (!list.includes(ident.channel)) list.push(ident.channel)
    byContact.set(ident.contactId, list)
  }
  const items = page.map((r) => toListItem(r, byContact.get(r.id) ?? []))
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > limit && last
      ? encodeListingCursor(last.lastInteractionAt?.toISOString() ?? "", last.id, fingerprint)
      : null
  return { items, nextCursor }
}

export interface ContactPatientLink {
  id: string
  patientNumber: number
  displayName: string
  isActive: boolean
  relationship: string
  relationshipDetail: string | null
  isPreferred: boolean
}

export interface ContactConversationItem {
  id: string
  status: string
  channel: string
  connectionId: string
  connectionName: string
  contactIdentityId: string | null
  lastMessageAt: string | null
}

export interface ContactFull {
  contact: ContactDetail
  patients: ContactPatientLink[]
  identities: { id: string; channel: string; externalUserId: string; displayName: string | null }[]
  openTasks: { id: string; title: string; dueAt: string | null; assigneeUserId: string | null }[]
  conversations: ContactConversationItem[]
}

export async function getContact(tx: Db, orgId: string, id: string): Promise<ContactFull> {
  const row = await requireContact(tx, orgId, id)
  const [identities, tasks, conversations, links] = await Promise.all([
    tx
      .select()
      .from(contactIdentity)
      .where(and(eq(contactIdentity.organizationId, orgId), eq(contactIdentity.contactId, id))),
    tx
      .select()
      .from(crmTask)
      .where(
        and(eq(crmTask.organizationId, orgId), eq(crmTask.contactId, id), eq(crmTask.status, "open")),
      )
      .orderBy(asc(crmTask.createdAt)),
    tx
      .select({ conversation, connection: channelConnection })
      .from(conversation)
      .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
      .where(and(eq(conversation.organizationId, orgId), eq(conversation.contactId, id)))
      .orderBy(sql`"conversation"."last_message_at" desc nulls last`),
    tx
      .select({ link: patientContact, patient })
      .from(patientContact)
      .innerJoin(
        patient,
        and(eq(patientContact.patientId, patient.id), eq(patient.organizationId, orgId)),
      )
      .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.contactId, id)))
      .orderBy(desc(patientContact.isPreferred), asc(patient.displayName), asc(patient.id)),
  ])
  const customFields =
    row.customFields && typeof row.customFields === "object" && !Array.isArray(row.customFields)
      ? (row.customFields as Record<string, unknown>)
      : {}
  return {
    contact: {
      ...toListItem(row, [...new Set(identities.map((i) => i.channel))]),
      notes: row.notes,
      customFields,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    patients: links.map(({ link, patient: p }) => ({
      id: p.id,
      patientNumber: p.patientNumber,
      displayName: p.displayName,
      isActive: p.isActive,
      relationship: link.relationship,
      relationshipDetail: link.relationshipDetail,
      isPreferred: link.isPreferred,
    })),
    identities: identities.map((i) => ({
      id: i.id,
      channel: i.channel,
      externalUserId: i.externalUserId,
      displayName: i.displayName,
    })),
    openTasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      dueAt: iso(t.dueAt),
      assigneeUserId: t.assigneeUserId,
    })),
    conversations: conversations.map(({ conversation: c, connection }) => ({
      id: c.id,
      status: c.status,
      channel: connection.channel,
      connectionId: connection.id,
      connectionName: connection.displayName,
      contactIdentityId: c.contactIdentityId,
      lastMessageAt: iso(c.lastMessageAt),
    })),
  }
}

export async function requireContact(
  tx: Db,
  orgId: string,
  id: string,
): Promise<typeof contact.$inferSelect> {
  const [row] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.id, id), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Contacto")
  return row
}


/** Auditoría administrativa: IDs y campos modificados, sin texto clínico ni tokens. */
async function auditContact(
  tx: Db,
  orgId: string,
  actor: { userId: string | null } | undefined,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: actor?.userId ?? null,
    action,
    entity: "contact",
    entityId,
    metadata: metadata as Record<string, unknown> | null,
  })
}

/** Teléfono declarado: se conserva tal cual, sin verificar ni generar identidades. */
function cleanContactPhone(input: string | null | undefined): string | null | undefined {
  if (input === undefined) return undefined
  if (input === null) return null
  const value = input.trim()
  if (!value) return null
  if (value.length > 50) throw validation("El teléfono no puede superar 50 caracteres")
  return value
}

function cleanContactEmail(input: string | null | undefined): string | null | undefined {
  if (input === undefined) return undefined
  if (input === null) return null
  const value = input.trim()
  if (!value) return null
  if (value.length > 200) throw validation("El correo no puede superar 200 caracteres")
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw validation("El correo no tiene un formato válido")
  return value
}

export async function createContact(
  tx: Db,
  orgId: string,
  input: {
    displayName: string
    phone?: string | null
    email?: string | null
    isActive?: boolean
    notes?: string
    tags?: string[]
    assignedUserId?: string | null
  },
  actor?: { userId: string | null },
): Promise<ContactDetail> {
  const displayName = input.displayName.trim()
  if (!displayName) throw validation("El nombre del contacto es obligatorio")
  const [created] = await tx
    .insert(contact)
    .values({
      organizationId: orgId,
      displayName,
      phone: cleanContactPhone(input.phone) ?? null,
      email: cleanContactEmail(input.email) ?? null,
      isActive: input.isActive ?? true,
      notes: input.notes ?? null,
      tags: normalizeContactTags(input.tags ?? []),
      assignedUserId: input.assignedUserId ?? null,
    })
    .returning()
  if (!created) throw new Error("No se pudo crear el contacto")
  // Auditoría con nombres de campos e IDs, sin valores de texto/PII ni tokens.
  const createdFields = ["displayName"]
  if (input.phone !== undefined) createdFields.push("phone")
  if (input.email !== undefined) createdFields.push("email")
  if (input.isActive !== undefined) createdFields.push("isActive")
  if (input.notes !== undefined) createdFields.push("notes")
  if (input.tags !== undefined) createdFields.push("tags")
  if (input.assignedUserId !== undefined) createdFields.push("assignedUserId")
  await auditContact(tx, orgId, actor, "contact.created", created.id, { fields: createdFields })
  const full = await getContact(tx, orgId, created.id)
  return full.contact
}

/** Valida custom fields contra las definiciones de la org; descarta claves desconocidas. */
export async function sanitizeCustomFields(
  tx: Db,
  orgId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const defs = await tx
    .select()
    .from(customFieldDef)
    .where(eq(customFieldDef.organizationId, orgId))
  const byKey = new Map(defs.map((d) => [d.key, d]))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const def = byKey.get(key)
    if (!def || value === null || value === undefined) continue
    switch (def.type) {
      case "text":
        if (typeof value !== "string") throw validation(`Campo ${def.label}: debe ser texto`)
        out[key] = value
        break
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw validation(`Campo ${def.label}: debe ser número`)
        }
        out[key] = value
        break
      case "date":
        if (
          typeof value !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          Number.isNaN(Date.parse(value))
        ) {
          throw validation(`Campo ${def.label}: debe ser fecha YYYY-MM-DD`)
        }
        out[key] = value
        break
      case "select": {
        const options =
          Array.isArray(def.options) && def.options.every((o): o is string => typeof o === "string")
            ? def.options
            : []
        if (typeof value !== "string" || !options.includes(value)) {
          throw validation(`Campo ${def.label}: valor fuera de opciones`)
        }
        out[key] = value
        break
      }
      default:
        throw validation(`Campo ${def.label}: tipo desconocido`)
    }
  }
  return out
}
export async function updateContact(
  tx: Db,
  orgId: string,
  id: string,
  input: {
    displayName?: string
    phone?: string | null
    email?: string | null
    /** Archivar/reactivar: la ruta lo restringe a owner/admin. */
    isActive?: boolean
    notes?: string | null
    tags?: string[]
    assignedUserId?: string | null
    customFields?: Record<string, unknown>
  },
  actor?: { userId: string | null },
): Promise<ContactDetail> {
  const { isActive, ...fields } = input
  await requireContact(tx, orgId, id)
  const patch: Partial<typeof contact.$inferInsert> = { updatedAt: new Date() }
  const changed: string[] = []
  if (fields.displayName !== undefined) {
    const displayName = fields.displayName.trim()
    if (!displayName) throw validation("El nombre del contacto es obligatorio")
    patch.displayName = displayName
    changed.push("displayName")
  }
  if (fields.phone !== undefined) {
    patch.phone = cleanContactPhone(fields.phone) ?? null
    changed.push("phone")
  }
  if (fields.email !== undefined) {
    patch.email = cleanContactEmail(fields.email) ?? null
    changed.push("email")
  }
  if (fields.notes !== undefined) {
    patch.notes = fields.notes
    changed.push("notes")
  }
  if (fields.tags !== undefined) {
    patch.tags = normalizeContactTags(fields.tags)
    changed.push("tags")
  }
  if (fields.assignedUserId !== undefined) {
    patch.assignedUserId = fields.assignedUserId
    changed.push("assignedUserId")
  }
  if (fields.customFields !== undefined) {
    patch.customFields = await sanitizeCustomFields(tx, orgId, fields.customFields)
    changed.push("customFields")
  }
  if (isActive !== undefined) await applyContactActive(tx, orgId, id, isActive, actor)
  if (changed.length > 0) {
    await tx
      .update(contact)
      .set(patch)
      .where(and(eq(contact.id, id), eq(contact.organizationId, orgId)))
    await auditContact(tx, orgId, actor, "contact.updated", id, { fields: changed })
  }
  const full = await getContact(tx, orgId, id)
  return full.contact
}

/**
 * Archiva o reactiva un contacto. Único punto de cambio de isActive (vía
 * updateContact). Orden de locks: enlaces de registro pendientes por id y
 * después el contacto FOR UPDATE con revalidación. Al archivar revoca los
 * enlaces pendientes; reactivar no revive enlaces revocados.
 */
async function applyContactActive(
  tx: Db,
  orgId: string,
  contactId: string,
  isActive: boolean,
  actor?: { userId: string | null },
): Promise<void> {
  await lockRegistrationContacts(tx, orgId, [contactId], true)
  const pendingScope = and(
    eq(patientRegistrationLink.organizationId, orgId),
    eq(patientRegistrationLink.contactId, contactId),
    sql`"consumed_at" is null`,
    sql`"revoked_at" is null`,
  )
  await tx
    .select({ id: patientRegistrationLink.id })
    .from(patientRegistrationLink)
    .where(pendingScope)
    .orderBy(asc(patientRegistrationLink.id))
    .for("update")
  const [locked] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!locked) throw notFound("Contacto")
  const revokedLinks = isActive ? 0 : await revokePendingRegistrationLinks(tx, orgId, contactId)
  await tx
    .update(contact)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
  await auditContact(tx, orgId, actor, isActive ? "contact.reactivated" : "contact.archived", contactId, {
    fields: ["isActive"],
    revokedLinks,
  })
}


/* ------------------------------------------------------------------ */
/* Canales omnicanal (paso 5): identidades, transferencia y locks.      */
/* WhatsApp, Telegram, Messenger e Instagram. gmail/microsoft365 y      */
/* web_chat los amplían sus slices en OMNI_CHANNELS/normalize. El       */
/* teléfono/correo declarado del contacto NUNCA genera ni infiere una   */
/* identidad: solo el alta manual o la ingesta autenticada por el       */
/* proveedor crean filas en contact_identity.                           */
/* ------------------------------------------------------------------ */

export const OMNI_CHANNELS = ["whatsapp", "telegram", "messenger", "instagram"] as const
export type OmniChannel = (typeof OMNI_CHANNELS)[number]

/** Normaliza la identidad al formato del adaptador o falla con validación. */
export function normalizeChannelIdentity(
  channel: string,
  externalUserId: string,
): { channel: OmniChannel; externalUserId: string } {
  if (!OMNI_CHANNELS.includes(channel as OmniChannel)) {
    throw validation("Canal no soportado: solo whatsapp, telegram, messenger o instagram")
  }
  const raw = externalUserId.trim()
  if (!raw) throw validation("El identificador del canal es obligatorio")
  if (channel === "whatsapp") {
    const withoutPrefix = raw.toLowerCase().startsWith("wa:") ? raw.slice(3) : raw
    const digits = withoutPrefix.replace(/[\s\-()+]/g, "")
    if (!/^\d{7,15}$/.test(digits)) {
      throw validation("WhatsApp exige un teléfono internacional (7–15 dígitos)")
    }
    return { channel, externalUserId: `wa:${digits}` }
  }
  // telegram (tg:), messenger (msgr:) e instagram (ig:) usan IDs numéricos
  // de la plataforma (chat id, PSID, IGSID); nunca @usuario ni teléfonos.
  const prefix = channel === "messenger" ? "msgr" : channel === "instagram" ? "ig" : "tg"
  const label = channel === "messenger" ? "Messenger" : channel === "instagram" ? "Instagram" : "Telegram"
  const withoutPrefix = raw.toLowerCase().startsWith(`${prefix}:`) ? raw.slice(prefix.length + 1) : raw
  if (!/^\d+$/.test(withoutPrefix)) {
    throw validation(`${label} exige el ID numérico de la plataforma (no @usuario)`)
  }
  return { channel: channel as OmniChannel, externalUserId: `${prefix}:${withoutPrefix}` }
}

/** Hilo grupal de Telegram (chat negativo): nunca se atribuye ni se traslada. */
export function isTelegramGroupThread(channel: string, externalThreadId: string): boolean {
  return channel === "telegram" && /^tg:-\d+/.test(externalThreadId)
}

/** Hilo directo remitente↔hilo (criterio conservador, como el backfill). */
export function isDirectThread(
  channel: string,
  externalThreadId: string,
  senderExternalId: string,
): boolean {
  if (isTelegramGroupThread(channel, externalThreadId)) return false
  if (channel === "whatsapp") {
    const thread = externalThreadId.replace(/\D/g, "")
    const sender = senderExternalId.replace(/\D/g, "")
    return thread.length > 0 && thread === sender
  }
  return externalThreadId === senderExternalId
}

/**
 * Lock advisory transaccional por identidad de canal. Lo toman ingesta,
 * alta manual y transferencia con la misma clave para serializar
 * creación/resolución/traslado sin capturar unique violations en
 * transacciones abortadas.
 */
export async function lockChannelIdentity(
  tx: Db,
  orgId: string,
  channel: string,
  externalUserId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"ci:" + orgId}), hashtext(${channel + ":" + externalUserId}))`,
  )
}

export interface ContactIdentityItem {
  id: string
  channel: string
  externalUserId: string
  displayName: string | null
}

function toIdentityItem(row: typeof contactIdentity.$inferSelect): ContactIdentityItem {
  return {
    id: row.id,
    channel: row.channel,
    externalUserId: row.externalUserId,
    displayName: row.displayName,
  }
}
export async function findChannelIdentity(
  tx: Db,
  orgId: string,
  channel: string,
  externalUserId: string,
): Promise<typeof contactIdentity.$inferSelect | null> {
  const [row] = await tx
    .select()
    .from(contactIdentity)
    .where(
      and(
        eq(contactIdentity.organizationId, orgId),
        eq(contactIdentity.channel, channel),
        eq(contactIdentity.externalUserId, externalUserId),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Alta manual autorizada de identidad de canal. Idempotente para el mismo
 * contacto; 409 IDENTITY_IN_USE si pertenece a otro contacto.
 */
export async function addContactIdentity(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  contactId: string,
  input: { channel: string; externalUserId: string },
): Promise<ContactIdentityItem> {
  const actor = { userId: actorUserId }
  await requireContact(tx, orgId, contactId)
  const normalized = normalizeChannelIdentity(input.channel, input.externalUserId)
  await lockChannelIdentity(tx, orgId, normalized.channel, normalized.externalUserId)
  const existing = await findChannelIdentity(tx, orgId, normalized.channel, normalized.externalUserId)
  if (existing) {
    if (existing.contactId !== contactId) {
      throw new ServiceError(
        "IDENTITY_IN_USE",
        409,
        "Esa identidad de canal ya pertenece a otro contacto",
      )
    }
    return toIdentityItem(existing)
  }
  const [created] = await tx
    .insert(contactIdentity)
    .values({
      organizationId: orgId,
      contactId,
      channel: normalized.channel,
      externalUserId: normalized.externalUserId,
    })
    .onConflictDoNothing({
      target: [
        contactIdentity.organizationId,
        contactIdentity.channel,
        contactIdentity.externalUserId,
      ],
    })
    .returning()
  const row = created ?? (await findChannelIdentity(tx, orgId, normalized.channel, normalized.externalUserId))
  if (!row) throw new Error("No se pudo crear la identidad de canal")
  if (row.contactId !== contactId) {
    throw new ServiceError(
      "IDENTITY_IN_USE",
      409,
      "Esa identidad de canal ya pertenece a otro contacto",
    )
  }
  await auditContact(tx, orgId, actor, "contact.identity_added", contactId, {
    fields: ["identityId", "channel"],
    identityId: row.id,
    channel: row.channel,
  })
  return toIdentityItem(row)
}

/**
 * Reasignación explícita de una identidad («Reasignar canal»).
 * Orden de locks: advisory de identidad → enlaces de registro pendientes
 * ordenados por id → contactos ordenados por id (FOR UPDATE). Mueve la
 * identidad y solo las conversaciones directas resueltas por esa identidad,
 * más las tareas doblemente ligadas (esas conversaciones + contacto origen).
 * No mueve vínculos de pacientes ni archiva/fusiona el origen. Revoca los
 * enlaces de registro pendientes del contacto origen.
 */
export async function moveContactIdentity(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  identityId: string,
  input: { fromContactId: string; toContactId: string; reason: string },
): Promise<{
  identity: ContactIdentityItem
  movedConversations: number
  movedTasks: number
  revokedLinks: number
}> {
  const actor = { userId: actorUserId }
  const reason = input.reason.trim()
  if (reason.length < 1 || reason.length > 500) {
    throw validation("El motivo de la reasignación debe tener entre 1 y 500 caracteres")
  }
  if (input.fromContactId === input.toContactId) {
    throw validation("El contacto origen y destino deben ser distintos")
  }
  const [identity] = await tx
    .select()
    .from(contactIdentity)
    .where(and(eq(contactIdentity.id, identityId), eq(contactIdentity.organizationId, orgId)))
    .limit(1)
  if (!identity) throw notFound("Identidad de canal")
  await lockChannelIdentity(tx, orgId, identity.channel, identity.externalUserId)
  await lockRegistrationContacts(tx, orgId, [input.fromContactId, input.toContactId].sort(), true)
  const [lockedIdentity] = await tx
    .select()
    .from(contactIdentity)
    .where(and(eq(contactIdentity.id, identityId), eq(contactIdentity.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!lockedIdentity) throw notFound("Identidad de canal")
  if (lockedIdentity.contactId !== input.fromContactId) {
    throw new ServiceError(
      "IDENTITY_IN_USE",
      409,
      "La identidad ya no pertenece al contacto origen indicado",
    )
  }
  const [fromId, toId] =
    input.fromContactId < input.toContactId
      ? [input.fromContactId, input.toContactId]
      : [input.toContactId, input.fromContactId]
  await tx
    .select({ id: patientRegistrationLink.id })
    .from(patientRegistrationLink)
    .where(
      and(
        eq(patientRegistrationLink.organizationId, orgId),
        inArray(patientRegistrationLink.contactId, [fromId, toId]),
        sql`"consumed_at" is null`,
        sql`"revoked_at" is null`,
      ),
    )
    .orderBy(asc(patientRegistrationLink.id))
    .for("update")
  const lockedContacts = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), inArray(contact.id, [fromId, toId])))
    .orderBy(asc(contact.id))
    .for("update")
  if (lockedContacts.length !== 2) throw notFound("Contacto")
  const originConvs = await tx
    .select({ conv: conversation, connection: channelConnection })
    .from(conversation)
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    .where(
      and(eq(conversation.organizationId, orgId), eq(conversation.contactId, input.fromContactId)),
    )
  const ambiguous = originConvs.filter(
    (r) =>
      r.connection.channel === lockedIdentity.channel &&
      r.conv.contactIdentityId === null &&
      !isTelegramGroupThread(r.connection.channel, r.conv.externalThreadId),
  )
  if (ambiguous.length > 0) {
    throw new ServiceError(
      "AMBIGUOUS_CHANNEL_HISTORY",
      409,
      "Hay conversaciones del origen sin identidad determinable: resuélvelas manualmente antes de transferir",
    )
  }
  const movable = originConvs.filter(
    (r) =>
      r.conv.contactIdentityId === lockedIdentity.id &&
      !isTelegramGroupThread(r.connection.channel, r.conv.externalThreadId),
  )
  const movedIds = movable.map((r) => r.conv.id)
  const revokedCount = await revokePendingRegistrationLinks(tx, orgId, input.fromContactId)
  await tx
    .update(contactIdentity)
    .set({ contactId: input.toContactId })
    .where(
      and(eq(contactIdentity.id, lockedIdentity.id), eq(contactIdentity.organizationId, orgId)),
    )
  let movedTasks = 0
  if (movedIds.length > 0) {
    await tx
      .update(conversation)
      .set({ contactId: input.toContactId, updatedAt: new Date() })
      .where(
        and(
          eq(conversation.organizationId, orgId),
          inArray(conversation.id, [...movedIds].sort()),
        ),
      )
    const movedTaskRows = await tx
      .update(crmTask)
      .set({ contactId: input.toContactId, updatedAt: new Date() })
      .where(
        and(
          eq(crmTask.organizationId, orgId),
          eq(crmTask.contactId, input.fromContactId),
          inArray(crmTask.conversationId, [...movedIds].sort()),
        ),
      )
      .returning({ id: crmTask.id })
    movedTasks = movedTaskRows.length
  }
  await auditContact(tx, orgId, actor, "contact.identity_moved", input.fromContactId, {
    fields: ["identityId", "fromContactId", "toContactId", "reason"],
    identityId: lockedIdentity.id,
    fromContactId: input.fromContactId,
    toContactId: input.toContactId,
    reason,
    movedConversations: movedIds.length,
    movedTasks,
    revokedLinks: revokedCount,
  })
  const [moved] = await tx
    .select()
    .from(contactIdentity)
    .where(and(eq(contactIdentity.id, lockedIdentity.id), eq(contactIdentity.organizationId, orgId)))
    .limit(1)
  if (!moved) throw notFound("Identidad de canal")
  return {
    identity: toIdentityItem(moved),
    movedConversations: movedIds.length,
    movedTasks,
    revokedLinks: revokedCount,
  }
}

/** Revoca enlaces pendientes de un contacto (archivar/transferir), ya bloqueados. */
export async function revokePendingRegistrationLinks(
  tx: Db,
  orgId: string,
  contactId: string,
): Promise<number> {
  const revoked = await tx
    .update(patientRegistrationLink)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(patientRegistrationLink.organizationId, orgId),
        eq(patientRegistrationLink.contactId, contactId),
        sql`"consumed_at" is null`,
        sql`"revoked_at" is null`,
      ),
    )
    .returning({ id: patientRegistrationLink.id })
  return revoked.length
}

/** Cierra la carrera de enlaces nuevos mientras archivo/traslado enumera los pendientes. */
export async function lockRegistrationContacts(tx: Db, orgId: string, contactIds: string[], exclusive: boolean): Promise<void> {
  for (const id of [...new Set(contactIds.map(id => id.toLowerCase()))].sort()) {
    const key = `patient-registration-contact:${orgId}:${id}`
    if (exclusive) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
    else await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`)
  }
}
