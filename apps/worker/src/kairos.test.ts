import { fakeKairosWriter, type KairosWriter } from "@odentia/agent"
import {
  kairosAiUsage,
  kairosItem,
  kairosWeekly,
  saasClient,
  saasClientContact,
  saasClientFile,
  saasInboundEmail,
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
    draftReply: async (input) => {
      calls.push("respuesta")
      return (overrides.draftReply ?? fakeKairosWriter.draftReply)(input)
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
    // Las fechas van en palabras: el resumen con plantilla las copia a la ficha.
    expect(client?.summary).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(client?.summary).toContain("13 de noviembre de 2026")
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

it("prepara una sola vez la respuesta de cada correo nuevo a hola@ o a una persona, nunca de soporte@", async () => {
  // Miércoles 18, 08:00 de Lima: los correos llegaron esa madrugada.
  const wednesday = new Date("2026-11-18T13:00:00Z")
  const received = new Date("2026-11-18T10:00:00Z")
  const emails = await ownerDb
    .insert(saasInboundEmail)
    .values([
      {
        mailbox: "hola",
        product: "dental",
        messageId: "<k-hola@example.test>",
        fromAddress: "dra.luna@example.test",
        fromName: "Dra. Luna (ficticia)",
        toAddress: "hola@odentia32.com",
        subject: "¿Cómo empiezo?",
        textBody:
          "Tengo un consultorio con dos unidades.\nMi paciente con DNI 44556677 necesita su historia.\n> lo citado no viaja",
        senderVerified: true,
        receivedAt: received,
      },
      {
        mailbox: "soporte",
        product: "dental",
        messageId: "<k-soporte@example.test>",
        fromAddress: "recepcion@example.test",
        toAddress: "soporte@odentia32.com",
        subject: "No puedo entrar",
        textBody: "La paciente Juana Pérez no aparece",
        senderVerified: true,
        receivedAt: received,
      },
    ])
    .returning({ id: saasInboundEmail.id, mailbox: saasInboundEmail.mailbox })
  const hola = emails.find((email) => email.mailbox === "hola")?.id ?? ""
  const asks: Parameters<KairosWriter["draftReply"]>[0][] = []
  const { writer, calls } = countingWriter({
    draftReply: async (input) => {
      asks.push(input)
      return fakeKairosWriter.draftReply(input)
    },
  })
  const result = await runKairosTick({ ownerDb, writer, storage, now: wednesday })
  expect(result.errors).toEqual([])
  const replies = await ownerDb
    .select()
    .from(kairosItem)
    .where(eq(kairosItem.kind, "responder_correo"))
  // Solo la de hola@: lo de soporte@ puede traer datos de pacientes.
  expect(replies).toHaveLength(1)
  const [reply] = replies
  expect(reply).toMatchObject({ status: "espera", adminOnly: true, clientId: null })
  expect(reply?.payload.emailId).toBe(hola)
  expect(reply?.reason).toContain("Le escribió a hola@ de odentIA el 18 de noviembre")
  expect(reply?.expiresAt.getTime()).toBe(wednesday.getTime() + 48 * 3_600_000)
  // Redactada en la misma pasada, con el texto filtrado: sin la frase del paciente ni lo citado.
  expect(calls.filter((call) => call === "respuesta")).toHaveLength(1)
  expect(asks[0]?.lines).toEqual(["Tengo un consultorio con dos unidades."])
  expect(asks[0]?.omitted).toBe(1)
  expect(JSON.stringify(asks[0])).not.toContain("44556677")
  expect(String(reply?.payload.body)).toContain("Gracias por escribirnos")
  // Con su borrador, lista para el sí de una persona: nada salió.
  expect(reply?.payload.draft).toMatchObject({ subject: null })

  // Descartada, la pasada siguiente no la vuelve a preparar.
  await ownerDb
    .update(kairosItem)
    .set({ status: "descartada" })
    .where(eq(kairosItem.id, reply?.id ?? ""))
  const again = countingWriter()
  await runKairosTick({
    ownerDb,
    writer: again.writer,
    storage,
    now: new Date(wednesday.getTime() + 300_000),
  })
  const after = await ownerDb
    .select()
    .from(kairosItem)
    .where(eq(kairosItem.kind, "responder_correo"))
  expect(after).toHaveLength(1)
  expect(again.calls).not.toContain("respuesta")
})
