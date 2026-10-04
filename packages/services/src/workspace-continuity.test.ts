import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { agentHandoff } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { clinicalFollowUp, encounter, patient } from "@odentia/db/schema/clinical"
import { crmTask } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { getManagementReport, type WorkspaceAccess } from "./workspace.js"

setupTestDb()

const full: WorkspaceAccess = {
  patients: true,
  appointments: true,
  conversations: true,
  tasks: true,
  finance: true,
  clinical: true,
  crm: true,
  agent: true,
  allTasks: true,
}

it("mide continuidad por caso sin inflar reaperturas, cancelaciones ni históricos desconocidos", async () => {
  const orgId = randomUUID()
  const userId = randomUUID()
  await insertOrg(ownerDb, orgId, `continuidad-${orgId}`)
  await ownerDb
    .insert(user)
    .values({
      id: userId,
      name: "Responsable",
      email: `${userId}@continuidad.test`,
      emailVerified: true,
    })
  await ownerDb
    .insert(member)
    .values({
      id: randomUUID(),
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: new Date("2026-09-01T10:00:00Z"),
    })
  const [person] = await ownerDb
    .insert(patient)
    .values({ organizationId: orgId, displayName: "Paciente continuidad", patientNumber: 1 })
    .returning()
  if (!person) throw new Error("No se creó el paciente")
  const [visit] = await ownerDb
    .insert(encounter)
    .values({
      organizationId: orgId,
      patientId: person.id,
      dentistUserId: userId,
      status: "finalizada",
      finalizedAt: new Date("2026-09-10T14:00:00Z"),
      finalizedBy: userId,
      createdAt: new Date("2026-09-10T13:00:00Z"),
      updatedAt: new Date("2026-09-10T14:00:00Z"),
    })
    .returning()
  if (!visit) throw new Error("No se creó la atención")
  const dueAt = new Date("2026-09-10T15:00:00Z")
  const createdAt = new Date("2026-09-01T10:00:00Z")
  await ownerDb.insert(clinicalFollowUp).values([
    {
      organizationId: orgId,
      patientId: person.id,
      kind: "mantenimiento",
      title: "Control realizado",
      dueAt,
      status: "realizado",
      completedEncounterId: visit.id,
      completedAt: new Date("2026-09-10T14:00:00Z"),
      outcome: "Sin hallazgos",
      createdAt,
      updatedAt: new Date("2026-09-10T14:00:00Z"),
    },
    {
      organizationId: orgId,
      patientId: person.id,
      kind: "mantenimiento",
      title: "Control cancelado",
      dueAt,
      status: "cancelado",
      cancelledAt: new Date("2026-09-09T14:00:00Z"),
      cancelledReason: "Ya no aplica",
      createdAt,
      updatedAt: new Date("2026-09-09T14:00:00Z"),
    },
    {
      organizationId: orgId,
      patientId: person.id,
      kind: "mantenimiento",
      title: "Control pendiente",
      dueAt,
      status: "pendiente",
      createdAt,
      updatedAt: createdAt,
    },
    {
      organizationId: orgId,
      patientId: person.id,
      kind: "mantenimiento",
      title: "Histórico incompleto",
      dueAt,
      status: "realizado",
      createdAt,
      updatedAt: createdAt,
    },
  ])
  const taskRows = await ownerDb
    .insert(crmTask)
    .values([
      {
        organizationId: orgId,
        title: "En plazo",
        dueAt,
        status: "done",
        createdBy: "user",
        createdAt,
        updatedAt: new Date("2026-09-10T14:00:00Z"),
      },
      {
        organizationId: orgId,
        title: "Reabierta y resuelta tarde",
        dueAt,
        status: "done",
        createdBy: "user",
        createdAt,
        updatedAt: new Date("2026-09-10T17:00:00Z"),
      },
      {
        organizationId: orgId,
        title: "Cancelada",
        dueAt,
        status: "cancelled",
        createdBy: "user",
        createdAt,
        updatedAt: new Date("2026-09-09T12:00:00Z"),
      },
      {
        organizationId: orgId,
        title: "Abierta",
        dueAt,
        status: "open",
        createdBy: "user",
        createdAt,
        updatedAt: createdAt,
      },
      {
        organizationId: orgId,
        title: "Sin evidencia",
        dueAt,
        status: "done",
        createdBy: "user",
        createdAt,
        updatedAt: new Date("2026-09-10T14:00:00Z"),
      },
    ])
    .returning()
  const [onTime, reopened, cancelled, open] = taskRows
  if (!onTime || !reopened || !cancelled || !open) throw new Error("No se crearon las tareas")
  await ownerDb.insert(auditEvent).values([
    {
      organizationId: orgId,
      action: "task.updated",
      entity: "task",
      entityId: onTime.id,
      metadata: { statusPrev: "open", statusNext: "done" },
      createdAt: new Date("2026-09-10T14:00:00Z"),
    },
    {
      organizationId: orgId,
      action: "task.updated",
      entity: "task",
      entityId: reopened.id,
      metadata: { statusPrev: "open", statusNext: "done" },
      createdAt: new Date("2026-09-10T14:00:00Z"),
    },
    {
      organizationId: orgId,
      action: "task.updated",
      entity: "task",
      entityId: reopened.id,
      metadata: { statusPrev: "done", statusNext: "open" },
      createdAt: new Date("2026-09-10T16:00:00Z"),
    },
    {
      organizationId: orgId,
      action: "task.updated",
      entity: "task",
      entityId: reopened.id,
      metadata: { statusPrev: "open", statusNext: "done" },
      createdAt: new Date("2026-09-10T17:00:00Z"),
    },
    {
      organizationId: orgId,
      action: "task.updated",
      entity: "task",
      entityId: cancelled.id,
      metadata: { statusPrev: "open", statusNext: "cancelled" },
      createdAt: new Date("2026-09-09T12:00:00Z"),
    },
  ])
  const handoffs = await ownerDb
    .insert(agentHandoff)
    .values([
      {
        organizationId: orgId,
        reason: "Resuelta",
        summary: "Caso resuelto",
        priority: "media",
        taskId: onTime.id,
        assigneeUserId: userId,
        createdAt,
      },
      {
        organizationId: orgId,
        reason: "Recogida",
        summary: "Caso abierto",
        priority: "media",
        taskId: open.id,
        createdAt,
      },
      {
        organizationId: orgId,
        reason: "Cancelada",
        summary: "Caso cancelado",
        priority: "baja",
        taskId: cancelled.id,
        createdAt,
      },
      {
        organizationId: orgId,
        reason: "Histórica",
        summary: "Sin tarea",
        priority: "baja",
        createdAt,
      },
    ])
    .returning()
  const claimed = handoffs[1]
  if (!claimed) throw new Error("No se creó la derivación recogida")
  await ownerDb.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: userId,
    action: "agent.handoff_claimed",
    entity: "agent_handoff",
    entityId: claimed.id,
    metadata: { taskId: open.id },
    createdAt: new Date("2026-09-02T10:00:00Z"),
  })
  const report = await withOrgContext(appDb, orgId, (tx) =>
    getManagementReport(tx, orgId, "2026-09-01", "2026-09-30", full),
  )
  expect(report.performance.taskTimeliness).toEqual({
    cohort: 5,
    onTime: 1,
    late: 1,
    cancelled: 1,
    open: 1,
    unknown: 1,
  })
  expect(report.performance.clinicalControls).toEqual({
    cohort: 4,
    realized: 1,
    cancelled: 1,
    pending: 1,
    unknown: 1,
  })
  expect(report.performance.handoffs).toEqual({
    cohort: 4,
    collected: 2,
    resolved: 1,
    cancelled: 1,
    open: 1,
    unknown: 1,
  })
})
