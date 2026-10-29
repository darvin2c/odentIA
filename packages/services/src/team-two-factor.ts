/**
 * Verificación en dos pasos del equipo de la clínica (ADR 0106).
 *
 * La verificación es de la persona (Better Auth: `user.two_factor_enabled` y
 * su fila en `two_factor`); la clínica solo decide si la pide a todo su equipo
 * (`org_profile.require_two_factor`) y puede restablecer la de alguien que
 * perdió el teléfono y sus códigos. Lee y escribe tablas de identidad, así que
 * recibe la conexión owner; quien llama ya comprobó el permiso en la clínica.
 */
import { type Db, withOrgContext } from "@odentia/db"
import { adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { account, member, organization, session, user, verification } from "@odentia/db/schema/auth"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, eq, like } from "drizzle-orm"
import { ServiceError } from "./errors.js"

export interface TeamTwoFactorMember {
  userId: string
  name: string
  email: string
  role: string
  enabled: boolean
}

export interface TeamTwoFactor {
  required: boolean
  members: TeamTwoFactorMember[]
}

/** Si la clínica la pide: lo consulta la API en cada pedido de la clínica. */
export async function orgRequiresTwoFactor(db: Db, orgId: string): Promise<boolean> {
  const [row] = await withOrgContext(db, orgId, (tx) =>
    tx.select({ required: orgProfile.requireTwoFactor }).from(orgProfile).where(eq(orgProfile.organizationId, orgId)).limit(1),
  )
  return row?.required ?? false
}

/** Si la pide la clínica y quién del equipo la tiene activa. */
export async function getTeamTwoFactor(ownerDb: Db, orgId: string): Promise<TeamTwoFactor> {
  const [profile] = await ownerDb
    .select({ required: orgProfile.requireTwoFactor })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  const members = await ownerDb
    .select({ userId: user.id, name: user.name, email: user.email, role: member.role, enabled: user.twoFactorEnabled })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, orgId))
    .orderBy(asc(user.name))
  return { required: profile?.required ?? false, members }
}

/**
 * Enciende o apaga la exigencia. Encenderla exige que quien lo hace ya la
 * tenga: no se pide al equipo lo que uno mismo no hizo. Devuelve a quién le
 * falta activarla, para avisarles.
 */
export async function setTeamTwoFactorRequired(
  ownerDb: Db,
  input: { orgId: string; actorUserId: string; required: boolean },
): Promise<{ required: boolean; missing: TeamTwoFactorMember[] }> {
  return ownerDb.transaction(async (tx) => {
    const team = await getTeamTwoFactor(tx as Db, input.orgId)
    const actor = team.members.find((item) => item.userId === input.actorUserId)
    if (input.required && !actor?.enabled) {
      throw new ServiceError("TWO_FACTOR_SELF_REQUIRED", 409, "Activa primero tu verificación en dos pasos en Mi perfil")
    }
    if (team.required !== input.required) {
      const updated = await tx
        .update(orgProfile)
        .set({ requireTwoFactor: input.required, updatedAt: new Date() })
        .where(eq(orgProfile.organizationId, input.orgId))
        .returning({ id: orgProfile.organizationId })
      if (updated.length === 0) throw new ServiceError("NOT_FOUND", 404, "La clínica aún no tiene sus datos")
      await tx.insert(auditEvent).values({
        organizationId: input.orgId,
        actorUserId: input.actorUserId,
        action: input.required ? "settings.two_factor_required" : "settings.two_factor_not_required",
        entity: "organization",
        entityId: input.orgId,
        metadata: { missing: team.members.filter((item) => !item.enabled).length },
      })
    }
    return { required: input.required, missing: input.required ? team.members.filter((item) => !item.enabled) : [] }
  })
}

/**
 * Restablece la verificación de alguien del equipo que perdió el teléfono y
 * sus códigos: borra su factor, sus navegadores recordados y sus sesiones.
 * Un administrador no restablece a un propietario, nadie se restablece a sí
 * mismo (eso es Mi perfil) y el personal de odentIA queda fuera: su factor es
 * también el de la administración.
 */
export async function resetMemberTwoFactor(
  ownerDb: Db,
  input: { orgId: string; actorUserId: string; actorRole: string; targetUserId: string; reason: string },
): Promise<void> {
  const reason = input.reason.trim()
  if (reason.length < 3) throw new ServiceError("VALIDATION", 400, "Escribe el motivo")
  if (input.targetUserId === input.actorUserId) {
    throw new ServiceError("FORBIDDEN", 403, "Tu propia verificación se cambia en Mi perfil")
  }
  await ownerDb.transaction(async (tx) => {
    const [target] = await tx
      .select({ role: member.role, enabled: user.twoFactorEnabled })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, input.orgId), eq(member.userId, input.targetUserId)))
      .limit(1)
    if (!target) throw new ServiceError("NOT_FOUND", 404, "Esa persona no es del equipo")
    if (target.role === "owner" && input.actorRole !== "owner") {
      throw new ServiceError("FORBIDDEN", 403, "Solo un propietario restablece a otro propietario")
    }
    const [staff] = await tx.select({ userId: adminStaff.userId }).from(adminStaff).where(eq(adminStaff.userId, input.targetUserId)).limit(1)
    if (staff) throw new ServiceError("STAFF_FACTOR", 409, "Es del personal de odentIA: su verificación la restablece la administración")
    if (!target.enabled) throw new ServiceError("TWO_FACTOR_NOT_ENABLED", 409, "Esa persona no tiene la verificación activa")

    await tx.delete(twoFactor).where(eq(twoFactor.userId, input.targetUserId))
    await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, input.targetUserId))
    // Los navegadores recordados de Better Auth: `trust-device-*` con el id de la persona.
    await tx.delete(verification).where(and(like(verification.identifier, "trust-device-%"), eq(verification.value, input.targetUserId)))
    await tx.delete(session).where(eq(session.userId, input.targetUserId))
    await tx.insert(auditEvent).values({
      organizationId: input.orgId,
      actorUserId: input.actorUserId,
      action: "settings.two_factor_reset",
      entity: "user",
      entityId: input.targetUserId,
      metadata: { reason },
    })
  })
}

/**
 * Las clínicas de la persona que piden la verificación: mientras haya alguna,
 * no puede desactivarla (Better Auth lo rechaza en `/two-factor/disable`).
 */
export async function clinicsRequiringTwoFactor(ownerDb: Db, userId: string): Promise<string[]> {
  const rows = await ownerDb
    .select({ name: organization.name })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .innerJoin(orgProfile, eq(orgProfile.organizationId, member.organizationId))
    .where(and(eq(member.userId, userId), eq(orgProfile.requireTwoFactor, true)))
    .orderBy(asc(organization.name))
  return rows.map((row) => row.name)
}

export interface MyTwoFactor {
  enabled: boolean
  /** Personal de odentIA: su factor es el de la administración y se maneja allí. */
  staff: boolean
  /** Sus clínicas que la piden: mientras haya alguna, no puede desactivarla. */
  requiredBy: string[]
  /** Navegadores que no piden el código (los recuerda Better Auth 30 días). */
  trustedBrowsers: number
  /** Sin contraseña (entra con Google), Better Auth no la pide para activarla. */
  hasPassword: boolean
}

/** Lo que Mi perfil dice de la verificación de la persona. */
export async function getMyTwoFactor(ownerDb: Db, userId: string, now = new Date()): Promise<MyTwoFactor> {
  const [row] = await ownerDb.select({ enabled: user.twoFactorEnabled }).from(user).where(eq(user.id, userId)).limit(1)
  const [staff] = await ownerDb.select({ userId: adminStaff.userId }).from(adminStaff).where(eq(adminStaff.userId, userId)).limit(1)
  const browsers = await ownerDb
    .select({ expiresAt: verification.expiresAt })
    .from(verification)
    .where(and(like(verification.identifier, "trust-device-%"), eq(verification.value, userId)))
  const [credential] = await ownerDb
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
    .limit(1)
  return {
    enabled: row?.enabled ?? false,
    staff: Boolean(staff),
    hasPassword: Boolean(credential),
    requiredBy: await clinicsRequiringTwoFactor(ownerDb, userId),
    trustedBrowsers: browsers.filter((item) => item.expiresAt > now).length,
  }
}

/** «Que los navegadores recordados vuelvan a pedir el código»: olvida todos los de la persona. */
export async function forgetTrustedBrowsers(ownerDb: Db, userId: string): Promise<number> {
  const removed = await ownerDb
    .delete(verification)
    .where(and(like(verification.identifier, "trust-device-%"), eq(verification.value, userId)))
    .returning({ id: verification.id })
  return removed.length
}
