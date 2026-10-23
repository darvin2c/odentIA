import type { Db } from "@odentia/db"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { orgSpecialty, serviceCatalog, treatmentTemplate } from "@odentia/db/schema/clinical"
import { professionalSpecialty } from "@odentia/db/schema/clinical-forms"
import { and, eq, inArray, sql } from "drizzle-orm"
import { validation } from "./errors.js"
import { findOrgCountry } from "./locale.js"
import { type CatalogSpecialty, kindOfSpecialty, type ProductCatalog, specialtyForKind } from "./product-catalog.js"
import { productHooks } from "./products.js"

/** El catálogo del producto de la clínica y las especialidades de su país (ADR 0079). */
async function orgCatalog(tx: Db, orgId: string): Promise<{ catalog: ProductCatalog; specialties: readonly CatalogSpecialty[] }> {
  const { catalog } = await productHooks(tx, orgId)
  return { catalog, specialties: catalog.specialties(await findOrgCountry(tx, orgId)) }
}

/**
 * Una sola lista de especialidades, la de la clínica (ADR 0039). Nace con las
 * del perfil de su país (ADR 0069): en Perú, las del DS 023-2020-SA que
 * atienden pacientes; sin perfil, la lista del núcleo. El servicio apunta a
 * una por id, y la agenda ofrece el servicio a quien la atiende. Toda función
 * recibe un `tx` ya dentro de `withOrgContext`.
 */

/**
 * Las especialidades del país que le faltan a la clínica, con su nombre
 * inicial. No toca las que ya tiene (renombradas o archivadas): solo agrega
 * las claves que faltan. Se llama al crear la clínica.
 */
export async function ensureClinicSpecialties(tx: Db, orgId: string): Promise<void> {
  const { specialties } = await orgCatalog(tx, orgId)
  if (specialties.length === 0) return
  await tx
    .insert(orgSpecialty)
    .values(specialties.map((item) => ({ organizationId: orgId, key: item.key, name: item.name })))
    .onConflictDoNothing({ target: [orgSpecialty.organizationId, orgSpecialty.key] })
}

/**
 * La especialidad de la clínica que recibe cada tipo de la biblioteca: así se
 * resuelve un servicio que se agrega desde la biblioteca. Si la clínica aún
 * no la tiene, nace con su nombre inicial; si la archivó, se usa igual (el
 * servicio sigue diciendo su especialidad). Devuelve tipo → id.
 */
export async function librarySpecialtyIds(tx: Db, orgId: string, kinds: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(kinds)]
  if (wanted.length === 0) return new Map()
  const { specialties } = await orgCatalog(tx, orgId)
  const keyOfKind = new Map<string, string>()
  for (const kind of wanted) {
    const owner = specialtyForKind(specialties, kind)
    if (owner) keyOfKind.set(kind, owner.key)
  }
  const keys = [...new Set(keyOfKind.values())]
  if (keys.length === 0) return new Map()
  const read = () =>
    tx
      .select({ id: orgSpecialty.id, key: orgSpecialty.key })
      .from(orgSpecialty)
      .where(and(eq(orgSpecialty.organizationId, orgId), inArray(orgSpecialty.key, keys)))
  let rows = await read()
  if (rows.length < keys.length) {
    await ensureClinicSpecialties(tx, orgId)
    rows = await read()
  }
  const idOfKey = new Map(rows.map((row) => [row.key, row.id]))
  const out = new Map<string, string>()
  for (const [kind, key] of keyOfKind) {
    const id = idOfKey.get(key)
    if (id) out.set(kind, id)
  }
  return out
}

/** Especialidad de esta clínica; una de otra clínica o inexistente es un dato inválido (400). */
export async function requireOrgSpecialtyId(tx: Db, orgId: string, specialtyId: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(specialtyId)) {
    throw validation("Elige una especialidad de la clínica")
  }
  const [row] = await tx
    .select({ id: orgSpecialty.id })
    .from(orgSpecialty)
    .where(and(eq(orgSpecialty.organizationId, orgId), eq(orgSpecialty.id, specialtyId)))
    .limit(1)
  if (!row) throw validation("Elige una especialidad de la clínica")
  return row.id
}

/**
 * El tipo de tratamiento de un servicio (ADR 0069), para la fase del plan y
 * las palabras del agente: el de su tratamiento si viene de la biblioteca; si
 * es propio, el de su especialidad del país; null con una especialidad que
 * creó la clínica o sin especialidad.
 */
export async function serviceKindOf(
  tx: Db,
  orgId: string,
  service: { templateId: string | null; specialtyId: string | null },
): Promise<string | null> {
  if (service.templateId) {
    const [row] = await tx
      .select({ kind: treatmentTemplate.kind })
      .from(treatmentTemplate)
      .where(eq(treatmentTemplate.id, service.templateId))
      .limit(1)
    if (row) return row.kind
  }
  if (!service.specialtyId) return null
  const [row] = await tx
    .select({ key: orgSpecialty.key })
    .from(orgSpecialty)
    .where(and(eq(orgSpecialty.organizationId, orgId), eq(orgSpecialty.id, service.specialtyId)))
    .limit(1)
  const { catalog, specialties } = await orgCatalog(tx, orgId)
  return kindOfSpecialty(catalog, specialties, row?.key)
}

/** A quién ofrece la agenda un servicio en una sede, si la regla aplica. */
export interface AttendingRule {
  /** Nombre de la especialidad de la clínica, como se lee en pantalla. */
  specialtyName: string
  /** Quienes la atienden y tienen horario en esa sede. */
  professionalUserIds: string[]
}

/**
 * La regla de la agenda (decisiones 2 y 3 de la fase 4), la misma para
 * recepción, el enlace de reserva, el portal y el agente: si el servicio tiene
 * una especialidad activa y alguien adscrito a ella tiene horario en esa sede,
 * se ofrecen solo sus huecos. Si nadie la atiende ahí, la regla no aplica y
 * se ofrece a cualquiera, como antes: no castiga a la clínica que todavía no
 * terminó de configurar (Especialidades lo avisa).
 */
export async function attendingRule(
  tx: Db,
  orgId: string,
  input: { serviceId: string; branchId: string },
): Promise<AttendingRule | null> {
  const [service] = await tx
    .select({ specialtyId: serviceCatalog.specialtyId, specialtyName: orgSpecialty.name, active: orgSpecialty.isActive })
    .from(serviceCatalog)
    .innerJoin(
      orgSpecialty,
      and(eq(orgSpecialty.organizationId, serviceCatalog.organizationId), eq(orgSpecialty.id, serviceCatalog.specialtyId)),
    )
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.id, input.serviceId)))
    .limit(1)
  if (!service?.specialtyId || !service.active) return null
  const rows = await tx
    .selectDistinct({ userId: professionalSpecialty.userId })
    .from(professionalSpecialty)
    .innerJoin(
      professionalSchedule,
      and(
        eq(professionalSchedule.organizationId, professionalSpecialty.organizationId),
        eq(professionalSchedule.professionalUserId, professionalSpecialty.userId),
        eq(professionalSchedule.branchId, input.branchId),
        eq(professionalSchedule.isActive, true),
      ),
    )
    .where(and(eq(professionalSpecialty.organizationId, orgId), eq(professionalSpecialty.specialtyId, service.specialtyId)))
    .orderBy(sql`1`)
  if (rows.length === 0) return null
  return { specialtyName: service.specialtyName, professionalUserIds: rows.map((row) => row.userId) }
}
