import type { Db } from "@odentia/db";
import { serviceCatalog, treatmentTemplate } from "@odentia/db/schema/clinical";
import { auditEvent, orgProfile } from "@odentia/db/schema/org";
import { organization } from "@odentia/db/schema/auth";
import {
  TREATMENT_SCOPES,
  TREATMENT_SPECIALTIES,
  type TreatmentScope,
  type TreatmentSpecialty,
} from "@odentia/clinical";
import { and, asc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js";

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message);
}

export type ServiceRow = typeof serviceCatalog.$inferSelect;
export type TreatmentTemplateRow = typeof treatmentTemplate.$inferSelect;

export const TREATMENT_SOURCES = ["template", "custom", "legacy"] as const;
export type TreatmentSource = (typeof TREATMENT_SOURCES)[number];

export const SERVICE_STATES = ["active", "inactive", "unpriced", "legacy"] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw validation("limit debe ser un entero entre 1 y 100");
  return Math.min(limit, MAX_LIMIT);
}

function encodeCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify({ n: name, i: id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): { name: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { n?: unknown; i?: unknown };
    if (typeof parsed.n !== "string" || typeof parsed.i !== "string") throw new Error("cursor inválido");
    return { name: parsed.n, id: parsed.i };
  } catch {
    throw validation("cursor inválido");
  }
}

/**
 * Código interno de la clínica: trim + mayúsculas, 1–40 sin controles;
 * vacío → null (sin código). La unicidad por organización solo aplica a no nulos.
 */
function normalizeCode(code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const value = code.trim().toUpperCase();
  if (!value) return null;
  if (value.length > 40 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw validation("code debe tener 1–40 caracteres sin controles");
  }
  return value;
}

function assertName(name: string | null | undefined): string {
  const value = name?.trim() ?? "";
  if (!value || value.length > 200) throw validation("name debe tener 1–200 caracteres");
  return value;
}

function assertSpecialty(specialty: string | null | undefined): TreatmentSpecialty {
  const value = (specialty ?? "").trim().toLowerCase();
  if (!(TREATMENT_SPECIALTIES as readonly string[]).includes(value)) {
    throw validation("specialty inválida: usa una especialidad de la biblioteca");
  }
  return value as TreatmentSpecialty;
}

function assertScope(scope: string | null | undefined): TreatmentScope {
  const value = (scope ?? "").trim().toLowerCase();
  if (!(TREATMENT_SCOPES as readonly string[]).includes(value)) {
    throw validation("scope inválido: general|tooth|surfaces|quadrant|arch");
  }
  return value as TreatmentScope;
}

/**
 * null = Sin tarifa (nunca cero implícito); cero solo con ingreso explícito.
 */
function assertPrice(priceCents: number | null | undefined): number | null {
  if (priceCents === null || priceCents === undefined) return null;
  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 2147483647) {
    throw validation("priceCents debe ser un entero >= 0");
  }
  return priceCents;
}

function assertCurrency(currency: string | null | undefined, orgCurrency: string): string {
  const value = currency ?? orgCurrency;
  if (!/^[A-Z]{3}$/.test(value)) throw validation("currency debe ser ISO-4217 de 3 letras mayúsculas");
  return value;
}

function assertDuration(durationMin: number | null | undefined): number | null {
  if (durationMin === null || durationMin === undefined) return null;
  if (!Number.isInteger(durationMin) || durationMin <= 0 || durationMin > 1440) {
    throw validation("durationMin debe ser un entero entre 1 y 1440");
  }
  return durationMin;
}

/** Moneda de la organización (nunca un literal de moneda en el código). */
async function orgCurrency(tx: Db, orgId: string): Promise<string> {
  const [profile] = await tx
    .select({ currency: orgProfile.currency })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1);
  return profile?.currency ?? "PEN";
}

async function requireTemplate(tx: Db, templateId: string): Promise<TreatmentTemplateRow> {
  const [row] = await tx.select().from(treatmentTemplate).where(eq(treatmentTemplate.id, templateId)).limit(1);
  if (!row) throw notFound("Prestación de la biblioteca");
  if (!row.isActive) throw conflict("TEMPLATE_INACTIVE", "La prestación de la biblioteca ya no está vigente");
  return row;
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  action: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx
    .insert(auditEvent)
    .values({ organizationId: orgId, actorUserId, action, entity: "service_catalog", entityId, metadata: metadata ?? null });
}

export interface ListTemplatesQuery {
  q?: string;
  specialty?: string;
  cursor?: string;
  limit?: number;
}

export async function listTemplates(
  tx: Db,
  query: ListTemplatesQuery,
): Promise<{ data: TreatmentTemplateRow[]; nextCursor: string | null }> {
  const limit = clampLimit(query.limit);
  const after = decodeCursor(query.cursor);
  const conditions = [eq(treatmentTemplate.isActive, true)];
  if (query.specialty) {
    conditions.push(eq(treatmentTemplate.specialty, assertSpecialty(query.specialty)));
  }
  const q = query.q?.trim();
  if (q) {
    conditions.push(or(ilike(treatmentTemplate.name, `%${q}%`), ilike(treatmentTemplate.key, `%${q}%`))!);
  }
  if (after) {
    conditions.push(sql`("treatment_template"."name", "treatment_template"."id") > (${after.name}, ${after.id})`);
  }
  const rows = await tx
    .select()
    .from(treatmentTemplate)
    .where(and(...conditions))
    .orderBy(asc(treatmentTemplate.name), asc(treatmentTemplate.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.name, last.id) : null,
  };
}

export interface ListServicesQuery {
  q?: string;
  specialty?: string;
  state?: string;
  cursor?: string;
  limit?: number;
}

export async function listServices(
  tx: Db,
  orgId: string,
  query: ListServicesQuery = {},
): Promise<{ data: ServiceRow[]; nextCursor: string | null }> {
  const limit = clampLimit(query.limit);
  const after = decodeCursor(query.cursor);
  const conditions = [eq(serviceCatalog.organizationId, orgId)];
  if (query.specialty) {
    conditions.push(eq(serviceCatalog.specialty, assertSpecialty(query.specialty)));
  }
  const state = query.state ?? "active";
  if (!(SERVICE_STATES as readonly string[]).includes(state)) {
    throw validation("state debe ser active|inactive|unpriced|legacy");
  }
  if (state === "active") {
    conditions.push(eq(serviceCatalog.isActive, true), ne(serviceCatalog.source, "legacy"));
  } else if (state === "inactive") {
    conditions.push(eq(serviceCatalog.isActive, false), ne(serviceCatalog.source, "legacy"));
  } else if (state === "unpriced") {
    conditions.push(sql`"service_catalog"."price_cents" IS NULL`, ne(serviceCatalog.source, "legacy"));
  } else {
    conditions.push(eq(serviceCatalog.source, "legacy"));
  }
  const q = query.q?.trim();
  if (q) {
    const like = `%${q}%`;
    conditions.push(or(ilike(serviceCatalog.name, like), ilike(serviceCatalog.code, like))!);
  }
  if (after) {
    conditions.push(sql`("service_catalog"."name", "service_catalog"."id") > (${after.name}, ${after.id})`);
  }
  const rows = await tx
    .select()
    .from(serviceCatalog)
    .where(and(...conditions))
    .orderBy(asc(serviceCatalog.name), asc(serviceCatalog.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.name, last.id) : null,
  };
}

export async function requireService(tx: Db, orgId: string, serviceId: string): Promise<ServiceRow> {
  const [row] = await tx
    .select()
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.id, serviceId), eq(serviceCatalog.organizationId, orgId)))
    .limit(1);
  if (!row) throw notFound("Servicio del catálogo");
  return row;
}

/**
 * Oferta utilizable para una nueva indicación: activa, no legado y con tarifa
 * explícita (409 SERVICE_INACTIVE / SERVICE_UNPRICED en caso contrario).
 */
export async function requireServiceForIndication(tx: Db, orgId: string, serviceId: string): Promise<ServiceRow> {
  const row = await requireService(tx, orgId, serviceId);
  if (!row.isActive || row.source === "legacy") {
    throw conflict("SERVICE_INACTIVE", "La prestación no está disponible para nuevas indicaciones");
  }
  if (row.priceCents === null) {
    throw conflict("SERVICE_UNPRICED", "La prestación aún no tiene tarifa configurada");
  }
  return row;
}

export interface CreateServiceInput {
  templateId?: string | null;
  name?: string | null;
  specialty?: string | null;
  scope?: string | null;
  code?: string | null;
  priceCents?: number | null;
  currency?: string | null;
  durationMin?: number | null;
  isActive?: boolean;
}

export async function createService(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateServiceInput,
): Promise<ServiceRow> {
  const currencyDefault = await orgCurrency(tx, orgId);
  let values: typeof serviceCatalog.$inferInsert;
  if (input.templateId) {
    const tpl = await requireTemplate(tx, input.templateId);
    const name = input.name?.trim() ? assertName(input.name) : tpl.name;
    if (input.specialty !== undefined && input.specialty !== null && input.specialty !== tpl.specialty) {
      throw validation("specialty debe coincidir con la plantilla (derivado, no editable)");
    }
    if (input.scope !== undefined && input.scope !== null && input.scope !== tpl.scope) {
      throw validation("scope debe coincidir con la plantilla (derivado, no editable)");
    }
    values = {
      organizationId: orgId,
      templateId: tpl.id,
      source: "template",
      code: normalizeCode(input.code),
      name,
      specialty: tpl.specialty,
      scope: tpl.scope,
      priceCents: assertPrice(input.priceCents),
      currency: assertCurrency(input.currency, currencyDefault),
      durationMin: assertDuration(input.durationMin),
      isActive: input.isActive ?? true,
    };
  } else {
    values = {
      organizationId: orgId,
      templateId: null,
      source: "custom",
      code: normalizeCode(input.code),
      name: assertName(input.name),
      specialty: assertSpecialty(input.specialty),
      scope: assertScope(input.scope),
      priceCents: assertPrice(input.priceCents),
      currency: assertCurrency(input.currency, currencyDefault),
      durationMin: assertDuration(input.durationMin),
      isActive: input.isActive ?? true,
    };
  }
  let row: ServiceRow;
  try {
    const [created] = await tx.insert(serviceCatalog).values(values).returning();
    if (!created) throw new Error("No se pudo crear el servicio");
    row = created;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    throw conflict("DUPLICATE_CODE", "Ya existe una prestación con ese código interno");
  }
  await audit(tx, orgId, actorUserId, "catalog.service_created", row.id, {
    source: row.source,
    templateId: row.templateId,
    code: row.code,
    priceCents: row.priceCents,
    currency: row.currency,
  });
  return row;
}

export interface UpdateServicePatch {
  templateId?: string | null;
  name?: string;
  specialty?: string;
  scope?: string;
  code?: string | null;
  priceCents?: number | null;
  currency?: string;
  durationMin?: number | null;
  isActive?: boolean;
}

export async function updateService(
  tx: Db,
  orgId: string,
  actorUserId: string,
  serviceId: string,
  patch: UpdateServicePatch,
): Promise<ServiceRow> {
  const current = await requireService(tx, orgId, serviceId);
  const currencyDefault = await orgCurrency(tx, orgId);
  const set: Partial<typeof serviceCatalog.$inferInsert> = {};
  const fields: string[] = [];

  if (patch.templateId !== undefined) {
    if (patch.templateId === null) {
      // Independizar la oferta: definición propia completa, sin referencia clínica falsa.
      const name = patch.name !== undefined ? assertName(patch.name) : current.name;
      const specialty =
        patch.specialty !== undefined ? assertSpecialty(patch.specialty) : current.specialty;
      const scope = patch.scope !== undefined ? assertScope(patch.scope) : current.scope;
      if (!specialty || !scope) {
        throw validation("Para independizar la oferta envía su definición completa (nombre, especialidad y ámbito)");
      }
      set.templateId = null;
      set.source = "custom";
      set.name = name;
      set.specialty = specialty;
      set.scope = scope;
      fields.push("templateId:null");
    } else {
      const tpl = await requireTemplate(tx, patch.templateId);
      if (patch.specialty !== undefined && patch.specialty !== tpl.specialty) {
        throw validation("specialty debe coincidir con la plantilla (derivado, no editable)");
      }
      if (patch.scope !== undefined && patch.scope !== tpl.scope) {
        throw validation("scope debe coincidir con la plantilla (derivado, no editable)");
      }
      set.templateId = tpl.id;
      set.source = "template";
      set.specialty = tpl.specialty;
      set.scope = tpl.scope;
      if (patch.name !== undefined) set.name = assertName(patch.name);
      fields.push("templateId");
    }
  } else if (current.source === "template") {
    if (patch.specialty !== undefined || patch.scope !== undefined) {
      throw validation("specialty/scope se derivan de la plantilla; para independizar envía templateId:null");
    }
  }

  if (patch.name !== undefined && patch.templateId === undefined) {
    set.name = assertName(patch.name);
    fields.push("name");
  } else if (patch.name !== undefined && patch.templateId !== undefined && set.name === undefined) {
    set.name = assertName(patch.name);
    fields.push("name");
  }
  if (patch.code !== undefined) {
    set.code = normalizeCode(patch.code);
    fields.push("code");
  }
  if (patch.priceCents !== undefined) {
    set.priceCents = assertPrice(patch.priceCents);
    fields.push("priceCents");
  }
  if (patch.currency !== undefined) {
    set.currency = assertCurrency(patch.currency, currencyDefault);
    fields.push("currency");
  }
  if (patch.durationMin !== undefined) {
    set.durationMin = assertDuration(patch.durationMin);
    fields.push("durationMin");
  }
  if (patch.isActive !== undefined) {
    set.isActive = patch.isActive;
    fields.push("isActive");
  }

  const resolvedSource = (set.source ?? current.source) as string;
  const resolvedSpecialty = (set.specialty ?? current.specialty) as string | null;
  const resolvedScope = (set.scope ?? current.scope) as string | null;
  const resolvedActive = set.isActive ?? current.isActive;
  if (resolvedSource === "legacy") {
    if (resolvedActive) {
      throw conflict("LEGACY_MUST_RESOLVE", "La prestación heredada debe vincularse a una plantilla o confirmarse como propia antes de reactivarse");
    }
  } else if (!resolvedSpecialty || !resolvedScope) {
    throw validation("specialty y scope son obligatorios fuera del legado");
  }
  if (fields.length === 0) throw validation("Sin cambios: patch vacío");

  let updated: ServiceRow | undefined;
  try {
    const [row] = await tx
      .update(serviceCatalog)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(serviceCatalog.id, serviceId), eq(serviceCatalog.organizationId, orgId)))
      .returning();
    updated = row;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    throw conflict("DUPLICATE_CODE", "Ya existe una prestación con ese código interno");
  }
  if (!updated) throw notFound("Servicio del catálogo");
  await audit(tx, orgId, actorUserId, "catalog.service_updated", serviceId, { fields });
  return updated;
}

export interface FromTemplatesResult {
  created: ServiceRow[];
  existing: ServiceRow[];
}

/**
 * Incorpora ofertas base desde la biblioteca: crea solo las faltantes con
 * tarifa nula (Sin tarifa), sin pisar variantes ni precios existentes.
 * Serializa en la fila de organización para evitar duplicados concurrentes.
 */
export async function fromTemplates(
  tx: Db,
  orgId: string,
  actorUserId: string,
  templateIds: string[],
): Promise<FromTemplatesResult> {
  if (!Array.isArray(templateIds) || templateIds.length < 1 || templateIds.length > 100) {
    throw validation("templateIds debe tener entre 1 y 100 identificadores");
  }
  if (new Set(templateIds).size !== templateIds.length) {
    throw validation("templateIds no debe repetirse");
  }
  await tx.execute(sql`select "id" from "organization" where "id" = ${orgId} for update`);
  const templates = await tx.select().from(treatmentTemplate).where(inArray(treatmentTemplate.id, templateIds));
  if (templates.length !== templateIds.length) throw notFound("Prestación de la biblioteca");
  for (const tpl of templates) {
    if (!tpl.isActive) throw conflict("TEMPLATE_INACTIVE", "La prestación de la biblioteca ya no está vigente");
  }
  const owned = await tx
    .select()
    .from(serviceCatalog)
    .where(
      and(
        eq(serviceCatalog.organizationId, orgId),
        eq(serviceCatalog.source, "template"),
        inArray(serviceCatalog.templateId, templateIds),
      ),
    );
  const ownedIds = new Set(owned.map((row) => row.templateId));
  const currencyDefault = await orgCurrency(tx, orgId);
  const missing = templates.filter((tpl) => !ownedIds.has(tpl.id));
  const created: ServiceRow[] = [];
  for (const tpl of missing) {
    const [row] = await tx
      .insert(serviceCatalog)
      .values({
        organizationId: orgId,
        templateId: tpl.id,
        source: "template",
        code: null,
        name: tpl.name,
        specialty: tpl.specialty,
        scope: tpl.scope,
        priceCents: null,
        currency: currencyDefault,
        durationMin: null,
        isActive: true,
      })
      .returning();
    if (!row) throw new Error("No se pudo incorporar la prestación");
    created.push(row);
    await audit(tx, orgId, actorUserId, "catalog.service_created", row.id, {
      source: "template",
      templateId: tpl.id,
      fromLibrary: true,
    });
  }
  return { created, existing: owned };
}

/** Ofertas heredadas pendientes de revisión (legado inactivo). */
export async function listLegacyServices(tx: Db, orgId: string): Promise<ServiceRow[]> {
  return tx
    .select()
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.source, "legacy")))
    .orderBy(asc(serviceCatalog.name), asc(serviceCatalog.id));
}

/** Verdadero si la fila puede ofrecerse en una nueva indicación. */
export function isSelectableForIndication(row: ServiceRow): boolean {
  return row.isActive && row.source !== "legacy" && row.priceCents !== null;
}
