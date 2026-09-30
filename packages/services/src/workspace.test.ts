import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { agentHandoff, agentProposal, agentRunLedger } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { patient, patientCharge, patientPayment } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message, pipeline, pipelineStage } from "@odentia/db/schema/crm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { orgProfile } from "@odentia/db/schema/org"
import { sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { createWorkspaceNotification, getManagementReport, getWorkspaceHome, getWorkspacePulse, listWorkspaceAudit, listWorkspaceNotifications, readWorkspaceNotification, type WorkspaceAccess } from "./workspace.js"

setupTestDb()
const recipient = randomUUID()
const colleague = randomUUID()
const outsider = randomUUID()
const restricted: WorkspaceAccess = { patients: true, appointments: false, conversations: false, tasks: false, finance: false, clinical: false, crm: false, agent: false, allTasks: false }
const full: WorkspaceAccess = { patients: true, appointments: true, conversations: true, tasks: true, finance: true, clinical: true, crm: true, agent: true, allTasks: true }
beforeAll(async () => {
  await ownerDb.insert(user).values([recipient, colleague, outsider].map(id => ({ id, name: "Persona de prueba", email: `${id}@workspace.test`, emailVerified: true })))
  await ownerDb.insert(member).values([
    { id: randomUUID(), organizationId: "org_a", userId: recipient, role: "reception", createdAt: new Date() },
    { id: randomUUID(), organizationId: "org_a", userId: colleague, role: "reception", createdAt: new Date() },
    { id: randomUUID(), organizationId: "org_b", userId: outsider, role: "owner", createdAt: new Date() },
  ])
  await ownerDb.insert(orgProfile).values({ organizationId: "org_a", legalName: "Clínica de prueba" })

  // Canales y conversaciones: 2 abiertas en whatsapp, 1 cerrada.
  const [connection] = await ownerDb.insert(channelConnection).values({
    organizationId: "org_a", channel: "whatsapp", provider: "prueba",
    displayName: "Canal de prueba", configEncrypted: "x", webhookSecret: "y",
  }).returning({ id: channelConnection.id })
  const [contactRow] = await ownerDb.insert(contact).values({ organizationId: "org_a", displayName: "Contacto pulso" }).returning({ id: contact.id })
  for (const thread of ["hilo-abierto-1", "hilo-abierto-2"]) {
    await ownerDb.insert(conversation).values({
      organizationId: "org_a", contactId: contactRow!.id,
      channelConnectionId: connection!.id, externalThreadId: thread, status: "open",
    })
  }
  await ownerDb.insert(conversation).values({
    organizationId: "org_a", contactId: contactRow!.id,
    channelConnectionId: connection!.id, externalThreadId: "hilo-cerrado", status: "closed",
  })

  // Embudo: 2 abiertas en la primera etapa (PEN), 1 en la segunda (USD), 1 ganada (excluida).
  const [pipe] = await ownerDb.insert(pipeline).values({ organizationId: "org_a", name: "Comercial" }).returning({ id: pipeline.id })
  const [first, second] = await ownerDb.insert(pipelineStage).values([
    { organizationId: "org_a", pipelineId: pipe!.id, name: "Nuevo", position: 0 },
    { organizationId: "org_a", pipelineId: pipe!.id, name: "Contacto", position: 1 },
  ]).returning({ id: pipelineStage.id })
  await ownerDb.insert(opportunity).values([
    { organizationId: "org_a", contactId: contactRow!.id, pipelineId: pipe!.id, stageId: first!.id, title: "Caso 1", amountCents: 10000, currency: "PEN", status: "open" },
    { organizationId: "org_a", contactId: contactRow!.id, pipelineId: pipe!.id, stageId: first!.id, title: "Caso 2", amountCents: 20000, currency: "PEN", status: "open" },
    { organizationId: "org_a", contactId: contactRow!.id, pipelineId: pipe!.id, stageId: second!.id, title: "Caso 3", amountCents: 50000, currency: "USD", status: "open" },
    { organizationId: "org_a", contactId: contactRow!.id, pipelineId: pipe!.id, stageId: first!.id, title: "Caso ganado", amountCents: 99999, currency: "PEN", status: "won", closedAt: new Date(), closeReason: "Pagó el tratamiento" },
  ])

  // Agente: 2 propuestas pendientes (la segunda es la más reciente), 1 ejecutada,
  // 1 derivación reciente y 1 antigua (excluida), corridas de hoy y una de hace 5 días.
  const hour = 3_600_000
  await ownerDb.insert(agentProposal).values([
    {
      organizationId: "org_a", action: "reservar_cita", status: "propuesta",
      payload: { startsAt: new Date(Date.now() + hour).toISOString() },
      idempotencyKey: "pulso:propuesta:1", createdAt: new Date(Date.now() - hour),
    },
    {
      organizationId: "org_a", action: "cancelar_cita", status: "propuesta",
      payload: { appointmentId: "12345678-aaaa-bbbb-cccc-dddddddddddd" },
      idempotencyKey: "pulso:propuesta:2", createdAt: new Date(),
    },
    {
      organizationId: "org_a", action: "reservar_cita", status: "ejecutada",
      payload: {}, idempotencyKey: "pulso:propuesta:3", createdAt: new Date(),
    },
  ])
  await ownerDb.insert(agentHandoff).values([
    { organizationId: "org_a", reason: "Reciente", summary: "Pide humano", priority: "alta" },
    { organizationId: "org_a", reason: "Antigua", summary: "Fuera de ventana", priority: "baja", createdAt: new Date(Date.now() - 4 * 86_400_000) },
  ])
  await ownerDb.insert(agentRunLedger).values([
    { organizationId: "org_a", model: "prueba", status: "ok", startedAt: new Date() },
    { organizationId: "org_a", model: "prueba", status: "ok", startedAt: new Date() },
    { organizationId: "org_a", model: "prueba", status: "handoff", startedAt: new Date() },
    { organizationId: "org_a", model: "prueba", status: "error", startedAt: new Date(Date.now() - 5 * 86_400_000) },
  ])

  // Cobros: uno vigente en PEN, uno anulado (excluido) y uno en USD.
  const [account] = await ownerDb.insert(patient).values({ organizationId: "org_a", displayName: "Cuenta pulso", patientNumber: 901 }).returning({ id: patient.id })
  await ownerDb.insert(patientPayment).values([
    { organizationId: "org_a", patientId: account!.id, amountCents: 20000, currency: "PEN", paidAt: new Date(), method: "yape" },
    { organizationId: "org_a", patientId: account!.id, amountCents: 99999, currency: "PEN", paidAt: new Date(), method: "efectivo", voidedAt: new Date() },
    { organizationId: "org_a", patientId: account!.id, amountCents: 10000, currency: "USD", paidAt: new Date(Date.now() - 2 * 86_400_000), method: "tarjeta" },
  ])
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

it("el inicio muestra la banda del agente con pendientes, derivaciones y corridas de hoy", async () => {
  const home = await withOrgContext(appDb, "org_a", tx => getWorkspaceHome(tx, "org_a", recipient, full))
  expect(home.agent).not.toBeNull()
  expect(home.agent!.pendingProposals).toBe(2)
  // Solo propuestas en estado 'propuesta', la más reciente primero.
  expect(home.agent!.proposals.map(item => item.action)).toEqual(["cancelar_cita", "reservar_cita"])
  // Solo derivaciones de las últimas 72 horas.
  expect(home.agent!.recentHandoffs).toHaveLength(1)
  expect(home.agent!.recentHandoffs[0]).toMatchObject({ reason: "Reciente", priority: "alta" })
  expect(home.agent!.today).toEqual({ runs: 3, ok: 2, handoff: 1, error: 0, omitida: 0 })
})

it("el inicio oculta la banda del agente sin el permiso", async () => {
  const home = await withOrgContext(appDb, "org_a", tx => getWorkspaceHome(tx, "org_a", recipient, { ...full, agent: false }))
  expect(home.agent).toBeNull()
})

it("el pulso agrupa el embudo por etapa con importes por moneda", async () => {
  const pulse = await withOrgContext(appDb, "org_a", tx => getWorkspacePulse(tx, "org_a", full))
  expect(pulse.funnel).toEqual([
    { stage: "Nuevo", count: 2, amountCents: "30000", currency: "PEN" },
    { stage: "Contacto", count: 1, amountCents: "50000", currency: "USD" },
  ])
  const gated = await withOrgContext(appDb, "org_a", tx => getWorkspacePulse(tx, "org_a", { ...full, crm: false }))
  expect(gated.funnel).toBeNull()
})

it("el pulso cuenta conversaciones abiertas por canal", async () => {
  const pulse = await withOrgContext(appDb, "org_a", tx => getWorkspacePulse(tx, "org_a", full))
  expect(pulse.channels).toEqual([{ channel: "whatsapp", count: 2 }])
  const gated = await withOrgContext(appDb, "org_a", tx => getWorkspacePulse(tx, "org_a", { ...full, conversations: false }))
  expect(gated.channels).toBeNull()
})

it("las ejecuciones correctas no incluyen derivaciones ni errores y se ocultan sin permiso", async () => {
  const pulse = await withOrgContext(appDb, "org_a", tx => getWorkspacePulse(tx, "org_a", full))
  expect(pulse.execution!.reduce((sum, item) => sum + item.ok, 0)).toBe(2)
  expect(pulse.execution!.reduce((sum, item) => sum + item.handoff, 0)).toBe(1)
  expect(pulse.execution!.reduce((sum, item) => sum + item.error, 0)).toBe(1)
  const gated = await withOrgContext(appDb, "org_a", tx => getWorkspacePulse(tx, "org_a", { ...full, agent: false }))
  expect(gated.execution).toBeNull()
})

it("el pulso suma cobros no anulados por día y moneda", async () => {
  const pulse = await withOrgContext(appDb, "org_a", tx => getWorkspacePulse(tx, "org_a", full))
  const pen = pulse.collections!.filter(item => item.currency === "PEN")
  const usd = pulse.collections!.filter(item => item.currency === "USD")
  expect(pen.reduce((sum, item) => sum + Number(item.amountCents), 0)).toBe(20000)
  expect(usd.reduce((sum, item) => sum + Number(item.amountCents), 0)).toBe(10000)
  expect(pulse.collections!.every(item => /^\d{4}-\d{2}-\d{2}$/.test(item.day))).toBe(true)
  const gated = await withOrgContext(appDb, "org_a", tx => getWorkspacePulse(tx, "org_a", { ...full, finance: false }))
  expect(gated.collections).toBeNull()
})

it("la primera respuesta usa aceptación real y excluye colas, fallos y simulación", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `metricas-${orgId}`)
  await ownerDb.insert(orgProfile).values({ organizationId: orgId, legalName: "Métricas", timezone: "America/Lima" })
  const [person] = await ownerDb.insert(contact).values({ organizationId: orgId, displayName: "Interlocutor" }).returning()
  const [connection] = await ownerDb.insert(channelConnection).values({
    organizationId: orgId, channel: "whatsapp", provider: "prueba", displayName: "Métricas", configEncrypted: "x", webhookSecret: "y",
  }).returning()
  const inboundAt = new Date("2026-09-10T10:00:00.000Z")
  for (const [index, status] of ["sent", "queued", "failed", "mock", "legacy"].entries()) {
    const [thread] = await ownerDb.insert(conversation).values({
      organizationId: orgId, contactId: person!.id, channelConnectionId: connection!.id, externalThreadId: `metricas-${index}`,
    }).returning()
    await ownerDb.insert(message).values([
      { organizationId: orgId, conversationId: thread!.id, direction: "in", senderKind: "contact", status: "received", createdAt: inboundAt },
      { organizationId: orgId, conversationId: thread!.id, direction: "out", senderKind: "user",
        status: status === "mock" || status === "legacy" ? "sent" : status,
        externalId: status === "mock" ? "mock-demostracion" : `proveedor-${index}`,
        createdAt: new Date(inboundAt.getTime() + 10_000),
        sentAt: status === "sent" ? new Date(inboundAt.getTime() + 90_000) : null },
    ])
    if (status === "sent") {
      await ownerDb.insert(message).values({
        organizationId: orgId, conversationId: thread!.id, direction: "out", senderKind: "user",
        status: "sent", externalId: "proveedor-primero-aceptado",
        createdAt: new Date(inboundAt.getTime() + 20_000), sentAt: new Date(inboundAt.getTime() + 30_000),
      })
    }
  }
  const report = await withOrgContext(appDb, orgId, tx => getManagementReport(tx, orgId, "2026-09-01", "2026-09-30", full))
  expect(report.performance.responses).toEqual({ conversations: 5, responded: 2, timedResponses: 1, avgFirstResponseSeconds: 30 })
  expect(report.performance.conversations!.waiting).toBe(3)
  const home = await withOrgContext(appDb, orgId, tx => getWorkspaceHome(tx, orgId, recipient, full))
  expect(home.conversations!.waiting).toBe(3)
  const hidden = await withOrgContext(appDb, orgId, tx => getManagementReport(tx, orgId, "2026-09-01", "2026-09-30", restricted))
  expect(hidden.performance).toEqual({ responses: null, followUps: null, conversations: null, bookings: null, conversion: null, proposals: null })
})
