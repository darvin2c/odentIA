/**
 * Reportes › Finanzas: las comisiones son las de Finanzas › Comisiones, la
 * comisión cuenta al cobrar y su pago no se suma dos veces; pagar una compra es
 * un gasto de Materiales enlazado con sus reglas (en partes, adelanto, a favor,
 * cancelar); «Te deben» por antigüedad es el saldo vencido; y «Puede faltar un
 * gasto» se calla cuando la clínica dice que no hubo.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { encounter, encounterProcedure, patientCharge, patientPayment, patientPaymentApplication } from "@odentia/db/schema/clinical"
import { expense } from "@odentia/db/schema/finance"
import { branch } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createExpense, dismissExpenseGap, listMonthCommissions, payMonthCommission, payPurchaseOrder, setCommissionRate, voidExpense } from "./finance.js"
import { cancelPurchaseOrder, confirmPurchaseOrder, createProduct, createPurchaseOrder, createSupplier, createWarehouse, getPurchaseOrder, receivePurchaseOrder } from "./inventory.js"
import { collectCharge, createCharge, voidTicket } from "./payments.js"
import { createPaymentMethod } from "./payment-methods.js"
import { purchaseBalances, supplierCredits, unpaidPurchasesMany } from "./purchase-balance.js"
import { overdueDebtMany } from "./report-summary.js"
import { commissionsMany, debtAgingMany, getReportCommissions, getReportFinance } from "./report-finance.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

function currentMonth(): { year: number; month: number; key: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date())
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const year = get("year")
  const month = get("month")
  return { year, month, key: `${year}-${String(month).padStart(2, "0")}` }
}

it("comisiones: las del reporte son las de Finanzas › Comisiones y su pago no se cuenta dos veces", async () => {
  const f = await clinicalFixture()
  await ownerDb.insert(member).values({ id: randomUUID(), organizationId: "org_a", userId: f.actor, role: "dentist", createdAt: new Date() })
  const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede reporte ${randomUUID()}` }).returning()
  const branchId = site!.id
  const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: `Efectivo ${randomUUID()}`, typeCode: "10" }))
  const procedure = async (priceCents: number) => {
    const [row] = await ownerDb
      .insert(encounterProcedure)
      .values({ organizationId: "org_a", encounterId: f.encounter.id, serviceId: f.service.id, description: "Tratamiento", priceCents, currency: "PEN", createdBy: f.actor })
      .returning()
    return row!
  }
  const first = await procedure(40_000)
  const second = await procedure(20_000)
  await ownerDb
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: new Date(), signerName: "Clínico", signerRegistration: "12345" })
    .where(eq(encounter.id, f.encounter.id))
  const chargeA = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: first.id }))
  const chargeB = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: second.id }))
  const collect = (chargeId: string, amountCents: number) =>
    f.run((tx) => collectCharge(tx, ...f.args, { branchId, chargeIds: [chargeId], payments: [{ paymentMethodId: cash.id, amountCents }], requestId: randomUUID() }))
  const paid = await collect(chargeA.id, 40_000)
  await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 3000 }))
  const month = currentMonth()
  // Se paga la comisión de lo cobrado hasta ahí; después se cobra el segundo y se anula el primero.
  await f.run((tx) => payMonthCommission(tx, "org_a", f.actor, { professionalUserId: f.actor, year: month.year, month: month.month, branchId }))
  await collect(chargeB.id, 20_000)
  await f.run((tx) => voidTicket(tx, "org_a", f.actor, f.patient.id, paid.ticket.id, { reason: "Se cobró a otra persona", allowPostClose: false }))

  const official = (await f.run((tx) => listMonthCommissions(tx, "org_a", { year: month.year, month: month.month }))).find((row) => row.professionalUserId === f.actor)
  const report = (await f.run((tx) => getReportCommissions(tx, "org_a", { period: "este_mes" }))).rows.find((row) => row.userId === f.actor)
  expect(report).toMatchObject({
    collectedCents: official?.baseCents,
    commissionCents: official?.commissionCents,
    paidCents: official?.paidCents,
    pendingCents: Math.max(0, official?.pendingCents ?? 0),
    rateBps: 3000,
  })
  // Lo pagado (12 000 del primer cobro) se pagó igual, pero su cobro se anuló: no es comisión del mes y se
  // descontará del próximo pago; lo nuevo (6 000) no alcanza a cubrirlo, así que no hay nada por pagar.
  expect(report).toMatchObject({ collectedCents: 20_000, commissionCents: 6_000, paidCents: 12_000, pendingCents: 0, discountCents: 12_000 })

  // En la cascada, la comisión cuenta al generarse y su pago (un gasto de Personal) no vuelve a restar.
  const finance = await f.run((tx) => getReportFinance(tx, "org_a", { period: "este_mes", branchId }))
  const [byMonth] = await f.run((tx) => commissionsMany(tx, "org_a", [{ start: new Date(finance.period.start), end: new Date(finance.period.end) }], { currency: "PEN", branchId }))
  expect(finance.totals.current.commissionCents).toBe(byMonth?.reduce((total, row) => total + row.commissionCents, 0))
  expect(finance.cascade.commissionPaidCents).toBe(12_000)
  expect(finance.cascade.categories.find((row) => row.category === "Personal")).toBeUndefined()
  expect(finance.totals.current.leavesCents).toBe(finance.totals.current.cobradoCents - finance.totals.current.commissionCents - finance.totals.current.otherExpensesCents)
  // «En caja quedó» sí descuenta el pago de la comisión.
  expect(finance.totals.current.cashLeftCents).toBe(finance.totals.current.cobradoCents - 12_000)
})

async function purchasesClinic() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `compras-${orgId}`)
  const actor = randomUUID()
  await ownerDb.execute(`insert into "user" (id, name, email) values ('${actor}', 'Caja', '${actor}@compras.test')`)
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro" }).returning()
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const store = await run((tx) => createWarehouse(tx, orgId, actor, { branchId: site!.id, name: "Almacén" }))
  const seller = await run((tx) => createSupplier(tx, orgId, actor, { name: "Dental Perú" }))
  const item = await run((tx) => createProduct(tx, orgId, actor, { sku: "RES-A2", name: "Resina A2", kind: "insumo", unit: "jeringa", minStock: 0 }))
  const order = async (quantity: number, unitCostCents: number) => {
    const created = await run((tx) =>
      createPurchaseOrder(tx, orgId, actor, { supplierId: seller.id, warehouseId: store.id, lines: [{ productId: item.id, quantity, unitCostCents }] }),
    )
    await run((tx) => confirmPurchaseOrder(tx, orgId, actor, created.id))
    return created
  }
  const receive = (orderId: string, quantity: number) =>
    run((tx) => receivePurchaseOrder(tx, orgId, actor, orderId, [{ productId: item.id, quantity }], randomUUID()))
  const pay = (orderId: string, amountCents: number, extra: { creditCents?: number; expectedDueCents?: number } = {}) =>
    run((tx) => payPurchaseOrder(tx, orgId, actor, { orderId, amountCents, ...extra }))
  const balance = async (orderId: string) => (await run((tx) => purchaseBalances(tx, orgId, { orderIds: [orderId] })))[0]!
  const credit = async () => (await run((tx) => supplierCredits(tx, orgId)))[0]?.cents ?? 0
  return { orgId, actor, branchId: site!.id, run, order, receive, pay, balance, credit }
}

it("pagar una compra: en partes, por adelantado, de más queda a favor y lo a favor paga otra", async () => {
  const c = await purchasesClinic()
  const first = await c.order(10, 10_000)
  expect(first.orderNumber).toBe(1)
  // Por adelantado: nada llegó, no se debe nada; el pago es un adelanto.
  const advance = await c.pay(first.id, 30_000)
  expect(advance.expense).toMatchObject({ category: "Materiales", purchaseOrderId: first.id, branchId: c.branchId })
  expect(advance.expense?.concept).toBe("Adelanto de compra OC-0001 · Dental Perú")
  expect(await c.balance(first.id)).toMatchObject({ receivedCents: 0, paidCents: 30_000, dueCents: 0, aheadCents: 30_000 })
  // Llega la mitad: el adelanto se descuenta de lo recibido.
  await c.receive(first.id, 5)
  expect(await c.balance(first.id)).toMatchObject({ receivedCents: 50_000, dueCents: 20_000 })
  // En partes: paga 5 000 de los 20 000 que faltan, y la pantalla mostró la cifra correcta.
  await expect(c.pay(first.id, 5_000, { expectedDueCents: 19_000 })).rejects.toMatchObject({ code: "PURCHASE_DUE_CHANGED" })
  const part = await c.pay(first.id, 5_000, { expectedDueCents: 20_000 })
  expect(part.expense?.concept).toBe("Pago de compra OC-0001 · Dental Perú (una parte)")
  expect(part.balance).toMatchObject({ dueCents: 15_000 })
  // Lo recibido sin pagar al momento: antes y después de pagar.
  const [now] = await c.run((tx) => unpaidPurchasesMany(tx, c.orgId, [new Date(Date.now() + 1000)]))
  expect(now).toEqual([expect.objectContaining({ currency: "PEN", cents: 15_000, orders: 1 })])
  // Llega lo demás y se paga de más: al cerrar, el exceso queda a favor con el proveedor.
  await c.receive(first.id, 5)
  await c.pay(first.id, 77_000)
  expect(await c.balance(first.id)).toMatchObject({ status: "recibida", receivedCents: 100_000, paidCents: 112_000, dueCents: 0, aheadCents: 12_000 })
  expect(await c.credit()).toBe(12_000)
  // Lo a favor paga la siguiente compra del mismo proveedor, sin gasto: el dinero ya salió.
  const next = await c.order(2, 10_000)
  await expect(c.pay(next.id, 0, { creditCents: 13_000 })).rejects.toMatchObject({ code: "SUPPLIER_CREDIT_SHORT" })
  const used = await c.pay(next.id, 0, { creditCents: 12_000 })
  expect(used.expense).toBeNull()
  expect(used.balance).toMatchObject({ creditCents: 12_000, paidCents: 12_000 })
  expect(await c.credit()).toBe(0)
  // Anular el pago que dejó lo a favor ya usado no se puede: antes hay que anular ese uso.
  const overpay = (await c.run((tx) => getPurchaseOrder(tx, c.orgId, first.id))).payments.find((row) => row.amountCents === 77_000)!
  await expect(c.run((tx) => voidExpense(tx, c.orgId, c.actor, overpay.id, { reason: "Error" }))).rejects.toMatchObject({ code: "SUPPLIER_CREDIT_USED" })
})

it("cancelar una compra pagada pide qué hacer con sus pagos: anularlos o dejarlos a favor", async () => {
  const c = await purchasesClinic()
  const order = await c.order(4, 10_000)
  await c.pay(order.id, 15_000)
  await expect(c.run((tx) => cancelPurchaseOrder(tx, c.orgId, c.actor, order.id))).rejects.toMatchObject({ code: "PURCHASE_HAS_PAYMENTS" })
  await c.run((tx) => cancelPurchaseOrder(tx, c.orgId, c.actor, order.id, { payments: "a_favor" }))
  expect(await c.credit()).toBe(15_000)
  await expect(c.pay(order.id, 1_000)).rejects.toMatchObject({ code: "PURCHASE_CANCELLED" })

  const other = await c.order(4, 10_000)
  const paid = await c.pay(other.id, 8_000)
  await c.run((tx) => cancelPurchaseOrder(tx, c.orgId, c.actor, other.id, { payments: "anular", reason: "El proveedor devolvió el adelanto" }))
  const [voided] = await ownerDb.select().from(expense).where(eq(expense.id, paid.expense!.id))
  expect(voided?.voidReason).toBe("El proveedor devolvió el adelanto")
  expect(await c.credit()).toBe(15_000)
  // El gasto de una compra es siempre de Materiales.
  await expect(
    c.run((tx) => createExpense(tx, c.orgId, c.actor, { branchId: c.branchId, category: "Otros", concept: "x", amountCents: 100 }, { purchaseOrderId: other.id })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
})

it("te deben por antigüedad: lo de más de 30 días es exactamente el saldo vencido", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `deuda-${orgId}`)
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro" }).returning()
  const people = await insertTestPatients(
    ownerDb,
    [1, 2, 3].map((number) => ({ organizationId: orgId, displayName: `Persona ${number}`, patientNumber: number })),
  )
  const at = new Date("2026-09-30T05:00:00Z")
  const charge = async (patientId: string, daysAgo: number, amountCents: number) => {
    const [row] = await ownerDb
      .insert(patientCharge)
      .values({ organizationId: orgId, patientId, branchId: site!.id, description: "Tratamiento", amountCents, currency: "PEN", createdAt: new Date(at.getTime() - daysAgo * 86_400_000) })
      .returning()
    return row!
  }
  await charge(people[0]!.id, 10, 5_000)
  // La segunda persona debe dos conceptos: cuenta entera en el tramo del más antiguo.
  await charge(people[1]!.id, 45, 8_000)
  await charge(people[1]!.id, 5, 2_000)
  const old = await charge(people[2]!.id, 120, 30_000)
  const [payment] = await ownerDb
    .insert(patientPayment)
    .values({ organizationId: orgId, patientId: people[2]!.id, branchId: site!.id, amountCents: 10_000, currency: "PEN", paidAt: new Date(at.getTime() - 60 * 86_400_000), methodName: "Efectivo" })
    .returning()
  await ownerDb.insert(patientPaymentApplication).values({ organizationId: orgId, patientId: people[2]!.id, paymentId: payment!.id, chargeId: old.id, amountCents: 10_000, createdAt: payment!.paidAt })
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const [aging] = await run((tx) => debtAgingMany(tx, orgId, [at], { currency: "PEN" }))
  expect(aging?.ages).toEqual([
    { key: "0_30", cents: 5_000, people: 1 },
    { key: "31_60", cents: 10_000, people: 1 },
    { key: "61_90", cents: 0, people: 0 },
    { key: "90_plus", cents: 20_000, people: 1 },
  ])
  const [overdue] = await run((tx) => overdueDebtMany(tx, orgId, undefined, [at]))
  expect(overdue).toEqual([{ currency: "PEN", cents: 30_000, people: 2 }])
})

it("puede faltar un gasto: se avisa el tipo que tuvo los dos meses anteriores y se calla con «No hubo ese gasto»", async () => {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `faltante-${orgId}`)
  const actor = randomUUID()
  await ownerDb.execute(`insert into "user" (id, name, email) values ('${actor}', 'Caja', '${actor}@faltante.test')`)
  const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro" }).returning()
  const run = <T>(fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const spend = (iso: string, category: string, amountCents: number) =>
    run((tx) => createExpense(tx, orgId, actor, { branchId: site!.id, category, concept: `${category} del mes`, amountCents, spentAt: iso }))
  await spend("2026-07-18T15:00:00Z", "Impuestos", 190_000)
  await spend("2026-08-18T15:00:00Z", "Impuestos", 190_000)
  await spend("2026-07-01T15:00:00Z", "Alquiler", 500_000)
  await spend("2026-08-01T15:00:00Z", "Alquiler", 500_000)
  await spend("2026-09-01T15:00:00Z", "Alquiler", 500_000)
  const now = new Date("2026-10-12T15:00:00Z")
  const report = await run((tx) => getReportFinance(tx, orgId, { period: "2026-09" }, now))
  expect(report.missing).toEqual([
    expect.objectContaining({
      category: "Impuestos",
      branch: { id: site!.id, name: "Centro" },
      previous: [
        { month: "2026-07", cents: 190_000 },
        { month: "2026-08", cents: 190_000 },
      ],
      copy: { month: "2026-08", concept: "Impuestos del mes", amountCents: 190_000, day: 18 },
    }),
  ])
  await run((tx) => dismissExpenseGap(tx, orgId, actor, { category: "Impuestos", month: "2026-09", branchId: site!.id }))
  // Repetirlo no hace nada.
  await run((tx) => dismissExpenseGap(tx, orgId, actor, { category: "Impuestos", month: "2026-09", branchId: site!.id }))
  expect((await run((tx) => getReportFinance(tx, orgId, { period: "2026-09" }, now))).missing).toEqual([])
})
