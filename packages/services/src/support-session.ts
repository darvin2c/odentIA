import { createHash, randomBytes } from "node:crypto"
import { type OrgRole, roleLabel } from "@odentia/auth/permissions"
import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { supportAccessAudit, supportAccessGrant, supportAccessSession, supportCase } from "@odentia/db/schema/admin-support"
import { member, organization, user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { and, desc, eq, gt, isNull } from "drizzle-orm"
import type { AdminActor } from "./admin-core.js"
import { writeAdminAudit } from "./admin-core.js"
import { notFound, ServiceError } from "./errors.js"

/**
 * La entrada de soporte a la app de una clínica en solo lectura (permiso de
 * alcance `rol`). La administración pide un pase de un solo uso que dura un
 * minuto; la app de la clínica lo canjea por una sesión que vale lo mismo que
 * el permiso. Ningún token se guarda: solo su hash. Todo corre con el dueño de
 * la base (la tabla de sesiones es de odentIA).
 */

/** Cuánto vale el pase de entrada: lo justo para abrir la otra pestaña. */
export const SUPPORT_PASS_SECONDS = 60

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex")
const newToken = (): string => randomBytes(32).toString("base64url")

type Grant = typeof supportAccessGrant.$inferSelect

/** ¿Quien lo dio sigue pudiendo darlo (propietaria o administradora de la clínica)? */
async function granterStillAllowed(db: Db, grant: Grant): Promise<boolean> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, grant.grantedBy), eq(member.organizationId, grant.organizationId)))
    .limit(1)
  return row?.role === "owner" || row?.role === "admin"
}

/**
 * El permiso, si sigue valiendo ahora. Si quien lo dio ya no puede darlo, se
 * cierra en ese momento y no vale; si venció, no vale.
 */
export async function validSupportGrant(db: Db, grantId: string, now: Date = new Date()): Promise<Grant | null> {
  const [grant] = await db.select().from(supportAccessGrant).where(eq(supportAccessGrant.id, grantId)).limit(1)
  if (!grant || grant.revokedAt !== null || grant.expiresAt.getTime() <= now.getTime()) return null
  if (!(await granterStillAllowed(db, grant))) {
    await db
      .update(supportAccessGrant)
      .set({ revokedAt: now, endReason: "sin_quien_lo_dio" })
      .where(and(eq(supportAccessGrant.id, grant.id), isNull(supportAccessGrant.revokedAt)))
    return null
  }
  return grant
}

/**
 * El permiso vigente de un caso para esta persona de soporte. El de nadie (la
 * clínica lo dio sin pedido) pasa a ser de quien lo usa primero; el de otra
 * persona no sirve.
 */
export async function claimSupportGrant(db: Db, actor: AdminActor, caseId: string, now: Date = new Date()): Promise<Grant | null> {
  const [open] = await db
    .select()
    .from(supportAccessGrant)
    .where(and(eq(supportAccessGrant.caseId, caseId), isNull(supportAccessGrant.revokedAt), gt(supportAccessGrant.expiresAt, now)))
    .orderBy(desc(supportAccessGrant.createdAt))
    .limit(1)
  if (!open) return null
  const grant = await validSupportGrant(db, open.id, now)
  if (!grant) return null
  if (grant.staffUserId === null) {
    const [claimed] = await db
      .update(supportAccessGrant)
      .set({ staffUserId: actor.userId })
      .where(and(eq(supportAccessGrant.id, grant.id), isNull(supportAccessGrant.staffUserId)))
      .returning()
    if (claimed) return claimed
    const [again] = await db.select().from(supportAccessGrant).where(eq(supportAccessGrant.id, grant.id)).limit(1)
    return again?.staffUserId === actor.userId ? again : null
  }
  return grant.staffUserId === actor.userId ? grant : null
}

/**
 * «Abrir la clínica (solo mirar)»: un pase de un solo uso para esta persona de
 * soporte, con un permiso de alcance `rol` vigente y suyo. Devuelve el token
 * (una sola vez) y la clínica, para armar la dirección en su dominio.
 */
export async function createSupportPass(
  db: Db,
  actor: AdminActor,
  caseId: string,
  now: Date = new Date(),
): Promise<{ token: string; slug: string; product: ClinicalProduct; expiresAt: string }> {
  const [kase] = await db.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  if (!kase?.organizationId) throw notFound("Caso")
  const grant = await claimSupportGrant(db, actor, caseId, now)
  if (!grant || grant.scope !== "rol") {
    await db.insert(supportAccessAudit).values({
      grantId: grant?.id ?? null,
      caseId,
      organizationId: kase.organizationId,
      staffUserId: actor.userId,
      action: "denegado_pase",
    })
    throw new ServiceError("FORBIDDEN", 403, "Sin un acceso vigente para mirar la clínica dado a ti: pídelo a la clínica")
  }
  const token = newToken()
  await db.insert(supportAccessSession).values({
    grantId: grant.id,
    staffUserId: actor.userId,
    passHash: hashOf(token),
    passExpiresAt: new Date(now.getTime() + SUPPORT_PASS_SECONDS * 1000),
    createdAt: now,
  })
  await db.insert(supportAccessAudit).values({
    grantId: grant.id,
    caseId,
    organizationId: grant.organizationId,
    staffUserId: actor.userId,
    action: "pase",
  })
  await writeAdminAudit(db, actor, { action: "support.access.pass", organizationId: grant.organizationId, entityId: caseId })
  const [org] = await db
    .select({ slug: organization.slug, product: orgProfile.product })
    .from(organization)
    .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id))
    .where(eq(organization.id, grant.organizationId))
    .limit(1)
  if (!org?.slug) throw notFound("Organización")
  return {
    token,
    slug: org.slug,
    product: isClinicalProduct(org.product) ? org.product : "dental",
    expiresAt: grant.expiresAt.toISOString(),
  }
}

/**
 * Canjea el pase por la sesión de solo mirar. Un pase sirve una vez, dentro de
 * su minuto y con el permiso todavía vigente. Devuelve el token de la sesión
 * (una sola vez) y hasta cuándo vale.
 */
export async function redeemSupportPass(
  db: Db,
  pass: string,
  now: Date = new Date(),
): Promise<{ sessionToken: string; expiresAt: Date; organizationId: string }> {
  const denied = () => new ServiceError("FORBIDDEN", 403, "El pase no sirve: pide otro desde la administración")
  if (typeof pass !== "string" || pass.length < 20 || pass.length > 200) throw denied()
  const sessionToken = newToken()
  // Marcar el canje y comprobarlo es una sola escritura: dos canjes a la vez, uno gana.
  const [row] = await db
    .update(supportAccessSession)
    .set({ redeemedAt: now, sessionHash: hashOf(sessionToken) })
    .where(
      and(
        eq(supportAccessSession.passHash, hashOf(pass)),
        isNull(supportAccessSession.redeemedAt),
        gt(supportAccessSession.passExpiresAt, now),
      ),
    )
    .returning()
  if (!row) throw denied()
  const grant = await validSupportGrant(db, row.grantId, now)
  if (!grant || grant.scope !== "rol" || grant.staffUserId !== row.staffUserId) {
    await db.update(supportAccessSession).set({ endedAt: now }).where(eq(supportAccessSession.id, row.id))
    throw denied()
  }
  await db.insert(supportAccessAudit).values({
    grantId: grant.id,
    caseId: grant.caseId,
    organizationId: grant.organizationId,
    staffUserId: row.staffUserId,
    action: "entrada",
  })
  return { sessionToken, expiresAt: grant.expiresAt, organizationId: grant.organizationId }
}

/** Una sesión de soporte vigente, lo que la API necesita para atenderla. */
export interface SupportSessionContext {
  sessionId: string
  grantId: string
  caseId: string
  organizationId: string
  staffUserId: string
  staffName: string
  viewRole: OrgRole
  expiresAt: Date
}

/** La sesión del token, si sigue valiendo: sin terminar y con su permiso vigente. */
export async function resolveSupportSession(db: Db, sessionToken: string, now: Date = new Date()): Promise<SupportSessionContext | null> {
  if (typeof sessionToken !== "string" || sessionToken.length < 20 || sessionToken.length > 200) return null
  const [row] = await db
    .select({ session: supportAccessSession, staffName: user.name })
    .from(supportAccessSession)
    .innerJoin(user, eq(user.id, supportAccessSession.staffUserId))
    .where(and(eq(supportAccessSession.sessionHash, hashOf(sessionToken)), isNull(supportAccessSession.endedAt)))
    .limit(1)
  if (!row) return null
  const grant = await validSupportGrant(db, row.session.grantId, now)
  if (!grant || grant.scope !== "rol" || !grant.viewRole || grant.staffUserId !== row.session.staffUserId) return null
  return {
    sessionId: row.session.id,
    grantId: grant.id,
    caseId: grant.caseId,
    organizationId: grant.organizationId,
    staffUserId: row.session.staffUserId,
    staffName: row.staffName,
    viewRole: grant.viewRole as OrgRole,
    expiresAt: grant.expiresAt,
  }
}

/** «Salir»: la sesión termina aunque el permiso siga vigente. */
export async function endSupportSession(db: Db, sessionToken: string, now: Date = new Date()): Promise<void> {
  if (typeof sessionToken !== "string" || sessionToken.length < 20 || sessionToken.length > 200) return
  await db
    .update(supportAccessSession)
    .set({ endedAt: now })
    .where(and(eq(supportAccessSession.sessionHash, hashOf(sessionToken)), isNull(supportAccessSession.endedAt)))
}

/** Por qué terminó el acceso de una sesión, para «El acceso terminó». */
export async function supportSessionEnding(
  db: Db,
  sessionToken: string,
): Promise<{ at: string; reason: string; byName: string | null } | null> {
  if (typeof sessionToken !== "string" || sessionToken.length < 20 || sessionToken.length > 200) return null
  const [row] = await db
    .select({ grant: supportAccessGrant, endedAt: supportAccessSession.endedAt })
    .from(supportAccessSession)
    .innerJoin(supportAccessGrant, eq(supportAccessGrant.id, supportAccessSession.grantId))
    .where(eq(supportAccessSession.sessionHash, hashOf(sessionToken)))
    .limit(1)
  if (!row) return null
  const { grant } = row
  const [by] = grant.revokedBy ? await db.select({ name: user.name }).from(user).where(eq(user.id, grant.revokedBy)).limit(1) : []
  if (grant.revokedAt) return { at: grant.revokedAt.toISOString(), reason: grant.endReason ?? "quitado", byName: by?.name ?? null }
  if (row.endedAt) return { at: row.endedAt.toISOString(), reason: "salio", byName: null }
  return { at: grant.expiresAt.toISOString(), reason: "vencido", byName: null }
}

/** «Odontólogo», «Médico»…: el rol con que mira soporte, en las palabras del producto. */
export function supportViewRoleLabel(role: OrgRole, product: ClinicalProduct): string {
  return roleLabel(role, product)
}
