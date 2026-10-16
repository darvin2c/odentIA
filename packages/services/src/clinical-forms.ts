import type { Db } from "@odentia/db"
import {
  type ConsentSections,
  consentSectionsToText,
  isValidTooth,
  parseConsentSections,
  SUGGESTED_CONSENT_TEMPLATES,
} from "@odentia/clinical"
import {
  cie10Code,
  encounter,
  patient,
  patientDocument,
  serviceCatalog,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import {
  clinicalFormAddendum,
  clinicalFormResponse,
  clinicalFormTemplate,
  clinicalOrder,
  consentDocument,
  consentEvent,
  consentTemplate,
  orgSpecialty,
  professionalSpecialty,
  serviceSpecialty,
} from "@odentia/db/schema/clinical-forms"
import { member } from "@odentia/db/schema/auth"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import { requireProfessionalSignature } from "./professional-profiles.js"
import { requireDecisionContact, requireLinkedActiveContact } from "./responsibilities.js"
import { createWorkspaceNotification } from "./workspace.js"

/**
 * Especialidades dinámicas, formularios clínicos versionados, consentimientos
 *
 * Convención: toda función recibe un `tx: Db` que YA corre dentro de
 * `withOrgContext(db, orgId, ...)` (RLS por GUC `app.org_id`).
 */

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  action: string,
  entity: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity,
    entityId,
    metadata: metadata ?? null,
  })
}

/**
 * Aviso dirigido vía workspaceNotification (sin PII clínica en el texto, solo
 * referencia a la ficha). El aviso nunca bloquea el registro clínico: si el
 * destinatario dejó la organización, se omite y el registro persiste.
 */
async function notifyUser(
  tx: Db,
  orgId: string,
  userId: string,
  input: { dedupeKey: string; title: string; body: string; href: string; actorUserId: string; subject?: string },
): Promise<void> {
  try {
    // Nadie recibe aviso de lo que hizo él mismo (`actorUserId`).
    await createWorkspaceNotification(tx, orgId, {
      ...input,
      userId,
      dedupeKey: `${input.dedupeKey}:${userId}`,
      permission: "clinical.read",
    })
  } catch (e) {
    if (e instanceof ServiceError) return
    throw e
  }
}

function assertKey(raw: string | null | undefined, name: string): string {
  const value = (raw ?? "").trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(value) || value.length < 2) {
    throw validation(
      `${name} inválida: usa 2–40 caracteres (letras, números y guiones)`,
    )
  }
  return value
}

function assertName(raw: string | null | undefined, name: string, max = 120): string {
  const value = (raw ?? "").trim()
  if (!value) throw validation(`${name} es obligatorio`)
  if (value.length > max) throw validation(`${name} supera ${max} caracteres`)
  return value
}

function assertOptionalText(
  raw: string | null | undefined,
  name: string,
  max: number,
): string | null {
  if (raw == null) return null
  const value = raw.trim()
  if (!value) return null
  if (value.length > max) throw validation(`${name} supera ${max} caracteres`)
  return value
}

async function requireSpecialty(tx: Db, orgId: string, specialtyId: string) {
  const [row] = await tx
    .select()
    .from(orgSpecialty)
    .where(and(eq(orgSpecialty.id, specialtyId), eq(orgSpecialty.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Especialidad")
  return row
}

async function requireMemberUserId(tx: Db, orgId: string, userId: string): Promise<void> {
  const [row] = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  if (!row) throw validation("El profesional debe ser miembro de la organización")
}

// ---------------------------------------------------------------------------
// Especialidades (CRUD por organización)
// ---------------------------------------------------------------------------

export type SpecialtyRow = typeof orgSpecialty.$inferSelect

export interface CreateSpecialtyInput {
  key?: string | null
  name: string
  description?: string | null
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return base.length >= 2 ? base : ""
}

/**
 * Clave generada a partir del nombre que escribió la clínica. Nadie la ve: si
 * del nombre no sale ninguna, el problema se dice del nombre, no de la clave.
 */
function keyFromName(name: string): string {
  // El recorte a 40 puede dejar un guion al final.
  const key = slugify(name).replace(/-+$/, "")
  if (key.length < 2) throw validation("El nombre necesita al menos dos letras o números")
  return assertKey(key, "Clave")
}

export async function listSpecialties(
  tx: Db,
  orgId: string,
  query: { q?: string; activeOnly?: boolean } = {},
): Promise<SpecialtyRow[]> {
  const conditions = [eq(orgSpecialty.organizationId, orgId)]
  if (query.activeOnly) conditions.push(eq(orgSpecialty.isActive, true))
  const q = (query.q ?? "").trim()
  if (q) conditions.push(ilike(orgSpecialty.name, `%${q}%`))
  return tx
    .select()
    .from(orgSpecialty)
    .where(and(...conditions))
    .orderBy(asc(orgSpecialty.name))
}

export async function createSpecialty(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateSpecialtyInput,
): Promise<SpecialtyRow> {
  const name = assertName(input.name, "Nombre de la especialidad")
  const key = input.key ? assertKey(input.key, "Clave") : keyFromName(name)
  const description = assertOptionalText(input.description, "Descripción", 2000)
  try {
    const [row] = await tx
      .insert(orgSpecialty)
      .values({ organizationId: orgId, key, name, description })
      .returning()
    await audit(tx, orgId, actorUserId, "specialty.create", "org_specialty", row.id, {
      key,
      name,
    })
    return row
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("DUPLICATE", "Ya existe una especialidad con ese nombre o uno muy parecido")
    throw e
  }
}

export interface UpdateSpecialtyPatch {
  name?: string
  description?: string | null
  isActive?: boolean
}

export async function updateSpecialty(
  tx: Db,
  orgId: string,
  actorUserId: string,
  specialtyId: string,
  patch: UpdateSpecialtyPatch,
): Promise<SpecialtyRow> {
  const current = await requireSpecialty(tx, orgId, specialtyId)
  // La clave es estable: renombrar no cambia el key (los vínculos siguen válidos).
  const name = patch.name !== undefined ? assertName(patch.name, "Nombre de la especialidad") : current.name
  const description =
    patch.description !== undefined
      ? assertOptionalText(patch.description, "Descripción", 2000)
      : current.description
  const isActive = patch.isActive ?? current.isActive
  const [row] = await tx
    .update(orgSpecialty)
    .set({ name, description, isActive, updatedAt: new Date() })
    .where(and(eq(orgSpecialty.id, specialtyId), eq(orgSpecialty.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Especialidad")
  await audit(tx, orgId, actorUserId, "specialty.update", "org_specialty", row.id, { name })
  return row
}

/**
 * Desactiva una especialidad (sin borrarla: los registros históricos la
 * conservan). No puede desactivarse con plantillas publicadas vigentes.
 */
export async function archiveSpecialty(
  tx: Db,
  orgId: string,
  actorUserId: string,
  specialtyId: string,
): Promise<SpecialtyRow> {
  await requireSpecialty(tx, orgId, specialtyId)
  const [publishedForm] = await tx
    .select({ id: clinicalFormTemplate.id })
    .from(clinicalFormTemplate)
    .where(
      and(
        eq(clinicalFormTemplate.organizationId, orgId),
        eq(clinicalFormTemplate.specialtyId, specialtyId),
        eq(clinicalFormTemplate.status, "publicado"),
      ),
    )
    .limit(1)
  const [publishedConsent] = await tx
    .select({ id: consentTemplate.id })
    .from(consentTemplate)
    .where(
      and(
        eq(consentTemplate.organizationId, orgId),
        eq(consentTemplate.specialtyId, specialtyId),
        eq(consentTemplate.status, "publicado"),
      ),
    )
    .limit(1)
  if (publishedForm || publishedConsent) {
    throw conflict(
      "HAS_PUBLISHED",
      "Archiva primero las plantillas publicadas de esta especialidad",
    )
  }
  return updateSpecialty(tx, orgId, actorUserId, specialtyId, { isActive: false })
}

// ---------------------------------------------------------------------------
// Profesionales y servicios por especialidad
// ---------------------------------------------------------------------------

export async function setProfessionalSpecialties(
  tx: Db,
  orgId: string,
  actorUserId: string,
  userId: string,
  specialtyIds: string[],
): Promise<{ userId: string; specialtyIds: string[] }> {
  await requireMemberUserId(tx, orgId, userId)
  const unique = [...new Set(specialtyIds)]
  if (unique.length > 20) throw validation("Máximo 20 especialidades por profesional")
  for (const id of unique) await requireSpecialty(tx, orgId, id)
  await tx
    .delete(professionalSpecialty)
    .where(
      and(
        eq(professionalSpecialty.organizationId, orgId),
        eq(professionalSpecialty.userId, userId),
      ),
    )
  if (unique.length > 0) {
    await tx.insert(professionalSpecialty).values(
      unique.map((specialtyId) => ({
        organizationId: orgId,
        specialtyId,
        userId,
      })),
    )
  }
  await audit(tx, orgId, actorUserId, "specialty.professionals", "user", userId, {
    specialtyIds: unique,
  })
  return { userId, specialtyIds: unique }
}

export async function listProfessionalSpecialties(
  tx: Db,
  orgId: string,
  userId: string,
): Promise<SpecialtyRow[]> {
  const rows = await tx
    .select({ specialty: orgSpecialty })
    .from(professionalSpecialty)
    .innerJoin(orgSpecialty, eq(professionalSpecialty.specialtyId, orgSpecialty.id))
    .where(
      and(
        eq(professionalSpecialty.organizationId, orgId),
        eq(professionalSpecialty.userId, userId),
      ),
    )
    .orderBy(asc(orgSpecialty.name))
  return rows.map((r) => r.specialty)
}

export async function listSpecialtyProfessionals(
  tx: Db,
  orgId: string,
  specialtyId: string,
): Promise<{ userId: string }[]> {
  await requireSpecialty(tx, orgId, specialtyId)
  return tx
    .select({ userId: professionalSpecialty.userId })
    .from(professionalSpecialty)
    .where(
      and(
        eq(professionalSpecialty.organizationId, orgId),
        eq(professionalSpecialty.specialtyId, specialtyId),
      ),
    )
}

export async function setServiceSpecialties(
  tx: Db,
  orgId: string,
  actorUserId: string,
  serviceId: string,
  specialtyIds: string[],
): Promise<{ serviceId: string; specialtyIds: string[] }> {
  const [service] = await tx
    .select({ id: serviceCatalog.id })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.id, serviceId), eq(serviceCatalog.organizationId, orgId)))
    .limit(1)
  if (!service) throw notFound("Prestación")
  const unique = [...new Set(specialtyIds)]
  if (unique.length > 10) throw validation("Máximo 10 especialidades por prestación")
  for (const id of unique) await requireSpecialty(tx, orgId, id)
  await tx
    .delete(serviceSpecialty)
    .where(
      and(eq(serviceSpecialty.organizationId, orgId), eq(serviceSpecialty.serviceId, serviceId)),
    )
  if (unique.length > 0) {
    await tx.insert(serviceSpecialty).values(
      unique.map((specialtyId) => ({ organizationId: orgId, specialtyId, serviceId })),
    )
  }
  await audit(tx, orgId, actorUserId, "specialty.services", "service_catalog", serviceId, {
    specialtyIds: unique,
  })
  return { serviceId, specialtyIds: unique }
}

export async function listServiceSpecialties(
  tx: Db,
  orgId: string,
  serviceId: string,
): Promise<SpecialtyRow[]> {
  const rows = await tx
    .select({ specialty: orgSpecialty })
    .from(serviceSpecialty)
    .innerJoin(orgSpecialty, eq(serviceSpecialty.specialtyId, orgSpecialty.id))
    .where(
      and(eq(serviceSpecialty.organizationId, orgId), eq(serviceSpecialty.serviceId, serviceId)),
    )
    .orderBy(asc(orgSpecialty.name))
  return rows.map((r) => r.specialty)
}

// ---------------------------------------------------------------------------
// Formularios clínicos versionados
// ---------------------------------------------------------------------------

export const FIELD_TYPES = [
  "texto",
  "texto_largo",
  "numero",
  "booleano",
  "opcion_unica",
  "opcion_multiple",
  "fecha",
  "firma",
  /** Pieza dentaria en notación FDI (ISO 3950). */
  "pieza",
  /** Escala numérica entera con extremos declarados (p. ej. dolor 0–10). */
  "escala",
  /** Archivo del paciente ya subido (imagen o documento). */
  "adjunto",
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

/** Mostrar el campo solo si otro campo anterior tiene ese valor. */
export interface FieldCondition {
  field: string
  equals: string | boolean
}

export interface FormFieldDef {
  id: string
  label: string
  type: FieldType
  required?: boolean
  options?: string[]
  unit?: string | null
  min?: number | null
  max?: number | null
  help?: string | null
  showIf?: FieldCondition | null
}

export interface FormSectionDef {
  id: string
  title: string
  fields: FormFieldDef[]
}

export interface FormSchemaDef {
  sections: FormSectionDef[]
}

function assertFieldId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,48}$/i.test(id.trim())) {
    throw validation("Cada campo necesita un id estable (letras, números, guion)")
  }
  return id.trim()
}

/** Valida el esquema de la plantilla (secciones, campos tipados, opciones, unidades). */
export function assertFormSchema(raw: unknown): FormSchemaDef {
  if (!raw || typeof raw !== "object" || !("sections" in raw)) {
    throw validation("El esquema del formulario es obligatorio")
  }
  const sections: unknown = raw.sections
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > 30) {
    throw validation("El formulario necesita entre 1 y 30 secciones")
  }
  const seenSections = new Set<string>()
  const seenFields = new Set<string>()
  const seenFieldDefs = new Map<string, FormFieldDef>()
  const parsed: FormSectionDef[] = sections.map((s, si) => {
    if (!s || typeof s !== "object") throw validation(`La sección ${si + 1} es inválida`)
    const id: unknown = "id" in s ? s.id : undefined
    const title: unknown = "title" in s ? s.title : undefined
    const fields: unknown = "fields" in s ? s.fields : undefined
    const sectionId = assertFieldId(typeof id === "string" ? id : `seccion-${si + 1}`)
    if (seenSections.has(sectionId)) throw validation(`Sección duplicada: ${sectionId}`)
    seenSections.add(sectionId)
    const sectionTitle = typeof title === "string" ? title.trim() : ""
    if (!sectionTitle) throw validation("Cada sección necesita un título")
    if (sectionTitle.length > 120) throw validation("El título de sección supera 120 caracteres")
    if (!Array.isArray(fields) || fields.length === 0 || fields.length > 60) {
      throw validation(`La sección "${sectionTitle}" necesita entre 1 y 60 campos`)
    }
    return {
      id: sectionId,
      title: sectionTitle,
      fields: fields.map((f, fi) => {
        if (!f || typeof f !== "object") {
          throw validation(`Campo ${fi + 1} de "${sectionTitle}" inválido`)
        }
        const rawId: unknown = "id" in f ? f.id : undefined
        const rawLabel: unknown = "label" in f ? f.label : undefined
        const rawType: unknown = "type" in f ? f.type : undefined
        const rawRequired: unknown = "required" in f ? f.required : undefined
        const rawUnit: unknown = "unit" in f ? f.unit : undefined
        const rawHelp: unknown = "help" in f ? f.help : undefined
        const rawOptions: unknown = "options" in f ? f.options : undefined
        const rawMin: unknown = "min" in f ? f.min : undefined
        const rawMax: unknown = "max" in f ? f.max : undefined
        const rawShowIf: unknown = "showIf" in f ? f.showIf : undefined
        const fieldId = assertFieldId(typeof rawId === "string" ? rawId : "")
        if (seenFields.has(fieldId)) throw validation(`Campo duplicado: ${fieldId}`)
        seenFields.add(fieldId)
        const label = typeof rawLabel === "string" ? rawLabel.trim() : ""
        if (!label) throw validation("Cada campo necesita una etiqueta")
        if (label.length > 200) throw validation(`El campo "${fieldId}" supera 200 caracteres`)
        const type = typeof rawType === "string" ? rawType : ""
        if (!(FIELD_TYPES as readonly string[]).includes(type)) {
          throw validation(`Tipo inválido en "${label}": ${type || "?"}`)
        }
        const field: FormFieldDef = { id: fieldId, label, type: type as FieldType }
        if (typeof rawRequired === "boolean") field.required = rawRequired
        if (rawUnit !== undefined && rawUnit !== null) {
          const unit = String(rawUnit).trim()
          if (!unit) throw validation(`Unidad vacía en "${label}"`)
          if (unit.length > 20) throw validation(`Unidad muy larga en "${label}"`)
          field.unit = unit
        }
        if (rawHelp !== undefined && rawHelp !== null) {
          const help = String(rawHelp).trim()
          if (help.length > 500) throw validation(`Ayuda muy larga en "${label}"`)
          field.help = help || null
        }
        if (type === "opcion_unica" || type === "opcion_multiple") {
          if (!Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > 50) {
            throw validation(`"${label}" necesita entre 2 y 50 opciones`)
          }
          const options = rawOptions.map((o) => String(o).trim()).filter(Boolean)
          if (options.length < 2) throw validation(`"${label}" necesita entre 2 y 50 opciones`)
          if (new Set(options).size !== options.length) {
            throw validation(`"${label}" tiene opciones duplicadas`)
          }
          if (options.some((o) => o.length > 120)) {
            throw validation(`"${label}" tiene opciones muy largas (máx. 120)`)
          }
          field.options = options
        }
        if (type === "escala") {
          const min = rawMin ?? 0
          const max = rawMax ?? 10
          if (!Number.isInteger(min) || !Number.isInteger(max) || (min as number) >= (max as number)) {
            throw validation(`La escala "${label}" necesita extremos enteros (mínimo < máximo)`)
          }
          if ((max as number) - (min as number) > 100) throw validation(`La escala "${label}" es demasiado amplia`)
          field.min = min as number
          field.max = max as number
        }
        if (rawShowIf !== undefined && rawShowIf !== null) {
          if (typeof rawShowIf !== "object" || Array.isArray(rawShowIf))
            throw validation(`Condición inválida en "${label}"`)
          const cond = rawShowIf as Record<string, unknown>
          const target = typeof cond.field === "string" ? cond.field : ""
          const source = seenFieldDefs.get(target)
          if (!source)
            throw validation(`"${label}" depende de un campo anterior que no existe: ${target || "?"}`)
          if (source.type === "booleano") {
            if (typeof cond.equals !== "boolean") throw validation(`"${label}": la condición debe ser Sí o No`)
          } else if (source.type === "opcion_unica" || source.type === "opcion_multiple") {
            if (typeof cond.equals !== "string" || !source.options?.includes(cond.equals))
              throw validation(`"${label}": la condición debe ser una opción de "${source.label}"`)
          } else {
            throw validation(`"${label}" solo puede depender de un campo Sí/No o de opciones`)
          }
          field.showIf = { field: target, equals: cond.equals }
        }
        if (type === "numero") {
          if (rawMin !== undefined && rawMin !== null) {
            if (typeof rawMin !== "number" || !Number.isFinite(rawMin)) {
              throw validation(`Mínimo inválido en "${label}"`)
            }
            field.min = rawMin
          }
          if (rawMax !== undefined && rawMax !== null) {
            if (typeof rawMax !== "number" || !Number.isFinite(rawMax)) {
              throw validation(`Máximo inválido en "${label}"`)
            }
            field.max = rawMax
          }
          if (field.min != null && field.max != null && field.min > field.max) {
            throw validation(`Rango inválido en "${label}"`)
          }
        }
        seenFieldDefs.set(fieldId, field)
        return field
      }),
    }
  })
  return { sections: parsed }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function conditionMet(condition: FieldCondition, answer: unknown): boolean {
  if (Array.isArray(answer)) return answer.includes(condition.equals)
  return answer === condition.equals
}

/** Los adjuntos deben ser archivos vigentes del mismo paciente. */
async function assertAttachmentAnswers(
  tx: Db,
  orgId: string,
  patientId: string,
  schema: FormSchemaDef,
  answers: Record<string, unknown>,
): Promise<void> {
  const ids = schema.sections
    .flatMap((section) => section.fields)
    .filter((field) => field.type === "adjunto" && typeof answers[field.id] === "string")
    .map((field) => answers[field.id] as string)
  if (ids.length === 0) return
  const rows = await tx
    .select({ id: patientDocument.id })
    .from(patientDocument)
    .where(
      and(
        eq(patientDocument.organizationId, orgId),
        eq(patientDocument.patientId, patientId),
        inArray(patientDocument.id, ids),
        isNull(patientDocument.retiredAt),
      ),
    )
  const found = new Set(rows.map((row) => row.id))
  const missing = ids.find((id) => !found.has(id))
  if (missing) throw validation("El archivo adjunto no pertenece al paciente o está retirado")
}

function isEmptyAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "string") return value.trim() === ""
  if (Array.isArray(value)) return value.length === 0
  return false
}



/**
 * Valida respuestas contra el snapshot del esquema: tipos, opciones, rangos y
 * unidades declaradas. Con requireAll exige obligatorios (cierre); en borrador
 * permite captura parcial pero rechaza claves desconocidas y tipos inválidos.
 * Lanza 400 con el campo culpable. `false` booleano es respuesta válida.
 */
export function assertAnswers(
  schema: FormSchemaDef,
  answers: unknown,
  options: { requireAll?: boolean } = {},
): Record<string, unknown> {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw validation("Las respuestas deben ser un objeto por campo")
  }
  const requireAll = options.requireAll !== false
  // Copia tipada del objeto libre de la respuesta (las claves se validan abajo).
  const input: Record<string, unknown> = Object.fromEntries(Object.entries(answers))
  const allowed = new Set<string>()
  const out: Record<string, unknown> = {}
  for (const section of schema.sections) {
    for (const field of section.fields) {
      allowed.add(field.id)
      const value: unknown = input[field.id]
      // Campo oculto por su condición: no se exige y no guarda respuesta.
      if (field.showIf && !conditionMet(field.showIf, out[field.showIf.field])) {
        out[field.id] = null
        continue
      }
      if (isEmptyAnswer(value)) {
        if (requireAll && field.required) throw validation(`"${field.label}" es obligatorio`)
        out[field.id] = null
        continue
      }
      switch (field.type) {
        case "texto":
        case "texto_largo": {
          if (typeof value !== "string") throw validation(`"${field.label}" debe ser texto`)
          const text = value.trim()
          if (!text) {
            if (requireAll && field.required) throw validation(`"${field.label}" es obligatorio`)
            out[field.id] = null
            break
          }
          if (text.length > (field.type === "texto" ? 500 : 5000)) {
            throw validation(`"${field.label}" supera el máximo de caracteres`)
          }
          out[field.id] = text
          break
        }
        case "numero": {
          const num = typeof value === "number" ? value : Number(value)
          if (!Number.isFinite(num)) throw validation(`"${field.label}" debe ser un número`)
          if (field.min != null && num < field.min) {
            throw validation(`"${field.label}" debe ser ≥ ${field.min}`)
          }
          if (field.max != null && num > field.max) {
            throw validation(`"${field.label}" debe ser ≤ ${field.max}`)
          }
          out[field.id] = num
          break
        }
        case "booleano": {
          if (typeof value !== "boolean") throw validation(`"${field.label}" debe ser sí/no`)
          out[field.id] = value
          break
        }
        case "opcion_unica": {
          if (typeof value !== "string" || !field.options!.includes(value)) {
            throw validation(`"${field.label}" tiene una opción inválida`)
          }
          out[field.id] = value
          break
        }
        case "opcion_multiple": {
          if (!Array.isArray(value) || value.length === 0) {
            throw validation(`"${field.label}" necesita al menos una opción`)
          }
          for (const v of value) {
            if (typeof v !== "string" || !field.options!.includes(v)) {
              throw validation(`"${field.label}" tiene una opción inválida`)
            }
          }
          if (new Set(value).size !== value.length) {
            throw validation(`"${field.label}" tiene opciones repetidas`)
          }
          out[field.id] = [...value]
          break
        }
        case "fecha": {
          if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            throw validation(`"${field.label}" debe ser una fecha (AAAA-MM-DD)`)
          }
          const date = new Date(`${value}T00:00:00Z`)
          if (Number.isNaN(date.getTime())) throw validation(`"${field.label}" no es una fecha válida`)
          out[field.id] = value
          break
        }
        case "firma": {
          // Trazo manuscrito con su firmante; límites de tamaño y coordenadas
          // iguales a los del consentimiento. Sin afirmación de certificación.
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw validation(`"${field.label}" necesita la firma manuscrita`)
          }
          const raw = value as Record<string, unknown>
          const signerName = typeof raw.signerName === "string" ? raw.signerName.trim() : ""
          if (!signerName || signerName.length > 200)
            throw validation(`"${field.label}" necesita el nombre de quien firma`)
          const signature = assertSignatureData({ strokes: raw.strokes }, `La firma de "${field.label}"`)
          out[field.id] = { ...signature, signerName }
          break
        }
        case "pieza": {
          const tooth = typeof value === "number" ? value : Number(value)
          if (!Number.isInteger(tooth) || !isValidTooth(tooth))
            throw validation(`"${field.label}" debe ser una pieza FDI válida`)
          out[field.id] = tooth
          break
        }
        case "escala": {
          const num = typeof value === "number" ? value : Number(value)
          if (!Number.isInteger(num) || num < (field.min ?? 0) || num > (field.max ?? 10))
            throw validation(`"${field.label}" debe ser un entero de ${field.min ?? 0} a ${field.max ?? 10}`)
          out[field.id] = num
          break
        }
        case "adjunto": {
          if (typeof value !== "string" || !UUID_RE.test(value))
            throw validation(`"${field.label}" debe ser un archivo del paciente`)
          out[field.id] = value
          break
        }
      }
    }
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw validation(`Campo desconocido: ${key}`)
  }
  return out
}

export type FormTemplateRow = typeof clinicalFormTemplate.$inferSelect

export interface CreateFormTemplateInput {
  key?: string | null
  title: string
  description?: string | null
  specialtyId?: string | null
  schema: unknown
  /** «portal»: cuestionario que responde el paciente antes de su cita. */
  respondent?: "staff" | "portal"
}

function assertRespondent(raw: unknown): "staff" | "portal" {
  if (raw === undefined || raw === null) return "staff"
  if (raw !== "staff" && raw !== "portal") throw validation("Destinatario inválido: staff|portal")
  return raw
}

/** El paciente no adjunta archivos clínicos desde el portal. */
function assertPortalSchema(respondent: "staff" | "portal", schema: FormSchemaDef): void {
  if (respondent !== "portal") return
  const attachment = schema.sections.flatMap((s) => s.fields).find((f) => f.type === "adjunto")
  if (attachment)
    throw validation(`«${attachment.label}»: el cuestionario del portal no admite archivos adjuntos`)
}

export async function listFormTemplates(
  tx: Db,
  orgId: string,
  query: { specialtyId?: string; status?: string; q?: string } = {},
): Promise<FormTemplateRow[]> {
  const conditions = [eq(clinicalFormTemplate.organizationId, orgId)]
  if (query.specialtyId) conditions.push(eq(clinicalFormTemplate.specialtyId, query.specialtyId))
  if (query.status) {
    if (!["borrador", "publicado", "archivado"].includes(query.status)) {
      throw validation("Estado inválido: borrador|publicado|archivado")
    }
    conditions.push(eq(clinicalFormTemplate.status, query.status))
  }
  const q = (query.q ?? "").trim()
  if (q) conditions.push(ilike(clinicalFormTemplate.title, `%${q}%`))
  return tx
    .select()
    .from(clinicalFormTemplate)
    .where(and(...conditions))
    .orderBy(desc(clinicalFormTemplate.updatedAt))
}

export async function createFormTemplate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateFormTemplateInput,
): Promise<FormTemplateRow> {
  const title = assertName(input.title, "Título del formulario", 200)
  const key = input.key ? assertKey(input.key, "Clave") : keyFromName(title)
  const description = assertOptionalText(input.description, "Descripción", 2000)
  const schema = assertFormSchema(input.schema)
  let specialtyId: string | null = null
  if (input.specialtyId) {
    const specialty = await requireSpecialty(tx, orgId, input.specialtyId)
    if (!specialty.isActive) throw validation("La especialidad está inactiva")
    specialtyId = specialty.id
  }
  // La versión arranca en 1; si la clave ya existe se crea la siguiente versión.
  const existing = await tx
    .select({ version: clinicalFormTemplate.version, status: clinicalFormTemplate.status })
    .from(clinicalFormTemplate)
    .where(and(eq(clinicalFormTemplate.organizationId, orgId), eq(clinicalFormTemplate.key, key)))
    .orderBy(desc(clinicalFormTemplate.version))
  if (existing.some((row) => row.status === "borrador"))
    throw conflict("DRAFT_EXISTS", "Ya hay un borrador de este formulario: edítalo o publícalo")
  const version = (existing[0]?.version ?? 0) + 1
  const respondent = assertRespondent(input.respondent)
  assertPortalSchema(respondent, schema)
  try {
    const [row] = await tx
      .insert(clinicalFormTemplate)
      .values({
        organizationId: orgId,
        specialtyId,
        key,
        title,
        description,
        version,
        status: "borrador",
        schema: schema as unknown as Record<string, unknown>,
        respondent,
        createdBy: actorUserId,
      })
      .returning()
    await audit(tx, orgId, actorUserId, "form_template.create", "clinical_form_template", row.id, {
      key,
      version,
    })
    return row
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("DUPLICATE", "Ya existe esa versión de la plantilla")
    throw e
  }
}

export interface UpdateFormTemplatePatch {
  title?: string
  description?: string | null
  specialtyId?: string | null
  schema?: unknown
  respondent?: "staff" | "portal"
}

/** Solo borradores: una versión publicada/archivada es inmutable. */
export async function updateFormTemplate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  templateId: string,
  patch: UpdateFormTemplatePatch,
): Promise<FormTemplateRow> {
  const [current] = await tx
    .select()
    .from(clinicalFormTemplate)
    .where(
      and(eq(clinicalFormTemplate.id, templateId), eq(clinicalFormTemplate.organizationId, orgId)),
    )
    .limit(1)
  if (!current) throw notFound("Plantilla")
  if (current.status !== "borrador") {
    throw conflict("IMMUTABLE", "Solo un borrador puede editarse: publica una versión nueva")
  }
  const title = patch.title !== undefined ? assertName(patch.title, "Título del formulario", 200) : current.title
  const description =
    patch.description !== undefined
      ? assertOptionalText(patch.description, "Descripción", 2000)
      : current.description
  let specialtyId = current.specialtyId
  if (patch.specialtyId !== undefined) {
    if (patch.specialtyId === null) {
      specialtyId = null
    } else {
      specialtyId = (await requireSpecialty(tx, orgId, patch.specialtyId)).id
    }
  }
  const schema = patch.schema !== undefined ? assertFormSchema(patch.schema) : current.schema
  const respondent =
    patch.respondent !== undefined ? assertRespondent(patch.respondent) : (current.respondent as "staff" | "portal")
  assertPortalSchema(respondent, schema as FormSchemaDef)
  const [row] = await tx
    .update(clinicalFormTemplate)
    .set({
      title,
      description,
      specialtyId,
      schema: schema as unknown as Record<string, unknown>,
      respondent,
      updatedAt: new Date(),
    })
    .where(
      and(eq(clinicalFormTemplate.id, templateId), eq(clinicalFormTemplate.organizationId, orgId)),
    )
    .returning()
  if (!row) throw notFound("Plantilla")
  await audit(tx, orgId, actorUserId, "form_template.update", "clinical_form_template", row.id, {
    version: row.version,
  })
  return row
}

/**
 * Publica el borrador con su número de versión real y archiva la versión
 * publicada anterior de la misma clave: «Nuevo formulario» ofrece solo la
 * vigente. Republicar nunca altera respuestas ya capturadas (snapshot).
 */
export async function publishFormTemplate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  templateId: string,
): Promise<FormTemplateRow> {
  const [current] = await tx
    .select()
    .from(clinicalFormTemplate)
    .where(
      and(eq(clinicalFormTemplate.id, templateId), eq(clinicalFormTemplate.organizationId, orgId)),
    )
    .for("update")
    .limit(1)
  if (!current) throw notFound("Plantilla")
  if (current.status !== "borrador") throw conflict("IMMUTABLE", "Solo un borrador puede publicarse")
  assertFormSchema(current.schema)
  if (current.specialtyId) {
    const specialty = await requireSpecialty(tx, orgId, current.specialtyId)
    if (!specialty.isActive) throw validation("La especialidad está inactiva")
  }
  const previous = await tx
    .update(clinicalFormTemplate)
    .set({ status: "archivado", updatedAt: new Date() })
    .where(
      and(
        eq(clinicalFormTemplate.organizationId, orgId),
        eq(clinicalFormTemplate.key, current.key),
        eq(clinicalFormTemplate.status, "publicado"),
      ),
    )
    .returning({ version: clinicalFormTemplate.version })
  const [published] = await tx
    .update(clinicalFormTemplate)
    .set({ status: "publicado", publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(clinicalFormTemplate.id, current.id))
    .returning()
  if (!published) throw notFound("Plantilla")
  await audit(tx, orgId, actorUserId, "form_template.publish", "clinical_form_template", published.id, {
    key: current.key,
    version: published.version,
    archived: previous.map((row) => row.version),
  })
  return published
}

export async function archiveFormTemplate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  templateId: string,
): Promise<FormTemplateRow> {
  const [current] = await tx
    .select()
    .from(clinicalFormTemplate)
    .where(
      and(eq(clinicalFormTemplate.id, templateId), eq(clinicalFormTemplate.organizationId, orgId)),
    )
    .limit(1)
  if (!current) throw notFound("Plantilla")
  if (current.status === "archivado") throw conflict("ARCHIVED", "La plantilla ya está archivada")
  const [row] = await tx
    .update(clinicalFormTemplate)
    .set({ status: "archivado", updatedAt: new Date() })
    .where(
      and(eq(clinicalFormTemplate.id, templateId), eq(clinicalFormTemplate.organizationId, orgId)),
    )
    .returning()
  if (!row) throw notFound("Plantilla")
  await audit(tx, orgId, actorUserId, "form_template.archive", "clinical_form_template", row.id, {})
  return row
}

// ---------------------------------------------------------------------------
// Captura por paciente/atención
// ---------------------------------------------------------------------------

export type FormResponseRow = typeof clinicalFormResponse.$inferSelect

export interface CreateFormResponseInput {
  templateId: string
  patientId: string
  encounterId?: string | null
  professionalUserId?: string | null
  answers?: unknown
}

async function requireVisibleEncounter(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
) {
  const [row] = await tx
    .select()
    .from(encounter)
    .where(
      and(
        eq(encounter.id, encounterId),
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Atención")
  return row
}

export async function createFormResponse(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateFormResponseInput,
): Promise<FormResponseRow> {
  await requirePatient(tx, orgId, input.patientId)
  const [template] = await tx
    .select()
    .from(clinicalFormTemplate)
    .where(
      and(
        eq(clinicalFormTemplate.id, input.templateId),
        eq(clinicalFormTemplate.organizationId, orgId),
      ),
    )
    .limit(1)
  if (!template) throw notFound("Plantilla")
  if (template.status !== "publicado") {
    throw validation("Solo una plantilla publicada admite capturas")
  }
  const schema = assertFormSchema(template.schema)
  let encounterId: string | null = null
  if (input.encounterId) {
    await requireVisibleEncounter(tx, orgId, input.patientId, input.encounterId)
    encounterId = input.encounterId
  }
  let professionalUserId: string | null = null
  if (input.professionalUserId) {
    await requireMemberUserId(tx, orgId, input.professionalUserId)
    professionalUserId = input.professionalUserId
  }
  const answers = assertAnswers(schema, input.answers ?? {}, { requireAll: false })
  await assertAttachmentAnswers(tx, orgId, input.patientId, schema, answers)
  const [row] = await tx
    .insert(clinicalFormResponse)
    .values({
      organizationId: orgId,
      templateId: template.id,
      templateVersion: template.version,
      templateTitle: template.title,
      templateSnapshot: template.schema as unknown as Record<string, unknown>,
      patientId: input.patientId,
      encounterId,
      professionalUserId,
      status: "borrador",
      answers: answers as unknown as Record<string, unknown>,
      authorUserId: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "form_response.create", "clinical_form_response", row.id, {
    template: template.key,
    version: template.version,
  })
  return row
}

export async function updateFormResponseDraft(
  tx: Db,
  orgId: string,
  actorUserId: string,
  responseId: string,
  input: { answers: unknown; professionalUserId?: string | null },
): Promise<FormResponseRow> {
  const [current] = await tx
    .select()
    .from(clinicalFormResponse)
    .where(
      and(eq(clinicalFormResponse.id, responseId), eq(clinicalFormResponse.organizationId, orgId)),
    )
    .limit(1)
  if (!current) throw notFound("Formulario")
  if (current.status !== "borrador") {
    throw conflict(
      "FINALIZED",
      current.status === "descartado"
        ? "El formulario está descartado"
        : "El formulario está finalizado: usa una adenda",
    )
  }
  const schema = assertFormSchema(current.templateSnapshot)
  const answers = assertAnswers(schema, input.answers, { requireAll: false })
  await assertAttachmentAnswers(tx, orgId, current.patientId, schema, answers)
  let professionalUserId = current.professionalUserId
  if (input.professionalUserId !== undefined) {
    if (input.professionalUserId === null) {
      professionalUserId = null
    } else {
      await requireMemberUserId(tx, orgId, input.professionalUserId)
      professionalUserId = input.professionalUserId
    }
  }
  const [row] = await tx
    .update(clinicalFormResponse)
    .set({ answers: answers as unknown as Record<string, unknown>, professionalUserId, updatedAt: new Date() })
    .where(
      and(eq(clinicalFormResponse.id, responseId), eq(clinicalFormResponse.organizationId, orgId)),
    )
    .returning()
  if (!row) throw notFound("Formulario")
  await audit(tx, orgId, actorUserId, "form_response.update", "clinical_form_response", row.id, {})
  return row
}

export async function finalizeFormResponse(
  tx: Db,
  orgId: string,
  actorUserId: string,
  responseId: string,
): Promise<FormResponseRow> {
  const [current] = await tx
    .select()
    .from(clinicalFormResponse)
    .where(
      and(eq(clinicalFormResponse.id, responseId), eq(clinicalFormResponse.organizationId, orgId)),
    )
    .for("update")
    .limit(1)
  if (!current) throw notFound("Formulario")
  if (current.status !== "borrador")
    throw conflict(
      "FINALIZED",
      current.status === "descartado" ? "El formulario está descartado" : "El formulario ya está finalizado",
    )
  const schema = assertFormSchema(current.templateSnapshot)
  // Revalida completitud al cerrar (obligatorios con valor real).
  const answers = assertAnswers(schema, current.answers, { requireAll: true })
  await assertAttachmentAnswers(tx, orgId, current.patientId, schema, answers)
  const [row] = await tx
    .update(clinicalFormResponse)
    .set({ status: "finalizado", finalizedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(clinicalFormResponse.id, responseId), eq(clinicalFormResponse.organizationId, orgId)),
    )
    .returning()
  if (!row) throw notFound("Formulario")
  await audit(tx, orgId, actorUserId, "form_response.finalize", "clinical_form_response", row.id, {})
  return row
}

/** Descarta un borrador con motivo: no cuenta como registro clínico y no se edita más. */
export async function discardFormResponse(
  tx: Db,
  orgId: string,
  actorUserId: string,
  responseId: string,
  reason: string,
): Promise<FormResponseRow> {
  const [current] = await tx
    .select()
    .from(clinicalFormResponse)
    .where(
      and(eq(clinicalFormResponse.id, responseId), eq(clinicalFormResponse.organizationId, orgId)),
    )
    .for("update")
    .limit(1)
  if (!current) throw notFound("Formulario")
  if (current.status !== "borrador")
    throw conflict("FINALIZED", "Solo un borrador se descarta; uno finalizado se corrige con adenda")
  const clean = (reason ?? "").trim()
  if (!clean || clean.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
  const [row] = await tx
    .update(clinicalFormResponse)
    .set({
      status: "descartado",
      discardedAt: new Date(),
      discardedBy: actorUserId,
      discardReason: clean,
      updatedAt: new Date(),
    })
    .where(
      and(eq(clinicalFormResponse.id, responseId), eq(clinicalFormResponse.organizationId, orgId)),
    )
    .returning()
  await audit(tx, orgId, actorUserId, "form_response.discard", "clinical_form_response", responseId, {
    reason: clean,
  })
  return row!
}

export async function addFormAddendum(
  tx: Db,
  orgId: string,
  actorUserId: string,
  responseId: string,
  text: string,
): Promise<typeof clinicalFormAddendum.$inferSelect> {
  const [current] = await tx
    .select({ id: clinicalFormResponse.id, status: clinicalFormResponse.status })
    .from(clinicalFormResponse)
    .where(
      and(eq(clinicalFormResponse.id, responseId), eq(clinicalFormResponse.organizationId, orgId)),
    )
    .limit(1)
  if (!current) throw notFound("Formulario")
  if (current.status !== "finalizado") {
    throw validation("La adenda solo aplica a formularios finalizados")
  }
  const clean = (text ?? "").trim()
  if (!clean) throw validation("La adenda no puede estar vacía")
  if (clean.length > 5000) throw validation("La adenda supera 5000 caracteres")
  const [row] = await tx
    .insert(clinicalFormAddendum)
    .values({ organizationId: orgId, responseId, text: clean, createdBy: actorUserId })
    .returning()
  await audit(tx, orgId, actorUserId, "form_response.addendum", "clinical_form_response", responseId, {})
  return row
}

export async function listFormResponses(
  tx: Db,
  orgId: string,
  query: { patientId: string; encounterId?: string; templateId?: string },
): Promise<FormResponseRow[]> {
  await requirePatient(tx, orgId, query.patientId)
  const conditions = [
    eq(clinicalFormResponse.organizationId, orgId),
    eq(clinicalFormResponse.patientId, query.patientId),
  ]
  if (query.encounterId) conditions.push(eq(clinicalFormResponse.encounterId, query.encounterId))
  if (query.templateId) conditions.push(eq(clinicalFormResponse.templateId, query.templateId))
  return tx
    .select()
    .from(clinicalFormResponse)
    .where(and(...conditions))
    .orderBy(desc(clinicalFormResponse.createdAt))
}

/** Paciente dueño de un formulario: para dejar traza de su lectura (404 si no existe). */
export async function formResponsePatientId(
  tx: Db,
  orgId: string,
  responseId: string,
): Promise<string> {
  const [current] = await tx
    .select({ patientId: clinicalFormResponse.patientId })
    .from(clinicalFormResponse)
    .where(
      and(eq(clinicalFormResponse.id, responseId), eq(clinicalFormResponse.organizationId, orgId)),
    )
    .limit(1)
  if (!current) throw notFound("Formulario")
  return current.patientId
}

export async function listFormAddenda(
  tx: Db,
  orgId: string,
  responseId: string,
): Promise<(typeof clinicalFormAddendum.$inferSelect)[]> {
  await formResponsePatientId(tx, orgId, responseId)
  return tx
    .select()
    .from(clinicalFormAddendum)
    .where(
      and(
        eq(clinicalFormAddendum.organizationId, orgId),
        eq(clinicalFormAddendum.responseId, responseId),
      ),
    )
    .orderBy(asc(clinicalFormAddendum.createdAt))
}

// ---------------------------------------------------------------------------
// Consentimientos informados
// ---------------------------------------------------------------------------

export type ConsentTemplateRow = typeof consentTemplate.$inferSelect
export type ConsentDocumentRow = typeof consentDocument.$inferSelect

export interface CreateConsentTemplateInput {
  key?: string | null
  title: string
  /** Secciones fijas; con ellas `body` se deriva. */
  sections?: unknown
  /** Texto libre (plantillas anteriores sin secciones). */
  body?: string | null
  specialtyId?: string | null
}

export async function listConsentTemplates(
  tx: Db,
  orgId: string,
  query: { specialtyId?: string; status?: string; q?: string } = {},
): Promise<ConsentTemplateRow[]> {
  const conditions = [eq(consentTemplate.organizationId, orgId)]
  if (query.specialtyId) conditions.push(eq(consentTemplate.specialtyId, query.specialtyId))
  if (query.status) {
    if (!["borrador", "publicado", "archivado"].includes(query.status)) {
      throw validation("Estado inválido: borrador|publicado|archivado")
    }
    conditions.push(eq(consentTemplate.status, query.status))
  }
  const q = (query.q ?? "").trim()
  if (q) conditions.push(ilike(consentTemplate.title, `%${q}%`))
  return tx
    .select()
    .from(consentTemplate)
    .where(and(...conditions))
    .orderBy(desc(consentTemplate.updatedAt))
}

function assertConsentBody(raw: string | null | undefined): string {
  const body = (raw ?? "").trim()
  if (body.length < 50) throw validation("El texto del consentimiento es muy corto (mín. 50 caracteres)")
  if (body.length > 20000) throw validation("El texto supera 20000 caracteres")
  return body
}

/** Secciones validadas y su texto equivalente; sin secciones, el texto libre. */
function consentContent(input: { sections?: unknown; body?: string | null }): {
  sections: ConsentSections | null
  body: string
} {
  if (input.sections !== undefined && input.sections !== null) {
    let sections: ConsentSections
    try {
      sections = parseConsentSections(input.sections)
    } catch (e) {
      throw validation(e instanceof Error ? e.message : "Secciones inválidas")
    }
    return { sections, body: assertConsentBody(consentSectionsToText(sections)) }
  }
  return { sections: null, body: assertConsentBody(input.body) }
}

export async function createConsentTemplate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateConsentTemplateInput,
): Promise<ConsentTemplateRow> {
  const title = assertName(input.title, "Título del consentimiento", 200)
  const { sections, body } = consentContent(input)
  const key = input.key ? assertKey(input.key, "Clave") : keyFromName(title)
  let specialtyId: string | null = null
  if (input.specialtyId) {
    const specialty = await requireSpecialty(tx, orgId, input.specialtyId)
    if (!specialty.isActive) throw validation("La especialidad está inactiva")
    specialtyId = specialty.id
  }
  const existing = await tx
    .select({ version: consentTemplate.version, status: consentTemplate.status })
    .from(consentTemplate)
    .where(and(eq(consentTemplate.organizationId, orgId), eq(consentTemplate.key, key)))
    .orderBy(desc(consentTemplate.version))
  if (existing.some((row) => row.status === "borrador"))
    throw conflict("DRAFT_EXISTS", "Ya hay un borrador de esta plantilla: edítalo o publícalo")
  const version = (existing[0]?.version ?? 0) + 1
  try {
    const [row] = await tx
      .insert(consentTemplate)
      .values({
        organizationId: orgId,
        specialtyId,
        key,
        title,
        body,
        sections,
        version,
        status: "borrador",
        createdBy: actorUserId,
      })
      .returning()
    await audit(tx, orgId, actorUserId, "consent_template.create", "consent_template", row.id, {
      key,
      version,
    })
    return row
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("DUPLICATE", "Ya existe esa versión de la plantilla")
    throw e
  }
}

export async function updateConsentTemplate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  templateId: string,
  patch: { title?: string; body?: string; sections?: unknown; specialtyId?: string | null },
): Promise<ConsentTemplateRow> {
  const [current] = await tx
    .select()
    .from(consentTemplate)
    .where(and(eq(consentTemplate.id, templateId), eq(consentTemplate.organizationId, orgId)))
    .limit(1)
  if (!current) throw notFound("Plantilla de consentimiento")
  if (current.status !== "borrador") {
    throw conflict("IMMUTABLE", "Solo un borrador puede editarse: publica una versión nueva")
  }
  const title = patch.title !== undefined ? assertName(patch.title, "Título del consentimiento", 200) : current.title
  const content =
    patch.sections !== undefined || patch.body !== undefined
      ? consentContent({ sections: patch.sections, body: patch.body ?? current.body })
      : { sections: current.sections as ConsentSections | null, body: current.body }
  let specialtyId = current.specialtyId
  if (patch.specialtyId !== undefined) {
    specialtyId = patch.specialtyId === null ? null : (await requireSpecialty(tx, orgId, patch.specialtyId)).id
  }
  const [row] = await tx
    .update(consentTemplate)
    .set({ title, body: content.body, sections: content.sections, specialtyId, updatedAt: new Date() })
    .where(and(eq(consentTemplate.id, templateId), eq(consentTemplate.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Plantilla de consentimiento")
  await audit(tx, orgId, actorUserId, "consent_template.update", "consent_template", row.id, {})
  return row
}

/**
 * Publica el borrador con el número de versión real y archiva la versión
 * publicada anterior de la misma clave: solo una versión vigente por plantilla.
 */
export async function publishConsentTemplate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  templateId: string,
): Promise<ConsentTemplateRow> {
  const [current] = await tx
    .select()
    .from(consentTemplate)
    .where(and(eq(consentTemplate.id, templateId), eq(consentTemplate.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!current) throw notFound("Plantilla de consentimiento")
  if (current.status !== "borrador") throw conflict("IMMUTABLE", "Solo un borrador puede publicarse")
  const previous = await tx
    .update(consentTemplate)
    .set({ status: "archivado", updatedAt: new Date() })
    .where(
      and(
        eq(consentTemplate.organizationId, orgId),
        eq(consentTemplate.key, current.key),
        eq(consentTemplate.status, "publicado"),
      ),
    )
    .returning({ id: consentTemplate.id, version: consentTemplate.version })
  const [published] = await tx
    .update(consentTemplate)
    .set({ status: "publicado", publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(consentTemplate.id, current.id))
    .returning()
  if (!published) throw notFound("Plantilla de consentimiento")
  await audit(tx, orgId, actorUserId, "consent_template.publish", "consent_template", published.id, {
    key: current.key,
    version: published.version,
    archived: previous.map((row) => row.version),
  })
  return published
}

/** Retira una plantilla: deja de ofrecerse; los documentos generados no cambian. */
export async function archiveConsentTemplate(
  tx: Db,
  orgId: string,
  actorUserId: string,
  templateId: string,
): Promise<ConsentTemplateRow> {
  const [current] = await tx
    .select()
    .from(consentTemplate)
    .where(and(eq(consentTemplate.id, templateId), eq(consentTemplate.organizationId, orgId)))
    .limit(1)
  if (!current) throw notFound("Plantilla de consentimiento")
  if (current.status === "archivado") throw conflict("ARCHIVED", "La plantilla ya está archivada")
  const [row] = await tx
    .update(consentTemplate)
    .set({ status: "archivado", updatedAt: new Date() })
    .where(eq(consentTemplate.id, templateId))
    .returning()
  await audit(tx, orgId, actorUserId, "consent_template.archive", "consent_template", templateId, {
    key: current.key,
    version: current.version,
  })
  return row!
}

/**
 * Crea como borrador las plantillas sugeridas por procedimiento que la
 * organización aún no tiene (por clave). Nunca publica: el texto se revisa.
 */
export async function createSuggestedConsentTemplates(
  tx: Db,
  orgId: string,
  actorUserId: string,
): Promise<ConsentTemplateRow[]> {
  const existing = await tx
    .select({ key: consentTemplate.key })
    .from(consentTemplate)
    .where(eq(consentTemplate.organizationId, orgId))
  const known = new Set(existing.map((row) => row.key))
  const created: ConsentTemplateRow[] = []
  for (const suggestion of SUGGESTED_CONSENT_TEMPLATES) {
    if (known.has(suggestion.key)) continue
    created.push(
      await createConsentTemplate(tx, orgId, actorUserId, {
        key: suggestion.key,
        title: suggestion.title,
        sections: suggestion.sections,
      }),
    )
  }
  return created
}

export interface CreateConsentDocumentInput {
  templateId: string
  patientId: string
  encounterId?: string | null
  planItemId?: string | null
  procedureRef?: string | null
  /** CIE-10 que motiva el procedimiento; por defecto, el del tratamiento. */
  diagnosisCode?: string | null
}

export async function createConsentDocument(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateConsentDocumentInput,
): Promise<ConsentDocumentRow> {
  await requirePatient(tx, orgId, input.patientId)
  const [template] = await tx
    .select()
    .from(consentTemplate)
    .where(
      and(eq(consentTemplate.id, input.templateId), eq(consentTemplate.organizationId, orgId)),
    )
    .limit(1)
  if (!template) throw notFound("Plantilla de consentimiento")
  if (template.status !== "publicado") {
    throw validation("Solo una plantilla publicada genera consentimientos")
  }
  let encounterId: string | null = null
  if (input.encounterId) {
    await requireVisibleEncounter(tx, orgId, input.patientId, input.encounterId)
    encounterId = input.encounterId
  }
  let planItemId: string | null = null
  let planDiagnosis: string | null = null
  if (input.planItemId) {
    const [item] = await tx
      .select({
        id: treatmentPlanItem.id,
        patientId: treatmentPlanItem.patientId,
        diagnosisCode: treatmentPlanItem.diagnosisCode,
      })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, input.planItemId),
          eq(treatmentPlanItem.organizationId, orgId),
        ),
      )
      .limit(1)
    if (!item || item.patientId !== input.patientId) {
      throw validation("El tratamiento no pertenece al paciente")
    }
    planItemId = item.id
    planDiagnosis = item.diagnosisCode
  }
  if (!encounterId && !planItemId && !input.procedureRef?.trim()) {
    throw validation("Indica la atención, el tratamiento o el procedimiento al que aplica")
  }
  const procedureRef = assertOptionalText(input.procedureRef, "Procedimiento", 500)
  const diagnosisCode = input.diagnosisCode?.trim() || planDiagnosis
  if (diagnosisCode) {
    const [known] = await tx
      .select({ code: cie10Code.code })
      .from(cie10Code)
      .where(eq(cie10Code.code, diagnosisCode))
    if (!known) throw validation(`Código CIE-10 inexistente: ${diagnosisCode}`)
  }
  const [row] = await tx
    .insert(consentDocument)
    .values({
      organizationId: orgId,
      templateId: template.id,
      templateVersion: template.version,
      bodySnapshot: template.body,
      titleSnapshot: template.title,
      sectionsSnapshot: template.sections,
      diagnosisCode: diagnosisCode ?? null,
      patientId: input.patientId,
      encounterId,
      planItemId,
      procedureRef,
      signerKind: "paciente",
      signerName: "",
      status: "pendiente",
      authorUserId: actorUserId,
    })
    .returning()
  await tx.insert(consentEvent).values({
    organizationId: orgId,
    documentId: row.id,
    fromStatus: null,
    toStatus: "pendiente",
    actorUserId,
    reason: "Documento creado",
  })
  await audit(tx, orgId, actorUserId, "consent.create", "consent_document", row.id, {
    template: template.key,
  })
  // Sin aviso a quien lo generó: lo hizo él mismo y lo ve en la ficha.
  return row
}

export interface SignConsentInput {
  signerKind: "paciente" | "representante"
  /**
   * Persona vinculada que firma: el propio paciente o su representante legal
   * vigente. Obligatoria: nombre y documento salen de su registro y la
   * facultad se verifica; no hay firmante declarado a mano.
   */
  signerContactId: string
  /** Solo si el registro de la persona no tiene documento. */
  signerDoc?: string | null
  representativeRelation?: string | null
  /** Trazo manuscrito de quien firma. */
  signatureData: unknown
  /** La persona firmante confirmó haber comprendido la información. */
  comprehensionConfirmed: boolean
  /** Firma manuscrita del profesional que informa (el actor). */
  professionalSignature: unknown
  witness?: { name: string; doc?: string | null } | null
  /** Hora en que se informó; por defecto, ahora. */
  informedAt?: string | null
}

function assertSignatureData(raw: unknown, label = "La firma manuscrita"): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw validation(`${label} es obligatoria`)
  }
  const strokes: unknown = "strokes" in raw ? raw.strokes : undefined
  const image: unknown = "image" in raw ? raw.image : undefined
  if (strokes !== undefined) {
    if (!Array.isArray(strokes) || strokes.length === 0) {
      throw validation(`${label} está vacía`)
    }
    if (strokes.length > 500) throw validation(`${label} supera el tamaño permitido`)
    let points = 0
    for (const stroke of strokes) {
      if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > 5000)
        throw validation(`${label} tiene un trazo inválido`)
      for (const point of stroke) {
        if (
          !Array.isArray(point) ||
          point.length !== 2 ||
          !point.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1000)
        )
          throw validation(`${label} tiene coordenadas fuera del recuadro`)
      }
      points += stroke.length
    }
    if (points > 20000) throw validation(`${label} supera el tamaño permitido`)
    return { strokes }
  }
  if (typeof image !== "string" || image.length < 100) {
    throw validation(`${label} está vacía`)
  }
  if (image.length > 500_000) throw validation(`${label} supera el tamaño permitido`)
  if (!image.startsWith("data:image/png;base64,"))
    throw validation(`${label} debe ser una imagen PNG`)
  return { image }
}

/** Edad cumplida en años a una fecha (AAAA-MM-DD). */
function ageOn(birthDate: string, on: Date): number {
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number]
  let age = on.getUTCFullYear() - y
  const month = on.getUTCMonth() + 1
  if (month < m || (month === m && on.getUTCDate() < d)) age -= 1
  return age
}

/**
 * Firma del consentimiento: firma la propia persona (si es mayor de edad) o
 * su representante legal vigente, y firma el profesional que informa. El
 * sistema no certifica identidad digital: guarda autor, firmantes y evidencia.
 */
export async function signConsentDocument(
  tx: Db,
  orgId: string,
  actorUserId: string,
  documentId: string,
  input: SignConsentInput,
): Promise<ConsentDocumentRow> {
  const [current] = await tx
    .select()
    .from(consentDocument)
    .where(and(eq(consentDocument.id, documentId), eq(consentDocument.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!current) throw notFound("Consentimiento")
  if (current.status !== "pendiente") {
    throw conflict("SIGNED", "El consentimiento ya no está pendiente")
  }
  if (input.signerKind !== "paciente" && input.signerKind !== "representante") {
    throw validation("Firmante inválido: paciente|representante")
  }
  if (!input.signerContactId)
    throw validation("Elige a la persona que firma: el paciente o su representante legal vigente")
  if (input.comprehensionConfirmed !== true)
    throw validation("La persona firmante debe confirmar que comprendió la información")
  const subject = await requirePatient(tx, orgId, current.patientId)
  const now = new Date()
  const minor = subject.birthDate ? ageOn(subject.birthDate, now) < 18 : false
  if (minor && input.signerKind !== "representante")
    throw validation("El paciente es menor de edad: firma su representante legal vigente")
  let verified: { displayName: string; docNumber: string | null; docType: string | null }
  if (input.signerKind === "paciente") {
    const linked = await requireLinkedActiveContact(tx, orgId, current.patientId, input.signerContactId)
    if (linked.relationship !== "self")
      throw conflict("SIGNER_NOT_AUTHORIZED", "Solo la propia persona firma como paciente")
    verified = linked.contact
  } else {
    const linked = await requireLinkedActiveContact(tx, orgId, current.patientId, input.signerContactId)
    if (linked.relationship === "self")
      throw conflict("SIGNER_NOT_AUTHORIZED", "La propia persona firma como paciente, no como representante")
    // Facultad legal vigente sobre este paciente, no un vínculo cualquiera.
    verified = await requireDecisionContact(tx, orgId, current.patientId, input.signerContactId)
  }
  const signerName = assertName(verified.displayName, "Nombre de quien firma", 200)
  const signerDoc = assertOptionalText(
    verified.docNumber ? `${verified.docType ?? ""} ${verified.docNumber}`.trim() : input.signerDoc,
    "Documento de quien firma",
    40,
  )
  let representativeRelation: string | null = null
  if (input.signerKind === "representante") {
    representativeRelation =
      assertOptionalText(input.representativeRelation, "Parentesco o relación", 120) ??
      "Representante legal"
    if (!signerDoc) throw validation("El representante necesita documento de identidad")
  }
  const signatureData = assertSignatureData(input.signatureData)
  const professionalSignature = assertSignatureData(
    input.professionalSignature,
    "La firma del profesional",
  )
  const informer = await requireProfessionalSignature(tx, orgId, actorUserId)
  let informedAt = now
  if (input.informedAt) {
    informedAt = new Date(input.informedAt)
    if (Number.isNaN(informedAt.getTime()) || informedAt.getTime() > now.getTime() + 60_000)
      throw validation("La hora en que se informó no es válida")
    if (informedAt < current.createdAt)
      throw validation("No se puede informar antes de generar el documento")
  }
  let witnessName: string | null = null
  let witnessDoc: string | null = null
  if (input.witness) {
    witnessName = assertName(input.witness.name, "Nombre del testigo", 200)
    witnessDoc = assertOptionalText(input.witness.doc, "Documento del testigo", 40)
  }
  const [row] = await tx
    .update(consentDocument)
    .set({
      signerKind: input.signerKind,
      signerContactId: input.signerContactId,
      signerName,
      signerDoc,
      representativeRelation,
      signatureData,
      comprehensionConfirmed: true,
      professionalSignature,
      informedAt,
      informedBy: actorUserId,
      informerName: informer.name,
      informerTitle: informer.title,
      informerRegistration: informer.registration,
      witnessName,
      witnessDoc,
      status: "firmado",
      signedAt: now,
      updatedAt: now,
    })
    .where(and(eq(consentDocument.id, documentId), eq(consentDocument.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Consentimiento")
  await tx.insert(consentEvent).values([
    {
      organizationId: orgId,
      documentId,
      fromStatus: "pendiente",
      toStatus: "informado",
      actorUserId,
      reason: `${informer.name} · ${informer.registration}`,
      createdAt: informedAt,
    },
    {
      organizationId: orgId,
      documentId,
      fromStatus: "pendiente",
      toStatus: "firmado",
      actorUserId,
      reason: `${input.signerKind}: ${signerName}${witnessName ? ` · testigo ${witnessName}` : ""}`,
    },
  ])
  await audit(tx, orgId, actorUserId, "consent.sign", "consent_document", documentId, {
    signerKind: input.signerKind,
    minor,
    witness: Boolean(witnessName),
  })
  // Si quien recabó la firma no es el autor, se avisa al autor del documento.
  if (row.authorUserId && row.authorUserId !== actorUserId) {
    await notifyUser(tx, orgId, row.authorUserId, {
      dedupeKey: `consent-${row.id}-firmado`,
      title: "Un consentimiento fue firmado",
      body: "Un consentimiento que generaste ya tiene firma registrada.",
      href: `/patients/${row.patientId}`,
      actorUserId,
    })
  }
  return row
}

/** Anula un pendiente: desaparece de los pendientes y no cuenta como consentimiento. */
export async function cancelConsentDocument(
  tx: Db,
  orgId: string,
  actorUserId: string,
  documentId: string,
  reason: string,
): Promise<ConsentDocumentRow> {
  const [current] = await tx
    .select()
    .from(consentDocument)
    .where(and(eq(consentDocument.id, documentId), eq(consentDocument.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!current) throw notFound("Consentimiento")
  if (current.status !== "pendiente")
    throw conflict("CONSENT_STATUS", "Solo un consentimiento pendiente se anula; uno firmado se revoca")
  const clean = (reason ?? "").trim()
  if (!clean || clean.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
  const [row] = await tx
    .update(consentDocument)
    .set({
      status: "anulado",
      cancelledAt: new Date(),
      cancelledBy: actorUserId,
      cancelReason: clean,
      updatedAt: new Date(),
    })
    .where(and(eq(consentDocument.id, documentId), eq(consentDocument.organizationId, orgId)))
    .returning()
  await tx.insert(consentEvent).values({
    organizationId: orgId,
    documentId,
    fromStatus: "pendiente",
    toStatus: "anulado",
    actorUserId,
    reason: clean,
  })
  await audit(tx, orgId, actorUserId, "consent.cancel", "consent_document", documentId, {})
  return row!
}

export interface RevokeConsentInput {
  reason: string
  /** Quien revoca: la propia persona o su representante legal vigente. */
  revokerContactId: string
  signatureData: unknown
}

/**
 * Revocación: la decide la persona (o su representante legal vigente), con
 * motivo y su firma. El documento firmado no se altera; el tratamiento vuelve
 * a requerir consentimiento.
 */
export async function revokeConsentDocument(
  tx: Db,
  orgId: string,
  actorUserId: string,
  documentId: string,
  input: RevokeConsentInput,
): Promise<ConsentDocumentRow> {
  const [current] = await tx
    .select()
    .from(consentDocument)
    .where(and(eq(consentDocument.id, documentId), eq(consentDocument.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!current) throw notFound("Consentimiento")
  if (current.status !== "firmado") {
    throw conflict("CONSENT_STATUS", "Solo un consentimiento firmado puede revocarse")
  }
  const clean = (input.reason ?? "").trim()
  if (!clean) throw validation("La revocación necesita un motivo")
  if (clean.length > 2000) throw validation("El motivo supera 2000 caracteres")
  if (!input.revokerContactId) throw validation("Indica quién revoca")
  const subject = await requirePatient(tx, orgId, current.patientId)
  const minor = subject.birthDate ? ageOn(subject.birthDate, new Date()) < 18 : false
  const linked = await requireLinkedActiveContact(tx, orgId, current.patientId, input.revokerContactId)
  if (linked.relationship === "self" && minor)
    throw validation("El paciente es menor de edad: revoca su representante legal vigente")
  const revoker =
    linked.relationship === "self"
      ? linked.contact
      : await requireDecisionContact(tx, orgId, current.patientId, input.revokerContactId)
  const revokeSignature = assertSignatureData(input.signatureData, "La firma de quien revoca")
  const [row] = await tx
    .update(consentDocument)
    .set({
      status: "revocado",
      revokedAt: new Date(),
      revokeReason: clean,
      revokerName: revoker.displayName,
      revokerContactId: input.revokerContactId,
      revokeSignature,
      updatedAt: new Date(),
    })
    .where(and(eq(consentDocument.id, documentId), eq(consentDocument.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Consentimiento")
  await tx.insert(consentEvent).values({
    organizationId: orgId,
    documentId,
    fromStatus: "firmado",
    toStatus: "revocado",
    actorUserId,
    reason: `${revoker.displayName}: ${clean}`,
  })
  await audit(tx, orgId, actorUserId, "consent.revoke", "consent_document", documentId, {})
  return row
}

/** Asocia el PDF generado (documento clínico) y su huella SHA-256, una sola vez. */
export async function attachConsentPdf(
  tx: Db,
  orgId: string,
  actorUserId: string,
  documentId: string,
  input: { pdfDocumentId: string; sha256: string },
): Promise<ConsentDocumentRow> {
  const [current] = await tx
    .select()
    .from(consentDocument)
    .where(and(eq(consentDocument.id, documentId), eq(consentDocument.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!current) throw notFound("Consentimiento")
  if (current.status !== "firmado" && current.status !== "revocado")
    throw conflict("CONSENT_STATUS", "Solo un consentimiento firmado genera PDF")
  if (current.pdfDocumentId) throw conflict("PDF_EXISTS", "El consentimiento ya tiene su PDF")
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw validation("Huella SHA-256 inválida")
  const [row] = await tx
    .update(consentDocument)
    .set({ pdfDocumentId: input.pdfDocumentId, pdfSha256: input.sha256, updatedAt: new Date() })
    .where(and(eq(consentDocument.id, documentId), eq(consentDocument.organizationId, orgId)))
    .returning()
  await audit(tx, orgId, actorUserId, "consent.pdf", "consent_document", documentId, {
    pdfDocumentId: input.pdfDocumentId,
    sha256: input.sha256,
  })
  return row!
}

/** Datos del documento para imprimir o generar el PDF. */
export async function getConsentPrint(tx: Db, orgId: string, documentId: string) {
  const [doc] = await tx
    .select()
    .from(consentDocument)
    .where(and(eq(consentDocument.id, documentId), eq(consentDocument.organizationId, orgId)))
    .limit(1)
  if (!doc) throw notFound("Consentimiento")
  const [person] = await tx
    .select({
      displayName: patient.displayName,
      patientNumber: patient.patientNumber,
      docType: patient.docType,
      docNumber: patient.docNumber,
      birthDate: patient.birthDate,
    })
    .from(patient)
    .where(and(eq(patient.id, doc.patientId), eq(patient.organizationId, orgId)))
  if (!person) throw notFound("Paciente")
  const [org] = await tx
    .select({
      legalName: orgProfile.legalName,
      tradeName: orgProfile.tradeName,
      fiscalDocType: orgProfile.fiscalDocType,
      fiscalDocNumber: orgProfile.fiscalDocNumber,
      address: orgProfile.fiscalAddress,
      // Con qué formato y en qué zona se escriben las fechas del documento.
      locale: orgProfile.locale,
      timezone: orgProfile.timezone,
    })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
  const [dx] = doc.diagnosisCode
    ? await tx
        .select({ description: cie10Code.description })
        .from(cie10Code)
        .where(eq(cie10Code.code, doc.diagnosisCode))
    : []
  const minor = person.birthDate ? ageOn(person.birthDate, new Date()) < 18 : false
  return {
    document: doc,
    diagnosisDescription: dx?.description ?? null,
    patient: { ...person, minor },
    establishment: org ?? null,
  }
}

export async function listConsentDocuments(
  tx: Db,
  orgId: string,
  query: { patientId: string; status?: string },
): Promise<ConsentDocumentRow[]> {
  await requirePatient(tx, orgId, query.patientId)
  const conditions = [
    eq(consentDocument.organizationId, orgId),
    eq(consentDocument.patientId, query.patientId),
  ]
  if (query.status) {
    if (!["pendiente", "firmado", "revocado", "anulado"].includes(query.status)) {
      throw validation("Estado inválido: pendiente|firmado|revocado|anulado")
    }
    conditions.push(eq(consentDocument.status, query.status))
  }
  return tx
    .select()
    .from(consentDocument)
    .where(and(...conditions))
    .orderBy(desc(consentDocument.createdAt))
}

/** Paciente dueño de un consentimiento: para dejar traza de su lectura (404 si no existe). */
export async function consentDocumentPatientId(
  tx: Db,
  orgId: string,
  documentId: string,
): Promise<string> {
  const [doc] = await tx
    .select({ patientId: consentDocument.patientId })
    .from(consentDocument)
    .where(and(eq(consentDocument.id, documentId), eq(consentDocument.organizationId, orgId)))
    .limit(1)
  if (!doc) throw notFound("Consentimiento")
  return doc.patientId
}

export async function listConsentEvents(
  tx: Db,
  orgId: string,
  documentId: string,
): Promise<(typeof consentEvent.$inferSelect)[]> {
  await consentDocumentPatientId(tx, orgId, documentId)
  return tx
    .select()
    .from(consentEvent)
    .where(and(eq(consentEvent.organizationId, orgId), eq(consentEvent.documentId, documentId)))
    // A igual hora, el orden del flujo: informar precede a firmar.
    .orderBy(
      asc(consentEvent.createdAt),
      sql`array_position(array['pendiente','informado','firmado','revocado','anulado'], ${consentEvent.toStatus})`,
    )
}

// ---------------------------------------------------------------------------
// Órdenes de laboratorio / interconsulta
// ---------------------------------------------------------------------------

export type OrderRow = typeof clinicalOrder.$inferSelect

export interface CreateOrderInput {
  kind: "laboratorio" | "interconsulta"
  specialtyId?: string | null
  patientId: string
  encounterId?: string | null
  recipient: string
  title: string
  detail?: string | null
}

export async function createClinicalOrder(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateOrderInput,
): Promise<OrderRow> {
  if (input.kind !== "laboratorio" && input.kind !== "interconsulta") {
    throw validation("Tipo inválido: laboratorio|interconsulta")
  }
  await requirePatient(tx, orgId, input.patientId)
  let specialtyId: string | null = null
  if (input.specialtyId) {
    const specialty = await requireSpecialty(tx, orgId, input.specialtyId)
    if (!specialty.isActive) throw validation("La especialidad está inactiva")
    specialtyId = specialty.id
  }
  let encounterId: string | null = null
  if (input.encounterId) {
    await requireVisibleEncounter(tx, orgId, input.patientId, input.encounterId)
    encounterId = input.encounterId
  }
  const recipient = assertName(input.recipient, "Destinatario", 200)
  const title = assertName(input.title, "Título de la orden", 200)
  const detail = assertOptionalText(input.detail, "Detalle", 5000)
  const [row] = await tx
    .insert(clinicalOrder)
    .values({
      organizationId: orgId,
      kind: input.kind,
      specialtyId,
      patientId: input.patientId,
      encounterId,
      fromUserId: actorUserId,
      recipient,
      title,
      detail,
      status: "solicitado",
    })
    .returning()
  await audit(tx, orgId, actorUserId, "order.create", "clinical_order", row.id, {
    kind: input.kind,
  })
  // Responsable: profesionales adscritos a la especialidad destino; sin ellos,
  // el solicitante (da seguimiento al destinatario externo libre).
  const responsible = row.specialtyId
    ? (
        await tx
          .select({ userId: professionalSpecialty.userId })
          .from(professionalSpecialty)
          .where(
            and(
              eq(professionalSpecialty.organizationId, orgId),
              eq(professionalSpecialty.specialtyId, row.specialtyId),
            ),
          )
      ).map((r) => r.userId)
    : []
  const recipients = [...new Set(responsible.length > 0 ? responsible : [actorUserId])]
  for (const userId of recipients) {
    await notifyUser(tx, orgId, userId, {
      dedupeKey: `clinical-order-${row.id}-solicitado`,
      title: "Nueva orden clínica por atender",
      body: "Tienes una orden clínica pendiente de atención.",
      href: `/patients/${row.patientId}`,
      actorUserId,
      // Se retira cuando alguien la toma o se cancela.
      subject: `orden-clinica:${row.id}`,
    })
  }
  return row
}

export async function advanceClinicalOrder(
  tx: Db,
  orgId: string,
  actorUserId: string,
  orderId: string,
  toStatus: "en_proceso" | "completado" | "cancelado",
  resultText?: string | null,
): Promise<OrderRow> {
  const [current] = await tx
    .select()
    .from(clinicalOrder)
    .where(and(eq(clinicalOrder.id, orderId), eq(clinicalOrder.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!current) throw notFound("Orden")
  const allowed: Record<string, string[]> = {
    solicitado: ["en_proceso", "cancelado"],
    en_proceso: ["completado", "cancelado"],
    completado: [],
    cancelado: [],
  }
  if (!allowed[current.status]?.includes(toStatus)) {
    throw conflict("TRANSITION", `No puede pasar de ${current.status} a ${toStatus}`)
  }
  const result = assertOptionalText(resultText, "Resultado", 10000)
  if (toStatus === "completado" && !result) {
    throw validation("Completar la orden necesita el resultado")
  }
  const [row] = await tx
    .update(clinicalOrder)
    .set({
      status: toStatus,
      resultText: toStatus === "completado" ? result : current.resultText,
      resultAt: toStatus === "completado" ? new Date() : current.resultAt,
      completedBy: toStatus === "completado" ? actorUserId : current.completedBy,
      updatedAt: new Date(),
    })
    .where(and(eq(clinicalOrder.id, orderId), eq(clinicalOrder.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Orden")
  await audit(tx, orgId, actorUserId, "order.status", "clinical_order", orderId, {
    from: current.status,
    to: toStatus,
  })
  // Resultado disponible: se avisa al solicitante (si no fue quien completó).
  if (toStatus === "completado" && row.fromUserId && row.fromUserId !== actorUserId) {
    await notifyUser(tx, orgId, row.fromUserId, {
      dedupeKey: `clinical-order-${row.id}-completado`,
      title: "Una orden clínica tiene resultado disponible",
      body: "Ya puedes revisar el resultado de la orden clínica.",
      href: `/patients/${row.patientId}`,
      actorUserId,
    })
  }
  return row
}

export async function listClinicalOrders(
  tx: Db,
  orgId: string,
  query: { patientId?: string; status?: string; kind?: string; specialtyId?: string },
): Promise<OrderRow[]> {
  const conditions = [eq(clinicalOrder.organizationId, orgId)]
  if (query.patientId) {
    await requirePatient(tx, orgId, query.patientId)
    conditions.push(eq(clinicalOrder.patientId, query.patientId))
  }
  if (query.status) {
    if (!["solicitado", "en_proceso", "completado", "cancelado"].includes(query.status)) {
      throw validation("Estado de orden inválido")
    }
    conditions.push(eq(clinicalOrder.status, query.status))
  }
  if (query.kind) {
    if (query.kind !== "laboratorio" && query.kind !== "interconsulta") {
      throw validation("Tipo inválido: laboratorio|interconsulta")
    }
    conditions.push(eq(clinicalOrder.kind, query.kind))
  }
  if (query.specialtyId) conditions.push(eq(clinicalOrder.specialtyId, query.specialtyId))
  return tx
    .select()
    .from(clinicalOrder)
    .where(and(...conditions))
    .orderBy(desc(clinicalOrder.createdAt))
}

