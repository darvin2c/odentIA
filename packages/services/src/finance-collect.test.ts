/**
 * Cobro atómico: idempotencia, concurrencia sin duplicados ni saltos, saldo a
 * favor automático, anulación antes/después del cierre y moneda extranjera.
 * (Escrito sin ejecutar: lo corre la verificación conjunta del integrador.)
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { branch } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  closeCashWindow,
  getCashState,
  getClosureSheet,
  listClosures,
} from "./finance.js"
import {
  collectCharge,
  createCharge,
  getAccountSummary,
  refundCredit,
  voidTicket,
} from "./payments.js"
import { createPaymentMethod } from "./payment-methods.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()

interface Fixture {
  actor: string
  patient: { id: string }
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
}

async function seedCashbox(f: Fixture) {
  const [branchRow] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede cobro ${randomUUID()}` })
    .returning()
  const cash = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }),
  )
  const yape = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Yape", typeCode: "68" }),
  )
  return { branchId: branchRow.id, cash, yape }
}

it("el reintento con el mismo requestId devuelve el ticket sin duplicar", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Consulta", amountCents: 10000, currency: "PEN" }),
  )
  const body = {
    branchId,
    payments: [{ paymentMethodId: cash.id, amountCents: 10000 }],
    requestId: randomUUID(),
  }
  const first = await f.run((tx) => collectCharge(tx, ...f.args, body))
  const retry = await f.run((tx) => collectCharge(tx, ...f.args, body))
  expect(retry.ticket.id).toBe(first.ticket.id)
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(summary.cobros).toHaveLength(1)
  expect(summary.byCurrency.find((c) => c.currency === "PEN")).toMatchObject({
    porCobrar: 0,
    pagado: 10000,
    aFavor: 0,
  })
})

it("dos cobros concurrentes no repiten ni saltan número de ticket", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Uno", amountCents: 5000, currency: "PEN" }),
  )
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Dos", amountCents: 5000, currency: "PEN" }),
  )
  const [a, b] = await Promise.all([
    f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId,
        payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
        requestId: randomUUID(),
      }),
    ),
    f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId,
        payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
        requestId: randomUUID(),
      }),
    ),
  ])
  const numbers = [a.ticket.ticketNumber, b.ticket.ticketNumber].sort((x, y) => x - y)
  expect(numbers[1] - numbers[0]).toBe(1)
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(summary.cobros).toHaveLength(2)
  expect(summary.byCurrency.find((c) => c.currency === "PEN")).toMatchObject({ porCobrar: 0 })
})

it("el adelanto queda a favor y se aplica solo al siguiente concepto", async () => {
  const f = await clinicalFixture()
  const { branchId, cash, yape } = await seedCashbox(f)
  const advance = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 20000,
      payments: [{ paymentMethodId: cash.id, amountCents: 20000 }],
      requestId: randomUUID(),
    }),
  )
  expect(advance.creditAppliedCents).toBe(0)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Endodoncia", amountCents: 60000, currency: "PEN" }),
  )
  const paid = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: yape.id, amountCents: 40000, reference: "OP-9" }],
      requestId: randomUUID(),
    }),
  )
  // 20000 del saldo + 40000 nuevos cubren los 60000.
  expect(paid.creditAppliedCents).toBe(20000)
  expect(paid.remainingCents).toBe(0)
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(summary.byCurrency.find((c) => c.currency === "PEN")).toMatchObject({
    porCobrar: 0,
    pagado: 60000,
    aFavor: 0,
  })
})

it("el cobro parcial deja el resto por cobrar y el ticket congela el medio", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Corona", amountCents: 90000, currency: "PEN" }),
  )
  const partial = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 60000 }],
      requestId: randomUUID(),
    }),
  )
  expect(partial.remainingCents).toBe(30000)
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(summary.byCurrency.find((c) => c.currency === "PEN")).toMatchObject({
    porCobrar: 30000,
    aFavor: 0,
  })
  expect(summary.pendiente[0]).toMatchObject({ totalCents: 90000, paidCents: 60000, saldoCents: 30000 })
  expect(summary.cobros[0].snapshot).toMatchObject({
    methods: [{ name: "Efectivo", typeCode: "10" }],
  })
})

it("anula todo antes del cierre y exige administración después", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Limpieza", amountCents: 12000, currency: "PEN" }),
  )
  const collected = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 12000 }],
      requestId: randomUUID(),
    }),
  )
  const undone = await f.run((tx) =>
    voidTicket(tx, ...f.args, collected.ticket.id, { reason: "Importe mal digitado", allowPostClose: false }),
  )
  expect(undone.voidedPayments).toBe(1)
  expect(undone.compensated).toBe(false)
  const afterVoid = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(afterVoid.byCurrency.find((c) => c.currency === "PEN")).toMatchObject({
    porCobrar: 12000,
    pagado: 0,
  })
  expect(afterVoid.cobros[0]).toMatchObject({ status: "anulado", voidReason: "Importe mal digitado" })

  const second = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 12000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    closeCashWindow(tx, "org_a", f.actor, {
      branchId,
      countedCents: 12000,
      retainedCents: 2000,
      deliveredCents: 10000,
    }),
  )
  // Tras el cierre, sin administración no se anula.
  await expect(
    f.run((tx) =>
      voidTicket(tx, ...f.args, second.ticket.id, { reason: "Tarde", allowPostClose: false }),
    ),
  ).rejects.toMatchObject({ code: "POST_CLOSE_NEEDS_ADMIN" })
  const admin = await f.run((tx) =>
    voidTicket(tx, ...f.args, second.ticket.id, { reason: "Autoriza administración", allowPostClose: true }),
  )
  expect(admin.compensated).toBe(true)
  const state = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  // La ventana nueva abrió con lo que quedó (2000) menos la compensación (12000).
  expect(state.cashOnHandCents).toBe(-10000)
})

it("devuelve solo el saldo a favor desde el efectivo de la caja", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 20000,
      payments: [{ paymentMethodId: cash.id, amountCents: 20000 }],
      requestId: randomUUID(),
    }),
  )
  await expect(
    f.run((tx) =>
      refundCredit(tx, ...f.args, { branchId, amountCents: 20001, reason: "De más" }),
    ),
  ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDIT" })
  const refund = await f.run((tx) =>
    refundCredit(tx, ...f.args, { branchId, amountCents: 20000, reason: "Ya no se atiende" }),
  )
  expect(refund.refunds).toHaveLength(1)
  expect(refund.methodName).toBe("Efectivo")
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(summary.byCurrency.find((c) => c.currency === "PEN")).toMatchObject({ pagado: 0, aFavor: 0 })
})

it("no mezcla monedas y cobra en moneda extranjera", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  const soles = await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Soles", amountCents: 10000, currency: "PEN" }),
  )
  const dollarsCharge = await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Dólares", amountCents: 5000, currency: "USD" }),
  )
  await expect(
    f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId,
        chargeIds: [soles.id, dollarsCharge.id],
        payments: [{ paymentMethodId: cash.id, amountCents: 15000 }],
        requestId: randomUUID(),
      }),
    ),
  ).rejects.toMatchObject({ code: "CURRENCY_MISMATCH" })
  const dollars = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
      requestId: randomUUID(),
    }),
  )
  // Sin chargeIds cobra lo pendiente en la moneda de la clínica (PEN); el
  // concepto en USD no entra al cobro.
  expect(dollars.ticket.currency).toBe("PEN")
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  const byCurrency = Object.fromEntries(summary.byCurrency.map((c) => [c.currency, c]))
  expect(byCurrency["PEN"].porCobrar).toBe(5000)
  expect(byCurrency["USD"].porCobrar).toBe(5000)
})

it("el cierre congela hoja imprimible e historial", async () => {
  const f = await clinicalFixture()
  const { branchId, cash, yape } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Brackets", amountCents: 80000, currency: "PEN" }),
  )
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [
        { paymentMethodId: cash.id, amountCents: 30000 },
        { paymentMethodId: yape.id, amountCents: 50000, reference: "OP-3" },
      ],
      requestId: randomUUID(),
    }),
  )
  const closed = await f.run((tx) =>
    closeCashWindow(tx, "org_a", f.actor, {
      branchId,
      countedCents: 30000,
      retainedCents: 5000,
      deliveredCents: 25000,
    }),
  )
  expect(closed.differenceCents).toBe(0)
  const closures = await f.run((tx) => listClosures(tx, "org_a", { branchId }))
  expect(closures).toHaveLength(1)
  const sheet = await f.run((tx) => getClosureSheet(tx, "org_a", closures[0].id))
  expect(sheet.legacy).toBe(false)
  expect(sheet.closure).toMatchObject({
    openingRetainedCents: 0,
    cashCollectedCents: 30000,
    expectedCents: 30000,
    countedCents: 30000,
    retainedCents: 5000,
    deliveredCents: 25000,
  })
  expect(sheet.totalsByMethod).toEqual([{ name: "Yape", count: 1, amountCents: 50000 }])
})

it("aplica solo el saldo a favor sin dinero nuevo", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 15000,
      payments: [{ paymentMethodId: cash.id, amountCents: 15000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Obturación", amountCents: 10000, currency: "PEN" }),
  )
  const paid = await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId, payments: [], requestId: randomUUID() }),
  )
  expect(paid.ticket.totalCents).toBe(0)
  expect(paid.creditAppliedCents).toBe(10000)
  expect(paid.remainingCents).toBe(0)
  expect(paid.ticket.snapshot).toMatchObject({
    lines: [{ description: "Obturación", amountCents: 10000, appliedCents: 10000 }],
  })
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(summary.byCurrency.find((c) => c.currency === "PEN")).toMatchObject({
    porCobrar: 0,
    aFavor: 5000,
  })
})

it("la clave reusada en otro cobro se rechaza", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Uno", amountCents: 5000, currency: "PEN" }),
  )
  const requestId = randomUUID()
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
      requestId,
    }),
  )
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Dos", amountCents: 7000, currency: "PEN" }),
  )
  await expect(
    f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId,
        payments: [{ paymentMethodId: cash.id, amountCents: 7000 }],
        requestId,
      }),
    ),
  ).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" })
})
