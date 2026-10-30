import {
  clinicalProfileFor,
  normalizePostalAddress,
  placeDirectionsUrl,
  postalAddressErrors,
  postalAddressText,
  type PostalAddress,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { fieldsError, invalidField, notFound, ServiceError } from "./errors.js"
import { findOrgCountry } from "./locale.js"
import { clinicOriginOf } from "./public-links.js"

export type BranchRow = typeof branch.$inferSelect

/** Las columnas de la dirección de una sede, para leerlas anidadas en una consulta. */
export const branchAddressColumns = {
  line: branch.addressLine1,
  city: branch.city,
  district: branch.district,
  region: branch.region,
  postalCode: branch.postalCode,
  country: branch.country,
}

/** La dirección de una fila de sede, en la forma común (FHIR Address). */
export function branchPostal(row: Pick<BranchRow, "addressLine1" | "city" | "district" | "region" | "postalCode" | "country">): PostalAddress {
  return { line: row.addressLine1, city: row.city, district: row.district, region: row.region, postalCode: row.postalCode, country: row.country }
}

/**
 * Cómo se escribe en una línea la dirección de una sede de esta clínica
 * («Av. José Larco 345 · Miraflores, Lima Metropolitana»): la región con el
 * nombre de la lista de su país. Se lee el país una vez para muchas sedes.
 */
export async function branchAddressWriter(tx: Db, orgId: string): Promise<(address: PostalAddress) => string | null> {
  const profile = clinicalProfileFor(await findOrgCountry(tx, orgId))
  return (address) => postalAddressText(profile, address)
}

/**
 * «Cómo llegar» a una sede de esta clínica (issue 36): su ficha de Google si
 * se eligió de la lista, o su dirección con el nombre de la clínica. Sin
 * dirección, null. Se lee la clínica una vez para muchas sedes.
 */
export async function branchDirectionsWriter(
  tx: Db,
  orgId: string,
): Promise<(place: { address: PostalAddress; placeId: string | null }) => string | null> {
  const [org] = await tx
    .select({ country: orgProfile.countryCode, tradeName: orgProfile.tradeName, legalName: orgProfile.legalName })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  const profile = clinicalProfileFor(org?.country)
  const name = org?.tradeName ?? org?.legalName ?? null
  return (place) => placeDirectionsUrl(profile, { name, address: place.address, placeId: place.placeId })
}

/**
 * El enlace corto de la clínica para llegar a una sede
 * (`https://<clínica>/llegar/<sede>`): el que manda Sofi y el que se copia en
 * Sedes. Nulo sin dirección pública configurada.
 */
export async function branchShortLinkWriter(tx: Db, orgId: string): Promise<(branchSlug: string) => string | null> {
  const origin = await clinicOriginOf(tx, orgId)
  return (branchSlug) => (origin ? `${origin}/llegar/${encodeURIComponent(branchSlug)}` : null)
}

/**
 * Lo que abre el enlace corto: a dónde llevar en Google Maps. Solo sedes
 * activas y con dirección; lo demás no existe para quien no tiene sesión.
 */
export async function getBranchDirections(
  tx: Db,
  orgId: string,
  branchSlug: string,
): Promise<{ branchName: string; url: string }> {
  const [row] = await tx
    .select({ name: branch.name, address: branchAddressColumns, placeId: branch.googlePlaceId })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.slug, branchSlug), eq(branch.isActive, true)))
    .limit(1)
  const url = row ? (await branchDirectionsWriter(tx, orgId))(row) : null
  if (!row || !url) throw notFound("Sede")
  return { branchName: row.name, url }
}

/** Lo que se escribe de una sede: nombre, dirección (la forma del paciente), contacto y zona horaria. */
export interface BranchInput {
  name: string
  addressLine1?: string | null
  city?: string | null
  district?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
  /** La ficha de la sede en Google Maps, si se eligió de las sugerencias (issue 36). */
  googlePlaceId?: string | null
  phone?: string | null
  email?: string | null
  /** null = hereda la zona horaria de la clínica. */
  timezone?: string | null
}

const ADDRESS_KEYS = ["addressLine1", "city", "district", "region", "postalCode", "country"] as const

/** El campo de la dirección en el cuerpo de la sede (`BranchInput`). */
const BRANCH_ADDRESS_FIELD: Record<string, string> = { line: "addressLine1" }

function toPostal(value: Partial<BranchInput>): PostalAddress {
  return {
    line: value.addressLine1,
    city: value.city,
    district: value.district,
    region: value.region,
    postalCode: value.postalCode,
    country: value.country,
  }
}

/**
 * La dirección lista para guardar según el país de la clínica (issue 36):
 * misma validación que la del paciente. Lo guardado que no cambia no se
 * vuelve a juzgar. Un error se dice con el campo que hay que arreglar.
 */
async function branchAddress(
  tx: Db,
  orgId: string,
  next: Partial<BranchInput>,
  previous?: BranchRow,
): Promise<Pick<BranchRow, "addressLine1" | "city" | "district" | "region" | "postalCode" | "country">> {
  const profile = clinicalProfileFor(await findOrgCountry(tx, orgId))
  const merged: PostalAddress = {
    ...(previous ? toPostal(previous) : {}),
    ...Object.fromEntries(Object.entries(toPostal(next)).filter(([, value]) => value !== undefined)),
  }
  const errors = postalAddressErrors(profile, merged, previous ? toPostal(previous) : undefined)
  const failed = fieldsError(errors, (key) => BRANCH_ADDRESS_FIELD[key] ?? key)
  if (failed) throw failed
  const address = normalizePostalAddress(profile, merged)
  return {
    addressLine1: address.line,
    city: address.city,
    district: address.district,
    region: address.region,
    postalCode: address.postalCode,
    country: address.country ?? profile.country,
  }
}

function cleanName(name: string): string {
  const text = name.trim()
  if (!text || text.length > 120) throw invalidField("name", "Escribe el nombre de la sede (hasta 120 caracteres)")
  return text
}

/** Una sede nueva, con su dirección validada según el país de la clínica. */
export async function createBranch(tx: Db, orgId: string, actorUserId: string, input: BranchInput): Promise<BranchRow> {
  const [created] = await tx
    .insert(branch)
    .values({
      organizationId: orgId,
      name: cleanName(input.name),
      ...(await branchAddress(tx, orgId, input)),
      googlePlaceId: input.googlePlaceId?.trim() || null,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      timezone: input.timezone ?? null,
    })
    .returning()
  if (!created) throw new ServiceError("INTERNAL", 500, "No se pudo crear la sede")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "branch.create",
    entity: "branch",
    entityId: created.id,
    metadata: { name: created.name },
  })
  return created
}

/** Cambia lo que llega de una sede; lo que no llega queda como estaba. */
export async function updateBranch(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  patch: Partial<BranchInput>,
): Promise<BranchRow> {
  const [current] = await tx
    .select()
    .from(branch)
    .where(and(eq(branch.id, id), eq(branch.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!current) throw notFound("Sede")
  const set: Partial<typeof branch.$inferInsert> = { updatedAt: new Date() }
  if (patch.name !== undefined) set.name = cleanName(patch.name)
  if (ADDRESS_KEYS.some((key) => patch[key] !== undefined)) Object.assign(set, await branchAddress(tx, orgId, patch, current))
  if (patch.googlePlaceId !== undefined) set.googlePlaceId = patch.googlePlaceId?.trim() || null
  if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null
  if (patch.email !== undefined) set.email = patch.email?.trim() || null
  if (patch.timezone !== undefined) set.timezone = patch.timezone
  const [updated] = await tx
    .update(branch)
    .set(set)
    .where(and(eq(branch.id, id), eq(branch.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Sede")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "branch.update",
    entity: "branch",
    entityId: id,
    metadata: { fields: Object.keys(patch) },
  })
  return updated
}

/**
 * Desactiva o reactiva una sede. Desactivarla la saca de la agenda, de las
 * reservas y de lo que responde el agente; no borra nada: sus citas, horarios
 * y unidades dentales se conservan y vuelven tal cual al reactivarla. Repetir el mismo
 * estado no cambia nada ni deja otra entrada de auditoría.
 */
export async function setBranchActive(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  isActive: boolean,
): Promise<{ id: string; isActive: boolean }> {
  const [current] = await tx
    .select({ id: branch.id, isActive: branch.isActive })
    .from(branch)
    .where(and(eq(branch.id, id), eq(branch.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!current) throw new ServiceError("NOT_FOUND", 404, "Sede no encontrada")
  if (current.isActive === isActive) return current
  await tx
    .update(branch)
    .set({ isActive, updatedAt: new Date() })
    .where(and(eq(branch.id, id), eq(branch.organizationId, orgId)))
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: isActive ? "branch.reactivate" : "branch.deactivate",
    entity: "branch",
    entityId: id,
  })
  return { id, isActive }
}
