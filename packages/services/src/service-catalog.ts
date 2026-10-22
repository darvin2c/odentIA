import {
  type ProcedureCodingSnapshot,
  type ServiceListProfile,
} from "@odentia/clinical"
import {
  isTreatmentKind,
  type LeavesFinding,
  TREATMENT_KINDS,
  TREATMENT_SCOPES,
  type TreatmentKind,
  type TreatmentScope,
  validateLeavesFinding,
} from "@odentia/dental"
import type { Db } from "@odentia/db"
import {
  orgSpecialty,
  PRICE_DISCLOSURES,
  type PriceDisclosure,
  procedureCatalogRelease,
  procedureCode,
  serviceCatalog,
  treatmentTemplate,
  treatmentTemplateCode,
} from "@odentia/db/schema/clinical"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm"
import { foldedWordsMatch } from "./search-text.js"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { librarySpecialtyIds, requireOrgSpecialtyId } from "./specialties.js"
import { orgDentalProfile } from "./dental/profile.js"
import { orgClinicalProfile, orgProfileRequired } from "./locale.js"
import { currentCatalogRelease, currentProcedureCode, serviceCoding, templateCodingIn } from "./procedure-codings.js"

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

export type ServiceRow = typeof serviceCatalog.$inferSelect
/** El servicio como lo lee una pantalla: con el nombre de su especialidad de la clínica. */
export type ServiceListItem = ServiceRow & { specialtyName: string | null }
export type TreatmentTemplateRow = typeof treatmentTemplate.$inferSelect


export const SERVICE_STATES = ["active", "inactive"] as const

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

/** Tipo de tratamiento: solo filtra la biblioteca, nunca el tarifario. */
function assertKind(kind: string | null | undefined): TreatmentKind {
  const value = (kind ?? "").trim().toLowerCase()
  if (!isTreatmentKind(value)) throw validation("Tipo de tratamiento inválido")
  return value
}

/** La especialidad de la clínica para un servicio propio: obligatoria. */
async function assertServiceSpecialty(tx: Db, orgId: string, specialtyId: string | null | undefined): Promise<string> {
  if (!specialtyId) throw validation("Elige la especialidad del servicio")
  return requireOrgSpecialtyId(tx, orgId, specialtyId)
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

/** Cómo dice el precio el agente; sin indicarlo, un servicio nuevo nace «solo con evaluación». */
export function assertPriceDisclosure(value: string | null | undefined): PriceDisclosure {
  const v = (value ?? "evaluacion").trim()
  if (!(PRICE_DISCLOSURES as readonly string[]).includes(v)) {
    throw validation("Cómo dice el precio: exacto, desde o evaluacion")
  }
  return v as PriceDisclosure
}

/**
 * La evaluación que ofrece el agente: un servicio activo de la misma clínica y
 * distinto del propio. `null` = sin una evaluación propia.
 */
async function assertEvaluationService(
  tx: Db,
  orgId: string,
  evaluationServiceId: string | null | undefined,
  selfId: string | null,
): Promise<string | null> {
  if (!evaluationServiceId) return null
  if (evaluationServiceId === selfId) throw validation("Un servicio no puede ser su propia evaluación")
  const evaluation = await requireService(tx, orgId, evaluationServiceId)
  if (!evaluation.isActive) {
    throw validation("La evaluación debe ser un servicio activo")
  }
  return evaluation.id
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

/**
 * Lo que deja el servicio en la pieza al completarse (lo tratado queda
 * dibujado): `null` = nada. Se valida con el ámbito del servicio y la regla
 * del país de la clínica (en Perú, con su variante).
 */
async function assertLeavesFinding(
  tx: Db,
  orgId: string,
  leaves: unknown,
  scope: string | null | undefined,
): Promise<LeavesFinding | null> {
  if (leaves === null || leaves === undefined) return null
  const strictVariants = (await orgDentalProfile(tx, orgId)).odontogram?.strictVariants ?? false
  const errors = validateLeavesFinding(leaves, { scope, strictVariants })
  if (errors.length) throw validation(errors.join(" "))
  const { condition, variant } = leaves as LeavesFinding
  return variant ? { condition, variant } : { condition }
}

/**
 * Lo que deja un servicio de la biblioteca: lo que odentIA puso en su
 * tratamiento (`treatment_template.leaves_finding`, ADR 0069); null si no
 * deja nada claro o no encaja con el ámbito.
 */
function libraryLeavesFinding(template: TreatmentTemplateRow): LeavesFinding | null {
  const leaves = template.leavesFinding
  if (!leaves) return null
  // La variante se exige al configurar a mano; aquí basta con que encaje en la pieza.
  return validateLeavesFinding(leaves, { scope: template.scope, strictVariants: false }).length === 0
    ? { ...leaves }
    : null
}

/** La lista de servicios del país de la clínica (ADR 0069), o null. */
async function orgServiceList(tx: Db, orgId: string): Promise<ServiceListProfile | null> {
  return (await orgClinicalProfile(tx, orgId)).services
}

/**
 * Donde la lista es obligatoria, un tratamiento sin código en ella no se
 * ofrece ni se agrega (decisión 2 del lienzo del issue 40).
 */
async function assertTemplateUsable(
  tx: Db,
  list: ServiceListProfile | null,
  template: { id: string; codedOnly: boolean },
): Promise<void> {
  // Una variante de la norma de otro país (`coded_only`) solo vale donde la
  // lista del país le da un código; lo demás, donde la lista no es obligatoria.
  if (!list?.required && !template.codedOnly) return
  if (list && (await templateCodingIn(tx, template.id, list.system))) return
  if (!list?.required) {
    throw conflict("TEMPLATE_UNCODED", "Este tratamiento es una variante de la norma de otro país: usa el general de la biblioteca")
  }
  throw conflict(
    "TEMPLATE_UNCODED",
    `Este tratamiento no tiene un ${list.codeName} vigente: en tu país cada servicio lleva el suyo`,
  )
}

/**
 * El código oficial que elige la clínica para un servicio propio (ADR 0069):
 * obligatorio donde la lista lo es, opcional donde es de referencia, y nada
 * sin lista. `undefined` = no se toca.
 */
async function assertOwnCode(
  tx: Db,
  list: ServiceListProfile | null,
  code: string | null | undefined,
  options: { creating: boolean },
): Promise<{ procedureSystem: string | null; procedureCode: string | null; procedureVersion: string | null } | undefined> {
  const value = code?.trim().toUpperCase() || null
  if (code === undefined && !options.creating) return undefined
  if (!list) {
    if (value) throw validation("En tu país los servicios no llevan código oficial")
    return { procedureSystem: null, procedureCode: null, procedureVersion: null }
  }
  if (!value) {
    if (list.required) throw validation(`Elige el ${list.codeName} del servicio: en tu país es obligatorio`)
    return { procedureSystem: null, procedureCode: null, procedureVersion: null }
  }
  const coding = await currentProcedureCode(tx, list.system, value)
  if (!coding) throw validation(`«${value}» no es un ${list.codeName} vigente`)
  return { procedureSystem: coding.system, procedureCode: coding.code, procedureVersion: coding.version }
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
 * Detalle read-only de un tratamiento de la biblioteca por id, sin exigir
 * vigencia (incluye retirados), para fichas enlazadas. Lleva solo el código
 * vigente de la lista del país de la clínica (ADR 0069): nada de otro país.
 */
export async function getTemplate(
  tx: Db,
  orgId: string,
  templateId: string,
): Promise<TreatmentTemplateRow & { codings: ProcedureCodingSnapshot[] }> {
  const [row] = await tx
    .select()
    .from(treatmentTemplate)
    .where(eq(treatmentTemplate.id, templateId))
    .limit(1)
  if (!row) throw notFound("Prestación de la biblioteca")
  const list = await orgServiceList(tx, orgId)
  const coding = list ? await templateCodingIn(tx, templateId, list.system) : null
  return { ...row, codings: coding ? [coding] : [] }
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
  /** Tipo de tratamiento. */
  kind?: string
  cursor?: string
  limit?: number
}

/** La lista de servicios que ve la clínica en la biblioteca: la de su país, o null. */
export interface TemplateCodeList {
  system: string
  required: boolean
}

export type LibraryTemplate = TreatmentTemplateRow & { codings: ProcedureCodingSnapshot[] }

const templateColumns = {
  id: treatmentTemplate.id,
  key: treatmentTemplate.key,
  name: treatmentTemplate.name,
  kind: treatmentTemplate.kind,
  scope: treatmentTemplate.scope,
  surfaceCountMin: treatmentTemplate.surfaceCountMin,
  surfaceCountMax: treatmentTemplate.surfaceCountMax,
  leavesFinding: treatmentTemplate.leavesFinding,
  isCommon: treatmentTemplate.isCommon,
  codedOnly: treatmentTemplate.codedOnly,
  isActive: treatmentTemplate.isActive,
  version: treatmentTemplate.version,
}

/**
 * Los tratamientos de la biblioteca con el código de la lista del país:
 * `left join` donde la lista es de referencia (sin código, igual se ofrece),
 * `inner join` donde es obligatoria y sin unir nada donde no hay lista.
 */
function libraryQuery(tx: Db, list: ServiceListProfile | null, release: { version: string } | null) {
  const columns = {
    ...templateColumns,
    code: procedureCode.code,
    codeVersion: procedureCode.version,
    display: procedureCode.display,
  }
  if (!list || !release) {
    return tx
      .select({ ...templateColumns, code: sql<string | null>`null`, codeVersion: sql<string | null>`null`, display: sql<string | null>`null` })
      .from(treatmentTemplate)
      .$dynamic()
  }
  const codeOn = and(
    eq(treatmentTemplateCode.templateId, treatmentTemplate.id),
    eq(treatmentTemplateCode.systemKey, list.system),
    eq(treatmentTemplateCode.version, release.version),
  )
  const officialOn = and(
    eq(procedureCode.systemKey, treatmentTemplateCode.systemKey),
    eq(procedureCode.code, treatmentTemplateCode.code),
    eq(procedureCode.version, treatmentTemplateCode.version),
    eq(procedureCode.isActive, true),
  )
  const base = tx.select(columns).from(treatmentTemplate)
  return list.required
    ? base.innerJoin(treatmentTemplateCode, codeOn).innerJoin(procedureCode, officialOn).$dynamic()
    : base.leftJoin(treatmentTemplateCode, codeOn).leftJoin(procedureCode, officialOn).$dynamic()
}

/**
 * Lo que la biblioteca ofrece en el país: una variante de la norma de un país
 * (`coded_only`) solo donde su lista le da un código. Donde la lista es
 * obligatoria ya lo exige la unión con el código.
 */
function offeredHere(list: ServiceListProfile | null, release: { version: string } | null) {
  if (list?.required) return undefined
  if (!list || !release) return eq(treatmentTemplate.codedOnly, false)
  return or(eq(treatmentTemplate.codedOnly, false), isNotNull(procedureCode.code))
}

type LibraryRow = TreatmentTemplateRow & { code: string | null; codeVersion: string | null; display: string | null }

function toLibraryTemplate(row: LibraryRow, list: ServiceListProfile | null): LibraryTemplate {
  const { code, codeVersion, display, ...template } = row
  return {
    ...template,
    codings: list && code && codeVersion && display ? [{ system: list.system, code, version: codeVersion, display }] : [],
  }
}

/**
 * La biblioteca como la ve la clínica (ADR 0069): todos los tratamientos de
 * consultorio, con el código de la lista de su país si tiene una. Donde la
 * lista es obligatoria, solo los que tienen código en ella.
 */
export async function listTemplates(
  tx: Db,
  orgId: string,
  query: ListTemplatesQuery,
): Promise<{
  data: LibraryTemplate[]
  nextCursor: string | null
  total: number
  codeList: TemplateCodeList | null
}> {
  const limit = clampLimit(query.limit)
  const after = decodeCursor(query.cursor)
  const list = await orgServiceList(tx, orgId)
  const release = list ? await currentCatalogRelease(tx, list.system) : null
  // Una lista obligatoria sin edición cargada no deja ofrecer nada.
  if (list?.required && !release) return { data: [], nextCursor: null, total: 0, codeList: { system: list.system, required: true } }
  const conditions = [eq(treatmentTemplate.isActive, true), offeredHere(list, release)]
  if (query.kind) conditions.push(eq(treatmentTemplate.kind, assertKind(query.kind)))
  const q = query.q?.trim()
  if (q) {
    const fields = list && release ? [treatmentTemplate.name, procedureCode.code] : [treatmentTemplate.name]
    conditions.push(foldedWordsMatch(fields, q))
  }
  // La biblioteca es corta (unos 400 tratamientos): se cuenta lo que coincide.
  const total = (await libraryQuery(tx, list, release).where(and(...conditions))).length
  if (after) {
    conditions.push(sql`("treatment_template"."name", "treatment_template"."id") > (${after.name}, ${after.id})`)
  }
  const rows = (await libraryQuery(tx, list, release)
    .where(and(...conditions))
    .orderBy(asc(treatmentTemplate.name), asc(treatmentTemplate.id))
    .limit(limit + 1)) as LibraryRow[]
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    data: page.map((row) => toLibraryTemplate(row, list)),
    nextCursor: rows.length > limit && last ? encodeCursor(last.name, last.id) : null,
    total,
    codeList: list ? { system: list.system, required: list.required } : null,
  }
}

/**
 * El buscador del código oficial de un servicio propio (decisión 3 del
 * lienzo del issue 40): la edición vigente de la lista del país, por nombre o
 * por código, sin tildes. Sin lista, nada.
 */
export async function searchOfficialCodes(
  tx: Db,
  orgId: string,
  query: { q?: string; limit?: number },
): Promise<{ data: ProcedureCodingSnapshot[]; codeList: TemplateCodeList | null }> {
  const list = await orgServiceList(tx, orgId)
  if (!list) return { data: [], codeList: null }
  const limit = Math.min(clampLimit(query.limit), 20)
  const q = query.q?.trim()
  const rows = await tx
    .select({
      system: procedureCode.systemKey,
      code: procedureCode.code,
      version: procedureCode.version,
      display: procedureCode.display,
    })
    .from(procedureCode)
    .innerJoin(
      procedureCatalogRelease,
      and(
        eq(procedureCatalogRelease.systemKey, procedureCode.systemKey),
        eq(procedureCatalogRelease.version, procedureCode.version),
      ),
    )
    .where(
      and(
        eq(procedureCode.systemKey, list.system),
        eq(procedureCode.isActive, true),
        eq(procedureCatalogRelease.isCurrent, true),
        q ? foldedWordsMatch([procedureCode.code, procedureCode.display], q) : undefined,
      ),
    )
    .orderBy(asc(procedureCode.code))
    .limit(limit)
  return { data: rows, codeList: { system: list.system, required: list.required } }
}

export interface ListServicesQuery {
  q?: string
  /** Especialidad de la clínica (id). */
  specialtyId?: string
  state?: string
  /**
   * Solo estos servicios, en cualquier estado: para nombrar lo ya elegido
   * aunque no esté en la primera página ni siga activo.
   */
  ids?: string[]
  cursor?: string
  limit?: number
}

/** Columnas de la lista: el servicio y el nombre de su especialidad de la clínica. */
const serviceListColumns = {
  id: serviceCatalog.id,
  organizationId: serviceCatalog.organizationId,
  templateId: serviceCatalog.templateId,
  source: serviceCatalog.source,
  code: serviceCatalog.code,
  name: serviceCatalog.name,
  specialtyId: serviceCatalog.specialtyId,
  specialtyName: orgSpecialty.name,
  scope: serviceCatalog.scope,
  priceCents: serviceCatalog.priceCents,
  currency: serviceCatalog.currency,
  durationMin: serviceCatalog.durationMin,
  billingMode: serviceCatalog.billingMode,
  priceDisclosure: serviceCatalog.priceDisclosure,
  evaluationServiceId: serviceCatalog.evaluationServiceId,
  leavesFinding: serviceCatalog.leavesFinding,
  procedureSystem: serviceCatalog.procedureSystem,
  procedureCode: serviceCatalog.procedureCode,
  procedureVersion: serviceCatalog.procedureVersion,
  isActive: serviceCatalog.isActive,
  createdAt: serviceCatalog.createdAt,
  updatedAt: serviceCatalog.updatedAt,
}

const specialtyJoin = and(
  eq(orgSpecialty.organizationId, serviceCatalog.organizationId),
  eq(orgSpecialty.id, serviceCatalog.specialtyId),
)

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * El tarifario por páginas, con el total de lo que coincide: una lista que
 * puede crecer se busca o se pagina, y dice cuántos son (topes B1–B4 de la
 * fase 4).
 */
export async function listServices(
  tx: Db,
  orgId: string,
  query: ListServicesQuery = {},
): Promise<{ data: ServiceListItem[]; nextCursor: string | null; total: number }> {
  const limit = clampLimit(query.limit)
  const after = decodeCursor(query.cursor)
  const conditions = [eq(serviceCatalog.organizationId, orgId)]
  if (query.specialtyId) {
    conditions.push(eq(serviceCatalog.specialtyId, await requireOrgSpecialtyId(tx, orgId, query.specialtyId)))
  }
  if (query.ids) {
    const ids = [...new Set(query.ids)]
    if (ids.length === 0) return { data: [], nextCursor: null, total: 0 }
    if (ids.length > MAX_LIMIT || ids.some((id) => !UUID_SHAPE.test(id))) {
      throw validation("ids debe tener entre 1 y 100 identificadores de servicio")
    }
    conditions.push(inArray(serviceCatalog.id, ids))
  } else {
    const state = query.state ?? "active"
    if (!(SERVICE_STATES as readonly string[]).includes(state)) {
      throw validation("state debe ser active|inactive")
    }
    conditions.push(eq(serviceCatalog.isActive, state === "active"))
  }
  const q = query.q?.trim()
  if (q) {
    conditions.push(foldedWordsMatch([serviceCatalog.name, serviceCatalog.code], q))
  }
  const [counted] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(serviceCatalog)
    .where(and(...conditions))
  if (after) {
    conditions.push(
      sql`("service_catalog"."name", "service_catalog"."id") > (${after.name}, ${after.id})`,
    )
  }
  const rows = await tx
    .select(serviceListColumns)
    .from(serviceCatalog)
    .leftJoin(orgSpecialty, specialtyJoin)
    .where(and(...conditions))
    .orderBy(asc(serviceCatalog.name), asc(serviceCatalog.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    data: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.name, last.id) : null,
    total: counted?.total ?? 0,
  }
}

/**
 * Un servicio de la clínica, en cualquier estado, con el nombre de su
 * especialidad y su código oficial en la lista de su país (ADR 0069).
 */
export async function getService(
  tx: Db,
  orgId: string,
  serviceId: string,
): Promise<ServiceListItem & { officialCoding: ProcedureCodingSnapshot | null }> {
  if (!UUID_SHAPE.test(serviceId)) throw notFound("Servicio del catálogo")
  const [row] = await tx
    .select(serviceListColumns)
    .from(serviceCatalog)
    .leftJoin(orgSpecialty, specialtyJoin)
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.id, serviceId)))
    .limit(1)
  if (!row) throw notFound("Servicio del catálogo")
  return { ...row, officialCoding: await serviceCoding(tx, await orgServiceList(tx, orgId), row) }
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
 * Oferta utilizable para una nueva indicación: activa y con tarifa explícita
 * (409 SERVICE_INACTIVE). Su código lo congela `resolveServiceCodings`.
 */
export async function requireServiceForIndication(
  tx: Db,
  orgId: string,
  serviceId: string,
): Promise<ServiceRow> {
  const row = await requireService(tx, orgId, serviceId)
  if (!row.isActive) {
    throw conflict("SERVICE_INACTIVE", "La prestación no está disponible para nuevas indicaciones")
  }
  return row
}

export interface CreateServiceInput {
  templateId?: string | null
  name?: string | null
  /**
   * Especialidad de la clínica. Obligatoria en un servicio propio; de la
   * biblioteca, sin indicarla, la de la clínica con la clave de la plantilla.
   */
  specialtyId?: string | null
  scope?: string | null
  code?: string | null
  priceCents?: number | null
  currency?: string | null
  durationMin?: number | null
  billingMode?: string | null
  /** Cómo dice el precio el agente; por defecto «evaluacion». */
  priceDisclosure?: string | null
  evaluationServiceId?: string | null
  /**
   * Qué deja en la pieza al completarse; `null` = nada. De la biblioteca, si
   * no se indica, el que odentIA puso en su tratamiento.
   */
  leavesFinding?: LeavesFinding | null
  /**
   * Código oficial de un servicio propio en la lista del país (ADR 0069):
   * obligatorio donde la lista lo es. Uno de la biblioteca toma el de su
   * tratamiento y no lo admite.
   */
  officialCode?: string | null
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
  const list = await orgServiceList(tx, orgId)
  if (input.templateId) {
    const tpl = await requireTemplate(tx, input.templateId)
    await assertTemplateUsable(tx, list, tpl)
    if (input.officialCode) throw validation("Un servicio de la biblioteca toma el código de su tratamiento")
    const name = input.name?.trim() ? assertName(input.name) : tpl.name
    const specialtyId = input.specialtyId
      ? await requireOrgSpecialtyId(tx, orgId, input.specialtyId)
      : ((await librarySpecialtyIds(tx, orgId, [tpl.kind])).get(tpl.kind) ?? null)
    if (input.scope !== undefined && input.scope !== null && input.scope !== tpl.scope) {
      throw validation("scope debe coincidir con la plantilla (derivado, no editable)")
    }
    values = {
      organizationId: orgId,
      templateId: tpl.id,
      source: "template",
      code: normalizeCode(input.code),
      name,
      specialtyId,
      scope: tpl.scope,
      priceCents: assertPrice(input.priceCents),
      currency,
      durationMin: assertDuration(input.durationMin),
      billingMode: assertBillingMode(input.billingMode),
      priceDisclosure: assertPriceDisclosure(input.priceDisclosure),
      evaluationServiceId: await assertEvaluationService(tx, orgId, input.evaluationServiceId, null),
      leavesFinding:
        input.leavesFinding === undefined
          ? libraryLeavesFinding(tpl)
          : await assertLeavesFinding(tx, orgId, input.leavesFinding, tpl.scope),
      isActive: input.isActive ?? true,
    }
  } else {
    const scope = assertScope(input.scope)
    values = {
      organizationId: orgId,
      templateId: null,
      source: "custom",
      code: normalizeCode(input.code),
      name: assertName(input.name),
      specialtyId: await assertServiceSpecialty(tx, orgId, input.specialtyId),
      scope,
      priceCents: assertPrice(input.priceCents),
      currency,
      durationMin: assertDuration(input.durationMin),
      billingMode: assertBillingMode(input.billingMode),
      priceDisclosure: assertPriceDisclosure(input.priceDisclosure),
      evaluationServiceId: await assertEvaluationService(tx, orgId, input.evaluationServiceId, null),
      leavesFinding: await assertLeavesFinding(tx, orgId, input.leavesFinding, scope),
      ...(await assertOwnCode(tx, list, input.officialCode, { creating: true })),
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
    officialCode: row.procedureCode,
    priceCents: row.priceCents,
    currency: row.currency,
  })
  return row
}

export interface UpdateServicePatch {
  templateId?: string | null
  name?: string
  /** La especialidad de la clínica: se elige en el formulario del servicio, también si viene de la biblioteca. */
  specialtyId?: string
  scope?: string
  code?: string | null
  priceCents?: number | null
  currency?: string
  durationMin?: number | null
  billingMode?: string
  priceDisclosure?: string
  evaluationServiceId?: string | null
  /** Qué deja en la pieza al completarse; `null` = nada. */
  leavesFinding?: LeavesFinding | null
  /** Código oficial de un servicio propio; `null` = sin código (solo donde no es obligatorio). */
  officialCode?: string | null
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
  const list = await orgServiceList(tx, orgId)

  if (patch.templateId !== undefined) {
    if (patch.templateId === null) {
      // Independizar la oferta: definición propia completa, sin referencia clínica falsa.
      const name = patch.name !== undefined ? assertName(patch.name) : current.name
      const specialtyId =
        patch.specialtyId !== undefined
          ? await assertServiceSpecialty(tx, orgId, patch.specialtyId)
          : current.specialtyId
      const scope = patch.scope !== undefined ? assertScope(patch.scope) : current.scope
      if (!specialtyId || !scope) {
        throw validation(
          "Para independizar la oferta envía su definición completa (nombre, especialidad y ámbito)",
        )
      }
      set.templateId = null
      set.source = "custom"
      set.name = name
      set.specialtyId = specialtyId
      set.scope = scope
      // Al independizarse guarda su propio código: el que elige la clínica o,
      // si no elige, el que tenía su tratamiento (o el suyo, si ya era propio).
      const inherited = !list
        ? null
        : current.templateId
          ? ((await templateCodingIn(tx, current.templateId, list.system))?.code ?? null)
          : current.procedureSystem === list.system
            ? current.procedureCode
            : null
      Object.assign(
        set,
        await assertOwnCode(tx, list, patch.officialCode !== undefined ? patch.officialCode : inherited, {
          creating: true,
        }),
      )
      fields.push("templateId:null")
    } else {
      const tpl = await requireTemplate(tx, patch.templateId)
      await assertTemplateUsable(tx, list, tpl)
      if (patch.officialCode) throw validation("Un servicio de la biblioteca toma el código de su tratamiento")
      // Vincular la biblioteca trae lo que su tratamiento deja en la pieza y su código.
      if (patch.leavesFinding === undefined) {
        set.leavesFinding = libraryLeavesFinding(tpl)
        fields.push("leavesFinding")
      }
      set.procedureSystem = null
      set.procedureCode = null
      set.procedureVersion = null
      if (patch.scope !== undefined && patch.scope !== tpl.scope) {
        throw validation("scope debe coincidir con la plantilla (derivado, no editable)")
      }
      set.templateId = tpl.id
      set.source = "template"
      // Vincular la biblioteca trae su especialidad, salvo que la clínica elija otra.
      set.specialtyId =
        patch.specialtyId !== undefined
          ? await assertServiceSpecialty(tx, orgId, patch.specialtyId)
          : ((await librarySpecialtyIds(tx, orgId, [tpl.kind])).get(tpl.kind) ?? current.specialtyId)
      set.scope = tpl.scope
      if (patch.name !== undefined) set.name = assertName(patch.name)
      fields.push("templateId")
    }
  } else if (current.source === "template") {
    if (patch.scope !== undefined) {
      throw validation("scope se deriva de la plantilla; para independizar envía templateId:null")
    }
  }
  if (patch.templateId === undefined && patch.specialtyId !== undefined) {
    set.specialtyId = await assertServiceSpecialty(tx, orgId, patch.specialtyId)
    fields.push("specialtyId")
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
  if (patch.officialCode !== undefined && patch.templateId === undefined) {
    if ((set.source ?? current.source) === "template") {
      throw validation("Un servicio de la biblioteca toma el código de su tratamiento")
    }
    Object.assign(set, await assertOwnCode(tx, list, patch.officialCode, { creating: false }))
    fields.push("officialCode")
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
  if (patch.priceDisclosure !== undefined) {
    set.priceDisclosure = assertPriceDisclosure(patch.priceDisclosure)
    fields.push("priceDisclosure")
  }
  if (patch.evaluationServiceId !== undefined) {
    set.evaluationServiceId = await assertEvaluationService(tx, orgId, patch.evaluationServiceId, serviceId)
    fields.push("evaluationServiceId")
  }
  if (patch.isActive !== undefined) {
    set.isActive = patch.isActive
    fields.push("isActive")
  }
  if (patch.leavesFinding !== undefined) {
    set.leavesFinding = await assertLeavesFinding(
      tx,
      orgId,
      patch.leavesFinding,
      (set.scope ?? current.scope) as string | null,
    )
    fields.push("leavesFinding")
  } else if (set.scope !== undefined && set.leavesFinding === undefined && current.leavesFinding) {
    // Cambiar dónde se hace no deja un dibujo que ya no encaja.
    await assertLeavesFinding(tx, orgId, current.leavesFinding, set.scope)
  }

  const resolvedScope = (set.scope ?? current.scope) as string | null
  if (!resolvedScope) throw validation("Elige dónde se hace el servicio")
  if (fields.length === 0) throw validation("Sin cambios: patch vacío")
  // Donde la lista es obligatoria, un servicio propio no se guarda sin su código
  // (ADR 0069), tampoco si se edita otra cosa: p. ej. uno que dejó de ser «Heredada».
  const finalTemplateId = set.templateId !== undefined ? set.templateId : current.templateId
  const finalCode = set.procedureCode !== undefined ? set.procedureCode : current.procedureCode
  if (list?.required && !finalTemplateId && !finalCode) {
    throw validation(`Elige el ${list.codeName} del servicio: en tu país es obligatorio`)
  }

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
  options: { priceDisclosure?: string | null } = {},
): Promise<FromTemplatesResult> {
  const priceDisclosure = assertPriceDisclosure(options.priceDisclosure)
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
  const list = await orgServiceList(tx, orgId)
  for (const tpl of templates) {
    if (!tpl.isActive)
      throw conflict("TEMPLATE_INACTIVE", "La prestación de la biblioteca ya no está vigente")
    await assertTemplateUsable(tx, list, tpl)
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
  // Cada tratamiento va a la especialidad del país que recibe su tipo.
  const specialtyOf = await librarySpecialtyIds(
    tx,
    orgId,
    templates.map((tpl) => tpl.kind),
  )
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
        specialtyId: specialtyOf.get(tpl.kind) ?? null,
        scope: tpl.scope,
        priceCents: assertPrice(item.priceCents),
        currency,
        durationMin: assertDuration(item.durationMin),
        billingMode: assertBillingMode(item.billingMode),
        priceDisclosure,
        // Lo tratado queda dibujado: odentIA lo deja puesto en su biblioteca.
        leavesFinding: libraryLeavesFinding(tpl),
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
      priceDisclosure: row.priceDisclosure,
    })
  }
  return { created, existing: owned }
}

/** Servicio propio dentro de la carga rápida: sin tratamiento de la biblioteca. */
export interface CustomServiceItem {
  name: string
  /** Especialidad de la clínica. */
  specialtyId: string
  scope: string
  /** Tarifa explícita en unidad menor; 0 = incluido sin costo. */
  priceCents: number
  billingMode?: string | null
  durationMin?: number | null
  /** Qué deja en la pieza al completarse; sin indicarlo, nada. */
  leavesFinding?: LeavesFinding | null
  /** Código oficial en la lista del país; obligatorio donde la lista lo es. */
  officialCode?: string | null
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
  /**
   * «¿Cómo dice el agente estos precios?», una sola vez para todo lo que se
   * agrega (decisión 5 de la fase 4). La pantalla la manda con «Precio
   * exacto» marcado; sin indicarla, como cualquier servicio nuevo, «Solo con
   * evaluación».
   */
  options: { priceDisclosure?: string | null } = {},
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
      ? await fromTemplates(tx, orgId, actorUserId, fromLibrary, options)
      : { created: [], existing: [] }
  for (const item of custom) {
    result.created.push(
      await createService(tx, orgId, actorUserId, {
        name: item.name,
        specialtyId: item.specialtyId,
        scope: item.scope,
        priceCents: item.priceCents,
        billingMode: item.billingMode,
        durationMin: item.durationMin,
        priceDisclosure: options.priceDisclosure,
        leavesFinding: item.leavesFinding ?? null,
        officialCode: item.officialCode ?? null,
        isActive: true,
      }),
    )
  }
  return result
}

/** Cuántos servicios se cambian de una vez: los que caben en una página de la lista. */
export const PRICE_DISCLOSURE_BATCH = 100

/**
 * «Cómo dice el precio» de varios servicios a la vez (decisión 5 de la fase
 * 4): solo cambia lo que el agente le dice a una persona; caja y presupuesto
 * siguen con la tarifa. Todos los servicios deben ser de la clínica; si uno
 * no lo es, no se cambia ninguno.
 */
export async function setServicesPriceDisclosure(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { serviceIds: string[]; priceDisclosure: string },
): Promise<{ updated: number }> {
  const ids = [...new Set(input.serviceIds)]
  if (ids.length < 1 || ids.length > PRICE_DISCLOSURE_BATCH) {
    throw validation(`Elige entre 1 y ${PRICE_DISCLOSURE_BATCH} servicios`)
  }
  const priceDisclosure = assertPriceDisclosure(input.priceDisclosure)
  const owned = await tx
    .select({ id: serviceCatalog.id })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.organizationId, orgId), inArray(serviceCatalog.id, ids)))
  if (owned.length !== ids.length) throw notFound("Servicio del catálogo")
  await tx
    .update(serviceCatalog)
    .set({ priceDisclosure, updatedAt: new Date() })
    .where(and(eq(serviceCatalog.organizationId, orgId), inArray(serviceCatalog.id, ids)))
  for (const id of ids) {
    await audit(tx, orgId, actorUserId, "catalog.service_updated", id, { fields: ["priceDisclosure"], batch: true })
  }
  return { updated: ids.length }
}

export interface StarterSuggestion {
  /** Tipo de tratamiento: agrupa la lista. */
  key: TreatmentKind
  label: string
  templates: LibraryTemplate[]
}

/**
 * «Más usados»: punto de partida para una clínica que aún no tiene tarifario
 * (ADR 0069). Son los tratamientos que odentIA marcó en su biblioteca
 * (`is_common`), por tipo y en el orden de los tipos, con el código del país y
 * sin los que la clínica ya agregó. Donde la lista es obligatoria, solo los
 * que tienen código en ella.
 */
export async function listMostUsedServices(
  tx: Db,
  orgId: string,
  options: { perConcept?: number } = {},
): Promise<StarterSuggestion[]> {
  const perKind = options.perConcept ?? 10
  if (!Number.isInteger(perKind) || perKind < 1 || perKind > 20) {
    throw validation("perConcept debe ser un entero entre 1 y 20")
  }
  const list = await orgServiceList(tx, orgId)
  const release = list ? await currentCatalogRelease(tx, list.system) : null
  if (list?.required && !release) return []
  const rows = (await libraryQuery(tx, list, release)
    .where(and(eq(treatmentTemplate.isActive, true), eq(treatmentTemplate.isCommon, true), offeredHere(list, release)))
    .orderBy(asc(treatmentTemplate.name), asc(treatmentTemplate.id))) as LibraryRow[]
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
  const suggestions: StarterSuggestion[] = []
  for (const kind of TREATMENT_KINDS) {
    const templates = rows
      .filter((row) => row.kind === kind.key && !ownedIds.has(row.id))
      .slice(0, perKind)
      .map((row) => toLibraryTemplate(row, list))
    if (templates.length > 0) suggestions.push({ key: kind.key, label: kind.name, templates })
  }
  return suggestions
}
