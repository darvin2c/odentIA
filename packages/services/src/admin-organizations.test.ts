import { adminStaff } from "@odentia/db/schema/admin-core"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { invitation, member, organization, session, user } from "@odentia/db/schema/auth"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import {
  accountProduct,
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
  getOrganizationPendingCounts,
  getUserDetail,
  leaveOrganization,
  listMyInvitations,
  listOrganizationProducts,
  listOrganizations,
  openRecoveryCase,
  ownersPendingRows,
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

it("alta asistida de latidIA: la clínica nace médica y la invitación nombra el rol como en su producto", async () => {
  const created = await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, admin, {
      orgName: "Consultorio San Martín",
      slug: "t-alta-latidia",
      email: "t-latidia@example.test",
      countryCode: "PE",
      product: "medical",
    }),
  )
  const [pending] = await listMyInvitations(ownerDb, "t-latidia@example.test")
  expect(pending).toMatchObject({ id: created.invitationId, product: "medical" })
  // Sin decirlo, odentIA, como siempre.
  const dental = await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, admin, { orgName: "Clínica Sonríe", slug: "t-alta-odentia", email: "t-odentia@example.test", countryCode: "PE" }),
  )
  const [own] = await listMyInvitations(ownerDb, "t-odentia@example.test")
  expect(own).toMatchObject({ id: dental.invitationId, product: "dental", roleLabel: "Propietario" })
})

it("el producto de una cuenta: latidIA solo si todas sus clínicas lo son (entrega 4b del issue 229)", async () => {
  await seedUser("t-cuenta", "t-cuenta@example.test", true, new Date())
  expect(await accountProduct(ownerDb, "t-cuenta")).toBe("dental")
  const medical = await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, admin, { orgName: "Consultorio Cuenta", slug: "t-cuenta-latidia", email: "t-cuenta-x@example.test", countryCode: "PE", product: "medical" }),
  )
  await seedMember(medical.organizationId, "t-cuenta", "owner")
  expect(await accountProduct(ownerDb, "t-cuenta")).toBe("medical")
  const dental = await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, admin, { orgName: "Clínica Cuenta", slug: "t-cuenta-odentia", email: "t-cuenta-y@example.test", countryCode: "PE" }),
  )
  await seedMember(dental.organizationId, "t-cuenta", "clinician")
  expect(await accountProduct(ownerDb, "t-cuenta")).toBe("dental")
})

it("la administración distingue el producto de cada clínica: lo marca, lo cuenta y filtra por él (ADR 0091)", async () => {
  const medical = await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, admin, { orgName: "Filtro Consultorio", slug: "t-filtro-latidia", email: "t-f1@example.test", countryCode: "PE", product: "medical" }),
  )
  const dental = await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, admin, { orgName: "Filtro Clínica", slug: "t-filtro-odentia", email: "t-f2@example.test", countryCode: "PE" }),
  )
  // Sin perfil todavía: nace dental, como `org_profile.product` por defecto.
  await ownerDb.insert(organization).values({ id: "t-filtro-sin-perfil", name: "Filtro Sin Perfil", slug: "t-filtro-sin-perfil", createdAt: new Date() })

  const all = await listOrganizations(ownerDb, support, { q: "filtro" })
  expect(all.byProduct).toEqual({ dental: 2, medical: 1, optical: 0 })
  expect(Object.fromEntries(all.items.map((item) => [item.slug, item.product]))).toEqual({
    "t-filtro-latidia": "medical",
    "t-filtro-odentia": "dental",
    "t-filtro-sin-perfil": "dental",
  })

  const onlyMedical = await listOrganizations(ownerDb, support, { q: "filtro", product: "medical" })
  expect(onlyMedical.items.map((item) => item.slug)).toEqual(["t-filtro-latidia"])
  expect(onlyMedical.total).toBe(1)
  // La cuenta por producto no depende del producto elegido.
  expect(onlyMedical.byProduct).toEqual({ dental: 2, medical: 1, optical: 0 })
  const onlyDental = await listOrganizations(ownerDb, support, { q: "filtro", product: "dental" })
  expect(onlyDental.items.map((item) => item.slug).sort()).toEqual(["t-filtro-odentia", "t-filtro-sin-perfil"])

  const products = await listOrganizationProducts(ownerDb, support)
  expect(products).toMatchObject({ [medical.organizationId]: "medical", [dental.organizationId]: "dental", "t-filtro-sin-perfil": "dental" })
  expect((await getOrganizationDetail(ownerDb, support, medical.organizationId)).product).toBe("medical")
  await expect(listOrganizationProducts(ownerDb, null)).rejects.toThrow()
})

it("la ficha › Equipo dice el rol en español y con la palabra del producto", async () => {
  const medical = await ownerDb.transaction((tx) =>
    createAssistedOrganization(tx, admin, { orgName: "Consultorio Roles", slug: "t-roles-latidia", email: "t-roles-l@example.test", countryCode: "PE", product: "medical" }),
  )
  await seedUser("t-roles-medico", "t-roles-medico@example.test", true, new Date())
  await seedMember(medical.organizationId, "t-roles-medico", "clinician")
  const detail = await getOrganizationDetail(ownerDb, support, medical.organizationId)
  expect(detail.members.map((item) => item.roleLabel)).toEqual(["Médico"])
  expect(detail.invitations.map((item) => item.roleLabel)).toEqual(["Propietario"])
})

describe("Inicio: altas por completar y propietarias sin aceptar", () => {
  const DAY = 24 * 60 * 60 * 1000
  let n = 0
  const assisted = async (actor: AdminActor = admin) => {
    n += 1
    return ownerDb.transaction((tx) =>
      createAssistedOrganization(tx, actor, {
        orgName: `Clínica Inicio ${n}`,
        slug: `t-inicio-${n}`,
        email: `t-inicio-${n}@example.test`,
        countryCode: "PE",
      }),
    )
  }
  const incomplete = async () => (await getOrganizationPendingCounts(ownerDb, admin)).incompleteProvisioning
  const expiresIn = (invitationId: string, ms: number) =>
    ownerDb.update(invitation).set({ expiresAt: new Date(Date.now() + ms) }).where(eq(invitation.id, invitationId))
  const pendingIds = async () => (await ownersPendingRows(ownerDb)).map((row) => row.organizationId)

  beforeEach(async () => {
    // Las invitaciones del alta asistida las hace el personal: quien está en `admin_staff`.
    await ownerDb.insert(adminStaff).values([{ userId: "t-admin", role: "admin" }, { userId: "t-support", role: "support" }]).onConflictDoNothing()
  })

  it("un alta asistida con perfil y sin sede cuenta en «Altas por completar», igual que su etiqueta", async () => {
    const before = await incomplete()
    const created = await assisted()
    const [item] = (await listOrganizations(ownerDb, admin, { q: created.slug })).items
    expect(item).toMatchObject({ hasProfile: true, hasBranch: false })
    expect(await incomplete()).toBe(before + 1)
    // Con su primera sede ya está completa.
    await ownerDb.insert(branch).values({ organizationId: created.organizationId, name: "Sede principal" })
    expect(await incomplete()).toBe(before)
  })

  it("una demo para presentar no cuenta en «Altas por completar»", async () => {
    const before = await incomplete()
    const created = await assisted()
    await ownerDb.insert(saasDemo).values({
      organizationId: created.organizationId,
      product: "dental",
      kind: "dental",
      size: "pequeno",
      months: 6,
      countryCode: "PE",
      name: "Demo Inicio",
      slug: created.slug,
      presenterUserId: "t-admin",
      createdBy: "t-admin",
      seed: 1,
    })
    expect(await incomplete()).toBe(before)
    expect(await pendingIds()).not.toContain(created.organizationId)
  })

  it("sale la clínica con la propietaria sin aceptar cuando su invitación vence en 3 días o ya venció", async () => {
    const soon = await assisted()
    const late = await assisted(support)
    const later = await assisted()
    await expiresIn(soon.invitationId, 3 * DAY - 60_000)
    await expiresIn(late.invitationId, -DAY)
    await expiresIn(later.invitationId, 5 * DAY)
    const rows = (await ownersPendingRows(ownerDb)).filter((row) =>
      [soon.organizationId, late.organizationId, later.organizationId].includes(row.organizationId),
    )
    // Lo vencido arriba; la que vence en 5 días todavía no sale.
    expect(rows.map((row) => row.organizationId)).toEqual([late.organizationId, soon.organizationId])
    expect(rows[1]).toMatchObject({ invitationId: soon.invitationId, product: "dental", organizationName: expect.stringMatching(/^Clínica Inicio/) })
    // Ni el correo de la invitada ni importes.
    expect(JSON.stringify(rows)).not.toContain("@example.test")
  })

  it("no sale si ya tiene propietaria, ni la invitación que la clínica le hizo a su socia", async () => {
    const owned = await assisted()
    await expiresIn(owned.invitationId, DAY)
    await seedUser("t-inicio-duena", "t-inicio-duena@example.test", true, new Date())
    await seedMember(owned.organizationId, "t-inicio-duena", "owner")
    expect(await pendingIds()).not.toContain(owned.organizationId)

    // Una clínica sin propietaria (salió) que invitó ella misma a una socia como propietaria: no es un alta nuestra.
    const own = await assisted()
    await expiresIn(own.invitationId, DAY)
    await seedUser("t-inicio-socia", "t-inicio-socia@example.test", true, new Date())
    await ownerDb.insert(invitation).values({
      id: randomUUID(),
      organizationId: own.organizationId,
      email: "t-inicio-otra@example.test",
      role: "owner",
      status: "pending",
      expiresAt: new Date(Date.now() + DAY),
      createdAt: new Date(Date.now() + 60_000),
      inviterId: "t-inicio-socia",
    })
    expect(await pendingIds()).not.toContain(own.organizationId)

    // Aceptada o cancelada, tampoco.
    const accepted = await assisted()
    await expiresIn(accepted.invitationId, DAY)
    await ownerDb.update(invitation).set({ status: "accepted" }).where(eq(invitation.id, accepted.invitationId))
    expect(await pendingIds()).not.toContain(accepted.organizationId)
  })

  it("reenviar una vencida la renueva por 7 días y la fila se va", async () => {
    const created = await assisted()
    await expiresIn(created.invitationId, -DAY)
    expect(await pendingIds()).toContain(created.organizationId)
    const resent = await ownerDb.transaction((tx) => resendOrganizationInvitation(tx, admin, created.invitationId))
    expect(Math.round((resent.expiresAt.getTime() - Date.now()) / DAY)).toBe(7)
    expect(await pendingIds()).not.toContain(created.organizationId)
  })
})
