import { randomUUID } from "node:crypto"
import { agentRunLedger, aiUsage } from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { encounterDictationSuggestion } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import { reportQuestion } from "@odentia/db/schema/reports"
import { saasAction, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { beforeAll, describe, expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { getClinicCostMargin } from "./saas-cost.js"
import {
  getClinicAgentCounts,
  getClinicCostActionDetail,
  listClinicCostActions,
  shortPersonName,
} from "./saas-cost-detail.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Cada acción con lo que nos costó (lienzo «Gastos por organización»): la
 * misma unión de gastos y acciones que «Costo y margen», las pausas de Clío,
 * las respuestas de Sofi y las preguntas a Argos con su costo exacto o
 * repartido, sin texto de mensajes ni nada clínico.
 */
setupTestDb()
const ORG = "org_a"
const HOUR = 3_600_000
const DAY = 24 * HOUR
const now = new Date()
const at = new Date(now.getTime() - 2 * DAY)
let conversationId: string
let looseConversationId: string
let encounterId: string
let professionalId: string
let patientId: string
let askerId: string
const ids: Record<string, string> = {}

beforeAll(async () => {
  const [plan] = await ownerDb
    .insert(saasPlan)
    .values({
      code: "detalle",
      name: "Plan odentIA",
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationMicros: 500_000,
      consultationMicros: 500_000,
      recoveryMicros: 2_000_000,
      argosIncludedQuestions: 300,
      argosPackMicros: 3_000_000,
      trialCreditCents: 0,
      trialMaxCreditCents: 0,
    })
    .returning()
  const period = {
    status: "activa",
    isDemo: false,
    planId: plan!.id,
    activatedAt: new Date(now.getTime() - 10 * DAY),
    currentPeriodStart: new Date(now.getTime() - 10 * DAY),
    currentPeriodEnd: new Date(now.getTime() + 20 * DAY),
  }
  await ownerDb
    .insert(saasSubscription)
    .values({ organizationId: ORG, ...period })
    .onConflictDoUpdate({ target: saasSubscription.organizationId, set: period })

  const [person] = await ownerDb
    .insert(contact)
    .values({
      organizationId: ORG,
      displayName: "Lucía Ramos Pérez",
      givenNames: "Lucía",
      familyName: "Ramos Pérez",
    })
    .returning()
  const [other] = await ownerDb
    .insert(contact)
    .values({ organizationId: ORG, displayName: "Número sin nombre" })
    .returning()
  const [channel] = await ownerDb
    .insert(channelConnection)
    .values({
      organizationId: ORG,
      channel: "whatsapp",
      provider: "prueba",
      displayName: "Canal",
      configEncrypted: "x",
      webhookSecret: "x",
    })
    .returning()
  const thread = async (contactId: string) =>
    (
      await ownerDb
        .insert(conversation)
        .values({
          organizationId: ORG,
          contactId,
          channelConnectionId: channel!.id,
          externalThreadId: randomUUID(),
        })
        .returning()
    )[0]!.id
  conversationId = await thread(person!.id)
  looseConversationId = await thread(other!.id)

  const fixture = await clinicalFixture()
  encounterId = fixture.encounter.id
  professionalId = fixture.encounter.professionalUserId
  patientId = fixture.encounter.patientId
  askerId = randomUUID()
  await ownerDb
    .insert(user)
    .values({ id: askerId, name: "Paula Ríos", email: `${askerId}@example.test` })
  await ownerDb.insert(member).values({
    id: randomUUID(),
    organizationId: ORG,
    userId: askerId,
    role: "cashier",
    createdAt: now,
  })

  const action = (values: Partial<typeof saasAction.$inferInsert>) => ({
    organizationId: ORG,
    kind: "conversacion",
    tier: "gestiona",
    occurredAt: at,
    detail: "Atendió una conversación y gestionó una cita por WhatsApp",
    currency: "USD",
    basePriceMicros: 500_000,
    priceMicros: 500_000,
    dedupeKey: randomUUID(),
    ...values,
  })
  const actions = await ownerDb
    .insert(saasAction)
    .values([
      action({ contactId: person!.id, conversationId, channel: "whatsapp" }),
      action({
        kind: "consulta",
        tier: "completa",
        encounterId,
        detail: "Ordenó la consulta dictada y armó el presupuesto por Clínico",
      }),
    ])
    .returning({ id: saasAction.id, kind: saasAction.kind })
  ids.sofi = actions.find((row) => row.kind === "conversacion")!.id
  ids.clio = actions.find((row) => row.kind === "consulta")!.id

  // Dos preguntas: una de antes de anotarse su costo (se reparte el del día) y otra con su costo.
  const ask = async (createdAt: Date, outcome: string, plan: Record<string, unknown> | null) =>
    (
      await ownerDb
        .insert(reportQuestion)
        .values({ organizationId: ORG, userId: askerId, outcome, usedModel: true, plan, createdAt })
        .returning()
    )[0]!.id
  const oldDay = new Date(now.getTime() - 5 * DAY)
  ids.old = await ask(oldDay, "respondida", {
    titulo: "Citas por canal · últimos 3 meses",
    fuente: "argos",
  })
  ids.asked = await ask(at, "respondida", {
    titulo: "Inasistencias por profesional · octubre",
    fuente: "oficial",
    pantalla: "agenda",
    sede: "Miraflores",
  })
  ids.patient = await ask(new Date(at.getTime() + 60_000), "respondida", {
    titulo: "Citas de Rosa Quispe · este año",
    paciente: randomUUID(),
  })
  ids.failed = await ask(at, "no_pudo", null)

  const usage = (values: Partial<typeof aiUsage.$inferInsert>) => ({
    organizationId: ORG,
    origin: "recepcion",
    provider: "openai",
    model: "gpt-6-luna",
    calls: 1,
    ...values,
  })
  const firstAnswer = new Date(at.getTime() + HOUR)
  const secondAnswer = new Date(at.getTime() + 2 * HOUR)
  const pause = (minutes: number) => new Date(at.getTime() - 30 * 60_000 + minutes * 60_000)
  await ownerDb.insert(aiUsage).values([
    // Sofi: dos respuestas de su conversación, y una de una conversación sin acción.
    usage({
      conversationId,
      costMicros: 800,
      inputTokens: 11_900,
      outputTokens: 120,
      createdAt: firstAnswer,
    }),
    usage({
      conversationId,
      costMicros: 1_500,
      calls: 2,
      inputTokens: 26_000,
      outputTokens: 280,
      createdAt: secondAnswer,
    }),
    usage({ conversationId: looseConversationId, costMicros: 900, createdAt: firstAnswer }),
    // Clío: dos pausas; lo de Jev de la segunda va en su fila, como en «Costo y margen».
    usage({
      origin: "dictado",
      encounterId,
      costMicros: 200,
      inputTokens: 1_840,
      outputTokens: 160,
      createdAt: pause(0),
    }),
    usage({ origin: "dictado", encounterId, costMicros: 300, createdAt: pause(2) }),
    usage({
      origin: "dictado",
      encounterId,
      provider: "jev",
      model: "jev-1.13.0",
      costMicros: 0,
      createdAt: pause(2),
    }),
    // Argos: lo de antes, sin pregunta; lo de ahora, con la suya.
    usage({ origin: "reportes", costMicros: 600, createdAt: new Date(oldDay.getTime() + 60_000) }),
    usage({
      origin: "reportes",
      provider: "jev",
      model: "jev-1.13.0",
      costMicros: 100,
      reportQuestionId: ids.asked,
      createdAt: at,
    }),
    usage({ origin: "reportes", costMicros: 150, reportQuestionId: ids.asked, createdAt: at }),
  ])
  await ownerDb.insert(agentRunLedger).values([
    {
      organizationId: ORG,
      conversationId,
      model: "gpt-6-luna",
      status: "ok",
      startedAt: new Date(firstAnswer.getTime() - 5_000),
      toolsUsed: ["send_reply"],
    },
    {
      organizationId: ORG,
      conversationId,
      model: "gpt-6-luna",
      status: "ok",
      startedAt: new Date(secondAnswer.getTime() - 5_000),
      toolsUsed: ["buscar_huecos", "confirmar_propuesta", "send_reply"],
    },
  ])
  // Lo que sugirió cada pausa, guardado justo después de su gasto.
  const suggestion = (kind: string, createdAt: Date, status: string) => ({
    organizationId: ORG,
    patientId,
    encounterId,
    professionalUserId: professionalId,
    kind: kind as never,
    payload: {},
    status,
    createdAt,
  })
  await ownerDb
    .insert(encounterDictationSuggestion)
    .values([
      suggestion("nota", new Date(pause(0).getTime() + 1_000), "confirmada"),
      suggestion("diagnostico", new Date(pause(2).getTime() + 1_000), "confirmada"),
      suggestion("diagnostico", new Date(pause(2).getTime() + 1_500), "descartada"),
    ])
})

describe("cada acción con lo que nos costó", () => {
  it("cuesta lo mismo que su fila de «Costo y margen» y nombra al paciente con la inicial y el apellido", async () => {
    const list = await listClinicCostActions(ownerDb, ORG, { now })
    const margin = await getClinicCostMargin(ownerDb, ORG, { now })
    const sofi = list.items.find((item) => item.key === `a:${ids.sofi}`)
    expect(sofi).toMatchObject({
      agent: "sofi",
      type: "Gestiona",
      who: "L. Ramos Pérez",
      whoDetail: "WhatsApp",
      chargedMicros: 500_000,
      costMicros: 2_300,
      steps: 2,
    })
    expect(sofi?.costMicros).toBe(
      margin.lines.find((line) => line.key === "sofi:gestiona")?.costMicros,
    )
    const clio = list.items.find((item) => item.key === `a:${ids.clio}`)
    expect(clio).toMatchObject({
      agent: "clio",
      type: "Completa",
      who: "Clínico",
      what: "Nota y diagnóstico",
      costMicros: 500,
      steps: 2,
      professionalId,
    })
    expect(clio?.costMicros).toBe(
      margin.lines.find((line) => line.key === "clio:completa")?.costMicros,
    )
  })

  it("las preguntas a Argos: costo exacto, repartido las de antes y «No cuenta» lo que no pudo", async () => {
    const { items, questions } = await listClinicCostActions(ownerDb, ORG, { agent: "argos", now })
    const question = (id: string) => items.find((item) => item.key === `q:${id}`)
    expect(question(ids.old!)).toMatchObject({
      who: "Paula Ríos",
      whoDetail: "Caja",
      what: "Citas por canal · últimos 3 meses",
      chargedNote: "1 de 300",
      costMicros: 600,
      spread: true,
    })
    expect(question(ids.asked!)).toMatchObject({
      outcome: "Respondida",
      chargedNote: "2 de 300",
      costMicros: 250,
      calls: 2,
      spread: false,
    })
    // El título de una pregunta sobre un paciente puede llevar su nombre: no se muestra.
    expect(question(ids.patient!)).toMatchObject({ what: "Una pregunta sobre un paciente" })
    expect(question(ids.failed!)).toMatchObject({
      outcome: "No pudo",
      chargedNote: "No cuenta",
      free: true,
      what: "El proveedor no respondió",
    })
    expect(questions).toEqual({ counted: 3, included: 300, free: 1 })
  })

  it("lo que no se cobró va aparte, y los filtros cuentan cada agente", async () => {
    const all = await listClinicCostActions(ownerDb, ORG, { now })
    const loose = all.items.find((item) => item.key === `c:${looseConversationId}`)
    expect(loose).toMatchObject({
      agent: "sofi",
      type: "Sin cobro",
      free: true,
      chargedMicros: null,
      costMicros: 900,
    })
    expect(all.counts).toMatchObject({ sofi: 2, clio: 1, argos: 4, sin_cobro: 2 })
    expect(all.freeCounts).toEqual({ sofi: 1, clio: 0 })
    const byProfessional = await listClinicCostActions(ownerDb, ORG, {
      agent: "clio",
      professionalId,
      now,
    })
    expect(byProfessional.items.map((item) => item.key)).toEqual([`a:${ids.clio}`])
    expect(all.days.some((day) => day.costMicros > 0)).toBe(true)
    expect(all.timezone).toBeTruthy()
  })
})

describe("de qué se compone una acción", () => {
  it("Clío: cada pausa con lo que sugirió y lo que quedó confirmado", async () => {
    const detail = await getClinicCostActionDetail(ownerDb, ORG, { key: `a:${ids.clio}`, now })
    expect(detail.steps.map((step) => [step.what, step.costMicros, step.model])).toEqual([
      ["Nota", 200, "gpt-6-luna"],
      ["Diagnóstico", 300, "gpt-6-luna"],
    ])
    expect(detail.facts[0]).toEqual({
      label: "Dejó hecho y confirmado",
      value: "Nota y diagnóstico",
    })
  })

  it("Sofi: cada respuesta con lo que hizo, sin el texto de los mensajes", async () => {
    const detail = await getClinicCostActionDetail(ownerDb, ORG, { key: `a:${ids.sofi}`, now })
    expect(detail.steps.map((step) => [step.what, step.calls, step.costMicros])).toEqual([
      ["Respondió", 1, 800],
      ["Buscó horarios libres y reservó la cita", 2, 1_500],
    ])
    expect(detail.costMicros).toBe(2_300)
  })

  it("Argos: lo que entendió y sus llamadas; la repartida lo dice", async () => {
    const asked = await getClinicCostActionDetail(ownerDb, ORG, { key: `q:${ids.asked}`, now })
    expect(asked.facts).toEqual(
      expect.arrayContaining([
        { label: "Lo que entendió", value: "Inasistencias por profesional · octubre" },
        { label: "De dónde sale", value: "Una cifra oficial de Reportes" },
        { label: "Sede", value: "Miraflores" },
        { label: "Llevó a", value: "Agenda" },
      ]),
    )
    expect(asked.steps.map((step) => step.what)).toEqual([
      "Jev decidió qué se preguntaba",
      "Escribió la consulta",
    ])
    const old = await getClinicCostActionDetail(ownerDb, ORG, { key: `q:${ids.old}`, now })
    expect(old).toMatchObject({ spread: true, steps: [], costMicros: 600 })
    await expect(
      getClinicCostActionDetail(ownerDb, ORG, { key: `a:${randomUUID()}`, now }),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe("lo que ve soporte", () => {
  it("cuántas cosas hicieron los agentes, sin importes", async () => {
    const counts = await getClinicAgentCounts(ownerDb, ORG, now)
    expect(counts).toMatchObject({
      sofi: { conversations: 1, byTier: { informa: 0, gestiona: 1, agenda: 0 } },
      clio: { consultations: 1, byTier: { simple: 0, estandar: 0, completa: 1 } },
      argos: { questions: 3, included: 300, limited: true, recovered: 0 },
    })
    expect(JSON.stringify(counts)).not.toMatch(/Micros|Cents/)
  })
})

describe("el nombre del paciente", () => {
  it("la inicial del nombre y los apellidos; sin ellos, lo que se pueda del nombre", () => {
    expect(
      shortPersonName({ givenNames: "Lucía María", familyName: "Ramos Pérez", displayName: "x" }),
    ).toBe("L. Ramos Pérez")
    expect(
      shortPersonName({ givenNames: null, familyName: null, displayName: "Rosa Quispe" }),
    ).toBe("R. Quispe")
    expect(shortPersonName({ givenNames: null, familyName: null, displayName: "Rosa" })).toBe(
      "Rosa",
    )
  })
})
