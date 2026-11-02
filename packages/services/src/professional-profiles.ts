/**
 * Registro profesional por organización: nombre de firma, título y colegiatura
 * con que el profesional firma atenciones, actas, recetas y consentimientos.
 * Cada documento firmado guarda su propia instantánea; editar el perfil nunca
 * reescribe lo ya firmado. Su firma dibujada (ADR 0131) es lo que se ve en el
 * papel: no acredita nada más que los datos del perfil y no es firma digital.
 */
import { ATTENDING_ROLES } from "@odentia/auth/permissions"
import type { SignatureStrokes } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { professionalDrawnSignature, professionalProfile } from "@odentia/db/schema/clinical-forms"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm"
import { requireCanAttend } from "./attending.js"
import { invalidField, notFound, ServiceError } from "./errors.js"

export interface ProfessionalProfile {
  userId: string
  /** Nombre de la cuenta, para mostrar si no hay nombre de firma. */
  accountName: string
  signatureName: string | null
  /** Como lo escribió la persona; vacío mientras no complete su perfil. */
  professionalTitle: string
  /** Colegio u organismo que emite su registro; vacío mientras no lo escriba. */
  registrationBody: string
  registrationNumber: string | null
  specialtyRegistration: string | null
  /** Firma lista: hay colegiatura registrada. */
  complete: boolean
  updatedAt: Date | null
}

export interface ProfessionalProfileInput {
  signatureName?: string | null
  professionalTitle?: string
  registrationBody?: string
  registrationNumber?: string | null
  specialtyRegistration?: string | null
  /** Solo la propia persona. Sin el dato no cambia; nulo es que la quita. */
  signatureStrokes?: unknown
}

/** Su propio perfil, con su firma: nadie más la recibe. */
export interface OwnProfessionalProfile extends ProfessionalProfile {
  signatureStrokes: SignatureStrokes | null
}

/** Instantánea con la que se firma un documento clínico. */
export interface ProfessionalSignature {
  name: string
  title: string
  /** Colegio y número, como se imprime: «<colegio> <número>». */
  registration: string
}

// Título y colegio dependen del país y de la profesión: no hay valor por
// defecto, los escribe cada profesional (o quien administra) en su perfil.
/** Colegiatura: letras, dígitos y guion; sin espacios ni símbolos. */
const REGISTRATION_RE = /^[A-Za-z0-9-]{1,20}$/

/** `key`: el nombre del dato en el cuerpo, para decir el error junto a su campo. */
function clean(value: string | null | undefined, key: string, field: string, max: number): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > max) throw invalidField(key, `${field} admite hasta ${max} caracteres`)
  return trimmed
}

async function requireMember(tx: Db, orgId: string, userId: string): Promise<string> {
  const [row] = await tx
    .select({ name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  if (!row) throw notFound("Profesional")
  return row.name
}

function toProfile(
  userId: string,
  accountName: string,
  row: typeof professionalProfile.$inferSelect | undefined,
): ProfessionalProfile {
  return {
    userId,
    accountName,
    signatureName: row?.signatureName ?? null,
    professionalTitle: row?.professionalTitle ?? "",
    registrationBody: row?.registrationBody ?? "",
    registrationNumber: row?.registrationNumber ?? null,
    specialtyRegistration: row?.specialtyRegistration ?? null,
    complete: Boolean(row?.registrationNumber),
    updatedAt: row?.updatedAt ?? null,
  }
}

export async function getProfessionalProfile(
  tx: Db,
  orgId: string,
  userId: string,
): Promise<ProfessionalProfile> {
  const accountName = await requireMember(tx, orgId, userId)
  const [row] = await tx
    .select()
    .from(professionalProfile)
    .where(
      and(eq(professionalProfile.organizationId, orgId), eq(professionalProfile.userId, userId)),
    )
    .limit(1)
  return toProfile(userId, accountName, row)
}

/** Los trazos de una firma, con sus límites. `field`: su nombre en el cuerpo de la petición. */
export function assertStrokes(
  raw: unknown,
  label = "La firma manuscrita",
  field = "signatureData",
): SignatureStrokes {
  const fail = (message: string) => invalidField(field, message)
  if (!Array.isArray(raw) || raw.length === 0) throw fail(`${label} está vacía`)
  if (raw.length > 500) throw fail(`${label} supera el tamaño permitido`)
  let points = 0
  for (const stroke of raw) {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > 5000)
      throw fail(`${label} tiene un trazo inválido`)
    for (const point of stroke) {
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        !point.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1000)
      )
        throw fail(`${label} tiene coordenadas fuera del recuadro`)
    }
    points += stroke.length
  }
  if (points > 20000) throw fail(`${label} supera el tamaño permitido`)
  return raw as SignatureStrokes
}

/** La firma que usa hoy; nula si no guardó ninguna o la quitó. */
export async function currentDrawnSignature(
  tx: Db,
  orgId: string,
  userId: string,
): Promise<SignatureStrokes | null> {
  const [row] = await tx
    .select({ strokes: professionalDrawnSignature.strokes })
    .from(professionalDrawnSignature)
    .where(
      and(
        eq(professionalDrawnSignature.organizationId, orgId),
        eq(professionalDrawnSignature.userId, userId),
      ),
    )
    .orderBy(desc(professionalDrawnSignature.createdAt), desc(professionalDrawnSignature.id))
    .limit(1)
  return (row?.strokes as SignatureStrokes | null | undefined) ?? null
}

/**
 * La firma que regía cuando se emitió un papel: la misma aunque después la
 * cambie. Nula si entonces no tenía ninguna: el papel lleva la línea para firmar a mano.
 */
export async function drawnSignatureAt(
  tx: Db,
  orgId: string,
  userId: string | null | undefined,
  at: Date | string,
): Promise<SignatureStrokes | null> {
  if (!userId) return null
  const [row] = await tx
    .select({ strokes: professionalDrawnSignature.strokes })
    .from(professionalDrawnSignature)
    .where(
      and(
        eq(professionalDrawnSignature.organizationId, orgId),
        eq(professionalDrawnSignature.userId, userId),
        lte(professionalDrawnSignature.createdAt, new Date(at)),
      ),
    )
    .orderBy(desc(professionalDrawnSignature.createdAt), desc(professionalDrawnSignature.id))
    .limit(1)
  return (row?.strokes as SignatureStrokes | null | undefined) ?? null
}

/** Lo que ve la propia persona de su perfil. */
export async function getOwnProfessionalProfile(
  tx: Db,
  orgId: string,
  userId: string,
): Promise<OwnProfessionalProfile> {
  return {
    ...(await getProfessionalProfile(tx, orgId, userId)),
    signatureStrokes: await currentDrawnSignature(tx, orgId, userId),
  }
}

/** Perfiles de quienes pueden atender; en blanco para quien aún no lo completó. */
export async function listProfessionalProfiles(
  tx: Db,
  orgId: string,
): Promise<ProfessionalProfile[]> {
  const members = await tx
    .select({ userId: member.userId, name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), inArray(member.role, [...ATTENDING_ROLES])))
    .orderBy(asc(user.name))
  const rows = await tx
    .select()
    .from(professionalProfile)
    .where(eq(professionalProfile.organizationId, orgId))
  const byUser = new Map(rows.map((row) => [row.userId, row]))
  return members.map((m) => toProfile(m.userId, m.name, byUser.get(m.userId)))
}

export async function setProfessionalProfile(
  tx: Db,
  orgId: string,
  actorUserId: string,
  userId: string,
  input: ProfessionalProfileInput,
): Promise<ProfessionalProfile> {
  // Administración edita los datos de otro, nunca su firma: nadie firma por otra persona.
  if (input.signatureStrokes !== undefined && actorUserId !== userId)
    throw new ServiceError("SIGNATURE_OWN_ONLY", 403, "Cada profesional guarda su propia firma")
  const signatureStrokes =
    input.signatureStrokes === undefined || input.signatureStrokes === null
      ? input.signatureStrokes
      : assertStrokes(input.signatureStrokes, "Tu firma", "signatureStrokes")
  const { name: accountName } = await requireCanAttend(tx, orgId, userId)
  const current = await getProfessionalProfile(tx, orgId, userId)
  const professionalTitle =
    input.professionalTitle === undefined
      ? current.professionalTitle
      : clean(input.professionalTitle, "professionalTitle", "El título profesional", 120)
  if (!professionalTitle) throw invalidField("professionalTitle", "El título profesional es obligatorio")
  const registrationBody =
    input.registrationBody === undefined
      ? current.registrationBody
      : clean(input.registrationBody, "registrationBody", "El colegio profesional", 40)
  if (!registrationBody) throw invalidField("registrationBody", "El colegio profesional es obligatorio")
  const registrationNumber =
    input.registrationNumber === undefined
      ? current.registrationNumber
      : clean(input.registrationNumber, "registrationNumber", "La colegiatura", 20)
  if (registrationNumber && !REGISTRATION_RE.test(registrationNumber))
    throw invalidField("registrationNumber", "La colegiatura admite solo letras, dígitos y guion, sin espacios")
  const signatureName =
    input.signatureName === undefined
      ? current.signatureName
      : clean(input.signatureName, "signatureName", "El nombre de firma", 200)
  const specialtyRegistration =
    input.specialtyRegistration === undefined
      ? current.specialtyRegistration
      : clean(input.specialtyRegistration, "specialtyRegistration", "El registro de especialista", 40)
  const values = {
    signatureName,
    professionalTitle,
    registrationBody,
    registrationNumber,
    specialtyRegistration,
    updatedBy: actorUserId,
    updatedAt: new Date(),
  }
  const [row] = await tx
    .insert(professionalProfile)
    .values({ organizationId: orgId, userId, ...values })
    .onConflictDoUpdate({
      target: [professionalProfile.organizationId, professionalProfile.userId],
      set: values,
    })
    .returning()
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "professional_profile.updated",
    entity: "professional_profile",
    entityId: row?.id ?? userId,
    metadata: { userId, registrationNumber: registrationNumber ?? null },
  })
  if (signatureStrokes !== undefined) {
    await tx.insert(professionalDrawnSignature).values({
      organizationId: orgId,
      userId,
      strokes: signatureStrokes,
    })
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: signatureStrokes ? "professional_signature.saved" : "professional_signature.removed",
      entity: "professional_profile",
      entityId: row?.id ?? userId,
      metadata: { userId },
    })
  }
  return toProfile(userId, accountName, row)
}

/**
 * Firma del profesional para un documento clínico. Sin colegiatura no se
 * firma: el documento no puede quedar a nombre de alguien no identificable.
 */
export async function requireProfessionalSignature(
  tx: Db,
  orgId: string,
  userId: string,
): Promise<ProfessionalSignature> {
  const profile = await getProfessionalProfile(tx, orgId, userId)
  if (!profile.registrationNumber) {
    throw new ServiceError(
      "PROFILE_INCOMPLETE",
      409,
      "Registra tu colegiatura en tu perfil profesional para firmar",
    )
  }
  return {
    name: profile.signatureName ?? profile.accountName,
    title: profile.professionalTitle,
    registration: `${profile.registrationBody} ${profile.registrationNumber}`,
  }
}
