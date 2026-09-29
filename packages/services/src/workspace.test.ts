import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { patient, patientCharge } from "@odentia/db/schema/clinical"
import { orgProfile } from "@odentia/db/schema/org"
import { sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"
import { createWorkspaceNotification, getWorkspaceHome, listWorkspaceAudit, listWorkspaceNotifications, readWorkspaceNotification, type WorkspaceAccess } from "./workspace.js"

setupTestDb()
const recipient = randomUUID()
const colleague = randomUUID()
const outsider = randomUUID()
const restricted: WorkspaceAccess = { patients: true, appointments: false, conversations: false, tasks: false, finance: false, clinical: false, crm: false, allTasks: false }
beforeAll(async () => {
  await ownerDb.insert(user).values([recipient, colleague, outsider].map(id => ({ id, name: "Persona de prueba", email: `${id}@workspace.test`, emailVerified: true })))
  await ownerDb.insert(member).values([
    { id: randomUUID(), organizationId: "org_a", userId: recipient, role: "reception", createdAt: new Date() },
    { id: randomUUID(), organizationId: "org_a", userId: colleague, role: "reception", createdAt: new Date() },
    { id: randomUUID(), organizationId: "org_b", userId: outsider, role: "owner", createdAt: new Date() },
  ])
  await ownerDb.insert(orgProfile).values({ organizationId: "org_a", legalName: "Clínica de prueba" })
})

it("una notificación es idempotente y solo su destinatario autorizado puede leerla", async () => {
  const input = { userId: recipient, dedupeKey: "aviso-unico", title: "Pendiente", body: "Revisa la tarea", href: "/tasks", permission: "tasks.read" }
  await withOrgContext(appDb, "org_a", async tx => {
    await createWorkspaceNotification(tx, "org_a", input)
    await createWorkspaceNotification(tx, "org_a", input)
  })
  const result = await withOrgContext(appDb, "org_a", tx => listWorkspaceNotifications(tx, "org_a", recipient, ["tasks.read"]))
  expect(result.unread).toBe(1)
  const notice = result.items[0]!
  const others = await withOrgContext(appDb, "org_a", tx => listWorkspaceNotifications(tx, "org_a", colleague, ["tasks.read"]))
  expect(others.items).toEqual([])
  await expect(withOrgContext(appDb, "org_a", tx => readWorkspaceNotification(tx, "org_a", colleague, notice.id, ["tasks.read"]))).rejects.toMatchObject({ status: 404 })
  await expect(withOrgContext(appDb, "org_a", tx => readWorkspaceNotification(tx, "org_a", recipient, notice.id, []))).rejects.toMatchObject({ status: 404 })
  await withOrgContext(appDb, "org_a", tx => readWorkspaceNotification(tx, "org_a", recipient, notice.id, ["tasks.read"]))
  expect((await withOrgContext(appDb, "org_a", tx => listWorkspaceNotifications(tx, "org_a", recipient, ["tasks.read"]))).unread).toBe(0)
})

it("rechaza avisar a una persona que no pertenece a la organización", async () => {
  await expect(withOrgContext(appDb, "org_a", tx => createWorkspaceNotification(tx, "org_a", { userId: outsider, dedupeKey: "no-miembro", title: "Privado", body: "", href: "/home", permission: "tasks.read" }))).rejects.toMatchObject({ status: 404 })
})


it("el inicio no revela saldos a un rol sin permiso financiero", async () => {
  const [person] = await ownerDb.insert(patient).values({ organizationId: "org_a", displayName: "Cuenta privada", patientNumber: 403 }).returning()
  await ownerDb.insert(patientCharge).values({ organizationId: "org_a", patientId: person!.id, description: "Cargo", amountCents: 25000, currency: "PEN" })
  const home = await withOrgContext(appDb, "org_a", tx => getWorkspaceHome(tx, "org_a", recipient, restricted))
  expect(home.debt).toEqual([])
  expect(home.budgets).toEqual([])
  const authorized = await withOrgContext(appDb, "org_a", tx => getWorkspaceHome(tx, "org_a", recipient, { ...restricted, finance: true }))
  expect(authorized.debt).toEqual([{ currency: "PEN", outstandingCents: "25000", overdueCents: "0", patients: 1 }])
})

it("la auditoría pagina sin saltar eventos del mismo milisegundo", async () => {
  await ownerDb.execute(sql`insert into audit_event (organization_id, action, entity, created_at)
    select 'org_a', 'cursor.regression', 'prueba', '2026-09-28 10:00:00.000001+00'::timestamptz + n * interval '1 microsecond'
    from generate_series(1, 75) n`)
  const first = await withOrgContext(appDb, "org_a", tx => listWorkspaceAudit(tx, "org_a", { action: "cursor.regression" }))
  if (!first.next) throw new Error("Falta la segunda página del historial")
  const second = await withOrgContext(appDb, "org_a", tx => listWorkspaceAudit(tx, "org_a", { action: "cursor.regression", ...first.next! }))
  const ids = [...first.items, ...second.items].map(item => item.id)
  expect(new Set(ids).size).toBe(75)
  expect(second.next).toBeNull()
})
