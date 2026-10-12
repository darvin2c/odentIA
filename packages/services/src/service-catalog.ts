import {
  TREATMENT_SCOPES,
  TREATMENT_SPECIALTIES,
  type ProcedureCodingSnapshot,
  type TreatmentScope,
  type TreatmentSpecialty,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  procedureCode,
  serviceCatalog,
  treatmentTemplate,
  treatmentTemplateCode,
} from "@odentia/db/schema/clinical"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { orgProfileRequired } from "./locale.js"
import {
  currentCatalogRelease,
  resolveSingleTemplateCoding,
  type CatalogRelease,
} from "./procedure-codings.js"

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

export type ServiceRow = typeof serviceCatalog.$inferSelect
export type TreatmentTemplateRow = typeof treatmentTemplate.$inferSelect


export const SERVICE_STATES = ["active", "inactive", "legacy"] as const

const MAX_LIMIT = 100
const DEFAULT_LIMIT = 30

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0)
    throw validation("limit debe ser un entero entre 1 y 100")
  return Math.min(limit, MAX_LIMIT)
}

function encodeCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify({ n: name, i: id }), "utf8").toString("base64url")
}

function decodeCursor(cursor: string | undefined): { name: string; id: string } | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      n?: unknown
      i?: unknown
    }
    if (typeof parsed.n !== "string" || typeof parsed.i !== "string")
      throw new Error("cursor inválido")
    return { name: parsed.n, id: parsed.i }
  } catch {
    throw validation("cursor inválido")
  }
}

/**
 * Código interno de la clínica: trim + mayúsculas, 1–40 sin controles;
 * vacío → null (sin código). La unicidad por organización solo aplica a no nulos.
 */
function normalizeCode(code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null
  const value = code.trim().toUpperCase()
  if (!value) return null
  if (value.length > 40 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw validation("code debe tener 1–40 caracteres sin controles")
  }
  return value
}

function assertName(name: string | null | undefined): string {
  const value = name?.trim() ?? ""
  if (!value || value.length > 200) throw validation("name debe tener 1–200 caracteres")
  return value
}

function assertSpecialty(specialty: string | null | undefined): TreatmentSpecialty {
  const value = (specialty ?? "").trim().toLowerCase()
  if (!(TREATMENT_SPECIALTIES as readonly string[]).includes(value)) {
    throw validation("specialty inválida: usa una especialidad de la biblioteca")
  }
  return value as TreatmentSpecialty
}

export const BILLING_MODES = ["treatment", "session"] as const
export type BillingMode = (typeof BILLING_MODES)[number]

/**
 * Cómo se cobra la oferta: 'treatment' una vez por tratamiento, 'session' el
 * precio en cada visita atendida. Lo que está en curso usa el snapshot
 * congelado; cambiar el modo solo afecta lo nuevo.
 */
export function assertBillingMode(mode: string | null | undefined): BillingMode {
  const value = (mode ?? "treatment").trim().toLowerCase()
  if (value !== "treatment" && value !== "session") {
    throw validation("billingMode inválido: treatment|session")
  }
  return value
}

function assertScope(scope: string | null | undefined): TreatmentScope {
   const value = (scope ?? "").trim().toLowerCase()
   if (!(TREATMENT_SCOPES as readonly string[]).includes(value)) {
     throw validation("scope inválido: general|tooth|surfaces|quadrant|arch")
   }
   return value as TreatmentScope
 }

/**
 * Toda oferta tiene tarifa explícita: 0 = incluido sin costo. Nunca null.
 */
function assertPrice(priceCents: number | null | undefined): number {
  if (priceCents === null || priceCents === undefined) {
    throw validation("priceCents es obligatorio (0 si no tiene costo)")
  }
  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 2147483647) {
    throw validation("priceCents debe ser un entero >= 0")
  }
  return priceCents
}

function assertCurrency(currency: string): string {
  if (!/^[A-Z]{3}$/.test(currency))
    throw validation("currency debe ser ISO-4217 de 3 letras mayúsculas")
  return currency
}

function assertDuration(durationMin: number | null | undefined): number | null {
  if (durationMin === null || durationMin === undefined) return null
  if (!Number.isInteger(durationMin) || durationMin <= 0 || durationMin > 1440) {
    throw validation("durationMin debe ser un entero entre 1 y 1440")
  }
  return durationMin
}

/**
 * Moneda de la organización. Sin perfil regional no se asume la de ningún
 * país: poner precio a un servicio exige haber configurado la clínica.
 */
async function orgCurrency(tx: Db, orgId: string): Promise<string> {
  const [profile] = await tx
    .select({ currency: orgProfile.currency })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  if (!profile) throw orgProfileRequired()
  return profile.currency
}

async function requireTemplate(tx: Db, templateId: string): Promise<TreatmentTemplateRow> {
  const [row] = await tx
    .select()
    .from(treatmentTemplate)
    .where(eq(treatmentTemplate.id, templateId))
    .limit(1)
  if (!row) throw notFound("Prestación de la biblioteca")
  if (!row.isActive)
    throw conflict("TEMPLATE_INACTIVE", "La prestación de la biblioteca ya no está vigente")
  return row
}
/**
 * Detalle exacto read-only de una plantilla por id, sin exigir vigencia:
 * incluye retiradas (`isActive: false`) y sus versiones. Solo lectura para
 * fichas enlazadas (ofertas/históricos); las nuevas indicaciones siguen
 * pasando por `requireServiceForIndication` + snapshot único vigente.
 */
export async function getTemplate(
  tx: Db,
  templateId: string,
): Promise<TreatmentTemplateRow & { codings: ProcedureCodingSnapshot[] }> {
  const [row] = await tx
    .select()
    .from(treatmentTemplate)
    .where(eq(treatmentTemplate.id, templateId))
    .limit(1)
  if (!row) throw notFound("Prestación de la biblioteca")
  const mappings = await tx
    .select({
      system: treatmentTemplateCode.systemKey,
      code: treatmentTemplateCode.code,
      version: treatmentTemplateCode.version,
      display: procedureCode.display,
    })
    .from(treatmentTemplateCode)
    .innerJoin(
      procedureCode,
      and(
        eq(treatmentTemplateCode.systemKey, procedureCode.systemKey),
        eq(treatmentTemplateCode.code, procedureCode.code),
        eq(treatmentTemplateCode.version, procedureCode.version),
      ),
    )
    .where(eq(treatmentTemplateCode.templateId, templateId))
    .orderBy(desc(treatmentTemplateCode.isPrimary), treatmentTemplateCode.systemKey)
  return { ...row, codings: mappings }
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  action: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "service_catalog",
    entityId,
    metadata: metadata ?? null,
  })
}

export interface ListTemplatesQuery {
  q?: string
  specialty?: string
  cursor?: string
  limit?: number
}

export interface TemplateCatalogInfo {
  system: string
  version: string
  scope: string
  sourceUrl: string
  sourceSha256: string
  expectedCount: number
  availableCount: number
}

export async function listTemplates(
  tx: Db,
  query: ListTemplatesQuery,
): Promise<{
  data: Array<TreatmentTemplateRow & { codings: ProcedureCodingSnapshot[] }>
  nextCursor: string | null
  total: number
  catalog: TemplateCatalogInfo | null
}> {
  const limit = clampLimit(query.limit)
  const after = decodeCursor(query.cursor)
  const release: CatalogRelease | null = await currentCatalogRelease(tx)
  if (!release) return { data: [], nextCursor: null, total: 0, catalog: null }
  const baseConditions = [
    eq(treatmentTemplate.isActive, true),
    eq(treatmentTemplateCode.isPrimary, true),
    eq(procedureCode.systemKey, release.system),
    eq(procedureCode.version, release.version),
    eq(procedureCode.isActive, true),
  ]
  const availableWhere = and(...baseConditions)
  if (query.specialty) {
    baseConditions.push(eq(treatmentTemplate.specialty, assertSpecialty(query.specialty)))
  }
  const q = query.q?.trim()
  const searchCond = q
    ? or(
        ilike(treatmentTemplate.name, `%${q}%`),
        ilike(treatmentTemplate.key, `%${q}%`),
        ilike(procedureCode.code, `%${q}%`),
        ilike(procedureCode.display, `%${q}%`),
      )!
    : undefined
  const filteredWhere = searchCond ? and(...baseConditions, searchCond) : and(...baseConditions)
  const totalRows = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(treatmentTemplate)
    .innerJoin(treatmentTemplateCode, eq(treatmentTemplateCode.templateId, treatmentTemplate.id))
    .innerJoin(
      procedureCode,
      and(
        eq(treatmentTemplateCode.systemKey, procedureCode.systemKey),
        eq(treatmentTemplateCode.code, procedureCode.code),
        eq(treatmentTemplateCode.version, procedureCode.version),
      ),
    )
    .where(filteredWhere)
  const total = totalRows[0]?.total ?? 0
  const availableRows = await tx
    .select({ availableCount: sql<number>`count(*)::int` })
    .from(treatmentTemplate)
    .innerJoin(treatmentTemplateCode, eq(treatmentTemplateCode.templateId, treatmentTemplate.id))
    .innerJoin(
      procedureCode,
      and(
        eq(treatmentTemplateCode.systemKey, procedureCode.systemKey),
        eq(treatmentTemplateCode.code, procedureCode.code),
        eq(treatmentTemplateCode.version, procedureCode.version),
      ),
    )
    .where(availableWhere)
  const availableCount = availableRows[0]?.availableCount ?? 0
  const cursorCond = after
    ? sql`("treatment_template"."name", "treatment_template"."id") > (${after.name}, ${after.id})`
    : undefined
  const pageWhere = cursorCond ? and(filteredWhere, cursorCond) : filteredWhere
  const rows = await tx
    .select({
      id: treatmentTemplate.id,
      key: treatmentTemplate.key,
      name: treatmentTemplate.name,
      specialty: treatmentTemplate.specialty,
      scope: treatmentTemplate.scope,
      surfaceCountMin: treatmentTemplate.surfaceCountMin,
      surfaceCountMax: treatmentTemplate.surfaceCountMax,
      isActive: treatmentTemplate.isActive,
      version: treatmentTemplate.version,
      code: procedureCode.code,
      codeVersion: procedureCode.version,
      display: procedureCode.display,
    })
    .from(treatmentTemplate)
    .innerJoin(treatmentTemplateCode, eq(treatmentTemplateCode.templateId, treatmentTemplate.id))
    .innerJoin(
      procedureCode,
      and(
        eq(treatmentTemplateCode.systemKey, procedureCode.systemKey),
        eq(treatmentTemplateCode.code, procedureCode.code),
        eq(treatmentTemplateCode.version, procedureCode.version),
      ),
    )
    .where(pageWhere)
    .orderBy(asc(treatmentTemplate.name), asc(treatmentTemplate.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    data: page.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      specialty: row.specialty,
      scope: row.scope,
      surfaceCountMin: row.surfaceCountMin,
      surfaceCountMax: row.surfaceCountMax,
      isActive: row.isActive,
      version: row.version,
      codings: [
        { system: release.system, code: row.code, version: row.codeVersion, display: row.display },
      ],
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.name, last.id) : null,
    total,
    catalog: {
      system: release.system,
      version: release.version,
      scope: release.scope,
      sourceUrl: release.sourceUrl,
      sourceSha256: release.sourceSha256,
      expectedCount: release.expectedCount,
      availableCount,
    },
  }
}

export interface ListServicesQuery {
  q?: string
  specialty?: string
  state?: string
  cursor?: string
  limit?: number
}

export async function listServices(
  tx: Db,
  orgId: string,
  query: ListServicesQuery = {},
): Promise<{ data: ServiceRow[]; nextCursor: string | null }> {
  const limit = clampLimit(query.limit)
  const after = decodeCursor(query.cursor)
  const conditions = [eq(serviceCatalog.organizationId, orgId)]
  if (query.specialty) {
    conditions.push(eq(serviceCatalog.specialty, assertSpecialty(query.specialty)))
  }
  const state = query.state ?? "active"
  if (!(SERVICE_STATES as readonly string[]).includes(state)) {
    throw validation("state debe ser active|inactive|legacy")
  }
  if (state === "active") {
    conditions.push(eq(serviceCatalog.isActive, true), ne(serviceCatalog.source, "legacy"))
  } else if (state === "inactive") {
    conditions.push(eq(serviceCatalog.isActive, false), ne(serviceCatalog.source, "legacy"))
  } else {
    conditions.push(eq(serviceCatalog.source, "legacy"))
  }
  const q = query.q?.trim()
  if (q) {
    const like = `%${q}%`
    conditions.push(or(ilike(serviceCatalog.name, like), ilike(serviceCatalog.code, like))!)
  }
  if (after) {
    conditions.push(
      sql`("service_catalog"."name", "service_catalog"."id") > (${after.name}, ${after.id})`,
    )
  }
  const rows = await tx
    .select()
    .from(serviceCatalog)
    .where(and(...conditions))
    .orderBy(asc(serviceCatalog.name), asc(serviceCatalog.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    data: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.name, last.id) : null,
  }
}

export async function requireService(
  tx: Db,
  orgId: string,
  serviceId: string,
): Promise<ServiceRow> {
  const [row] = await tx
    .select()
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.id, serviceId), eq(serviceCatalog.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Servicio del catálogo")
  return row
}

/**
 * Oferta utilizable para una nueva indicación: activa, no legado, con tarifa
 * explícita y proyección oficial vigente (409 SERVICE_INACTIVE /
 * SERVICE_UNPRICED / TEMPLATE_INACTIVE / CODING_AMBIGUOUS en caso contrario).
 * Las ofertas propias (`custom`, sin plantilla) conservan snapshot `[]`.
 */
export async function requireServiceForIndication(
  tx: Db,
  orgId: string,
  serviceId: string,
): Promise<ServiceRow> {
  const row = await requireService(tx, orgId, serviceId)
  if (!row.isActive || row.source === "legacy") {
    throw conflict("SERVICE_INACTIVE", "La prestación no está disponible para nuevas indicaciones")
  }
  if (row.templateId) {
    await resolveSingleTemplateCoding(tx, row.templateId)
  }
  return row
}

export interface CreateServiceInput {
  templateId?: string | null
  name?: string | null
  specialty?: string | null
  scope?: string | null
  code?: string | null
  priceCents?: number | null
  currency?: string | null
  durationMin?: number | null
  billingMode?: string | null
  isActive?: boolean
}

export async function createService(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateServiceInput,
): Promise<ServiceRow> {
  // La moneda viaja siempre explícita: la indicada o la de la clínica (la
  // columna no tiene valor por defecto).
  const currency = assertCurrency(input.currency ?? (await orgCurrency(tx, orgId)))
  let values: typeof serviceCatalog.$inferInsert
  if (input.templateId) {
    const tpl = await requireTemplate(tx, input.templateId)
    await resolveSingleTemplateCoding(tx, tpl.id)
    const name = input.name?.trim() ? assertName(input.name) : tpl.name
    if (
      input.specialty !== undefined &&
      input.specialty !== null &&
      input.specialty !== tpl.specialty
    ) {
      throw validation("specialty debe coincidir con la plantilla (derivado, no editable)")
    }
    if (input.scope !== undefined && input.scope !== null && input.scope !== tpl.scope) {
      throw validation("scope debe coincidir con la plantilla (derivado, no editable)")
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
      currency,
      durationMin: assertDuration(input.durationMin),
      billingMode: assertBillingMode(input.billingMode),
      isActive: input.isActive ?? true,
    }
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
      currency,
      durationMin: assertDuration(input.durationMin),
      billingMode: assertBillingMode(input.billingMode),
      isActive: input.isActive ?? true,
    }
  }
  let row: ServiceRow
  try {
    const [created] = await tx.insert(serviceCatalog).values(values).returning()
    if (!created) throw new Error("No se pudo crear el servicio")
    row = created
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    throw conflict("DUPLICATE_CODE", "Ya existe una prestación con ese código interno")
  }
  await audit(tx, orgId, actorUserId, "catalog.service_created", row.id, {
    source: row.source,
    templateId: row.templateId,
    code: row.code,
    priceCents: row.priceCents,
    currency: row.currency,
  })
  return row
}

export interface UpdateServicePatch {
  templateId?: string | null
  name?: string
  specialty?: string
  scope?: string
  code?: string | null
  priceCents?: number | null
  currency?: string
  durationMin?: number | null
  billingMode?: string
  isActive?: boolean
}

export async function updateService(
  tx: Db,
  orgId: string,
  actorUserId: string,
  serviceId: string,
  patch: UpdateServicePatch,
): Promise<ServiceRow> {
  const current = await requireService(tx, orgId, serviceId)
  const set: Partial<typeof serviceCatalog.$inferInsert> = {}
  const fields: string[] = []

  if (patch.templateId !== undefined) {
    if (patch.templateId === null) {
      // Independizar la oferta: definición propia completa, sin referencia clínica falsa.
      const name = patch.name !== undefined ? assertName(patch.name) : current.name
      const specialty =
        patch.specialty !== undefined ? assertSpecialty(patch.specialty) : current.specialty
      const scope = patch.scope !== undefined ? assertScope(patch.scope) : current.scope
      if (!specialty || !scope) {
        throw validation(
          "Para independizar la oferta envía su definición completa (nombre, especialidad y ámbito)",
        )
      }
      set.templateId = null
      set.source = "custom"
      set.name = name
      set.specialty = specialty
      set.scope = scope
      fields.push("templateId:null")
    } else {
      const tpl = await requireTemplate(tx, patch.templateId)
      await resolveSingleTemplateCoding(tx, tpl.id)
      if (patch.specialty !== undefined && patch.specialty !== tpl.specialty) {
        throw validation("specialty debe coincidir con la plantilla (derivado, no editable)")
      }
      if (patch.scope !== undefined && patch.scope !== tpl.scope) {
        throw validation("scope debe coincidir con la plantilla (derivado, no editable)")
      }
      set.templateId = tpl.id
      set.source = "template"
      set.specialty = tpl.specialty
      set.scope = tpl.scope
      if (patch.name !== undefined) set.name = assertName(patch.name)
      fields.push("templateId")
    }
  } else if (current.source === "template") {
    if (patch.specialty !== undefined || patch.scope !== undefined) {
      throw validation(
        "specialty/scope se derivan de la plantilla; para independizar envía templateId:null",
      )
    }
  }

  if (patch.name !== undefined && patch.templateId === undefined) {
    set.name = assertName(patch.name)
    fields.push("name")
  } else if (patch.name !== undefined && patch.templateId !== undefined && set.name === undefined) {
    set.name = assertName(patch.name)
    fields.push("name")
  }
  if (patch.code !== undefined) {
    set.code = normalizeCode(patch.code)
    fields.push("code")
  }
  if (patch.priceCents !== undefined) {
    set.priceCents = assertPrice(patch.priceCents)
    fields.push("priceCents")
  }
  if (patch.currency !== undefined) {
    set.currency = assertCurrency(patch.currency)
    fields.push("currency")
  }
  if (patch.durationMin !== undefined) {
    set.durationMin = assertDuration(patch.durationMin)
    fields.push("durationMin")
  }
  if (patch.billingMode !== undefined) {
    set.billingMode = assertBillingMode(patch.billingMode)
    fields.push("billingMode")
  }
  if (patch.isActive !== undefined) {
    set.isActive = patch.isActive
    fields.push("isActive")
  }

  const resolvedSource = (set.source ?? current.source) as string
  const resolvedSpecialty = (set.specialty ?? current.specialty) as string | null
  const resolvedScope = (set.scope ?? current.scope) as string | null
  const resolvedActive = set.isActive ?? current.isActive
  if (resolvedSource === "legacy") {
    if (resolvedActive) {
      throw conflict(
        "LEGACY_MUST_RESOLVE",
        "La prestación heredada debe vincularse a una plantilla o confirmarse como propia antes de reactivarse",
      )
    }
  } else if (!resolvedSpecialty || !resolvedScope) {
    throw validation("specialty y scope son obligatorios fuera del legado")
  }
  if (fields.length === 0) throw validation("Sin cambios: patch vacío")

  let updated: ServiceRow | undefined
  try {
    const [row] = await tx
      .update(serviceCatalog)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(serviceCatalog.id, serviceId), eq(serviceCatalog.organizationId, orgId)))
      .returning()
    updated = row
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    throw conflict("DUPLICATE_CODE", "Ya existe una prestación con ese código interno")
  }
  if (!updated) throw notFound("Servicio del catálogo")
  await audit(tx, orgId, actorUserId, "catalog.service_updated", serviceId, { fields })
  return updated
}

export interface FromTemplatesResult {
  created: ServiceRow[]
  existing: ServiceRow[]
}

export interface FromTemplateItem {
  templateId: string
  /** Nombre con el que la clínica lo ofrece; sin él rige la denominación de la biblioteca. */
  name?: string | null
  /** Tarifa explícita en unidad menor; 0 = incluido sin costo. Nunca null. */
  priceCents: number
  billingMode?: string | null
  durationMin?: number | null
}

/**
 * Carga rápida del tarifario en una pantalla: se eligen prestaciones de la
 * biblioteca con su nombre, su precio y cómo se cobran, y quedan activas en el
 * mismo acto. Sin alta diferida: no se crean ofertas inactivas con tarifa 0.
 * El nombre es el comercial de la clínica; el código oficial no se altera.
 * Serializa en la fila de organización para evitar duplicados concurrentes.
 */
export async function fromTemplates(
  tx: Db,
  orgId: string,
  actorUserId: string,
  items: FromTemplateItem[],
): Promise<FromTemplatesResult> {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw validation("items debe tener entre 1 y 100 prestaciones con su precio")
  }
  const ids = items.map((item) => item.templateId)
  if (new Set(ids).size !== ids.length) {
    throw validation("templateId no debe repetirse")
  }
  await tx.execute(sql`select "id" from "organization" where "id" = ${orgId} for update`)
  const templates = await tx
    .select()
    .from(treatmentTemplate)
    .where(inArray(treatmentTemplate.id, ids))
  if (templates.length !== ids.length) throw notFound("Prestación de la biblioteca")
  for (const tpl of templates) {
    if (!tpl.isActive)
      throw conflict("TEMPLATE_INACTIVE", "La prestación de la biblioteca ya no está vigente")
    await resolveSingleTemplateCoding(tx, tpl.id)
  }
  const byId = new Map(templates.map((tpl) => [tpl.id, tpl]))
  const owned = await tx
    .select()
    .from(serviceCatalog)
    .where(
      and(
        eq(serviceCatalog.organizationId, orgId),
        eq(serviceCatalog.source, "template"),
        inArray(serviceCatalog.templateId, ids),
      ),
    )
  const ownedIds = new Set(owned.map((row) => row.templateId))
  // Moneda explícita de la clínica: la columna no tiene valor por defecto.
  const currency = await orgCurrency(tx, orgId)
  const created: ServiceRow[] = []
  for (const item of items) {
    if (ownedIds.has(item.templateId)) continue
    const tpl = byId.get(item.templateId)
    if (!tpl) throw notFound("Prestación de la biblioteca")
    const [row] = await tx
      .insert(serviceCatalog)
      .values({
        organizationId: orgId,
        templateId: tpl.id,
        source: "template",
        code: null,
        name: item.name?.trim() ? assertName(item.name) : tpl.name,
        specialty: tpl.specialty,
        scope: tpl.scope,
        priceCents: assertPrice(item.priceCents),
        currency,
        durationMin: assertDuration(item.durationMin),
        billingMode: assertBillingMode(item.billingMode),
        isActive: true,
      })
      .returning()
    if (!row) throw new Error("No se pudo incorporar la prestación")
    created.push(row)
    await audit(tx, orgId, actorUserId, "catalog.service_created", row.id, {
      source: "template",
      templateId: tpl.id,
      fromLibrary: true,
      priceCents: row.priceCents,
      billingMode: row.billingMode,
    })
  }
  return { created, existing: owned }
}

/** Servicio propio dentro de la carga rápida: sin plantilla ni código oficial. */
export interface CustomServiceItem {
  name: string
  specialty: string
  scope: string
  /** Tarifa explícita en unidad menor; 0 = incluido sin costo. */
  priceCents: number
  billingMode?: string | null
  durationMin?: number | null
}

export type QuickAddServiceItem =
  | ({ kind: "template" } & FromTemplateItem)
  | ({ kind: "custom" } & CustomServiceItem)

/**
 * «Agregar servicios» en un solo acto: lo elegido de la biblioteca y los
 * servicios propios se guardan juntos y quedan activos, o no se guarda nada
 * (la transacción es de quien llama). Compone las dos altas existentes: aquí
 * no hay otra regla de precio, moneda ni código.
 */
export async function quickAddServices(
  tx: Db,
  orgId: string,
  actorUserId: string,
  items: QuickAddServiceItem[],
): Promise<FromTemplatesResult> {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw validation("items debe tener entre 1 y 100 servicios con su precio")
  }
  const fromLibrary: FromTemplateItem[] = []
  const custom: CustomServiceItem[] = []
  for (const item of items) {
    if (item.kind === "template") fromLibrary.push(item)
    else custom.push(item)
  }
  const result: FromTemplatesResult =
    fromLibrary.length > 0
      ? await fromTemplates(tx, orgId, actorUserId, fromLibrary)
      : { created: [], existing: [] }
  for (const item of custom) {
    result.created.push(
      await createService(tx, orgId, actorUserId, {
        name: item.name,
        specialty: item.specialty,
        scope: item.scope,
        priceCents: item.priceCents,
        billingMode: item.billingMode,
        durationMin: item.durationMin,
        isActive: true,
      }),
    )
  }
  return result
}

/**
 * Concepto de «Más usados»: lo que casi toda clínica ofrece, dicho con
 * vocabulario clínico general y no con el código de un catálogo. `phrases` va
 * en orden de preferencia; una frase casa cuando el nombre de la plantilla
 * contiene todas sus raíces (sin tildes ni mayúsculas). `specialties` acota el
 * área, para que «limpieza» no traiga la limpieza de una prótesis.
 */
export interface StarterConcept {
  key: string
  label: string
  phrases: readonly (readonly [string, ...string[]])[]
  specialties?: readonly TreatmentSpecialty[]
}

export const STARTER_CONCEPTS: readonly StarterConcept[] = [
  {
    key: "consulta",
    label: "Consulta",
    phrases: [["consulta"], ["evaluacion"]],
    specialties: ["diagnostico", "general"],
  },
  {
    key: "radiografia",
    label: "Radiografía",
    phrases: [["radiograf"]],
    specialties: ["diagnostico"],
  },
  {
    key: "profilaxis",
    label: "Limpieza (profilaxis)",
    phrases: [["profilaxis"], ["limpieza"], ["destartraje"]],
    specialties: ["prevencion", "periodoncia"],
  },
  { key: "fluor", label: "Flúor", phrases: [["fluor"]], specialties: ["prevencion"] },
  {
    key: "sellante",
    label: "Sellante",
    phrases: [["sellante"]],
    specialties: ["prevencion", "restauradora", "odontopediatria"],
  },
  {
    key: "resina",
    label: "Resina",
    phrases: [["restauracion", "resina"], ["resina"]],
    specialties: ["restauradora"],
  },
  {
    key: "endodoncia",
    label: "Endodoncia",
    phrases: [["endodon"], ["conducto"]],
    specialties: ["endodoncia"],
  },
  {
    key: "exodoncia",
    label: "Extracción (exodoncia)",
    phrases: [["exodoncia"], ["extraccion"]],
    specialties: ["cirugia"],
  },
  { key: "corona", label: "Corona", phrases: [["corona"]], specialties: ["protesis"] },
  {
    key: "implante",
    label: "Implante",
    phrases: [["implante"]],
    specialties: ["implantologia"],
  },
  {
    key: "ortodoncia",
    label: "Ortodoncia y controles",
    phrases: [["control", "ortodon"], ["ortodon"]],
    specialties: ["ortodoncia"],
  },
  { key: "blanqueamiento", label: "Blanqueamiento", phrases: [["blanqueamiento"]] },
]

/**
 * Pares para `translate()`: la biblioteca escribe «Restauracion» y
 * «Radiografía». Incluye las mayúsculas porque `lower()` solo las convierte si
 * la base tiene una configuración regional que las conozca.
 */
const FOLD_FROM = "áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ"
const FOLD_TO = "aaaaaeeeeiiiiooooouuuuncaaaaaeeeeiiiiooooouuuunc"

/** Minúsculas y sin tildes, igual que el filtro de la consulta. */
function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
}

export type LibraryTemplate = TreatmentTemplateRow & { codings: ProcedureCodingSnapshot[] }

export interface StarterSuggestion {
  key: string
  label: string
  templates: LibraryTemplate[]
}

/**
 * «Más usados»: punto de partida para una clínica que aún no tiene tarifario.
 * Resuelve cada concepto contra la biblioteca disponible para la clínica (la
 * misma que lista `listTemplates`) y devuelve, por concepto, las plantillas que
 * casan y que la clínica todavía no incorporó. Un concepto que la biblioteca no
 * tiene —o que ya está entero en el tarifario— no aparece; sin biblioteca la
 * lista queda vacía y la clínica crea sus servicios propios.
 */
export async function listMostUsedServices(
  tx: Db,
  orgId: string,
  options: { perConcept?: number } = {},
): Promise<StarterSuggestion[]> {
  const perConcept = options.perConcept ?? 3
  if (!Number.isInteger(perConcept) || perConcept < 1 || perConcept > 10) {
    throw validation("perConcept debe ser un entero entre 1 y 10")
  }
  const release = await currentCatalogRelease(tx)
  if (!release) return []
  // Toda frase exige su primera raíz: basta con ella para acotar en la base.
  const stems = [
    ...new Set(STARTER_CONCEPTS.flatMap((concept) => concept.phrases.map((phrase) => phrase[0]))),
  ]
  const folded = sql`translate(lower(${treatmentTemplate.name}), ${FOLD_FROM}, ${FOLD_TO})`
  const rows = await tx
    .select({
      id: treatmentTemplate.id,
      key: treatmentTemplate.key,
      name: treatmentTemplate.name,
      specialty: treatmentTemplate.specialty,
      scope: treatmentTemplate.scope,
      surfaceCountMin: treatmentTemplate.surfaceCountMin,
      surfaceCountMax: treatmentTemplate.surfaceCountMax,
      isActive: treatmentTemplate.isActive,
      version: treatmentTemplate.version,
      code: procedureCode.code,
      codeVersion: procedureCode.version,
      display: procedureCode.display,
    })
    .from(treatmentTemplate)
    .innerJoin(treatmentTemplateCode, eq(treatmentTemplateCode.templateId, treatmentTemplate.id))
    .innerJoin(
      procedureCode,
      and(
        eq(treatmentTemplateCode.systemKey, procedureCode.systemKey),
        eq(treatmentTemplateCode.code, procedureCode.code),
        eq(treatmentTemplateCode.version, procedureCode.version),
      ),
    )
    .where(
      and(
        eq(treatmentTemplate.isActive, true),
        eq(treatmentTemplateCode.isPrimary, true),
        eq(procedureCode.systemKey, release.system),
        eq(procedureCode.version, release.version),
        eq(procedureCode.isActive, true),
        or(...stems.map((stem) => sql`${folded} like ${`%${stem}%`}`)),
      ),
    )
    .orderBy(asc(treatmentTemplate.name), asc(treatmentTemplate.id))
  if (rows.length === 0) return []
  const owned = await tx
    .select({ templateId: serviceCatalog.templateId })
    .from(serviceCatalog)
    .where(
      and(
        eq(serviceCatalog.organizationId, orgId),
        eq(serviceCatalog.source, "template"),
        inArray(
          serviceCatalog.templateId,
          rows.map((row) => row.id),
        ),
      ),
    )
  const ownedIds = new Set(owned.map((row) => row.templateId))
  const candidates = rows
    .filter((row) => !ownedIds.has(row.id))
    .map((row) => ({ row, text: foldText(row.name) }))

  // Una plantilla pertenece a un solo concepto: el primero que la reclama.
  const taken = new Set<string>()
  const suggestions: StarterSuggestion[] = []
  for (const concept of STARTER_CONCEPTS) {
    const ranked: Array<{ row: (typeof rows)[number]; phrase: number; at: number }> = []
    for (const candidate of candidates) {
      if (taken.has(candidate.row.id)) continue
      if (
        concept.specialties &&
        !(concept.specialties as readonly string[]).includes(candidate.row.specialty)
      ) {
        continue
      }
      const phrase = concept.phrases.findIndex((phraseStems) =>
        phraseStems.every((stem) => candidate.text.includes(stem)),
      )
      const phraseStems = concept.phrases[phrase]
      if (!phraseStems) continue
      const at = Math.min(...phraseStems.map((stem) => candidate.text.indexOf(stem)))
      ranked.push({ row: candidate.row, phrase, at })
    }
    // Primero la frase preferida, luego el nombre que empieza por el concepto y
    // el más corto: la denominación general antes que sus variantes.
    ranked.sort(
      (a, b) =>
        a.phrase - b.phrase ||
        a.at - b.at ||
        a.row.name.length - b.row.name.length ||
        a.row.name.localeCompare(b.row.name) ||
        a.row.id.localeCompare(b.row.id),
    )
    const chosen = ranked.slice(0, perConcept)
    if (chosen.length === 0) continue
    for (const pick of chosen) taken.add(pick.row.id)
    suggestions.push({
      key: concept.key,
      label: concept.label,
      templates: chosen.map(({ row }) => ({
        id: row.id,
        key: row.key,
        name: row.name,
        specialty: row.specialty,
        scope: row.scope,
        surfaceCountMin: row.surfaceCountMin,
        surfaceCountMax: row.surfaceCountMax,
        isActive: row.isActive,
        version: row.version,
        codings: [
          { system: release.system, code: row.code, version: row.codeVersion, display: row.display },
        ],
      })),
    })
  }
  return suggestions
}


