import { randomUUID } from "node:crypto"
import type { ChannelAdapter, NormalizedInbound } from "@odentia/channels"
import { withOrgContext } from "@odentia/db"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { automationJob } from "@odentia/db/schema/automation"
import { encounter, patientContact } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { saasAction, saasCommercialTerms, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { recordAgentRun } from "./agent-operations.js"
import { upsertAgentConfig } from "./agentConfig.js"
import { APPOINTMENT_NOTICE_KEYS } from "./automation-messages.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createConnection } from "./connections.js"
import { type IngestDeps, ingestInbound } from "./conversations.js"
import { confirmDictationSuggestion, saveDictationSuggestions } from "./encounter-dictation.js"
import { finalizeEncounter } from "./encounters.js"
import { getSaasConsumption, listPendingRecoveries } from "./saas-actions.js"
import { SAAS_TERMS_INITIAL } from "./saas-commercial-terms.js"
import { secretsKeyFromEnv } from "./secrets.js"
import type { Storage } from "./storage.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

/** Lo que hicieron los agentes, por acción (ADR 0031, fase 2): qué cuenta, cuánto y una sola vez. */
setupTestDb()
const ORG = "org_a"
const KEY = secretsKeyFromEnv("cd".repeat(32))
const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, ORG, fn)

const unused = async (): Promise<never> => {
  throw new Error("no usado")
}
const storage: Storage = {
  putAvatar: unused,
  deleteByUrl: async () => {},
  putAttachment: unused,
  attachmentUrl: async (key) => `https://signed.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: unused,
  putPatientAvatar: unused,
}
const deps: IngestDeps = { storage, fetch, secretsKey: KEY }
const adapter: ChannelAdapter = {
  provider: "telegram_bot_api",
  capabilities: { templates: false, media: false, interactive: false, readReceipts: false, edit: true },
  verifyWebhook: () => true,
  parseWebhook: () => ({ messages: [], statuses: [] }),
  sendMessage: async () => ({ externalId: "x" }),
  validateConnection: async () => ({ externalId: "bot", displayName: "Bot" }),
}
let connectionId: string

async function inbound(thread: string, sender: string): Promise<string> {
  const event: NormalizedInbound = {
    externalEventId: randomUUID(),
    externalMessageId: randomUUID(),
    externalThreadId: thread,
    senderExternalId: sender,
    senderDisplayName: "Lucía Ramos",
    content: { type: "text", text: "Hola" },
    sentAt: new Date().toISOString(),
  }
  return (await run((tx) => ingestInbound(tx, { orgId: ORG, connectionId, event }, adapter, deps))).conversationId
}

const ran = (conversationId: string, at: Date, over: { status?: "ok" | "sin_respuesta"; llmCalls?: number } = {}) =>
  run((tx) =>
    recordAgentRun(tx, ORG, { conversationId, model: "gpt-6-luna", status: over.status ?? "ok", startedAt: at, llmCalls: over.llmCalls ?? 1 }),
  )

const actionsOf = (kind: string) =>
  run((tx) => tx.select().from(saasAction).where(and(eq(saasAction.organizationId, ORG), eq(saasAction.kind, kind))))

beforeAll(async () => {
  // El plan de la ADR 0031 como plan por defecto, y un 10 % negociado para la clínica.
  await ownerDb.insert(saasPlan).values({
    code: "odentia-prueba-acciones",
    name: "Plan odentIA",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 4_000_000,
    trialCreditCents: 5000,
    trialMaxCreditCents: 13000,
    isDefault: true,
  })
  const period = { status: "activa", discountBps: 1000, currentPeriodStart: new Date(Date.now() - 10 * 86_400_000), currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000) }
  await ownerDb
    .insert(saasSubscription)
    .values({ organizationId: ORG, ...period })
    .onConflictDoUpdate({ target: saasSubscription.organizationId, set: period })
  connectionId = (
    await run((tx) =>
      createConnection(tx, ORG, KEY, { channel: "telegram", provider: "telegram_bot_api", displayName: "Bot", config: { botToken: "T" } }, { fetch, validateExternal: false }),
    )
  ).id
})

describe("conversación de Recepción", () => {
  it("una por persona cada 24 horas, aunque cambie de hilo; solo si atendió con IA", async () => {
    const first = await inbound("tg:lucia", "tg:lucia")
    const second = await inbound("tg:lucia-otro", "tg:lucia")
    const now = Date.now()
    // Sin llamar al modelo (texto fijo) o sin responder: no cuenta.
    await ran(first, new Date(now - 30 * 3_600_000), { llmCalls: 0 })
    await ran(first, new Date(now - 29 * 3_600_000), { status: "sin_respuesta" })
    expect(await actionsOf("conversacion")).toHaveLength(0)
    await ran(first, new Date(now - 28 * 3_600_000))
    // Dos horas después, por otro hilo de la misma persona: va dentro de la misma.
    await ran(second, new Date(now - 26 * 3_600_000))
    expect(await actionsOf("conversacion")).toHaveLength(1)
    // Pasadas 24 horas, otra.
    await ran(second, new Date(now - 3 * 3_600_000))
    const counted = await actionsOf("conversacion")
    expect(counted).toHaveLength(2)
    // El precio se congela al contar: base y con el 10 % negociado.
    expect(counted[0]).toMatchObject({ currency: "USD", basePriceMicros: 500_000, priceMicros: 450_000, discountBps: 1000, channel: "telegram" })
  })
})

describe("consulta dictada", () => {
  it("cuenta una por atención al cerrarla, solo con lo dictado confirmado", async () => {
    await run((tx) => upsertAgentConfig(tx, ORG, { clinicalAssistantEnabled: true }))
    const without = await clinicalFixture()
    await without.ready(without.encounter.id)
    await without.run((tx) => finalizeEncounter(tx, ...without.args, without.encounter.id))
    expect(await actionsOf("consulta")).toHaveLength(0)

    const dictated = await clinicalFixture()
    const [note] = await dictated.run((tx) =>
      saveDictationSuggestions(tx, ...dictated.args, dictated.encounter.id, [{ kind: "nota", payload: { reason: "Dolor al masticar" } }]),
    )
    await dictated.run((tx) => confirmDictationSuggestion(tx, ...dictated.args, dictated.encounter.id, note!.id))
    await dictated.ready(dictated.encounter.id)
    await dictated.run((tx) => finalizeEncounter(tx, ...dictated.args, dictated.encounter.id))
    const counted = await actionsOf("consulta")
    expect(counted).toHaveLength(1)
    expect(counted[0]).toMatchObject({ encounterId: dictated.encounter.id, basePriceMicros: 400_000, priceMicros: 360_000 })
    expect(counted[0]?.detail).toContain("Clínico")
  })
})

describe("cita recuperada", () => {
  async function scene(source: string, sentDaysBeforeBooking: number, kind = "seguimiento_presupuesto", bookedDaysAgo = 2) {
    const fx = await clinicalFixture()
    const [self] = await ownerDb
      .select({ contactId: patientContact.contactId })
      .from(patientContact)
      .where(and(eq(patientContact.patientId, fx.patient.id), eq(patientContact.relationship, "self")))
    const [site] = await ownerDb.insert(branch).values({ organizationId: ORG, name: `Sede ${randomUUID().slice(0, 6)}` }).returning()
    const [room] = await ownerDb.insert(scheduleRoom).values({ organizationId: ORG, branchId: site!.id, name: "Unidad dental" }).returning()
    const bookedAt = new Date(Date.now() - bookedDaysAgo * 86_400_000)
    await ownerDb.insert(automationJob).values({
      organizationId: ORG,
      kind,
      status: "enviado",
      dedupeKey: randomUUID(),
      scheduledFor: bookedAt,
      contactId: self!.contactId,
      updatedAt: new Date(bookedAt.getTime() - sentDaysBeforeBooking * 86_400_000),
    })
    const startsAt = new Date(Date.now() + 86_400_000 + Math.floor(Math.random() * 1_000) * 3_600_000)
    const [appt] = await ownerDb
      .insert(appointment)
      .values({
        organizationId: ORG,
        branchId: site!.id,
        roomId: room!.id,
        professionalUserId: fx.actor,
        patientId: fx.patient.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        durationMin: 30,
        status: "programada",
        source,
        createdAt: bookedAt,
      })
      .returning()
    return { fx, appointmentId: appt!.id }
  }

  /** El paciente asiste: su atención se une a la cita y, al firmarla, la cita queda atendida (ADR 0032). */
  async function attend(item: Awaited<ReturnType<typeof scene>>) {
    await ownerDb.update(encounter).set({ appointmentId: item.appointmentId }).where(eq(encounter.id, item.fx.encounter.id))
    await item.fx.ready(item.fx.encounter.id)
    await item.fx.run((tx) => finalizeEncounter(tx, ...item.fx.args, item.fx.encounter.id))
  }

  it("se cuenta cuando el paciente asiste, si el agente la reservó tras un mensaje del Administrador", async () => {
    const recovered = await scene("enlace", 2)
    // Mientras no asiste, espera; no se cobra.
    expect((await run((tx) => listPendingRecoveries(tx, ORG))).map((row) => row.appointmentId)).toContain(recovered.appointmentId)
    await attend(recovered)
    const counted = await actionsOf("cita")
    expect(counted.map((row) => row.appointmentId)).toEqual([recovered.appointmentId])
    expect(counted[0]).toMatchObject({ basePriceMicros: 4_000_000, priceMicros: 3_600_000, channel: "enlace" })
    expect(counted[0]?.detail).toContain("reservó desde el enlace")
  })

  it("no cuenta la que agendó el equipo, la de un recordatorio ni la de un mensaje de hace más de 7 días", async () => {
    const before = (await actionsOf("cita")).length
    for (const item of [await scene("recepcion", 1), await scene("agent", 1, "recordatorio_cita"), await scene("agent", 8)]) {
      await attend(item)
    }
    expect(await actionsOf("cita")).toHaveLength(before)
  })

  it("no cuenta la que se reserva tras un aviso de cita reservada, movida o cancelada: no estaba perdida", async () => {
    // Recepción agendó a Lucía por teléfono, le llegó «Tu cita quedó reservada» y días después reservó otra con Sofi.
    const before = (await actionsOf("cita")).length
    for (const kind of APPOINTMENT_NOTICE_KEYS) await attend(await scene("agent", 4, kind))
    expect(await actionsOf("cita")).toHaveLength(before)
  })

  it("sí cuenta la que se reserva tras «Reprogramar tras una inasistencia»", async () => {
    const recovered = await scene("agent", 3, "seguimiento_no_asistencia")
    await attend(recovered)
    const counted = (await actionsOf("cita")).find((row) => row.appointmentId === recovered.appointmentId)
    expect(counted?.detail).toBe("Volvió tras «Reprogramar tras una inasistencia» y reservó en la conversación")
    // Se retira para que «lo que ve la clínica» siga sumando la única cita de la primera prueba.
    await ownerDb.delete(saasAction).where(eq(saasAction.id, counted!.id))
  })

  it("usa el plazo que regía al reservar: bajarlo después no le quita la cita a quien ya reservó (ADR 0074)", async () => {
    const before = (await actionsOf("cita")).length
    // Hace 36 horas el plazo bajó de 7 a 3 días. Rosa reservó hace 2 días, 5 días después del mensaje de Argos.
    await ownerDb.insert(saasCommercialTerms).values({ ...SAAS_TERMS_INITIAL, recoveryWindowDays: 3, effectiveFrom: new Date(Date.now() - 36 * 3_600_000) })
    const rosa = await scene("agent", 5)
    await attend(rosa)
    const counted = (await actionsOf("cita")).find((row) => row.appointmentId === rosa.appointmentId)
    expect(counted).toBeDefined()
    // Lucía, en la misma situación, reservó hace una hora: con 3 días, ya no cuenta.
    const lucia = await scene("agent", 5, "seguimiento_presupuesto", 1 / 24)
    await attend(lucia)
    expect(await actionsOf("cita")).toHaveLength(before + 1)
    // Se retira para que «lo que ve la clínica» siga sumando la única cita de la primera prueba.
    await ownerDb.delete(saasAction).where(eq(saasAction.id, counted!.id))
  })

  it("«No podré ir» tras un recordatorio: Sofi mueve la cita que ya tenía y no cuenta (ADR 0031)", async () => {
    const before = (await actionsOf("cita")).length
    // La cita ya estaba reservada cuando salió el recordatorio; la persona pidió otro día y Sofi la movió.
    const kept = await scene("agent", -1, "recordatorio_cita")
    const startsAt = new Date(Date.now() + 3 * 86_400_000)
    await ownerDb.update(appointment).set({ startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000) }).where(eq(appointment.id, kept.appointmentId))
    await attend(kept)
    expect(await actionsOf("cita")).toHaveLength(before)
  })
})

describe("lo que ve la clínica", () => {
  it("suma el mes con el precio negociado y dice cuánto ahorra frente al precio base", async () => {
    const consumption = await run((tx) => getSaasConsumption(tx, ORG))
    const line = (kind: string) => consumption.lines.find((item) => item.kind === kind)
    expect(consumption).toMatchObject({ currency: "USD", priced: true, discountBps: 1000, creditCents: 2900 })
    expect(line("conversacion")).toMatchObject({ count: 2, amountCents: 90, baseAmountCents: 100, priceMicros: 450_000 })
    expect(line("consulta")).toMatchObject({ count: 1, amountCents: 36 })
    expect(line("cita")).toMatchObject({ count: 1, amountCents: 360 })
    expect(consumption.subtotalCents).toBe(90 + 36 + 360)
    expect(consumption.baseSubtotalCents).toBe(100 + 40 + 400)
    // Todo cabe en el crédito de USD 29.
    expect(consumption).toMatchObject({ creditUsedCents: 486, overCreditCents: 0, creditExhaustedAt: null })
  })

  it("sin plan con precios cuenta las acciones sin importe", async () => {
    await ownerDb.update(saasPlan).set({ isDefault: false }).where(eq(saasPlan.code, "odentia-prueba-acciones"))
    const other = "org_b"
    const id = randomUUID()
    await ownerDb.insert(user).values({ id, name: "x", email: `${id}@x.test` })
    const consumption = await withOrgContext(appDb, other, (tx) => getSaasConsumption(tx, other))
    expect(consumption).toMatchObject({ priced: false, currency: null, subtotalCents: 0 })
    await ownerDb.update(saasPlan).set({ isDefault: true }).where(eq(saasPlan.code, "odentia-prueba-acciones"))
  })
})
