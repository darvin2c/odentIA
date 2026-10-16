import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { saasAction, saasNotice, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { createSaasPlan, tickSaasBilling, updateSaasPlan } from "./saas-billing.js"
import { checkActionPricing, planMarginScenario } from "./saas-actions.js"
import {
  decideSaasNegotiation,
  getAgentSpendGate,
  getSaasAlerts,
  listSaasNegotiations,
  setSaasDiscount,
  setSaasSpendCap,
  setSaasTrialTerms,
} from "./saas-terms.js"
import { insertOrg, ownerDb, appDb, setupTestDb } from "./test-setup.js"

/** Plan, prueba, descuentos, avisos y tope del cobro por acción (ADR 0030, fase 3). */
setupTestDb()
const admin = { userId: "terms-admin", role: "admin" as const }
const support = { userId: "terms-support", role: "support" as const }
let planId: string

async function clinic(status: "prueba" | "activa", over: Partial<typeof saasSubscription.$inferInsert> = {}) {
  const orgId = `terms-${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const now = Date.now()
  // La base ya crea la suscripción con la organización: se fija su estado.
  const values = {
    status,
    trialStartedAt: status === "prueba" ? new Date(now - 10 * 86_400_000) : null,
    trialEndsAt: status === "prueba" ? new Date(now + 20 * 86_400_000) : null,
    currentPeriodStart: new Date(now - 10 * 86_400_000),
    currentPeriodEnd: new Date(now + 20 * 86_400_000),
    planId: status === "activa" ? planId : null,
    ...over,
  }
  await ownerDb
    .insert(saasSubscription)
    .values({ organizationId: orgId, ...values })
    .onConflictDoUpdate({ target: saasSubscription.organizationId, set: values })
  const owner = randomUUID()
  await ownerDb.insert(user).values({ id: owner, name: "Marta", email: `${owner}@clinica.test` })
  await ownerDb.insert(member).values({ id: randomUUID(), userId: owner, organizationId: orgId, role: "owner", createdAt: new Date() })
  return orgId
}

/** Acciones ya contadas por un importe dado, a precio de conversación. */
async function spent(orgId: string, cents: number) {
  const each = 500_000
  const count = Math.round((cents * 10_000) / each)
  await ownerDb.insert(saasAction).values(
    Array.from({ length: count }, (_, index) => ({
      organizationId: orgId,
      kind: "conversacion",
      occurredAt: new Date(Date.now() - (index + 1) * 60_000),
      contactId: randomUUID(),
      detail: "Atendió una conversación por WhatsApp",
      currency: "USD",
      basePriceMicros: each,
      priceMicros: each,
      dedupeKey: randomUUID(),
    })),
  )
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Administración", email: "admin@terms.test" },
    { id: support.userId, name: "Ana Quispe", email: "ana@terms.test" },
  ])
  // Un plan por defecto anterior no debe impedir crear otro por defecto.
  await ownerDb.update(saasPlan).set({ isDefault: false })
  const plan = await createSaasPlan(ownerDb, admin.userId, {
    code: "terms-odentia",
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
  planId = plan.id
})

describe("precio mínimo", () => {
  it("ningún precio, al descuento máximo, queda bajo el doble de su peor costo", async () => {
    const checks = checkActionPricing({ conversationMicros: 500_000, consultationMicros: 400_000, recoveryMicros: 4_000_000, maxDiscountBps: 6000, currency: "USD" })
    expect(checks.find((item) => item.kind === "conversacion")).toMatchObject({ minimumMicros: 200_000, baseMultiple: 12.5, minimumMultiple: 5, ok: true })
    await expect(
      createSaasPlan(ownerDb, admin.userId, { code: "barato", name: "Barato", currency: "USD", priceCents: 2900, conversationMicros: 100_000, maxDiscountBps: 6000 }),
    ).rejects.toMatchObject({ code: "SAAS_PRICE_BELOW_FLOOR" })
    await expect(updateSaasPlan(ownerDb, admin.userId, planId, { maxDiscountBps: 9000 })).rejects.toMatchObject({ code: "SAAS_PRICE_BELOW_FLOOR" })
    // Nada se guardó.
    const [plan] = await ownerDb.select().from(saasPlan).where(eq(saasPlan.id, planId))
    expect(plan?.maxDiscountBps).toBe(6000)
  })

  it("el peor caso del plan deja margen a precio base y al mínimo", () => {
    expect(planMarginScenario({ priceCents: 2900, creditCents: 2900, conversationMicros: 500_000, maxDiscountBps: 6000, currency: "USD" })).toEqual({
      atBase: 86,
      atMinimum: 74,
    })
  })

  it("marcar otro plan por defecto desmarca el anterior", async () => {
    const other = await createSaasPlan(ownerDb, admin.userId, { code: "terms-otro", name: "Otro", currency: "USD", priceCents: 2900, isDefault: true })
    const defaults = await ownerDb.select({ id: saasPlan.id }).from(saasPlan).where(eq(saasPlan.isDefault, true))
    expect(defaults.map((row) => row.id)).toEqual([other.id])
    await updateSaasPlan(ownerDb, admin.userId, planId, { isDefault: true })
  })
})

describe("negociación", () => {
  it("el vendedor da hasta 10 %; más queda pedido y lo aprueba la administración", async () => {
    const orgId = await clinic("activa")
    expect(await setSaasDiscount(ownerDb, support, orgId, { discountBps: 1000 })).toEqual({ status: "aplicado", negotiationId: null })
    const asked = await setSaasDiscount(ownerDb, support, orgId, { discountBps: 1500, note: "Red de tres sedes" })
    expect(asked.status).toBe("pendiente")
    const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub?.discountBps).toBe(1000)
    await expect(decideSaasNegotiation(ownerDb, support, asked.negotiationId!, true)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await decideSaasNegotiation(ownerDb, admin, asked.negotiationId!, true)
    const [after] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(after?.discountBps).toBe(1500)
    expect((await listSaasNegotiations(ownerDb, { orgId }))[0]).toMatchObject({ status: "aprobada", requestedByName: "Ana Quispe" })
    // Nunca por debajo del precio mínimo, lo pida quien lo pida.
    await expect(setSaasDiscount(ownerDb, admin, orgId, { discountBps: 6500 })).rejects.toMatchObject({ code: "SAAS_PRICE_BELOW_FLOOR" })
  })

  it("una prueba por encima de USD 50 y 30 días pide aprobación; aprobada, mueve el fin", async () => {
    const orgId = await clinic("prueba")
    const asked = await setSaasTrialTerms(ownerDb, support, orgId, { trialCreditCents: 7500, trialDays: 45 })
    expect(asked.status).toBe("pendiente")
    await expect(setSaasTrialTerms(ownerDb, admin, orgId, { trialCreditCents: 20000, trialDays: 45 })).rejects.toMatchObject({ code: "VALIDATION" })
    await decideSaasNegotiation(ownerDb, admin, asked.negotiationId!, true)
    const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub).toMatchObject({ trialCreditCents: 7500, trialDays: 45 })
    expect(Math.round((sub!.trialEndsAt!.getTime() - sub!.trialStartedAt!.getTime()) / 86_400_000)).toBe(45)
  })
})

describe("avisos, alarma y límite", () => {
  it("el saldo de prueba avisa al 75 %, alarma al 90 % y al acabarse pausa a los agentes", async () => {
    // 25 días de prueba: a este ritmo el saldo no se acaba antes de que termine, así que el 80 % solo avisa.
    const orgId = await clinic("prueba", { trialStartedAt: new Date(Date.now() - 25 * 86_400_000), trialEndsAt: new Date(Date.now() + 5 * 86_400_000), currentPeriodStart: new Date(Date.now() - 25 * 86_400_000), currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000) })
    const read = () => withOrgContext(appDb, orgId, (tx) => getSaasAlerts(tx, orgId))
    expect((await read()).filter((alert) => alert.family === "saldo_prueba")).toEqual([])
    await spent(orgId, 4000)
    expect((await read()).map((alert) => [alert.family, alert.level])).toContainEqual(["saldo_prueba", "aviso"])
    expect((await read()).map((alert) => alert.family)).toContain("dias_prueba")
    await spent(orgId, 600)
    expect((await read()).find((alert) => alert.family === "saldo_prueba")?.level).toBe("alarma")
    await spent(orgId, 400)
    const paused = (await read()).find((alert) => alert.family === "saldo_prueba")
    expect(paused).toMatchObject({ level: "limite", action: "elegir_plan" })
    expect(paused?.message).toContain("en pausa")
    expect(await withOrgContext(appDb, orgId, (tx) => getAgentSpendGate(tx, orgId))).toEqual({ trialExhausted: true, capReached: false })
  })

  it("el ciclo manda cada aviso una sola vez, al propietario", async () => {
    const orgId = await clinic("prueba", { trialStartedAt: new Date(Date.now() - 25 * 86_400_000), trialEndsAt: new Date(Date.now() + 5 * 86_400_000), currentPeriodStart: new Date(Date.now() - 25 * 86_400_000), currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000) })
    await spent(orgId, 4000)
    await tickSaasBilling(ownerDb)
    await tickSaasBilling(ownerDb)
    const notices = await ownerDb.select().from(saasNotice).where(and(eq(saasNotice.organizationId, orgId), eq(saasNotice.kind, "saldo_prueba_aviso")))
    expect(notices).toHaveLength(1)
    expect(notices[0]?.emailTo).toContain("@clinica.test")
  })

  it("con plan activo, el tope avisa y al llegar corta los casos nuevos; el crédito usado no pausa", async () => {
    const orgId = await clinic("activa")
    await withOrgContext(appDb, orgId, (tx) => setSaasSpendCap(tx, orgId, "terms-admin", 1000))
    await spent(orgId, 2900 + 800)
    const alerts = await withOrgContext(appDb, orgId, (tx) => getSaasAlerts(tx, orgId))
    expect(alerts.map((alert) => [alert.family, alert.level])).toEqual(
      expect.arrayContaining([
        ["credito", "limite"],
        ["tope", "aviso"],
      ]),
    )
    await spent(orgId, 200)
    expect(await withOrgContext(appDb, orgId, (tx) => getAgentSpendGate(tx, orgId))).toEqual({ trialExhausted: false, capReached: true })
  })

  it("la demo no avisa ni se pausa", async () => {
    const orgId = await clinic("prueba", { isDemo: true })
    await spent(orgId, 6000)
    expect(await withOrgContext(appDb, orgId, (tx) => getSaasAlerts(tx, orgId))).toEqual([])
    await ownerDb.execute(sql`select 1`)
  })
})
