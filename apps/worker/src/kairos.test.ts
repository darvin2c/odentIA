import { fakeKairosWriter, type KairosWriter } from "@odentia/agent"
import {
  kairosAiUsage,
  kairosItem,
  kairosWeekly,
  saasClient,
  saasClientContact,
  saasClientFile,
  saasImportDraft,
} from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { aiUsage } from "@odentia/db/schema/agent"
import { organization, user } from "@odentia/db/schema/auth"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { kairosUseRecorder, runKairosTick } from "./kairos.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

// Lunes 16 de noviembre de 2026, 08:00 de Lima (13:00 UTC).
const monday = new Date("2026-11-16T13:00:00Z")
let clientId = ""
let itemId = ""
const deleted: string[] = []
const storage = {
  deleteAttachment: async (key: string) => {
    deleted.push(key)
  },
}

/** El doble, contando lo que se le pide. */
function countingWriter(overrides: Partial<KairosWriter> = {}) {
  const calls: string[] = []
  const writer: KairosWriter = {
    draftMessage: async (input) => {
      calls.push("borrador")
      return (overrides.draftMessage ?? fakeKairosWriter.draftMessage)(input)
    },
    summarizeClient: async (input) => {
      calls.push("resumen")
      return (overrides.summarizeClient ?? fakeKairosWriter.summarizeClient)(input)
    },
    parseAnnotation: async (input) => {
      calls.push("anotar")
      return fakeKairosWriter.parseAnnotation(input)
    },
    presentationScript: async (input) => {
      calls.push("guion")
      return fakeKairosWriter.presentationScript(input)
    },
    weeklySummary: async (input) => {
      calls.push("semana")
      return (overrides.weeklySummary ?? fakeKairosWriter.weeklySummary)(input)
    },
  }
  return { writer, calls }
}

beforeAll(async () => {
  const [client] = await ownerDb
    .insert(saasClient)
    .values({ name: "Clínica Sonríe (ficticia)", product: "dental", origin: "web" })
    .returning()
  clientId = client?.id ?? ""
  const [contact] = await ownerDb
    .insert(saasClientContact)
    .values({
      clientId,
      name: "Rosa Quispe",
      title: "Gerente",
      roles: ["decide"],
      email: "rosa@sonrie.test",
      isPrimary: true,
    })
    .returning()
  await ownerDb.insert(saasFollowUp).values({
    clientId,
    body: "Le interesa la agenda por WhatsApp",
    kind: "llamada",
    direction: "salio",
    happenedAt: new Date("2026-11-13T15:00:00Z"),
  })
  await ownerDb.insert(saasFollowUp).values({
    clientId,
    body: "El descuento que pidió es solo para Administración",
    kind: "nota",
    adminOnly: true,
    happenedAt: new Date("2026-11-13T16:00:00Z"),
  })
  const [item] = await ownerDb
    .insert(kairosItem)
    .values({
      clientId,
      kind: "mensaje",
      title: "Primera respuesta a Rosa Quispe",
      reason: "Dejó su solicitud en la web y nadie le respondió",
      payload: {
        channel: "correo",
        goal: "primera_respuesta",
        contactId: contact?.id,
        facts: ["Producto: odentIA"],
      },
      idempotencyKey: "prueba:responder:1",
      expiresAt: new Date(monday.getTime() + 48 * 3_600_000),
    })
    .returning()
  itemId = item?.id ?? ""
  await ownerDb.insert(saasClientFile).values([
    {
      clientId,
      kind: "archivo_clinica",
      filename: "pacientes.xlsx",
      objectKey: `clients/${clientId}/vencido.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 10,
      deleteAfter: "2026-11-15",
      source: "correo",
    },
    {
      clientId,
      kind: "archivo_clinica",
      filename: "agenda.xlsx",
      objectKey: `clients/${clientId}/vigente.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sizeBytes: 10,
      deleteAfter: "2026-12-10",
      source: "correo",
    },
  ])
})

describe("runKairosTick", () => {
  it("antes de las 07:00 de Lima corre las reglas y los borradores, pero no lo del día", async () => {
    const { writer, calls } = countingWriter()
    // Lunes 06:30 de Lima.
    const early = new Date("2026-11-16T11:30:00Z")
    const result = await runKairosTick({ ownerDb, writer, storage, now: early })
    expect(result.errors).toEqual([])
    expect(result.pass).not.toBeNull()
    expect(result.day).toBeNull()
    expect(result.drafted).toBe(1)
    expect(calls).toEqual(["borrador"])
    const [item] = await ownerDb.select().from(kairosItem).where(eq(kairosItem.id, itemId))
    // Redactado, sigue esperando el sí de una persona: nada se envió.
    expect(item?.status).toBe("espera")
    expect(item?.payload.draft).toMatchObject({ subject: "Tu solicitud de odentIA" })
    expect(String((item?.payload.draft as { body?: string } | undefined)?.body)).toContain(
      "Hola, Rosa:",
    )
    expect(deleted).toEqual([`clients/${clientId}/vencido.xlsx`])
  })

  it("desde las 07:00 renueva los resúmenes con sus fuentes y escribe la semana, una sola vez por día", async () => {
    const { writer, calls } = countingWriter()
    const result = await runKairosTick({ ownerDb, writer, storage, now: monday })
    expect(result.errors).toEqual([])
    expect(result.day).toBe("2026-11-16")
    expect(result.summaries).toBeGreaterThanOrEqual(1)
    expect(result.weekly).toBe("2026-11-16")
    const [client] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, clientId))
    expect(client?.summary).toContain("Le interesa la agenda por WhatsApp")
    // Lo solo de administración no entra en lo que también ve Soporte.
    expect(client?.summary).not.toContain("descuento")
    expect(client?.summarySources?.length).toBeGreaterThan(0)
    for (const source of client?.summarySources ?? [])
      expect(source.source).toMatch(
        /^(cliente|solicitud|contacto|actividad|tarea|propuesta|venta):/,
      )
    expect(client?.summaryAt?.toISOString()).toBe(monday.toISOString())
    const weeks = await ownerDb.select().from(kairosWeekly)
    expect(weeks.map((week) => week.weekStart)).toEqual(["2026-11-16"])
    expect(calls.filter((call) => call === "semana")).toHaveLength(1)
    const claims = await ownerDb
      .select()
      .from(adminAudit)
      .where(and(eq(adminAudit.action, "kairos.daily_pass"), eq(adminAudit.entityId, "2026-11-16")))
    expect(claims).toHaveLength(1)

    // La pasada siguiente del mismo día no repite nada ni llama al modelo.
    const again = countingWriter()
    const second = await runKairosTick({
      ownerDb,
      writer: again.writer,
      storage,
      now: new Date(monday.getTime() + 300_000),
    })
    expect(second.day).toBeNull()
    expect(second.summaries).toBe(0)
    expect(second.weekly).toBeNull()
    expect(again.calls).toEqual([])
    // El archivo vigente sigue: solo se borra lo vencido.
    expect(deleted).toEqual([`clients/${clientId}/vencido.xlsx`])
  })

  it("al día siguiente renueva solo el cliente con algo nuevo, y un fallo del modelo no frena lo demás", async () => {
    await ownerDb.insert(saasFollowUp).values({
      clientId,
      body: "Pidió ver la demo con su socio",
      kind: "whatsapp",
      direction: "entro",
      createdAt: new Date("2026-11-16T20:00:00Z"),
      happenedAt: new Date("2026-11-16T20:00:00Z"),
    })
    const { writer, calls } = countingWriter({
      summarizeClient: async () => {
        throw new Error("el proveedor no respondió")
      },
    })
    const tuesday = new Date("2026-11-17T13:00:00Z")
    const result = await runKairosTick({ ownerDb, writer, storage, now: tuesday })
    expect(result.day).toBe("2026-11-17")
    expect(result.summaries).toBe(0)
    expect(result.summariesFailed).toBe(1)
    expect(result.errors.some((error) => error.includes("el proveedor no respondió"))).toBe(true)
    expect(calls.filter((call) => call === "resumen")).toHaveLength(1)
    // La semana ya estaba escrita: no se vuelve a pedir.
    expect(calls).not.toContain("semana")
    const [client] = await ownerDb.select().from(saasClient).where(eq(saasClient.id, clientId))
    expect(client?.summaryAt?.toISOString()).toBe(monday.toISOString())
  })
})

it("el gasto de Kairós se anota como gasto de Sallca, sin clínica", async () => {
  await kairosUseRecorder(ownerDb)({
    purpose: "borrador",
    model: "gpt-6-luna",
    inputTokens: 1_000,
    outputTokens: 200,
    cachedTokens: 0,
    costMicros: null,
  })
  await kairosUseRecorder(ownerDb)({
    purpose: "resumen",
    model: "gpt-6-luna",
    inputTokens: 1_000,
    outputTokens: 200,
    cachedTokens: 0,
    costMicros: 200,
  })
  const rows = await ownerDb.select().from(kairosAiUsage)
  expect(rows).toEqual([
    expect.objectContaining({
      purpose: "borrador",
      model: "gpt-6-luna",
      inputTokens: 1_000,
      costMicros: null,
      clientId: null,
    }),
    expect.objectContaining({ purpose: "resumen", costMicros: 200, clientId: null }),
  ])
  // Nunca en el libro de gasto de una clínica.
  expect(await ownerDb.select().from(aiUsage)).toEqual([])
})

it("la pasada borra los JSON de la skill usados, reemplazados o subidos hace 30 días, y deja constancia sin datos", async () => {
  const org = "kairos-org-carga"
  await ownerDb.insert(user).values({ id: "kairos-ada", name: "Ada", email: "ada@kairos.test" })
  await ownerDb
    .insert(organization)
    .values({ id: org, name: "Clínica Carga", slug: "kairos-carga", createdAt: new Date() })
  // Miércoles 18, 06:00 de Lima: sin lo del día.
  const now = new Date("2026-11-18T11:00:00Z")
  const key = (name: string) => `clients/${clientId}/${name}.json`
  const base = {
    clientId,
    organizationId: org,
    uploadedBy: "kairos-ada",
    summary: { personas: 2 },
  }
  const drafts = await ownerDb
    .insert(saasImportDraft)
    .values([
      {
        ...base,
        kind: "plan_pacientes",
        number: 1,
        payloadKey: key("usado"),
        status: "usada",
        payloadUploadedAt: now,
      },
      {
        ...base,
        kind: "plan_pacientes",
        number: 2,
        payloadKey: key("viejo"),
        payloadUploadedAt: new Date(now.getTime() - 30 * 86_400_000),
      },
      {
        ...base,
        kind: "plan_pacientes",
        number: 3,
        payloadKey: key("vigente"),
        payloadUploadedAt: new Date(now.getTime() - 29 * 86_400_000),
        stalePayloadKeys: [key("reemplazado")],
      },
    ])
    .returning({ id: saasImportDraft.id, number: saasImportDraft.number })
  const gone: string[] = []
  const result = await runKairosTick({
    ownerDb,
    writer: countingWriter().writer,
    storage: { deleteAttachment: async (k: string) => void gone.push(k) },
    now,
  })
  expect(result.errors).toEqual([])
  expect(result.draftPayloadsDeleted).toBe(3)
  expect(gone.filter((k) => k.endsWith(".json")).sort()).toEqual(
    [key("usado"), key("viejo"), key("reemplazado")].sort(),
  )
  const rows = await ownerDb.select().from(saasImportDraft)
  const byNumber = new Map(rows.map((row) => [row.number, row]))
  expect(byNumber.get(1)?.payloadDeletedAt?.toISOString()).toBe(now.toISOString())
  expect(byNumber.get(2)?.payloadDeletedAt?.toISOString()).toBe(now.toISOString())
  expect(byNumber.get(3)).toMatchObject({ payloadDeletedAt: null, stalePayloadKeys: [] })
  const audits = await ownerDb
    .select({ actor: adminAudit.actorUserId, metadata: adminAudit.metadata })
    .from(adminAudit)
    .where(eq(adminAudit.action, "skill.draft_payload_deleted"))
  expect(audits.map((audit) => audit.metadata?.reason).sort()).toEqual([
    "30_dias",
    "reemplazado",
    "usada",
  ])
  expect(audits.every((audit) => audit.actor === null)).toBe(true)
  expect(JSON.stringify(audits)).not.toContain(".json")
  expect(drafts).toHaveLength(3)
})
