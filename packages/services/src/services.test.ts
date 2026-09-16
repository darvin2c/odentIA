import { withOrgContext } from "@odentia/db"
import { contact } from "@odentia/db/schema/crm"
import { expect, it } from "vitest"
import { getAgentConfig, upsertAgentConfig } from "./agentConfig.js"
import { sanitizeCustomFields } from "./contacts.js"
import { createFieldDef, deleteFieldDef, listFieldDefs, updateFieldDef } from "./fields.js"
import {
  createPipeline,
  deleteStage,
  ensureDefaultPipeline,
  listPipelines,
  reorderStages,
} from "./pipelines.js"
import { completeTask, createTask, listTasks } from "./tasks.js"
import { appDb, setupTestDb } from "./test-setup.js"

setupTestDb()

it("ensureDefaultPipeline crea Ventas con 5 etapas y es idempotente", async () => {
  const first = await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  expect(first.stages.map((s) => s.name)).toEqual([
    "Nuevo",
    "Contactado",
    "Cita agendada",
    "Ganado",
    "Perdido",
  ])
  expect(first.stages.map((s) => s.kind)).toEqual(["open", "open", "open", "won", "lost"])
  const second = await withOrgContext(appDb, "org_a", (tx) => ensureDefaultPipeline(tx, "org_a"))
  expect(second.pipelineId).toBe(first.pipelineId)
  expect(second.stages).toHaveLength(5)
})

it("listPipelines aísla por org", async () => {
  await withOrgContext(appDb, "org_b", (tx) => ensureDefaultPipeline(tx, "org_b"))
  const a = await withOrgContext(appDb, "org_a", (tx) => listPipelines(tx, "org_a"))
  const b = await withOrgContext(appDb, "org_b", (tx) => listPipelines(tx, "org_b"))
  expect(a).toHaveLength(1)
  expect(b.map((p) => p.name)).toContain("Ventas")
  expect(a[0]?.id).not.toBe(b[0]?.id)
})

it("createPipeline + reorderStages reordenan posiciones", async () => {
  const created = await withOrgContext(appDb, "org_b", (tx) =>
    createPipeline(tx, "org_b", { name: "Postventa" }),
  )
  expect(created.isDefault).toBe(false)
  const reversed = await withOrgContext(appDb, "org_a", async (tx) => {
    const { stages } = await ensureDefaultPipeline(tx, "org_a")
    return reorderStages(
      tx,
      "org_a",
      stages[0]?.pipelineId ?? "",
      [...stages.map((s) => s.id)].reverse(),
    )
  })
  expect(reversed.map((s) => s.position)).toEqual([0, 1, 2, 3, 4])
  // Restaurar orden original para no contaminar otros tests.
  await withOrgContext(appDb, "org_a", async (tx) => {
    const { stages } = await ensureDefaultPipeline(tx, "org_a")
    await reorderStages(
      tx,
      "org_a",
      stages[0]?.pipelineId ?? "",
      [...stages.map((s) => s.id)].reverse(),
    )
  })
  void created
})

it("deleteStage con contactos en uso da STAGE_IN_USE", async () => {
  await withOrgContext(appDb, "org_a", async (tx) => {
    const { stages } = await ensureDefaultPipeline(tx, "org_a")
    await tx.insert(contact).values({
      organizationId: "org_a",
      displayName: "Con etapa",
      stageId: stages[0]?.id ?? "",
    })
    await expect(deleteStage(tx, "org_a", stages[0]?.id ?? "")).rejects.toMatchObject({
      code: "STAGE_IN_USE",
      status: 409,
    })
  })
})

it("custom fields: valida tipos, descarta desconocidas", async () => {
  await withOrgContext(appDb, "org_a", async (tx) => {
    await createFieldDef(tx, "org_a", { key: "alergias", label: "Alergias", type: "text" })
    await createFieldDef(tx, "org_a", { key: "edad", label: "Edad", type: "number" })
    await createFieldDef(tx, "org_a", {
      key: "sede",
      label: "Sede",
      type: "select",
      options: ["norte", "sur"],
    })
    const defs = await listFieldDefs(tx, "org_a")
    expect(defs.map((d) => d.key).sort()).toEqual(["alergias", "edad", "sede"])
    const clean = await sanitizeCustomFields(tx, "org_a", {
      alergias: "penicilina",
      edad: 30,
      sede: "norte",
      fantasma: "x",
    })
    expect(clean).toEqual({ alergias: "penicilina", edad: 30, sede: "norte" })
    await expect(sanitizeCustomFields(tx, "org_a", { edad: "treinta" })).rejects.toMatchObject({
      status: 400,
    })
    await expect(sanitizeCustomFields(tx, "org_a", { sede: "este" })).rejects.toMatchObject({
      status: 400,
    })
    const renamed = await updateFieldDef(tx, "org_a", defs[0]?.id ?? "", {
      label: "Alergias conocidas",
    })
    expect(renamed.label).toBe("Alergias conocidas")
    await deleteFieldDef(tx, "org_a", defs[0]?.id ?? "")
    expect(await listFieldDefs(tx, "org_a")).toHaveLength(2)
  })
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
