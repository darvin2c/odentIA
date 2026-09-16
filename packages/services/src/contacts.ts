import type { Db } from "@odentia/db";
import { normalizeTags } from "@odentia/clinical";
import { contact, contactIdentity, conversation, crmTask, customFieldDef, pipelineStage } from "@odentia/db/schema/crm";
import { patient } from "@odentia/db/schema/clinical";
import { and, asc, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "./cursors.js";
import { notFound, validation } from "./errors.js";
import { ensureDefaultPipeline } from "./pipelines.js";

/** Normaliza etiquetas con el helper canónico; convierte Error a ServiceError validation. */
export function normalizeContactTags(tags: readonly string[]): string[] {
  try {
    return normalizeTags(tags);
  } catch (e) {
    throw validation(e instanceof Error ? e.message : "Etiquetas inválidas");
  }
}

const PAGE_DEFAULT = 30;

export interface ContactListItem {
  id: string;
  displayName: string;
  tags: string[];
  stageId: string | null;
  assignedUserId: string | null;
  lastInteractionAt: string | null;
  channels: string[];
}

export interface ContactDetail extends ContactListItem {
  notes: string | null;
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function toListItem(
  row: typeof contact.$inferSelect,
  channels: string[],
): ContactListItem {
  return {
    id: row.id,
    displayName: row.displayName,
    tags: row.tags,
    stageId: row.stageId,
    assignedUserId: row.assignedUserId,
    lastInteractionAt: iso(row.lastInteractionAt),
    channels,
  };
}

export async function listContacts(
  tx: Db,
  orgId: string,
  input: { q?: string; stageId?: string; cursor?: string; limit?: number },
): Promise<{ items: ContactListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? PAGE_DEFAULT, 1), 100);
  const conditions = [eq(contact.organizationId, orgId)];
  if (input.q) conditions.push(ilike(contact.displayName, `%${input.q}%`));
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded) throw validation("Cursor inválido");
    if (decoded.ts === "") {
      // Cola de nulos (NULLS LAST): paginar solo por id.
      conditions.push(sql`"last_interaction_at" is null`);
      conditions.push(lt(contact.id, decoded.id));
    } else {
      const ts = new Date(decoded.ts);
      conditions.push(
        or(
          lt(contact.lastInteractionAt, ts),
          and(eq(contact.lastInteractionAt, ts), lt(contact.id, decoded.id)),
          sql`"last_interaction_at" is null`,
        )!,
      );
    }
  }
  const rows = await tx
    .select()
    .from(contact)
    .where(and(...conditions))
    .orderBy(sql`"last_interaction_at" desc nulls last`, desc(contact.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const identities = page.length
    ? await tx
        .select()
        .from(contactIdentity)
        .where(
          and(
            eq(contactIdentity.organizationId, orgId),
            sql`"contact_id" in (${sql.join(page.map((r) => sql`${r.id}::uuid`), sql`, `)})`,
          ),
        )
    : [];
  const byContact = new Map<string, string[]>();
  for (const ident of identities) {
    const list = byContact.get(ident.contactId) ?? [];
    if (!list.includes(ident.channel)) list.push(ident.channel);
    byContact.set(ident.contactId, list);
  }
  const items = page.map((r) => toListItem(r, byContact.get(r.id) ?? []));
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last ? encodeCursor(last.lastInteractionAt?.toISOString() ?? "", last.id) : null;
  return { items, nextCursor };
}

export interface ContactFull {
  contact: ContactDetail;
  patientId: string | null;
  identities: { id: string; channel: string; externalUserId: string; displayName: string | null }[];
  openTasks: { id: string; title: string; dueAt: string | null; assigneeUserId: string | null }[];
  conversations: { id: string; status: string; lastMessageAt: string | null }[];
}

export async function getContact(tx: Db, orgId: string, id: string): Promise<ContactFull> {
  const [row] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.id, id), eq(contact.organizationId, orgId)))
    .limit(1);
  const [identities, tasks, conversations, patientLink] = await Promise.all([
    tx.select().from(contactIdentity).where(eq(contactIdentity.contactId, id)),
    tx
      .select()
      .from(crmTask)
      .where(and(eq(crmTask.contactId, id), eq(crmTask.status, "open")))
      .orderBy(asc(crmTask.createdAt)),
    tx
      .select()
      .from(conversation)
      .where(eq(conversation.contactId, id))
      .orderBy(sql`"last_message_at" desc nulls last`),
    tx
      .select({ id: patient.id })
      .from(patient)
      .where(and(eq(patient.contactId, id), eq(patient.organizationId, orgId)))
      .limit(1),
  ]);
  const customFields =
    row.customFields && typeof row.customFields === "object" && !Array.isArray(row.customFields)
      ? (row.customFields as Record<string, unknown>)
      : {};
  return {
    contact: {
      ...toListItem(row, [...new Set(identities.map((i) => i.channel))]),
      notes: row.notes,
      customFields,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    patientId: patientLink[0]?.id ?? null,
    identities: identities.map((i) => ({
      id: i.id,
      channel: i.channel,
      externalUserId: i.externalUserId,
      displayName: i.displayName,
    })),
    openTasks: tasks.map((t) => ({ id: t.id, title: t.title, dueAt: iso(t.dueAt), assigneeUserId: t.assigneeUserId })),
    conversations: conversations.map((c) => ({ id: c.id, status: c.status, lastMessageAt: iso(c.lastMessageAt) })),
  };
}

export async function requireContact(tx: Db, orgId: string, id: string): Promise<typeof contact.$inferSelect> {
  const [row] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.id, id), eq(contact.organizationId, orgId)))
    .limit(1);
  if (!row) throw notFound("Contacto");
  return row;
}

async function resolveStageId(tx: Db, orgId: string, stageId: string | undefined): Promise<string> {
  if (stageId) {
    const [stage] = await tx
      .select({ id: pipelineStage.id })
      .from(pipelineStage)
      .where(and(eq(pipelineStage.id, stageId), eq(pipelineStage.organizationId, orgId)))
      .limit(1);
    if (!stage) throw validation("Etapa inválida para esta organización");
    return stage.id;
  }
  const { stages } = await ensureDefaultPipeline(tx, orgId);
  const first = stages[0];
  if (!first) throw new Error("Pipeline default sin etapas");
  return first.id;
}

export async function createContact(
  tx: Db,
  orgId: string,
  input: { displayName: string; notes?: string; tags?: string[]; stageId?: string; assignedUserId?: string | null },
): Promise<ContactDetail> {
  const displayName = input.displayName.trim();
  if (!displayName) throw validation("El nombre del contacto es obligatorio");
  const stageId = await resolveStageId(tx, orgId, input.stageId);
  const [created] = await tx
    .insert(contact)
    .values({
      organizationId: orgId,
      displayName,
      notes: input.notes ?? null,
      tags: normalizeContactTags(input.tags ?? []),
      stageId,
      assignedUserId: input.assignedUserId ?? null,
    })
    .returning();
  if (!created) throw new Error("No se pudo crear el contacto");
  const full = await getContact(tx, orgId, created.id);
  return full.contact;
}

/** Valida custom fields contra las definiciones de la org; descarta claves desconocidas. */
export async function sanitizeCustomFields(
  tx: Db,
  orgId: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const defs = await tx.select().from(customFieldDef).where(eq(customFieldDef.organizationId, orgId));
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const def = byKey.get(key);
    if (!def || value === null || value === undefined) continue;
    switch (def.type) {
      case "text":
        if (typeof value !== "string") throw validation(`Campo ${def.label}: debe ser texto`);
        out[key] = value;
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw validation(`Campo ${def.label}: debe ser número`);
        }
        out[key] = value;
        break;
      case "date":
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
          throw validation(`Campo ${def.label}: debe ser fecha YYYY-MM-DD`);
        }
        out[key] = value;
        break;
      case "select": {
        const options =
          Array.isArray(def.options) && def.options.every((o): o is string => typeof o === "string")
            ? def.options
            : [];
        if (typeof value !== "string" || !options.includes(value)) {
          throw validation(`Campo ${def.label}: valor fuera de opciones`);
        }
        out[key] = value;
        break;
      }
      default:
        throw validation(`Campo ${def.label}: tipo desconocido`);
    }
  }
  return out;
}

export async function updateContact(
  tx: Db,
  orgId: string,
  id: string,
  input: {
    displayName?: string;
    notes?: string | null;
    tags?: string[];
    stageId?: string;
    assignedUserId?: string | null;
    customFields?: Record<string, unknown>;
  },
): Promise<ContactDetail> {
  await requireContact(tx, orgId, id);
  const patch: Partial<typeof contact.$inferInsert> = { updatedAt: new Date() };
  if (input.displayName !== undefined) {
    const displayName = input.displayName.trim();
    if (!displayName) throw validation("El nombre del contacto es obligatorio");
    patch.displayName = displayName;
  }
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.tags !== undefined) patch.tags = normalizeContactTags(input.tags);
  if (input.stageId !== undefined) patch.stageId = await resolveStageId(tx, orgId, input.stageId);
  if (input.assignedUserId !== undefined) patch.assignedUserId = input.assignedUserId;
  if (input.customFields !== undefined) patch.customFields = await sanitizeCustomFields(tx, orgId, input.customFields);
  await tx.update(contact).set(patch).where(and(eq(contact.id, id), eq(contact.organizationId, orgId)));
  const full = await getContact(tx, orgId, id);
  return full.contact;
}

export async function setStage(tx: Db, orgId: string, contactId: string, stageId: string): Promise<void> {
  await requireContact(tx, orgId, contactId);
  const resolved = await resolveStageId(tx, orgId, stageId);
  await tx
    .update(contact)
    .set({ stageId: resolved, updatedAt: new Date() })
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)));
}
