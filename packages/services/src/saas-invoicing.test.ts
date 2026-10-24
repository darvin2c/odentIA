import { randomUUID } from "node:crypto"
import { member, user } from "@odentia/db/schema/auth"
import {
  saasAction,
  saasCharge,
  saasChargeLine,
  saasCommercialTerms,
  saasPayment,
  saasPlan,
  saasSeller,
  saasSellerCommission,
  saasSubscription,
} from "@odentia/db/schema/saas-billing"
import { and, asc, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { confirmSaasPayment, createSaasPlan, tickSaasBilling } from "./saas-billing.js"
import { SAAS_TERMS_INITIAL } from "./saas-commercial-terms.js"
import { addMonth, closeSaasPeriods } from "./saas-invoicing.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Cobrar (ADR 0031, fase 4): el cargo del tramo con sus líneas, el mes anclado y la gracia. */
setupTestDb()
let planId: string
const admin = "invoice-admin"

async function clinic(over: Partial<typeof saasSubscription.$inferInsert> = {}) {
  const orgId = `inv-${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const values = { status: "activa", planId, ...over }
  await ownerDb.insert(saasSubscription).values({ organizationId: orgId, ...values }).onConflictDoUpdate({ target: saasSubscription.organizationId, set: values })
  const owner = randomUUID()
  await ownerDb.insert(user).values({ id: owner, name: "Marta", email: `${owner}@inv.test` })
  await ownerDb.insert(member).values({ id: randomUUID(), userId: owner, organizationId: orgId, role: "owner", createdAt: new Date() })
  return orgId
}

async function action(orgId: string, at: Date, micros = 500_000) {
  await ownerDb.insert(saasAction).values({
    organizationId: orgId,
    kind: "conversacion",
    tier: "gestiona",
    occurredAt: at,
    contactId: randomUUID(),
    detail: "Atendió una conversación por WhatsApp",
    currency: "USD",
    basePriceMicros: 500_000,
    priceMicros: micros,
    discountBps: micros === 500_000 ? 0 : 1000,
    dedupeKey: randomUUID(),
  })
}

const chargesOf = (orgId: string) =>
  ownerDb.select().from(saasCharge).where(eq(saasCharge.organizationId, orgId)).orderBy(asc(saasCharge.createdAt))
const linesOf = (chargeId: string) =>
  ownerDb.select().from(saasChargeLine).where(eq(saasChargeLine.chargeId, chargeId)).orderBy(asc(saasChargeLine.sortOrder))

beforeAll(async () => {
  await ownerDb.insert(user).values({ id: admin, name: "Administración", email: "admin@inv.test" })
  await ownerDb.update(saasPlan).set({ isDefault: false })
  const plan = await createSaasPlan(ownerDb, admin, {
    code: "inv-odentia",
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

describe("el mes de la clínica", () => {
  it("empieza el día que activa y el siguiente cae el mismo día (o el último del mes)", () => {
    expect(addMonth(new Date("2026-10-15T14:00:00Z")).toISOString()).toBe("2026-11-15T14:00:00.000Z")
    expect(addMonth(new Date("2026-01-31T10:00:00Z")).toISOString()).toBe("2026-02-28T10:00:00.000Z")
  })

  it("al terminar la prueba con plan elegido, pasa a activa sin cargo y su mes empieza ese día", async () => {
    const start = new Date("2026-09-01T12:00:00Z")
    const orgId = await clinic({ status: "prueba", trialStartedAt: start, trialEndsAt: new Date("2026-10-01T12:00:00Z") })
    const now = new Date("2026-10-01T13:00:00Z")
    await tickSaasBilling(ownerDb, now)
    const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub).toMatchObject({ status: "activa", activatedAt: now, currentPeriodStart: now, currentPeriodEnd: new Date("2026-11-01T13:00:00Z") })
    expect(await chargesOf(orgId)).toHaveLength(0)
  })
})

describe("cargo del tramo", () => {
  it("al cerrar: la cuota, lo que pasó del crédito por agente, lo que cubrió el crédito y el IGV", async () => {
    const start = new Date("2026-08-10T15:00:00Z")
    const end = new Date("2026-09-10T15:00:00Z")
    const orgId = await clinic({ activatedAt: start, currentPeriodStart: start, currentPeriodEnd: end })
    // 66 conversaciones a USD 0,45 (10 % negociado): USD 29,70; el crédito cubre 64 (USD 28,80) y
    // USD 0,20 de la 65: se cobra solo lo que pasó, USD 0,70 (el crédito vuelve íntegro, ADR 0031).
    for (let index = 0; index < 66; index++) await action(orgId, new Date(start.getTime() + (index + 1) * 3_600_000), 450_000)
    // Una acción del tramo siguiente no entra.
    await action(orgId, new Date(end.getTime() + 3_600_000), 450_000)
    const { issued } = await closeSaasPeriods(ownerDb, new Date("2026-09-10T16:00:00Z"))
    expect(issued).toBeGreaterThanOrEqual(1)
    const [charge] = await chargesOf(orgId)
    const lines = await linesOf(charge!.id)
    expect(lines.map((line) => [line.kind, line.quantity, line.amountCents])).toEqual([
      ["cuota", 1, 2900],
      ["conversacion", 2, 70],
      ["credito", 64, 0],
      // La clínica de prueba es de Perú: IGV de 18 %.
      ["impuesto", 1, Math.round((2900 + 70) * 0.18)],
    ])
    // Con parte de una acción cubierta, la línea dice solo su total.
    expect(lines[1]).toMatchObject({ unitBaseMicros: null, unitPriceMicros: null })
    expect(lines[2]?.description).toContain("y parte de otra por el crédito del mes (29.00 USD)")
    expect(charge).toMatchObject({ subtotalCents: 2970, taxCents: 535, amountCents: 3505, taxLabel: "IGV", currency: "USD" })
    // Abre el mes siguiente, el mismo día.
    const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub).toMatchObject({ currentPeriodStart: end, currentPeriodEnd: new Date("2026-10-10T15:00:00Z") })
    // Repetir no emite otro cargo ni cobra dos veces.
    await closeSaasPeriods(ownerDb, new Date("2026-09-10T17:00:00Z"))
    expect(await chargesOf(orgId)).toHaveLength(1)
    const charged = await ownerDb.select().from(saasAction).where(and(eq(saasAction.organizationId, orgId), eq(saasAction.chargeId, charge!.id)))
    expect(charged).toHaveLength(66)
  })

  it("quincenal: a los 15 días cobra lo que ya pasó del crédito y al cierre el resto, sin repetir", async () => {
    const start = new Date("2026-08-01T12:00:00Z")
    const end = new Date("2026-09-01T12:00:00Z")
    const orgId = await clinic({ activatedAt: start, currentPeriodStart: start, currentPeriodEnd: end, billingCycle: "quincenal" })
    for (let index = 0; index < 60; index++) await action(orgId, new Date(start.getTime() + (index + 1) * 3_600_000))
    for (let index = 0; index < 4; index++) await action(orgId, new Date(start.getTime() + 20 * 86_400_000 + index * 3_600_000))
    await closeSaasPeriods(ownerDb, new Date("2026-08-17T12:00:00Z"))
    const [half] = await chargesOf(orgId)
    // 60 × USD 0,50 = USD 30: el crédito cubre 58 y se cobran 2.
    expect((await linesOf(half!.id)).map((line) => [line.kind, line.quantity, line.amountCents])).toEqual([
      ["conversacion", 2, 100],
      ["credito", 58, 0],
      ["impuesto", 1, 18],
    ])
    await closeSaasPeriods(ownerDb, new Date("2026-09-01T13:00:00Z"))
    const all = await chargesOf(orgId)
    expect(all).toHaveLength(2)
    expect((await linesOf(all[1]!.id)).map((line) => [line.kind, line.quantity, line.amountCents])).toEqual([
      ["cuota", 1, 2900],
      ["conversacion", 4, 200],
      ["impuesto", 1, Math.round(3100 * 0.18)],
    ])
  })
})

describe("cobranza", () => {
  it("un cargo vencido abre la gracia; pagado vuelve a activa sin mover el mes; la comisión no lleva el IGV", async () => {
    const [seller] = await ownerDb.insert(saasSeller).values({ displayName: "Ana Quispe", rateBps: 1000 }).returning()
    const start = new Date("2026-06-05T12:00:00Z")
    const end = new Date("2026-07-05T12:00:00Z")
    const orgId = await clinic({
      activatedAt: start,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      sellerId: seller!.id,
      sellerRateBps: 1000,
      sellerWindowDays: 90,
      sellerStartedAt: start,
    })
    await tickSaasBilling(ownerDb, new Date("2026-07-05T13:00:00Z"))
    const [charge] = await chargesOf(orgId)
    expect(charge).toMatchObject({ amountCents: 3422, taxCents: 522 })
    await tickSaasBilling(ownerDb, new Date("2026-07-13T13:00:00Z"))
    let [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub?.status).toBe("gracia")
    // El pago lo registra la administración y se confirma: vuelve a activa con su mismo mes.
    const [payment] = await ownerDb
      .insert(saasPayment)
      .values({ organizationId: orgId, chargeId: charge!.id, amountCents: 3422, currency: "USD", methodCode: "transferencia", idempotencyKey: randomUUID() })
      .returning()
    await confirmSaasPayment(ownerDb, orgId, admin, payment!.id, new Date("2026-07-14T10:00:00Z"))
    ;[sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub?.status).toBe("activa")
    expect(sub?.currentPeriodStart).toEqual(end)
    const [commission] = await ownerDb.select().from(saasSellerCommission).where(eq(saasSellerCommission.organizationId, orgId))
    expect(commission).toMatchObject({ baseCents: 2900, commissionCents: 290 })
  })
})

// Va al final: agrega una versión de las condiciones comerciales para noviembre de 2026.
describe("condiciones comerciales (ADR 0074)", () => {
  it("el plazo de pago es el que rige al emitir el cargo; el día quincenal, el del inicio del tramo", async () => {
    // El 5 de noviembre se pasa a 10 días para pagar y al cobro quincenal a los 10 días.
    await ownerDb.insert(saasCommercialTerms).values({ ...SAAS_TERMS_INITIAL, paymentDays: 10, halfCycleDays: 10, effectiveFrom: new Date("2026-11-05T00:00:00Z") })
    // Su tramo empezó el 3, antes del cambio: sigue cobrando a los 15 días (el 18), no a los 10 (el 13).
    const early = await clinic({ activatedAt: new Date("2026-11-03T12:00:00Z"), currentPeriodStart: new Date("2026-11-03T12:00:00Z"), currentPeriodEnd: new Date("2026-12-03T12:00:00Z"), billingCycle: "quincenal" })
    // Su tramo empezó el 6, después del cambio: cobra a los 10 días.
    const late = await clinic({ activatedAt: new Date("2026-11-06T12:00:00Z"), currentPeriodStart: new Date("2026-11-06T12:00:00Z"), currentPeriodEnd: new Date("2026-12-06T12:00:00Z"), billingCycle: "quincenal" })
    for (const orgId of [early, late]) {
      for (let index = 0; index < 60; index++) await action(orgId, new Date(Date.UTC(2026, 10, 6, 13) + index * 60_000))
    }
    await closeSaasPeriods(ownerDb, new Date("2026-11-16T13:00:00Z"))
    expect(await chargesOf(early)).toHaveLength(0)
    const [half] = await chargesOf(late)
    // Emitido después del cambio: 10 días para pagar.
    expect(half?.dueAt).toEqual(new Date("2026-11-26T13:00:00Z"))
    await closeSaasPeriods(ownerDb, new Date("2026-11-18T13:00:00Z"))
    expect(await chargesOf(early)).toHaveLength(1)
  })
})
