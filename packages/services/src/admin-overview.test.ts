import { user } from "@odentia/db/schema/auth"
import { saasWaitlistRequest } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import type { AdminActor } from "./admin-core.js"
import { getBackofficeOverview, getBackofficeToday } from "./admin-overview.js"
import { openSupportCaseFromHelp } from "./admin-support.js"
import { createSaasPlan } from "./saas-billing.js"
import { addWaitlistFollowUp, followUpChoices, inviteFromWaitlist, submitWaitlistRequest } from "./saas-founders.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/** Inicio de la administración: filas con nombre para administración y soporte. */
setupTestDb()
const admin: AdminActor = { userId: "ov-admin", role: "admin" }
const support: AdminActor = { userId: "ov-support", role: "support" }
const ORG = "ov-org"
const OWNER = "ov-owner"
const DAY = 86_400_000
const NOW = new Date()
const BILLING_QUESTION = "Me cobraron USD 29.00 dos veces este mes"
const QUESTION = "¿Cómo cambio el horario de la sede del centro?"
let planId: string
let billingCase: string
let questionCase: string

function request(email: string) {
  return {
    firstName: "Rosa",
    lastName: "Mamani",
    email,
    phone: "+51 987 654 321",
    clinicName: "Clínica Inicio",
    countryCode: "pe",
    city: "Cusco",
    professionals: "2-3" as const,
    currentTool: "cuaderno_excel" as const,
  }
}

/** Una solicitud que llegó en `createdAt`. */
async function waiting(email: string, createdAt = NOW): Promise<string> {
  const { id } = await submitWaitlistRequest(ownerDb, request(email))
  await ownerDb.update(saasWaitlistRequest).set({ createdAt }).where(eq(saasWaitlistRequest.id, id))
  return id
}

const helpCase = async (kind: "cobro" | "pregunta", question: string) =>
  (
    await openSupportCaseFromHelp(ownerDb, ORG, {
      userId: OWNER,
      kind,
      question,
      detail: null,
      screen: kind === "cobro" ? "/billing/acciones" : "/agenda",
      role: "Propietario",
      appVersion: null,
      dedupeKey: `ov:${question}`,
    })
  ).id

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Administración", email: "ada@overview.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@overview.test" },
    { id: OWNER, name: "Dueña Inicio", email: "duena@overview.test" },
  ])
  await insertOrg(ownerDb, ORG, "ov-clinica")
  // El plan por invitación con lugares de sobra: invitar no depende de otra prueba.
  const plan = await createSaasPlan(ownerDb, admin.userId, {
    code: "ov-fundadores",
    name: "Fundadores Inicio",
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
    seatLimit: 50,
    guaranteeMonths: 12,
  })
  planId = plan.id
  billingCase = await helpCase("cobro", BILLING_QUESTION)
  questionCase = await helpCase("pregunta", QUESTION)
})

describe("Inicio de la administración", () => {
  it("a soporte no le llega ningún importe, ninguna fila de cobro ni el texto de un caso", async () => {
    const today = await getBackofficeToday(ownerDb, support, NOW)
    const text = JSON.stringify(today)
    expect(today.support.map((row) => row.id)).toContain(questionCase)
    expect(today.support.map((row) => row.id)).not.toContain(billingCase)
    expect(today.support.every((row) => row.kind !== "cobro")).toBe(true)
    for (const word of ["USD", "creditLeftCents", "amountCents", BILLING_QUESTION, QUESTION]) expect(text).not.toContain(word)

    const overview = await getBackofficeOverview(ownerDb, support, { now: NOW })
    expect(JSON.stringify(overview)).not.toContain("USD")
    expect(overview.items.map((item) => item.path)).not.toContain("/billing")
    expect(overview.expiring).toEqual([])

    // La administración sí ve el caso de cobro, también sin su texto.
    const adminToday = await getBackofficeToday(ownerDb, admin, NOW)
    expect(adminToday.support.map((row) => row.id)).toContain(billingCase)
    expect(JSON.stringify(adminToday)).not.toContain(BILLING_QUESTION)
  })

  it("lo vencido va arriba", async () => {
    const fresh = await waiting("hoy@inicio.test")
    const late = await waiting("tarde@inicio.test", new Date(NOW.getTime() - 10 * DAY))
    const ids = (await getBackofficeToday(ownerDb, admin, NOW)).prospects.map((row) => row.id)
    expect(ids).toContain(fresh)
    expect(ids.indexOf(late)).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf(late)).toBeLessThan(ids.indexOf(fresh))
    const [row] = (await getBackofficeToday(ownerDb, admin, NOW)).prospects.filter((item) => item.id === late)
    expect(row).toMatchObject({ reason: "por_responder", overdue: true, answer: expect.objectContaining({ due: "vencida" }) })
  })

  it("una solicitud sale una sola vez: su seguimiento de hoy va en la misma fila", async () => {
    const id = await waiting("doble@inicio.test")
    // Invitada hace 12 días: su enlace de 14 vence en 2.
    await inviteFromWaitlist(ownerDb, admin, id, { planId }, new Date(NOW.getTime() - 12 * DAY))
    await addWaitlistFollowUp(ownerDb, support, id, { body: "Lo ve con su socia", followUpOn: followUpChoices(NOW).today }, NOW)
    const rows = (await getBackofficeToday(ownerDb, support, NOW)).prospects.filter((row) => row.id === id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ reason: "invitacion", followUp: expect.objectContaining({ body: "Lo ve con su socia", authorName: "Sofía Soporte" }) })
  })

  it("después de invitarla, la fila se va sola", async () => {
    const id = await waiting("invitar@inicio.test")
    expect((await getBackofficeToday(ownerDb, admin, NOW)).prospects.map((row) => row.id)).toContain(id)
    const before = (await getBackofficeOverview(ownerDb, admin, { now: NOW })).items.find((item) => item.key === "waitlist")?.count ?? 0
    await inviteFromWaitlist(ownerDb, admin, id, { planId }, NOW)
    expect((await getBackofficeToday(ownerDb, admin, NOW)).prospects.map((row) => row.id)).not.toContain(id)
    expect((await getBackofficeOverview(ownerDb, admin, { now: NOW })).items.find((item) => item.key === "waitlist")?.count).toBe(before - 1)
  })

  it("«Pruebas por terminar» ya no está entre los contadores", async () => {
    const overview = await getBackofficeOverview(ownerDb, admin, { now: NOW })
    expect(overview.items.map((item) => item.key)).not.toContain("trials")
    expect(overview.items.map((item) => item.label)).not.toContain("Pruebas por terminar")
    expect(overview.items.find((item) => item.key === "onboarding")?.description).toBe("Sin perfil o sin sede")
  })

  it("el número de «Lista de espera» y el de «Soporte» son los de sus secciones, para cada rol", async () => {
    for (const actor of [admin, support]) {
      const today = await getBackofficeToday(ownerDb, actor, NOW)
      const counts = Object.fromEntries((await getBackofficeOverview(ownerDb, actor, { now: NOW })).items.map((item) => [item.key, item.count]))
      expect(counts.waitlist).toBe(today.prospects.filter((row) => row.reason !== null).length)
      expect(counts["support-open"]).toBe(today.support.length)
    }
  })
})
