import { randomUUID } from "node:crypto"
import { aiUsage } from "@odentia/db/schema/agent"
import { channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import { reportQuestion } from "@odentia/db/schema/reports"
import {
  saasAction,
  saasPlan,
  saasSeller,
  saasSubscription,
  storageUsageDay,
} from "@odentia/db/schema/saas-billing"
import { eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { STORAGE_GB_BYTES } from "./saas-actions.js"
import {
  getClinicCostMargin,
  getCostMarginOverview,
  SAAS_FIXED_COST_MICROS,
  SAAS_STORAGE_COST_MICROS_PER_GB,
} from "./saas-cost.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/** Costo y margen de cada clínica (ADR 0085, tableros O2 y O3): cada gasto unido a su acción. */
setupTestDb()
const ORG = "org_a"
const FOUNDER = "org_b"
const HOUR = 3_600_000
const DAY = 24 * HOUR
let contactId: string
let conversationId: string
let encounterId: string

beforeAll(async () => {
  const [plan] = await ownerDb
    .insert(saasPlan)
    .values({
      code: "costo-normal",
      name: "Plan odentIA",
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationMicros: 500_000,
      consultationMicros: 500_000,
      recoveryMicros: 2_000_000,
      trialCreditCents: 0,
      trialMaxCreditCents: 0,
    })
    .returning()
  const [founders] = await ownerDb
    .insert(saasPlan)
    .values({
      code: "costo-fundadores",
      name: "Fundadores",
      currency: "USD",
      priceCents: 0,
      creditCents: 0,
      conversationMicros: 250_000,
      seatLimit: 20,
      trialCreditCents: 0,
      trialMaxCreditCents: 0,
    })
    .returning()
  const [seller] = await ownerDb
    .insert(saasSeller)
    .values({ displayName: "Carla Núñez", rateBps: 1000 })
    .returning()
  const now = Date.now()
  const active = (planId: string, activatedAt: Date) => ({
    status: "activa",
    isDemo: false,
    planId,
    activatedAt,
    currentPeriodStart: new Date(now - 10 * DAY),
    currentPeriodEnd: new Date(now + 20 * DAY),
  })
  await ownerDb
    .insert(saasSubscription)
    .values({
      organizationId: ORG,
      ...active(plan!.id, new Date(now - 10 * DAY)),
      // La atribución congela el % del vendedor en la suscripción.
      sellerId: seller!.id,
      sellerRateBps: 1000,
    })
    .onConflictDoUpdate({
      target: saasSubscription.organizationId,
      set: { ...active(plan!.id, new Date(now - 10 * DAY)), sellerId: seller!.id, sellerRateBps: 1000 },
    })
  // La Fundadora entró hace 70 días y nunca encendió un agente.
  await ownerDb
    .insert(saasSubscription)
    .values({ organizationId: FOUNDER, ...active(founders!.id, new Date(now - 70 * DAY)) })
    .onConflictDoUpdate({
      target: saasSubscription.organizationId,
      set: active(founders!.id, new Date(now - 70 * DAY)),
    })

  const [person] = await ownerDb
    .insert(contact)
    .values({ organizationId: ORG, displayName: "Lucía Ramos" })
    .returning()
  contactId = person!.id
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
  const [thread] = await ownerDb
    .insert(conversation)
    .values({
      organizationId: ORG,
      contactId,
      channelConnectionId: channel!.id,
      externalThreadId: randomUUID(),
    })
    .returning()
  conversationId = thread!.id
  encounterId = (await clinicalFixture()).encounter.id
})

describe("costo y margen de una clínica", () => {
  it("une cada gasto a su acción, cobra la cuota y lo que pasa del crédito, y descuenta la comisión", async () => {
    const at = new Date(Date.now() - 2 * DAY)
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
    await ownerDb
      .insert(saasAction)
      .values([
        action({ contactId, conversationId }),
        action({
          kind: "consulta",
          tier: "completa",
          encounterId,
          detail: "Ordenó la consulta dictada y armó el presupuesto por Ana Torres",
        }),
      ])
    const usage = (values: Partial<typeof aiUsage.$inferInsert>) => ({
      organizationId: ORG,
      origin: "recepcion",
      provider: "openai",
      model: "gpt-6-luna",
      calls: 1,
      ...values,
    })
    await ownerDb.insert(aiUsage).values([
      // Lo de Sofi en la ventana de su conversación, y lo de Jev aparte.
      usage({ conversationId, costMicros: 5_000, createdAt: new Date(at.getTime() + HOUR) }),
      usage({
        conversationId,
        provider: "jev",
        model: "jev-1.13.0",
        costMicros: 100,
        createdAt: new Date(at.getTime() + HOUR),
      }),
      // Dos pausas del dictado de esa atención.
      usage({ origin: "dictado", encounterId, calls: 2, costMicros: 3_000, createdAt: at }),
      // Argos responde preguntas incluidas.
      usage({ origin: "reportes", costMicros: 2_000, createdAt: at }),
    ])
    const [anyUser] = (await ownerDb.execute(
      sql`select id from "user" limit 1`,
    )) as unknown as Array<{ id: string }>
    await ownerDb
      .insert(reportQuestion)
      .values({
        organizationId: ORG,
        userId: anyUser!.id,
        outcome: "respondida",
        usedModel: true,
        createdAt: at,
      })
    await ownerDb
      .insert(storageUsageDay)
      .values({
        organizationId: ORG,
        day: new Date().toISOString().slice(0, 10),
        bytes: 10 * STORAGE_GB_BYTES,
      })

    const cost = await getClinicCostMargin(ownerDb, ORG)
    const line = (key: string) => cost.lines.find((item) => item.key === key)
    expect(line("sofi:gestiona")).toMatchObject({
      count: 1,
      chargedCents: 50,
      costMicros: 5_000,
      marginPct: 99,
    })
    expect(line("clio:completa")).toMatchObject({ count: 1, chargedCents: 50, costMicros: 3_000 })
    expect(line("clio:completa")?.detail).toEqual([
      expect.objectContaining({
        calls: 2,
        costMicros: 3_000,
        what: expect.stringContaining("Ana Torres"),
      }),
    ])
    expect(line("argos:preguntas")).toMatchObject({ count: 1, costMicros: 2_000, chargedCents: 0 })
    expect(line("jev")).toMatchObject({ costMicros: 100 })
    expect(line("no_ia:almacenamiento")).toMatchObject({
      costMicros: 10 * SAAS_STORAGE_COST_MICROS_PER_GB,
    })
    // La cuota de USD 29 vuelve como crédito: USD 1 de acciones no pasa del crédito.
    expect(cost.chargedCents).toBe(2900)
    expect(cost.aiMicros).toBe(10_100)
    expect(cost.costMicros).toBe(
      10_100 + 10 * SAAS_STORAGE_COST_MICROS_PER_GB + SAAS_FIXED_COST_MICROS,
    )
    expect(cost.commissionCents).toBe(290)
    expect(cost.sellerName).toBe("Carla Núñez")
    expect(cost.marginPct).toBe(Math.round((1 - cost.costMicros / 29_000_000) * 100))
    expect(cost).toMatchObject({ alarm: false, idle: false, founder: false })
  })

  it("las preguntas que pasan de las incluidas cuestan en la fila de los paquetes", async () => {
    const planOf = sql`(select plan_id from saas_subscription where organization_id = ${ORG})`
    // Con 0 incluidas y paquetes, la única pregunta del mes se pagó con un paquete.
    await ownerDb.execute(sql`update saas_plan set argos_pack_micros = 3000000, argos_included_questions = 0 where id = ${planOf}`)
    const cost = await getClinicCostMargin(ownerDb, ORG)
    const line = (key: string) => cost.lines.find((item) => item.key === key)
    expect(line("argos:preguntas")).toMatchObject({ count: 0, costMicros: 0 })
    expect(line("argos:paquetes")).toMatchObject({ costMicros: 2_000 })
    await ownerDb.execute(sql`update saas_plan set argos_pack_micros = null where id = ${planOf}`)
  })

  it("descuenta la comisión como se paga: el % congelado, la atribución abierta y solo los primeros meses", async () => {
    const commission = async () => (await getClinicCostMargin(ownerDb, ORG)).commissionCents
    // Cambiar el % del vendedor no toca lo atribuido a la clínica.
    await ownerDb.update(saasSeller).set({ rateBps: 3000 })
    expect(await commission()).toBe(290)
    // Pasados los meses que comisiona (12 al empezar), ya no se paga.
    await ownerDb.update(saasSubscription).set({ trialStartedAt: new Date(Date.now() - 400 * DAY) }).where(eq(saasSubscription.organizationId, ORG))
    expect(await commission()).toBe(0)
    // Con la atribución terminada, tampoco.
    await ownerDb.update(saasSubscription).set({ trialStartedAt: null, sellerEndedAt: new Date() }).where(eq(saasSubscription.organizationId, ORG))
    expect(await commission()).toBe(0)
    await ownerDb.update(saasSubscription).set({ sellerEndedAt: null }).where(eq(saasSubscription.organizationId, ORG))
    await ownerDb.update(saasSeller).set({ rateBps: 1000 })
  })

  it("la alarma interna avisa desde USD 30 de IA al mes, sin cortar nada", async () => {
    await ownerDb
      .insert(aiUsage)
      .values({
        organizationId: ORG,
        origin: "recepcion",
        provider: "openai",
        model: "gpt-6-luna",
        calls: 900,
        costMicros: 31_000_000,
        createdAt: new Date(),
      })
    expect(await getClinicCostMargin(ownerDb, ORG)).toMatchObject({ alarm: true })
  })
})

describe("todas las clínicas", () => {
  it("pone arriba lo que hay que revisar: la alarma y la Fundadora sin uso", async () => {
    const overview = await getCostMarginOverview(ownerDb)
    expect(overview.clinics.map((item) => [item.organizationId, item.alarm, item.idle])).toEqual([
      [ORG, true, false],
      [FOUNDER, false, true],
    ])
    expect(overview).toMatchObject({ founders: 1, chargedCents: 2900 })
  })
})
