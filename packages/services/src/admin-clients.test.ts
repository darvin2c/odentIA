import { randomUUID } from "node:crypto"
import {
  saasClient,
  saasClientContact,
  saasClientFile,
  saasClientMilestone,
  saasInboundEmail,
  saasOpportunity,
  saasOutreach,
  saasProposal,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminAudit, adminStaff } from "@odentia/db/schema/admin-core"
import { supportCase } from "@odentia/db/schema/admin-support"
import { member, user } from "@odentia/db/schema/auth"
import {
  saasFollowUp,
  saasPayment,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import { and, eq, isNull } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import {
  addClientContact,
  archiveClient,
  CLIENT_STAGES,
  clientSignals,
  clientTimeline,
  createClient,
  getClient,
  linkContactToUser,
  listClientContacts,
  listClients,
  mergeClients,
  setPrimaryClientContact,
  updateClient,
  updateClientContact,
} from "./admin-clients.js"
import type { AdminActor } from "./admin-core.js"
import { createAssistedOrganization } from "./admin-organizations.js"
import { listSaasProposals } from "./admin-sales.js"
import { listProgressReports } from "./clinic-progress-report.js"
import { createSaasPlan } from "./saas-billing.js"
import {
  completeFounderInvitation,
  inviteFromWaitlist,
  submitWaitlistRequest,
} from "./saas-founders.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Los clientes del ARM (ADR 0185): etapa calculada, duplicados, fusión, personas, historial y enganches. */
setupTestDb()
const admin: AdminActor = { userId: "arm-admin", role: "admin" }
const support: AdminActor = { userId: "arm-support", role: "support" }
const DAY = 86_400_000
let planId: string
let n = 0
const uniq = () => {
  n += 1
  return `${Date.now().toString(36)}${n}`
}

async function newClient(
  over: { name?: string; email?: string; phone?: string; product?: "dental" | "medical" } = {},
) {
  const key = uniq()
  const { id } = await createClient(ownerDb, admin, {
    name: over.name ?? `Clínica Prueba ${key}`,
    product: over.product ?? "dental",
    contact: {
      name: "Rosa Díaz",
      email: over.email ?? `rosa-${key}@clinica.test`,
      ...(over.phone ? { phone: over.phone } : {}),
    },
    origin: "referido",
    confirmNew: true,
  })
  return id
}

async function clinicWithMember(email: string) {
  const orgId = `arm-${uniq()}`
  await insertOrg(ownerDb, orgId, orgId)
  const userId = `u-${orgId}`
  await ownerDb.insert(user).values({ id: userId, name: "Lucía Rojas", email })
  await ownerDb.insert(member).values({
    id: randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
    createdAt: new Date(),
  })
  return { orgId, userId }
}

function request(email: string, clinicName = "Clínica Sonrisa") {
  return {
    firstName: "Ana",
    lastName: "Quispe",
    email,
    phone: "+51 987 654 321",
    clinicName,
    countryCode: "pe",
    city: "Arequipa",
    professionals: "2-3" as const,
    currentTool: "cuaderno_excel" as const,
  }
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Marta Admin", email: "admin@arm.test" },
    { id: support.userId, name: "Sergio Soporte", email: "support@arm.test" },
    { id: "arm-ex", name: "Ya no está", email: "ex@arm.test" },
  ])
  await ownerDb.insert(adminStaff).values([
    { userId: admin.userId, role: "admin" },
    { userId: support.userId, role: "support" },
    { userId: "arm-ex", role: "support", active: false },
  ])
  const plan = await createSaasPlan(ownerDb, admin.userId, {
    code: "arm-plan",
    name: "Plan ARM",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 4_000_000,
    trialCreditCents: 10_000,
    trialMaxCreditCents: 10_000,
    trialDays: 30,
    showOnWeb: false,
  })
  planId = plan.id
})

describe("la etapa se calcula", () => {
  it("la lista y la ficha dicen la misma, cliente por cliente", async () => {
    const contacto = await newClient()
    const agendada = await newClient()
    await ownerDb
      .insert(saasTask)
      .values({ clientId: agendada, kind: "presentacion", title: "Presentar", dueOn: "2099-01-01" })
    const hecha = await newClient()
    await ownerDb
      .insert(saasTask)
      .values({ clientId: hecha, kind: "presentacion", title: "Presentar", dueOn: "2099-01-01" })
    await ownerDb
      .insert(saasFollowUp)
      .values({ clientId: hecha, kind: "presentacion", body: "Se presentó la agenda" })
    const noConecto = await newClient()
    await ownerDb.insert(saasFollowUp).values({
      clientId: noConecto,
      kind: "nota",
      body: "La presentación no se hizo: no se conectó",
    })
    const propuesta = await newClient()
    await ownerDb.insert(saasProposal).values({
      clientId: propuesta,
      version: 1,
      planId,
      listPriceCents: 2900,
      currency: "USD",
      validUntil: "2099-12-31",
      status: "enviada",
      sentAt: new Date(),
    })
    const vencida = await newClient()
    await ownerDb.insert(saasProposal).values({
      clientId: vencida,
      version: 1,
      planId,
      listPriceCents: 2900,
      currency: "USD",
      validUntil: "2000-01-01",
      status: "enviada",
      sentAt: new Date(),
    })
    const perdido = await newClient()
    await ownerDb
      .update(saasOpportunity)
      .set({ decision: "perdido", reason: "precio", decidedAt: new Date() })
      .where(eq(saasOpportunity.clientId, perdido))
    const expected: Record<string, string> = {
      [contacto]: "contacto",
      [agendada]: "presentacion_agendada",
      [hecha]: "presentacion_hecha",
      [noConecto]: "contacto",
      [propuesta]: "propuesta",
      [vencida]: "contacto",
      [perdido]: "perdido",
    }
    const { items } = await listClients(ownerDb, admin, { view: "todos", limit: 100 })
    for (const [id, stage] of Object.entries(expected)) {
      expect(items.find((item) => item.id === id)?.stage).toBe(stage)
      expect((await getClient(ownerDb, admin, id)).stage).toBe(stage)
    }
    for (const stage of CLIENT_STAGES) {
      const filtered = await listClients(ownerDb, admin, { view: "todos", stage, limit: 100 })
      expect(filtered.items.every((item) => item.stage === stage)).toBe(true)
    }
  })
})

describe("nuevo cliente", () => {
  it("guarda la clínica, su persona principal (papeles por confirmar) y abre su venta; responsable, quien la crea", async () => {
    const { id, duplicates } = await createClient(ownerDb, support, {
      name: "Dental Los Olivos",
      product: "dental",
      contact: { name: "Pedro Ruiz", phone: "+51 912 345 678" },
      origin: "evento",
      originDetail: "Feria de Lima",
    })
    expect(duplicates).toEqual([])
    const [client] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, id))
    expect(client).toMatchObject({
      ownerUserId: support.userId,
      origin: "evento",
      createdBy: support.userId,
      organizationId: null,
    })
    const [contact] = await ownerDb
      .select()
      .from(saasClientContact)
      .where(eq(saasClientContact.clientId, id))
    expect(contact).toMatchObject({ phone: "+51912345678", isPrimary: true, rolesConfirmed: false })
    const opportunities = await ownerDb
      .select()
      .from(saasOpportunity)
      .where(eq(saasOpportunity.clientId, id))
    expect(opportunities).toHaveLength(1)
    expect(opportunities[0]?.decision).toBeNull()
    const [audit] = await ownerDb
      .select()
      .from(adminAudit)
      .where(and(eq(adminAudit.action, "client.created"), eq(adminAudit.entityId, id)))
    expect(audit?.metadata).not.toHaveProperty("name")
  })

  it("pide celular o correo, un celular con su código de país, y solo Administración elige otro responsable", async () => {
    const base = { name: "Sin datos", product: "dental" as const, origin: "otro" as const }
    await expect(
      createClient(ownerDb, admin, { ...base, contact: { name: "Nadie" } }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { "contact.phone": expect.any(String), "contact.email": expect.any(String) },
    })
    await expect(
      createClient(ownerDb, admin, { ...base, contact: { name: "X", phone: "987654321" } }),
    ).rejects.toMatchObject({
      fields: { "contact.phone": expect.stringContaining("+51") },
    })
    await expect(
      createClient(ownerDb, support, {
        ...base,
        contact: { name: "X", email: "x@x.test" },
        ownerUserId: admin.userId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", fields: { ownerUserId: expect.any(String) } })
    await expect(
      createClient(ownerDb, admin, {
        ...base,
        contact: { name: "X", email: "x2@x.test" },
        ownerUserId: "arm-ex",
      }),
    ).rejects.toMatchObject({ fields: { ownerUserId: expect.any(String) } })
    const { id } = await createClient(ownerDb, admin, {
      ...base,
      name: "Con responsable",
      contact: { name: "X", email: "x3@x.test" },
      ownerUserId: support.userId,
    })
    const [row] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, id))
    expect(row?.ownerUserId).toBe(support.userId)
  })

  it("con un correo, una solicitud o un nombre parecido responde 409 «¿es la misma?»; nunca fusiona sola", async () => {
    const email = `dup-${uniq()}@clinica.test`
    const first = await newClient({
      name: "Odontología Primavera",
      email,
      phone: "+51 955 111 222",
    })
    const attempt = createClient(ownerDb, admin, {
      name: "Otra cosa",
      product: "dental",
      contact: { name: "Rosa", email },
      origin: "otro",
    })
    await expect(attempt).rejects.toMatchObject({
      code: "CLIENT_MAYBE_DUPLICATE",
      status: 409,
      fields: { "contact.email": expect.any(String) },
      duplicates: [expect.objectContaining({ clientId: first, why: "correo" })],
    })
    // Nombre parecido, sin tildes ni mayúsculas.
    await expect(
      createClient(ownerDb, admin, {
        name: "odontologia primavera",
        product: "dental",
        contact: { name: "X", email: `otra-${uniq()}@x.test` },
        origin: "otro",
      }),
    ).rejects.toMatchObject({
      code: "CLIENT_MAYBE_DUPLICATE",
      fields: { name: expect.any(String) },
    })
    // Una solicitud de la web con ese correo.
    const webEmail = `web-${uniq()}@clinica.test`
    await submitWaitlistRequest(ownerDb, request(webEmail, "Clínica del Puerto"))
    await expect(
      createClient(ownerDb, admin, {
        name: "Puerto Sonrisas",
        product: "dental",
        contact: { name: "X", email: webEmail },
        origin: "otro",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_MAYBE_DUPLICATE" })
    // El teléfono solo es una pista: no frena, pero se dice.
    const byPhone = await createClient(ownerDb, admin, {
      name: `Clínica Distinta ${uniq()}`,
      product: "dental",
      contact: { name: "X", phone: "+51955111222" },
      origin: "otro",
    })
    expect(byPhone.duplicates).toEqual([
      expect.objectContaining({ clientId: first, why: "telefono" }),
    ])
    // «Es otra»: se crea y quedan las dos.
    const confirmed = await createClient(ownerDb, admin, {
      name: "Otra cosa",
      product: "dental",
      contact: { name: "Rosa", email },
      origin: "otro",
      confirmNew: true,
    })
    expect(confirmed.duplicates.length).toBeGreaterThan(0)
    expect(confirmed.id).not.toBe(first)
  })
})

describe("la lista", () => {
  it("vistas con sus conteos, búsqueda por clínica, persona, correo o teléfono, y responsable", async () => {
    const tag = uniq()
    const mine = await createClient(ownerDb, admin, {
      name: `Busca ${tag} Norte`,
      product: "medical",
      contact: { name: `Gloria ${tag}`, email: `gloria-${tag}@x.test`, phone: "+51 944 777 888" },
      origin: "busqueda",
      confirmNew: true,
    })
    const nobody = await createClient(ownerDb, admin, {
      name: `Busca ${tag} Sur`,
      product: "medical",
      contact: { name: "Otro", email: `sur-${tag}@x.test` },
      origin: "busqueda",
      confirmNew: true,
    })
    await updateClient(ownerDb, admin, nobody.id, { ownerUserId: null })
    const lost = await createClient(ownerDb, admin, {
      name: `Busca ${tag} Oeste`,
      product: "medical",
      contact: { name: "Otro", email: `oeste-${tag}@x.test` },
      origin: "busqueda",
      confirmNew: true,
    })
    await ownerDb
      .update(saasOpportunity)
      .set({
        decision: "no_por_ahora",
        reason: "no_es_el_momento",
        returnOn: "2099-01-01",
        decidedAt: new Date(),
      })
      .where(eq(saasOpportunity.clientId, lost.id))
    const q = `busca ${tag}`
    const all = await listClients(ownerDb, support, { view: "todos", q })
    expect(all.total).toBe(3)
    expect(all.counts).toMatchObject({
      por_vender: 2,
      no_por_ahora: 1,
      con_cuenta: 0,
      perdidos: 0,
      todos: 3,
    })
    expect((await listClients(ownerDb, support, { q })).items.map((i) => i.id).sort()).toEqual(
      [mine.id, nobody.id].sort(),
    )
    expect(
      (await listClients(ownerDb, admin, { view: "todos", q: `gloria ${tag}` })).items.map(
        (i) => i.id,
      ),
    ).toEqual([mine.id])
    expect(
      (await listClients(ownerDb, admin, { view: "todos", q: `GLORIA-${tag}@X.TEST` })).items.map(
        (i) => i.id,
      ),
    ).toEqual([mine.id])
    expect(
      (
        await listClients(ownerDb, admin, { view: "todos", q: "944 777 888", product: "medical" })
      ).items.map((i) => i.id),
    ).toContain(mine.id)
    expect(
      (await listClients(ownerDb, admin, { view: "todos", q, owner: "mio" })).items
        .map((i) => i.id)
        .sort(),
    ).toEqual([mine.id, lost.id].sort())
    expect(
      (await listClients(ownerDb, admin, { view: "todos", q, owner: "sin" })).items.map(
        (i) => i.id,
      ),
    ).toEqual([nobody.id])
    expect((await listClients(ownerDb, admin, { view: "todos", q, origin: "web" })).total).toBe(0)
    const row = all.items.find((i) => i.id === mine.id)
    expect(row).toMatchObject({
      product: "medical",
      origin: "busqueda",
      owner: { userId: admin.userId, name: "Marta Admin" },
      nextStep: null,
    })
  })

  it("las señales de Kairós: sin próximo paso, se enfría y puede estar repetida", async () => {
    const email = `senal-${uniq()}@x.test`
    const cold = await newClient({ email })
    await ownerDb
      .update(saasClient)
      .set({ createdAt: new Date(Date.now() - 10 * DAY) })
      .where(eq(saasClient.id, cold))
    const { items } = await listClients(ownerDb, admin, { view: "todos", q: email })
    expect(items[0]?.signals.map((s) => s.code)).toEqual(["se_enfria", "sin_proximo_paso"])
    await ownerDb
      .insert(saasTask)
      .values({ clientId: cold, kind: "llamar", title: "Llamar", dueOn: "2000-01-01" })
    await ownerDb
      .insert(saasFollowUp)
      .values({ clientId: cold, kind: "llamada", direction: "salio", body: "Contestó" })
    const twin = await newClient({ email })
    const again = await listClients(ownerDb, admin, { view: "todos", q: email })
    const coldRow = again.items.find((i) => i.id === cold)
    expect(coldRow?.signals.map((s) => s.code)).toEqual(["duplicado"])
    expect(coldRow?.nextStep).toMatchObject({
      kind: "llamar",
      title: "Llamar",
      dueOn: "2000-01-01",
      overdue: true,
    })
    expect(again.items.find((i) => i.id === twin)?.signals.map((s) => s.code)).toContain(
      "duplicado",
    )
  })

  it("«puede estar repetida» no sale si no se pueden fusionar: las dos con cuenta, o de otro producto", async () => {
    const accounts = `cuentas-${uniq()}@x.test`
    const withAccount = [await newClient({ email: accounts }), await newClient({ email: accounts })]
    for (const id of withAccount) {
      const orgId = `arm-dup-${uniq()}`
      await insertOrg(ownerDb, orgId, orgId)
      await ownerDb.update(saasClient).set({ organizationId: orgId }).where(eq(saasClient.id, id))
    }
    const products = `productos-${uniq()}@x.test`
    const dental = await newClient({ email: products })
    const medical = await newClient({ email: products, product: "medical" })
    const signals = await clientSignals(ownerDb, admin, [...withAccount, dental, medical])
    for (const id of [...withAccount, dental, medical])
      expect((signals.get(id) ?? []).map((s) => s.code)).not.toContain("duplicado")
    // `mergeClients` rechaza esas mismas fusiones.
    await expect(
      mergeClients(ownerDb, admin, withAccount[0] as string, withAccount[1] as string),
    ).rejects.toMatchObject({ code: "CLIENT_MERGE_TWO_ACCOUNTS" })
    await expect(mergeClients(ownerDb, admin, dental, medical)).rejects.toMatchObject({
      code: "VALIDATION",
    })
    // Con una sola con cuenta sí se puede, y sí sale.
    const single = await newClient({ email: accounts })
    const withSingle = await clientSignals(ownerDb, admin, [single, ...withAccount])
    expect((withSingle.get(single) ?? []).map((s) => s.code)).toContain("duplicado")
  })
})

describe("la ficha", () => {
  it("cabecera, personas (con el equipo de la cuenta como filas de solo lectura), tareas, actividades y lo que Soporte no ve", async () => {
    const { orgId, userId } = await clinicWithMember(`lucia-${uniq()}@clinica.test`)
    const id = await newClient()
    await ownerDb.update(saasClient).set({ organizationId: orgId }).where(eq(saasClient.id, id))
    await ownerDb.insert(saasTask).values({
      clientId: id,
      kind: "alta",
      title: "Cargar datos",
      dueOn: "2099-02-02",
      assigneeUserId: support.userId,
    })
    await ownerDb.insert(saasFollowUp).values([
      { clientId: id, kind: "nota", body: "Nota para todos", authorUserId: support.userId },
      {
        clientId: id,
        kind: "nota",
        body: "Solo administración",
        authorUserId: admin.userId,
        adminOnly: true,
      },
    ])
    // Ocho días después: la cuenta ya no es nueva y nadie de la clínica entró (regla de `kairosRiskRows`).
    const detail = await getClient(ownerDb, admin, id, new Date(Date.now() + 8 * DAY))
    expect(detail).toMatchObject({
      stage: "entro",
      organization: { id: orgId, slug: orgId },
      nextStep: { kind: "alta", title: "Cargar datos" },
      owner: { userId: admin.userId },
    })
    expect(detail.contacts.map((c) => c.source)).toEqual(["contacto", "miembro"])
    expect(detail.contacts[1]).toMatchObject({
      readOnly: true,
      user: { userId, role: "owner", roleLabel: expect.any(String) },
    })
    expect(detail.openTasks[0]?.assignee).toEqual({
      userId: support.userId,
      name: "Sergio Soporte",
    })
    expect(detail.recentActivities).toHaveLength(2)
    expect(detail.riskSignals.map((s) => s.code)).toContain("sin_sesiones")
    const forSupport = await getClient(ownerDb, support, id)
    expect(forSupport.recentActivities.map((a) => a.body)).toEqual(["Nota para todos"])
    await expect(getClient(ownerDb, admin, randomUUID())).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(getClient(ownerDb, admin, "no-es-uuid")).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("cambiar datos: el responsable solo Administración; el producto de una cuenta no cambia; archivar es de Administración", async () => {
    const id = await newClient()
    await expect(
      updateClient(ownerDb, support, id, { ownerUserId: support.userId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    const updated = await updateClient(ownerDb, support, id, {
      city: "Cusco",
      professionals: "4-9",
      origin: "redes",
    })
    expect(updated).toMatchObject({ city: "Cusco", professionals: "4-9", origin: "redes" })
    const [audit] = await ownerDb
      .select()
      .from(adminAudit)
      .where(and(eq(adminAudit.action, "client.updated"), eq(adminAudit.entityId, id)))
    expect(audit?.metadata).toEqual({ fields: ["city", "professionals", "origin"] })
    const { orgId } = await clinicWithMember(`p-${uniq()}@x.test`)
    await ownerDb.update(saasClient).set({ organizationId: orgId }).where(eq(saasClient.id, id))
    await expect(updateClient(ownerDb, admin, id, { product: "medical" })).rejects.toMatchObject({
      fields: { product: expect.any(String) },
    })
    await expect(archiveClient(ownerDb, support, id)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await archiveClient(ownerDb, admin, id)
    expect(
      (await listClients(ownerDb, admin, { view: "todos", limit: 100 })).items.some(
        (i) => i.id === id,
      ),
    ).toBe(false)
  })
})

describe("personas", () => {
  it("la primera es la principal; una principal por cliente; decir sus papeles los confirma", async () => {
    const id = await newClient()
    const second = await addClientContact(ownerDb, support, id, {
      name: "Juan Pérez",
      roles: ["paga", "paga"],
      email: "JUAN@X.TEST",
    })
    expect(second).toMatchObject({
      isPrimary: false,
      roles: ["paga"],
      email: "juan@x.test",
      rolesConfirmed: true,
    })
    await setPrimaryClientContact(ownerDb, support, second.id)
    const rows = await listClientContacts(ownerDb, support, id)
    expect(rows.filter((r) => r.isPrimary).map((r) => r.id)).toEqual([second.id])
    const first = rows.find((r) => r.id !== second.id)
    expect(first?.rolesConfirmed).toBe(false)
    const confirmed = await updateClientContact(ownerDb, support, first?.id ?? "", {
      roles: ["decide"],
    })
    expect(confirmed).toMatchObject({ roles: ["decide"], rolesConfirmed: true })
  })

  it("ligar a un usuario: solo Administración, solo con el mismo correo y si es del equipo de la cuenta", async () => {
    const email = `liga-${uniq()}@clinica.test`
    const { orgId, userId } = await clinicWithMember(email)
    const id = await newClient({ email })
    const [contact] = await ownerDb
      .select()
      .from(saasClientContact)
      .where(eq(saasClientContact.clientId, id))
    const contactId = contact?.id ?? ""
    await expect(linkContactToUser(ownerDb, admin, contactId, userId)).rejects.toMatchObject({
      fields: { userId: expect.stringContaining("cuenta") },
    })
    await ownerDb.update(saasClient).set({ organizationId: orgId }).where(eq(saasClient.id, id))
    await expect(linkContactToUser(ownerDb, support, contactId, userId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    const other = await addClientContact(ownerDb, admin, id, {
      name: "Otra",
      email: "otra@clinica.test",
      phone: "+51 900 000 001",
    })
    await expect(linkContactToUser(ownerDb, admin, other.id, userId)).rejects.toMatchObject({
      fields: { userId: expect.stringContaining("correo") },
    })
    const stranger = `u-stranger-${uniq()}`
    await ownerDb
      .insert(user)
      .values({ id: stranger, name: "Extraña", email: `otra-${uniq()}@clinica.test` })
    await ownerDb
      .update(saasClientContact)
      .set({ email: (await ownerDb.select().from(user).where(eq(user.id, stranger)))[0]?.email })
      .where(eq(saasClientContact.id, other.id))
    await expect(linkContactToUser(ownerDb, admin, other.id, stranger)).rejects.toMatchObject({
      fields: { userId: expect.stringContaining("equipo") },
    })
    const linked = await linkContactToUser(ownerDb, admin, contactId, userId)
    expect(linked.userId).toBe(userId)
    const rows = await listClientContacts(ownerDb, admin, id)
    // El miembro ligado ya no sale como fila aparte.
    expect(rows.filter((r) => r.source === "miembro")).toEqual([])
    expect(rows.find((r) => r.id === contactId)?.user).toMatchObject({ userId, role: "owner" })
    await expect(
      updateClientContact(ownerDb, admin, contactId, { email: "cambia@x.test" }),
    ).rejects.toMatchObject({ fields: { email: expect.any(String) } })
  })
})

describe("fusionar", () => {
  it("todo pasa a la que se queda, las propuestas siguen numeradas y queda una venta abierta", async () => {
    const keep = await newClient()
    const drop = await newClient()
    const { orgId } = await clinicWithMember(`f-${uniq()}@x.test`)
    await ownerDb
      .update(saasClient)
      .set({ organizationId: orgId, city: "Piura" })
      .where(eq(saasClient.id, drop))
    await ownerDb.insert(saasFollowUp).values({ clientId: drop, kind: "llamada", body: "La llamé" })
    await ownerDb
      .insert(saasTask)
      .values({ clientId: drop, kind: "llamar", title: "Volver", dueOn: "2099-01-01" })
    const proposal = { planId, listPriceCents: 2900, currency: "USD", validUntil: "2099-12-31" }
    await ownerDb.insert(saasProposal).values([
      { ...proposal, clientId: keep, version: 1 },
      { ...proposal, clientId: drop, version: 1, status: "enviada", sentAt: new Date() },
    ])
    await ownerDb
      .insert(saasOutreach)
      .values({ clientId: drop, channel: "whatsapp", toAddress: "+51900000002", body: "Hola" })
    await ownerDb.insert(saasClientFile).values({
      clientId: drop,
      kind: "otro",
      filename: "a.pdf",
      objectKey: `clients/${drop}/a.pdf`,
      contentType: "application/pdf",
      sizeBytes: 1,
    })
    // Los pasos del alta guardados viajan con la cuenta (también «No aplica» y lo perdido).
    const reachedAt = new Date("2026-10-01T15:00:00Z")
    await ownerDb.insert(saasClientMilestone).values([
      { clientId: drop, step: "entro", reachedAt, source: "hecho" },
      {
        clientId: drop,
        step: "equipo",
        naReason: "Trabaja sola",
        naBy: admin.userId,
        naAt: reachedAt,
      },
    ])
    await expect(mergeClients(ownerDb, support, keep, drop)).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    const result = await mergeClients(ownerDb, admin, keep, drop)
    expect(result.moved).toMatchObject({
      contacts: 1,
      activities: 1,
      tasks: 1,
      proposals: 1,
      outreach: 1,
      files: 1,
      milestones: 2,
    })
    const milestones = await ownerDb
      .select()
      .from(saasClientMilestone)
      .where(eq(saasClientMilestone.clientId, keep))
      .orderBy(saasClientMilestone.step)
    expect(milestones).toMatchObject([
      { step: "entro", reachedAt, source: "hecho" },
      { step: "equipo", reachedAt: null, naReason: "Trabaja sola" },
    ])
    expect(await ownerDb.select().from(saasClient).where(eq(saasClient.id, drop))).toEqual([])
    const [kept] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, keep))
    expect(kept).toMatchObject({ organizationId: orgId, city: "Piura" })
    const versions = (
      await ownerDb.select().from(saasProposal).where(eq(saasProposal.clientId, keep))
    )
      .map((p) => p.version)
      .sort()
    expect(versions).toEqual([1, 2])
    const open = await ownerDb
      .select()
      .from(saasOpportunity)
      .where(and(eq(saasOpportunity.clientId, keep), isNull(saasOpportunity.decision)))
    expect(open).toHaveLength(1)
    const contacts = await ownerDb
      .select()
      .from(saasClientContact)
      .where(eq(saasClientContact.clientId, keep))
    expect(contacts.filter((c) => c.isPrimary)).toHaveLength(1)
    const [audit] = await ownerDb
      .select()
      .from(adminAudit)
      .where(and(eq(adminAudit.action, "client.merged"), eq(adminAudit.entityId, keep)))
    expect(audit?.metadata).toMatchObject({ dropId: drop })
  })

  it("dos con cuenta no se fusionan", async () => {
    const a = await newClient()
    const b = await newClient()
    for (const id of [a, b]) {
      const { orgId } = await clinicWithMember(`m-${uniq()}@x.test`)
      await ownerDb.update(saasClient).set({ organizationId: orgId }).where(eq(saasClient.id, id))
    }
    await expect(mergeClients(ownerDb, admin, a, b)).rejects.toMatchObject({
      code: "CLIENT_MERGE_TWO_ACCOUNTS",
      fields: { dropId: expect.any(String) },
    })
    await expect(mergeClients(ownerDb, admin, a, a)).rejects.toMatchObject({
      fields: { dropId: expect.any(String) },
    })
  })
})

describe("el historial", () => {
  it("junta sus fuentes en palabras, sin códigos, y Soporte no ve importes, cobros ni lo solo de administración", async () => {
    const email = `hist-${uniq()}@clinica.test`
    const { orgId, userId } = await clinicWithMember(`dueña-${uniq()}@clinica.test`)
    const { id: requestId } = await submitWaitlistRequest(
      ownerDb,
      request(email, "Clínica Historia"),
    )
    const [req] = await ownerDb
      .select()
      .from(saasWaitlistRequest)
      .where(eq(saasWaitlistRequest.id, requestId))
    const id = req?.clientId ?? ""
    await ownerDb.update(saasClient).set({ organizationId: orgId }).where(eq(saasClient.id, id))
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000)
    await ownerDb.insert(saasFollowUp).values([
      {
        clientId: id,
        requestId,
        kind: "llamada",
        direction: "salio",
        body: "Le conté del plan",
        authorUserId: support.userId,
        happenedAt: at(50),
      },
      {
        clientId: id,
        kind: "nota",
        body: "Precio especial pedido",
        authorUserId: admin.userId,
        adminOnly: true,
        happenedAt: at(49),
      },
    ])
    await ownerDb.insert(saasTask).values({
      clientId: id,
      kind: "llamar",
      title: "Llamar a Ana",
      dueOn: "2026-11-12",
      status: "hecha",
      doneAt: at(48),
      doneBy: support.userId,
    })
    await ownerDb.insert(saasProposal).values({
      clientId: id,
      version: 1,
      planId,
      listPriceCents: 2900,
      currency: "USD",
      discountBps: 1000,
      validUntil: "2099-12-31",
      status: "enviada",
      sentAt: at(47),
      createdBy: admin.userId,
      createdAt: at(47),
    })
    await ownerDb.insert(saasOutreach).values({
      clientId: id,
      channel: "whatsapp",
      toAddress: "+51987654321",
      body: "¿Vemos la propuesta?",
      createdBy: support.userId,
      createdAt: at(46),
    })
    await ownerDb.insert(adminAudit).values([
      {
        actorUserId: admin.userId,
        actorRole: "admin",
        action: "org.setup_import",
        organizationId: orgId,
        metadata: { planSha256: "e".repeat(64), nueva: 20, cambia: 2, igual: 7 },
        createdAt: at(45),
      },
      {
        actorUserId: admin.userId,
        actorRole: "admin",
        action: "saas.paused",
        organizationId: orgId,
        createdAt: at(44),
      },
      {
        actorUserId: admin.userId,
        actorRole: "admin",
        action: "algo.desconocido",
        organizationId: orgId,
        createdAt: at(43),
      },
    ])
    await ownerDb.insert(saasPayment).values([
      {
        organizationId: orgId,
        amountCents: 2900,
        currency: "USD",
        methodCode: "transferencia",
        status: "confirmado",
        idempotencyKey: randomUUID(),
        confirmedAt: at(42),
        confirmedBy: admin.userId,
        createdAt: at(42),
      },
      {
        organizationId: orgId,
        amountCents: 2900,
        currency: "USD",
        methodCode: "transferencia",
        status: "rechazado",
        idempotencyKey: randomUUID(),
        rejectedAt: at(41),
        rejectedBy: admin.userId,
        rejectReason: "No se lee el monto",
        createdAt: at(41),
      },
    ])
    await ownerDb.insert(supportCase).values([
      {
        organizationId: orgId,
        kind: "problema",
        question: "No me llega el código",
        dedupeKey: randomUUID(),
        openedBy: userId,
        createdAt: at(40),
      },
      {
        organizationId: orgId,
        kind: "cobro",
        question: "Me cobraron dos veces",
        dedupeKey: randomUUID(),
        openedBy: userId,
        createdAt: at(39),
      },
    ])
    // Lo que deja la skill al enviar el informe: N.º 1 salió; del N.º 2 no se sabe.
    await ownerDb.insert(adminAudit).values([
      {
        actorUserId: admin.userId,
        actorRole: "admin",
        action: "org.progress_report_sending",
        organizationId: orgId,
        entityId: "informe-1",
        createdAt: at(38),
      },
      {
        actorUserId: admin.userId,
        actorRole: "admin",
        action: "org.progress_report_sent",
        organizationId: orgId,
        entityId: "informe-1",
        createdAt: at(38),
      },
      {
        actorUserId: admin.userId,
        actorRole: "admin",
        action: "org.progress_report_unknown",
        organizationId: orgId,
        entityId: "informe-2",
        createdAt: at(38),
      },
    ])
    const received = at(37)
    const registered = at(36)
    await ownerDb.insert(saasInboundEmail).values([
      {
        clientId: id,
        mailbox: "contacto",
        product: "dental",
        messageId: `<a-${uniq()}@x>`,
        fromAddress: email,
        toAddress: "contacto@odentia32.com",
        subject: "Consulta",
        receivedAt: received,
      },
      {
        clientId: id,
        mailbox: "soporte",
        product: "dental",
        messageId: `<b-${uniq()}@x>`,
        fromAddress: email,
        toAddress: "soporte@odentia32.com",
        subject: "Ya registrado",
        receivedAt: registered,
      },
    ])
    // El segundo correo ya dejó su actividad (misma hora): no se cuenta dos veces.
    await ownerDb.insert(saasFollowUp).values({
      clientId: id,
      kind: "correo",
      direction: "entro",
      body: "Ya registrado",
      byKairos: true,
      happenedAt: registered,
    })
    await ownerDb.insert(saasClientFile).values({
      clientId: id,
      kind: "carta",
      filename: "carta.pdf",
      objectKey: `clients/${id}/carta.pdf`,
      contentType: "application/pdf",
      sizeBytes: 10,
      adminOnly: false,
      createdBy: admin.userId,
      source: "persona",
      createdAt: at(35),
    })

    const forAdmin = await clientTimeline(ownerDb, admin, id, { limit: 100 })
    const titles = forAdmin.items.map((i) => i.title)
    expect(titles).toEqual(
      expect.arrayContaining([
        "Pidió entrar desde la web",
        "La llamamos",
        "Nota",
        "Hecho: Llamar a Ana",
        "Se preparó la propuesta 1",
        "Se envió la propuesta 1",
        "Mensaje por WhatsApp: falta decir si salió",
        "Se cargó la configuración: 20 nuevos · 2 cambiaron · 7 ya estaban",
        "Se pausó su plan",
        "Se confirmó su pago",
        "Se rechazó su comprobante",
        "Abrió un caso de soporte",
        "Abrió un caso de cobro",
        "Salió el informe N.º 1",
        "No se sabe si salió el informe N.º 2",
        "Nos escribió a contacto@",
        "Nos escribió un correo",
        "Carta de bienvenida: carta.pdf",
      ]),
    )
    expect(titles).not.toContain("Nos escribió a soporte@")
    // El paso de en medio de cada envío no se dice: lo dice cómo terminó.
    expect(titles.filter((title) => title.includes("informe N.º 1"))).toHaveLength(1)
    expect(JSON.stringify(forAdmin.items)).not.toContain("algo.desconocido")
    expect(forAdmin.items.find((i) => i.title === "Se confirmó su pago")?.detail).toBe("USD 29")
    expect(forAdmin.items.find((i) => i.title === "Se preparó la propuesta 1")?.detail).toContain(
      "10 % de descuento",
    )
    expect(forAdmin.items.find((i) => i.title === "La llamamos")?.who).toEqual({
      kind: "persona",
      name: "Sergio Soporte",
    })
    // Lo anotó Kairós, pero lo escribió quien lo mandó: sin nombre, su correo.
    expect(forAdmin.items.find((i) => i.title === "Nos escribió un correo")?.who).toEqual({
      kind: "clinica",
      name: email,
    })
    // Ordenado de lo más nuevo a lo más viejo.
    const times = forAdmin.items.map((i) => i.at.getTime())
    expect([...times].sort((a, b) => b - a)).toEqual(times)

    const forSupport = await clientTimeline(ownerDb, support, id, { limit: 100 })
    const seen = forSupport.items.map((i) => i.title)
    expect(seen).not.toContain("Nota")
    expect(seen).not.toContain("Abrió un caso de cobro")
    expect(seen.some((title) => title.startsWith("Se cargó la configuración"))).toBe(false)
    expect(seen.some((title) => title.includes("informe"))).toBe(false)
    expect(forSupport.items.every((i) => !i.adminOnly)).toBe(true)
    expect(forSupport.items.find((i) => i.title === "Se confirmó su pago")?.detail).toBeUndefined()
    expect(
      forSupport.items.find((i) => i.title === "Se preparó la propuesta 1")?.detail,
    ).toBeUndefined()
    expect(forSupport.items.find((i) => i.title === "Se rechazó su comprobante")?.detail).toBe(
      "No se lee el monto",
    )

    const onlySupport = await clientTimeline(ownerDb, admin, id, { filter: "soporte" })
    expect(new Set(onlySupport.items.map((i) => i.category))).toEqual(new Set(["soporte"]))

    // «Cargar más»: las páginas no repiten ni pierden entradas.
    const pages: string[] = []
    let before: Date | undefined
    for (let page = 0; page < 20; page += 1) {
      const { items, nextBefore } = await clientTimeline(ownerDb, admin, id, { limit: 4, before })
      pages.push(...items.map((i) => i.id))
      if (!nextBefore) break
      before = nextBefore
    }
    expect(pages).toEqual(forAdmin.items.map((i) => i.id))
  })
})

describe("enganches: la solicitud y la cuenta", () => {
  it("la solicitud de la web crea su cliente y su persona; otra con el mismo correo reutiliza el cliente", async () => {
    const email = `engancha-${uniq()}@clinica.test`
    const { id } = await submitWaitlistRequest(
      ownerDb,
      request(email, "Clínica Enganche"),
      "medical",
    )
    const [req] = await ownerDb
      .select()
      .from(saasWaitlistRequest)
      .where(eq(saasWaitlistRequest.id, id))
    expect(req?.source).toBe("web")
    const [client] = await ownerDb
      .select()
      .from(saasClient)
      .where(eq(saasClient.id, req?.clientId ?? ""))
    expect(client).toMatchObject({
      name: "Clínica Enganche",
      product: "medical",
      origin: "web",
      countryCode: "PE",
      city: "Arequipa",
      professionals: "2-3",
      createdBy: null,
    })
    const [contact] = await ownerDb
      .select()
      .from(saasClientContact)
      .where(eq(saasClientContact.clientId, client?.id ?? ""))
    expect(contact).toMatchObject({
      name: "Ana Quispe",
      email,
      phone: "+51987654321",
      isPrimary: true,
      rolesConfirmed: false,
    })
    // Se descarta y vuelve: el mismo cliente, otra venta.
    await ownerDb
      .update(saasOpportunity)
      .set({ decision: "perdido", reason: "no_respondio", decidedAt: new Date() })
      .where(eq(saasOpportunity.clientId, client?.id ?? ""))
    await ownerDb
      .update(saasWaitlistRequest)
      .set({ status: "descartada", discardReason: "No respondió", decidedAt: new Date() })
      .where(eq(saasWaitlistRequest.id, id))
    const again = await submitWaitlistRequest(
      ownerDb,
      request(email, "Clínica Enganche 2"),
      "medical",
    )
    const [second] = await ownerDb
      .select()
      .from(saasWaitlistRequest)
      .where(eq(saasWaitlistRequest.id, again.id))
    expect(second?.clientId).toBe(client?.id)
    const opportunities = await ownerDb
      .select()
      .from(saasOpportunity)
      .where(eq(saasOpportunity.clientId, client?.id ?? ""))
    expect(opportunities.map((o) => o.decision).sort()).toEqual(["perdido", null].sort())
    expect(
      await ownerDb
        .select()
        .from(saasClientContact)
        .where(eq(saasClientContact.clientId, client?.id ?? "")),
    ).toHaveLength(1)
  })

  it("al entrar con la invitación, el cliente queda con la cuenta y su venta como «entró»", async () => {
    const email = `entra-${uniq()}@clinica.test`
    const { id } = await submitWaitlistRequest(ownerDb, request(email, "Clínica Entra"))
    await inviteFromWaitlist(ownerDb, admin, id, { planId })
    const orgId = `arm-entra-${uniq()}`
    await insertOrg(ownerDb, orgId, orgId)
    await completeFounderInvitation(ownerDb, id, orgId)
    const [req] = await ownerDb
      .select()
      .from(saasWaitlistRequest)
      .where(eq(saasWaitlistRequest.id, id))
    const [client] = await ownerDb
      .select()
      .from(saasClient)
      .where(eq(saasClient.id, req?.clientId ?? ""))
    expect(client?.organizationId).toBe(orgId)
    const opportunities = await ownerDb
      .select()
      .from(saasOpportunity)
      .where(eq(saasOpportunity.clientId, client?.id ?? ""))
    expect(opportunities).toEqual([expect.objectContaining({ decision: "entro", reason: null })])
    expect((await getClient(ownerDb, admin, client?.id ?? "")).stage).toBe("entro")
  })

  it("el alta asistida liga la cuenta al cliente («Dar de alta», solo Administración) o crea uno; una demo no es cliente", async () => {
    const id = await newClient({ product: "medical" })
    const slug = `t-arm-${uniq()}`
    const input = {
      orgName: "Consultorio ARM",
      slug,
      email: `alta-${uniq()}@x.test`,
      countryCode: "PE",
      clientId: id,
    }
    await expect(
      ownerDb.transaction((tx) => createAssistedOrganization(tx, support, input)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      ownerDb.transaction((tx) =>
        createAssistedOrganization(tx, admin, { ...input, product: "dental" }),
      ),
    ).rejects.toMatchObject({
      fields: { product: expect.any(String) },
    })
    const created = await ownerDb.transaction((tx) => createAssistedOrganization(tx, admin, input))
    expect(created.clientId).toBe(id)
    const [client] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, id))
    expect(client?.organizationId).toBe(created.organizationId)
    const decisions = (
      await ownerDb.select().from(saasOpportunity).where(eq(saasOpportunity.clientId, id))
    ).map((o) => o.decision)
    expect(decisions).toEqual(["entro"])
    await expect(
      ownerDb.transaction((tx) =>
        createAssistedOrganization(tx, admin, {
          ...input,
          slug: `${slug}-2`,
          email: `otra-${uniq()}@x.test`,
        }),
      ),
    ).rejects.toMatchObject({ code: "CLIENT_HAS_ACCOUNT" })

    // Sin cliente: nace uno con los datos de la cuenta, responsable quien la crea.
    const plain = await ownerDb.transaction((tx) =>
      createAssistedOrganization(tx, support, {
        orgName: "Clínica Sola",
        slug: `t-sola-${uniq()}`,
        email: `sola-${uniq()}@x.test`,
        countryCode: "PE",
      }),
    )
    const [own] = await ownerDb
      .select()
      .from(saasClient)
      .where(eq(saasClient.id, plain.clientId ?? ""))
    expect(own).toMatchObject({
      name: "Clínica Sola",
      product: "dental",
      organizationId: plain.organizationId,
      ownerUserId: support.userId,
    })

    // Una demo nunca es cliente.
    const demo = await ownerDb.transaction((tx) =>
      createAssistedOrganization(tx, admin, {
        orgName: "Demo ARM",
        slug: `t-demo-${uniq()}`,
        email: `demo-${uniq()}@x.test`,
        countryCode: "PE",
        isDemo: true,
      }),
    )
    expect(demo.clientId).toBeNull()
    expect(
      await ownerDb
        .select()
        .from(saasClient)
        .where(eq(saasClient.organizationId, demo.organizationId)),
    ).toEqual([])
  })
})

describe("los informes de la carga", () => {
  it("a la misma hora, el cierre gana al «enviándose»: un informe que no se sabe si salió no se lee enviándose", async () => {
    const orgId = `arm-${uniq()}`
    await insertOrg(ownerDb, orgId, orgId)
    const at = new Date()
    // Reservar y cerrar en una misma transacción comparten now(): mismo created_at.
    await ownerDb.insert(adminAudit).values([
      {
        action: "org.progress_report_unknown",
        organizationId: orgId,
        entityId: "informe-1",
        createdAt: at,
      },
      {
        action: "org.progress_report_sending",
        organizationId: orgId,
        entityId: "informe-1",
        createdAt: at,
      },
      {
        action: "org.progress_report_sending",
        organizationId: orgId,
        entityId: "informe-2",
        createdAt: at,
      },
      {
        action: "org.progress_report_sent",
        organizationId: orgId,
        entityId: "informe-2",
        createdAt: at,
      },
    ])
    const reports = await listProgressReports(ownerDb, orgId)
    expect(reports.map((report) => [report.number, report.state])).toEqual([
      [2, "enviado"],
      [1, "desconocido"],
    ])
  })
})

describe("lo que encontró la revisión", () => {
  it("al fusionar, las propuestas quedan numeradas por fecha: la vigente de la que se queda no pasa a reemplazada", async () => {
    const keep = await newClient()
    const drop = await newClient()
    const proposal = async (clientId: string, daysAgo: number) => {
      const at = new Date(Date.now() - daysAgo * DAY)
      const [row] = await ownerDb
        .insert(saasProposal)
        .values({
          clientId,
          version: 1,
          planId,
          listPriceCents: 2900,
          currency: "USD",
          validUntil: "2099-12-31",
          status: "enviada",
          sentAt: at,
          createdAt: at,
          updatedAt: at,
        })
        .returning({ id: saasProposal.id })
      return row?.id ?? ""
    }
    const older = await proposal(drop, 10)
    const live = await proposal(keep, 2)
    await mergeClients(ownerDb, admin, keep, drop)
    const listed = await listSaasProposals(ownerDb, admin, keep)
    expect(listed.map((p) => [p.id, p.version, p.displayStatus])).toEqual([
      [live, 2, "enviada"],
      [older, 1, "reemplazada"],
    ])
  })

  it("una solicitud de quien ya es de una clínica con cuenta abre otro cliente; entrar con una de antes, pegada a esa ficha, liga la cuenta nueva", async () => {
    const email = `segunda-${uniq()}@clinica.test`
    const requestOf = async (id: string) =>
      (await ownerDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, id)))[0]
    const { id: first } = await submitWaitlistRequest(ownerDb, request(email, "Clínica Primera"))
    await inviteFromWaitlist(ownerDb, admin, first, { planId })
    const orgA = `arm-a-${uniq()}`
    await insertOrg(ownerDb, orgA, orgA)
    await completeFounderInvitation(ownerDb, first, orgA)
    const clientA = (await requestOf(first))?.clientId ?? ""

    const { id: second } = await submitWaitlistRequest(ownerDb, request(email, "Clínica Segunda"))
    const clientB = (await requestOf(second))?.clientId ?? ""
    expect(clientB).not.toBe(clientA)
    const [b] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, clientB))
    expect(b).toMatchObject({ name: "Clínica Segunda", organizationId: null })

    // Una solicitud de antes de este arreglo, pegada a la ficha que ya tiene cuenta.
    await ownerDb
      .update(saasWaitlistRequest)
      .set({ clientId: clientA })
      .where(eq(saasWaitlistRequest.id, second))
    await inviteFromWaitlist(ownerDb, admin, second, { planId })
    const orgB = `arm-b-${uniq()}`
    await insertOrg(ownerDb, orgB, orgB)
    await completeFounderInvitation(ownerDb, second, orgB)
    const entered = await requestOf(second)
    expect(entered?.status).toBe("entro")
    expect(entered?.clientId).not.toBe(clientA)
    const [linked] = await ownerDb
      .select()
      .from(saasClient)
      .where(eq(saasClient.id, entered?.clientId ?? ""))
    expect(linked?.organizationId).toBe(orgB)
    const [subB] = await ownerDb
      .select()
      .from(saasSubscription)
      .where(eq(saasSubscription.organizationId, orgB))
    expect(subB?.planId).toBe(planId)
  })
})
