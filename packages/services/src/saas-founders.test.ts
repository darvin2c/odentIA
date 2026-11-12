import { randomUUID } from "node:crypto"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import {
  saasCommercialTerms,
  saasFollowUp,
  saasPayment,
  saasPlan,
  saasSignupPolicy,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import { and, eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import { getActionPricing } from "./saas-actions.js"
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
  getSignupMode,
  getSignupModes,
  getWaitlistRequest,
  hideWaitlistFollowUp,
  inviteFromWaitlist,
  listExpiringTerms,
  listWaitlist,
  readFounderInvitation,
  releaseFounderInvitation,
  setSignupMode,
  setWaitlistNote,
  submitWaitlistRequest,
  WAITLIST_STAGES,
  type WaitlistInput,
  waitlistHomeRows,
  waitlistStage,
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

  it("guarda el producto del dominio y pregunta por quien atiende con su palabra (decisión 17 del issue 229)", async () => {
    const { id } = await submitWaitlistRequest(ownerDb, request("vela@sanmartin.test"), "medical")
    const [row] = await ownerDb.select().from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, id))
    expect(row?.product).toBe("medical")
    const { professionals: _, ...without } = request("sinrespuesta@sanmartin.test")
    await expect(submitWaitlistRequest(ownerDb, without as WaitlistInput, "medical")).rejects.toMatchObject({
      message: "Elige cuántos médicos atienden",
    })
    await expect(submitWaitlistRequest(ownerDb, without as WaitlistInput)).rejects.toMatchObject({
      message: "Elige cuántos odontólogos atienden",
    })
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
      seatLimit: 1,
      guaranteeMonths: 12,
      showOnWeb: true,
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

  it("cada web publica su lista y su oferta, con el descuento contra su propio plan de lista", async () => {
    const medical = await getPublicPricing(ownerDb, "medical")
    expect(medical.list?.code).toBe("founders-lista-latidia")
    expect(medical.founders).toMatchObject({ code: "founders-fundadores-latidia", discountPercent: 50 })
    const dental = await getPublicPricing(ownerDb, "dental")
    expect(dental.list?.code).toBe("founders-lista")
    expect(dental.founders).toMatchObject({ code: "founders-fundadores", discountPercent: 40 })
    expect((await getPublicTrialOffer(ownerDb, "medical"))?.days).toBe(45)
    expect((await getPublicTrialOffer(ownerDb, "dental"))?.days).toBe(30)
  })

  it("cada producto decide si se entra con invitación o libre", async () => {
    await setSignupMode(ownerDb, admin, "abierta", "medical")
    expect(await getSignupModes(ownerDb)).toEqual({ dental: "invitacion", medical: "abierta", optical: "invitacion" })
    expect((await getPublicPricing(ownerDb, "medical")).signupMode).toBe("abierta")
    // vistIA tiene su propia columna: abrirla no abre las otras.
    await setSignupMode(ownerDb, admin, "abierta", "optical")
    expect(await getSignupModes(ownerDb)).toEqual({ dental: "invitacion", medical: "abierta", optical: "abierta" })
    await setSignupMode(ownerDb, admin, "invitacion", "medical")
    await setSignupMode(ownerDb, admin, "invitacion", "optical")
    expect(await getSignupModes(ownerDb)).toEqual({ dental: "invitacion", medical: "invitacion", optical: "invitacion" })
  })

  it("la solicitud de latidIA entra con Fundadores latidIA y gasta sus propios lugares", async () => {
    const a = await submitWaitlistRequest(ownerDb, request("lugar-a@latido.test"), "medical")
    const b = await submitWaitlistRequest(ownerDb, request("lugar-b@latido.test"), "medical")
    // Con un plan de odentIA no se invita a una solicitud de latidIA.
    await expect(inviteFromWaitlist(ownerDb, admin, a.id, { planId: foundersPlanId })).rejects.toMatchObject({ code: "VALIDATION" })
    const invited = await inviteFromWaitlist(ownerDb, admin, a.id)
    expect(invited.request.planId).toBe(medicalFoundersId)
    // Su único lugar está ocupado; los de odentIA no cuentan.
    await expect(inviteFromWaitlist(ownerDb, admin, b.id)).rejects.toMatchObject({ code: "SAAS_SEATS_FULL" })
    const dental = await submitWaitlistRequest(ownerDb, request("sigue@sonrisa.test"))
    expect((await inviteFromWaitlist(ownerDb, admin, dental.id)).request.planId).toBe(foundersPlanId)
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
    const orgId = await consultorio({ planId: medicalFoundersId, guaranteedUntil: new Date(Date.now() - 60_000) })
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
    const expired = await listWaitlist(ownerDb, { stage: "invitacion_vencida", search: "vencio@andes.test" }, WED)
    expect(expired.rows.map((row) => [row.id, row.stage])).toEqual([[id, "invitacion_vencida"]])
    expect((await listWaitlist(ownerDb, { stage: "invitada", search: "vencio@andes.test" }, WED)).rows).toEqual([])
    expect(await homeOf(admin, WED, id)).toEqual([expect.objectContaining({ reason: "invitacion", stage: "invitacion_vencida", overdue: true })])
    expect(waitlistStage({ status: "invitada", inviteExpiresAt: WED }, false, WED)).toBe("invitacion_vencida")
  })

  it("entró sin un pago confirmado es «Entró», aunque la suscripción esté activa; con uno, «Paga»", async () => {
    const orgId = await clinic({ planId: listPlanId, status: "activa" })
    await entered("paga@andes.test", orgId)
    const stageOf = async (email: string) => (await listWaitlist(ownerDb, { stage: "todas", search: email }, WED)).rows[0]?.stage
    expect(await stageOf("paga@andes.test")).toBe("entro")
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
    expect(await stageOf("paga@andes.test")).toBe("entro")
    await payment("confirmado")
    expect(await stageOf("paga@andes.test")).toBe("paga")
    expect((await listWaitlist(ownerDb, { stage: "paga", search: "paga@andes.test" }, WED)).rows).toHaveLength(1)
    // La clínica borrada sigue en «Entró».
    await entered("borrada@andes.test", null)
    expect(await stageOf("borrada@andes.test")).toBe("entro")
  })

  it("los conteos por etapa suman «Todas» y cada etapa trae solo las suyas", async () => {
    const page = await listWaitlist(ownerDb, { stage: "todas" }, WED)
    const { todas, ...stages } = page.counts
    expect(Object.keys(stages).sort()).toEqual([...WAITLIST_STAGES].sort())
    expect(Object.values(stages).reduce((sum, n) => sum + n, 0)).toBe(todas)
    const [all] = await ownerDb.select({ n: sql<number>`count(*)::int` }).from(saasWaitlistRequest)
    expect(todas).toBe(all?.n)
    for (const stage of WAITLIST_STAGES) {
      const { rows } = await listWaitlist(ownerDb, { stage }, WED)
      expect(rows.every((row) => row.stage === stage)).toBe(true)
      expect(rows).toHaveLength(Math.min(stages[stage], 200))
    }
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

  it("la nota de una pestaña vieja se agrega como entrada y no cierra el recordatorio", async () => {
    const id = await waiting("pestana@andes.test")
    await addWaitlistFollowUp(ownerDb, admin, id, { body: "Pide que la llame el jueves", followUpOn: "2026-11-12" }, TUE)
    await setWaitlistNote(ownerDb, support, id, "  Preguntó el precio  ", WED)
    // Sin texto no hace nada.
    await setWaitlistNote(ownerDb, support, id, null, WED)
    const { request: row, entries } = await getWaitlistRequest(ownerDb, admin, id, WED)
    expect(entries.map((entry) => [entry.body, entry.followUpOn, entry.authorName])).toEqual([
      ["Preguntó el precio", "2026-11-12", "Soporte"],
      ["Pide que la llame el jueves", "2026-11-12", "Administración"],
    ])
    expect(row.nextFollowUpOn).toBe("2026-11-12")
    const [stored] = await ownerDb.select({ note: saasWaitlistRequest.note }).from(saasWaitlistRequest).where(eq(saasWaitlistRequest.id, id))
    expect(stored?.note).toBeNull()
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
    // La nota de una pestaña vieja tampoco es un contacto.
    await setWaitlistNote(ownerDb, support, id, "Pregunta si hay plan anual", THU)
    expect((await getWaitlistRequest(ownerDb, admin, id, THU)).entries[0]).toMatchObject({ fromNote: true })
    expect(await homeOf(admin, THU, id)).toHaveLength(1)
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
