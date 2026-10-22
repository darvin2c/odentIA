import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { supportAccessGrant, supportCase } from "@odentia/db/schema/admin-support"
import { member, user } from "@odentia/db/schema/auth"
import { saasAction, saasCharge, saasNotice, saasPayment, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, eq } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { getClinicNotices } from "./clinic-notices.js"
import { createSaasPlan, tickSaasBilling } from "./saas-billing.js"
import { setSaasSpendCap } from "./saas-terms.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * Qué ve cada persona en la franja de avisos (ADR 0065): el servidor decide el
 * público y el texto; los montos y las acciones de cobro, solo quien administra.
 */
setupTestDb()
const DAY = 86_400_000
let planId: string

async function clinic(over: Partial<typeof saasSubscription.$inferInsert> = {}) {
  const orgId = `avisos-${randomUUID().slice(0, 8)}`
  await insertOrg(ownerDb, orgId, orgId)
  const now = Date.now()
  const values = {
    status: "activa" as const,
    planId,
    trialEndsAt: null,
    currentPeriodStart: new Date(now - 10 * DAY),
    currentPeriodEnd: new Date(now + 20 * DAY),
    ...over,
  }
  await ownerDb
    .insert(saasSubscription)
    .values({ organizationId: orgId, ...values })
    .onConflictDoUpdate({ target: saasSubscription.organizationId, set: values })
  const people = { owner: randomUUID(), reception: randomUUID(), clinician: randomUUID(), cashier: randomUUID() }
  await ownerDb.insert(user).values([
    { id: people.owner, name: "Rosa Díaz", email: `${people.owner}@clinica.test` },
    { id: people.reception, name: "Carla Ruiz", email: `${people.reception}@clinica.test` },
    { id: people.clinician, name: "Luis Mamani", email: `${people.clinician}@clinica.test` },
    { id: people.cashier, name: "Pedro Salas", email: `${people.cashier}@clinica.test` },
  ])
  await ownerDb.insert(member).values([
    { id: randomUUID(), userId: people.owner, organizationId: orgId, role: "owner", createdAt: new Date() },
    { id: randomUUID(), userId: people.reception, organizationId: orgId, role: "reception", createdAt: new Date() },
    { id: randomUUID(), userId: people.clinician, organizationId: orgId, role: "clinician", createdAt: new Date() },
    { id: randomUUID(), userId: people.cashier, organizationId: orgId, role: "cashier", createdAt: new Date() },
  ])
  const read = (who: keyof typeof people) =>
    withOrgContext(appDb, orgId, (tx) =>
      getClinicNotices(tx, orgId, { userId: people[who], role: { owner: "owner", reception: "reception", clinician: "clinician", cashier: "cashier" }[who] }),
    )
  return { orgId, people, read }
}

async function charge(orgId: string, dueInDays: number) {
  const [row] = await ownerDb
    .insert(saasCharge)
    .values({
      organizationId: orgId,
      planId,
      planCode: "avisos-odentia",
      planName: "Plan odentIA",
      periodStart: new Date(Date.UTC(2026, 9, 1)),
      periodEnd: new Date(Date.UTC(2026, 10, 1)),
      amountCents: 3276,
      currency: "USD",
      dueAt: new Date(Date.now() + dueInDays * DAY),
      dedupeKey: randomUUID(),
    })
    .returning()
  if (!row) throw new Error("sin cargo")
  return row
}

beforeAll(async () => {
  await ownerDb.insert(user).values({ id: "avisos-admin", name: "Administración", email: "admin@avisos.test" })
  await ownerDb.update(saasPlan).set({ isDefault: false })
  const plan = await createSaasPlan(ownerDb, "avisos-admin", {
    code: "avisos-odentia",
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

describe("franja de avisos: el pago del mes", () => {
  it("el cargo que llega avisa a quien administra, con el monto; al resto, nada", async () => {
    const { orgId, read } = await clinic()
    await charge(orgId, 6)
    const owner = await read("owner")
    expect(owner).toHaveLength(1)
    expect(owner[0]).toMatchObject({ topic: "cobro", tone: "aviso", dismiss: "nivel", action: { kind: "pagar" } })
    expect(owner[0]?.message).toContain("32.76")
    expect(await read("reception")).toEqual([])
    expect(await read("cashier")).toEqual([])
  })

  it("dos días antes pasa a ámbar y se cierra solo por hoy", async () => {
    const { orgId, read } = await clinic()
    await charge(orgId, 1.5)
    expect((await read("owner"))[0]).toMatchObject({ tone: "alarma", dismiss: "dia" })
  })

  it("con un comprobante en revisión, las alarmas del pago se detienen", async () => {
    const { orgId, people, read } = await clinic()
    const row = await charge(orgId, 1)
    await ownerDb.insert(saasPayment).values({
      organizationId: orgId,
      chargeId: row.id,
      amountCents: row.amountCents,
      currency: "USD",
      methodCode: "transferencia",
      status: "pendiente",
      createdBy: people.owner,
      idempotencyKey: randomUUID(),
    })
    const owner = await read("owner")
    expect(owner).toHaveLength(1)
    expect(owner[0]).toMatchObject({ id: "cobro:en-revision", tone: "aviso" })
  })

  it("el día antes de pasar a solo lectura avisa a todo el equipo, sin montos y con a quién avisar", async () => {
    const { orgId, read } = await clinic({ status: "gracia", graceEndsAt: new Date(Date.now() + 20 * 3_600_000) })
    await charge(orgId, -6)
    const owner = await read("owner")
    expect(owner[0]).toMatchObject({ tone: "alarma", action: { kind: "pagar" } })
    expect(owner[0]?.message).toContain("Mañana")
    const clinician = await read("clinician")
    expect(clinician).toHaveLength(1)
    expect(clinician[0]).toMatchObject({ tone: "alarma", action: null })
    expect(clinician[0]?.message).toContain("Avísale a Rosa")
    expect(clinician[0]?.message).not.toContain("32.76")
  })

  it("en solo lectura todos lo ven en rojo; solo quien administra, el monto y la acción", async () => {
    const { orgId, read } = await clinic({ status: "restringida", restrictReason: "gracia_vencida" })
    await charge(orgId, -10)
    const owner = await read("owner")
    expect(owner[0]).toMatchObject({ tone: "limite", dismiss: null, action: { kind: "pagar" } })
    const cashier = await read("cashier")
    expect(cashier[0]).toMatchObject({ tone: "limite", dismiss: null, action: null })
    expect(cashier[0]?.message).toContain("solo lectura")
    expect(cashier[0]?.message).not.toContain("32.76")
  })

  it("en pausa, quien administra escribe a soporte", async () => {
    const { read } = await clinic({ status: "pausada", pauseReason: "revisión de la cuenta" })
    expect((await read("owner"))[0]).toMatchObject({ tone: "limite", action: { kind: "escribir_soporte" } })
    expect((await read("owner"))[0]?.message).toContain("revisión de la cuenta")
  })
})

describe("franja de avisos: el tope y el crédito", () => {
  it("el tope alcanzado llega también a quien atiende conversaciones, sin «Subir tope»", async () => {
    const { orgId, read } = await clinic()
    await withOrgContext(appDb, orgId, (tx) => setSaasSpendCap(tx, orgId, "avisos-admin", 100))
    await ownerDb.insert(saasAction).values(
      Array.from({ length: 62 }, (_, index) => ({
        organizationId: orgId,
        kind: "conversacion",
        occurredAt: new Date(Date.now() - (index + 1) * 60_000),
        contactId: randomUUID(),
        detail: "Atendió una conversación por WhatsApp",
        currency: "USD",
        basePriceMicros: 500_000,
        priceMicros: 500_000,
        dedupeKey: randomUUID(),
      })),
    )
    const owner = await read("owner")
    expect(owner.find((notice) => notice.topic === "tope")).toMatchObject({ tone: "limite", action: { kind: "subir_tope" } })
    // Que se acabe el crédito solo informa.
    expect(owner.find((notice) => notice.id.startsWith("credito:"))).toMatchObject({ tone: "aviso" })
    const reception = await read("reception")
    expect(reception).toHaveLength(1)
    expect(reception[0]).toMatchObject({ topic: "tope", tone: "limite", action: null })
    expect(reception[0]?.message).toContain("te llegan a ti")
    expect(await read("cashier")).toEqual([])
  })
})

describe("franja de avisos: soporte con acceso", () => {
  it("solo propietario y administrador, diciendo quién lo dio", async () => {
    const { orgId, people, read } = await clinic()
    const [kase] = await ownerDb
      .insert(supportCase)
      .values({ organizationId: orgId, openedBy: people.owner, question: "No se envían los recordatorios", screen: "/agenda", role: "owner", dedupeKey: randomUUID() })
      .returning()
    if (!kase) throw new Error("sin caso")
    await ownerDb.insert(supportAccessGrant).values({
      organizationId: orgId,
      caseId: kase.id,
      scope: "diagnostico",
      grantedBy: people.owner,
      expiresAt: new Date(Date.now() + 30 * 60_000),
    })
    const owner = await read("owner")
    expect(owner).toHaveLength(1)
    expect(owner[0]).toMatchObject({ topic: "soporte", tone: "aviso", action: { kind: "quitar_acceso" } })
    expect(owner[0]?.message).toMatch(/^Diste acceso/)
    expect(owner[0]?.message).toContain("No se envían los recordatorios")
    expect(await read("reception")).toEqual([])
    expect(await read("clinician")).toEqual([])
  })
})

describe("correos de cobro (ADR 0065)", () => {
  it("el cargo que llega y el día antes de solo lectura se avisan una sola vez", async () => {
    const issued = await clinic()
    await charge(issued.orgId, 7)
    const ending = await clinic({ status: "gracia", graceEndsAt: new Date(Date.now() + 20 * 3_600_000) })
    await charge(ending.orgId, -6)
    await tickSaasBilling(ownerDb)
    await tickSaasBilling(ownerDb)
    const kinds = async (orgId: string, kind: string) =>
      ownerDb.select().from(saasNotice).where(and(eq(saasNotice.organizationId, orgId), eq(saasNotice.kind, kind)))
    const cargo = await kinds(issued.orgId, "cargo_emitido")
    expect(cargo).toHaveLength(1)
    expect(cargo[0]?.emailTo).toContain("@clinica.test")
    expect(await kinds(ending.orgId, "restriccion_manana")).toHaveLength(1)
  })

  it("el crédito al 75 % queda en la franja, sin correo", async () => {
    const { orgId } = await clinic()
    await ownerDb.insert(saasAction).values(
      Array.from({ length: 46 }, (_, index) => ({
        organizationId: orgId,
        kind: "conversacion",
        occurredAt: new Date(Date.now() - (index + 1) * 60_000),
        contactId: randomUUID(),
        detail: "Atendió una conversación por WhatsApp",
        currency: "USD",
        basePriceMicros: 500_000,
        priceMicros: 500_000,
        dedupeKey: randomUUID(),
      })),
    )
    await tickSaasBilling(ownerDb)
    const [notice] = await ownerDb.select().from(saasNotice).where(and(eq(saasNotice.organizationId, orgId), eq(saasNotice.kind, "credito_aviso")))
    expect(notice?.emailTo ?? null).toBeNull()
  })
})
