import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { commercialFollowUpCoordination } from "@odentia/db/schema/agent"
import { automationConsent } from "@odentia/db/schema/automation"
import {
  agentConfig,
  channelConnection,
  contact,
  conversation,
  crmTask,
  pipeline,
  pipelineStage,
} from "@odentia/db/schema/crm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { syncOverdueCommercialFollowUps } from "./automation.js"
import { beginCommercialFollowUpCoordination } from "./commercial-coordination.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function seedDueFollowUp(input: { consent: boolean }) {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `coord-${orgId}`)
  const [person] = await ownerDb
    .insert(contact)
    .values({ organizationId: orgId, displayName: "Interlocutor coordinación" })
    .returning()
  const [connection] = await ownerDb
    .insert(channelConnection)
    .values({
      organizationId: orgId,
      channel: "telegram",
      provider: "telegram_bot_api",
      displayName: "Telegram coordinación",
      configEncrypted: "config",
      webhookSecret: "secret",
      status: "active",
    })
    .returning()
  if (!person || !connection) throw new Error("No se pudo preparar el contacto y el canal")
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: orgId,
      contactId: person.id,
      channelConnectionId: connection.id,
      externalThreadId: `tg:${randomUUID()}`,
      agentStatus: "on",
    })
    .returning()
  await ownerDb.insert(agentConfig).values({ organizationId: orgId, enabled: true })
  if (input.consent) {
    await ownerDb.insert(automationConsent).values({
      organizationId: orgId,
      contactId: person.id,
      purpose: "seguimiento",
      channel: "telegram",
      status: "granted",
      source: "prueba",
    })
  }
  const [pipe] = await ownerDb
    .insert(pipeline)
    .values({ organizationId: orgId, name: "Comercial", isDefault: true })
    .returning()
  if (!pipe) throw new Error("No se pudo preparar el pipeline")
  const [stage] = await ownerDb
    .insert(pipelineStage)
    .values({ organizationId: orgId, pipelineId: pipe.id, name: "Contacto", position: 0 })
    .returning()
  if (!stage || !thread) throw new Error("No se pudo preparar la etapa y la conversación")
  const dueAt = new Date("2026-10-03T14:00:00.000Z")
  const [opp] = await ownerDb
    .insert(opportunity)
    .values({
      organizationId: orgId,
      contactId: person.id,
      conversationId: thread.id,
      pipelineId: pipe.id,
      stageId: stage.id,
      title: "Ortodoncia",
      currency: "PEN",
      nextActionAt: dueAt,
      nextActionNote: "Retomar propuesta",
    })
    .returning()
  if (!opp) throw new Error("No se pudo preparar la oportunidad")
  const [task] = await ownerDb
    .insert(crmTask)
    .values({
      organizationId: orgId,
      contactId: person.id,
      conversationId: thread.id,
      opportunityId: opp.id,
      title: "Retomar propuesta",
      dueAt,
      status: "open",
      kind: "opportunity_follow_up",
      createdBy: "user",
    })
    .returning()
  if (!task) throw new Error("No se pudo preparar la tarea")
  return { orgId, taskId: task.id }
}

it("programa una sola coordinación por tarea y vencimiento aunque el tick se repita", async () => {
  const fixture = await seedDueFollowUp({ consent: true })
  const now = new Date("2026-10-03T15:00:00.000Z")
  const first = await withOrgContext(appDb, fixture.orgId, (tx) =>
    syncOverdueCommercialFollowUps(tx, fixture.orgId, now),
  )
  const replay = await withOrgContext(appDb, fixture.orgId, (tx) =>
    syncOverdueCommercialFollowUps(tx, fixture.orgId, now),
  )
  expect(first).toEqual({ programados: 1, omitidos: 0 })
  expect(replay).toEqual({ programados: 0, omitidos: 0 })
  const rows = await withOrgContext(appDb, fixture.orgId, (tx) =>
    tx
      .select()
      .from(commercialFollowUpCoordination)
      .where(
        and(
          eq(commercialFollowUpCoordination.organizationId, fixture.orgId),
          eq(commercialFollowUpCoordination.taskId, fixture.taskId),
        ),
      ),
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]?.status).toBe("pendiente")
})

it("omite una coordinación si el pendiente cambió antes de ejecutar", async () => {
  const fixture = await seedDueFollowUp({ consent: true })
  const now = new Date("2026-10-03T15:00:00.000Z")
  await withOrgContext(appDb, fixture.orgId, (tx) =>
    syncOverdueCommercialFollowUps(tx, fixture.orgId, now),
  )
  const [coordination] = await withOrgContext(appDb, fixture.orgId, (tx) =>
    tx
      .select()
      .from(commercialFollowUpCoordination)
      .where(eq(commercialFollowUpCoordination.taskId, fixture.taskId)),
  )
  if (!coordination) throw new Error("No se creó la coordinación")
  await ownerDb.update(crmTask).set({ status: "done" }).where(eq(crmTask.id, fixture.taskId))
  const result = await withOrgContext(appDb, fixture.orgId, (tx) =>
    beginCommercialFollowUpCoordination(tx, fixture.orgId, coordination.id, now),
  )
  expect(result).toMatchObject({ run: false, status: "omitida" })
})

it("deriva sin contactar cuando falta consentimiento y no fuga la coordinación a otra organización", async () => {
  const fixture = await seedDueFollowUp({ consent: false })
  const now = new Date("2026-10-03T15:00:00.000Z")
  const summary = await withOrgContext(appDb, fixture.orgId, (tx) =>
    syncOverdueCommercialFollowUps(tx, fixture.orgId, now),
  )
  expect(summary).toEqual({ programados: 0, omitidos: 1 })
  const own = await withOrgContext(appDb, fixture.orgId, (tx) =>
    tx.select().from(commercialFollowUpCoordination),
  )
  const foreign = await withOrgContext(appDb, "org_b", (tx) =>
    tx.select().from(commercialFollowUpCoordination),
  )
  expect(own).toHaveLength(1)
  expect(own[0]).toMatchObject({ status: "derivada", nextResponsibleKind: "team" })
  expect(foreign).toEqual([])
})
