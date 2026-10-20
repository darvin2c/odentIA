import { randomUUID } from "node:crypto"
import { user } from "@odentia/db/schema/auth"
import { saasCommercialTerms, saasPlan, saasSignupPolicy, saasSubscription, saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { getActionPricing } from "./saas-actions.js"
import { chooseSaasPlan, createSaasPlan } from "./saas-billing.js"
import { SAAS_TERMS_INITIAL } from "./saas-commercial-terms.js"
import {
  claimFounderInvitation,
  clearExpiredDiscounts,
  completeFounderInvitation,
  discardWaitlistRequest,
  endFounderGuarantees,
  getPublicPricing,
  getSignupMode,
  inviteFromWaitlist,
  listExpiringTerms,
  readFounderInvitation,
  releaseFounderInvitation,
  setSignupMode,
  submitWaitlistRequest,
} from "./saas-founders.js"
import { decideSaasNegotiation, getSaasAlerts, setSaasDiscount } from "./saas-terms.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Fundadores (issue 165) y precio negociado con vencimiento (issue 168). */
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
    dentists: "2-3" as const,
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
    seatLimit: 2,
    guaranteeMonths: 12,
    showOnWeb: true,
  })
  foundersPlanId = founders.id
  // El plan de otra prueba con lugares no debe colarse como el plan por invitación.
  await ownerDb.update(saasPlan).set({ isActive: false }).where(eq(saasPlan.code, "fundadores-ficticio"))
})

describe("cómo se abren clínicas", () => {
  it("la migración deja «solo con invitación» y solo la administración lo cambia", async () => {
    expect(await getSignupMode(ownerDb)).toBe("invitacion")
    await expect(setSignupMode(ownerDb, support, "abierta")).rejects.toMatchObject({ code: "FORBIDDEN" })
    await setSignupMode(ownerDb, admin, "abierta")
    expect(await getSignupMode(ownerDb)).toBe("abierta")
    await setSignupMode(ownerDb, admin, "invitacion")
    const [row] = await ownerDb.select().from(saasSignupPolicy)
    expect(row?.updatedBy).toBe(admin.userId)
  })
})

describe("la lista de espera", () => {
  it("guarda la solicitud y no duplica un correo con una solicitud viva", async () => {
    const first = await submitWaitlistRequest(ownerDb, request("ana@sonrisa.test"))
    expect(first.existing).toBe(false)
    const again = await submitWaitlistRequest(ownerDb, { ...request("ANA@sonrisa.test"), clinicName: "Otra" })
    // El plazo que se promete es el que regía cuando llegó la solicitud.
    expect(again).toEqual({ id: first.id, existing: true, answerDays: 2 })
    const [row] = await ownerDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, first.id))
    expect(row).toMatchObject({ email: "ana@sonrisa.test", phone: "+51987654321", countryCode: "PE", status: "por_revisar" })
  })

  it("rechaza datos que no sirven con un mensaje claro", async () => {
    await expect(submitWaitlistRequest(ownerDb, { ...request("x@y.test"), phone: "abc" })).rejects.toMatchObject({
      message: "Escribe un celular válido, solo con números",
    })
  })

  it("descartar pide un motivo", async () => {
    const { id } = await submitWaitlistRequest(ownerDb, request("descartar@sonrisa.test"))
    await expect(discardWaitlistRequest(ownerDb, admin, id, "  ")).rejects.toMatchObject({ code: "VALIDATION" })
    await discardWaitlistRequest(ownerDb, admin, id, "Vende insumos")
    const [row] = await ownerDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, id))
    expect(row).toMatchObject({ status: "descartada", discardReason: "Vende insumos", tokenHash: null })
  })
})

describe("la invitación Fundadores", () => {
  it("respeta los lugares del plan: reenviar no ocupa otro y lleno no invita", async () => {
    const a = await submitWaitlistRequest(ownerDb, request("lugar-a@sonrisa.test"))
    const b = await submitWaitlistRequest(ownerDb, request("lugar-b@sonrisa.test"))
    const c = await submitWaitlistRequest(ownerDb, request("lugar-c@sonrisa.test"))
    const first = await inviteFromWaitlist(ownerDb, admin, a.id)
    expect(first.request.planId).toBe(foundersPlanId)
    await inviteFromWaitlist(ownerDb, admin, b.id)
    const resent = await inviteFromWaitlist(ownerDb, admin, a.id)
    expect(resent.token).not.toBe(first.token)
    // El enlace anterior deja de servir al reenviar.
    expect(await readFounderInvitation(ownerDb, first.token)).toBeNull()
    await expect(inviteFromWaitlist(ownerDb, admin, c.id)).rejects.toMatchObject({ code: "SAAS_SEATS_FULL" })
    await expect(inviteFromWaitlist(ownerDb, support, c.id)).rejects.toBeTruthy()
    // Liberar un lugar (descartar una invitada) deja invitar otra vez.
    await discardWaitlistRequest(ownerDb, admin, b.id, "No contestó")
    await inviteFromWaitlist(ownerDb, admin, c.id)
  })

  it("la invitación abre una sola clínica, solo con su correo, con el plan y la prueba del plan", async () => {
    await ownerDb.update(saasPlan).set({ seatLimit: 50 }).where(eq(saasPlan.id, foundersPlanId))
    const { id } = await submitWaitlistRequest(ownerDb, request("abre@sonrisa.test"))
    const { token } = await inviteFromWaitlist(ownerDb, admin, id)

    const offer = await readFounderInvitation(ownerDb, token)
    expect(offer).toMatchObject({ email: "abre@sonrisa.test", offer: { priceCents: 0, trialCreditCents: 10_000, discountPercent: 40, guaranteeMonths: 12 } })

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
    // Mientras valgan sus condiciones, la clínica no deja el plan Fundadores por error.
    await expect(chooseSaasPlan(ownerDb, orgId, admin.userId, "founders-lista")).rejects.toMatchObject({ code: "SAAS_FOUNDER_GUARANTEED" })
  })

  it("una invitación vencida no sirve", async () => {
    const { id } = await submitWaitlistRequest(ownerDb, request("vencida@sonrisa.test"))
    const { token } = await inviteFromWaitlist(ownerDb, admin, id, {}, new Date(Date.now() - 15 * DAY))
    expect(await readFounderInvitation(ownerDb, token)).toBeNull()
    await expect(claimFounderInvitation(ownerDb, token, "vencida@sonrisa.test")).rejects.toMatchObject({ code: "INVITATION_INVALID" })
  })

  it("una clínica no elige el plan por invitación por su cuenta", async () => {
    const orgId = await clinic()
    await expect(chooseSaasPlan(ownerDb, orgId, admin.userId, "founders-fundadores")).rejects.toMatchObject({ code: "SAAS_PLAN_BY_INVITATION" })
  })

  it("al terminar las condiciones garantizadas pasa al plan de lista", async () => {
    const orgId = await clinic({ planId: foundersPlanId, guaranteedUntil: new Date(Date.now() - 60_000) })
    const moved = await endFounderGuarantees(ownerDb)
    expect(moved).toContain(orgId)
    const [sub] = await ownerDb.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId))
    expect(sub).toMatchObject({ planId: listPlanId, guaranteedUntil: null })
  })
})

describe("lo que publica la web", () => {
  it("solo los planes con «Mostrar en la web», con el descuento contra la lista y sin lugares", async () => {
    const pricing = await getPublicPricing(ownerDb)
    expect(pricing.list?.code).toBe("founders-lista")
    expect(pricing.founders).toMatchObject({ code: "founders-fundadores", priceCents: 0, discountPercent: 40, guaranteeMonths: 12 })
    expect(JSON.stringify(pricing)).not.toContain("seatLimit")
    await ownerDb.update(saasPlan).set({ showOnWeb: false }).where(eq(saasPlan.id, foundersPlanId))
    expect((await getPublicPricing(ownerDb)).founders).toBeNull()
    await ownerDb.update(saasPlan).set({ showOnWeb: true }).where(eq(saasPlan.id, foundersPlanId))
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
