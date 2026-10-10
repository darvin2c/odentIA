import type { Db } from "@odentia/db"
import {
  agentKnowledgeEntry,
  agentKnowledgeRevision,
  type KnowledgeKind,
  type KnowledgeStatus,
} from "@odentia/db/schema/agent"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm"
import { notFound, validation } from "./errors.js"
import { listServices } from "./service-catalog.js"

const KINDS = ["faq", "info_sede", "politica"] as const
const STATUSES = ["borrador", "publicada"] as const
const MAX_LIMIT = 100

export interface KnowledgeEntryItem {
  id: string
  kind: KnowledgeKind
  title: string
  body: string
  branchId: string | null
  branchName: string | null
  status: KnowledgeStatus
  version: number
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

function toItem(
  row: typeof agentKnowledgeEntry.$inferSelect,
  branchName: string | null = null,
): KnowledgeEntryItem {
  return {
    id: row.id,
    kind: row.kind as KnowledgeKind,
    title: row.title,
    body: row.body,
    branchId: row.branchId,
    branchName,
    status: row.status as KnowledgeStatus,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function assertKind(kind: string): asserts kind is KnowledgeKind {
  if (!(KINDS as readonly string[]).includes(kind)) throw validation("kind debe ser faq|info_sede|politica")
}

function assertStatus(status: string): asserts status is KnowledgeStatus {
  if (!(STATUSES as readonly string[]).includes(status)) throw validation("status debe ser borrador|publicada")
}

function cleanText(value: string | undefined, field: string, max: number): string {
  const text = value?.trim() ?? ""
  if (!text) throw validation(`${field} es obligatorio`)
  if (text.length > max) throw validation(`${field} supera ${max} caracteres`)
  return text
}

async function requireBranchOfOrg(tx: Db, orgId: string, branchId: string): Promise<string> {
  const [row] = await tx
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.id, branchId)))
    .limit(1)
  if (!row) throw notFound("Sede")
  return row.name
}

async function audit(tx: Db, orgId: string, actorUserId: string | null, action: string, entityId: string, metadata?: Record<string, unknown>) {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "agent_knowledge_entry",
    entityId,
    metadata,
  })
}

/** Alta de entrada en borrador con su revisión v1. */
export async function createKnowledgeEntry(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  input: { kind: string; title: string; body: string; branchId?: string | null },
): Promise<KnowledgeEntryItem> {
  assertKind(input.kind)
  const title = cleanText(input.title, "El título", 200)
  const body = cleanText(input.body, "El contenido", 8000)
  let branchName: string | null = null
  const branchId = input.branchId ?? null
  if (branchId) branchName = await requireBranchOfOrg(tx, orgId, branchId)
  const [row] = await tx
    .insert(agentKnowledgeEntry)
    .values({ organizationId: orgId, kind: input.kind, title, body, branchId, createdBy: actorUserId })
    .returning()
  if (!row) throw new Error("No se pudo crear la entrada de conocimiento")
  await tx.insert(agentKnowledgeRevision).values({
    organizationId: orgId,
    entryId: row.id,
    version: 1,
    title,
    body,
    createdBy: actorUserId,
  })
  await audit(tx, orgId, actorUserId, "agent.knowledge_created", row.id, { kind: input.kind })
  return toItem(row, branchName)
}

async function requireEntry(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(agentKnowledgeEntry)
    .where(and(eq(agentKnowledgeEntry.organizationId, orgId), eq(agentKnowledgeEntry.id, id)))
    .limit(1)
  if (!row) throw notFound("Entrada de conocimiento")
  return row
}

export async function getKnowledgeEntry(tx: Db, orgId: string, id: string): Promise<KnowledgeEntryItem> {
  const row = await requireEntry(tx, orgId, id)
  let branchName: string | null = null
  if (row.branchId) {
    const [b] = await tx.select({ name: branch.name }).from(branch).where(eq(branch.id, row.branchId)).limit(1)
    branchName = b?.name ?? null
  }
  return toItem(row, branchName)
}

/** Edición: bloquea la fila, congela la versión en revisiones y sube version. */
export async function updateKnowledgeEntry(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  id: string,
  input: { title?: string; body?: string; branchId?: string | null },
): Promise<KnowledgeEntryItem> {
  const [locked] = await tx
    .select()
    .from(agentKnowledgeEntry)
    .where(and(eq(agentKnowledgeEntry.organizationId, orgId), eq(agentKnowledgeEntry.id, id)))
    .for("update")
    .limit(1)
  if (!locked) throw notFound("Entrada de conocimiento")
  const current = locked
  const title = input.title === undefined ? current.title : cleanText(input.title, "El título", 200)
  const body = input.body === undefined ? current.body : cleanText(input.body, "El contenido", 8000)
  let branchId = current.branchId
  let branchName: string | null = null
  if (input.branchId !== undefined) {
    branchId = input.branchId
    if (branchId) branchName = await requireBranchOfOrg(tx, orgId, branchId)
  } else if (branchId) {
    const [b] = await tx.select({ name: branch.name }).from(branch).where(eq(branch.id, branchId)).limit(1)
    branchName = b?.name ?? null
  }
  const version = current.version + 1
  const [row] = await tx
    .update(agentKnowledgeEntry)
    .set({ title, body, branchId, version, updatedAt: new Date() })
    .where(eq(agentKnowledgeEntry.id, id))
    .returning()
  if (!row) throw new Error("No se pudo actualizar la entrada")
  await tx.insert(agentKnowledgeRevision).values({
    organizationId: orgId,
    entryId: id,
    version,
    title,
    body,
    createdBy: actorUserId,
  })
  await audit(tx, orgId, actorUserId, "agent.knowledge_updated", id, { version })
  return toItem(row, branchName)
}

/** Publica o devuelve a borrador. Solo lo publicado alimenta al agente. */
export async function setKnowledgeStatus(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  id: string,
  status: string,
): Promise<KnowledgeEntryItem> {
  assertStatus(status)
  await requireEntry(tx, orgId, id)
  const [row] = await tx
    .update(agentKnowledgeEntry)
    .set({ status, updatedAt: new Date() })
    .where(eq(agentKnowledgeEntry.id, id))
    .returning()
  if (!row) throw new Error("No se pudo cambiar el estado")
  await audit(tx, orgId, actorUserId, "agent.knowledge_status", id, { status })
  return getKnowledgeEntry(tx, orgId, id)
}

export interface ListKnowledgeInput {
  kind?: string
  status?: string
  branchId?: string
  q?: string
  limit?: number
}

export async function listKnowledgeEntries(tx: Db, orgId: string, input: ListKnowledgeInput = {}): Promise<KnowledgeEntryItem[]> {
  const conditions = [eq(agentKnowledgeEntry.organizationId, orgId)]
  if (input.kind) {
    assertKind(input.kind)
    conditions.push(eq(agentKnowledgeEntry.kind, input.kind))
  }
  if (input.status) {
    assertStatus(input.status)
    conditions.push(eq(agentKnowledgeEntry.status, input.status))
  }
  if (input.branchId) conditions.push(eq(agentKnowledgeEntry.branchId, input.branchId))
  const q = input.q?.trim()
  if (q) {
    const like = `%${q}%`
    conditions.push(or(ilike(agentKnowledgeEntry.title, like), ilike(agentKnowledgeEntry.body, like))!)
  }
  const limit = input.limit === undefined ? 50 : Math.min(Math.max(input.limit, 1), MAX_LIMIT)
  const rows = await tx
    .select({ entry: agentKnowledgeEntry, branchName: branch.name })
    .from(agentKnowledgeEntry)
    .leftJoin(branch, eq(branch.id, agentKnowledgeEntry.branchId))
    .where(and(...conditions))
    .orderBy(desc(agentKnowledgeEntry.updatedAt), asc(agentKnowledgeEntry.id))
    .limit(limit)
  return rows.map(({ entry, branchName }) => toItem(entry, branchName))
}

export async function listKnowledgeRevisions(tx: Db, orgId: string, entryId: string) {
  await requireEntry(tx, orgId, entryId)
  const rows = await tx
    .select()
    .from(agentKnowledgeRevision)
    .where(and(eq(agentKnowledgeRevision.organizationId, orgId), eq(agentKnowledgeRevision.entryId, entryId)))
    .orderBy(desc(agentKnowledgeRevision.version))
  return rows.map((r) => ({
    version: r.version,
    title: r.title,
    body: r.body,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  }))
}

/** Búsqueda sobre lo publicado (lo único que el agente puede citar). */
export async function searchPublishedKnowledge(tx: Db, orgId: string, q: string, limit = 5): Promise<KnowledgeEntryItem[]> {
  const query = q.trim()
  if (!query) return []
  const like = `%${query}%`
  const rows = await tx
    .select({ entry: agentKnowledgeEntry, branchName: branch.name })
    .from(agentKnowledgeEntry)
    .leftJoin(branch, eq(branch.id, agentKnowledgeEntry.branchId))
    .where(
      and(
        eq(agentKnowledgeEntry.organizationId, orgId),
        eq(agentKnowledgeEntry.status, "publicada"),
        or(ilike(agentKnowledgeEntry.title, like), ilike(agentKnowledgeEntry.body, like))!,
      ),
    )
    // La coincidencia exacta de título va primero: es como se pide el texto
    // completo de una respuesta que el prompt mostró recortada.
    .orderBy(
      desc(sql`lower(${agentKnowledgeEntry.title}) = lower(${query})`),
      asc(agentKnowledgeEntry.title),
      asc(agentKnowledgeEntry.id),
    )
    .limit(Math.min(Math.max(limit, 1), 10))
  return rows.map(({ entry, branchName }) => toItem(entry, branchName))
}

export interface ClinicInfoSnapshot {
  clinicName: string
  timezone: string
  branches: Array<{ id: string; name: string; address: string | null; phone: string | null; mapsUrl: string | null; timezone: string | null }>
  services: Array<{ id: string; name: string; code: string | null; specialty: string | null; priceCents: number; currency: string; durationMin: number | null }>
}

/**
 * Información de la clínica desde catálogo y sedes (fuente de verdad para el
 * agente: nunca inventa precios ni direcciones).
 */
export async function getClinicInfoSnapshot(tx: Db, orgId: string): Promise<ClinicInfoSnapshot> {
  const [profile] = await tx
    .select({ legalName: orgProfile.legalName, tradeName: orgProfile.tradeName, timezone: orgProfile.timezone })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  const branchRows = await tx
    .select({
      id: branch.id,
      name: branch.name,
      address: branch.addressLine1,
      phone: branch.phone,
      mapsUrl: branch.mapsUrl,
      timezone: branch.timezone,
    })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .orderBy(asc(branch.name), asc(branch.id))
    .limit(20)
  const { data } = await listServices(tx, orgId, { state: "active", limit: 50 })
  return {
    clinicName: profile?.tradeName ?? profile?.legalName ?? "la clínica",
    timezone: profile?.timezone ?? "America/Lima",
    branches: branchRows.map((b) => ({ ...b, address: b.address ?? null })),
    services: data.map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      specialty: s.specialty,
      priceCents: s.priceCents,
      currency: s.currency,
      durationMin: s.durationMin,
    })),
  }
}

/**
 * Tope por respuesta oficial dentro del prompt. El bloque viaja en cada
 * llamada al modelo; una respuesta extensa (un protocolo pegado entero) se
 * recorta con aviso y su texto completo se pide con `consultar_conocimiento`.
 */
export const KNOWLEDGE_PROMPT_ENTRY_CHARS = 600

/** Bloque de sistema con conocimiento vigente + catálogo + sedes. */
export function formatKnowledgeForPrompt(snapshot: ClinicInfoSnapshot, faqs: KnowledgeEntryItem[]): string {
  const lines = [`Clínica: ${snapshot.clinicName}.`]
  if (snapshot.branches.length) {
    lines.push("Sedes:")
    for (const b of snapshot.branches) {
      const parts = [`- ${b.name}`, b.address ? `dir. ${b.address}` : null, b.phone ? `tel. ${b.phone}` : null, b.mapsUrl ? `mapa: ${b.mapsUrl}` : null]
        .filter(Boolean)
        .join(" · ")
      lines.push(parts)
    }
  }
  if (snapshot.services.length) {
    lines.push("Servicios y tarifas vigentes (PEN en céntimos → soles):")
    for (const s of snapshot.services) {
      const soles = (s.priceCents / 100).toFixed(2)
      lines.push(`- ${s.name}: S/ ${soles}${s.durationMin ? ` (${s.durationMin} min)` : ""}`)
    }
  } else {
    lines.push("Sin servicios publicados: no des precios, ofrece derivar.")
  }
  const published = faqs.filter((f) => f.status === "publicada")
  if (published.length) {
    lines.push(
      "Respuestas oficiales (cítalas tal cual; si una aparece recortada, pide su texto completo a consultar_conocimiento con su título exacto antes de citarla):",
    )
    for (const f of published.slice(0, 10)) {
      // El corte no deja medio carácter (un emoji ocupa dos unidades).
      const cut = f.body.slice(0, KNOWLEDGE_PROMPT_ENTRY_CHARS).replace(/[\uD800-\uDBFF]$/, "")
      const body = f.body.length > KNOWLEDGE_PROMPT_ENTRY_CHARS ? `${cut.trimEnd()}… (recortada)` : f.body
      lines.push(`- ${f.title}: ${body}`)
    }
  }
  return lines.join("\n")
}

/** Todo lo publicado (tope 10 por orden de actualización) para el prompt. */
export async function listPublishedForPrompt(tx: Db, orgId: string): Promise<KnowledgeEntryItem[]> {
  return listKnowledgeEntries(tx, orgId, { status: "publicada", limit: 10 })
}
