/**
 * El impuesto de lo que cobra la clínica (ADR 0083): cada concepto guarda el
 * suyo, el ticket lo separa como una boleta, cada pago guarda su parte y
 * Reportes no cuenta ese impuesto en lo que deja (ni su pago otra vez).
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { patientPayment, patientPaymentRefund } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { refundTaxCents, splitTaxAcrossPayments, taxColumnsFor, ticketTaxesOf } from "./clinic-taxes.js"
import { createExpense } from "./finance.js"
import { updateOrgRegion } from "./organization-profile.js"
import { createPaymentMethod } from "./payment-methods.js"
import { collectCharge, createCharge, refundCredit, type TicketFrozen } from "./payments.js"
import { getReportFinance } from "./report-finance.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()

interface Fixture {
  actor: string
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
}

async function cashbox(f: Fixture) {
  const [branchRow] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede impuesto ${randomUUID()}` })
    .returning()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }))
  const yape = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: "Yape", typeCode: "68" }))
  return { branchId: branchRow.id, cash, yape }
}

describe("reglas sin base", () => {
  it("cada línea redondea su impuesto y el ticket los suma", () => {
    const igv = { name: "IGV", law: "", legalForm: null, legalFormPending: false } as const
    const taxes = ticketTaxesOf(
      {
        ...igv,
        servicios: { category: "S", rateBps: 1800, label: "IGV 18 %", isDefault: true, choiceKey: "igv18" },
        productos: { category: "S", rateBps: 1800, label: "IGV 18 %", isDefault: true, choiceKey: "igv18" },
      },
      [
        { amountCents: 11_800, taxCategory: "S", taxBps: 1800, scope: "servicios" },
        { amountCents: 5_900, taxCategory: "S", taxBps: 1800, scope: "productos" },
      ],
    )
    expect(taxes).toMatchObject({ subtotalCents: 15_000, taxCents: 2_700 })
    // Un concepto anterior al impuesto suma al subtotal: subtotal + impuesto sigue siendo el total.
    const mixed = ticketTaxesOf(
      {
        ...igv,
        servicios: { category: "S", rateBps: 1800, label: "IGV 18 %", isDefault: true, choiceKey: "igv18" },
        productos: { category: "S", rateBps: 1800, label: "IGV 18 %", isDefault: true, choiceKey: "igv18" },
      },
      [
        { amountCents: 11_800, taxCategory: "S", taxBps: 1800, scope: "servicios" },
        { amountCents: 1_000, taxCategory: null, taxBps: null, scope: "servicios" },
      ],
    )
    expect(mixed).toMatchObject({ subtotalCents: 11_000, taxCents: 1_800 })
    // Nada con impuesto: el ticket queda como antes.
    expect(ticketTaxesOf(null, [{ amountCents: 100, taxCategory: "S", taxBps: 1800, scope: "servicios" }])).toBeNull()
  })

  it("reparte el impuesto entre los medios sin perder un céntimo", () => {
    expect(splitTaxAcrossPayments(6_864, [20_000, 25_000])).toEqual([3_051, 3_813])
    expect(splitTaxAcrossPayments(0, [100])).toEqual([0])
    expect(refundTaxCents({ amountCents: 11_800, taxCents: 1_800 }, 5_900)).toBe(900)
  })

  it("solo guarda lo que difiere de lo del país", () => {
    expect(taxColumnsFor("PE", { servicios: { category: "S", rateBps: 1800 } })).toMatchObject({
      servicesTaxCategory: null,
      servicesTaxBps: null,
    })
    expect(taxColumnsFor("PE", { servicios: { category: "S", rateBps: 1000 } })).toMatchObject({
      servicesTaxCategory: "S",
      servicesTaxBps: 1000,
    })
    // Una exención que el país no tiene no se inventa.
    expect(() => taxColumnsFor("PE", { servicios: { category: "E", rateBps: 0 } })).toThrow()
    expect(() => taxColumnsFor("MX", { legalForm: "otra" })).toThrow()
    expect(() => taxColumnsFor("AR", { servicios: { category: "S", rateBps: 2100 } })).toThrow()
  })
})

it("el ticket separa el IGV y lo que falta pagar; cada pago guarda su parte", async () => {
  const f = await clinicalFixture()
  const { branchId, cash, yape } = await cashbox(f)
  const cleaning = await f.run((tx) => createCharge(tx, ...f.args, { description: "Limpieza", amountCents: 11_800, currency: "PEN" }))
  expect(cleaning).toMatchObject({ taxCategory: "S", taxBps: 1800 })
  const paid = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [cleaning.id],
      payments: [{ paymentMethodId: cash.id, amountCents: 11_800 }],
      requestId: randomUUID(),
    }),
  )
  const frozen = paid.ticket.snapshot as TicketFrozen
  expect(frozen.taxes).toMatchObject({ name: "IGV", subtotalCents: 10_000, taxCents: 1_800 })
  expect(frozen.taxes?.groups).toEqual([expect.objectContaining({ label: "IGV 18 %", taxCents: 1_800 })])
  expect(frozen.pending).toEqual([])
  expect(paid.payments[0]?.taxCents).toBe(1_800)

  // Un pago a cuenta de 450 de una endodoncia de 900: el impuesto es el de lo que entra hoy.
  const root = await f.run((tx) => createCharge(tx, ...f.args, { description: "Endodoncia", amountCents: 90_000, currency: "PEN" }))
  const partial = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [root.id],
      payments: [
        { paymentMethodId: cash.id, amountCents: 20_000 },
        { paymentMethodId: yape.id, amountCents: 25_000 },
      ],
      requestId: randomUUID(),
    }),
  )
  const half = partial.ticket.snapshot as TicketFrozen
  expect(half.taxes).toMatchObject({ subtotalCents: 38_136, taxCents: 6_864 })
  expect(half.pending).toEqual([{ chargeId: root.id, description: "Endodoncia", amountCents: 90_000, remainingCents: 45_000 }])
  expect(partial.payments.reduce((sum, item) => sum + item.taxCents, 0)).toBe(6_864)
})

it("cambiar el impuesto vale desde que se guarda y los productos usan el suyo", async () => {
  const f = await clinicalFixture()
  const before = await f.run((tx) => createCharge(tx, ...f.args, { description: "Consulta", amountCents: 5_000, currency: "PEN" }))
  await f.run((tx) => updateOrgRegion(tx, "org_a", f.actor, { taxes: { servicios: { category: "O", rateBps: 0 } } }))
  try {
    const after = await f.run((tx) => createCharge(tx, ...f.args, { description: "Control", amountCents: 5_000, currency: "PEN" }))
    expect(after).toMatchObject({ taxCategory: "O", taxBps: 0 })
    // Lo ya cargado conserva el impuesto con que nació.
    expect(before).toMatchObject({ taxCategory: "S", taxBps: 1800 })
  } finally {
    await f.run((tx) => updateOrgRegion(tx, "org_a", f.actor, { taxes: {} }))
  }
})

it("con el dinero de una devolución sale su parte del impuesto", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await cashbox(f)
  const advance = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 11_800,
      payments: [{ paymentMethodId: cash.id, amountCents: 11_800 }],
      requestId: randomUUID(),
    }),
  )
  // Un adelanto lleva el impuesto de las atenciones.
  expect(advance.payments[0]?.taxCents).toBe(1_800)
  await f.run((tx) =>
    refundCredit(tx, ...f.args, { branchId, amountCents: 5_900, reason: "Ya no se atenderá" }),
  )
  const refunds = await ownerDb
    .select({ taxCents: patientPaymentRefund.taxCents })
    .from(patientPaymentRefund)
    .where(eq(patientPaymentRefund.paymentId, advance.payments[0]?.id ?? ""))
  expect(refunds).toEqual([{ taxCents: 900 }])
})

it("Reportes no cuenta el IGV en lo que deja ni resta otra vez su pago", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await cashbox(f)
  const charge = await f.run((tx) => createCharge(tx, ...f.args, { description: "Resina", amountCents: 23_600, currency: "PEN" }))
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [charge.id],
      payments: [{ paymentMethodId: cash.id, amountCents: 23_600 }],
      requestId: randomUUID(),
    }),
  )
  const first = await f.run((tx) => getReportFinance(tx, "org_a", { period: "este_mes", branchId }))
  const tax = await ownerDb.select({ taxCents: patientPayment.taxCents }).from(patientPayment).where(eq(patientPayment.branchId, branchId))
  expect(first.totals.current.taxCents).toBe(tax.reduce((sum, row) => sum + row.taxCents, 0))
  expect(first.totals.current.taxCents).toBe(3_600)
  expect(first.taxName).toBe("IGV")
  const { cobradoCents, taxCents, commissionCents, otherExpensesCents, leavesCents } = first.totals.current
  expect(leavesCents).toBe(cobradoCents - taxCents - commissionCents - otherExpensesCents)
  expect(first.payables.salesTax.cents).toBe(3_600)

  // Pagar el IGV sale de la caja, pero no vuelve a restar de lo que deja.
  await f.run((tx) =>
    createExpense(tx, "org_a", f.actor, { branchId, category: "Impuestos", concept: "IGV del mes", amountCents: 3_600, salesTax: true }),
  )
  const second = await f.run((tx) => getReportFinance(tx, "org_a", { period: "este_mes", branchId }))
  expect(second.totals.current.leavesCents).toBe(first.totals.current.leavesCents)
  expect(second.totals.current.cashLeftCents).toBe(first.totals.current.cashLeftCents - 3_600)
  expect(second.cascade.salesTaxPaidCents).toBe(3_600)
  expect(second.cascade.categories.find((item) => item.category === "Impuestos")).toBeUndefined()
  // Solo un gasto de «Impuestos» puede ser el pago del IGV.
  await expect(
    f.run((tx) => createExpense(tx, "org_a", f.actor, { branchId, category: "Otros", concept: "x", amountCents: 100, salesTax: true })),
  ).rejects.toThrow()
})
