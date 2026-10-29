import {
  normalizePhone,
  normalizeTags,
  phoneFormatError,
  whatsappNumberProblem,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { patient, patientContact, patientRegistrationLink } from "@odentia/db/schema/clinical"
import {
  channelConnection,
  contact,
  contactIdentity,
  conversation,
  crmTask,
  customFieldDef,
  PREFERRED_CHANNELS,
} from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, or, sql } from "drizzle-orm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { notFound, ServiceError, validation } from "./errors.js"
import { personSearchCondition } from "./person-search.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { findOrgCountry } from "./locale.js"
import { identityPatchOf, setPersonArchived, updatePersonIdentity } from "./people.js"

/** Aviso en vivo mínimo para refresco CRM: solo `{ orgId, kind, at }`, sin PII. */
export async function notifyContactChange(tx: Db, orgId: string): Promise<void> {
  await notifyCrm(tx, orgId, "contact.updated")
}

async function notifyCrm(tx: Db, orgId: string, kind: string): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind, at: new Date().toISOString() })})`)
}

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
  /** Medio preferido para avisos y documentos; nulo = sin preferencia. */
  preferredChannel: string | null
  isActive: boolean
  tags: string[]
  lastInteractionAt: string | null
  channels: string[]
  /** Oportunidades abiertas del contacto (agregado SQL completo, no muestra truncada). */
  openOpportunityCount: number
}


export interface ContactDetail extends ContactListItem {
  docType: string | null
  docNumber: string | null
  birthDate: string | null
  sex: string | null
  customFields: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null
}
function toListItem(
  row: typeof contact.$inferSelect,
  channels: string[],
  openOpportunityCount = 0,
): ContactListItem {
  return {
    id: row.id,
    displayName: row.displayName,
    phone: row.phone,
    email: row.email,
    preferredChannel: row.preferredChannel,
    isActive: row.isActive,
    tags: row.tags,
    lastInteractionAt: iso(row.lastInteractionAt),
    channels,
    openOpportunityCount,
  }
}
const PAGE_DEFAULT = 30

export type ContactSort = "nombre" | "-nombre" | "actividad" | "-actividad"
export interface ContactListFilters {
  q?: string
  /** true = solo activos (default), false = solo archivados, "all" = todos. */
  isActive?: boolean | "all"
  /** Orden global servidor; default "-actividad" (recientes primero). */
  sort?: ContactSort
  cursor?: string
  limit?: number
}

/** Huella de filtros: el cursor solo es válido con los mismos parámetros. */
function listingFingerprint(input: { q: string; isActive: boolean | "all"; sort: ContactSort }): string {
  return JSON.stringify({ q: input.q, isActive: input.isActive, sort: input.sort })
}

function encodeListingCursor(key: string, id: string, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ k: key, id, f: fingerprint }), "utf8").toString("base64url")
}

function decodeListingCursor(cursor: string): { k: string; id: string; f: string } | null {
  try {
    const raw: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (!raw || typeof raw !== "object") return null
    const rec = raw as Record<string, unknown>
    if (typeof rec.k !== "string" || typeof rec.id !== "string" || typeof rec.f !== "string") {
      return null
    }
    if (!/^[0-9a-f-]{36}$/i.test(rec.id)) return null
    return { k: rec.k, id: rec.id, f: rec.f }
  } catch {
    return null
  }
}

/** Clave actividad UTC con microsegundos (to_char ... .US"Z"); "" = NULL. */
const ACTIVITY_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/
function assertActivityKey(k: string): void {
  if (!ACTIVITY_KEY_RE.test(k) || Number.isNaN(new Date(k).getTime())) {
    throw validation("Cursor inválido")
  }
}
function normalizeContactSort(sort: ContactSort | undefined): ContactSort {
  if (sort === undefined) return "-actividad"
  if (sort === "nombre" || sort === "-nombre" || sort === "actividad" || sort === "-actividad") return sort
  throw validation("Orden inválido (nombre|-nombre|actividad|-actividad)")
}

export async function listContacts(
  tx: Db,
  orgId: string,
  input: ContactListFilters,
): Promise<{ items: ContactListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? PAGE_DEFAULT, 1), 100)
  const q = input.q?.trim() ? input.q.trim() : ""
  const active = input.isActive ?? true
  const sort = normalizeContactSort(input.sort)
  const fingerprint = listingFingerprint({ q, isActive: active, sort })
  const conditions = [eq(contact.organizationId, orgId)]
  // El mismo buscador que la lista de personas: «987 654» encuentra «+51987654100».
  if (q)
    conditions.push(
      personSearchCondition(q, { displayName: contact.displayName, email: contact.email, phone: contact.phone, contactId: contact.id }),
    )
  if (active !== "all") conditions.push(eq(contact.isActive, active))
  // Una historia bloqueada no sale en ninguna lista (ADR 0080).
  conditions.push(sql`${contact.recordLockedAt} is null`)
  if (input.cursor) {
    const decoded = decodeListingCursor(input.cursor)
    if (!decoded) throw validation("Cursor inválido")
    if (decoded.f !== fingerprint)
      throw validation("El cursor no corresponde a los filtros actuales")
    if (sort === "-actividad") {
      if (decoded.k === "") {
        conditions.push(sql`"last_interaction_at" is null`)
        conditions.push(lt(contact.id, decoded.id))
      } else {
        assertActivityKey(decoded.k)
        conditions.push(
          or(
            sql`"last_interaction_at" < ${decoded.k}::timestamptz`,
            and(
              sql`"last_interaction_at" = ${decoded.k}::timestamptz`,
              lt(contact.id, decoded.id),
            ),
            sql`"last_interaction_at" is null`,
          )!,
        )
      }
    } else if (sort === "actividad") {
      if (decoded.k === "") {
        conditions.push(
          or(
            and(sql`"last_interaction_at" is null`, gt(contact.id, decoded.id)),
            sql`"last_interaction_at" is not null`,
          )!,
        )
      } else {
        assertActivityKey(decoded.k)
        conditions.push(
          or(
            sql`"last_interaction_at" > ${decoded.k}::timestamptz`,
            and(
              sql`"last_interaction_at" = ${decoded.k}::timestamptz`,
              gt(contact.id, decoded.id),
            ),
          )!,
        )
      }
    } else if (sort === "nombre") {
      conditions.push(
        or(
          gt(contact.displayName, decoded.k),
          and(eq(contact.displayName, decoded.k), gt(contact.id, decoded.id)),
        )!,
      )
    } else {
      conditions.push(
        or(
          lt(contact.displayName, decoded.k),
          and(eq(contact.displayName, decoded.k), lt(contact.id, decoded.id)),
        )!,
      )
    }
  }
  const orderBy =
    sort === "-actividad"
      ? [sql`"last_interaction_at" desc nulls last`, desc(contact.id)]
      : sort === "actividad"
        ? [sql`"last_interaction_at" asc nulls first`, asc(contact.id)]
        : sort === "nombre"
          ? [asc(contact.displayName), asc(contact.id)]
          : [desc(contact.displayName), desc(contact.id)]
  const rows = await tx
    .select({
      contact,
      activityKey: sql<string | null>`to_char("last_interaction_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(contact)
    .where(and(...conditions))
    .orderBy(...orderBy)
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
              page.map((r) => sql`${r.contact.id}::uuid`),
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
  // Conteo completo de oportunidades abiertas por contacto (agregado SQL, no muestra).
  const openCounts = new Map<string, number>()
  if (page.length) {
    const counted = await tx
      .select({ contactId: opportunity.contactId, count: sql<number>`count(*)::int` })
      .from(opportunity)
      .where(
        and(
          eq(opportunity.organizationId, orgId),
          eq(opportunity.status, "open"),
          inArray(
            opportunity.contactId,
            page.map((r) => r.contact.id),
          ),
        ),
      )
      .groupBy(opportunity.contactId)
    for (const row of counted) openCounts.set(row.contactId, row.count)
  }
  const items = page.map((r) =>
    toListItem(r.contact, byContact.get(r.contact.id) ?? [], openCounts.get(r.contact.id) ?? 0),
  )
  const last = page[page.length - 1]
  const cursorKey = last
    ? sort === "nombre" || sort === "-nombre"
      ? last.contact.displayName
      : (last.activityKey ?? "")
    : ""
  const nextCursor =
    rows.length > limit && last ? encodeListingCursor(cursorKey, last.contact.id, fingerprint) : null
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
  /** Cómo se cerró (mismo formato que la Bandeja); null si está abierta. */
  closure: { reason: "resuelta" | "sin_respuesta" | "equipo" | "manual"; at: string; byName: string | null } | null
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
      .select({
        conversation,
        connection: channelConnection,
        closedByName: sql<string | null>`(select u.name from "user" u where u.id = "conversation"."closed_by_user_id")`,
      })
      .from(conversation)
      .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
      .where(and(eq(conversation.organizationId, orgId), eq(conversation.contactId, id)))
      .orderBy(sql`"conversation"."last_message_at" desc nulls last`),
    tx
      .select({
        link: patientContact,
        patient: { id: patient.id, patientNumber: patient.patientNumber, displayName: patientPerson.displayName, isActive: patientPerson.isActive },
      })
      .from(patientContact)
      .innerJoin(
        patient,
        and(eq(patientContact.patientId, patient.id), eq(patient.organizationId, orgId)),
      )
      .innerJoin(patientPerson, joinPatientPerson(patientPerson))
      .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.contactId, id)))
      .orderBy(desc(patientContact.isPreferred), asc(patientPerson.displayName), asc(patient.id)),
  ])
  const customFields =
    row.customFields && typeof row.customFields === "object" && !Array.isArray(row.customFields)
      ? (row.customFields as Record<string, unknown>)
      : {}
  return {
    contact: {
      ...toListItem(row, [...new Set(identities.map((i) => i.channel))]),
      docType: row.docType,
      docNumber: row.docNumber,
      birthDate: row.birthDate,
      sex: row.sex,
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
    conversations: conversations.map(({ conversation: c, connection, closedByName }) => ({
      id: c.id,
      status: c.status,
      channel: connection.channel,
      connectionId: connection.id,
      connectionName: connection.displayName,
      contactIdentityId: c.contactIdentityId,
      lastMessageAt: iso(c.lastMessageAt),
      closure:
        c.status === "closed" && c.closeReason && c.closedAt
          ? {
              reason: c.closeReason as "resuelta" | "sin_respuesta" | "equipo" | "manual",
              at: c.closedAt.toISOString(),
              byName: closedByName,
            }
          : null,
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
/**
 * Teléfono en E.164 (ADR 0004): +código de país. Un número nacional escrito
 * sin prefijo se completa con el perfil del país de la clínica, que solo se
 * consulta cuando hace falta: el campo de la interfaz ya entrega E.164.
 */
export async function cleanContactPhone(
  tx: Db,
  orgId: string,
  input: string | null | undefined,
): Promise<string | null | undefined> {
  if (input === undefined) return undefined
  if (input === null) return null
  const value = input.trim()
  if (!value) return null
  if (value.length > 50) throw validation("El teléfono no puede superar 50 caracteres")
  const international = normalizePhone(value)
  if (international) return international
  const countryCode = await findOrgCountry(tx, orgId)
  const normalized = normalizePhone(value, countryCode)
  if (!normalized) throw validation(phoneFormatError(countryCode))
  return normalized
}

export function cleanContactEmail(input: string | null | undefined): string | null | undefined {
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
    /** Nombre separado (ADR 0004): la base deriva de él el nombre visible. */
    givenNames?: string | null
    familyName?: string | null
    phone?: string | null
    email?: string | null
    docType?: string | null
    docNumber?: string | null
    docCountry?: string | null
    birthDate?: string | null
    sex?: string | null
    isActive?: boolean
    tags?: string[]
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
      givenNames: input.givenNames ?? null,
      familyName: input.familyName ?? null,
      phone: (await cleanContactPhone(tx, orgId, input.phone)) ?? null,
      email: cleanContactEmail(input.email) ?? null,
      docType: input.docType ?? null,
      docNumber: input.docNumber ?? null,
      docCountry: input.docCountry ?? null,
      birthDate: input.birthDate ?? null,
      sex: input.sex ?? null,
      isActive: input.isActive ?? true,
      tags: normalizeContactTags(input.tags ?? []),
    })
    .returning()
  if (!created) throw new Error("No se pudo crear el contacto")
  // Auditoría con nombres de campos e IDs, sin valores de texto/PII ni tokens.
  const createdFields = ["displayName"]
  if (input.phone !== undefined) createdFields.push("phone")
  if (input.email !== undefined) createdFields.push("email")
  if (input.docNumber) createdFields.push("docNumber")
  if (input.isActive !== undefined) createdFields.push("isActive")
  if (input.tags !== undefined) createdFields.push("tags")
  await auditContact(tx, orgId, actor, "contact.created", created.id, { fields: createdFields })
  await notifyCrm(tx, orgId, "contact.updated")
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
    givenNames?: string | null
    familyName?: string | null
    phone?: string | null
    email?: string | null
    /** Medio preferido para avisos y documentos; nulo = sin preferencia. */
    preferredChannel?: string | null
    docType?: string | null
    docNumber?: string | null
    docCountry?: string | null
    /** Fecha calendario ISO (AAAA-MM-DD). */
    birthDate?: string | null
    sex?: string | null
    /** Archivar/recuperar: archiva o recupera a la persona entera (`setPersonArchived`). */
    isActive?: boolean
    tags?: string[]
    customFields?: Record<string, unknown>
  },
  actor?: { userId: string | null; origin?: "agent" },
): Promise<ContactDetail> {
  const { isActive, ...fields } = input
  await requireContact(tx, orgId, id)
  // La identidad es una sola y se cambia con las reglas de la ficha, también
  // desde el CRM y el agente (`updatePersonIdentity`: catálogos, país emisor,
  // regla del menor si es paciente).
  const identity = identityPatchOf(fields)
  if (Object.keys(identity).length > 0)
    await updatePersonIdentity(tx, orgId, { userId: actor?.userId ?? null, ...(actor?.origin ? { origin: actor.origin } : {}) }, id, identity)
  const patch: Partial<typeof contact.$inferInsert> = { updatedAt: new Date() }
  const changed: string[] = []
  if (fields.preferredChannel !== undefined) {
    const preferred = fields.preferredChannel?.trim() || null
    if (preferred && !PREFERRED_CHANNELS.includes(preferred as (typeof PREFERRED_CHANNELS)[number]))
      throw validation("Medio preferido inválido: solo email, whatsapp, telegram, messenger o instagram")
    // Solo vale un medio por el que la clínica puede escribirle: uno conectado.
    // La regla vive aquí, no en el desplegable de la pantalla.
    if (preferred) {
      const [connected] = await tx
        .select({ id: channelConnection.id })
        .from(channelConnection)
        .where(
          and(
            eq(channelConnection.organizationId, orgId),
            eq(channelConnection.channel, preferred),
            eq(channelConnection.status, "active"),
          ),
        )
        .limit(1)
      if (!connected)
        throw validation("La clínica no tiene conectado ese medio: conéctalo antes de elegirlo como preferido")
    }
    patch.preferredChannel = preferred
    changed.push("preferredChannel")
  }
  if (fields.tags !== undefined) {
    patch.tags = normalizeContactTags(fields.tags)
    changed.push("tags")
  }
  if (fields.customFields !== undefined) {
    patch.customFields = await sanitizeCustomFields(tx, orgId, fields.customFields)
    changed.push("customFields")
  }
  if (isActive !== undefined) await setPersonArchived(tx, orgId, { userId: actor?.userId ?? null }, id, !isActive)
  if (changed.length > 0) {
    await tx
      .update(contact)
      .set(patch)
      .where(and(eq(contact.id, id), eq(contact.organizationId, orgId)))
    await auditContact(tx, orgId, actor, "contact.updated", id, {
      fields: changed,
      ...(actor?.origin ? { origin: actor.origin } : {}),
    })
    await notifyCrm(tx, orgId, "contact.updated")
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
export async function applyContactActive(
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
/* identidad por sí solo: solo crean filas en contact_identity la       */
/* ingesta autenticada por el proveedor y la decisión explícita de una  */
/* persona del equipo (alta manual o «Escribirle», `writeToPerson`, que */
/* usa el número que esa persona eligió). Un entrante nunca se empareja */
/* con una ficha por coincidencia de teléfono (ADR 0027).               */
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
 * Un teléfono pasa a ser el WhatsApp de una persona por la decisión de una
 * persona del equipo (ADR 0027): «Escribirle» con el número de la ficha o uno
 * que escribe, o el alta mínima desde la Agenda con su teléfono. Una sola
 * operación para las dos vías, auditada a nombre de quien lo decide; un número
 * que ya es de otra persona no se mueve (`IDENTITY_IN_USE`).
 */
export async function claimWhatsAppNumber(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  contactId: string,
  phone: string,
): Promise<{ identityId: string; created: boolean }> {
  // Un celular con un dígito de menos lo rechaza Meta en cada envío: no se guarda como su WhatsApp.
  const problem = whatsappNumberProblem(phone, await findOrgCountry(tx, orgId))
  if (problem) throw new ServiceError("NOT_WHATSAPP_NUMBER", 400, problem)
  const digits = phone.replace(/\D/g, "")
  const before = await findChannelIdentity(tx, orgId, "whatsapp", `wa:${digits}`)
  try {
    const identity = await addContactIdentity(tx, orgId, actorUserId, contactId, { channel: "whatsapp", externalUserId: digits })
    // Lo decide una persona del equipo, así que pasa a ser su WhatsApp principal: los
    // recordatorios y «Escribirle» eligen el principal, y sin esto seguirían yendo al
    // número de antes (el que escribió primero) aunque haya cambiado de número.
    await tx
      .update(contactIdentity)
      .set({ isPrimary: sql`${contactIdentity.id} = ${identity.id}` })
      .where(
        and(
          eq(contactIdentity.organizationId, orgId),
          eq(contactIdentity.contactId, contactId),
          eq(contactIdentity.channel, "whatsapp"),
        ),
      )
    // Si antes WhatsApp lo rechazó, se vuelve a intentar.
    await tx
      .update(contactIdentity)
      .set({ noWhatsappAt: null })
      .where(and(eq(contactIdentity.organizationId, orgId), eq(contactIdentity.id, identity.id)))
    return { identityId: identity.id, created: !before }
  } catch (error) {
    if (error instanceof ServiceError && error.code === "IDENTITY_IN_USE") {
      throw new ServiceError(
        "IDENTITY_IN_USE",
        409,
        "Ese número de WhatsApp ya es de otra persona de la clínica. Ábrela desde Contactos o escribe otro número.",
      )
    }
    throw error
  }
}

/**
 * Su teléfono y su WhatsApp (decisión 23): si el número de «Teléfono» es ya su
 * WhatsApp, si aún no lo es (nadie lo marcó: ADR 0027) o si WhatsApp lo
 * rechazó porque no tiene WhatsApp. `canUse`: la clínica tiene WhatsApp
 * conectado, así que «Usarlo como su WhatsApp» sirve.
 */
export type PhoneWhatsAppState = "sin_telefono" | "es_su_whatsapp" | "aun_no" | "no_tiene"

export interface PhoneWhatsApp {
  state: PhoneWhatsAppState
  phone: string | null
  canUse: boolean
}

export async function phoneWhatsAppState(tx: Db, orgId: string, contactId: string): Promise<PhoneWhatsApp> {
  const [person] = await tx
    .select({ phone: contact.phone })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, contactId)))
    .limit(1)
  const [connected] = await tx
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, "whatsapp"),
        eq(channelConnection.status, "active"),
      ),
    )
    .limit(1)
  const phone = person?.phone ?? null
  const digits = phone?.replace(/\D/g, "") ?? ""
  if (!digits) return { state: "sin_telefono", phone, canUse: !!connected }
  const [identity] = await tx
    .select({ noWhatsappAt: contactIdentity.noWhatsappAt })
    .from(contactIdentity)
    .where(
      and(
        eq(contactIdentity.organizationId, orgId),
        eq(contactIdentity.contactId, contactId),
        eq(contactIdentity.channel, "whatsapp"),
        // Las identidades de WhatsApp se guardan como `wa:<dígitos>` (`normalizeChannelIdentity`).
        eq(contactIdentity.externalUserId, `wa:${digits}`),
      ),
    )
    .limit(1)
  const state: PhoneWhatsAppState = !identity ? "aun_no" : identity.noWhatsappAt ? "no_tiene" : "es_su_whatsapp"
  return { state, phone, canUse: !!connected }
}

/**
 * «Usarlo como su WhatsApp»: el teléfono de su ficha pasa a ser su WhatsApp
 * por decisión de alguien del equipo (ADR 0027), con la misma operación que
 * «Escribirle» (`claimWhatsAppNumber`). Nunca por coincidencia de un mensaje.
 */
export async function usePhoneAsWhatsApp(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  contactId: string,
): Promise<PhoneWhatsApp> {
  const [person] = await tx
    .select({ phone: contact.phone })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, contactId)))
    .limit(1)
  if (!person) throw notFound("Persona")
  if (!person.phone?.replace(/\D/g, "")) throw validation("Escribe primero su teléfono en sus datos")
  await claimWhatsAppNumber(tx, orgId, actorUserId, contactId, person.phone)
  return phoneWhatsAppState(tx, orgId, contactId)
}

/**
 * Un mensaje llega de un número que es el «Teléfono» de una ficha (decisión
 * 23, caso 3). Nunca se une por coincidencia (regla raíz, ADR 0027): la
 * conversación pregunta «Este número es el teléfono de Carmen Ruiz. ¿Es
 * ella?» y solo alguien del equipo confirma. Se sugiere cuando quien escribe
 * es una persona provisional (aún sin ficha) y el número es el teléfono de
 * una sola persona activa; si es de varias, no se sugiere ninguna.
 */
export interface PhoneMatchSuggestion {
  identityId: string
  fromContactId: string
  personId: string
  personName: string
}

export async function phoneMatchOf(tx: Db, orgId: string, conversationId: string): Promise<PhoneMatchSuggestion | null> {
  const [thread] = await tx
    .select({ identityId: contactIdentity.id, digits: contactIdentity.externalUserId, fromContactId: contactIdentity.contactId })
    .from(conversation)
    .innerJoin(
      contactIdentity,
      and(eq(contactIdentity.organizationId, conversation.organizationId), eq(contactIdentity.id, conversation.contactIdentityId)),
    )
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, conversationId), eq(contactIdentity.channel, "whatsapp")))
    .limit(1)
  const digits = thread?.digits.replace(/\D/g, "") ?? ""
  if (!thread || digits.length < 7) return null
  // Quien escribe ya tiene su ficha: no es una persona provisional.
  const [own] = await tx
    .select({ id: patientContact.id })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.contactId, thread.fromContactId),
        eq(patientContact.relationship, "self"),
      ),
    )
    .limit(1)
  if (own) return null
  const matches = await tx
    .select({ id: contact.id, name: contact.displayName })
    .from(contact)
    .where(
      and(
        eq(contact.organizationId, orgId),
        eq(contact.isActive, true),
        sql`${contact.id} <> ${thread.fromContactId}`,
        sql`regexp_replace(coalesce(${contact.phone}, ''), '[^0-9]', '', 'g') = ${digits}`,
      ),
    )
    .limit(2)
  if (matches.length !== 1 || !matches[0]) return null
  return { identityId: thread.identityId, fromContactId: thread.fromContactId, personId: matches[0].id, personName: matches[0].name }
}

/**
 * «Sí, es Carmen»: alguien del equipo confirma que quien escribe es esa
 * persona. Se une con la operación que ya existe para eso, «Reasignar canal»
 * (`moveContactIdentity`): el número queda como su WhatsApp y la conversación
 * pasa a su página. La persona provisional queda como estaba.
 */
export async function confirmPhoneMatch(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  conversationId: string,
  personId: string,
): Promise<{ conversationId: string; contactId: string }> {
  const suggestion = await phoneMatchOf(tx, orgId, conversationId)
  if (!suggestion || suggestion.personId !== personId) {
    throw new ServiceError("PHONE_MATCH_GONE", 409, "Ese número ya no coincide con el teléfono de esa persona: revisa la conversación")
  }
  await moveContactIdentity(tx, orgId, actorUserId, suggestion.identityId, {
    fromContactId: suggestion.fromContactId,
    toContactId: personId,
    reason: `Recepción confirmó que el número es el teléfono de ${suggestion.personName}`,
  })
  return { conversationId, contactId: personId }
}

/**
 * Reasignación explícita de una identidad («Reasignar canal»).
 * Orden de locks: advisory de identidad → enlaces de registro pendientes
 * ordenados por id → contactos ordenados por id (FOR UPDATE) → oportunidades
 * y tareas del origen (FOR UPDATE, oportunidad antes que tarea). Mueve la
 * identidad y solo las conversaciones directas resueltas por esa identidad,
 * más las tareas operativas (sin oportunidad) ligadas a esos hilos.
 * No transfiere pacientes, representación ni negocio: las oportunidades y las
 * tareas comerciales (opportunityId != null) quedan en el contacto origen con
 * su conversationId desvinculado antes de mover el hilo (el guard SQL 23514
 * exige hilo y oportunidad del mismo contacto). Los seguimientos abiertos que
 * espejan el hilo de su oportunidad se desvinculan también, así el sync
 * futuro nunca revincula la conversación antigua. No mueve vínculos de
 * pacientes ni archiva/fusiona el origen. Revoca los enlaces de registro
 * pendientes del contacto origen.
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
  reconciledOpportunities: number
  reconciledTasks: number
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
  const movedSorted = [...movedIds].sort()
  // La reasignación de canal no transfiere negocio: las oportunidades y las
  // tareas comerciales quedan en el origen. El guard SQL exige hilo y
  // oportunidad del mismo contacto, así que se desvinculan ANTES de mover el
  // hilo; solo las tareas operativas (sin oportunidad) viajan con él.
  const reconciledOpportunityIds = new Set<string>()
  const reconciledTaskIds = new Set<string>()
  let operationalTaskIds: string[] = []
  if (movedSorted.length > 0) {
    const originOpps = await tx
      .select({ id: opportunity.id, conversationId: opportunity.conversationId })
      .from(opportunity)
      .where(
        and(eq(opportunity.organizationId, orgId), eq(opportunity.contactId, input.fromContactId)),
      )
      .orderBy(asc(opportunity.id))
      .for("update")
    const detachOppIds = originOpps
      .filter((o) => o.conversationId !== null && movedSorted.includes(o.conversationId))
      .map((o) => o.id)
    const linkedTasks = await tx
      .select({
        id: crmTask.id,
        opportunityId: crmTask.opportunityId,
        conversationId: crmTask.conversationId,
      })
      .from(crmTask)
      .where(
        and(
          eq(crmTask.organizationId, orgId),
          eq(crmTask.contactId, input.fromContactId),
          inArray(crmTask.conversationId, movedSorted),
        ),
      )
      .orderBy(asc(crmTask.id))
      .for("update")
    for (const t of linkedTasks) {
      if (t.opportunityId !== null) reconciledTaskIds.add(t.id)
      else operationalTaskIds.push(t.id)
    }
    if (detachOppIds.length > 0) {
      const detachedOpps = await tx
        .update(opportunity)
        .set({ conversationId: null, updatedAt: new Date() })
        .where(
          and(eq(opportunity.organizationId, orgId), inArray(opportunity.id, [...detachOppIds].sort())),
        )
        .returning({ id: opportunity.id })
      for (const r of detachedOpps) reconciledOpportunityIds.add(r.id)
      // Seguimientos abiertos que espejan el hilo de su oportunidad: se
      // desvinculan también aunque apunten a otro hilo, para que el sync
      // futuro no revincule la conversación antigua.
      const followUps = await tx
        .select({ id: crmTask.id })
        .from(crmTask)
        .where(
          and(
            eq(crmTask.organizationId, orgId),
            inArray(crmTask.opportunityId, [...detachOppIds].sort()),
            eq(crmTask.status, "open"),
            isNotNull(crmTask.conversationId),
          ),
        )
        .orderBy(asc(crmTask.id))
        .for("update")
      for (const f of followUps) reconciledTaskIds.add(f.id)
    }
    if (reconciledTaskIds.size > 0) {
      await tx
        .update(crmTask)
        .set({ conversationId: null, updatedAt: new Date() })
        .where(
          and(eq(crmTask.organizationId, orgId), inArray(crmTask.id, [...reconciledTaskIds].sort())),
        )
    }
  }
  const revokedCount = await revokePendingRegistrationLinks(tx, orgId, input.fromContactId)
  await tx
    .update(contactIdentity)
    .set({ contactId: input.toContactId })
    .where(
      and(eq(contactIdentity.id, lockedIdentity.id), eq(contactIdentity.organizationId, orgId)),
    )
  let movedTasks = 0
  if (movedSorted.length > 0) {
    await tx
      .update(conversation)
      .set({ contactId: input.toContactId, updatedAt: new Date() })
      .where(
        and(eq(conversation.organizationId, orgId), inArray(conversation.id, movedSorted)),
      )
    operationalTaskIds = [...operationalTaskIds].sort()
    if (operationalTaskIds.length > 0) {
      const movedTaskRows = await tx
        .update(crmTask)
        .set({ contactId: input.toContactId, updatedAt: new Date() })
        .where(
          and(
            eq(crmTask.organizationId, orgId),
            eq(crmTask.contactId, input.fromContactId),
            inArray(crmTask.id, operationalTaskIds),
          ),
        )
        .returning({ id: crmTask.id })
      movedTasks = movedTaskRows.length
    }
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
    reconciledOpportunities: reconciledOpportunityIds.size,
    reconciledTasks: reconciledTaskIds.size,
    reconciledOpportunityIds: [...reconciledOpportunityIds].sort(),
    reconciledTaskIds: [...reconciledTaskIds].sort(),
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
    reconciledOpportunities: reconciledOpportunityIds.size,
    reconciledTasks: reconciledTaskIds.size,
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
