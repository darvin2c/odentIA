/**
 * Cobrar en dos monedas: un servicio en dólares se debe en dólares hasta que se
 * paga. Un cobro cancela una moneda y entra en una; la caja recibe lo que entró, el
 * valor en moneda del negocio queda congelado y anular o devolver no usan un cambio
 * nuevo. Una clínica que paga en su moneda deja todo vacío y la huella de siempre.
 */
import { randomUUID } from "node:crypto"
import { type Db, withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import {
  patientPayment,
  patientPaymentRefund,
  paymentTicket,
  serviceCatalog,
} from "@odentia/db/schema/clinical"
import { cashClosure, cashMovement, cashShift } from "@odentia/db/schema/finance"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  addCashMovement,
  closeCashWindow,
  getCashState,
  getCashToday,
  getDayMovements,
  listDebts,
} from "./finance.js"
import {
  buildTicketSnapshot,
  getRefundReceiptPdf,
  renderReturnPdf,
  renderTicketPdf,
} from "./financial-document-pdf.js"
import { setOrgExchangeRate } from "./organization-profile.js"
import { createPaymentMethod } from "./payment-methods.js"
import { nextPatientNumber } from "./patients.js"
import {
  collectCharge,
  createCharge,
  getAccountSummary,
  getRefundReceipt,
  getTicketReturnable,
  refundCredit,
  returnFromTicket,
  type TicketFrozen,
  voidTicket,
} from "./payments.js"
import { insertTestPatients } from "./test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

async function clinic(rate: string | null = "3.75") {
  const orgId = `org-${randomUUID()}`
  await insertOrg(ownerDb, orgId, orgId)
  const actor = randomUUID()
  await ownerDb
    .insert(user)
    .values({ id: actor, name: "Rosa Caja", email: `${actor}@example.test` })
  const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  if (rate)
    await run((tx) =>
      setOrgExchangeRate(tx, orgId, actor, { secondCurrency: "USD", exchangeRate: rate }),
    )
  const [patient] = await insertTestPatients(ownerDb, {
    organizationId: orgId,
    displayName: "Lucía Ramos",
    patientNumber: await nextPatientNumber(ownerDb, orgId),
  })
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: orgId, name: "Miraflores" })
    .returning()
  const cash = await run((tx) =>
    createPaymentMethod(tx, orgId, actor, { name: "Efectivo", typeCode: "10" }),
  )
  const card = await run((tx) =>
    createPaymentMethod(tx, orgId, actor, { name: "Tarjeta", typeCode: "48" }),
  )
  const args = [orgId, actor, patient.id] as const
  const charge = (amountCents: number, currency: string, description = "Implante unitario") =>
    run((tx) => createCharge(tx, ...args, { description, amountCents, currency }))
  const collect = (
    body: Omit<Parameters<typeof collectCharge>[4], "branchId" | "requestId"> & {
      requestId?: string
    },
  ) =>
    run((tx) => collectCharge(tx, ...args, { branchId: site.id, requestId: randomUUID(), ...body }))
  const box = (currency: string) =>
    run((tx) => getCashState(tx, orgId, { branchId: site.id, currency }))
  const movements = async (paymentId?: string) => {
    const rows = await ownerDb
      .select({
        kind: cashMovement.kind,
        direction: cashMovement.direction,
        amountCents: cashMovement.amountCents,
        currency: cashMovement.currency,
        shiftCurrency: cashShift.currency,
        voidedAt: cashMovement.voidedAt,
        patientPaymentId: cashMovement.patientPaymentId,
      })
      .from(cashMovement)
      .innerJoin(cashShift, eq(cashShift.id, cashMovement.shiftId))
      .where(
        and(
          eq(cashMovement.organizationId, orgId),
          ...(paymentId ? [eq(cashMovement.patientPaymentId, paymentId)] : []),
        ),
      )
    return rows.map(({ patientPaymentId: _id, ...row }) => row)
  }
  const close = async (currency: string, countedCents: number) =>
    run((tx) =>
      closeCashWindow(tx, orgId, actor, {
        branchId: site.id,
        currency,
        countedCents,
        retainedCents: countedCents,
        deliveredCents: 0,
      }),
    )
  return {
    orgId,
    actor,
    patient,
    site,
    cash,
    card,
    args,
    run,
    charge,
    collect,
    box,
    movements,
    close,
  }
}

const live = <T extends { voidedAt: Date | null }>(rows: T[]) => rows.filter((row) => !row.voidedAt)
const paymentsOf = (ticketId: string) =>
  ownerDb.select().from(patientPayment).where(eq(patientPayment.ticketId, ticketId))
const columns = (row: typeof patientPayment.$inferSelect) => ({
  amountCents: row.amountCents,
  currency: row.currency.trim(),
  tenderCents: row.tenderCents,
  tenderCurrency: row.tenderCurrency?.trim() ?? null,
  exchangeRate: row.exchangeRate,
  businessCents: row.businessCents,
})
/** La cuenta del esperado: nada se mueve en caja fuera del desglose. */
const breakdownSum = (b: Awaited<ReturnType<ReturnType<typeof getCashStateOf>>>["breakdown"]) =>
  b.openingCents +
  b.cashCollectedCents +
  b.cashAddedCents -
  b.cashExpensesCents -
  b.cashWithdrawnCents -
  b.cashRefundedCents +
  b.cashChangeCents
function getCashStateOf(c: Awaited<ReturnType<typeof clinic>>) {
  return (currency: string) => c.box(currency)
}

it("debe USD 1,000 y paga S/ 3,750: se cancela en dólares y entra a la caja de soles", async () => {
  const c = await clinic()
  const debt = await c.charge(100000, "USD")
  const paid = await c.collect({
    chargeIds: [debt.id],
    currency: "USD",
    tenderCurrency: "PEN",
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 375000 }],
  })
  expect(paid.remainingCents).toBe(0)
  const [payment] = await paymentsOf(paid.ticket.id)
  expect(columns(payment)).toEqual({
    amountCents: 100000,
    currency: "USD",
    tenderCents: 375000,
    tenderCurrency: "PEN",
    exchangeRate: "3.75",
    businessCents: 375000,
  })
  expect(paid.ticket).toMatchObject({ currency: "USD", totalCents: 100000, changeCurrency: null })
  // La caja de soles recibe lo que entró; la de dólares no se entera.
  expect(await c.movements()).toMatchObject([
    {
      kind: "cobro",
      direction: "ingreso",
      amountCents: 375000,
      currency: "PEN",
      shiftCurrency: "PEN",
    },
  ])
  expect((await c.box("PEN")).cashOnHandCents).toBe(375000)
  expect((await c.box("USD")).cashOnHandCents).toBe(0)
  // La cuenta lee lo que cancela, cada moneda por su lado.
  const account = await c.run((tx) => getAccountSummary(tx, c.orgId, c.patient.id))
  expect(account.byCurrency).toMatchObject([
    { currency: "USD", porCobrar: 0, pagado: 100000, aFavor: 0 },
  ])
  expect(account.cobros[0]).toMatchObject({
    currency: "USD",
    payments: [
      {
        amountCents: 100000,
        tenderCents: 375000,
        tenderCurrency: "PEN",
        exchangeRate: "3.75",
        businessCents: 375000,
      },
    ],
  })
  // El ticket congela con qué pagó y a qué cambio: arriba lo que canceló, abajo lo que entró.
  const frozen = paid.ticket.snapshot as TicketFrozen
  expect(frozen.tender).toEqual({
    currency: "PEN",
    amountCents: 375000,
    rate: "3.75",
    businessCurrency: "PEN",
    otherCurrency: "USD",
  })
  expect(frozen.methods).toMatchObject([
    { name: "Efectivo", amountCents: 100000, tenderCents: 375000 },
  ])
})

it("debe USD y paga USD: sin moneda entregada aparte, con el cambio y el valor", async () => {
  const c = await clinic()
  const debt = await c.charge(100000, "USD")
  const paid = await c.collect({
    chargeIds: [debt.id],
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: c.card.id, amountCents: 100000 }],
  })
  const [payment] = await paymentsOf(paid.ticket.id)
  expect(columns(payment)).toEqual({
    amountCents: 100000,
    currency: "USD",
    tenderCents: null,
    tenderCurrency: null,
    exchangeRate: "3.75",
    businessCents: 375000,
  })
  expect(await c.movements()).toMatchObject([
    { kind: "cobro", amountCents: 100000, shiftCurrency: "USD" },
  ])
  expect((await c.box("USD")).byMethod).toMatchObject([{ name: "Tarjeta", amountCents: 100000 }])
})

it("billete de USD 100 para S/ 300 con vuelto en soles: tres movimientos y el ticket lo dice", async () => {
  const c = await clinic()
  const debt = await c.charge(30000, "PEN", "Limpieza dental")
  const paid = await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    changeCurrency: "PEN",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 8000 }],
    cashReceivedCents: 10000,
  })
  expect(paid.remainingCents).toBe(0)
  const [payment] = await paymentsOf(paid.ticket.id)
  expect(columns(payment)).toEqual({
    amountCents: 30000,
    currency: "PEN",
    tenderCents: 8000,
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    businessCents: 30000,
  })
  const moved = await c.movements(payment.id)
  expect(moved).toHaveLength(3)
  expect(moved).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "cobro",
        direction: "ingreso",
        amountCents: 8000,
        shiftCurrency: "USD",
      }),
      expect.objectContaining({
        kind: "vuelto",
        direction: "ingreso",
        amountCents: 2000,
        shiftCurrency: "USD",
      }),
      expect.objectContaining({
        kind: "vuelto",
        direction: "egreso",
        amountCents: 7500,
        shiftCurrency: "PEN",
      }),
    ]),
  )
  expect(paid.ticket).toMatchObject({
    currency: "PEN",
    totalCents: 30000,
    cashReceivedCents: 10000,
    changeCents: 7500,
    changeCurrency: "PEN",
  })
  const frozen = paid.ticket.snapshot as TicketFrozen
  expect(frozen.tender).toMatchObject({ currency: "USD", amountCents: 8000 })
  // Efecto en cada caja: dólares +100, soles −75. La caja de soles se abrió sola.
  const usd = await c.box("USD")
  const pen = await c.box("PEN")
  expect(usd.cashOnHandCents).toBe(10000)
  expect(usd.breakdown).toMatchObject({ cashCollectedCents: 8000, cashChangeCents: 2000 })
  expect(pen.cashOnHandCents).toBe(-7500)
  expect(pen.breakdown).toMatchObject({ cashCollectedCents: 0, cashChangeCents: -7500 })
  expect(pen.shiftId).not.toBeNull()
  expect(breakdownSum(usd.breakdown)).toBe(usd.cashOnHandCents)
  expect(breakdownSum(pen.breakdown)).toBe(pen.cashOnHandCents)
  expect(usd.ratesUsed).toEqual([{ rate: "3.75", cobros: 1, vueltos: 1, byName: "Rosa Caja" }])
  expect(pen.ratesUsed).toEqual([{ rate: "3.75", cobros: 0, vueltos: 1, byName: "Rosa Caja" }])
  // Lo cobrado de hoy no suma las dos monedas.
  const today = await c.run((tx) => getCashToday(tx, c.orgId, { branchId: c.site.id }))
  expect(today).toMatchObject({
    collectedCents: 0,
    secondCollected: { currency: "USD", cents: 8000 },
    tickets: 1,
  })
  // Movimientos de hoy: dicen lo que canceló y el vuelto.
  const { movements } = await c.run((tx) =>
    getDayMovements(tx, c.orgId, {
      branchId: c.site.id,
      day: new Date().toISOString().slice(0, 10),
      timezone: "UTC",
    }),
  )
  expect(movements.find((m) => m.kind === "cobro")?.cancels).toEqual({
    currency: "PEN",
    totalCents: 30000,
    rate: "3.75",
    cashReceivedCents: 10000,
    changeCents: 7500,
    changeCurrency: "PEN",
  })
})

it("paga en soles con vuelto en soles: solo entra lo cobrado, sin movimientos de vuelto", async () => {
  const c = await clinic()
  const debt = await c.charge(100000, "USD")
  const paid = await c.collect({
    chargeIds: [debt.id],
    currency: "USD",
    tenderCurrency: "PEN",
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 375000 }],
    cashReceivedCents: 380000,
  })
  expect(paid.ticket).toMatchObject({
    cashReceivedCents: 380000,
    changeCents: 5000,
    changeCurrency: null,
  })
  expect(paid.ticket.snapshot as TicketFrozen).toMatchObject({
    tender: { currency: "PEN", amountCents: 375000 },
  })
  expect(await c.movements()).toMatchObject([
    { kind: "cobro", amountCents: 375000, currency: "PEN" },
  ])
  expect((await c.box("PEN")).cashOnHandCents).toBe(375000)
})

it("S/ 150 en soles: todo vacío, el ticket como siempre y la huella de hoy", async () => {
  const c = await clinic()
  await c.charge(15000, "PEN", "Consulta")
  const requestId = randomUUID()
  const paid = await c.collect({
    requestId,
    payments: [{ paymentMethodId: c.cash.id, amountCents: 15000 }],
  })
  const [payment] = await paymentsOf(paid.ticket.id)
  expect(columns(payment)).toEqual({
    amountCents: 15000,
    currency: "PEN",
    tenderCents: null,
    tenderCurrency: null,
    exchangeRate: null,
    businessCents: null,
  })
  expect(paid.ticket.changeCurrency).toBeNull()
  const frozen = paid.ticket.snapshot as TicketFrozen
  expect("tender" in frozen).toBe(false)
  expect(frozen.methods[0]).not.toHaveProperty("tenderCents")
  expect(frozen.request).toBe(
    JSON.stringify({
      branchId: c.site.id,
      payerContactId: null,
      chargeIds: null,
      advanceCents: null,
      payments: [{ paymentMethodId: c.cash.id, amountCents: 15000, reference: null }],
      cashReceivedCents: null,
    }),
  )
  const state = await c.box("PEN")
  expect(state.ratesUsed).toEqual([])
  expect(state.breakdown.cashChangeCents).toBe(0)
})

it("dos medios con redondeo: cada fila guarda su parte y suman exacto", async () => {
  const c = await clinic("3.7777")
  const debt = await c.charge(10000, "USD")
  const inSoles = await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "PEN",
    exchangeRate: "3.7777",
    payments: [
      { paymentMethodId: c.cash.id, amountCents: 10000 },
      { paymentMethodId: c.card.id, amountCents: 27777 },
    ],
  })
  const rows = (await paymentsOf(inSoles.ticket.id)).sort((a, b) => a.amountCents - b.amountCents)
  expect(rows.map((row) => row.amountCents)).toEqual([2647, 7353])
  expect(rows.map((row) => row.tenderCents)).toEqual([10000, 27777])
  expect(rows.map((row) => row.businessCents)).toEqual([10000, 27777])
  expect(inSoles.remainingCents).toBe(0)
  // En dólares de punta a punta: el valor se reparte y el resto va a la última.
  const second = await c.charge(10000, "USD", "Corona")
  const inDollars = await c.collect({
    chargeIds: [second.id],
    exchangeRate: "3.7777",
    payments: [
      { paymentMethodId: c.cash.id, amountCents: 3333 },
      { paymentMethodId: c.card.id, amountCents: 6667 },
    ],
  })
  const dollars = (await paymentsOf(inDollars.ticket.id)).sort(
    (a, b) => a.amountCents - b.amountCents,
  )
  expect(dollars.map((row) => row.businessCents)).toEqual([12591, 25186])
  expect(12591 + 25186).toBe(37777)
})

it("cuadra a cero: a una unidad o menos cancela lo que debe, y pagar lo propuesto deja al día", async () => {
  const c = await clinic()
  const debt = await c.charge(10001, "USD")
  const paid = await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "PEN",
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 37500 }],
  })
  expect(paid.remainingCents).toBe(0)
  expect(columns((await paymentsOf(paid.ticket.id))[0])).toMatchObject({
    amountCents: 10001,
    tenderCents: 37500,
  })
  // S/ 301.03 proponen USD 80.27, que de vuelta son S/ 301.01: queda al día igual.
  const soles = await c.charge(30103, "PEN", "Resina")
  const dollars = await c.collect({
    chargeIds: [soles.id],
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 8027 }],
  })
  expect(dollars.remainingCents).toBe(0)
  expect(columns((await paymentsOf(dollars.ticket.id))[0])).toMatchObject({
    amountCents: 30103,
    tenderCents: 8027,
    businessCents: 30103,
  })
  const account = await c.run((tx) => getAccountSummary(tx, c.orgId, c.patient.id))
  expect(account.byCurrency.map((row) => row.aFavor)).toEqual([0, 0])
  // Pagar una parte: se convierte y lo demás queda por cobrar en dólares.
  const part = await c.charge(200000, "USD", "Ortodoncia")
  const some = await c.collect({
    chargeIds: [part.id],
    tenderCurrency: "PEN",
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 100000 }],
  })
  expect(columns((await paymentsOf(some.ticket.id))[0])).toMatchObject({
    amountCents: 26667,
    tenderCents: 100000,
    businessCents: 100000,
  })
  expect(some.remainingCents).toBe(200000 - 26667)
})

it("el cambio de este cobro vale solo para él, y no toca el de hoy", async () => {
  const c = await clinic()
  const before = (
    await ownerDb.select().from(orgProfile).where(eq(orgProfile.organizationId, c.orgId))
  )[0]
  const debt = await c.charge(100000, "USD")
  const paid = await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "PEN",
    exchangeRate: "3.80",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 380000 }],
  })
  expect(columns((await paymentsOf(paid.ticket.id))[0])).toMatchObject({
    exchangeRate: "3.8",
    businessCents: 380000,
  })
  const after = (
    await ownerDb.select().from(orgProfile).where(eq(orgProfile.organizationId, c.orgId))
  )[0]
  expect(after).toMatchObject({
    exchangeRate: before?.exchangeRate,
    exchangeRateAt: before?.exchangeRateAt,
  })
})

it("repetir el cobro con la misma clave devuelve el mismo ticket; otro cambio es otro cobro", async () => {
  const c = await clinic()
  const debt = await c.charge(100000, "USD")
  const body = {
    requestId: randomUUID(),
    chargeIds: [debt.id],
    tenderCurrency: "PEN",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 375000 }],
  }
  const first = await c.collect({ ...body, exchangeRate: "3.75" })
  // El cambio entra normalizado: «3.750» es el mismo cobro.
  const again = await c.collect({ ...body, exchangeRate: "3.750" })
  expect(again.duplicate).toBe(true)
  expect(again.ticket.id).toBe(first.ticket.id)
  expect(await paymentsOf(first.ticket.id)).toHaveLength(1)
  expect(await c.movements()).toHaveLength(1)
  await expect(c.collect({ ...body, exchangeRate: "3.8" })).rejects.toMatchObject({
    code: "REQUEST_ID_CONFLICT",
  })
  await expect(
    c.collect({ ...body, tenderCurrency: "USD", exchangeRate: "3.75" }),
  ).rejects.toMatchObject({
    code: "REQUEST_ID_CONFLICT",
  })
})

it("anular el billete revierte lo que pasó: dólares −100, soles +75, sin cambio nuevo", async () => {
  const c = await clinic()
  await c.run((tx) =>
    addCashMovement(tx, c.orgId, c.actor, {
      branchId: c.site.id,
      kind: "aporte",
      amountCents: 20000,
      concept: "Fondo",
      currency: "PEN",
    }),
  )
  const debt = await c.charge(30000, "PEN", "Limpieza dental")
  const paid = await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    changeCurrency: "PEN",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 8000 }],
    cashReceivedCents: 10000,
  })
  expect((await c.box("USD")).cashOnHandCents).toBe(10000)
  expect((await c.box("PEN")).cashOnHandCents).toBe(20000 - 7500)
  const voided = await c.run((tx) =>
    voidTicket(tx, ...c.args, paid.ticket.id, {
      reason: "Se equivocó de moneda",
      allowPostClose: false,
    }),
  )
  expect(voided.compensated).toBe(false)
  expect((await c.box("USD")).cashOnHandCents).toBe(0)
  expect((await c.box("PEN")).cashOnHandCents).toBe(20000)
  expect(live(await c.movements((await paymentsOf(paid.ticket.id))[0].id))).toHaveLength(0)
  // Vuelve a deber lo que debía, en su moneda.
  const account = await c.run((tx) => getAccountSummary(tx, c.orgId, c.patient.id))
  expect(account.byCurrency).toMatchObject([{ currency: "PEN", porCobrar: 30000, aFavor: 0 }])
})

it("anular con las cajas cerradas compensa con los datos de cada movimiento; solo administración", async () => {
  const c = await clinic()
  await c.run((tx) =>
    addCashMovement(tx, c.orgId, c.actor, {
      branchId: c.site.id,
      kind: "aporte",
      amountCents: 10000,
      concept: "Fondo",
      currency: "PEN",
    }),
  )
  const debt = await c.charge(30000, "PEN", "Limpieza dental")
  const paid = await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    changeCurrency: "PEN",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 8000 }],
    cashReceivedCents: 10000,
  })
  await c.close("USD", 10000)
  await c.close("PEN", 2500)
  const refused = c.run((tx) =>
    voidTicket(tx, ...c.args, paid.ticket.id, { reason: "Error", allowPostClose: false }),
  )
  await expect(refused).rejects.toMatchObject({ code: "POST_CLOSE_NEEDS_ADMIN" })
  const voided = await c.run((tx) =>
    voidTicket(tx, ...c.args, paid.ticket.id, { reason: "Error", allowPostClose: true }),
  )
  expect(voided.compensated).toBe(true)
  const usd = await c.box("USD")
  const pen = await c.box("PEN")
  expect(usd.cashOnHandCents).toBe(10000 - 8000 - 2000)
  expect(usd.breakdown).toMatchObject({ cashRefundedCents: 8000, cashChangeCents: -2000 })
  expect(pen.cashOnHandCents).toBe(2500 + 7500)
  expect(pen.breakdown).toMatchObject({ cashRefundedCents: 0, cashChangeCents: 7500 })
  expect(breakdownSum(usd.breakdown)).toBe(usd.cashOnHandCents)
  expect(breakdownSum(pen.breakdown)).toBe(pen.cashOnHandCents)
  // Lo cerrado no se tocó: sus movimientos siguen vigentes.
  expect(live(await c.movements((await paymentsOf(paid.ticket.id))[0].id))).toHaveLength(3)
})

it("una sola caja cerrada: lo abierto se anula y lo cerrado se compensa", async () => {
  const c = await clinic()
  const debt = await c.charge(30000, "PEN", "Limpieza dental")
  const paid = await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    changeCurrency: "PEN",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 8000 }],
    cashReceivedCents: 10000,
  })
  await c.close("USD", 10000)
  await c.run((tx) =>
    voidTicket(tx, ...c.args, paid.ticket.id, { reason: "Error", allowPostClose: true }),
  )
  expect((await c.box("USD")).cashOnHandCents).toBe(0)
  expect((await c.box("PEN")).cashOnHandCents).toBe(0)
})

it("devolver por partes sale en la moneda en que entró, en proporción y suma exacto", async () => {
  const c = await clinic("3.7777")
  const debt = await c.charge(10000, "USD")
  const paid = await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "PEN",
    exchangeRate: "3.7777",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 37777 }],
  })
  const give = async (amountCents: number) => {
    const { lines } = await c.run((tx) =>
      getTicketReturnable(tx, c.orgId, c.patient.id, paid.ticket.id),
    )
    return c.run((tx) =>
      returnFromTicket(tx, ...c.args, paid.ticket.id, {
        branchId: c.site.id,
        lines: [{ chargeId: lines[0]?.chargeId as string, amountCents }],
        paymentMethodId: c.cash.id,
        reason: "Reclamo",
        requestId: randomUUID(),
      }),
    )
  }
  const first = await give(3333)
  expect((first.paymentReturn.snapshot as { payouts?: unknown }).payouts).toEqual([
    { currency: "PEN", amountCents: 12591 },
  ])
  expect((await c.box("PEN")).cashOnHandCents).toBe(37777 - 12591)
  const secondReturn = await give(3333)
  expect((secondReturn.paymentReturn.snapshot as { payouts?: unknown }).payouts).toEqual([
    { currency: "PEN", amountCents: 12591 },
  ])
  await give(3334)
  // Devuelto todo: sale exactamente lo que entró, sin un centavo de diferencia.
  const pen = await c.box("PEN")
  expect(pen.cashOnHandCents).toBe(0)
  expect(pen.breakdown.cashRefundedCents).toBe(37777)
  expect((await c.box("USD")).cashOnHandCents).toBe(0)
  // Lo que salió queda en cada devolución: sumado da lo que entró.
  const saved = await c.run((tx) =>
    tx
      .select({ out: patientPaymentRefund.tenderCents })
      .from(patientPaymentRefund)
      .where(eq(patientPaymentRefund.organizationId, c.orgId))
      .orderBy(asc(patientPaymentRefund.createdAt)),
  )
  expect(saved.map((row) => row.out)).toEqual([12591, 12591, 12595])
})

it("una devolución en la moneda en que entró no guarda otro importe", async () => {
  const c = await clinic()
  const debt = await c.charge(10000, "USD")
  const paid = await c.collect({
    chargeIds: [debt.id],
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 10000 }],
  })
  const { lines } = await c.run((tx) =>
    getTicketReturnable(tx, c.orgId, c.patient.id, paid.ticket.id),
  )
  await c.run((tx) =>
    returnFromTicket(tx, ...c.args, paid.ticket.id, {
      branchId: c.site.id,
      lines: [{ chargeId: lines[0]?.chargeId as string, amountCents: 2500 }],
      paymentMethodId: c.cash.id,
      reason: "Reclamo",
      requestId: randomUUID(),
    }),
  )
  const saved = await c.run((tx) =>
    tx
      .select({ out: patientPaymentRefund.tenderCents })
      .from(patientPaymentRefund)
      .where(eq(patientPaymentRefund.organizationId, c.orgId)),
  )
  expect(saved).toEqual([{ out: null }])
})

it("S/ 300 cancelados con USD 80 devuelven hasta USD 80, sin cambio nuevo", async () => {
  const c = await clinic()
  const debt = await c.charge(30000, "PEN", "Limpieza dental")
  const paid = await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    changeCurrency: "PEN",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 8000 }],
    cashReceivedCents: 10000,
  })
  const { lines, tender } = await c.run((tx) =>
    getTicketReturnable(tx, c.orgId, c.patient.id, paid.ticket.id),
  )
  expect(tender).toMatchObject({ currency: "USD", amountCents: 8000 })
  await c.run((tx) =>
    returnFromTicket(tx, ...c.args, paid.ticket.id, {
      branchId: c.site.id,
      lines: [{ chargeId: lines[0]?.chargeId as string, amountCents: 30000 }],
      paymentMethodId: c.cash.id,
      reason: "Reclamo",
      requestId: randomUUID(),
    }),
  )
  // El vuelto ya se dio: de dólares salen los USD 80 que cancelaron, no los USD 100.
  expect((await c.box("USD")).cashOnHandCents).toBe(10000 - 8000)
  expect((await c.box("PEN")).cashOnHandCents).toBe(-7500)
})

it("adelanto cruzado: S/ 2,000 a 3.75 quedan USD 533.33, y se devuelven los S/ 2,000", async () => {
  const c = await clinic()
  const paid = await c.collect({
    currency: "USD",
    tenderCurrency: "PEN",
    exchangeRate: "3.75",
    advanceCents: 200000,
    payments: [{ paymentMethodId: c.cash.id, amountCents: 200000 }],
  })
  const [payment] = await paymentsOf(paid.ticket.id)
  expect(columns(payment)).toEqual({
    amountCents: 53333,
    currency: "USD",
    tenderCents: 200000,
    tenderCurrency: "PEN",
    exchangeRate: "3.75",
    businessCents: 200000,
  })
  expect(paid.ticket).toMatchObject({ currency: "USD", totalCents: 53333 })
  expect((paid.ticket.snapshot as TicketFrozen).lines).toMatchObject([
    { chargeId: null, amountCents: 53333 },
  ])
  expect((await c.box("PEN")).cashOnHandCents).toBe(200000)
  let account = await c.run((tx) => getAccountSummary(tx, c.orgId, c.patient.id))
  expect(account.byCurrency).toMatchObject([{ currency: "USD", aFavor: 53333 }])
  expect(account.aFavorOrigen).toMatchObject([
    { currency: "USD", tenderCurrency: "PEN", availableCents: 53333 },
  ])
  // El saldo a favor no se cruza entre monedas: no paga lo que se debe en soles.
  const soles = await c.charge(10000, "PEN", "Consulta")
  await expect(c.collect({ chargeIds: [soles.id], payments: [] })).rejects.toMatchObject({
    code: "VALIDATION",
  })
  // Devolverlo: sale lo que entró, en soles, sin cambio nuevo.
  const refund = await c.run((tx) =>
    refundCredit(tx, ...c.args, {
      branchId: c.site.id,
      amountCents: 53333,
      currency: "USD",
      paymentMethodId: c.cash.id,
      reason: "No se hará el tratamiento",
    }),
  )
  expect(refund.payouts).toEqual([{ currency: "PEN", amountCents: 200000 }])
  expect((await c.box("PEN")).cashOnHandCents).toBe(0)
  expect((await c.box("PEN")).breakdown.cashRefundedCents).toBe(200000)
  const receipt = await c.run((tx) => getRefundReceipt(tx, c.orgId, c.patient.id, refund.receiptId))
  expect(receipt).toMatchObject({
    currency: "USD",
    amountCents: 53333,
    payouts: [{ currency: "PEN", amountCents: 200000 }],
  })
  account = await c.run((tx) => getAccountSummary(tx, c.orgId, c.patient.id))
  expect(account.byCurrency.find((row) => row.currency === "USD")).toMatchObject({ aFavor: 0 })
})

it("el saldo a favor en dólares cancela lo que se debe en dólares, sin pedir cambio", async () => {
  const c = await clinic()
  await c.collect({
    currency: "USD",
    tenderCurrency: "PEN",
    exchangeRate: "3.75",
    advanceCents: 37500,
    payments: [{ paymentMethodId: c.cash.id, amountCents: 37500 }],
  })
  const debt = await c.charge(10000, "USD")
  const paid = await c.collect({ chargeIds: [debt.id], payments: [] })
  expect(paid.ticket).toMatchObject({ currency: "USD", totalCents: 0, creditAppliedCents: 10000 })
  expect(paid.remainingCents).toBe(0)
  expect("tender" in (paid.ticket.snapshot as TicketFrozen)).toBe(false)
})

it("cerrar la caja de dólares deja la de soles abierta y guarda el vuelto en el cierre", async () => {
  const c = await clinic()
  const debt = await c.charge(30000, "PEN", "Limpieza dental")
  await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    changeCurrency: "PEN",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 8000 }],
    cashReceivedCents: 10000,
  })
  const solesBefore = await c.box("PEN")
  const closed = await c.close("USD", 10000)
  expect(closed).toMatchObject({ status: "cerrada", currency: "USD", differenceCents: 0 })
  const [closure] = await ownerDb
    .select()
    .from(cashClosure)
    .where(eq(cashClosure.organizationId, c.orgId))
  expect(closure).toMatchObject({
    currency: "USD",
    cashCollectedCents: 8000,
    cashChangeCents: 2000,
    expectedCents: 10000,
  })
  const solesAfter = await c.box("PEN")
  expect(solesAfter.shiftId).toBe(solesBefore.shiftId)
  expect(solesAfter.cashOnHandCents).toBe(-7500)
  expect(solesAfter.lastClosure).toBeNull()
  // La ventana siguiente de dólares abre con lo que quedó.
  const dollars = await c.box("USD")
  expect(dollars.cashOnHandCents).toBe(10000)
  expect(dollars.breakdown.openingCents).toBe(10000)
  expect(dollars.lastClosure).not.toBeNull()
  expect(closure?.shiftId).not.toBe(dollars.shiftId)
})

it("sin el cambio cuando hace falta: el error dice su campo", async () => {
  const c = await clinic()
  const debt = await c.charge(100000, "USD")
  const body = { payments: [{ paymentMethodId: c.cash.id, amountCents: 100000 }] }
  await expect(c.collect({ chargeIds: [debt.id], ...body })).rejects.toMatchObject({
    code: "VALIDATION",
    fields: { exchangeRate: expect.any(String) },
  })
  await expect(
    c.collect({ chargeIds: [debt.id], tenderCurrency: "PEN", ...body }),
  ).rejects.toMatchObject({
    fields: { exchangeRate: expect.any(String) },
  })
  // Soles a soles no lo pide; dólares por una deuda en soles, sí.
  const soles = await c.charge(5000, "PEN", "Consulta")
  await expect(
    c.collect({
      chargeIds: [soles.id],
      tenderCurrency: "USD",
      payments: [{ paymentMethodId: c.cash.id, amountCents: 1000 }],
    }),
  ).rejects.toMatchObject({ fields: { exchangeRate: expect.any(String) } })
  // Un cambio que no se entiende tampoco pasa.
  await expect(
    c.collect({ chargeIds: [debt.id], exchangeRate: "tres", ...body }),
  ).rejects.toMatchObject({
    fields: { exchangeRate: expect.any(String) },
  })
  await expect(
    c.collect({ chargeIds: [debt.id], exchangeRate: "0", ...body }),
  ).rejects.toMatchObject({
    fields: { exchangeRate: expect.any(String) },
  })
  expect(
    await ownerDb.select().from(paymentTicket).where(eq(paymentTicket.organizationId, c.orgId)),
  ).toHaveLength(0)
})

it("una moneda ajena a las dos de la clínica se rechaza con su campo", async () => {
  const c = await clinic()
  const debt = await c.charge(100000, "USD")
  const body = {
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 100000 }],
  }
  await expect(
    c.collect({ chargeIds: [debt.id], tenderCurrency: "EUR", ...body }),
  ).rejects.toMatchObject({
    fields: { tenderCurrency: expect.any(String) },
  })
  await expect(c.collect({ currency: "EUR", advanceCents: 100000, ...body })).rejects.toMatchObject(
    {
      fields: { currency: expect.any(String) },
    },
  )
  await expect(
    c.collect({
      chargeIds: [debt.id],
      changeCurrency: "EUR",
      cashReceivedCents: 200000,
      ...body,
    }),
  ).rejects.toMatchObject({ fields: { changeCurrency: expect.any(String) } })
})

it("la caja solo se mueve en las monedas de la clínica", async () => {
  const c = await clinic()
  const third = { fields: { currency: expect.stringContaining("PEN y USD") } }
  await expect(
    c.run((tx) =>
      addCashMovement(tx, c.orgId, c.actor, {
        branchId: c.site.id,
        kind: "aporte",
        amountCents: 1000,
        concept: "Fondo",
        currency: "EUR",
      }),
    ),
  ).rejects.toMatchObject(third)
  await expect(c.close("EUR", 0)).rejects.toMatchObject(third)
  // Nada quedó en euros: la clínica no tiene ninguna caja en EUR.
  const shifts = await ownerDb
    .select({ currency: cashShift.currency })
    .from(cashShift)
    .where(eq(cashShift.organizationId, c.orgId))
  expect(shifts.map((row) => row.currency.trim())).not.toContain("EUR")
  // La segunda sí, como siempre.
  await c.run((tx) =>
    addCashMovement(tx, c.orgId, c.actor, {
      branchId: c.site.id,
      kind: "aporte",
      amountCents: 1000,
      concept: "Fondo",
      currency: "USD",
    }),
  )
})

it("la base no admite dos cobros vivos del mismo pago, aunque sean de otra moneda", async () => {
  const c = await clinic()
  const debt = await c.charge(30000, "PEN", "Limpieza dental")
  const paid = await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    changeCurrency: "PEN",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 8000 }],
    cashReceivedCents: 10000,
  })
  const [payment] = await paymentsOf(paid.ticket.id)
  const rows = await ownerDb
    .select()
    .from(cashMovement)
    .where(eq(cashMovement.patientPaymentId, payment?.id as string))
  const cobro = rows.find((row) => row.kind === "cobro")
  const givenBack = rows.find((row) => row.kind === "vuelto" && row.direction === "egreso")
  if (!cobro || !givenBack) throw new Error("Faltan los movimientos del cobro")
  // El vuelto dice su ticket como lo dice el resto de la caja: con seis cifras.
  const number = String(paid.ticket.ticketNumber).padStart(6, "0")
  expect(givenBack.concept).toBe(`Vuelto · Ticket ${number}`)
  const copy = ({ id: _id, createdAt: _at, ...row }: typeof cobro) => row
  // Otro cobro del mismo pago en la caja de soles, y otro vuelto que sale: ninguno entra.
  await expect(
    ownerDb.insert(cashMovement).values({ ...copy(cobro), currency: "PEN", shiftId: givenBack.shiftId }),
  ).rejects.toThrow()
  await expect(
    ownerDb.insert(cashMovement).values({ ...copy(givenBack), currency: "USD", shiftId: cobro.shiftId }),
  ).rejects.toThrow()
})

it("una devolución que en la moneda en que entró no llega a un céntimo no se registra", async () => {
  const c = await clinic()
  const debt = await c.charge(30000, "PEN", "Limpieza dental")
  const paid = await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 8000 }],
  })
  const { lines } = await c.run((tx) =>
    getTicketReturnable(tx, c.orgId, c.patient.id, paid.ticket.id),
  )
  // S/ 0.01 de lo que entró en dólares son USD 0.0027: no sale nada de la caja.
  await expect(
    c.run((tx) =>
      returnFromTicket(tx, ...c.args, paid.ticket.id, {
        branchId: c.site.id,
        lines: [{ chargeId: lines[0]?.chargeId as string, amountCents: 1 }],
        paymentMethodId: c.cash.id,
        reason: "Reclamo",
        requestId: randomUUID(),
      }),
    ),
  ).rejects.toMatchObject({ message: expect.stringContaining("demasiado pequeño para devolverlo en dólares") })
  const advance = await c.collect({
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    advanceCents: 3000,
    payments: [{ paymentMethodId: c.cash.id, amountCents: 3000 }],
  })
  expect(advance.payments[0]?.currency.trim()).toBe("PEN")
  await expect(
    c.run((tx) =>
      refundCredit(tx, ...c.args, {
        branchId: c.site.id,
        amountCents: 1,
        paymentMethodId: c.cash.id,
        reason: "Lo pidió",
      }),
    ),
  ).rejects.toMatchObject({ fields: { amountCents: expect.stringContaining("dólares") } })
})

it("los dólares no se quitan mientras algo los necesite: deuda, caja, saldo a favor o servicios", async () => {
  const c = await clinic()
  const remove = () =>
    c.run((tx) => setOrgExchangeRate(tx, c.orgId, c.actor, { secondCurrency: null }))
  const blocked = (text: string) =>
    expect(remove()).rejects.toMatchObject({
      code: "SECOND_CURRENCY_IN_USE",
      fields: { secondCurrency: expect.stringContaining(text) },
    })
  const debt = await c.charge(10000, "USD")
  await blocked("Para dejar de cobrar en dólares, primero cobra o anula lo que se debe en dólares")
  await c.collect({
    chargeIds: [debt.id],
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 10000 }],
  })
  await blocked("retira el efectivo de la caja de dólares")
  await c.run((tx) =>
    addCashMovement(tx, c.orgId, c.actor, {
      branchId: c.site.id,
      kind: "retiro",
      amountCents: 10000,
      concept: "Al banco",
      currency: "USD",
    }),
  )
  await c.collect({
    currency: "USD",
    exchangeRate: "3.75",
    advanceCents: 500,
    payments: [{ paymentMethodId: c.cash.id, amountCents: 500 }],
  })
  await blocked("usa o devuelve lo que tienen a favor en dólares")
  await c.run((tx) =>
    refundCredit(tx, ...c.args, {
      branchId: c.site.id,
      amountCents: 500,
      paymentMethodId: c.cash.id,
      reason: "Lo pidió",
      currency: "USD",
    }),
  )
  const [service] = await ownerDb
    .insert(serviceCatalog)
    .values({
      organizationId: c.orgId,
      name: "Implante",
      scope: "general",
      source: "custom",
      priceCents: 100000,
      currency: "USD",
    })
    .returning()
  await blocked("pasa el servicio con precio en dólares a soles")
  await ownerDb
    .update(serviceCatalog)
    .set({ isActive: false })
    .where(eq(serviceCatalog.id, service?.id as string))
  // Ya nada la necesita: se quita.
  expect((await remove()).secondCurrency).toBeNull()
})

it("quien debe en las dos monedas tiene dos filas y es una persona", async () => {
  const c = await clinic()
  await c.charge(15000, "PEN", "Limpieza")
  await c.charge(10000, "USD", "Implante")
  const list = await c.run((tx) => listDebts(tx, c.orgId, { branchId: c.site.id }))
  expect(list.data).toHaveLength(2)
  expect(list).toMatchObject({ total: 2, people: 1 })
})

it("conceptos de dos monedas no van en un cobro: cada moneda lleva su ticket", async () => {
  const c = await clinic()
  const dollars = await c.charge(100000, "USD")
  const soles = await c.charge(30000, "PEN", "Limpieza dental")
  await expect(
    c.collect({
      chargeIds: [dollars.id, soles.id],
      exchangeRate: "3.75",
      payments: [{ paymentMethodId: c.cash.id, amountCents: 130000 }],
    }),
  ).rejects.toMatchObject({ code: "CURRENCY_MISMATCH", fields: { chargeIds: expect.any(String) } })
  await expect(
    c.collect({
      currency: "PEN",
      chargeIds: [dollars.id],
      payments: [{ paymentMethodId: c.cash.id, amountCents: 100000 }],
    }),
  ).rejects.toMatchObject({ code: "CURRENCY_MISMATCH" })
  const inDollars = await c.collect({
    chargeIds: [dollars.id],
    exchangeRate: "3.75",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 100000 }],
  })
  const inSoles = await c.collect({
    chargeIds: [soles.id],
    payments: [{ paymentMethodId: c.cash.id, amountCents: 30000 }],
  })
  expect(inDollars.ticket.ticketNumber).not.toBe(inSoles.ticket.ticketNumber)
  expect(await paymentsOf(inSoles.ticket.id).then((rows) => rows[0]?.exchangeRate)).toBeNull()
})

it("sin segunda moneda el cobro no admite otra, y todo sigue como hoy", async () => {
  const c = await clinic(null)
  await c.charge(10000, "PEN", "Consulta")
  const dollars = await c.charge(10000, "USD")
  const payments = [{ paymentMethodId: c.cash.id, amountCents: 10000 }]
  await expect(
    c.collect({ tenderCurrency: "USD", exchangeRate: "3.75", payments }),
  ).rejects.toMatchObject({
    fields: { tenderCurrency: expect.any(String) },
  })
  await expect(c.collect({ chargeIds: [dollars.id], payments })).rejects.toMatchObject({
    code: "CURRENCY_MISMATCH",
    message: "Los conceptos son de otra moneda que la clínica",
  })
  const paid = await c.collect({ payments })
  expect(columns((await paymentsOf(paid.ticket.id))[0])).toEqual({
    amountCents: 10000,
    currency: "PEN",
    tenderCents: null,
    tenderCurrency: null,
    exchangeRate: null,
    businessCents: null,
  })
  const today = await c.run((tx) => getCashToday(tx, c.orgId, { branchId: c.site.id }))
  expect(today.collectedCents).toBe(10000)
  expect(today).not.toHaveProperty("secondCollected")
})

it("el ticket y sus papeles se arman con lo congelado, también con dos monedas", async () => {
  const c = await clinic()
  const debt = await c.charge(30000, "PEN", "Limpieza dental")
  const paid = await c.collect({
    chargeIds: [debt.id],
    tenderCurrency: "USD",
    exchangeRate: "3.75",
    changeCurrency: "PEN",
    payments: [{ paymentMethodId: c.cash.id, amountCents: 8000 }],
    cashReceivedCents: 10000,
  })
  const snap = await c.run((tx) => buildTicketSnapshot(tx, c.orgId, c.patient.id, paid.ticket.id))
  expect(snap).toMatchObject({
    currency: "PEN",
    totalCents: 30000,
    cashReceivedCents: 10000,
    changeCents: 7500,
    changeCurrency: "PEN",
    tender: { currency: "USD", rate: "3.75" },
    methods: [{ label: "Efectivo", amountCents: 30000, tenderCents: 8000 }],
  })
  expect((await renderTicketPdf(snap)).length).toBeGreaterThan(1000)
  expect((await renderTicketPdf(snap, "Letter")).length).toBeGreaterThan(1000)
  // Se cobró en soles: el ticket de una sola moneda no lleva nada de esto.
  const soles = await c.charge(15000, "PEN", "Consulta")
  const plain = await c.collect({
    chargeIds: [soles.id],
    payments: [{ paymentMethodId: c.cash.id, amountCents: 15000 }],
  })
  const plainSnap = await c.run((tx) =>
    buildTicketSnapshot(tx, c.orgId, c.patient.id, plain.ticket.id),
  )
  expect(plainSnap.tender).toBeNull()
  expect(plainSnap.methods[0]).not.toHaveProperty("tenderCents")
  // La devolución y la constancia dicen lo que salió.
  const { lines } = await c.run((tx) =>
    getTicketReturnable(tx, c.orgId, c.patient.id, paid.ticket.id),
  )
  const back = await c.run((tx) =>
    returnFromTicket(tx, ...c.args, paid.ticket.id, {
      branchId: c.site.id,
      lines: [{ chargeId: lines[0]?.chargeId as string, amountCents: 15000 }],
      paymentMethodId: c.cash.id,
      reason: "Reclamo",
      requestId: randomUUID(),
    }),
  )
  expect((back.paymentReturn.snapshot as { payouts?: unknown }).payouts).toEqual([
    { currency: "USD", amountCents: 4000 },
  ])
  const returned = await c.run((tx) =>
    renderReturnPdf(tx, c.orgId, c.patient.id, back.paymentReturn.id),
  )
  expect(returned.bytes.length).toBeGreaterThan(1000)
  const advance = await c.collect({
    currency: "USD",
    tenderCurrency: "PEN",
    exchangeRate: "3.75",
    advanceCents: 37500,
    payments: [{ paymentMethodId: c.cash.id, amountCents: 37500 }],
  })
  expect(advance.ticket.totalCents).toBe(10000)
  const refund = await c.run((tx) =>
    refundCredit(tx, ...c.args, {
      branchId: c.site.id,
      amountCents: 10000,
      currency: "USD",
      reason: "No vino",
    }),
  )
  const receipt = await c.run((tx) =>
    getRefundReceiptPdf(tx, c.orgId, c.patient.id, refund.receiptId),
  )
  expect(receipt.bytes.length).toBeGreaterThan(1000)
})

it("dos personas cerrando y cobrando a la vez en las dos cajas no se bloquean en cruz", async () => {
  const c = await clinic()
  await c.run((tx) =>
    addCashMovement(tx, c.orgId, c.actor, {
      branchId: c.site.id,
      kind: "aporte",
      amountCents: 50000,
      concept: "Fondo",
      currency: "PEN",
    }),
  )
  await c.run((tx) =>
    addCashMovement(tx, c.orgId, c.actor, {
      branchId: c.site.id,
      kind: "aporte",
      amountCents: 50000,
      concept: "Fondo",
      currency: "USD",
    }),
  )
  const a = await c.charge(30000, "PEN", "Uno")
  const b = await c.charge(30000, "PEN", "Dos")
  const billete = (chargeId: string) =>
    c.collect({
      chargeIds: [chargeId],
      tenderCurrency: "USD",
      exchangeRate: "3.75",
      changeCurrency: "PEN",
      payments: [{ paymentMethodId: c.cash.id, amountCents: 8000 }],
      cashReceivedCents: 10000,
    })
  await Promise.all([billete(a.id), billete(b.id), c.close("USD", 50000), c.close("PEN", 50000)])
  const usd = await c.box("USD")
  const pen = await c.box("PEN")
  expect(breakdownSum(usd.breakdown)).toBe(usd.cashOnHandCents)
  expect(breakdownSum(pen.breakdown)).toBe(pen.cashOnHandCents)
})
