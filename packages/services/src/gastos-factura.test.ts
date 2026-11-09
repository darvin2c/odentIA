/**
 * La factura por pagar (ADR 0174): anotarla no paga; cada pago es un gasto enlazado que nunca pasa de
 * lo que falta; anular o corregir un pago la deja como debe quedar; se anula solo sin pagos; y lo que
 * se debía en un momento sale en Reportes › Lo que debes.
 */
import { randomUUID } from "node:crypto"
import { treatmentPlanItem } from "@odentia/db/schema/clinical"
import { cashMovement, expense } from "@odentia/db/schema/finance"
import { branch } from "@odentia/db/schema/org"
import { and, eq, isNull } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { listPayables, notePayable, payablesOwedAt, voidPayable } from "./expense-payable.js"
import { addCashMovement, correctExpense, createExpense, voidExpense } from "./finance.js"
import { createPaymentMethod } from "./payment-methods.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function setup() {
  const f = await clinicalFixture()
  const [row] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede factura ${randomUUID()}` }).returning()
  const branchId = row!.id
  const transfer = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: `Transferencia ${randomUUID()}`, typeCode: "30" }))
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: `Efectivo ${randomUUID()}`, typeCode: "10" }))
  await f.run((tx) => addCashMovement(tx, "org_a", f.actor, { branchId, kind: "aporte", amountCents: 50_000, concept: "Fondo" }))
  const [crown] = await ownerDb
    .insert(treatmentPlanItem)
    .values({ organizationId: "org_a", patientId: f.patient.id, planId: f.plan.id, title: "Corona", currency: "PEN", status: "pendiente", decisionStatus: "aceptado" })
    .returning()
  const lab = { supplierName: "Laboratorio Dental Andino S.A.C.", supplierTaxId: "20512345671", receiptType: "01", receiptNumber: `E001-${Math.floor(Math.random() * 9000) + 1000}` }
  return { f, branchId, transfer, cash, crown: crown!, lab }
}

const payment = (branchId: string, methodId: string, amountCents: number, extra: Record<string, unknown> = {}) => ({
  branchId,
  category: "Laboratorio",
  concept: "Pago de la factura",
  amountCents,
  currency: "PEN",
  paymentMethodId: methodId,
  ...extra,
})

it("anotar la factura no paga ni toca la caja; se paga en partes y nunca más de lo que falta", async () => {
  const { f, branchId, transfer, cash, crown, lab } = await setup()
  const owed = await f.run((tx) =>
    notePayable(tx, "org_a", f.actor, {
      requestId: randomUUID(),
      branchId,
      ...lab,
      amountCents: 43_000,
      currency: "PEN",
      patientId: f.patient.id,
      planItemId: crown.id,
    }),
  )
  expect(owed).toMatchObject({ category: "Laboratorio", concept: `Factura ${lab.receiptNumber} · ${lab.supplierName}`, voidedAt: null })
  // Nada salió de la caja ni hay gasto.
  const spent = await ownerDb.select().from(expense).where(eq(expense.payableId, owed.id))
  expect(spent).toEqual([])
  let open = await f.run((tx) => listPayables(tx, "org_a", { branchId, open: true }))
  expect(open.payables.map((row) => [row.id, row.dueCents, row.planItemTitle, row.patientName])).toEqual([[owed.id, 43_000, "Corona", "Paciente de prueba"]])

  // Una parte por transferencia y otra en efectivo (esa sí sale de la caja).
  await f.run((tx) => createExpense(tx, "org_a", f.actor, payment(branchId, transfer.id, 20_000), { payableId: owed.id }))
  const inCash = await f.run((tx) => createExpense(tx, "org_a", f.actor, payment(branchId, cash.id, 3_000), { payableId: owed.id }))
  const out = await ownerDb.select().from(cashMovement).where(and(eq(cashMovement.expenseId, inCash.id), isNull(cashMovement.voidedAt)))
  expect(out.map((row) => row.amountCents)).toEqual([3_000])
  open = await f.run((tx) => listPayables(tx, "org_a", { branchId, open: true }))
  expect(open.payables[0]).toMatchObject({ paidCents: 23_000, dueCents: 20_000 })

  // De más, no.
  await expect(
    f.run((tx) => createExpense(tx, "org_a", f.actor, payment(branchId, transfer.id, 20_001), { payableId: owed.id })),
  ).rejects.toMatchObject({ fields: { amountCents: expect.stringMatching(/queda S\/\s200\.00 por pagar/) } })
  // Lo que falta, sí: sale de «Por pagar».
  await f.run((tx) => createExpense(tx, "org_a", f.actor, payment(branchId, transfer.id, 20_000), { payableId: owed.id }))
  open = await f.run((tx) => listPayables(tx, "org_a", { branchId, open: true }))
  expect(open.payables).toEqual([])
  // Anular un pago la deja otra vez por pagar, con lo que ese pago cubría.
  await f.run((tx) => voidExpense(tx, "org_a", f.actor, inCash.id, { reason: "Se anotó dos veces" }))
  open = await f.run((tx) => listPayables(tx, "org_a", { branchId, open: true }))
  expect(open.payables[0]?.dueCents).toBe(3_000)
})

it("corregir un pago lo deja en su factura; el tope sigue siendo lo que falta", async () => {
  const { f, branchId, transfer, lab } = await setup()
  const owed = await f.run((tx) => notePayable(tx, "org_a", f.actor, { branchId, ...lab, amountCents: 38_000 }))
  const first = await f.run((tx) => createExpense(tx, "org_a", f.actor, payment(branchId, transfer.id, 20_000), { payableId: owed.id }))
  const fixed = await f.run((tx) =>
    correctExpense(tx, "org_a", f.actor, first.id, { ...payment(branchId, transfer.id, 25_000), requestId: randomUUID() }),
  )
  expect(fixed.payableId).toBe(owed.id)
  const open = await f.run((tx) => listPayables(tx, "org_a", { branchId, open: true }))
  expect(open.payables[0]?.dueCents).toBe(13_000)
  await expect(
    f.run((tx) => correctExpense(tx, "org_a", f.actor, fixed.id, { ...payment(branchId, transfer.id, 38_001), requestId: randomUUID() })),
  ).rejects.toMatchObject({ fields: { amountCents: expect.any(String) } })
})

it("el pago va en el tipo, la sede y la moneda de su factura; lo del equipo no se anota así", async () => {
  const { f, branchId, transfer, lab, crown } = await setup()
  const owed = await f.run((tx) => notePayable(tx, "org_a", f.actor, { branchId, ...lab, amountCents: 10_000 }))
  await expect(
    f.run((tx) => createExpense(tx, "org_a", f.actor, payment(branchId, transfer.id, 1_000, { category: "Otros" }), { payableId: owed.id })),
  ).rejects.toMatchObject({ fields: { category: expect.any(String) } })
  const [other] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Otra sede ${randomUUID()}` }).returning()
  await expect(
    f.run((tx) => createExpense(tx, "org_a", f.actor, payment(other!.id, transfer.id, 1_000), { payableId: owed.id })),
  ).rejects.toMatchObject({ fields: { branchId: expect.any(String) } })
  await expect(
    f.run((tx) => notePayable(tx, "org_a", f.actor, { branchId, ...lab, category: "Personal", amountCents: 1_000 })),
  ).rejects.toMatchObject({ fields: { category: expect.any(String) } })
  // El tratamiento tiene que ser de esa paciente.
  const g = await clinicalFixture()
  await expect(
    f.run((tx) => notePayable(tx, "org_a", f.actor, { branchId, ...lab, amountCents: 1_000, patientId: g.patient.id, planItemId: crown.id })),
  ).rejects.toMatchObject({ fields: { planItemId: expect.any(String) } })
  // Vence después de la emisión, y la emisión no es futura.
  await expect(
    f.run((tx) => notePayable(tx, "org_a", f.actor, { branchId, ...lab, amountCents: 1_000, issuedOn: "2026-11-05", dueOn: "2026-11-01" })),
  ).rejects.toMatchObject({ fields: { dueOn: expect.any(String) } })
  // Una fecha que no existe es un error del campo, no del servidor.
  await expect(
    f.run((tx) => notePayable(tx, "org_a", f.actor, { branchId, ...lab, amountCents: 1_000, issuedOn: "2026-02-31" })),
  ).rejects.toMatchObject({ fields: { issuedOn: expect.any(String) } })
  // La misma factura del mismo proveedor no se anota dos veces.
  await expect(
    f.run((tx) => notePayable(tx, "org_a", f.actor, { branchId, ...lab, amountCents: 2_000 })),
  ).rejects.toMatchObject({ fields: { receiptNumber: expect.stringMatching(/ya está anotada/) } })
  // Reintentar con la misma clave devuelve la misma factura.
  const requestId = randomUUID()
  const nextPaper = { ...lab, receiptNumber: `${lab.receiptNumber}-B` }
  const once = await f.run((tx) => notePayable(tx, "org_a", f.actor, { requestId, branchId, ...nextPaper, amountCents: 5_000 }))
  const again = await f.run((tx) => notePayable(tx, "org_a", f.actor, { requestId, branchId, ...nextPaper, amountCents: 5_000 }))
  expect(again.id).toBe(once.id)
})

it("se anula solo sin pagos vigentes, y lo que se debía sale en Lo que debes", async () => {
  const { f, branchId, transfer, lab } = await setup()
  const owed = await f.run((tx) => notePayable(tx, "org_a", f.actor, { branchId, ...lab, amountCents: 30_000, dueOn: "2099-12-31" }))
  const paid = await f.run((tx) => createExpense(tx, "org_a", f.actor, payment(branchId, transfer.id, 10_000), { payableId: owed.id }))
  const before = new Date()
  expect(await f.run((tx) => payablesOwedAt(tx, "org_a", before, { branchId, money: { currency: "PEN", secondCurrency: null, exchangeRate: null, exchangeFactor: null }, timezone: "America/Lima" }))).toMatchObject({
    cents: 20_000,
    count: 1,
    overdueCents: 0,
  })
  await expect(f.run((tx) => voidPayable(tx, "org_a", f.actor, owed.id, { reason: "Error" }))).rejects.toMatchObject({ code: "PAYABLE_HAS_PAYMENTS" })
  await f.run((tx) => voidExpense(tx, "org_a", f.actor, paid.id, { reason: "Error" }))
  await f.run((tx) => voidPayable(tx, "org_a", f.actor, owed.id, { reason: "Anotada dos veces" }))
  const open = await f.run((tx) => listPayables(tx, "org_a", { branchId, open: true }))
  expect(open.payables).toEqual([])
  // Lo anulado ya no se paga.
  await expect(
    f.run((tx) => createExpense(tx, "org_a", f.actor, payment(branchId, transfer.id, 1_000), { payableId: owed.id })),
  ).rejects.toMatchObject({ code: "PAYABLE_VOIDED" })
  expect((await f.run((tx) => payablesOwedAt(tx, "org_a", new Date(), { branchId, money: { currency: "PEN", secondCurrency: null, exchangeRate: null, exchangeFactor: null }, timezone: "America/Lima" }))).cents).toBe(0)
})
