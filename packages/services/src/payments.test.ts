import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { branch } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { createBudget, decideBudget, deliverBudget, reviseBudget } from "./budgets.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { addPlanItem } from "./plan.js"
import { patientCharge, patientContact, patientPaymentRefund } from "@odentia/db/schema/clinical"
import { cashMovement } from "@odentia/db/schema/finance"
import { product, productLot, stockMovement } from "@odentia/db/schema/inventory"
import { and, eq, isNull, like, sql } from "drizzle-orm"
import { getAgentPatientSummary } from "./agent-operations.js"
import { defaultWarehouse, lotFor, receiveIntoLot, shortageOf } from "./inventory-stock.js"
import {
  collectCharge,
  createCharge,
  getAccountSummary,
  getPatientAccount,
  getTicketReturnable,
  listSaleProducts,
  refundCredit,
  returnFromTicket,
  updateCharge,
  voidCharge,
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

async function seedMethods(f: Fixture) {
  const cash = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }),
  )
  const yape = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Yape", typeCode: "68" }),
  )
  return { cash, yape }
}

async function seedBranch(_f: Fixture) {
  const [row] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede cobro ${randomUUID()}` })
    .returning()
  return row.id
}

it("conserva el límite por tratamiento y la edición con motivo sin aplicaciones", async () => {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  const first = await f.run((tx) =>
    createCharge(tx, ...f.args, { budgetItemId: budget.items[0].id, amountCents: 40000 }),
  )
  // La línea hereda la promoción de la propuesta (aquí sin promoción).
  expect(first.promotionId).toBeNull()
  const edited = await f.run((tx) =>
    updateCharge(tx, ...f.args, first.id, { amountCents: 35000, reason: "Descuento en mostrador" }),
  )
  expect(edited.amountCents).toBe(35000)
  expect(edited.editReason).toBe("Descuento en mostrador")
  const second = await f.run((tx) =>
    createCharge(tx, ...f.args, { budgetItemId: budget.items[0].id, amountCents: 80000 }),
  )
  expect(second.amountCents).toBe(80000)
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  const pen = summary.byCurrency.find((c) => c.currency === "PEN")
  expect(pen).toMatchObject({ porCobrar: 115000, pagado: 0, aFavor: 0 })
  expect(summary.pendiente).toHaveLength(2)
  expect(summary.pendiente[0]).toMatchObject({ budgetItemId: budget.items[0].id })
  const other = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  await expect(
    f.run((tx) => reviseBudget(tx, ...f.args, budget.id, { itemIds: [other.id], reason: "Cambio de plan" })),
  ).rejects.toMatchObject({ code: "BUDGET_ITEM_IN_USE" })
})

it("no vuelve a cobrar el mismo tratamiento al revisar la propuesta", async () => {
  const f = await clinicalFixture()
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const original = await f.run((tx) =>
    createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, original.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, original.id, {
      decisions: [{ planItemId: item.id, decision: "aceptado" }],
    }),
  )
  await f.run((tx) =>
    createCharge(tx, ...f.args, { budgetItemId: original.items[0].id, amountCents: 120000 }),
  )
  const revision = await f.run((tx) =>
    reviseBudget(tx, ...f.args, original.id, { itemIds: [item.id], reason: "Revisión sin cambios" }),
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, revision.id))
  await f.run((tx) => decideBudget(tx, ...f.args, revision.id, {
    decisions: [{ planItemId: item.id, decision: "aceptado" }],
  }))
  await expect(
    f.run((tx) => createCharge(tx, ...f.args, { budgetItemId: revision.items[0].id })),
  ).rejects.toMatchObject({ code: "CHARGE_EXCEEDS_BUDGET" })
})

it("el concepto manual toma la moneda de la clínica sin pedirla", async () => {
  const f = await clinicalFixture()
  const charge = await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Cepillo", amountCents: 2500 }),
  )
  expect(charge.currency).toBe("PEN")
  expect(charge.amountCents).toBe(2500)
})

it("cobra multimedio con vuelto, reparte FIFO y anula el concepto sin cobros", async () => {
  const f = await clinicalFixture()
  const { cash, yape } = await seedMethods(f)
  const branchId = await seedBranch(f)
  const first = await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Resina", amountCents: 33000, currency: "PEN" }),
  )
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Profilaxis", amountCents: 12000, currency: "PEN" }),
  )
  const collected = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [
        { paymentMethodId: cash.id, amountCents: 20000 },
        { paymentMethodId: yape.id, amountCents: 25000, reference: "OP-1" },
      ],
      cashReceivedCents: 50000,
      requestId: "11111111-1111-4111-8111-111111111111",
    }),
  )
  expect(collected.ticket.ticketNumber).toBe(1)
  expect(collected.ticket.changeCents).toBe(30000)
  expect(collected.remainingCents).toBe(0)
  expect(collected.payments).toHaveLength(2)
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(summary.byCurrency.find((c) => c.currency === "PEN")).toMatchObject({
    porCobrar: 0,
    pagado: 45000,
    aFavor: 0,
  })
  expect(summary.cobros[0]).toMatchObject({ number: 1, status: "vigente" })
  // Un concepto con cobros aplicados no se edita ni se anula.
  await expect(
    f.run((tx) => updateCharge(tx, ...f.args, first.id, { amountCents: 1, reason: "X" })),
  ).rejects.toMatchObject({ code: "CHARGE_HAS_APPLICATIONS" })
  await expect(
    f.run((tx) => voidCharge(tx, ...f.args, first.id, { reason: "X" })),
  ).rejects.toMatchObject({ code: "CHARGE_HAS_APPLICATIONS" })
})

it("el portal dice los mismos montos que Caja: multiplica por sesiones y resta las devoluciones", async () => {
  const f = await clinicalFixture()
  const { cash } = await seedMethods(f)
  const branchId = await seedBranch(f)
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  // Ortodoncia por sesiones: 12 visitas de S/ 1 200.
  await ownerDb.execute(
    sql`update treatment_budget_item set billing_mode = 'session', sessions_planned = 12 where budget_id = ${budget.id}`,
  )
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) =>
    decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }),
  )
  // Paga S/ 500 por adelantado y se le devuelven S/ 100.
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 50000,
      payments: [{ paymentMethodId: cash.id, amountCents: 50000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) => refundCredit(tx, ...f.args, { branchId, amountCents: 10000, reason: "Pagó de más" }))
  const caja = (await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))).byCurrency.find((c) => c.currency === "PEN")
  const portal = (await f.run((tx) => getPatientAccount(tx, "org_a", f.patient.id))).byCurrency.find((c) => c.currency === "PEN")
  expect(portal?.agreedCents).toBe(12 * 120000)
  expect(portal).toMatchObject({ pagado: 40000, aFavor: 40000, porCobrar: 0, saldo: 0 })
  expect(portal).toMatchObject({ pagado: caja?.pagado, aFavor: caja?.aFavor, porCobrar: caja?.porCobrar, saldo: caja?.saldo })
})

it("el saldo descuenta lo que tiene a favor, y «Aplicar» cancela la deuda con un movimiento registrado", async () => {
  const f = await clinicalFixture()
  const { cash } = await seedMethods(f)
  const branchId = await seedBranch(f)
  await f.run((tx) => createCharge(tx, ...f.args, { description: "Resina", amountCents: 10000 }))
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 6000,
      payments: [{ paymentMethodId: cash.id, amountCents: 6000 }],
      requestId: randomUUID(),
    }),
  )
  const before = (await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))).byCurrency[0]
  // «Debe: S/ 100 · A favor: S/ 60 · Saldo: S/ 40».
  expect(before).toMatchObject({ porCobrar: 10000, aFavor: 6000, saldo: 4000 })
  // El agente dice el mismo saldo, no lo que debe sin descontar.
  const [self] = await ownerDb
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(and(eq(patientContact.organizationId, "org_a"), eq(patientContact.patientId, f.patient.id), eq(patientContact.relationship, "self")))
  const told = await f.run((tx) => getAgentPatientSummary(tx, "org_a", self!.contactId, f.patient.id))
  expect(told.balance).toEqual([{ currency: before!.currency, outstandingCents: 4000 }])
  // Aplicar lo que tiene a favor: el mismo cobro de caja, sin dinero nuevo.
  const applied = await f.run((tx) => collectCharge(tx, ...f.args, { branchId, requestId: randomUUID() }))
  expect(applied.creditAppliedCents).toBe(6000)
  // No alcanza: lo que falta.
  expect(applied.remainingCents).toBe(4000)
  expect(applied.ticket).toMatchObject({ totalCents: 0, creditAppliedCents: 6000 })
  expect(applied.account.byCurrency[0]).toMatchObject({ porCobrar: 4000, aFavor: 0, saldo: 4000 })
  // Lo registrado se ve en sus cobros.
  expect(applied.account.cobros.some((row) => row.ticketId === applied.ticket.id)).toBe(true)
})

it("vender un producto desde Cobrar: descuenta de la sede, deja faltante, y quitar el concepto o anular el ticket lo devuelven", async () => {
  const f = await clinicalFixture()
  const { cash } = await seedMethods(f)
  const branchId = await seedBranch(f)
  const store = await f.run((tx) => defaultWarehouse(tx, "org_a", branchId))
  const tag = randomUUID().slice(0, 8)
  const newProduct = async (values: Partial<typeof product.$inferInsert>) => {
    const [row] = await ownerDb
      .insert(product)
      .values({ organizationId: "org_a", sku: `VTA-${randomUUID().slice(0, 8)}`, name: `Producto ${tag}`, unit: "unidad", ...values })
      .returning()
    return row!
  }
  const brush = await newProduct({
    name: `Cepillo dental suave ${tag}`,
    unit: "cepillo",
    usedInCare: false,
    forSale: true,
    salePriceCents: 1500,
    saleCurrency: "PEN",
  })
  const lot = await f.run(async (tx) => {
    const row = await lotFor(tx, "org_a", { productId: brush.id, warehouseId: store.id, code: "C-1", actorUserId: f.actor })
    await receiveIntoLot(tx, "org_a", {
      lot: row,
      quantity: 3,
      base: { kind: "ingreso", reason: "Prueba", actorUserId: f.actor, keyPrefix: `prueba:${randomUUID()}` },
    })
    return row
  })
  const lotQuantity = async () =>
    (await ownerDb.select({ q: productLot.quantityOnHand }).from(productLot).where(eq(productLot.id, lot.id)))[0]?.q

  // «+ Agregar producto»: lo que se vende, con su precio y lo que hay en la sede; nunca el costo.
  const found = await f.run((tx) => listSaleProducts(tx, "org_a", { branchId, q: `cepillo ${tag}` }))
  expect(found.items).toEqual([
    {
      productId: brush.id,
      name: brush.name,
      unit: "cepillo",
      salePriceCents: 1500,
      currency: "PEN",
      onHand: 3,
      onHandText: "3 cepillos",
    },
  ])

  // El concepto toma nombre y precio × cantidad, y sale del lote al agregarlo.
  const saleKey = randomUUID()
  const two = await f.run((tx) => createCharge(tx, ...f.args, { productId: brush.id, quantity: 2, branchId, requestKey: saleKey }))
  expect(two).toMatchObject({
    description: `${brush.name} × 2`,
    amountCents: 3000,
    currency: "PEN",
    productId: brush.id,
    productQuantity: 2,
    branchId,
  })
  expect(await lotQuantity()).toBe(1)
  const [sold] = await ownerDb.select().from(stockMovement).where(eq(stockMovement.chargeId, two.id))
  expect(sold).toMatchObject({ kind: "venta", quantityDelta: -2, patientId: f.patient.id, reason: "Vendido a Paciente de prueba" })
  // El mismo formulario otra vez (un corte de red): el mismo concepto, sin vender ni descontar de nuevo.
  const again = await f.run((tx) => createCharge(tx, ...f.args, { productId: brush.id, quantity: 2, branchId, requestKey: saleKey }))
  expect(again.id).toBe(two.id)
  expect(await lotQuantity()).toBe(1)
  await expect(
    f.run((tx) => createCharge(tx, ...f.args, { productId: brush.id, quantity: 3, branchId, requestKey: saleKey })),
  ).rejects.toThrow("ya se registró con otros datos")
  await expect(f.run((tx) => createCharge(tx, ...f.args, { productId: brush.id, quantity: 1, branchId }))).rejects.toThrow(
    "No se pudo identificar esta venta",
  )

  // Sin lo suficiente se vende igual: lo que falta queda como faltante.
  const more = await f.run((tx) => createCharge(tx, ...f.args, { productId: brush.id, quantity: 2, branchId, requestKey: randomUUID() }))
  expect(await lotQuantity()).toBe(0)
  expect(await f.run((tx) => shortageOf(tx, "org_a", brush.id, store.id))).toBe(1)
  // Con uno solo, el nombre sin «× 1».
  const one = await f.run((tx) => createCharge(tx, ...f.args, { productId: brush.id, branchId, requestKey: randomUUID() }))
  expect(one).toMatchObject({ description: brush.name, amountCents: 1500, productQuantity: 1 })
  expect(await f.run((tx) => shortageOf(tx, "org_a", brush.id, store.id))).toBe(2)

  // Quitar el concepto lo devuelve: primero baja el faltante.
  await f.run((tx) => voidCharge(tx, ...f.args, more.id, { reason: "Se arrepintió" }))
  expect(await f.run((tx) => shortageOf(tx, "org_a", brush.id, store.id))).toBe(0)
  const back = await ownerDb
    .select()
    .from(stockMovement)
    .where(and(eq(stockMovement.chargeId, more.id), eq(stockMovement.kind, "devolucion")))
  expect(back.reduce((sum, row) => sum + row.quantityDelta, 0)).toBe(2)

  // La corrección con motivo sigue igual y no toca lo que hay.
  const fixed = await f.run((tx) => updateCharge(tx, ...f.args, one.id, { amountCents: 1200, reason: "Precio de campaña" }))
  expect(fixed.amountCents).toBe(1200)

  // Anular el ticket deshace la venta (ADR 0068): el producto sale de la cuenta y vuelve a la sede.
  const collected = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [two.id],
      payments: [{ paymentMethodId: cash.id, amountCents: 3000 }],
      requestId: randomUUID(),
    }),
  )
  const before = await lotQuantity()
  const voided = await f.run((tx) =>
    voidTicket(tx, ...f.args, collected.ticket.id, { reason: "Error de medio", allowPostClose: false }),
  )
  expect(voided.returnedProducts).toEqual([{ description: `${brush.name} × 2`, quantity: 2, branchId }])
  expect(await lotQuantity()).toBe((before ?? 0) + 2)
  const [gone] = await ownerDb.select().from(patientCharge).where(eq(patientCharge.id, two.id))
  expect(gone?.voidedAt).not.toBeNull()
  const after = await ownerDb.select().from(stockMovement).where(eq(stockMovement.chargeId, two.id))
  expect(after.map((row) => [row.kind, row.quantityDelta])).toEqual([
    ["venta", -2],
    ["devolucion", 2],
  ])

  // Lo que no se vende, sin precio, desactivado o sin sede: error en palabras.
  const supply = await newProduct({ name: `Guantes ${tag}`, usedInCare: true })
  const unpriced = await newProduct({ name: `Enjuague ${tag}`, usedInCare: false, forSale: true })
  const retired = await newProduct({ name: `Hilo ${tag}`, forSale: true, salePriceCents: 900, saleCurrency: "PEN", isActive: false })
  await expect(f.run((tx) => createCharge(tx, ...f.args, { productId: supply.id, branchId }))).rejects.toMatchObject({
    code: "PRODUCT_NOT_FOR_SALE",
  })
  await expect(f.run((tx) => createCharge(tx, ...f.args, { productId: unpriced.id, branchId }))).rejects.toMatchObject({
    code: "PRODUCT_WITHOUT_PRICE",
    message: expect.stringContaining("no tiene precio de venta"),
  })
  await expect(f.run((tx) => createCharge(tx, ...f.args, { productId: retired.id, branchId }))).rejects.toMatchObject({
    code: "PRODUCT_INACTIVE",
  })
  await expect(f.run((tx) => createCharge(tx, ...f.args, { productId: brush.id }))).rejects.toMatchObject({
    code: "VALIDATION",
  })
  await expect(
    f.run((tx) => createCharge(tx, ...f.args, { productId: brush.id, branchId, amountCents: 100 })),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  const listed = await f.run((tx) => listSaleProducts(tx, "org_a", { branchId, q: tag }))
  expect(listed.items.map((item) => item.productId).sort()).toEqual([brush.id, unpriced.id].sort())
  expect(listed.items.find((item) => item.productId === unpriced.id)).toMatchObject({ salePriceCents: null, onHandText: null })
})

it("devolver desde un ticket: la venta queda, el producto vuelve si sirve, se le paga o queda a favor y el ticket ya no se anula", async () => {
  const f = await clinicalFixture()
  const { cash, yape } = await seedMethods(f)
  const branchId = await seedBranch(f)
  const store = await f.run((tx) => defaultWarehouse(tx, "org_a", branchId))
  const [brush] = await ownerDb
    .insert(product)
    .values({
      organizationId: "org_a",
      sku: `DEV-${randomUUID().slice(0, 8)}`,
      name: "Cepillo interdental",
      unit: "cepillo",
      usedInCare: false,
      forSale: true,
      salePriceCents: 1500,
      saleCurrency: "PEN",
    })
    .returning()
  const lot = await f.run(async (tx) => {
    const row = await lotFor(tx, "org_a", { productId: brush!.id, warehouseId: store.id, code: "D-1", actorUserId: f.actor })
    await receiveIntoLot(tx, "org_a", {
      lot: row,
      quantity: 5,
      base: { kind: "ingreso", reason: "Prueba", actorUserId: f.actor, keyPrefix: `prueba:${randomUUID()}` },
    })
    return row
  })
  const lotQuantity = async () =>
    (await ownerDb.select({ q: productLot.quantityOnHand }).from(productLot).where(eq(productLot.id, lot.id)))[0]?.q
  const sale = await f.run((tx) =>
    createCharge(tx, ...f.args, { productId: brush!.id, quantity: 2, branchId, requestKey: randomUUID() }),
  )
  const cleaning = await f.run((tx) => createCharge(tx, ...f.args, { description: "Limpieza dental", amountCents: 12000 }))
  const collected = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [sale.id, cleaning.id],
      payments: [{ paymentMethodId: cash.id, amountCents: 15000 }],
      requestId: randomUUID(),
    }),
  )
  const ticketId = collected.ticket.id
  expect(await lotQuantity()).toBe(3)

  // Qué se puede devolver: cada concepto como está hoy, con lo que pagó este ticket.
  const open = await f.run((tx) => getTicketReturnable(tx, "org_a", f.patient.id, ticketId))
  expect(open.lines).toEqual([
    expect.objectContaining({ chargeId: sale.id, kind: "producto", productName: "Cepillo interdental", quantity: 2, paidCents: 3000, blockedReason: null }),
    expect.objectContaining({ chargeId: cleaning.id, kind: "servicio", paidCents: 12000, blockedReason: null }),
  ])
  expect(open.methods).toEqual([expect.objectContaining({ paymentMethodId: cash.id, typeCode: "10" })])

  // Devuelve 1 de 2 cepillos, en buen estado, y se le pagan en efectivo.
  const key = randomUUID()
  const input = {
    branchId,
    lines: [{ chargeId: sale.id, quantity: 1 }],
    paymentMethodId: cash.id,
    reason: "No lo quería",
    requestId: key,
  }
  const first = await f.run((tx) => returnFromTicket(tx, ...f.args, ticketId, input))
  expect(first.duplicate).toBe(false)
  expect(first.paymentReturn).toMatchObject({ returnNumber: 1, totalCents: 1500, outcome: "pagado", methodName: "Efectivo" })
  expect(await lotQuantity()).toBe(4)
  // La venta queda en pie: el concepto se anula y otro sigue con lo que queda.
  const [old] = await ownerDb.select().from(patientCharge).where(eq(patientCharge.id, sale.id))
  expect(old?.voidedAt).not.toBeNull()
  const [kept] = await ownerDb
    .select()
    .from(patientCharge)
    .where(and(eq(patientCharge.originalChargeId, sale.id), isNull(patientCharge.voidedAt)))
  expect(kept).toMatchObject({ description: "Cepillo interdental", amountCents: 1500, productQuantity: 1, returnedCents: 1500 })
  let account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(account.byCurrency.find((c) => c.currency === "PEN")).toMatchObject({ porCobrar: 0, pagado: 13500, aFavor: 0 })
  const refunds = await ownerDb
    .select()
    .from(patientPaymentRefund)
    .where(eq(patientPaymentRefund.returnId, first.paymentReturn.id))
  expect(refunds.reduce((sum, row) => sum + row.amountCents, 0)).toBe(1500)
  const [out] = await ownerDb
    .select()
    .from(cashMovement)
    .where(and(eq(cashMovement.organizationId, "org_a"), like(cashMovement.concept, "Devolución 000001%")))
  expect(out).toMatchObject({ direction: "egreso", kind: "devolucion", amountCents: 1500, methodTypeCode: "10" })

  // Un reintento devuelve la misma devolución, sin devolver dos veces.
  const again = await f.run((tx) => returnFromTicket(tx, ...f.args, ticketId, input))
  expect(again).toMatchObject({ duplicate: true, paymentReturn: { id: first.paymentReturn.id } })
  expect(await lotQuantity()).toBe(4)
  await expect(
    f.run((tx) => returnFromTicket(tx, ...f.args, ticketId, { ...input, reason: "Otro motivo" })),
  ).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" })

  // Con una devolución, el ticket ya no se anula.
  await expect(
    f.run((tx) => voidTicket(tx, ...f.args, ticketId, { reason: "Error", allowPostClose: false })),
  ).rejects.toMatchObject({ code: "TICKET_HAS_REFUNDS" })

  // El otro cepillo llegó abierto: no vuelve a la venta y el dinero queda a favor.
  const now = await f.run((tx) => getTicketReturnable(tx, "org_a", f.patient.id, ticketId))
  expect(now.lines[0]).toMatchObject({ chargeId: kept!.id, quantity: 1, paidCents: 1500 })
  expect(now.returns).toHaveLength(1)
  await expect(
    f.run((tx) =>
      returnFromTicket(tx, ...f.args, ticketId, { ...input, lines: [{ chargeId: kept!.id, quantity: 2 }], requestId: randomUUID() }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  const second = await f.run((tx) =>
    returnFromTicket(tx, ...f.args, ticketId, {
      branchId,
      lines: [{ chargeId: kept!.id, quantity: 1, backToStock: false }],
      paymentMethodId: null,
      reason: "Llegó abierto",
      requestId: randomUUID(),
    }),
  )
  expect(second.paymentReturn).toMatchObject({ returnNumber: 2, totalCents: 1500, outcome: "a_favor", methodName: null })
  expect(await lotQuantity()).toBe(4)
  const stillSold = await ownerDb
    .select()
    .from(patientCharge)
    .where(and(eq(patientCharge.originalChargeId, sale.id), isNull(patientCharge.voidedAt)))
  expect(stillSold).toHaveLength(0)
  account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(account.byCurrency.find((c) => c.currency === "PEN")).toMatchObject({ porCobrar: 0, aFavor: 1500 })

  // De la limpieza se devuelve un importe por un reclamo; nunca más de lo que pagó este ticket.
  await expect(
    f.run((tx) =>
      returnFromTicket(tx, ...f.args, ticketId, {
        branchId,
        lines: [{ chargeId: cleaning.id, amountCents: 12001 }],
        paymentMethodId: yape.id,
        reason: "Reclamo",
        requestId: randomUUID(),
      }),
    ),
  ).rejects.toMatchObject({ code: "RETURN_EXCEEDS_PAID" })
  await f.run((tx) =>
    returnFromTicket(tx, ...f.args, ticketId, {
      branchId,
      lines: [{ chargeId: cleaning.id, amountCents: 5000 }],
      paymentMethodId: yape.id,
      reason: "Reclamo",
      requestId: randomUUID(),
    }),
  )
  const [rest] = await ownerDb
    .select()
    .from(patientCharge)
    .where(and(eq(patientCharge.originalChargeId, cleaning.id), isNull(patientCharge.voidedAt)))
  expect(rest).toMatchObject({ description: "Limpieza dental", amountCents: 7000, returnedCents: 5000 })
  account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(account.byCurrency.find((c) => c.currency === "PEN")).toMatchObject({ porCobrar: 0, aFavor: 1500, pagado: 8500 })
  expect(account.cobros[0]?.returns.map((item) => item.number)).toEqual([1, 2, 3])
})

it("una devolución no deja otra vez por cobrar lo que ya se cobró de un tratamiento", async () => {
  const f = await clinicalFixture()
  const { cash } = await seedMethods(f)
  const branchId = await seedBranch(f)
  const item = await f.run((tx) =>
    addPlanItem(tx, ...f.args, { serviceId: f.service.id, planId: f.plan.id, sourceEncounterId: f.encounter.id }),
  )
  const budget = await f.run((tx) => createBudget(tx, ...f.args, { planId: f.plan.id, itemIds: [item.id] }))
  await f.run((tx) => deliverBudget(tx, ...f.args, budget.id))
  await f.run((tx) => decideBudget(tx, ...f.args, budget.id, { decisions: [{ planItemId: item.id, decision: "aceptado" }] }))
  const charge = await f.run((tx) => createCharge(tx, ...f.args, { budgetItemId: budget.items[0].id }))
  const collected = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [charge.id],
      payments: [{ paymentMethodId: cash.id, amountCents: charge.amountCents }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    returnFromTicket(tx, ...f.args, collected.ticket.id, {
      branchId,
      lines: [{ chargeId: charge.id, amountCents: 1000 }],
      paymentMethodId: null,
      reason: "Descuento por reclamo",
      requestId: randomUUID(),
    }),
  )
  await expect(
    f.run((tx) => createCharge(tx, ...f.args, { budgetItemId: budget.items[0].id })),
  ).rejects.toMatchObject({ code: "CHARGE_EXCEEDS_BUDGET" })
})
