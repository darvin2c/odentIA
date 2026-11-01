import { withOrgContext } from "@odentia/db"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { getAgentConfig, upsertAgentConfig } from "./agentConfig.js"
import { ensureDefaultPipeline, listPipelines, renameStage } from "./pipelines.js"
import { completeTask, createTask, listTasks } from "./tasks.js"
import { appDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("ensureDefaultPipeline crea Ventas con los cuatro pasos fijos y es idempotente", async () => {
  const first = await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  expect(first.stages.map((s) => s.name)).toEqual(["Interesado", "Evaluación agendada", "Presupuesto enviado", "Decidió"])
  expect(first.stages.map((s) => s.moment)).toEqual(["interesado", "evaluacion_agendada", "presupuesto_enviado", "decidio"])
  const second = await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  expect(second.pipelineId).toBe(first.pipelineId)
  expect(second.stages).toHaveLength(4)
})

it("listPipelines aísla por org", async () => {
  await withOrgContext(appDb, "org_b", (tx) => ensureDefaultPipeline(tx, "org_b"))
  const a = await withOrgContext(appDb, "org_a", (tx) => listPipelines(tx, "org_a"))
  const b = await withOrgContext(appDb, "org_b", (tx) => listPipelines(tx, "org_b"))
  expect(a).toHaveLength(1)
  expect(b.map((p) => p.name)).toContain("Ventas")
  expect(a[0]?.id).not.toBe(b[0]?.id)
})

it("un paso se renombra, pero no cambia su momento ni su orden; otra organización no lo toca", async () => {
  const { stages } = await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  const first = stages[0]!
  const renamed = await withOrgContext(appDb, "org_a", (tx) => renameStage(tx, "org_a", first.id, { name: "Pidió precio" }))
  expect(renamed).toMatchObject({ name: "Pidió precio", moment: "interesado", position: 0 })
  await expect(withOrgContext(appDb, "org_a", (tx) => renameStage(tx, "org_a", first.id, { name: "   " }))).rejects.toMatchObject({ status: 400 })
  await expect(withOrgContext(appDb, "org_b", (tx) => renameStage(tx, "org_b", first.id, { name: "Ajeno" }))).rejects.toMatchObject({ status: 404 })
  await withOrgContext(appDb, "org_a", (tx) => renameStage(tx, "org_a", first.id, { name: "Interesado" }))
})

it("tasks: crear, listar por estado, completar", async () => {
  const created = await withOrgContext(appDb, "org_a", (tx) =>
    createTask(tx, "org_a", { title: "Llamar al paciente", createdBy: "agent" }),
  )
  expect(created.status).toBe("open")
  const open = await withOrgContext(appDb, "org_a", (tx) =>
    listTasks(tx, "org_a", { status: "open" }),
  )
  expect(open.map((t) => t.id)).toContain(created.id)
  const done = await withOrgContext(appDb, "org_a", (tx) => completeTask(tx, "org_a", created.id))
  expect(done.status).toBe("done")
  const other = await withOrgContext(appDb, "org_b", (tx) => listTasks(tx, "org_b", {}))
  expect(other.map((t) => t.id)).not.toContain(created.id)
})

it("agent config: defaults y upsert", async () => {
  const defaults = await withOrgContext(appDb, "org_a", (tx) => getAgentConfig(tx, "org_a"))
  expect(defaults).toMatchObject({ enabled: false, maxTurns: 10, handoffKeywords: [] })
  const updated = await withOrgContext(appDb, "org_a", (tx) =>
    upsertAgentConfig(tx, "org_a", { enabled: true, handoffKeywords: ["humano"], maxTurns: 5 }),
  )
  expect(updated).toMatchObject({ enabled: true, maxTurns: 5 })
  await expect(
    withOrgContext(appDb, "org_a", (tx) => upsertAgentConfig(tx, "org_a", { maxTurns: 0 })),
  ).rejects.toMatchObject({ status: 400 })
})

it("agent config: la clínica no elige el modelo ni la configuración lo guarda (ADR 0052)", async () => {
  const defaults = await withOrgContext(appDb, "org_b", (tx) => getAgentConfig(tx, "org_b"))
  expect(defaults).not.toHaveProperty("llm")
  const saved = await withOrgContext(appDb, "org_b", (tx) => upsertAgentConfig(tx, "org_b", { maxTurns: 7, replyCheckEnabled: false }))
  expect(saved).toMatchObject({ maxTurns: 7, replyCheckEnabled: false })
  for (const field of ["llm", "model", "llmBaseUrl", "hasLlmApiKey"]) expect(saved).not.toHaveProperty(field)
  const audits = await withOrgContext(appDb, "org_b", (tx) =>
    tx
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(and(eq(auditEvent.organizationId, "org_b"), eq(auditEvent.action, "agent.config_updated"))),
  )
  // maxTurns no se audita; la comprobación de respuestas sí, y ningún modelo.
  expect(audits.map((a) => a.metadata)).toEqual([expect.objectContaining({ changed: ["replyCheckEnabled"] })])
  expect(audits[0]?.metadata).not.toHaveProperty("llm")
})
