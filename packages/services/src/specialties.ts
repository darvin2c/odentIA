import { LIBRARY_SPECIALTIES } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { orgSpecialty, serviceCatalog } from "@odentia/db/schema/clinical"
import { professionalSpecialty } from "@odentia/db/schema/clinical-forms"
import { and, eq, inArray, sql } from "drizzle-orm"
import { validation } from "./errors.js"

/**
 * Una sola lista de especialidades, la de la clínica (ADR 0039, decisiones 1
 * a 3 de la fase 4). Nace con las de la biblioteca y la misma clave; el
 * servicio apunta a una por id, y la agenda ofrece el servicio a quien la
 * atiende. Toda función recibe un `tx` ya dentro de `withOrgContext`.
 */

/**
 * Las especialidades de la biblioteca que le faltan a la clínica, con su
 * nombre inicial. No toca las que ya tiene (renombradas o archivadas): solo
 * agrega las claves que faltan. Se llama al crear la organización.
 */
export async function ensureLibrarySpecialties(tx: Db, orgId: string): Promise<void> {
  await tx
    .insert(orgSpecialty)
    .values(LIBRARY_SPECIALTIES.map((item) => ({ organizationId: orgId, key: item.key, name: item.name })))
    .onConflictDoNothing({ target: [orgSpecialty.organizationId, orgSpecialty.key] })
}

/**
 * La especialidad de la clínica con esa clave de la biblioteca: así se
 * resuelve un servicio que se agrega desde la biblioteca. Si la clínica aún
 * no la tiene, nace con su nombre inicial; si la archivó, se usa igual (el
 * servicio sigue diciendo su especialidad).
 */
export async function librarySpecialtyIds(tx: Db, orgId: string, keys: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(keys)]
  if (wanted.length === 0) return new Map()
  const read = () =>
    tx
      .select({ id: orgSpecialty.id, key: orgSpecialty.key })
      .from(orgSpecialty)
      .where(and(eq(orgSpecialty.organizationId, orgId), inArray(orgSpecialty.key, wanted)))
  let rows = await read()
  if (rows.length < wanted.length) {
    await ensureLibrarySpecialties(tx, orgId)
    rows = await read()
  }
  return new Map(rows.map((row) => [row.key, row.id]))
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

/** Nombre y clave de la especialidad de un servicio (para la fase del plan y lo que lee el agente). */
export async function serviceSpecialtyOf(
  tx: Db,
  orgId: string,
  specialtyId: string | null,
): Promise<{ key: string; name: string } | null> {
  if (!specialtyId) return null
  const [row] = await tx
    .select({ key: orgSpecialty.key, name: orgSpecialty.name })
    .from(orgSpecialty)
    .where(and(eq(orgSpecialty.organizationId, orgId), eq(orgSpecialty.id, specialtyId)))
    .limit(1)
  return row ?? null
}

/** A quién ofrece la agenda un servicio en una sede, si la regla aplica. */
export interface AttendingRule {
  /** Nombre de la especialidad de la clínica, como se lee en pantalla. */
  specialtyName: string
  /** Quienes la atienden y tienen horario en esa sede. */
  dentistUserIds: string[]
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
        eq(professionalSchedule.dentistUserId, professionalSpecialty.userId),
        eq(professionalSchedule.branchId, input.branchId),
        eq(professionalSchedule.isActive, true),
      ),
    )
    .where(and(eq(professionalSpecialty.organizationId, orgId), eq(professionalSpecialty.specialtyId, service.specialtyId)))
    .orderBy(sql`1`)
  if (rows.length === 0) return null
  return { specialtyName: service.specialtyName, dentistUserIds: rows.map((row) => row.userId) }
}
