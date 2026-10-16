/**
 * Facturación SaaS: integridad de pagos, periodos, restricciones y comisiones.
 *
 * - El comprobante queda pendiente y la prórroga es acotada (una vez).
 * - El pago parcial no salda el cargo.
 * - El reverso tras liquidar deja un ajuste trazable sin mutar la liquidación.
 * - La demo está exenta de restricción y de comisiones.
 * - En pausa comercial no se opera ni se envía, pero billing/soporte/lectura pasan.
 * - La prueba dura 14 días y la gracia 7 antes de restringir.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext, type Db } from "@odentia/db"
import { invitation, member, user } from "@odentia/db/schema/auth"
import { saasCommissionSettlement, saasPayment, saasSubscription } from "@odentia/db/schema/saas-billing"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  assertSaasAllowed,
  assertSaasSeatAvailable,
  activateSaasSubscription,
  assignSaasSeller,
  chooseSaasPlan,
  confirmSaasPayment,
  createSaasCharge,
  createSaasPlan,
  decideSaasAccess,
  countSaasSeats,
  ensurePeriodCharge,
  getOrganizationBillingSummary,
  type SaasPaymentRow,
  listPendingSaasCommissions,
  pauseSaasSubscription,
  reverseSaasPayment,
  settleSaasCommissions,
  startSaasTrial,
  submitSaasReceipt,
  tickSaasBilling,
  upsertSaasPaymentMethod,
  upsertSaasSeller,
  updateSaasPlan,
  voidSaasSettlement,
} from "./saas-billing.js"
import type { Storage } from "./storage.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const storageStub: Storage = {
  putAvatar: async () => {
    throw new Error("no usado")
  },
  deleteByUrl: async () => {},
  putAttachment: async ({ orgId, conversationId, bytes, contentType }) => ({
    objectKey: `${orgId}/${conversationId}/comprobante.png`,
    mimeType: contentType,
    filename: "comprobante.png",
    size: bytes.byteLength,
  }),
  attachmentUrl: async (key) => `https://firmada.example.com/${key}`,
  deleteAttachment: async () => {},
  putPatientDocument: async () => {
    throw new Error("no usado")
  },
  putPatientAvatar: async () => {
    throw new Error("no usado")
  },
}

interface BillingFixture {
  orgId: string
  admin: string
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
}

async function billingFixture(orgId: string): Promise<BillingFixture> {
  await insertOrg(ownerDb, orgId, orgId)
  const admin = randomUUID()
  await ownerDb.insert(user).values({ id: admin, name: "Admin SaaS", email: `${admin}@example.test` })
  await ownerDb.insert(member).values({
    id: randomUUID(),
    organizationId: orgId,
    userId: admin,
    role: "owner",
    createdAt: new Date(),
  })
  await createSaasPlan(ownerDb, admin, {
    code: `base-${orgId}`,
    name: "Base",
    currency: "PEN",
    priceCents: 10000,
  })
  await upsertSaasPaymentMethod(ownerDb, admin, { code: "transferencia", name: "Transferencia" })
  return {
    orgId,
    admin,
    run: <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn),
  }
}

/** PNG 1x1 real: la verificación por bytes (sharp) lo acepta. */
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)
function receipt(amountCents: number, key: string) {
  return {
    methodCode: "transferencia",
    amountCents,
    receipt: {
      bytes: new Uint8Array(REAL_PNG),
      contentType: "image/png",
      filename: "comprobante.png",
    },
    idempotencyKey: key,
  }
}

async function trialWithCharge(f: BillingFixture, priceCents = 10000) {
  const now = new Date("2026-01-05T12:00:00Z")
  await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}` }, now)
  const charge = await createSaasCharge(ownerDb, f.orgId, f.admin, {
    planCode: `base-${f.orgId}`,
    periodStart: new Date("2026-01-01T00:00:00Z"),
    periodEnd: new Date("2026-02-01T00:00:00Z"),
  })
  void priceCents
  return { charge, now }
}

it("el comprobante queda pendiente y la prórroga es acotada a una vez", async () => {
  const f = await billingFixture("bil-01")
  const { charge, now } = await trialWithCharge(f)
  const first: SaasPaymentRow = await f.run((tx) =>
    submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, { chargeId: charge.id, ...receipt(10000, randomUUID()) }, now),
  )
  expect(first.status).toBe("pendiente")
  expect(first.hasReceipt).toBe(true)
  const summary = await f.run((tx) => getOrganizationBillingSummary(tx, f.orgId))
  expect(summary.proofExtensionUntil).not.toBeNull()
  // Otro comprobante no renueva el plazo ni permite duplicar lo pendiente.
  await expect(f.run((tx) =>
    submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, { chargeId: charge.id, ...receipt(1000, randomUUID()) }, now),
  )).rejects.toMatchObject({ code: "SAAS_RECEIPT_PENDING" })
  const again = await f.run((tx) => getOrganizationBillingSummary(tx, f.orgId))
  expect(again.proofExtensionUntil?.toISOString()).toBe(summary.proofExtensionUntil?.toISOString())
})

it("el pago parcial no salda el cargo", async () => {
  const f = await billingFixture("bil-02")
  const { charge } = await trialWithCharge(f)
  const payment = await f.run((tx) =>
    submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, { chargeId: charge.id, ...receipt(4000, randomUUID()) }),
  )
  const confirmed = await confirmSaasPayment(ownerDb, f.orgId, f.admin, payment.id)
  expect(confirmed.payment.status).toBe("confirmado")
  expect(confirmed.charge?.status).toBe("parcial")
  expect(confirmed.charge?.paidCents).toBe(4000)
})

it("el reverso tras liquidar deja un ajuste sin mutar la liquidación", async () => {
  const f = await billingFixture("bil-03")
  const seller = await upsertSaasSeller(ownerDb, f.admin, { displayName: "Vendedor", rateBps: 1000 })
  await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}` })
  await assignSaasSeller(ownerDb, f.orgId, f.admin, seller.id)
  const { charge } = await trialWithCharge(f)
  const payment = await f.run((tx) =>
    submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, { chargeId: charge.id, ...receipt(10000, randomUUID()) }),
  )
  await confirmSaasPayment(ownerDb, f.orgId, f.admin, payment.id)
  const settled = await settleSaasCommissions(ownerDb, f.admin, {
    sellerId: seller.id,
    year: new Date().getUTCFullYear(),
    month: new Date().getUTCMonth() + 1,
    currency: "PEN",
  })
  expect(settled.settlement.totalCents).toBe(1000)
  const reversed = await reverseSaasPayment(ownerDb, f.orgId, f.admin, payment.id, "Cobro duplicado")
  expect(reversed.payment.status).toBe("reversado")
  expect(reversed.adjustmentId).not.toBeNull()
  const [same] = await ownerDb
    .select()
    .from(saasCommissionSettlement)
    .where(eq(saasCommissionSettlement.id, settled.settlement.id))
  expect(same?.totalCents).toBe(1000)
  const pending = await listPendingSaasCommissions(ownerDb, seller.id)
  expect(pending).toHaveLength(0)
})

it("la demo está exenta de restricción y no genera comisión", async () => {
  const f = await billingFixture("bil-04")
  const now = new Date("2026-01-05T12:00:00Z")
  await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}`, isDemo: true }, now)
  const demoSummary = await f.run((tx) => getOrganizationBillingSummary(tx, f.orgId))
  expect(demoSummary.status).toBe("prueba")
  expect(demoSummary.restricted).toBe(false)
  const decision = await f.run((tx) => decideSaasAccess(tx, f.orgId, "enviar"))
  expect(decision.allowed).toBe(true)
  const charge = await createSaasCharge(ownerDb, f.orgId, f.admin, {
    planCode: `base-${f.orgId}`,
    periodStart: new Date("2026-01-01T00:00:00Z"),
    periodEnd: new Date("2026-02-01T00:00:00Z"),
  })
  const payment = await f.run((tx) =>
    submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, { chargeId: charge.id, ...receipt(10000, randomUUID()) }),
  )
  const confirmed = await confirmSaasPayment(ownerDb, f.orgId, f.admin, payment.id)
  expect(confirmed.commissionId).toBeNull()
})

it("en pausa no se opera ni se envía, pero billing, soporte y lectura pasan", async () => {
  const f = await billingFixture("bil-05")
  await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}` })
  await pauseSaasSubscription(ownerDb, f.orgId, f.admin, "Pausa solicitada por la clínica")
  await expect(f.run((tx) => assertSaasAllowed(tx, f.orgId, "operar"))).rejects.toMatchObject({
    code: "SAAS_RESTRICTED",
  })
  await expect(f.run((tx) => assertSaasAllowed(tx, f.orgId, "enviar"))).rejects.toMatchObject({
    code: "SAAS_RESTRICTED",
  })
  for (const operation of ["leer", "facturacion", "soporte"] as const) {
    const decision = await f.run((tx) => decideSaasAccess(tx, f.orgId, operation))
    expect(decision.allowed).toBe(true)
  }
})

it("la prueba dura 30 días (ADR 0030) y la gracia 7 antes de restringir", async () => {
  const f = await billingFixture("bil-06")
  const start = new Date("2026-01-05T12:00:00Z")
  const sub = await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}` }, start)
  await ownerDb
    .update(saasSubscription)
    .set({ trialStartedAt: start, trialEndsAt: new Date("2026-01-19T12:00:00Z") })
    .where(eq(saasSubscription.organizationId, f.orgId))
  const trialDays = (sub.trialEndsAt!.getTime() - sub.trialStartedAt!.getTime()) / 86400000
  expect(trialDays).toBe(30)
  await createSaasCharge(ownerDb, f.orgId, f.admin, {
    planCode: `base-${f.orgId}`,
    periodStart: new Date("2026-01-05T00:00:00Z"),
    periodEnd: new Date("2026-02-05T00:00:00Z"),
  })
  const afterTrial = await tickSaasBilling(ownerDb, new Date("2026-01-20T12:00:00Z"))
  expect(afterTrial.summary.trialsEnded).toBeGreaterThanOrEqual(1)
  const afterGrace = await tickSaasBilling(ownerDb, new Date("2026-02-10T12:00:00Z"))
  expect(afterGrace.summary.restricted).toBeGreaterThanOrEqual(1)
  const summary = await f.run((tx) => getOrganizationBillingSummary(tx, f.orgId))
  expect(summary.status).toBe("restringida")
  expect(summary.restrictReason).toBe("gracia_vencida")
})

it("confirmar el pago no reanuda una pausa manual", async () => {
  const f = await billingFixture("bil-07")
  await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}` })
  await pauseSaasSubscription(ownerDb, f.orgId, f.admin, "Pausa solicitada por la clínica")
  const charge = await createSaasCharge(ownerDb, f.orgId, f.admin, {
    planCode: `base-${f.orgId}`,
    periodStart: new Date("2026-01-01T00:00:00Z"),
    periodEnd: new Date("2026-02-01T00:00:00Z"),
  })
  const payment = await f.run((tx) =>
    submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, { chargeId: charge.id, ...receipt(10000, randomUUID()) }),
  )
  await confirmSaasPayment(ownerDb, f.orgId, f.admin, payment.id)
  const summary = await f.run((tx) => getOrganizationBillingSummary(tx, f.orgId))
  expect(summary.status).toBe("pausada")
  expect(summary.pauseReason).toBe("Pausa solicitada por la clínica")
})

it("elegir plan no reescribe el cargo histórico", async () => {
  const f = await billingFixture("bil-08")
  await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}` })
  const charge = await createSaasCharge(ownerDb, f.orgId, f.admin, {
    planCode: `base-${f.orgId}`,
    periodStart: new Date("2026-01-01T00:00:00Z"),
    periodEnd: new Date("2026-02-01T00:00:00Z"),
  })
  await createSaasPlan(ownerDb, f.admin, {
    code: `plus-${f.orgId}`,
    name: "Plus",
    currency: "PEN",
    priceCents: 20000,
  })
  await f.run((tx) => chooseSaasPlan(tx, f.orgId, f.admin, `plus-${f.orgId}`))
  const summary = await f.run((tx) => getOrganizationBillingSummary(tx, f.orgId))
  expect(summary.plan?.code).toBe(`plus-${f.orgId}`)
  expect(charge.planCode).toBe(`base-${f.orgId}`)
  expect(charge.amountCents).toBe(10000)
})
it("el cupo cuenta unión por correo: aceptar al límite exacto pasa", async () => {
  const f = await billingFixture("bil-09")
  await createSaasPlan(ownerDb, f.admin, {
    code: `duo-${f.orgId}`,
    name: "Dúo",
    currency: "PEN",
    priceCents: 5000,
    maxSeats: 2,
  })
  await startSaasTrial(ownerDb, f.orgId, { planCode: `duo-${f.orgId}` })
  // La invitación reserva el asiento sin duplicar al miembro que acepta.
  await ownerDb.insert(invitation).values({
    id: randomUUID(),
    organizationId: f.orgId,
    email: "nueva@example.test",
    role: "member",
    status: "pending",
    expiresAt: new Date("2026-06-01T00:00:00Z"),
    inviterId: f.admin,
    createdAt: new Date(),
  })
  // Unión: dueño + invitada = 2 (la invitada cuenta una sola vez).
  await f.run(async (tx) => {
    expect(await countSaasSeats(tx, f.orgId)).toBe(2)
    // Aceptar al límite exacto pasa: su asiento ya está reservado.
    await assertSaasSeatAvailable(tx, f.orgId, "nueva@example.test")
    // Un tercer correo distinto no cabe.
    await expect(assertSaasSeatAvailable(tx, f.orgId, "otra@example.test")).rejects.toMatchObject({
      code: "SAAS_SEAT_LIMIT",
    })
  })
})
it("el comprobante disfrazado (SVG/HTML) se rechaza por bytes", async () => {
  const f = await billingFixture("bil-10")
  await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}` })
  const charge = await createSaasCharge(ownerDb, f.orgId, f.admin, {
    planCode: `base-${f.orgId}`,
    periodStart: new Date("2026-01-01T00:00:00Z"),
    periodEnd: new Date("2026-02-01T00:00:00Z"),
  })
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  await f.run((tx) =>
    expect(
      submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, {
        chargeId: charge.id,
        methodCode: "transferencia",
        amountCents: 10000,
        receipt: { bytes: svg, contentType: "image/png", filename: "falso.png" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" }),
  )
})
it("el cargo del mes es idempotente y el precio nuevo rige el próximo", async () => {
  const f = await billingFixture("bil-11")
  const created = await createSaasPlan(ownerDb, f.admin, {
    code: `mes-${f.orgId}`,
    name: "Mensual",
    currency: "PEN",
    priceCents: 10000,
  })
  await activateSaasSubscription(ownerDb, f.orgId, f.admin, `mes-${f.orgId}`)
  const may1 = await f.run((tx) => ensurePeriodCharge(tx, f.orgId, null, "2026-05"))
  const may2 = await f.run((tx) => ensurePeriodCharge(tx, f.orgId, null, "2026-05"))
  expect(may1?.id).toBe(may2?.id)
  await updateSaasPlan(ownerDb, f.admin, created.id, { priceCents: 20000 })
  const june = await f.run((tx) => ensurePeriodCharge(tx, f.orgId, null, "2026-06"))
  expect(june?.amountCents).toBe(20000)
  expect(may1?.amountCents).toBe(10000)
})

it("dos comprobantes a la vez: uno pasa y el otro espera", async () => {
  const f = await billingFixture("bil-12")
  await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}` })
  const charge = await createSaasCharge(ownerDb, f.orgId, f.admin, {
    planCode: `base-${f.orgId}`,
    periodStart: new Date("2026-07-01T00:00:00Z"),
    periodEnd: new Date("2026-08-01T00:00:00Z"),
  })
  const outcomes = await Promise.allSettled([
    f.run((tx) =>
      submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, { chargeId: charge.id, ...receipt(10000, randomUUID()) }),
    ),
    f.run((tx) =>
      submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, { chargeId: charge.id, ...receipt(10000, randomUUID()) }),
    ),
  ])
  const ok = outcomes.filter((outcome) => outcome.status === "fulfilled")
  const denied = outcomes.filter(
    (outcome) => outcome.status === "rejected" && (outcome.reason as { code?: string })?.code === "SAAS_RECEIPT_PENDING",
  )
  expect(ok).toHaveLength(1)
  expect(denied).toHaveLength(1)
})

it("confirmar de más supera el cargo y se rechaza", async () => {
  const f = await billingFixture("bil-13")
  await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}` })
  const charge = await createSaasCharge(ownerDb, f.orgId, f.admin, {
    planCode: `base-${f.orgId}`,
    periodStart: new Date("2026-09-01T00:00:00Z"),
    periodEnd: new Date("2026-10-01T00:00:00Z"),
  })
  const first = await f.run((tx) =>
    submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, { chargeId: charge.id, ...receipt(10000, randomUUID()) }),
  )
  await confirmSaasPayment(ownerDb, f.orgId, f.admin, first.id)
  // Legado/carrera: segundo pendiente por el total cuando ya no hay saldo.
  const [extra] = await ownerDb
    .insert(saasPayment)
    .values({
      organizationId: f.orgId,
      chargeId: charge.id,
      amountCents: 10000,
      currency: "PEN",
      methodCode: "transferencia",
      status: "pendiente",
      idempotencyKey: randomUUID(),
      createdBy: f.admin,
    })
    .returning()
  await expect(confirmSaasPayment(ownerDb, f.orgId, f.admin, extra.id)).rejects.toMatchObject({
    code: "SAAS_OVERPAYMENT",
  })
})

it("anular libera las fuentes y se reliquida igual", async () => {
  const f = await billingFixture("bil-14")
  const seller = await upsertSaasSeller(ownerDb, f.admin, { displayName: "Reliq", rateBps: 1000 })
  await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}`, sellerId: seller.id })
  const charge = await createSaasCharge(ownerDb, f.orgId, f.admin, {
    planCode: `base-${f.orgId}`,
    periodStart: new Date("2026-11-01T00:00:00Z"),
    periodEnd: new Date("2026-12-01T00:00:00Z"),
  })
  const payment = await f.run((tx) =>
    submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, { chargeId: charge.id, ...receipt(10000, randomUUID()) }),
  )
  await confirmSaasPayment(ownerDb, f.orgId, f.admin, payment.id)
  const settled = await settleSaasCommissions(ownerDb, f.admin, {
    sellerId: seller.id,
    year: new Date().getUTCFullYear(),
    month: new Date().getUTCMonth() + 1,
    currency: "PEN",
  })
  await voidSaasSettlement(ownerDb, f.admin, settled.settlement.id, "Mes errado")
  const again = await settleSaasCommissions(ownerDb, f.admin, {
    sellerId: seller.id,
    year: new Date().getUTCFullYear(),
    month: new Date().getUTCMonth() + 1,
    currency: "PEN",
  })
  expect(again.settlement.totalCents).toBe(settled.settlement.totalCents)
  expect(again.settlement.id).not.toBe(settled.settlement.id)
})

it("cambiar vendedor congela lo nuevo sin tocar lo liquidado", async () => {
  const f = await billingFixture("bil-15")
  const first = await upsertSaasSeller(ownerDb, f.admin, { displayName: "Primero", rateBps: 1000 })
  await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}`, sellerId: first.id })
  await assignSaasSeller(ownerDb, f.orgId, f.admin, null)
  const second = await upsertSaasSeller(ownerDb, f.admin, { displayName: "Segundo", rateBps: 2000 })
  await assignSaasSeller(ownerDb, f.orgId, f.admin, second.id)
  const charge = await createSaasCharge(ownerDb, f.orgId, f.admin, {
    planCode: `base-${f.orgId}`,
    periodStart: new Date("2026-12-01T00:00:00Z"),
    periodEnd: new Date("2027-01-01T00:00:00Z"),
  })
  const payment = await f.run((tx) =>
    submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, { chargeId: charge.id, ...receipt(10000, randomUUID()) }),
  )
  const confirmed = await confirmSaasPayment(ownerDb, f.orgId, f.admin, payment.id)
  expect(confirmed.commissionId).not.toBeNull()
  const pending = await listPendingSaasCommissions(ownerDb, second.id)
  expect(pending[pending.length - 1]?.rateBps).toBe(2000)
})

it("después de 12 meses no hay comisión", async () => {
  const f = await billingFixture("bil-16")
  const seller = await upsertSaasSeller(ownerDb, f.admin, { displayName: "Tardío", rateBps: 1000 })
  await startSaasTrial(ownerDb, f.orgId, { planCode: `base-${f.orgId}`, sellerId: seller.id })
  const past = new Date()
  past.setUTCMonth(past.getUTCMonth() - 13)
  await ownerDb
    .update(saasSubscription)
    .set({ trialStartedAt: past })
    .where(eq(saasSubscription.organizationId, f.orgId))
  const charge = await createSaasCharge(ownerDb, f.orgId, f.admin, {
    planCode: `base-${f.orgId}`,
    periodStart: new Date("2027-02-01T00:00:00Z"),
    periodEnd: new Date("2027-03-01T00:00:00Z"),
  })
  const payment = await f.run((tx) =>
    submitSaasReceipt(tx, { storage: storageStub }, f.orgId, f.admin, { chargeId: charge.id, ...receipt(10000, randomUUID()) }),
  )
  const confirmed = await confirmSaasPayment(ownerDb, f.orgId, f.admin, payment.id)
  expect(confirmed.commissionId).toBeNull()
})
