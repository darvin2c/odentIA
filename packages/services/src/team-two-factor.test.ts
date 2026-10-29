import { randomUUID } from "node:crypto"
import { adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { member, session, user, verification } from "@odentia/db/schema/auth"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import {
  clinicsRequiringTwoFactor,
  clinicTwoFactorGate,
  getTeamTwoFactor,
  resetMemberTwoFactor,
  setTeamTwoFactorRequired,
} from "./team-two-factor.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/** Verificación en dos pasos del equipo (ADR 0107). */
setupTestDb()

async function person(orgId: string, role: string, enabled: boolean, name = role): Promise<string> {
  const id = `u_${randomUUID().slice(0, 8)}`
  await ownerDb.insert(user).values({ id, name, email: `${id}@clinica.test`, emailVerified: true, twoFactorEnabled: enabled, createdAt: new Date() })
  await ownerDb.insert(member).values({ id: randomUUID(), organizationId: orgId, userId: id, role, createdAt: new Date() })
  if (enabled) await ownerDb.insert(twoFactor).values({ id: randomUUID(), userId: id, secret: "s", backupCodes: "[]", verified: true })
  return id
}

describe("verificación en dos pasos del equipo", () => {
  it("encenderla exige tenerla uno mismo, dice a quién le falta, pide el código a cada sesión y queda en la actividad", async () => {
    const owner = await person("org_a", "owner", false, "Ana")
    const reception = await person("org_a", "reception", false, "María")
    const gate = (userId: string, sessionId: string, orgId = "org_a") => clinicTwoFactorGate(ownerDb, { orgId, userId, sessionId })
    await expect(setTeamTwoFactorRequired(ownerDb, { orgId: "org_a", actorUserId: owner, required: true })).rejects.toMatchObject({
      code: "TWO_FACTOR_SELF_REQUIRED",
    })
    expect(await gate(reception, "s-recepcion")).toBeNull()

    await ownerDb.insert(twoFactor).values({ id: randomUUID(), userId: owner, secret: "s", backupCodes: "[]", verified: true })
    const result = await setTeamTwoFactorRequired(ownerDb, { orgId: "org_a", actorUserId: owner, required: true })
    expect(result.missing.map((item) => item.userId)).toEqual([reception])
    // Sin la verificación: activarla. Con ella pero sin el código en esta sesión
    // (Google, o abierta antes): el código. La sesión que lo pasó, sigue.
    expect(await gate(reception, "s-recepcion")).toBe("activar")
    expect(await gate(owner, "s-google")).toBe("codigo")
    await ownerDb.insert(verification).values({ id: randomUUID(), identifier: "2fa-session-s-codigo", value: owner, expiresAt: new Date(Date.now() + 3600_000) })
    expect(await gate(owner, "s-codigo")).toBeNull()
    // La otra clínica no cambia.
    expect(await gate(reception, "s-recepcion", "org_b")).toBeNull()

    const team = await getTeamTwoFactor(ownerDb, "org_a")
    expect(team.required).toBe(true)
    expect(team.members.find((item) => item.userId === reception)).toMatchObject({ enabled: false, role: "reception" })
    const events = await ownerDb.select({ action: auditEvent.action }).from(auditEvent).where(eq(auditEvent.organizationId, "org_a"))
    expect(events.map((event) => event.action)).toContain("settings.two_factor_required")
    expect(await clinicsRequiringTwoFactor(ownerDb, reception)).toEqual(["Clínica norte"])

    await setTeamTwoFactorRequired(ownerDb, { orgId: "org_a", actorUserId: owner, required: false })
    expect(await gate(reception, "s-recepcion")).toBeNull()
    expect(await clinicsRequiringTwoFactor(ownerDb, reception)).toEqual([])
  })

  it("restablecer borra el factor, los navegadores recordados y las sesiones, con su motivo", async () => {
    const owner = await person("org_b", "owner", true)
    const admin = await person("org_b", "admin", true)
    const clinician = await person("org_b", "clinician", true)
    await ownerDb.insert(session).values({ id: randomUUID(), token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000), userId: clinician })
    await ownerDb.insert(verification).values([
      { id: randomUUID(), identifier: `trust-device-${randomUUID()}`, value: clinician, expiresAt: new Date(Date.now() + 3600_000) },
      // Lo de otra persona no se toca.
      { id: randomUUID(), identifier: `trust-device-${randomUUID()}`, value: owner, expiresAt: new Date(Date.now() + 3600_000) },
    ])

    await expect(
      resetMemberTwoFactor(ownerDb, { orgId: "org_b", actorUserId: owner, actorRole: "owner", targetUserId: clinician, reason: "" }),
    ).rejects.toMatchObject({ code: "VALIDATION" })
    await resetMemberTwoFactor(ownerDb, { orgId: "org_b", actorUserId: owner, actorRole: "owner", targetUserId: clinician, reason: "Le robaron el teléfono" })

    const [after] = await ownerDb.select({ enabled: user.twoFactorEnabled }).from(user).where(eq(user.id, clinician))
    expect(after?.enabled).toBe(false)
    expect(await ownerDb.select().from(twoFactor).where(eq(twoFactor.userId, clinician))).toEqual([])
    expect(await ownerDb.select().from(session).where(eq(session.userId, clinician))).toEqual([])
    expect(await ownerDb.select().from(verification).where(eq(verification.value, clinician))).toEqual([])
    expect(await ownerDb.select().from(verification).where(eq(verification.value, owner))).toHaveLength(1)
    const [event] = await ownerDb
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, "settings.two_factor_reset"), eq(auditEvent.entityId, clinician)))
    expect(event?.metadata).toEqual({ reason: "Le robaron el teléfono" })

    // Ya no la tiene: no hay nada que restablecer.
    await expect(
      resetMemberTwoFactor(ownerDb, { orgId: "org_b", actorUserId: owner, actorRole: "owner", targetUserId: clinician, reason: "otra vez" }),
    ).rejects.toMatchObject({ code: "TWO_FACTOR_NOT_ENABLED" })
    // Un administrador no restablece a un propietario; nadie se restablece a sí mismo.
    await expect(
      resetMemberTwoFactor(ownerDb, { orgId: "org_b", actorUserId: admin, actorRole: "admin", targetUserId: owner, reason: "perdió el teléfono" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      resetMemberTwoFactor(ownerDb, { orgId: "org_b", actorUserId: owner, actorRole: "owner", targetUserId: owner, reason: "perdí el teléfono" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    // Alguien de otra clínica no es del equipo.
    const stranger = await person("org_a", "reception", true)
    await expect(
      resetMemberTwoFactor(ownerDb, { orgId: "org_b", actorUserId: owner, actorRole: "owner", targetUserId: stranger, reason: "perdió el teléfono" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("a quien también es parte de otra clínica no lo restablece esta: su verificación vale allí", async () => {
    const owner = await person("org_a", "owner", true)
    const shared = await person("org_a", "reception", true)
    await ownerDb.insert(member).values({ id: randomUUID(), organizationId: "org_b", userId: shared, role: "owner", createdAt: new Date() })
    await expect(
      resetMemberTwoFactor(ownerDb, { orgId: "org_a", actorUserId: owner, actorRole: "owner", targetUserId: shared, reason: "perdió el teléfono" }),
    ).rejects.toMatchObject({ code: "TWO_FACTOR_OTHER_CLINIC" })
    expect(await ownerDb.select().from(twoFactor).where(eq(twoFactor.userId, shared))).toHaveLength(1)
  })

  it("el personal de la administración lo restablece la administración, no la clínica", async () => {
    const owner = await person("org_b", "owner", true)
    const staffer = await person("org_b", "admin", true)
    await ownerDb.insert(adminStaff).values({ userId: staffer, role: "admin" })
    await expect(
      resetMemberTwoFactor(ownerDb, { orgId: "org_b", actorUserId: owner, actorRole: "owner", targetUserId: staffer, reason: "perdió el teléfono" }),
    ).rejects.toMatchObject({ code: "STAFF_FACTOR" })
    const [kept] = await ownerDb.select({ required: orgProfile.requireTwoFactor }).from(orgProfile).where(eq(orgProfile.organizationId, "org_b"))
    expect(kept?.required).toBe(false)
  })
})
