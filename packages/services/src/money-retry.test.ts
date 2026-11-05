import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { patientPaymentRefund } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createPaymentMethod } from "./payment-methods.js"
import { collectCharge, createCharge, getAccountSummary, refundCredit } from "./payments.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * El dinero: el servidor hace cumplir la regla de la pantalla (con conceptos
 * marcados no se cobra de más) y reconoce el reintento de «Devolver dinero»
 * (el mismo pedido no devuelve dos veces). QA 2026-11-04, A5 y A6.
 */

setupTestDb()

interface Fixture {
  actor: string
  patient: { id: string }
  args: readonly [string, string, string]
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
}

async function cashbox(f: Fixture) {
  const [row] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}` }).returning()
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: `Efectivo ${randomUUID()}`, typeCode: "10" }))
  return { branchId: row!.id, cash }
}

it("con conceptos marcados no se cobra más de lo que les falta: lo dice en vez de dejarlo a favor", async () => {
  const f = (await clinicalFixture()) as unknown as Fixture
  const { branchId, cash } = await cashbox(f)
  const charge = await f.run((tx) => createCharge(tx, ...f.args, { description: "Endodoncia", amountCents: 30000, currency: "PEN" }))
  const pay = (amountCents: number) =>
    f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId,
        chargeIds: [charge.id],
        payments: [{ paymentMethodId: cash.id, amountCents }],
        requestId: randomUUID(),
      }),
    )
  // Otra pestaña cobró una parte; esta, que seguía mostrando el total, intenta cobrarlo entero.
  await pay(10000)
  await expect(pay(30000)).rejects.toMatchObject({ code: "EXCEEDS_DUE", status: 409 })
  await pay(20000)
  // Ya pagado del todo, lo dice como siempre.
  await expect(pay(5000)).rejects.toMatchObject({ code: "NOTHING_DUE" })
  const account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(account.byCurrency.find((row) => row.currency === "PEN")?.aFavor ?? 0).toBe(0)
})

it("«Devolver dinero» enviado dos veces devuelve una sola vez; si el saldo cambió, lo dice", async () => {
  const f = (await clinicalFixture()) as unknown as Fixture
  const { branchId, cash } = await cashbox(f)
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 20000,
      payments: [{ paymentMethodId: cash.id, amountCents: 20000 }],
      requestId: randomUUID(),
    }),
  )
  const requestId = randomUUID()
  const refund = (input: { amountCents: number; requestId: string; expectedCreditCents?: number }) =>
    f.run((tx) => refundCredit(tx, ...f.args, { branchId, reason: "Ya no se atiende", ...input }))
  const first = await refund({ amountCents: 5000, requestId, expectedCreditCents: 20000 })
  // El mismo pedido otra vez (doble clic, la red que reintenta): lo mismo, sin otro egreso.
  const again = await refund({ amountCents: 5000, requestId, expectedCreditCents: 20000 })
  expect(again).toMatchObject({ duplicate: true, receiptId: first.receiptId, amountCents: 5000 })
  const rows = await ownerDb
    .select()
    .from(patientPaymentRefund)
    .where(and(eq(patientPaymentRefund.patientId, f.patient.id), eq(patientPaymentRefund.requestId, requestId)))
  expect(rows).toHaveLength(1)
  // La misma clave con otros datos no se toma como reintento.
  await expect(refund({ amountCents: 6000, requestId })).rejects.toMatchObject({ code: "REFUND_REQUEST_CONFLICT" })
  // Otra pestaña que aún mostraba 200 a favor: el servidor dice que cambió.
  await expect(refund({ amountCents: 5000, requestId: randomUUID(), expectedCreditCents: 20000 })).rejects.toMatchObject({
    code: "CREDIT_CHANGED",
    status: 409,
  })
  const account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(account.byCurrency.find((row) => row.currency === "PEN")?.aFavor).toBe(15000)
})

it("el reintento de una devolución pagada con varios cobros devuelve la misma constancia", async () => {
  const f = (await clinicalFixture()) as unknown as Fixture
  const { branchId, cash } = await cashbox(f)
  for (const cents of [8000, 7000])
    await f.run((tx) =>
      collectCharge(tx, ...f.args, { branchId, advanceCents: cents, payments: [{ paymentMethodId: cash.id, amountCents: cents }], requestId: randomUUID() }),
    )
  const requestId = randomUUID()
  const refund = () => f.run((tx) => refundCredit(tx, ...f.args, { branchId, reason: "Se muda", amountCents: 12000, requestId }))
  const first = await refund()
  // Las dos filas nacen en la misma transacción: la constancia es la de la fila que la guarda.
  for (let i = 0; i < 3; i++) expect(await refund()).toMatchObject({ duplicate: true, receiptId: first.receiptId, amountCents: 12000 })
  const rows = await ownerDb.select().from(patientPaymentRefund).where(eq(patientPaymentRefund.requestId, requestId))
  expect(rows).toHaveLength(2)
})
