import { invitation, member, organization, session, user } from "@odentia/db/schema/auth"
import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { beforeEach, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import {
  approveRecoveryCase,
  cancelOrganizationInvitation,
  cleanupUnverifiedAccount,
  closeAccountByAdmin,
  closeMyAccount,
  createAssistedOrganization,
  executeRecoveryCase,
  findActiveUserBlock,
  findLifecycleCandidates,
  getOrganizationDetail,
  getUserDetail,
  leaveOrganization,
  listMyInvitations,
  openRecoveryCase,
  resendOrganizationInvitation,
  searchUsers,
  setGlobalBlock,
} from "./admin-organizations.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const admin: AdminActor = { userId: "t-admin", role: "admin" }
const support: AdminActor = { userId: "t-support", role: "support" }

async function seedUser(id: string, email: string, verified: boolean, createdAt: Date): Promise<void> {
  await ownerDb
    .insert(user)
    .values({ id, name: `Nombre ${id}`, firstName: "Nombre", lastName: id, email, emailVerified: verified, createdAt })
    .onConflictDoNothing()
}

async function seedSession(userId: string): Promise<void> {
  await ownerDb.insert(session).values({
    id: randomUUID(),
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 3600_000),
    userId,
  })
}

async function seedMember(orgId: string, userId: string, role: string): Promise<void> {
  await ownerDb.insert(member).values({
    id: randomUUID(),
    organizationId: orgId,
    userId,
    role,
    createdAt: new Date(),
  })
}

beforeEach(async () => {
  await seedUser("t-admin", "t-admin@example.test", true, new Date())
  await seedUser("t-support", "t-support@example.test", true, new Date())
})

it("alta asistida siempre invita aunque la cuenta exista: entrar exige aceptación", async () => {
  await seedUser("t-existe", "t-existe@example.test", true, new Date())
  const created = await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, support, {
      orgName: "Clínica Alta Uno",
      slug: "t-alta-existe-uno",
      email: "t-existe@example.test",
      countryCode: "PE",
    }),
  )
  expect(created.status).toBe("invitada")
  expect(created.userId).toBe("t-existe")
  // Sin membresía automática: autoridad y consentimiento nacen al aceptar.
  const detail = await getOrganizationDetail(ownerDb, admin, created.organizationId)
  expect(detail.members).toHaveLength(0)
  const pending = await listMyInvitations(ownerDb, "t-existe@example.test")
  expect(pending.map((p) => p.id)).toEqual([created.invitationId])
})

it("alta asistida con cuenta nueva invita una sola vez y el reenvío no duplica", async () => {
  const created = await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, support, {
      orgName: "Clínica Alta Dos",
      slug: "t-alta-nueva-dos",
      email: "t-nueva@example.test",
      countryCode: "PE",
    }),
  )
  expect(created.status).toBe("invitada")
  expect(created.userId).toBeNull()
  const resent = await ownerDb.transaction((tx) => resendOrganizationInvitation(tx, support, created.invitationId))
  expect(resent.id).toBe(created.invitationId)
  const pending = await listMyInvitations(ownerDb, "t-nueva@example.test")
  expect(pending.map((p) => p.id)).toEqual([created.invitationId])
  await ownerDb.transaction((tx) => cancelOrganizationInvitation(tx, admin, created.invitationId))
  expect(await listMyInvitations(ownerDb, "t-nueva@example.test")).toHaveLength(0)
})

it("slug reservado y duplicado se rechazan sin crear nada (fixtures propias)", async () => {
  await expect(
    ownerDb.transaction((tx) =>
      createAssistedOrganization(tx, support, { orgName: "Nombre Equis", slug: "admin", email: "t-r1@example.test", countryCode: "PE" }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, support, { orgName: "Base", slug: "t-slug-dup", email: "t-r2@example.test", countryCode: "PE" }),
  )
  await expect(
    ownerDb.transaction((tx) =>
      createAssistedOrganization(tx, support, { orgName: "Otra Clínica", slug: "t-slug-dup", email: "t-r3@example.test", countryCode: "PE" }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" })
})

it("soporte no bloquea ni decide recuperaciones; admin sí", async () => {
  await seedUser("t-miembro", "t-miembro@example.test", true, new Date())
  await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, admin, {
      orgName: "Clínica Roles",
      slug: "t-roles",
      email: "t-miembro@example.test",
      countryCode: "PE",
    }),
  )
  await expect(
    ownerDb.transaction((tx) => setGlobalBlock(tx, support, { userId: "t-miembro", reason: "motivo de prueba largo" })),
  ).rejects.toMatchObject({ code: "FORBIDDEN" })
  const opened = await ownerDb.transaction((tx) =>
    openRecoveryCase(tx, support, {
      email: "t-miembro@example.test",
      kind: "acceso",
      evidence: {
        description: "Evidencia de ejemplo con más de diez caracteres",
        verifiedBy: "alguien",
        verifiedAt: "2026-10-14",
        method: "Método de verificación de ejemplo",
      },
    }),
  )
  // La autoría la firma el servidor con el actor, no el texto enviado.
  expect(opened.evidence.verifiedBy).toBe("t-support")
  await expect(
    ownerDb.transaction((tx) => approveRecoveryCase(tx, support, { id: opened.id, decision: "aprobar" })),
  ).rejects.toMatchObject({ code: "FORBIDDEN" })
})

it("la última propietaria no sale; con otra propietaria sí", async () => {
  await seedUser("t-duena", "t-duena@example.test", true, new Date())
  const created = await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, admin, {
      orgName: "Clínica Dueña",
      slug: "t-duena",
      email: "t-duena@example.test",
      countryCode: "PE",
    }),
  )
  await seedMember(created.organizationId, "t-duena", "owner")
  await expect(leaveOrganization(ownerDb, "t-duena", created.organizationId)).rejects.toMatchObject({
    code: "CONFLICT",
  })
  await seedUser("t-duena2", "t-duena2@example.test", true, new Date())
  await seedMember(created.organizationId, "t-duena2", "owner")
  await leaveOrganization(ownerDb, "t-duena", created.organizationId)
  const remaining = await ownerDb
    .select()
    .from(member)
    .where(eq(member.organizationId, created.organizationId))
  expect(remaining.map((m) => m.userId)).toEqual(["t-duena2"])
})

it("bloqueo global corta sesiones sin borrar autoría ni membresías", async () => {
  await seedUser("t-bloq", "t-bloq@example.test", true, new Date())
  await seedSession("t-bloq")
  const created = await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, admin, {
      orgName: "Clínica Bloqueo",
      slug: "t-bloqueo",
      email: "t-bloq@example.test",
      countryCode: "PE",
    }),
  )
  await seedMember(created.organizationId, "t-bloq", "owner")
  await ownerDb.transaction((tx) =>
    setGlobalBlock(tx, admin, { userId: "t-bloq", reason: "acceso comprometido, se investiga" }),
  )
  const detail = await getUserDetail(ownerDb, admin, "t-bloq")
  expect(detail.blocked).toBe(true)
  expect(detail.sessions).toHaveLength(0)
  expect(detail.memberships.map((m) => m.organizationId)).toContain(created.organizationId)
  const users = await searchUsers(ownerDb, support, { q: "t-bloq@example.test" })
  expect(users.items[0]?.blocked).toBe(true)
})

it("cierre de cuenta conserva la fila de usuario", async () => {
  await seedUser("t-cierre", "t-cierre@example.test", true, new Date())
  await seedSession("t-cierre")
  const created = await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, admin, {
      orgName: "Clínica Cierre",
      slug: "t-cierre",
      email: "t-cierre@example.test",
      countryCode: "PE",
    }),
  )
  await seedUser("t-cierre2", "t-cierre2@example.test", true, new Date())
  await seedMember(created.organizationId, "t-cierre2", "owner")
  await ownerDb.transaction((tx) =>
    closeAccountByAdmin(tx, admin, { userId: "t-cierre", reason: "solicitud verificada del titular" }),
  )
  const detail = await getUserDetail(ownerDb, admin, "t-cierre")
  expect(detail.memberships).toHaveLength(0)
  expect(detail.blocked).toBe(true)
  const [row] = await ownerDb.select().from(organization).where(eq(organization.id, created.organizationId))
  expect(row?.id).toBe(created.organizationId)
})

it("cierre voluntario persiste bloqueo y no permite relogin", async () => {
  await seedUser("t-adios", "t-adios@example.test", true, new Date())
  await seedSession("t-adios")
  await ownerDb.transaction((tx) => closeMyAccount(tx, "t-adios"))
  const blocked = await findActiveUserBlock(ownerDb, "t-adios")
  expect(blocked?.reason).toBe("Cuenta cerrada por su titular")
  const detail = await getUserDetail(ownerDb, admin, "t-adios")
  expect(detail.blocked).toBe(true)
  expect(detail.sessions).toHaveLength(0)
})

it("recuperación exige doble control de dos admins y nunca autoasigna por correo", async () => {
  await seedUser("t-admin2", "t-admin2@example.test", true, new Date())
  const admin2: AdminActor = { userId: "t-admin2", role: "admin" }
  await seedUser("t-rec", "t-rec@example.test", true, new Date())
  const evidence = {
    description: "Presentó documento y poder vigente del representante legal",
    verifiedBy: "t-support",
    verifiedAt: new Date().toISOString(),
    method: "Llamada al número registrado + documento validado en mesa",
  }
  const opened = await ownerDb.transaction((tx) =>
    openRecoveryCase(tx, support, { email: "t-rec@example.test", kind: "acceso", evidence }),
  )
  expect(opened.status).toBe("pendiente")
  await expect(
    ownerDb.transaction((tx) => executeRecoveryCase(tx, admin, opened.id)),
  ).rejects.toMatchObject({ code: "CONFLICT" })
  const afterFirst = await ownerDb.transaction((tx) =>
    approveRecoveryCase(tx, admin, { id: opened.id, decision: "aprobar" }),
  )
  expect(afterFirst.status).toBe("pendiente")
  const afterSecond = await ownerDb.transaction((tx) =>
    approveRecoveryCase(tx, admin2, { id: opened.id, decision: "aprobar" }),
  )
  expect(afterSecond.status).toBe("aprobada")
  await seedSession("t-rec")
  const effect = await ownerDb.transaction((tx) => executeRecoveryCase(tx, admin, opened.id))
  expect(effect.kind).toBe("acceso")
  const detail = await getUserDetail(ownerDb, admin, "t-rec")
  expect(detail.sessions).toHaveLength(0)
})

it("ciclo de vida: solo limpia no verificadas sin relaciones", async () => {
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  await seedUser("t-dormida", "t-dormida@example.test", false, old)
  await seedUser("t-activa", "t-activa@example.test", false, old)
  await seedSession("t-activa")
  await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, admin, {
      orgName: "Clínica Ciclo",
      slug: "t-ciclo",
      email: "t-activa@example.test",
      countryCode: "PE",
    }),
  )
  const found = await findLifecycleCandidates(ownerDb, {})
  expect(found.cleanups.map((c) => c.userId)).toContain("t-dormida")
  expect(found.cleanups.map((c) => c.userId)).not.toContain("t-activa")
  const deleted = await ownerDb.transaction((tx) => cleanupUnverifiedAccount(tx, null, "t-dormida", {}))
  expect(deleted).toEqual({ deleted: true })
  const kept = await ownerDb.transaction((tx) => cleanupUnverifiedAccount(tx, null, "t-activa", {}))
  expect(kept).toEqual({ deleted: false })
  await expect(getUserDetail(ownerDb, admin, "t-dormida")).rejects.toMatchObject({ code: "NOT_FOUND" })
})

it("ciclo de vida: quien invitó a otra cuenta no se borra ni pierde su invitación", async () => {
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  await seedUser("t-invitador", "t-invitador@example.test", false, old)
  await ownerDb.insert(invitation).values({
    id: randomUUID(),
    organizationId: "org_a",
    email: "t-invitada@example.test",
    role: "member",
    status: "pending",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    inviterId: "t-invitador",
  })
  const found = await findLifecycleCandidates(ownerDb, {})
  expect(found.cleanups.map((c) => c.userId)).not.toContain("t-invitador")
  expect(found.reminders.map((c) => c.userId)).not.toContain("t-invitador")
  const kept = await ownerDb.transaction((tx) => cleanupUnverifiedAccount(tx, null, "t-invitador", {}))
  expect(kept).toEqual({ deleted: false })
  const rows = await ownerDb
    .select()
    .from(invitation)
    .where(eq(invitation.email, "t-invitada@example.test"))
  expect(rows).toHaveLength(1)
  expect(rows[0]?.inviterId).toBe("t-invitador")
})
