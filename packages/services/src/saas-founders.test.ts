import { randomUUID } from "node:crypto"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import {
  saasCommercialTerms,
  saasFollowUp,
  saasPayment,
  saasPlan,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import { getActionPricing, planPrices } from "./saas-actions.js"
import { chooseSaasPlan, createSaasPlan, getPublicTrialOffer, listClinicPlans, startSaasTrial, updateSaasPlan } from "./saas-billing.js"
import { SAAS_TERMS_INITIAL } from "./saas-commercial-terms.js"
import {
  addWaitlistFollowUp,
  claimFounderInvitation,
  clearExpiredDiscounts,
  completeFounderInvitation,
  countWaitlistToReview,
  discardWaitlistRequest,
  endFounderGuarantees,
  followUpChoices,
  getPublicPricing,
  getSpecialPlanMove,
  getWaitlistRequest,
  hideWaitlistFollowUp,
  inviteFromWaitlist,
  listExpiringTerms,
  moveClinicToSpecialPlan,
  readFounderInvitation,
  releaseFounderInvitation,
  waitlistHomeRows,
  waitlistStage,
} from "./saas-founders.js"
import { decideSaasNegotiation, getOrganizationBillingTerms, getSaasAlerts, setSaasDiscount } from "./saas-terms.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { submitWaitlistRequest } from "./waitlist-test-kit.js"

/** Las solicitudes que quedaron, los planes especiales (ADR 0221) y el precio negociado con vencimiento (issue 168). */
setupTestDb()
const admin = { userId: "founders-admin", role: "admin" as const }
const support = { userId: "founders-support", role: "support" as const }
const DAY = 86_400_000
let listPlanId: string
let foundersPlanId: string

function request(email: string) {
  return {
    firstName: "Ana",
    lastName: "Quispe",
    email,
    phone: "+51 987 654 321",
    clinicName: "Clínica Sonrisa",
    countryCode: "pe",
    city: "Arequipa",
    professionals: "2-3" as const,
    currentTool: "cuaderno_excel" as const,
  }
}

async function clinic(over: Partial<typeof saasSubscription.$inferInsert> = {}) {
  const orgId = `founders-${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  if (Object.keys(over).length) await ownerDb.update(saasSubscription).set(over).where(eq(saasSubscription.organizationId, orgId))
  return orgId
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Administración", email: "admin@founders.test" },
    { id: support.userId, name: "Soporte", email: "support@founders.test" },
  ])
  await ownerDb.update(saasPlan).set({ isDefault: false })
  const list = await createSaasPlan(ownerDb, admin.userId, {
    code: "founders-lista",
    name: "Plan odentIA",
    currency: "USD",
    priceCents: 2900,
    creditCents: 2900,
    conversationMicros: 500_000,
    consultationMicros: 400_000,
    recoveryMicros: 4_000_000,
    trialCreditCents: 10_000,
    trialMaxCreditCents: 10_000,
    trialDays: 30,
    isDefault: true,
    showOnWeb: true,
  })
  listPlanId = list.id
  const founders = await createSaasPlan(ownerDb, admin.userId, {
    code: "founders-fundadores",
    name: "Fundadores",
    currency: "USD",
    priceCents: 0,
    creditCents: 0,
    conversationMicros: 300_000,
    consultationMicros: 240_000,
    recoveryMicros: 2_400_000,
    maxDiscountBps: 0,
    sellerDiscountBps: 0,
    trialCreditCents: 10_000,
    trialMaxCreditCents: 10_000,
    trialDays: 90,
    trialMaxDays: 90,
    guaranteeMonths: 12,
  })
  foundersPlanId = founders.id
  // Otros planes especiales de odentIA (de la semilla o de otra prueba) no deben colarse en lo que se ofrece.
  await ownerDb
    .update(saasPlan)
    .set({ isActive: false })
    .where(and(eq(saasPlan.product, "dental"), eq(saasPlan.showOnWeb, false), eq(saasPlan.isDefault, false), eq(saasPlan.isActive, true)))
  await ownerDb.update(saasPlan).set({ isActive: true }).where(eq(saasPlan.id, foundersPlanId))
})

describe("las solicitudes que quedaron", () => {
  it("descartar pide un motivo", async () => {
    const { id } = await submitWaitlistRequest(ownerDb, request("descartar@sonrisa.test"))
    await expect(discardWaitlistRequest(ownerDb, admin, id, "  ")).rejects.toMatchObject({ code: "VALIDATION" })
    await discardWaitlistRequest(ownerDb, admin, id, "Vende insumos")
    const [row] = await ownerDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, id))
    expect(row).toMatchObject({ status: "descartada", discardReason: "Vende insumos", tokenHash: null })
  })
})

describe("la invitación que manda el equipo", () => {
  it("sin plan elegido invita con el plan de lista; reenviar anula el enlace anterior y no hay lugares que se llenen", async () => {
    const a = await submitWaitlistRequest(ownerDb, request("lugar-a@sonrisa.test"))
    const b = await submitWaitlistRequest(ownerDb, request("lugar-b@sonrisa.test"))
    const c = await submitWaitlistRequest(ownerDb, request("lugar-c@sonrisa.test"))
    const first = await inviteFromWaitlist(ownerDb, admin, a.id)
    expect(first.request.planId).toBe(listPlanId)
    const resent = await inviteFromWaitlist(ownerDb, admin, a.id)
    expect(resent.token).not.toBe(first.token)
    // El enlace anterior deja de servir al reenviar.
    expect(await readFounderInvitation(ownerDb, first.token)).toBeNull()
    expect(await readFounderInvitation(ownerDb, resent.token)).toMatchObject({ offer: { planName: "Plan odentIA", discountPercent: null } })
    // Con el plan especial, tantas como se quiera.
    expect((await inviteFromWaitlist(ownerDb, admin, b.id, { planId: foundersPlanId })).request.planId).toBe(foundersPlanId)
    expect((await inviteFromWaitlist(ownerDb, admin, c.id, { planId: foundersPlanId })).request.planId).toBe(foundersPlanId)
  })

  it("sin plan de lista en su producto no invita", async () => {
    const { id } = await submitWaitlistRequest(ownerDb, request("optica@vista.test"), "optical")
    await expect(inviteFromWaitlist(ownerDb, admin, id)).rejects.toMatchObject({ code: "SAAS_NO_PLAN" })
  })

  it("la invitación abre una sola clínica, solo con su correo, con el plan y la prueba del plan", async () => {
    const { id } = await submitWaitlistRequest(ownerDb, request("abre@sonrisa.test"))
    const { token } = await inviteFromWaitlist(ownerDb, admin, id, { planId: foundersPlanId })

    const offer = await readFounderInvitation(ownerDb, token)
    expect(offer).toMatchObject({ email: "abre@sonrisa.test", offer: { planName: "Fundadores", priceCents: 0, trialCreditCents: 10_000, discountPercent: 40, guaranteeMonths: 12 } })

    await expect(claimFounderInvitation(ownerDb, token, "otra@persona.test")).rejects.toMatchObject({ code: "INVITATION_OTHER_EMAIL" })
    const claimed = await claimFounderInvitation(ownerDb, token, "Abre@Sonrisa.test")
    await expect(claimFounderInvitation(ownerDb, token, "abre@sonrisa.test")).rejects.toMatchObject({ code: "INVITATION_IN_USE" })
    // Si la creación falla, la invitación se libera y vuelve a servir.
    await releaseFounderInvitation(ownerDb, claimed)
    const again = await claimFounderInvitation(ownerDb, token, "abre@sonrisa.test")

    const orgId = await clinic()
    const now = new Date()
    await completeFounderInvitation(ownerDb, again, orgId, now)
    const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub?.planId).toBe(foundersPlanId)
    expect(sub?.status).toBe("prueba")
    expect(Math.round(((sub?.trialEndsAt?.getTime() ?? 0) - now.getTime()) / DAY)).toBe(90)
    expect(sub?.guaranteedUntil?.getUTCFullYear()).toBe(now.getUTCFullYear() + 1)
    const [row] = await ownerDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, id))
    expect(row).toMatchObject({ status: "entro", organizationId: orgId, tokenHash: null })
    expect(await readFounderInvitation(ownerDb, token)).toBeNull()
    await expect(claimFounderInvitation(ownerDb, token, "abre@sonrisa.test")).rejects.toMatchObject({ code: "INVITATION_INVALID" })
    // Mientras valgan sus precios garantizados, la clínica no deja el plan especial por error.
    await expect(chooseSaasPlan(ownerDb, orgId, admin.userId, "founders-lista")).rejects.toMatchObject({ code: "SAAS_FOUNDER_GUARANTEED" })
  })

  it("una invitación vencida no sirve", async () => {
    const { id } = await submitWaitlistRequest(ownerDb, request("vencida@sonrisa.test"))
    const { token } = await inviteFromWaitlist(ownerDb, admin, id, {}, new Date(Date.now() - 15 * DAY))
    expect(await readFounderInvitation(ownerDb, token)).toBeNull()
    await expect(claimFounderInvitation(ownerDb, token, "vencida@sonrisa.test")).rejects.toMatchObject({ code: "INVITATION_INVALID" })
  })

  it("una clínica no elige un plan especial por su cuenta: lo asigna la administración", async () => {
    const orgId = await clinic()
    await expect(chooseSaasPlan(ownerDb, orgId, admin.userId, "founders-fundadores")).rejects.toMatchObject({ code: "SAAS_PLAN_NOT_OFFERED" })
  })

  it("al terminar las condiciones garantizadas pasa al plan de lista", async () => {
    const orgId = await clinic({ planId: foundersPlanId, guaranteedUntil: new Date(Date.now() - 60_000) })
    const moved = await endFounderGuarantees(ownerDb)
    expect(moved).toContain(orgId)
    const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub).toMatchObject({ planId: listPlanId, guaranteedUntil: null })
  })
})

describe("pasar a un plan especial desde la administración", () => {
  it("una clínica en prueba pasa con el plan, su prueba desde hoy y sus meses garantizados, y se le quita el descuento", async () => {
    // Con un precio especial negociado en el plan de lista: el plan especial trae sus precios.
    const orgId = await clinic({ discountBps: 1000, discountEndsAt: new Date(Date.now() + 90 * DAY) })
    const now = new Date()
    const move = await getSpecialPlanMove(ownerDb, orgId, now)
    expect(move).toMatchObject({ listPlanName: "Plan odentIA" })
    // Solo los planes especiales de su producto: ni el de lista ni los de otra app.
    expect(move?.plans.map((plan) => plan.id)).toEqual([foundersPlanId])
    expect(move?.plans[0]).toMatchObject({ name: "Fundadores", guaranteeMonths: 12, trialDays: 90, trialCreditCents: 10_000 })
    expect(move?.plans[0]?.guaranteedUntil?.getUTCFullYear()).toBe(now.getUTCFullYear() + 1)

    const entered = await moveClinicToSpecialPlan(ownerDb, admin, orgId, foundersPlanId, now)
    expect(entered.planName).toBe("Fundadores")
    expect(entered.guaranteedUntil?.getUTCFullYear()).toBe(now.getUTCFullYear() + 1)
    const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub).toMatchObject({
      planId: foundersPlanId,
      status: "prueba",
      trialStartedAt: now,
      guaranteedUntil: entered.guaranteedUntil,
      discountBps: 0,
      discountEndsAt: null,
    })
    expect(Math.round(((sub?.trialEndsAt?.getTime() ?? 0) - now.getTime()) / DAY)).toBe(90)
    const [audit] = await ownerDb
      .select({ metadata: adminAudit.metadata })
      .from(adminAudit)
      .where(and(eq(adminAudit.organizationId, orgId), eq(adminAudit.action, "saas.founders_entered")))
    expect(audit?.metadata).toEqual({ planId: foundersPlanId, discountBps: 1000 })
    // La ficha dice a qué plan pasa, desde cuándo y a qué precios: los del plan de lista.
    const [list] = await ownerDb.select().from(saasPlan).where(eq(saasPlan.id, listPlanId))
    expect((await getOrganizationBillingTerms(ownerDb, orgId, now))?.next).toEqual({
      name: "Plan odentIA",
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      prices: planPrices(list!),
      startsAt: entered.guaranteedUntil,
    })
    // Ya tiene precios garantizados: no se ofrece ni pasa otra vez.
    expect(await getSpecialPlanMove(ownerDb, orgId)).toBeNull()
    await expect(moveClinicToSpecialPlan(ownerDb, admin, orgId, foundersPlanId)).rejects.toMatchObject({ code: "SPECIAL_PLAN_ALREADY" })

    // Terminados sus meses vuelve al plan de lista y, aunque siguiera en prueba, no vuelve a pasar.
    await ownerDb.update(saasSubscription).set({ guaranteedUntil: new Date(Date.now() - 60_000) }).where(eq(saasSubscription.organizationId, orgId))
    expect(await endFounderGuarantees(ownerDb)).toContain(orgId)
    expect((await getOrganizationBillingTerms(ownerDb, orgId))?.next).toBeNull()
    await ownerDb.update(saasSubscription).set({ status: "prueba" }).where(eq(saasSubscription.organizationId, orgId))
    await expect(moveClinicToSpecialPlan(ownerDb, admin, orgId, foundersPlanId)).rejects.toMatchObject({ code: "SPECIAL_PLAN_ALREADY" })
  })

  it("con sus condiciones vigentes pero ya en el plan de lista, la ficha no anuncia otro plan", async () => {
    const orgId = await clinic({ planId: listPlanId, status: "activa", guaranteedUntil: new Date(Date.now() + 400 * DAY) })
    const terms = await getOrganizationBillingTerms(ownerDb, orgId)
    expect(terms?.plan?.id).toBe(listPlanId)
    expect(terms?.next).toBeNull()
  })

  it("no pasa una demo, una clínica que ya paga ni una con precios garantizados, y solo Administración la pasa", async () => {
    const orgId = await clinic()
    await expect(moveClinicToSpecialPlan(ownerDb, support, orgId, foundersPlanId)).rejects.toMatchObject({ code: "FORBIDDEN" })

    const demo = await clinic({ isDemo: true })
    expect(await getSpecialPlanMove(ownerDb, demo)).toBeNull()
    await expect(moveClinicToSpecialPlan(ownerDb, admin, demo, foundersPlanId)).rejects.toMatchObject({ code: "SPECIAL_PLAN_DEMO" })
    const paying = await clinic({ planId: listPlanId, status: "activa" })
    expect(await getSpecialPlanMove(ownerDb, paying)).toBeNull()
    await expect(moveClinicToSpecialPlan(ownerDb, admin, paying, foundersPlanId)).rejects.toMatchObject({ code: "SPECIAL_PLAN_NOT_IN_TRIAL" })
    const guaranteed = await clinic({ guaranteedUntil: new Date(Date.now() + 30 * DAY) })
    expect(await getSpecialPlanMove(ownerDb, guaranteed)).toBeNull()
    await expect(moveClinicToSpecialPlan(ownerDb, admin, guaranteed, foundersPlanId)).rejects.toMatchObject({ code: "SPECIAL_PLAN_ALREADY" })
    // Nada de lo rechazado cambió de plan.
    for (const id of [orgId, demo, paying, guaranteed]) {
      const [sub] = await ownerDb.select({ planId: saasSubscription.planId }).from(saasSubscription).where(eq(saasSubscription.organizationId, id))
      expect(sub?.planId).not.toBe(foundersPlanId)
    }
  })

  it("no pasa a un plan que sale en la web, al de lista ni a uno que no existe: lo dice en el campo del plan", async () => {
    const orgId = await clinic()
    const shown = await createSaasPlan(ownerDb, admin.userId, {
      code: "founders-visible",
      name: "Visible",
      currency: "USD",
      priceCents: 1900,
      creditCents: 1900,
      conversationMicros: 400_000,
      trialCreditCents: 0,
      trialMaxCreditCents: 0,
      guaranteeMonths: 6,
      showOnWeb: true,
    })
    for (const planId of [shown.id, listPlanId, randomUUID()]) {
      await expect(moveClinicToSpecialPlan(ownerDb, admin, orgId, planId)).rejects.toMatchObject({ fields: { planId: expect.any(String) } })
    }
    for (const planId of [undefined, "no-es-un-id"]) {
      await expect(moveClinicToSpecialPlan(ownerDb, admin, orgId, planId)).rejects.toMatchObject({ fields: { planId: "Elige el plan" } })
    }
    expect((await getSpecialPlanMove(ownerDb, orgId))?.plans.map((plan) => plan.id)).toEqual([foundersPlanId])
    await ownerDb.update(saasPlan).set({ isActive: false }).where(eq(saasPlan.id, shown.id))
    const [sub] = await ownerDb.select({ planId: saasSubscription.planId }).from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub?.planId).not.toBe(foundersPlanId)
  })

  it("sin planes especiales en su producto no se ofrece nada, ni pasa a uno de otro producto", async () => {
    const orgId = await clinic()
    await ownerDb.update(orgProfile).set({ product: "optical" }).where(eq(orgProfile.organizationId, orgId))
    expect(await getSpecialPlanMove(ownerDb, orgId)).toBeNull()
    await expect(moveClinicToSpecialPlan(ownerDb, admin, orgId, foundersPlanId)).rejects.toMatchObject({ fields: { planId: expect.any(String) } })
  })
})

describe("lo que publica la web", () => {
  it("solo el plan de lista y las condiciones: ni planes especiales, ni lugares, ni plazo de la lista de espera", async () => {
    const pricing = await getPublicPricing(ownerDb)
    expect(Object.keys(pricing).sort()).toEqual(["list", "terms"])
    expect(pricing.list?.code).toBe("founders-lista")
    expect(pricing.terms).not.toHaveProperty("waitlistAnswerDays")
    const text = JSON.stringify(pricing)
    for (const word of ["seatLimit", "founders-fundadores", "signupMode"]) expect(text).not.toContain(word)
    // Mostrar en la web un plan especial no lo vuelve el de lista.
    await ownerDb.update(saasPlan).set({ showOnWeb: true }).where(eq(saasPlan.id, foundersPlanId))
    expect((await getPublicPricing(ownerDb)).list?.code).toBe("founders-lista")
    await ownerDb.update(saasPlan).set({ showOnWeb: false }).where(eq(saasPlan.id, foundersPlanId))
    // Sin plan de lista publicado, la web no tiene precio que mostrar.
    expect((await getPublicPricing(ownerDb, "optical")).list).toBeNull()
  })
})

describe("precio negociado con vencimiento", () => {
  it("rige hasta su último instante; después se cuenta a precio de lista", async () => {
    const orgId = await clinic({ planId: listPlanId, status: "activa" })
    const now = new Date()
    const endsAt = new Date(now.getTime() + 5 * DAY)
    await setSaasDiscount(ownerDb, admin, orgId, { discountBps: 2000, discountEndsAt: endsAt }, now)
    expect((await getActionPricing(ownerDb, orgId, now)).discountBps).toBe(2000)
    expect((await getActionPricing(ownerDb, orgId, new Date(endsAt.getTime() + 1))).discountBps).toBe(0)

    // Se avisa desde 15 días antes (las condiciones de hoy), a la clínica y en Inicio de la administración.
    const alerts = await getSaasAlerts(ownerDb, orgId, now)
    expect(alerts.find((alert) => alert.family === "precio_especial")).toMatchObject({ level: "aviso", action: "ver_plan" })
    expect((await listExpiringTerms(ownerDb, now)).some((row) => row.organizationId === orgId && row.kind === "precio_especial")).toBe(true)

    // Vencido, el ciclo lo limpia.
    await ownerDb.update(saasSubscription).set({ discountEndsAt: new Date(now.getTime() - 1000) }).where(eq(saasSubscription.organizationId, orgId))
    await clearExpiredDiscounts(ownerDb, now)
    const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub).toMatchObject({ discountBps: 0, discountEndsAt: null })
  })

  it("no acepta un vencimiento pasado, y sin fecha no vence", async () => {
    const orgId = await clinic({ planId: listPlanId, status: "activa" })
    await expect(setSaasDiscount(ownerDb, admin, orgId, { discountBps: 1000, discountEndsAt: new Date(Date.now() - DAY) })).rejects.toMatchObject({
      code: "VALIDATION",
    })
    await setSaasDiscount(ownerDb, admin, orgId, { discountBps: 1000 })
    const far = new Date(Date.now() + 3650 * DAY)
    expect((await getActionPricing(ownerDb, orgId, far)).discountBps).toBe(1000)
  })

  it("un pedido del vendedor guarda su vencimiento y aprobarlo lo aplica", async () => {
    const orgId = await clinic({ planId: listPlanId, status: "activa" })
    const endsAt = new Date(Date.now() + 30 * DAY)
    const outcome = await setSaasDiscount(ownerDb, support, orgId, { discountBps: 3000, discountEndsAt: endsAt })
    expect(outcome.status).toBe("pendiente")
    await decideSaasNegotiation(ownerDb, admin, outcome.negotiationId!, true)
    const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub?.discountBps).toBe(3000)
    expect(sub?.discountEndsAt?.getTime()).toBe(endsAt.getTime())
  })
})

describe("una lista de precios por producto (ADR 0093)", () => {
  let medicalListId: string
  let medicalFoundersId: string
  async function consultorio(over: Partial<typeof saasSubscription.$inferInsert> = {}) {
    const orgId = await clinic(over)
    await ownerDb.update(orgProfile).set({ product: "medical" }).where(eq(orgProfile.organizationId, orgId))
    return orgId
  }

  beforeAll(async () => {
    // latidIA empieza con una copia de la lista de odentIA; la prueba distinta deja ver de cuál sale.
    const list = await createSaasPlan(ownerDb, admin.userId, {
      code: "founders-lista-latidia",
      name: "Plan latidIA",
      product: "medical",
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationMicros: 500_000,
      consultationMicros: 400_000,
      recoveryMicros: 4_000_000,
      trialCreditCents: 10_000,
      trialMaxCreditCents: 10_000,
      trialDays: 45,
      trialMaxDays: 60,
      isDefault: true,
      showOnWeb: true,
    })
    medicalListId = list.id
    const founders = await createSaasPlan(ownerDb, admin.userId, {
      code: "founders-fundadores-latidia",
      name: "Fundadores latidIA",
      product: "medical",
      currency: "USD",
      priceCents: 0,
      creditCents: 0,
      conversationMicros: 250_000,
      consultationMicros: 200_000,
      recoveryMicros: 2_000_000,
      maxDiscountBps: 0,
      sellerDiscountBps: 0,
      trialCreditCents: 10_000,
      trialMaxCreditCents: 10_000,
      trialDays: 90,
      trialMaxDays: 90,
      guaranteeMonths: 12,
    })
    medicalFoundersId = founders.id
  })

  it("cada producto tiene su plan por defecto: marcar el de latidIA no desmarca el de odentIA", async () => {
    const defaults = await ownerDb.select({ code: saasPlan.code, product: saasPlan.product }).from(saasPlan).where(eq(saasPlan.isDefault, true))
    expect(defaults).toEqual(expect.arrayContaining([
      { code: "founders-lista", product: "dental" },
      { code: "founders-lista-latidia", product: "medical" },
    ]))
    expect(defaults).toHaveLength(2)
    // El producto se elige al crear y no cambia.
    await expect(updateSaasPlan(ownerDb, admin.userId, medicalListId, { product: "dental" })).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("cada web publica su propio plan de lista y su prueba", async () => {
    const medical = await getPublicPricing(ownerDb, "medical")
    expect(medical.list?.code).toBe("founders-lista-latidia")
    const dental = await getPublicPricing(ownerDb, "dental")
    expect(dental.list?.code).toBe("founders-lista")
    expect((await getPublicTrialOffer(ownerDb, "medical"))?.days).toBe(45)
    expect((await getPublicTrialOffer(ownerDb, "dental"))?.days).toBe(30)
  })

  it("la solicitud de latidIA se invita con un plan de latidIA: el de lista o su plan especial", async () => {
    const a = await submitWaitlistRequest(ownerDb, request("lugar-a@latido.test"), "medical")
    const b = await submitWaitlistRequest(ownerDb, request("lugar-b@latido.test"), "medical")
    // Con un plan de odentIA no se invita a una solicitud de latidIA.
    await expect(inviteFromWaitlist(ownerDb, admin, a.id, { planId: foundersPlanId })).rejects.toMatchObject({ code: "VALIDATION" })
    expect((await inviteFromWaitlist(ownerDb, admin, a.id)).request.planId).toBe(medicalListId)
    const special = await inviteFromWaitlist(ownerDb, admin, b.id, { planId: medicalFoundersId })
    expect(special.request.planId).toBe(medicalFoundersId)
    // Su descuento se compara con el plan de lista de latidIA.
    expect((await readFounderInvitation(ownerDb, special.token))?.offer.discountPercent).toBe(50)
  })

  it("un consultorio de latidIA en prueba ve y pasa solo a los planes especiales de latidIA", async () => {
    const orgId = await consultorio()
    const move = await getSpecialPlanMove(ownerDb, orgId)
    expect(move?.plans.map((plan) => plan.id)).toEqual([medicalFoundersId])
    expect(move?.listPlanName).toBe("Plan latidIA")
    await expect(moveClinicToSpecialPlan(ownerDb, admin, orgId, foundersPlanId)).rejects.toMatchObject({ fields: { planId: expect.any(String) } })
    await moveClinicToSpecialPlan(ownerDb, admin, orgId, medicalFoundersId)
    const [sub] = await ownerDb.select({ planId: saasSubscription.planId }).from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub?.planId).toBe(medicalFoundersId)
  })

  it("un consultorio de latidIA prueba, ve y elige solo los planes de latidIA", async () => {
    const orgId = await consultorio()
    // El disparador abre la prueba con la de odentIA (aún no sabe el producto); el alta la corrige.
    const sub = await startSaasTrial(ownerDb, orgId, { product: "medical" })
    expect(Math.round(((sub.trialEndsAt?.getTime() ?? 0) - (sub.trialStartedAt?.getTime() ?? 0)) / DAY)).toBe(45)
    expect((await listClinicPlans(ownerDb, orgId)).map((plan) => plan.code)).toEqual(["founders-lista-latidia"])
    await expect(chooseSaasPlan(ownerDb, orgId, admin.userId, "founders-lista")).rejects.toMatchObject({ code: "SAAS_PLAN_NOT_OFFERED" })
    await chooseSaasPlan(ownerDb, orgId, admin.userId, "founders-lista-latidia")
    // Y una clínica dental no entra con un plan de latidIA.
    const dentalOrg = `founders-${randomUUID().slice(0, 8)}`
    await insertOrg(ownerDb, dentalOrg, dentalOrg)
    await expect(startSaasTrial(ownerDb, dentalOrg, { planCode: "founders-lista-latidia" })).rejects.toMatchObject({ code: "VALIDATION" })
  })

  it("al terminar Fundadores latidIA pasa al Plan latidIA", async () => {
    const orgId = await consultorio({ planId: medicalFoundersId, guaranteedUntil: new Date(Date.now() + 30 * DAY) })
    // La ficha anuncia el plan de lista de su producto, no el de odentIA.
    expect((await getOrganizationBillingTerms(ownerDb, orgId))?.next?.name).toBe("Plan latidIA")
    await ownerDb.update(saasSubscription).set({ guaranteedUntil: new Date(Date.now() - 60_000) }).where(eq(saasSubscription.organizationId, orgId))
    expect(await endFounderGuarantees(ownerDb)).toContain(orgId)
    const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub).toMatchObject({ planId: medicalListId, guaranteedUntil: null })
  })
})

describe("el seguimiento de un prospecto", () => {
  // Mar 10 y mié 11 nov 2026 a las 10:00 de Lima (UTC-5, sin horario de verano).
  const TUE = new Date("2026-11-10T15:00:00Z")
  const WED = new Date("2026-11-11T15:00:00Z")
  // Jue 12 nov a las 9:00 de Lima.
  const THU = new Date("2026-11-12T14:00:00Z")

  async function waiting(email: string, createdAt = new Date(WED.getTime() - DAY)) {
    const { id } = await submitWaitlistRequest(ownerDb, request(email))
    await ownerDb.update(saasWaitlistRequest).set({ createdAt }).where(eq(saasWaitlistRequest.id, id))
    return id
  }
  const homeOf = async (actor: AdminActor, now: Date, id: string) => (await waitlistHomeRows(ownerDb, actor, now)).filter((row) => row.id === id)
  const entered = async (email: string, organizationId: string | null) => {
    const [row] = await ownerDb
      .insert(saasWaitlistRequest)
      .values({ ...request(email), phone: "+51987654321", countryCode: "PE", status: "entro", planId: foundersPlanId, enteredAt: WED, organizationId })
      .returning({ id: saasWaitlistRequest.id })
    return row!.id
  }

  it("las fechas para volver salen del día de Lima", () => {
    expect(followUpChoices(WED)).toEqual({
      today: "2026-11-11",
      tomorrow: "2026-11-12",
      inThreeBusinessDays: "2026-11-16",
      nextWeek: "2026-11-18",
      latest: "2027-11-11",
    })
    // Las 19:30 del miércoles en Lima ya son jueves en UTC: «hoy» sigue siendo miércoles.
    expect(followUpChoices(new Date("2026-11-12T00:30:00Z")).today).toBe("2026-11-11")
  })

  it("una invitación vencida está en «Invitación vencida» y sale en Inicio", async () => {
    const id = await waiting("vencio@andes.test")
    await inviteFromWaitlist(ownerDb, admin, id, {}, new Date(WED.getTime() - 15 * DAY))
    expect((await getWaitlistRequest(ownerDb, admin, id, WED)).request.stage).toBe("invitacion_vencida")
    expect(await homeOf(admin, WED, id)).toEqual([expect.objectContaining({ reason: "invitacion", stage: "invitacion_vencida", overdue: true })])
    expect(waitlistStage({ status: "invitada", inviteExpiresAt: WED }, false, WED)).toBe("invitacion_vencida")
  })

  it("entró sin un pago confirmado es «Entró», aunque la suscripción esté activa; con uno, «Paga»", async () => {
    const orgId = await clinic({ planId: listPlanId, status: "activa" })
    const paid = await entered("paga@andes.test", orgId)
    const stageOf = async (id: string) => (await getWaitlistRequest(ownerDb, admin, id, WED)).request.stage
    expect(await stageOf(paid)).toBe("entro")
    const payment = (status: "pendiente" | "confirmado") =>
      ownerDb.insert(saasPayment).values({
        organizationId: orgId,
        amountCents: 2900,
        currency: "USD",
        methodCode: "transferencia",
        status,
        idempotencyKey: randomUUID(),
        ...(status === "confirmado" ? { confirmedAt: WED, confirmedBy: admin.userId } : {}),
      })
    // Un comprobante por revisar todavía no es un pago.
    await payment("pendiente")
    expect(await stageOf(paid)).toBe("entro")
    await payment("confirmado")
    expect(await stageOf(paid)).toBe("paga")
    // La clínica borrada sigue en «Entró».
    expect(await stageOf(await entered("borrada@andes.test", null))).toBe("entro")
  })

  it("un seguimiento para el jueves no sale el miércoles a las 19:30 de Lima y sí el jueves a las 9:00", async () => {
    const id = await waiting("jueves@andes.test")
    await addWaitlistFollowUp(ownerDb, admin, id, { body: "Pide que la llame el jueves", followUpOn: "2026-11-12" }, TUE)
    expect(await homeOf(admin, new Date("2026-11-12T00:30:00Z"), id)).toEqual([])
    expect(await homeOf(admin, THU, id)).toEqual([
      expect.objectContaining({
        reason: null,
        followUp: expect.objectContaining({ on: "2026-11-12", overdue: false, body: "Pide que la llame el jueves", authorName: "Administración" }),
      }),
    ])
  })

  it("una solicitud sale una sola vez en Inicio: el seguimiento va en su fila", async () => {
    // Nadie le respondió: sale por su plazo, de lunes a viernes.
    const late = await waiting("plazo@andes.test", new Date("2026-11-06T15:00:00Z"))
    expect(await homeOf(admin, THU, late)).toEqual([
      expect.objectContaining({ reason: "por_responder", overdue: true, answer: expect.objectContaining({ due: "vencida", day: "2026-11-10" }) }),
    ])
    const onTime = await waiting("a-tiempo@andes.test", WED)
    expect((await getWaitlistRequest(ownerDb, admin, onTime, WED)).request.answer).toEqual(
      expect.objectContaining({ kind: "por_responder", due: "hasta", day: "2026-11-13" }),
    )
    // Anotar un contacto cuenta como haberle respondido (decisión 1 del acta).
    const before = await countWaitlistToReview(ownerDb, THU)
    await addWaitlistFollowUp(ownerDb, admin, late, { body: "La llamé, lo piensa" }, THU)
    expect(await homeOf(admin, THU, late)).toEqual([])
    expect(await countWaitlistToReview(ownerDb, THU)).toBe(before - 1)
    // Invitada que vence en dos días y con un seguimiento para hoy: una fila, con el seguimiento como segunda línea.
    const invited = await waiting("doble@andes.test")
    await inviteFromWaitlist(ownerDb, admin, invited, {}, new Date(THU.getTime() - 12 * DAY))
    await addWaitlistFollowUp(ownerDb, admin, invited, { body: "Lo ve con su socia", followUpOn: "2026-11-12" }, WED)
    const rows = await homeOf(admin, THU, invited)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ reason: "invitacion", stage: "invitada", followUp: { on: "2026-11-12", body: "Lo ve con su socia" } })
  })

  it("una descartada no sale en Inicio aunque tenga una fecha pendiente", async () => {
    const id = await waiting("descarta@andes.test")
    await addWaitlistFollowUp(ownerDb, admin, id, { body: "No contestó", followUpOn: "2026-11-12" }, WED)
    expect(await homeOf(admin, THU, id)).toHaveLength(1)
    await discardWaitlistRequest(ownerDb, admin, id, "Vende insumos")
    expect(await homeOf(admin, THU, id)).toEqual([])
    expect((await getWaitlistRequest(ownerDb, admin, id, THU)).request).toMatchObject({ stage: "descartada", nextFollowUpOn: null, answer: null })
    await expect(addWaitlistFollowUp(ownerDb, admin, id, { body: "Volvió a escribir", followUpOn: "2026-11-13" }, THU)).rejects.toMatchObject({
      fields: { followUpOn: expect.any(String) },
    })
  })

  it("soporte no lee lo que es solo de administración ni lo ve en Inicio, y lo suyo nunca es solo de administración", async () => {
    const id = await waiting("solo-admin@andes.test")
    await addWaitlistFollowUp(ownerDb, admin, id, { body: "Debe dos meses en su otro sistema", followUpOn: "2026-11-12", adminOnly: true }, TUE)
    const forSupport = await getWaitlistRequest(ownerDb, support, id, WED)
    expect(forSupport.entries).toEqual([
      expect.objectContaining({ adminOnly: true, body: null, followUpOn: "2026-11-12", authorName: "Administración" }),
    ])
    expect(JSON.stringify(forSupport)).not.toContain("Debe dos meses")
    expect((await getWaitlistRequest(ownerDb, admin, id, WED)).entries[0]?.body).toBe("Debe dos meses en su otro sistema")
    expect(await homeOf(support, THU, id)).toEqual([])
    expect(await homeOf(admin, THU, id)).toHaveLength(1)

    const own = await addWaitlistFollowUp(ownerDb, support, id, { body: "Le escribí por WhatsApp", adminOnly: true }, WED)
    expect(own.adminOnly).toBe(false)
    // Ocultar a soporte es de la administración y no se deshace.
    await expect(hideWaitlistFollowUp(ownerDb, support, own.id)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await hideWaitlistFollowUp(ownerDb, admin, own.id)
    expect((await getWaitlistRequest(ownerDb, support, id, WED)).entries[0]).toMatchObject({ id: own.id, adminOnly: true, body: null })
    await expect(ownerDb.update(saasFollowUp).set({ adminOnly: false }).where(eq(saasFollowUp.id, own.id))).rejects.toThrow()
  })

  it("una «Nota del equipo» de antes no es un contacto: la solicitud sigue por responder y no se dice «Contactada»", async () => {
    // Como la deja la migración 0101: sin autor, sin fecha para volver, con la fecha en que pidió.
    const createdAt = new Date("2026-11-06T15:00:00Z")
    const id = await waiting("nota-de-antes@andes.test", createdAt)
    const before = await countWaitlistToReview(ownerDb, THU)
    await ownerDb.insert(saasFollowUp).values({ requestId: id, authorUserId: null, body: "Pedirle a Ada que la llame: pregunta por el plan anual", fromNote: true, createdAt })
    expect(await countWaitlistToReview(ownerDb, THU)).toBe(before)
    expect(await homeOf(admin, THU, id)).toEqual([
      expect.objectContaining({ reason: "por_responder", answer: expect.objectContaining({ due: "vencida", day: "2026-11-10" }) }),
    ])
    const detail = await getWaitlistRequest(ownerDb, admin, id, THU)
    expect(detail.request.answer).toMatchObject({ kind: "por_responder", due: "vencida" })
    expect(detail.entries).toEqual([expect.objectContaining({ authorName: null, fromNote: true })])
    // Anotar un contacto sí: sale de «Prospectos por responder» y el plazo dice el día del contacto, no el de la nota.
    await addWaitlistFollowUp(ownerDb, admin, id, { body: "La llamé, lo piensa" }, THU)
    expect(await homeOf(admin, THU, id)).toEqual([])
    expect(await countWaitlistToReview(ownerDb, THU)).toBe(before - 1)
    expect((await getWaitlistRequest(ownerDb, admin, id, THU)).request.answer).toEqual({ kind: "contactada", day: "2026-11-12" })
  })

  it("la fila dice si su fecha es de una entrada solo de administración y si su invitación la tiene en Inicio", async () => {
    const id = await waiting("fecha-admin@andes.test")
    // La de administración, un día antes: con la misma hora, la última la decidiría el id al azar.
    await addWaitlistFollowUp(ownerDb, admin, id, { body: "Precio especial", followUpOn: "2026-11-12", adminOnly: true }, TUE)
    expect((await getWaitlistRequest(ownerDb, support, id, WED)).request).toMatchObject({ nextFollowUpOn: "2026-11-12", nextFollowUpAdminOnly: true })
    await addWaitlistFollowUp(ownerDb, support, id, { body: "Le escribí", followUpOn: "2026-11-12" }, WED)
    expect((await getWaitlistRequest(ownerDb, support, id, WED)).request).toMatchObject({ nextFollowUpAdminOnly: false, invitationSoon: false })
    // Invitada hace 12 de sus 14 días: está en Inicio por su invitación.
    await inviteFromWaitlist(ownerDb, admin, id, {}, new Date(WED.getTime() - 12 * DAY))
    expect((await getWaitlistRequest(ownerDb, support, id, WED)).request).toMatchObject({ invitationSoon: true })
  })

  it("la base no deja reescribir una entrada", async () => {
    const id = await waiting("inmutable@andes.test")
    const entry = await addWaitlistFollowUp(ownerDb, admin, id, { body: "La llamé" }, WED)
    await expect(ownerDb.update(saasFollowUp).set({ body: "Otra cosa" }).where(eq(saasFollowUp.id, entry.id))).rejects.toThrow()
  })

  it("«Mantener» guarda la misma fecha y anotar sin fecha cierra el seguimiento", async () => {
    const id = await waiting("mantener@andes.test")
    await addWaitlistFollowUp(ownerDb, admin, id, { body: "Pide que la llame el jueves", followUpOn: "2026-11-12" }, TUE)
    await addWaitlistFollowUp(ownerDb, admin, id, { body: "Preguntó el precio", followUpOn: "2026-11-12" }, WED)
    expect((await getWaitlistRequest(ownerDb, admin, id, WED)).request).toMatchObject({
      nextFollowUpOn: "2026-11-12",
      answer: { kind: "volver", day: "2026-11-12" },
    })
    await addWaitlistFollowUp(ownerDb, admin, id, { body: "No contestó" }, THU)
    expect((await getWaitlistRequest(ownerDb, admin, id, THU)).request).toMatchObject({
      nextFollowUpOn: null,
      answer: { kind: "contactada", day: "2026-11-12" },
    })
    expect(await homeOf(admin, THU, id)).toEqual([])
    // Un día pasado, uno a más de un año, uno que no existe o un texto vacío no se guardan:
    // el mes 13 y el día 32 tienen la forma de una fecha y dicen el campo, no un error del servidor.
    for (const followUpOn of ["2026-11-11", "2027-11-13", "12/11/2026", "2026-13-01", "2026-12-32", "2026-02-30"]) {
      await expect(addWaitlistFollowUp(ownerDb, admin, id, { body: "Otra vez", followUpOn }, THU)).rejects.toMatchObject({
        fields: { followUpOn: expect.any(String) },
      })
    }
    await expect(addWaitlistFollowUp(ownerDb, admin, id, { body: "   " }, THU)).rejects.toMatchObject({ fields: { body: expect.any(String) } })
    // La auditoría dice qué pasó, nunca el texto.
    const audits = await ownerDb
      .select({ metadata: adminAudit.metadata })
      .from(adminAudit)
      .where(and(eq(adminAudit.action, "saas.waitlist_follow_up"), eq(adminAudit.entityId, id)))
    expect(audits).toHaveLength(3)
    expect(JSON.stringify(audits)).not.toContain("precio")
  })
})

// Va al final: cambia las condiciones comerciales para lo que siga en este archivo.
it("el aviso del fin de un precio especial usa los días de las condiciones comerciales (ADR 0074)", async () => {
  const orgId = await clinic({ planId: listPlanId, status: "activa" })
  const now = new Date()
  await setSaasDiscount(ownerDb, admin, orgId, { discountBps: 1500, discountEndsAt: new Date(now.getTime() + 10 * DAY) }, now)
  const listed = async () => (await listExpiringTerms(ownerDb, now)).some((row) => row.organizationId === orgId && row.kind === "precio_especial")
  const alerted = async () => (await getSaasAlerts(ownerDb, orgId, now)).some((alert) => alert.family === "precio_especial")
  // Con 15 días de aviso, a 10 días del fin ya se avisa.
  expect(await listed()).toBe(true)
  expect(await alerted()).toBe(true)
  // La administración baja el aviso a 5 días: todavía no.
  await ownerDb.insert(saasCommercialTerms).values({ ...SAAS_TERMS_INITIAL, discountNoticeDays: 5, effectiveFrom: new Date(now.getTime() - 1) })
  expect(await listed()).toBe(false)
  expect(await alerted()).toBe(false)
})
