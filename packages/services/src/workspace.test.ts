import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { agentHandoff, agentProposal, agentRunLedger } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { encounter, encounterProcedure, patientCharge, patientPayment, treatmentBudget, treatmentPlan } from "@odentia/db/schema/clinical"
import { agentConfig, channelConnection, contact, conversation, crmTask, message, pipeline, pipelineStage } from "@odentia/db/schema/crm"
import { automationJob } from "@odentia/db/schema/automation"
import { product } from "@odentia/db/schema/inventory"
import { opportunity } from "@odentia/db/schema/opportunities"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { claimHandoff, countOpenHandoffs, createHandoff, getAgentPanelSummary, getAgentRunStats, listAgentRuns } from "./agent-operations.js"
import { countConversationViews } from "./conversations.js"
import { getDebts } from "./finance.js"
import { getReportAgent } from "./report-agent.js"
import { getReportCommissions } from "./report-finance.js"
import type { WaitingRow } from "./workspace-home.js"
import {
  createWorkspaceNotification,
  getWorkspaceHome,
  listWorkspaceAudit,
  listWorkspaceNotifications,
  readAllWorkspaceNotifications,
  readWorkspaceNotification,
  settleWorkspaceNotifications,
  type WorkspaceAccess,
} from "./workspace.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()
const recipient = randomUUID()
const colleague = randomUUID()
const outsider = randomUUID()
const restricted: WorkspaceAccess = { patients: true, appointments: false, conversations: false, tasks: false, finance: false, clinical: false, crm: false, agent: false, allTasks: false, configure: false, ownAppointments: false }
const full: WorkspaceAccess = { patients: true, appointments: true, conversations: true, tasks: true, finance: true, clinical: true, crm: true, agent: true, allTasks: true, configure: true, ownAppointments: false }
/** Filas de un tipo de «Te espera», ya con su forma. */
const rowsOf = <K extends WaitingRow["kind"]>(rows: WaitingRow[], kind: K) =>
  rows.filter((row): row is Extract<WaitingRow, { kind: K }> => row.kind === kind)
beforeAll(async () => {
  await ownerDb.insert(branch).values({ organizationId: "org_a", name: "Sede de prueba", timezone: "America/Lima" })
  await ownerDb.insert(user).values([recipient, colleague, outsider].map(id => ({ id, name: "Persona de prueba", email: `${id}@workspace.test`, emailVerified: true })))
  await ownerDb.insert(member).values([
    { id: randomUUID(), organizationId: "org_a", userId: recipient, role: "reception", createdAt: new Date() },
    { id: randomUUID(), organizationId: "org_a", userId: colleague, role: "reception", createdAt: new Date() },
    { id: randomUUID(), organizationId: "org_b", userId: outsider, role: "owner", createdAt: new Date() },
  ])

  // Canales y conversaciones: 2 abiertas en whatsapp, 1 cerrada.
  const [connection] = await ownerDb.insert(channelConnection).values({
    organizationId: "org_a", channel: "whatsapp", provider: "prueba",
    displayName: "Canal de prueba", configEncrypted: "x", webhookSecret: "y",
  }).returning({ id: channelConnection.id })
  const [contactRow] = await ownerDb.insert(contact).values({ organizationId: "org_a", displayName: "Contacto pulso" }).returning({ id: contact.id })
  const openThreads: string[] = []
  for (const thread of ["hilo-abierto-1", "hilo-abierto-2"]) {
    const [row] = await ownerDb.insert(conversation).values({
      organizationId: "org_a", contactId: contactRow!.id,
      channelConnectionId: connection!.id, externalThreadId: thread, status: "open",
    }).returning({ id: conversation.id })
    openThreads.push(row!.id)
  }
  await ownerDb.insert(conversation).values({
    organizationId: "org_a", contactId: contactRow!.id,
    channelConnectionId: connection!.id, externalThreadId: "hilo-cerrado", status: "closed", closeReason: "manual", closedAt: new Date(),
  })

  // Embudo: 2 abiertas en la primera etapa (PEN), 1 en la segunda (USD), 1 ganada (excluida).
  const [pipe] = await ownerDb.insert(pipeline).values({ organizationId: "org_a", name: "Comercial" }).returning({ id: pipeline.id })
  const [first, second] = await ownerDb.insert(pipelineStage).values([
    { organizationId: "org_a", pipelineId: pipe!.id, name: "Interesado", position: 0, moment: "interesado" },
    { organizationId: "org_a", pipelineId: pipe!.id, name: "Evaluación agendada", position: 1, moment: "evaluacion_agendada" },
  ]).returning({ id: pipelineStage.id })
  await ownerDb.insert(opportunity).values([
    { organizationId: "org_a", contactId: contactRow!.id, pipelineId: pipe!.id, stageId: first!.id, title: "Caso 1", amountCents: 10000, currency: "PEN", status: "open" },
    { organizationId: "org_a", contactId: contactRow!.id, pipelineId: pipe!.id, stageId: first!.id, title: "Caso 2", amountCents: 20000, currency: "PEN", status: "open" },
    { organizationId: "org_a", contactId: contactRow!.id, pipelineId: pipe!.id, stageId: second!.id, title: "Caso 3", amountCents: 50000, currency: "USD", status: "open" },
    { organizationId: "org_a", contactId: contactRow!.id, pipelineId: pipe!.id, stageId: first!.id, title: "Caso ganado", amountCents: 99999, currency: "PEN", status: "won", closedAt: new Date(), closeReason: "acepto" },
  ])

  // Agente: 2 citas que esperan el sí del paciente (no esperan al equipo), 1 ejecutada,
  // 1 derivación reciente y 1 antigua (excluida), corridas de hoy y una de hace 5 días.
  const hour = 3_600_000
  await ownerDb.insert(agentProposal).values([
    {
      organizationId: "org_a", conversationId: openThreads[0]!, action: "reservar_cita", status: "propuesta",
      payload: { startsAt: new Date(Date.now() + hour).toISOString() },
      idempotencyKey: "pulso:propuesta:1", createdAt: new Date(Date.now() - hour),
    },
    {
      organizationId: "org_a", conversationId: openThreads[1]!, action: "cancelar_cita", status: "propuesta",
      payload: { appointmentId: "12345678-aaaa-bbbb-cccc-dddddddddddd" },
      idempotencyKey: "pulso:propuesta:2", createdAt: new Date(),
    },
    {
      organizationId: "org_a", conversationId: openThreads[0]!, action: "reservar_cita", status: "ejecutada",
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
    { organizationId: "org_a", model: "prueba", status: "sin_respuesta", startedAt: new Date(), llmCalls: 2 },
    { organizationId: "org_a", model: "prueba", status: "error", startedAt: new Date(Date.now() - 5 * 86_400_000) },
  ])

  // Cobros: uno vigente en PEN, uno anulado (excluido) y uno en USD.
  const [account] = await insertTestPatients(ownerDb, { organizationId: "org_a", displayName: "Cuenta pulso", patientNumber: 901 })
  await ownerDb.insert(patientPayment).values([
    { organizationId: "org_a", patientId: account!.id, amountCents: 20000, currency: "PEN", paidAt: new Date(), methodName: "yape" },
    { organizationId: "org_a", patientId: account!.id, amountCents: 99999, currency: "PEN", paidAt: new Date(), methodName: "efectivo", voidedAt: new Date() },
    { organizationId: "org_a", patientId: account!.id, amountCents: 10000, currency: "USD", paidAt: new Date(Date.now() - 2 * 86_400_000), methodName: "tarjeta" },
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


it("el inicio no revela la caja ni a quién falta cobrar a un rol sin permiso financiero", async () => {
  const [person] = await insertTestPatients(ownerDb, { organizationId: "org_a", displayName: "Cuenta privada", patientNumber: 403 })
  await ownerDb.insert(patientCharge).values({ organizationId: "org_a", patientId: person!.id, description: "Cargo", amountCents: 25000, currency: "PEN" })
  const home = await withOrgContext(appDb, "org_a", tx => getWorkspaceHome(tx, "org_a", recipient, restricted))
  expect(home.cash).toBeNull()
  expect(rowsOf(home.waiting, "budgets")).toEqual([])
  const authorized = await withOrgContext(appDb, "org_a", tx => getWorkspaceHome(tx, "org_a", recipient, { ...restricted, finance: true }))
  // «Por cobrar» es la lista de Finanzas › Caja: las mismas personas que `getDebts` marca como de hoy.
  const debts = await withOrgContext(appDb, "org_a", tx => getDebts(tx, "org_a", { branchId: authorized.cash!.branchId }))
  expect(authorized.cash!.toCollect.map(row => row.patientId)).toEqual(debts.filter(row => row.attendedTodayAt).map(row => row.patientId))
  expect(authorized.cash!.toCollect.find(row => row.patientId === person!.id)).toMatchObject({ displayName: "Cuenta privada", totalCents: 25000, currency: "PEN" })
  // Pagos sin movimiento de caja no cuentan como cobros del día de esta sede.
  expect(authorized.cash).toMatchObject({ currency: "PEN", collectedCents: 0, tickets: 0 })
})

it("Inicio abre la tarea de una oportunidad en Tareas, con la tarea a la vista, y la campana no la repite", async () => {
  const [opp] = await ownerDb
    .select({ id: opportunity.id, contactId: opportunity.contactId, title: opportunity.title })
    .from(opportunity)
    .where(eq(opportunity.organizationId, "org_a"))
    .limit(1)
  if (!opp) throw new Error("Falta la oportunidad de prueba")
  const [task] = await ownerDb
    .insert(crmTask)
    .values({
      organizationId: "org_a",
      title: "Retomar caso contextual",
      contactId: opp.contactId,
      opportunityId: opp.id,
      assigneeUserId: recipient,
      dueAt: new Date(Date.now() - 60_000),
      createdBy: "user",
    })
    .returning({ id: crmTask.id })
  const authorized = await withOrgContext(appDb, "org_a", tx =>
    getWorkspaceHome(tx, "org_a", recipient, full),
  )
  // La página de la oportunidad no lista tareas: la fila abre Tareas y dice de qué oportunidad sale.
  expect(rowsOf(authorized.waiting, "task").find((item) => item.id === task!.id)).toMatchObject({
    href: `/tasks?task=${task!.id}`,
    due: "overdue",
    mine: true,
    opportunityTitle: opp.title,
  })
  const tasksOnly = await withOrgContext(appDb, "org_a", tx =>
    getWorkspaceHome(tx, "org_a", recipient, { ...restricted, tasks: true }),
  )
  const row = rowsOf(tasksOnly.waiting, "task").find((item) => item.id === task!.id)
  expect(row).toMatchObject({ href: `/tasks?task=${task!.id}`, opportunityTitle: null })
  // Solo con tareas, la lista no trae nada de otros dominios.
  expect(tasksOnly.waiting.every((row) => row.kind === "task" || (row.kind === "more" && row.of === "tasks"))).toBe(true)
  // La tarea vencida está en «Te espera»: la campana no la repite.
  const notices = await withOrgContext(appDb, "org_a", tx =>
    listWorkspaceNotifications(tx, "org_a", recipient, ["tasks.read", "crm.read"]),
  )
  expect(notices.items.find((item) => item.body === "Retomar caso contextual" || item.title === "Tarea vencida")).toBeUndefined()
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

it("la actividad del equipo se dice con palabras, dice quién fue y se acota por área", async () => {
  await ownerDb.execute(sql`insert into audit_event (organization_id, actor_user_id, action, entity, metadata, created_at) values
    ('org_a', ${recipient}, 'appointment.created', 'appointment', null, '2026-09-29 10:00:00+00'),
    ('org_a', null, 'appointment.status_confirmada', 'appointment', null, '2026-09-29 10:00:30+00'),
    ('org_a', null, 'portal.appointment_confirmed', 'appointment', null, '2026-09-29 10:01:00+00'),
    ('org_a', null, 'contact.updated', 'contact', '{"origin":"agent"}'::jsonb, '2026-09-29 10:02:00+00'),
    ('org_a', null, 'tema_nuevo.sin_frase', 'x', null, '2026-09-29 10:03:00+00')`)
  const list = (input: Parameters<typeof listWorkspaceAudit>[2]) =>
    withOrgContext(appDb, "org_a", tx => listWorkspaceAudit(tx, "org_a", input))

  const agenda = await list({ area: "agenda" })
  expect(agenda.items.every(item => item.area === "agenda")).toBe(true)
  // Con una persona del equipo, su nombre; sin ella no se supone a nadie.
  expect(agenda.items.find(item => item.action === "appointment.created")).toMatchObject({
    what: "Reservó una cita", who: "Persona de prueba", areaLabel: "Agenda",
  })
  expect(agenda.items.find(item => item.action === "appointment.status_confirmada")).toMatchObject({
    what: "Confirmó una cita", who: "Automático",
  })
  // Lo que hace el paciente es suyo por naturaleza; lo del agente, solo si el registro lo dice.
  expect((await list({ area: "portal" })).items.find(item => item.action === "portal.appointment_confirmed")).toMatchObject({
    what: "Confirmó su cita desde el portal", who: "El paciente o su contacto",
  })
  expect((await list({ area: "ventas" })).items.find(item => item.action === "contact.updated")).toMatchObject({
    what: "Cambió los datos de un contacto", who: "El agente",
  })
  // Un registro sin frase propia se dice de forma general: el código nunca es el texto.
  const [unknown] = (await list({ action: "tema_nuevo.sin_frase" })).items
  expect(unknown).toMatchObject({ what: "Hizo un cambio", who: "Automático", area: "otros", areaLabel: "Otros" })
  await expect(list({ area: "inexistente" as never })).rejects.toMatchObject({ status: 400 })
})

it("«Te espera» trae los casos que pasó el agente, «Ahora» primero; las citas que esperan al paciente no esperan al equipo", async () => {
  const home = await withOrgContext(appDb, "org_a", tx => getWorkspaceHome(tx, "org_a", recipient, full))
  const agentRows = rowsOf(home.waiting, "case")
  // El caso «Ahora» va primero; el caso sin apuro, aunque sea antiguo, sigue esperando y va después.
  expect(agentRows.map(row => row.reason)).toEqual(["Reciente", "Antigua"])
  // Hay dos citas pendientes del sí del paciente: ninguna es una fila para aprobar.
  expect(home.waiting.map(row => row.kind as string)).not.toContain("proposal")
  expect(rowsOf(home.waiting, "case").map(row => row.priority)).toEqual(["alta", "baja"])
  // Las cifras de corridas del agente ya no viajan a Inicio.
  expect(home).not.toHaveProperty("agent")
})

it("el libro de corridas cuenta las que terminaron sin responder y las llamadas medidas", async () => {
  const stats = await withOrgContext(appDb, "org_a", tx => getAgentRunStats(tx, "org_a"))
  expect(stats.byStatus).toMatchObject({ ok: 2, handoff: 1, error: 1, sin_respuesta: 1 })
  // Solo una fila registró llamadas: el total no se reparte entre las cinco.
  expect(stats.totalLlmCalls).toBe(2)
  expect(stats.runsWithLlmCalls).toBe(1)
  const unanswered = await withOrgContext(appDb, "org_a", tx => listAgentRuns(tx, "org_a", { status: "sin_respuesta" }))
  expect(unanswered).toHaveLength(1)
  expect(unanswered[0]).toMatchObject({ status: "sin_respuesta", llmCalls: 2, cachedInputTokens: null })
})

it("sin permiso del agente, «Te espera» no trae casos", async () => {
  const home = await withOrgContext(appDb, "org_a", tx => getWorkspaceHome(tx, "org_a", recipient, { ...full, agent: false }))
  expect(home.waiting.filter(row => row.kind === "case" || (row.kind === "more" && row.of === "cases"))).toEqual([])
})

it("la primera respuesta usa aceptación real y excluye colas, fallos y simulación", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `metricas-${orgId}`)
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
  // Reportes › Agente: respondieron la enviada y la antigua sin hora de envío; la mediana solo mide la que tiene hora
  // (con la antigua contada desde que se creó saldría 20 s, no 30).
  const report = await withOrgContext(appDb, orgId, tx => getReportAgent(tx, orgId, { period: "2026-09" }))
  expect(report.responses.current).toEqual({ conversations: 5, responded: 2, byAgent: 0, byTeam: 2, agentMedianSeconds: null, teamMedianSeconds: 30 })
  const home = await withOrgContext(appDb, orgId, tx => getWorkspaceHome(tx, orgId, recipient, full))
  // Una sola fila: cuántas esperan y desde cuándo la más antigua; la misma cuenta que «Sin responder» de la Bandeja.
  expect(rowsOf(home.waiting, "conversations")).toEqual([{ kind: "conversations", waiting: 3, oldestAt: inboundAt.toISOString() }])
  // Con el agente atendiendo, esperan respuesta pero no piden a una persona: van en «Las atiende el agente».
  const inbox = await withOrgContext(appDb, orgId, tx => countConversationViews(tx, orgId, { status: "open" }, ["attend", "agent"]))
  expect(inbox.attend + inbox.agent).toBeGreaterThanOrEqual(3)
})

/** Si faltan o pasaron menos de 5 minutos de la medianoche de Lima, espera a que el día quede lejos. */
async function outsideLimaMidnight(): Promise<void> {
  const [hour, minute] = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date()).split(":").map(Number)
  const sinceMidnight = hour! * 60 + minute!
  const waitMinutes = sinceMidnight >= 24 * 60 - 5 ? 24 * 60 - sinceMidnight + 5 : sinceMidnight < 5 ? 5 - sinceMidnight : 0
  if (waitMinutes > 0) await new Promise((resolve) => setTimeout(resolve, waitMinutes * 60_000))
}

it("«Hoy»: la sede ve su agenda y quien atiende solo sus citas, con el resumen del día", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `hoy-${orgId.slice(0, 8)}`)
  const [ana, luis] = [randomUUID(), randomUUID()]
  await ownerDb.insert(user).values([
    { id: ana, name: "Dra. Ana Torres", email: `${ana}@hoy.test`, emailVerified: true },
    { id: luis, name: "Dr. Luis Vega", email: `${luis}@hoy.test`, emailVerified: true },
  ])
  const [centro] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: "America/Lima", createdAt: new Date(Date.now() - 60_000) }).returning({ id: branch.id })
  const [norte] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Norte", timezone: "America/Lima" }).returning({ id: branch.id })
  const [chairCentro] = await ownerDb.insert(scheduleChair).values({ organizationId: orgId, branchId: centro!.id, name: "Unidad dental 1" }).returning({ id: scheduleChair.id })
  const [chairNorte] = await ownerDb.insert(scheduleChair).values({ organizationId: orgId, branchId: norte!.id, name: "Unidad dental 2" }).returning({ id: scheduleChair.id })
  // Horas a minutos del reloj, dentro del mismo día de la sede: lo atendido ya pasó y
  // lo pendiente viene enseguida. Con horas fijas, una corrida al final del día de Lima
  // veía terminada la cita que debía ser «la siguiente».
  await outsideLimaMidnight()
  const visit = async (name: string, minutesFromNow: number, status: string, dentistUserId: string, where: "centro" | "norte") => {
    const [person] = await insertTestPatients(ownerDb, { organizationId: orgId, displayName: name, patientNumber: Math.floor(Math.random() * 1_000_000) })
    const startsAt = new Date(Math.floor(Date.now() / 60_000) * 60_000 + minutesFromNow * 60_000)
    await ownerDb.insert(appointment).values({
      organizationId: orgId, patientId: person!.id, dentistUserId, status, serviceName: "Control",
      branchId: where === "centro" ? centro!.id : norte!.id, chairId: where === "centro" ? chairCentro!.id : chairNorte!.id,
      startsAt, endsAt: new Date(startsAt.getTime() + 60_000), durationMin: 1,
    })
  }
  await visit("Atendida de Ana", -3, "atendida", ana, "centro")
  await visit("No asistió", -2, "no_asistio", luis, "centro")
  await visit("Cancelada", -1, "cancelada", luis, "centro")
  await visit("Confirmada de Luis", 2, "confirmada", luis, "centro")
  await visit("Sin confirmar de Ana", 3, "programada", ana, "centro")
  await visit("Ana en Norte", 1, "confirmada", ana, "norte")

  const reception: WorkspaceAccess = { ...restricted, appointments: true }
  const home = (access: WorkspaceAccess, userId: string, branchId?: string) =>
    withOrgContext(appDb, orgId, tx => getWorkspaceHome(tx, orgId, userId, access, { branchId }))

  // Sin sede pedida vale la primera activa; lo cancelado y lo no asistido no ocupan la agenda.
  const first = await home(reception, recipient)
  expect(first.multiBranch).toBe(true)
  expect(first.today).toMatchObject({ scope: "branch", branch: { id: centro!.id, name: "Centro" }, summary: { total: 3, attended: 1, upcoming: 2, unconfirmed: 1 } })
  // La sede recibe lo que falta, desde la siguiente, y al final quien no vino (para reagendar);
  // lo atendido queda en el resumen.
  expect(first.today!.appointments.map(row => [row.patientName, row.visit, row.next])).toEqual([
    ["Confirmada de Luis", "confirmada", true],
    ["Sin confirmar de Ana", "por_confirmar", false],
    ["No asistió", "no_vino", false],
  ])
  expect(first.today!.appointments[0]).toMatchObject({ dentistName: "Dr. Luis Vega", chairName: "Unidad dental 1", serviceName: "Control" })

  // La sede pedida filtra; una que no existe cae en la primera, sin mezclar sedes.
  const other = await home(reception, recipient, norte!.id)
  expect(other.today).toMatchObject({ branch: { id: norte!.id }, summary: { total: 1, attended: 0, upcoming: 1, unconfirmed: 0 } })
  expect(other.today!.appointments.map(row => row.patientName)).toEqual(["Ana en Norte"])
  expect((await home(reception, recipient, randomUUID())).today!.branch).toEqual({ id: centro!.id, name: "Centro" })

  // Quien atiende: solo sus citas, de todas las sedes; lo que falta primero y lo atendido al final.
  const dentist = await home({ ...reception, ownAppointments: true }, ana, norte!.id)
  expect(dentist.today).toMatchObject({ scope: "mine", branch: null, summary: { total: 3, attended: 1, upcoming: 2, unconfirmed: 1 } })
  expect(dentist.today!.appointments.map(row => [row.patientName, row.branchName, row.next])).toEqual([
    ["Ana en Norte", "Norte", true],
    ["Sin confirmar de Ana", "Centro", false],
    ["Atendida de Ana", "Centro", false],
  ])
  expect(dentist.agendaLine).toBeNull()
  expect(dentist.today!.appointments.some(row => row.dentistName === "Dr. Luis Vega")).toBe(false)

  // Un rol sin agenda ni caja no recibe citas, caja ni filas de otros.
  const bare = await home(restricted, recipient)
  expect(bare).toMatchObject({ today: null, cash: null, waiting: [] })
}, 11 * 60_000)

it("los presupuestos que esperan respuesta: quien atiende solo ve los de sus planes y recepción ninguno", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `presupuestos-${orgId.slice(0, 8)}`)
  const [ana, luis] = [randomUUID(), randomUUID()]
  await ownerDb.insert(user).values([ana, luis].map(id => ({ id, name: "Profesional", email: `${id}@presupuestos.test`, emailVerified: true })))
  const [person] = await insertTestPatients(ownerDb, { organizationId: orgId, displayName: "Paciente con presupuesto", patientNumber: 1 })
  const presentedAt = new Date(Date.now() - 9 * 86_400_000)
  for (const [index, createdBy] of [ana, luis].entries()) {
    const [plan] = await ownerDb.insert(treatmentPlan).values({ organizationId: orgId, patientId: person!.id, title: "Plan", createdBy }).returning({ id: treatmentPlan.id })
    // Lo propio del odontólogo es lo que preparó o indicó (ADR 0034), no el plan donde quedó.
    await ownerDb.insert(treatmentBudget).values([
      { organizationId: orgId, patientId: person!.id, planId: plan!.id, budgetNumber: index * 10 + 1, title: "Presentado", currency: "PEN", status: "presentado", presentedAt: index === 0 ? presentedAt : new Date(), createdBy },
      { organizationId: orgId, patientId: person!.id, planId: plan!.id, budgetNumber: index * 10 + 2, title: "Aceptado", currency: "PEN", status: "aceptado", presentedAt, createdBy },
    ])
  }
  const budgets = async (access: WorkspaceAccess, userId: string) =>
    rowsOf((await withOrgContext(appDb, orgId, tx => getWorkspaceHome(tx, orgId, userId, access))).waiting, "budgets")
  const cashier = await budgets({ ...restricted, finance: true }, recipient)
  expect(cashier).toHaveLength(1)
  expect(cashier[0]).toMatchObject({ total: 2, oldestPresentedAt: presentedAt.toISOString() })
  expect(cashier[0]!.items.map(item => item.title)).toEqual(["Presentado", "Presentado"])
  const dentist = await budgets({ ...restricted, clinical: true, ownAppointments: true }, luis)
  expect(dentist[0]).toMatchObject({ total: 1 })
  expect(await budgets({ ...restricted, appointments: true, conversations: true, tasks: true, crm: true, agent: true }, recipient)).toEqual([])
})

it("las tareas de otra persona no llegan a quien no dirige", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `tareas-${orgId.slice(0, 8)}`)
  const endOfDay = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())}T23:59:30-05:00`)
  await ownerDb.insert(crmTask).values([
    { organizationId: orgId, title: "Mía vencida", assigneeUserId: recipient, dueAt: new Date(Date.now() - 86_400_000), createdBy: "user" },
    { organizationId: orgId, title: "Mía de hoy", assigneeUserId: recipient, dueAt: endOfDay, createdBy: "user" },
    { organizationId: orgId, title: "Mía sin fecha", assigneeUserId: recipient, createdBy: "user" },
    { organizationId: orgId, title: "De otra persona", assigneeUserId: colleague, dueAt: new Date(Date.now() - 3_600_000), createdBy: "user" },
  ])
  const tasks = async (access: WorkspaceAccess) =>
    rowsOf((await withOrgContext(appDb, orgId, tx => getWorkspaceHome(tx, orgId, recipient, access))).waiting, "task")
  // Vencida primero; después la siguiente (la de hoy) con el resto resumido.
  expect((await tasks({ ...restricted, tasks: true })).map(row => [row.title, row.due, row.more])).toEqual([
    ["Mía vencida", "overdue", 0],
    ["Mía de hoy", "today", 1],
  ])
  // Quien dirige ve también las del equipo, con su responsable.
  const team = await tasks({ ...restricted, tasks: true, allTasks: true })
  expect(team.map(row => [row.title, row.mine])).toEqual([["Mía vencida", true], ["De otra persona", false], ["Mía de hoy", true]])
  expect(team.find(row => row.title === "De otra persona")?.assigneeName).toBe("Persona de prueba")
  expect(team.at(-1)?.more).toBe(1)
  // Lo que el Administrador deja a un área, sin responsable, llega a quien trabaja en ella y a nadie más.
  await ownerDb.insert(crmTask).values({
    organizationId: orgId, title: "Llamar por un saldo", dueAt: new Date(Date.now() - 7_200_000), createdBy: "admin", area: "caja", reason: "Saldo vencido",
  })
  expect((await tasks({ ...restricted, tasks: true, taskAreas: ["caja"] })).map(row => [row.title, row.mine])).toEqual([
    ["Mía vencida", true], ["Llamar por un saldo", false], ["Mía de hoy", true],
  ])
  expect((await tasks({ ...restricted, tasks: true, taskAreas: ["recepcion"] })).map(row => row.title)).toEqual(["Mía vencida", "Mía de hoy"])
})

it("la producción clínica excluye los actos anulados", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `produccion-${orgId.slice(0, 8)}`)
  const dentist = randomUUID()
  await ownerDb.insert(user).values({ id: dentist, name: "Dentista fase cero", email: `${dentist}@fase0.test`, emailVerified: true })
  const [account] = await insertTestPatients(ownerDb, { organizationId: orgId, displayName: "Paciente producción", patientNumber: 1 })
  // Ciclo real: borrador → actos (+ anulación en borrador) → cierre con firma.
  // Insertar actos en una atención ya finalizada viola encounter_child_draft_only.
  const [visit] = await ownerDb.insert(encounter).values({ organizationId: orgId, patientId: account!.id, dentistUserId: dentist }).returning({ id: encounter.id })
  const procedures = await ownerDb.insert(encounterProcedure).values([
    { organizationId: orgId, encounterId: visit!.id, description: "Resina vigente", priceCents: 30000, currency: "PEN" },
    { organizationId: orgId, encounterId: visit!.id, description: "Acto duplicado", priceCents: 99999, currency: "PEN" },
  ]).returning({ id: encounterProcedure.id, description: encounterProcedure.description })
  const anulado = procedures.find(procedure => procedure.description === "Acto duplicado")
  await ownerDb.update(encounterProcedure).set({ voidedAt: new Date(), voidReason: "Registro duplicado" }).where(eq(encounterProcedure.id, anulado!.id))
  await ownerDb.update(encounter).set({ status: "finalizada", finalizedAt: new Date(), finalizedBy: dentist, signerName: "Dentista fase cero", signerRegistration: "12345" }).where(eq(encounter.id, visit!.id))
  // Reportes › Finanzas › Comisiones: lo atendido es solo el acto vigente.
  const report = await withOrgContext(appDb, orgId, tx => getReportCommissions(tx, orgId, { period: "este_mes" }))
  expect(report.rows).toEqual([expect.objectContaining({ userId: dentist, attendedCents: 30000, unpaidCents: 30000 })])
})

it("un caso del agente sale una sola vez: ni su tarea ni su conversación se repiten, la campana no lo anuncia y el contador cuenta lo de cada quien", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `caso-${orgId.slice(0, 8)}`)
  const [rita, tomas] = [randomUUID(), randomUUID()]
  await ownerDb.insert(user).values([rita, tomas].map(id => ({ id, name: `Recepción ${id.slice(0, 4)}`, email: `${id}@caso.test`, emailVerified: true })))
  await ownerDb.insert(member).values([rita, tomas].map(id => ({ id: randomUUID(), organizationId: orgId, userId: id, role: "reception", createdAt: new Date() })))
  const [connection] = await ownerDb.insert(channelConnection).values({
    organizationId: orgId, channel: "whatsapp", provider: "prueba", displayName: "Canal", configEncrypted: "x", webhookSecret: "y",
  }).returning({ id: channelConnection.id })
  const thread = async (name: string) => {
    const [person] = await ownerDb.insert(contact).values({ organizationId: orgId, displayName: name }).returning({ id: contact.id })
    const [row] = await ownerDb.insert(conversation).values({
      organizationId: orgId, contactId: person!.id, channelConnectionId: connection!.id, externalThreadId: `t:${randomUUID()}`, status: "open",
    }).returning({ id: conversation.id })
    await ownerDb.insert(message).values({
      organizationId: orgId, conversationId: row!.id, direction: "in", senderKind: "contact", body: "Hola", status: "received",
      externalId: `ext-${randomUUID()}`, createdAt: new Date(Date.now() - 3_600_000),
    })
    return row!.id
  }
  const lucia = await thread("Lucía Paredes")
  await thread("Jorge Ramos")
  const handoff = await withOrgContext(appDb, orgId, tx => createHandoff(tx, orgId, null, {
    conversationId: lucia, reason: "Pregunta por un reembolso", summary: "Pide su dinero", priority: "alta", createdBy: "agent",
  }))
  // La tarea del caso lleva el nombre de siempre, sin la prioridad en código.
  const [caseTask] = await ownerDb.select().from(crmTask).where(eq(crmTask.id, handoff.taskId!))
  expect(caseTask?.title).toBe("Te lo pasó el agente: Pregunta por un reembolso")
  const access: WorkspaceAccess = { ...full, appointments: false, finance: false, clinical: false, configure: false }
  const home = await withOrgContext(appDb, orgId, tx => getWorkspaceHome(tx, orgId, rita, access))
  expect(rowsOf(home.waiting, "case")).toMatchObject([{ id: handoff.id, reason: "Pregunta por un reembolso", unclaimed: true }])
  expect(rowsOf(home.waiting, "task").map(row => row.id)).not.toContain(handoff.taskId)
  // Lucía ya es su propia fila: solo Jorge espera respuesta.
  expect(rowsOf(home.waiting, "conversations")).toMatchObject([{ waiting: 1 }])
  // Sin acceso a los casos (odontología), su conversación sí cuenta: es la única fila que la muestra.
  const noAgent = await withOrgContext(appDb, orgId, tx => getWorkspaceHome(tx, orgId, rita, { ...access, agent: false }))
  expect(rowsOf(noAgent.waiting, "conversations")).toMatchObject([{ waiting: 2 }])
  // La campana no repite el caso.
  const notices = await withOrgContext(appDb, orgId, tx => listWorkspaceNotifications(tx, orgId, rita, ["tasks.read", "conversations.read", "agent.decide"]))
  expect(notices.items).toEqual([])
  // Un solo contador: lo que nadie tomó más lo tuyo; lo que tomó otra persona no te espera.
  expect(await withOrgContext(appDb, orgId, tx => countOpenHandoffs(tx, orgId, { forUserId: rita }))).toBe(1)
  await withOrgContext(appDb, orgId, tx => claimHandoff(tx, orgId, tomas, handoff.id))
  expect(await withOrgContext(appDb, orgId, tx => countOpenHandoffs(tx, orgId, { forUserId: rita }))).toBe(0)
  expect((await withOrgContext(appDb, orgId, tx => getAgentPanelSummary(tx, orgId, tomas))).openHandoffs).toBe(1)
  expect(rowsOf((await withOrgContext(appDb, orgId, tx => getWorkspaceHome(tx, orgId, tomas, { ...access, allTasks: false }))).waiting, "case"))
    .toMatchObject([{ id: handoff.id, unclaimed: false }])
})

it("la campana: nadie recibe aviso de lo suyo, «Marcar todo leído» y cada aviso llega con el permiso que declara", async () => {
  const notice = (dedupeKey: string, permission: string, extra: { actorUserId?: string } = {}) =>
    withOrgContext(appDb, "org_a", tx => createWorkspaceNotification(tx, "org_a", {
      userId: colleague, dedupeKey, title: `Aviso ${dedupeKey}`, body: "", href: "/home", permission, ...extra,
    }))
  await notice("propio", "crm.read", { actorUserId: colleague })
  await notice("de-otra-persona", "crm.read", { actorUserId: recipient })
  await notice("plantilla", "settings.write")
  await notice("comision", "commissions.read")
  const list = (permissions: string[]) => withOrgContext(appDb, "org_a", tx => listWorkspaceNotifications(tx, "org_a", colleague, permissions))
  const titles = async (permissions: string[]) => (await list(permissions)).items.map(item => item.title).sort()
  expect(await titles(["crm.read", "settings.write", "commissions.read"])).toEqual(["Aviso comision", "Aviso de-otra-persona", "Aviso plantilla"])
  // Sin el permiso que declara, no se ve.
  expect(await titles(["crm.read"])).toEqual(["Aviso de-otra-persona"])
  const all = ["crm.read", "settings.write", "commissions.read"]
  expect((await list(all)).unread).toBe(3)
  // «Marcar todo leído» solo marca lo que quien mira puede ver.
  expect(await withOrgContext(appDb, "org_a", tx => readAllWorkspaceNotifications(tx, "org_a", colleague, ["crm.read", "settings.write"]))).toEqual({ read: 2 })
  expect((await list(all)).unread).toBe(1)
  expect(await withOrgContext(appDb, "org_a", tx => readAllWorkspaceNotifications(tx, "org_a", colleague, all))).toEqual({ read: 1 })
  expect((await list(all)).unread).toBe(0)
})

it("un aviso se retira solo cuando su asunto se resuelve y vuelve a llegar si el asunto vuelve", async () => {
  const [item] = await ownerDb.insert(product).values({ organizationId: "org_a", sku: `G-${randomUUID().slice(0, 6)}`, name: "Guantes", minStock: 5 }).returning()
  const lowStock = () => withOrgContext(appDb, "org_a", tx => createWorkspaceNotification(tx, "org_a", {
    userId: recipient, dedupeKey: `inventory:low-stock:${item!.id}`, title: "Stock bajo: Guantes", body: "", href: "/inventory",
    permission: "inventory.read", subject: `producto:${item!.id}`,
  }))
  const shown = async () => (await withOrgContext(appDb, "org_a", tx => listWorkspaceNotifications(tx, "org_a", recipient, ["inventory.read", "agent.write"])))
    .items.map(row => row.title)
  await lowStock()
  expect(await shown()).toContain("Stock bajo: Guantes")
  // Se repone (ya no está bajo el mínimo): el aviso se retira solo, aunque nadie lo leyera.
  await ownerDb.update(product).set({ minStock: 0 }).where(eq(product.id, item!.id))
  await withOrgContext(appDb, "org_a", tx => settleWorkspaceNotifications(tx, "org_a", { subject: `producto:${item!.id}` }))
  expect(await shown()).not.toContain("Stock bajo: Guantes")
  // Vuelve a bajar: con la misma clave, avisa otra vez y sin leer.
  await ownerDb.update(product).set({ minStock: 5 }).where(eq(product.id, item!.id))
  await lowStock()
  const again = await withOrgContext(appDb, "org_a", tx => listWorkspaceNotifications(tx, "org_a", recipient, ["inventory.read"]))
  expect(again.items.find(row => row.title === "Stock bajo: Guantes")?.readAt).toBeNull()
  // El modelo del agente: se retira cuando el agente vuelve a responder.
  await withOrgContext(appDb, "org_a", tx => createWorkspaceNotification(tx, "org_a", {
    userId: recipient, dedupeKey: "agent-provider:prueba", title: "El agente no puede usar el modelo", body: "", href: "/settings/agent",
    permission: "agent.write", subject: "modelo-del-agente",
  }))
  expect(await shown()).toContain("El agente no puede usar el modelo")
  await ownerDb.insert(agentRunLedger).values({ organizationId: "org_a", model: "prueba", status: "ok", startedAt: new Date(Date.now() + 1_000) })
  expect(await shown()).not.toContain("El agente no puede usar el modelo")
  // Un asunto que no tiene regla no se acepta: el aviso no podría retirarse nunca.
  await expect(withOrgContext(appDb, "org_a", tx => createWorkspaceNotification(tx, "org_a", {
    userId: recipient, dedupeKey: "rareza", title: "Raro", body: "", href: "/home", permission: "tasks.read", subject: "otra-cosa:1",
  }))).rejects.toMatchObject({ status: 400 })
})

it("una cita sin confirmar tras el primer recordatorio del agente aparece para llamar, con su teléfono, a quien ve la agenda", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `llamar-${orgId.slice(0, 8)}`)
  const dentist = randomUUID()
  await ownerDb.insert(user).values({ id: dentist, name: "Dra. Ruiz", email: `${dentist}@llamar.test`, emailVerified: true })
  const [centro] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro", timezone: "America/Lima" }).returning({ id: branch.id })
  const [chair] = await ownerDb.insert(scheduleChair).values({ organizationId: orgId, branchId: centro!.id, name: "Unidad dental 2" }).returning({ id: scheduleChair.id })
  const visit = async (name: string, status: string, reminder: "enviado" | "pendiente" | null, hours = 20) => {
    const [person] = await insertTestPatients(ownerDb, { organizationId: orgId, displayName: name, patientNumber: Math.floor(Math.random() * 1_000_000), phone: "+51987654100" })
    const startsAt = new Date(Date.now() + hours * 3_600_000)
    const [row] = await ownerDb.insert(appointment).values({
      organizationId: orgId, patientId: person!.id, dentistUserId: dentist, status, serviceName: "Evaluación",
      branchId: centro!.id, chairId: chair!.id, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), durationMin: 30,
    }).returning({ id: appointment.id })
    if (reminder) {
      await ownerDb.insert(automationJob).values({
        organizationId: orgId, kind: "recordatorio_cita", status: reminder, dedupeKey: `recordatorio_cita:${row!.id}:24`,
        scheduledFor: new Date(), appointmentId: row!.id, patientId: person!.id,
      })
    }
    return row!.id
  }
  const rosa = await visit("Rosa Quispe", "programada", "enviado")
  await visit("Ya confirmó", "confirmada", "enviado", 22)
  await visit("Aún sin recordatorio", "programada", "pendiente", 24)
  await visit("Sin la línea", "programada", null, 26)
  await visit("Ya pasó", "programada", "enviado", -2)
  const reception: WorkspaceAccess = { ...restricted, appointments: true }
  const home = await withOrgContext(appDb, orgId, tx => getWorkspaceHome(tx, orgId, randomUUID(), reception))
  expect(rowsOf(home.waiting, "unconfirmed")).toMatchObject([
    { id: rosa, patientName: "Rosa Quispe", phone: "+51987654100", branchName: "Centro", serviceName: "Evaluación" },
  ])
  // Quien atiende no llama: no le llega.
  const own = await withOrgContext(appDb, orgId, tx => getWorkspaceHome(tx, orgId, dentist, { ...reception, ownAppointments: true }))
  expect(rowsOf(own.waiting, "unconfirmed")).toEqual([])
  // Confirmada, deja de esperar.
  await ownerDb.update(appointment).set({ status: "confirmada" }).where(eq(appointment.id, rosa))
  expect(rowsOf((await withOrgContext(appDb, orgId, tx => getWorkspaceHome(tx, orgId, randomUUID(), reception))).waiting, "unconfirmed")).toEqual([])
})

it("la puesta en marcha trae encender Recepción y el Administrador, solo a quien puede encenderlos", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `puesta-${orgId.slice(0, 8)}`)
  const access: WorkspaceAccess = { ...full, appointments: false, finance: false, clinical: false, configure: true }
  const setupOf = (can: (permission: string) => boolean) =>
    withOrgContext(appDb, orgId, (tx) => getWorkspaceHome(tx, orgId, recipient, access, { can })).then((home) => home.setup)
  expect(await setupOf(() => true)).toMatchObject({ agent: false })
  // Sin poder encenderlos, el paso no viaja.
  expect(await setupOf((permission) => permission !== "agent.write")).not.toHaveProperty("agent")
  // Solo con los dos encendidos queda hecho.
  await ownerDb.insert(agentConfig).values({ organizationId: orgId, enabled: true, advisor: { enabled: false } })
  expect(await setupOf(() => true)).toMatchObject({ agent: false })
  await ownerDb.update(agentConfig).set({ advisor: { enabled: true } }).where(eq(agentConfig.organizationId, orgId))
  expect(await setupOf(() => true)).toMatchObject({ agent: true })
})
