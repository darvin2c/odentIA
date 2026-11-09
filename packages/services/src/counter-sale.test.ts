/**
 * Venta de mostrador (ADR 0172): productos cobrados sin ficha, a un contacto, a
 * un nombre o a nadie. Mismo ticket, misma serie, misma caja y mismas lecturas
 * que un cobro; nunca deja deuda ni saldo a favor, y no se mezcla con la cuenta
 * de un paciente.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import {
  patientCharge,
  patientPayment,
  patientPaymentApplication,
  patientPaymentRefund,
  paymentTicket,
} from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { cashMovement } from "@odentia/db/schema/finance"
import { product, productLot, stockMovement } from "@odentia/db/schema/inventory"
import { branch } from "@odentia/db/schema/org"
import { and, eq, isNull } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { runArgosQuery } from "./argos-query.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { sellAtCounter } from "./counter-sale.js"
import {
  closeCashWindow,
  collectedNetMany,
  getCashState,
  getClosureSheet,
  getDayMovements,
  getDebts,
  listClosures,
  listTickets,
} from "./finance.js"
import { buildTicketSnapshot, renderReturnPdf, renderTicketPdf } from "./financial-document-pdf.js"
import { searchEverything } from "./global-search.js"
import { defaultWarehouse, lotFor, receiveIntoLot } from "./inventory-stock.js"
import { createPaymentMethod } from "./payment-methods.js"
import {
  collectCharge,
  createCharge,
  getAccountSummary,
  getPaymentReturn,
  getTicketReceiptById,
  getTicketReturnable,
  returnFromTicket,
  type TicketFrozen,
  voidTicket,
} from "./payments.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

const run = <T>(orgId: string, fn: (tx: typeof appDb) => Promise<T>) => withOrgContext(appDb, orgId, fn)

/** Quien ve a todas las personas (recepción, administración). */
const SEES_EVERYONE = () => true

/** Una sede con su caja, dos medios y dos productos que se venden, con lo que hay en su almacén. */
async function counter(orgId = "org_a") {
  const actor = randomUUID()
  await ownerDb.insert(user).values({ id: actor, name: "Caja Mostrador", email: `${actor}@example.test` })
  const [site] = await ownerDb
    .insert(branch)
    .values({ organizationId: orgId, name: `Mostrador ${randomUUID().slice(0, 8)}` })
    .returning()
  const branchId = site!.id
  const cash = await run(orgId, (tx) => createPaymentMethod(tx, orgId, actor, { name: "Efectivo", typeCode: "10" }))
  const yape = await run(orgId, (tx) => createPaymentMethod(tx, orgId, actor, { name: "Yape", typeCode: "68" }))
  const store = await run(orgId, (tx) => defaultWarehouse(tx, orgId, branchId))
  const tag = randomUUID().slice(0, 8)
  /** Solo letras: con un número, lo escrito en el buscador se lee como un número de ticket. */
  const word = tag.replace(/[0-9]/g, (digit) => "ghijklmnop"[Number(digit)]!)
  const stocked = async (name: string, priceCents: number, quantity: number) => {
    const [row] = await ownerDb
      .insert(product)
      .values({
        organizationId: orgId,
        sku: `MOS-${randomUUID().slice(0, 8)}`,
        name: `${name} ${tag}`,
        unit: "unidad",
        usedInCare: false,
        forSale: true,
        salePriceCents: priceCents,
        saleCurrency: "PEN",
      })
      .returning()
    const lot = await run(orgId, async (tx) => {
      const lotRow = await lotFor(tx, orgId, { productId: row!.id, warehouseId: store.id, code: `L-${tag}`, actorUserId: actor })
      await receiveIntoLot(tx, orgId, {
        lot: lotRow,
        quantity,
        base: { kind: "ingreso", reason: "Prueba", actorUserId: actor, keyPrefix: `prueba:${randomUUID()}` },
      })
      return lotRow
    })
    return { ...row!, lotId: lot.id }
  }
  const sunglasses = await stocked("Lentes de sol", 12000, 3)
  const drops = await stocked("Gotas lubricantes", 1500, 10)
  const onHand = async (item: { lotId: string }) =>
    (await ownerDb.select({ q: productLot.quantityOnHand }).from(productLot).where(eq(productLot.id, item.lotId)))[0]?.q
  return { orgId, actor, branchId, cash, yape, sunglasses, drops, onHand, tag, word }
}

function frozenOf(ticket: { snapshot: unknown }): TicketFrozen {
  return ticket.snapshot as TicketFrozen
}

describe("venta de mostrador", () => {
  it("cobra con dos medios y vuelto, sin ficha, sale de la sede y numera en la misma serie", async () => {
    const c = await counter()
    const f = await clinicalFixture()
    await f.run((tx) => createCharge(tx, ...f.args, { description: "Consulta", amountCents: 5000, currency: "PEN" }))
    const before = await f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId: c.branchId,
        payments: [{ paymentMethodId: c.cash.id, amountCents: 5000 }],
        requestId: randomUUID(),
      }),
    )
    const sale = await run(c.orgId, (tx) =>
      sellAtCounter(tx, c.orgId, c.actor, {
        branchId: c.branchId,
        requestId: randomUUID(),
        lines: [{ productId: c.sunglasses.id }, { productId: c.drops.id, quantity: 2 }],
        payments: [
          { paymentMethodId: c.cash.id, amountCents: 5000 },
          { paymentMethodId: c.yape.id, amountCents: 10000, reference: "OP-77" },
        ],
        cashReceivedCents: 10000,
      }, SEES_EVERYONE),
    )
    expect(sale.duplicate).toBe(false)
    expect(sale.ticket).toMatchObject({
      patientId: null,
      buyerContactId: null,
      buyerName: null,
      totalCents: 15000,
      creditAppliedCents: 0,
      cashReceivedCents: 10000,
      changeCents: 5000,
      payerContactId: null,
    })
    // La misma serie que los cobros de las fichas, sin saltos.
    expect(sale.ticket.ticketNumber).toBe(before.ticket.ticketNumber + 1)
    await f.run((tx) => createCharge(tx, ...f.args, { description: "Control", amountCents: 3000, currency: "PEN" }))
    const after = await f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId: c.branchId,
        payments: [{ paymentMethodId: c.cash.id, amountCents: 3000 }],
        requestId: randomUUID(),
      }),
    )
    expect(after.ticket.ticketNumber).toBe(sale.ticket.ticketNumber + 1)

    const frozen = frozenOf(sale.ticket)
    expect(frozen.patient).toBeNull()
    expect(frozen.buyer).toBeNull()
    expect(frozen.remainingCents).toBe(0)
    expect(frozen.lines.map((line) => [line.description, line.amountCents, line.appliedCents])).toEqual([
      [c.sunglasses.name, 12000, 12000],
      [`${c.drops.name} × 2`, 3000, 3000],
    ])
    expect(frozen.methods.map((m) => [m.name, m.amountCents, m.reference])).toEqual([
      ["Efectivo", 5000, null],
      ["Yape", 10000, "OP-77"],
    ])
    // Nada de la ficha: los conceptos, los pagos y lo aplicado no tienen paciente.
    const charges = await ownerDb.select().from(patientCharge).where(eq(patientCharge.requestKey, `${sale.ticket.requestId}:0`))
    expect(charges).toHaveLength(1)
    expect(charges[0]).toMatchObject({ patientId: null, productId: c.sunglasses.id, productQuantity: 1, branchId: c.branchId })
    const payments = await ownerDb.select().from(patientPayment).where(eq(patientPayment.ticketId, sale.ticket.id))
    expect(payments.every((p) => p.patientId === null)).toBe(true)
    const applied = await ownerDb
      .select()
      .from(patientPaymentApplication)
      .where(eq(patientPaymentApplication.ticketId, sale.ticket.id))
    expect(applied.reduce((sum, app) => sum + app.amountCents, 0)).toBe(15000)
    expect(applied.every((app) => app.patientId === null)).toBe(true)
    // Sale de la sede como cualquier venta.
    expect(await c.onHand(c.sunglasses)).toBe(2)
    expect(await c.onHand(c.drops)).toBe(8)
    const [moved] = await ownerDb.select().from(stockMovement).where(eq(stockMovement.chargeId, charges[0]!.id))
    expect(moved).toMatchObject({ kind: "venta", quantityDelta: -1, patientId: null, reason: "Venta de mostrador" })
    // El paciente sigue con su cuenta como estaba: nada del mostrador entra en ella.
    const account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
    expect(account.cobros).toHaveLength(2)
    // Nunca deja deuda.
    expect((await run(c.orgId, (tx) => getDebts(tx, c.orgId, { branchId: c.branchId }))).every((row) => row.patientId !== null)).toBe(true)

    // La caja del día la cuenta: el efectivo que quedó y lo que entró por Yape.
    const state = await run(c.orgId, (tx) => getCashState(tx, c.orgId, { branchId: c.branchId }))
    expect(state.cashOnHandCents).toBe(5000 + 5000 + 3000)
    expect(state.tickets).toBe(3)
    expect(state.byMethod.find((m) => m.name === "Yape")?.amountCents).toBe(10000)
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date())
    const day = await run(c.orgId, (tx) => getDayMovements(tx, c.orgId, { branchId: c.branchId, day: today }))
    const counterRows = day.movements.filter((m) => m.ticketId === sale.ticket.id)
    expect(counterRows).toHaveLength(2)
    expect(counterRows.every((m) => m.patientId === null && m.patientName === "Venta de mostrador")).toBe(true)
    // El arqueo la cuenta y la hoja la lista.
    const closed = await run(c.orgId, (tx) =>
      closeCashWindow(tx, c.orgId, c.actor, { branchId: c.branchId, countedCents: 13000, retainedCents: 0, deliveredCents: 13000 }),
    )
    expect(closed.differenceCents).toBe(0)
    const [closure] = await run(c.orgId, (tx) => listClosures(tx, c.orgId, { branchId: c.branchId }))
    const sheet = await run(c.orgId, (tx) => getClosureSheet(tx, c.orgId, closure!.id))
    expect(sheet.closure).toMatchObject({ cashCollectedCents: 13000, countedCents: 13000 })
    expect(sheet.counted?.some((m) => m.ticketId === sale.ticket.id && m.patientName === "Venta de mostrador")).toBe(true)
  })

  it("la lista de Cobros, lo que suma y el buscador la encuentran por su número y por quien compró", async () => {
    const c = await counter()
    const [person] = await ownerDb
      .insert(contact)
      .values({ organizationId: c.orgId, displayName: `Rosa Quispe ${c.word}` })
      .returning()
    const toContact = await run(c.orgId, (tx) =>
      sellAtCounter(tx, c.orgId, c.actor, {
        branchId: c.branchId,
        requestId: randomUUID(),
        lines: [{ productId: c.drops.id }],
        buyer: { contactId: person!.id },
        payments: [{ paymentMethodId: c.yape.id, amountCents: 1500 }],
      }, SEES_EVERYONE),
    )
    const toName = await run(c.orgId, (tx) =>
      sellAtCounter(tx, c.orgId, c.actor, {
        branchId: c.branchId,
        requestId: randomUUID(),
        lines: [{ productId: c.sunglasses.id }],
        buyer: { name: `  Turista   de paso ${c.word} ` },
        payments: [{ paymentMethodId: c.cash.id, amountCents: 12000 }],
      }, SEES_EVERYONE),
    )
    const nobody = await run(c.orgId, (tx) =>
      sellAtCounter(tx, c.orgId, c.actor, {
        branchId: c.branchId,
        requestId: randomUUID(),
        lines: [{ productId: c.drops.id, quantity: 3 }],
        buyer: { name: "   " },
        payments: [{ paymentMethodId: c.cash.id, amountCents: 4500 }],
      }, SEES_EVERYONE),
    )
    expect(toContact.ticket).toMatchObject({ buyerContactId: person!.id, buyerName: null })
    expect(frozenOf(toContact.ticket).buyer).toEqual({ contactId: person!.id, displayName: person!.displayName })
    expect(toName.ticket).toMatchObject({ buyerContactId: null, buyerName: `Turista de paso ${c.word}` })
    expect(nobody.ticket).toMatchObject({ buyerContactId: null, buyerName: null })
    expect(frozenOf(nobody.ticket).buyer).toBeNull()

    const list = await run(c.orgId, (tx) => listTickets(tx, c.orgId, { branchId: c.branchId }))
    const byId = new Map(list.data.map((row) => [row.id, row]))
    expect(byId.get(toContact.ticket.id)).toMatchObject({ patientId: null, buyerContactId: person!.id, displayName: person!.displayName })
    expect(byId.get(toName.ticket.id)).toMatchObject({ patientId: null, buyerContactId: null, displayName: `Turista de paso ${c.word}` })
    expect(byId.get(nobody.ticket.id)).toMatchObject({ patientId: null, displayName: "Venta de mostrador", remainingCents: 0 })
    // Lo que suma la lista: todo, por medio.
    expect(list.totals).toEqual([
      {
        currency: "PEN",
        tickets: 3,
        cobradoCents: 18000,
        refundedCents: 0,
        byMethod: [
          { name: "Efectivo", cents: 16500 },
          { name: "Yape", cents: 1500 },
        ],
      },
    ])
    const found = async (q: string) => (await run(c.orgId, (tx) => listTickets(tx, c.orgId, { branchId: c.branchId, q }))).data.map((row) => row.id)
    expect(await found(`Turista ${c.word}`)).toEqual([toName.ticket.id])
    expect(await found(`Rosa ${c.word}`)).toEqual([toContact.ticket.id])
    expect((await found("mostrador")).sort()).toEqual([toContact.ticket.id, toName.ticket.id, nobody.ticket.id].sort())
    expect(await found(String(nobody.ticket.ticketNumber))).toEqual([nobody.ticket.id])

    // El buscador rápido: por número y por el nombre escrito, como su propia fila (no de una ficha).
    const search = (q: string) =>
      run(c.orgId, (tx) =>
        searchEverything(tx, c.orgId, { q, can: () => true, viewer: { userId: c.actor, role: "owner" } }),
      )
    const byNumber = await search(`ticket ${nobody.ticket.ticketNumber}`)
    expect(byNumber.owners.find((o) => o.id === nobody.ticket.id)).toMatchObject({
      kind: "comprobante",
      badge: "Venta de mostrador",
      detail: null,
      target: { screen: "ticket", ticketId: nobody.ticket.id, branchId: c.branchId },
    })
    const byName = await search(`Turista ${c.word}`)
    expect(byName.owners.find((o) => o.id === toName.ticket.id)).toMatchObject({ kind: "comprobante", detail: `Turista de paso ${c.word}` })
    expect(byName.personal).toBe(true)

    // El ticket se abre por su id, sin ficha: la guarda de la historia bloqueada no tiene a quién mirar.
    expect(toName.ticket.patientId).toBeNull()
    const receipt = await run(c.orgId, (tx) => getTicketReceiptById(tx, c.orgId, toName.ticket.id))
    expect(receipt.patientId).toBeNull()
    expect(receipt.payments).toHaveLength(1)
    expect(Object.keys(receipt.chargeById)).toHaveLength(1)

    // Una persona archivada no se elige.
    await ownerDb.update(contact).set({ isActive: false }).where(eq(contact.id, person!.id))
    await expect(
      run(c.orgId, (tx) =>
        sellAtCounter(tx, c.orgId, c.actor, {
          branchId: c.branchId,
          requestId: randomUUID(),
          lines: [{ productId: c.drops.id }],
          buyer: { contactId: person!.id },
          payments: [{ paymentMethodId: c.cash.id, amountCents: 1500 }],
        }, SEES_EVERYONE),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", fields: { contactId: "Contacto no encontrado" } })
  })

  it("el reintento devuelve el mismo ticket; con otros datos o la clave de un cobro, un conflicto en palabras", async () => {
    const c = await counter()
    const body = {
      branchId: c.branchId,
      requestId: randomUUID(),
      lines: [{ productId: c.drops.id, quantity: 2 }],
      payments: [{ paymentMethodId: c.cash.id, amountCents: 3000 }],
      cashReceivedCents: 5000,
    }
    const first = await run(c.orgId, (tx) => sellAtCounter(tx, c.orgId, c.actor, body, SEES_EVERYONE))
    const again = await run(c.orgId, (tx) => sellAtCounter(tx, c.orgId, c.actor, body, SEES_EVERYONE))
    expect(again.duplicate).toBe(true)
    expect(again.ticket.id).toBe(first.ticket.id)
    expect(again.payments.map((p) => p.id)).toEqual(first.payments.map((p) => p.id))
    // Ni otra venta ni otra salida del almacén.
    expect(await c.onHand(c.drops)).toBe(8)
    const tickets = await ownerDb.select().from(paymentTicket).where(eq(paymentTicket.requestId, body.requestId))
    expect(tickets).toHaveLength(1)
    await expect(
      run(c.orgId, (tx) => sellAtCounter(tx, c.orgId, c.actor, { ...body, cashReceivedCents: 10000 }, SEES_EVERYONE)),
    ).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT", status: 409, message: expect.stringContaining("ya se cobró con otros datos") })
    // La clave de un cobro de una ficha no sirve para una venta de mostrador.
    const f = await clinicalFixture()
    await f.run((tx) => createCharge(tx, ...f.args, { description: "Consulta", amountCents: 3000, currency: "PEN" }))
    const collected = await f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId: c.branchId,
        payments: [{ paymentMethodId: c.cash.id, amountCents: 3000 }],
        requestId: randomUUID(),
      }),
    )
    await expect(
      run(c.orgId, (tx) => sellAtCounter(tx, c.orgId, c.actor, { ...body, requestId: collected.ticket.requestId! }, SEES_EVERYONE)),
    ).rejects.toMatchObject({ code: "REQUEST_ID_CONFLICT" })
  })

  it("se paga entera: ni deuda ni saldo a favor, y no se mezcla con la cuenta de un paciente", async () => {
    const c = await counter()
    const sell = (payments: Array<{ paymentMethodId: string; amountCents: number }>, extra = {}) =>
      run(c.orgId, (tx) =>
        sellAtCounter(tx, c.orgId, c.actor, {
          branchId: c.branchId,
          requestId: randomUUID(),
          lines: [{ productId: c.sunglasses.id }],
          payments,
          ...extra,
        }, SEES_EVERYONE),
      )
    await expect(sell([{ paymentMethodId: c.cash.id, amountCents: 10000 }])).rejects.toMatchObject({
      code: "COUNTER_SALE_SHORT",
      message: expect.stringContaining("Falta cobrar"),
      fields: { payments: expect.any(String) },
    })
    await expect(sell([{ paymentMethodId: c.yape.id, amountCents: 13000 }])).rejects.toMatchObject({ code: "COUNTER_SALE_OVER" })
    // Lo recibido de más en efectivo es vuelto, no un excedente.
    await expect(sell([{ paymentMethodId: c.yape.id, amountCents: 12000 }], { cashReceivedCents: 20000 })).rejects.toMatchObject({
      code: "VALIDATION",
      fields: { cashReceivedCents: expect.any(String) },
    })
    await expect(sell([])).rejects.toMatchObject({ fields: { payments: "Elige con qué paga" } })
    await expect(
      run(c.orgId, (tx) =>
        sellAtCounter(tx, c.orgId, c.actor, {
          branchId: c.branchId,
          requestId: randomUUID(),
          lines: [{ productId: c.drops.id }, { productId: c.drops.id }],
          payments: [{ paymentMethodId: c.cash.id, amountCents: 3000 }],
        }, SEES_EVERYONE),
      ),
    ).rejects.toMatchObject({ fields: { "lines[1].productId": expect.stringContaining("ya está en la venta") } })
    // Nada salió del almacén con los rechazos.
    expect(await c.onHand(c.sunglasses)).toBe(3)

    // Quien compra es paciente con saldo a favor: la venta de mostrador no lo usa ni lo cambia.
    const f = await clinicalFixture()
    await f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId: c.branchId,
        advanceCents: 20000,
        payments: [{ paymentMethodId: c.cash.id, amountCents: 20000 }],
        requestId: randomUUID(),
      }),
    )
    const sold = await sell([{ paymentMethodId: c.cash.id, amountCents: 12000 }], { buyer: { contactId: f.patient.personId } })
    expect(sold.ticket.creditAppliedCents).toBe(0)
    const account = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
    expect(account.byCurrency.find((row) => row.currency === "PEN")).toMatchObject({ aFavor: 20000, porCobrar: 0 })

    // La base tampoco deja unir el mostrador con la cuenta de un paciente.
    const refused = (query: PromiseLike<unknown>) =>
      Promise.resolve(query).then(
        () => "aceptado",
        (error: { cause?: { message?: string }; message?: string }) => String(error.cause?.message ?? error.message),
      )
    const [counterPayment] = await ownerDb.select().from(patientPayment).where(eq(patientPayment.ticketId, sold.ticket.id))
    const patientCharges = await f.run((tx) => createCharge(tx, ...f.args, { description: "Limpieza", amountCents: 1000, currency: "PEN" }))
    expect(
      await refused(
        ownerDb.insert(patientPaymentApplication).values({
          organizationId: "org_a",
          patientId: null,
          paymentId: counterPayment!.id,
          chargeId: patientCharges.id,
          ticketId: sold.ticket.id,
          amountCents: 1000,
        }),
      ),
    ).toContain("no se mezcla con la cuenta de un paciente")
    expect(
      await refused(
        ownerDb.insert(paymentTicket).values({
          organizationId: "org_a",
          patientId: null,
          branchId: c.branchId,
          ticketNumber: 900_000 + Math.floor(Math.random() * 90_000),
          currency: "PEN",
          totalCents: 1000,
          creditAppliedCents: 100,
          snapshot: {},
        }),
      ),
    ).toContain("payment_ticket_counter_check")
    expect(
      await refused(
        ownerDb.insert(patientCharge).values({
          organizationId: "org_a",
          patientId: null,
          description: "Una atención sin ficha",
          amountCents: 1000,
          currency: "PEN",
        }),
      ),
    ).toContain("patient_charge_counter_check")
    expect(
      await refused(
        ownerDb.insert(patientPayment).values({
          organizationId: "org_a",
          patientId: f.patient.id,
          ticketId: sold.ticket.id,
          methodName: "Efectivo",
          amountCents: 100,
          currency: "PEN",
          paidAt: new Date(),
        }),
      ),
    ).toContain("no se mezcla con la cuenta de un paciente")

    // Lo de una venta de mostrador queda en su ticket: su pago no paga lo de otra venta.
    const other = await sell([{ paymentMethodId: c.cash.id, amountCents: 12000 }])
    const [otherApp] = await ownerDb
      .select()
      .from(patientPaymentApplication)
      .where(eq(patientPaymentApplication.ticketId, other.ticket.id))
    expect(
      await refused(
        ownerDb.insert(patientPaymentApplication).values({
          organizationId: "org_a",
          patientId: null,
          paymentId: counterPayment!.id,
          chargeId: otherApp!.chargeId,
          ticketId: sold.ticket.id,
          amountCents: 100,
        }),
      ),
    ).toContain("queda en su propio ticket")
    // Y nada pasa después a la cuenta de un paciente, ni sale de ella.
    expect(
      await refused(ownerDb.update(patientCharge).set({ patientId: f.patient.id }).where(eq(patientCharge.id, otherApp!.chargeId))),
    ).toContain("no cambia de cuenta")
    expect(
      await refused(ownerDb.update(patientCharge).set({ patientId: null }).where(eq(patientCharge.id, patientCharges.id))),
    ).toContain("no cambia de cuenta")
  })

  it("quien compra: archivada o con su historia bloqueada no se elige, y Caja solo elige a un paciente", async () => {
    const c = await counter()
    const f = await clinicalFixture()
    const sale = (contactId: string, can: (permission: string) => boolean) =>
      run(c.orgId, (tx) =>
        sellAtCounter(
          tx,
          c.orgId,
          c.actor,
          {
            branchId: c.branchId,
            requestId: randomUUID(),
            lines: [{ productId: c.drops.id }],
            buyer: { contactId },
            payments: [{ paymentMethodId: c.cash.id, amountCents: 1500 }],
          },
          can,
        ),
      )
    const [stranger] = await ownerDb
      .insert(contact)
      .values({ organizationId: c.orgId, displayName: `Sin ficha ${c.tag}` })
      .returning()
    const [locked] = await ownerDb
      .insert(contact)
      .values({
        organizationId: c.orgId,
        displayName: `Bloqueada ${c.tag}`,
        isActive: false,
        recordLockedAt: new Date(),
        recordLockedBy: c.actor,
      })
      .returning()
    await expect(sale(locked!.id, SEES_EVERYONE)).rejects.toMatchObject({ status: 404 })
    // Caja no ve a quien no es paciente: para ella no existe.
    const cashier = (permission: string) => permission !== "crm.read"
    await expect(sale(stranger!.id, cashier)).rejects.toMatchObject({ status: 404 })
    expect((await sale(f.patient.personId, cashier)).ticket.buyerContactId).toBe(f.patient.personId)
    // Recepción sí: cualquier persona, sea o no paciente.
    expect((await sale(stranger!.id, SEES_EVERYONE)).ticket.buyerContactId).toBe(stranger!.id)
    expect(await c.onHand(c.drops)).toBe(8)
  })

  it("anular devuelve el producto a la sede y saca el dinero de la caja", async () => {
    const c = await counter()
    const sale = await run(c.orgId, (tx) =>
      sellAtCounter(tx, c.orgId, c.actor, {
        branchId: c.branchId,
        requestId: randomUUID(),
        lines: [{ productId: c.sunglasses.id }, { productId: c.drops.id, quantity: 4 }],
        payments: [
          { paymentMethodId: c.cash.id, amountCents: 10000 },
          { paymentMethodId: c.yape.id, amountCents: 8000 },
        ],
        cashReceivedCents: 10000,
      }, SEES_EVERYONE),
    )
    expect(await c.onHand(c.sunglasses)).toBe(2)
    expect(await c.onHand(c.drops)).toBe(6)
    const returnable = await run(c.orgId, (tx) => getTicketReturnable(tx, c.orgId, null, sale.ticket.id))
    expect(returnable.lines.map((line) => [line.kind, line.paidCents, line.blockedReason])).toEqual([
      ["producto", 12000, null],
      ["producto", 6000, null],
    ])
    // Por la ruta de una ficha, no existe.
    const f = await clinicalFixture()
    await expect(f.run((tx) => getTicketReturnable(tx, "org_a", f.patient.id, sale.ticket.id))).rejects.toMatchObject({ code: "NOT_FOUND" })
    const voided = await run(c.orgId, (tx) =>
      voidTicket(tx, c.orgId, c.actor, null, sale.ticket.id, { reason: "Se marcó otro medio", allowPostClose: false }),
    )
    expect(voided.account).toBeNull()
    expect(voided.returnedProducts.map((item) => item.quantity).sort()).toEqual([1, 4])
    expect(await c.onHand(c.sunglasses)).toBe(3)
    expect(await c.onHand(c.drops)).toBe(10)
    const charges = await ownerDb.select().from(patientCharge).where(and(eq(patientCharge.branchId, c.branchId), isNull(patientCharge.patientId)))
    expect(charges.every((charge) => charge.voidedAt !== null)).toBe(true)
    const state = await run(c.orgId, (tx) => getCashState(tx, c.orgId, { branchId: c.branchId }))
    expect(state.cashOnHandCents).toBe(0)
    const live = await ownerDb
      .select()
      .from(cashMovement)
      .where(and(eq(cashMovement.organizationId, c.orgId), eq(cashMovement.shiftId, state.shiftId!), isNull(cashMovement.voidedAt)))
    expect(live).toHaveLength(0)
    await expect(
      run(c.orgId, (tx) => voidTicket(tx, c.orgId, c.actor, null, sale.ticket.id, { reason: "Otra vez", allowPostClose: false })),
    ).rejects.toMatchObject({ code: "TICKET_VOIDED" })
    const pdf = await run(c.orgId, async (tx) => renderTicketPdf(await buildTicketSnapshot(tx, c.orgId, null, sale.ticket.id)))
    expect(Buffer.from(pdf.slice(0, 5)).toString("latin1")).toBe("%PDF-")
  })

  it("devolver le paga lo devuelto (nunca a favor) y lo que está bien vuelve a la sede", async () => {
    const c = await counter()
    const sale = await run(c.orgId, (tx) =>
      sellAtCounter(tx, c.orgId, c.actor, {
        branchId: c.branchId,
        requestId: randomUUID(),
        lines: [{ productId: c.drops.id, quantity: 4 }],
        buyer: { name: `Turista ${c.word}` },
        payments: [{ paymentMethodId: c.cash.id, amountCents: 6000 }],
      }, SEES_EVERYONE),
    )
    const [charge] = (await run(c.orgId, (tx) => getTicketReturnable(tx, c.orgId, null, sale.ticket.id))).lines
    // Sin ficha no hay cuenta donde dejarlo a favor.
    await expect(
      run(c.orgId, (tx) =>
        returnFromTicket(tx, c.orgId, c.actor, null, sale.ticket.id, {
          branchId: c.branchId,
          lines: [{ chargeId: charge!.chargeId, quantity: 1 }],
          paymentMethodId: null,
          reason: "No le sirvió",
          requestId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ fields: { paymentMethodId: expect.stringContaining("no tiene cuenta") } })
    const back = await run(c.orgId, (tx) =>
      returnFromTicket(tx, c.orgId, c.actor, null, sale.ticket.id, {
        branchId: c.branchId,
        lines: [{ chargeId: charge!.chargeId, quantity: 1 }],
        paymentMethodId: c.cash.id,
        reason: "No le sirvió",
        requestId: randomUUID(),
      }),
    )
    expect(back.account).toBeNull()
    expect(back.paymentReturn).toMatchObject({ patientId: null, outcome: "pagado", totalCents: 1500 })
    expect(await c.onHand(c.drops)).toBe(7)
    const refunds = await ownerDb.select().from(patientPaymentRefund).where(eq(patientPaymentRefund.returnId, back.paymentReturn.id))
    expect(refunds.map((r) => [r.patientId, r.amountCents])).toEqual([[null, 1500]])
    // La caja del día pierde lo que se le devolvió.
    const state = await run(c.orgId, (tx) => getCashState(tx, c.orgId, { branchId: c.branchId }))
    expect(state.cashOnHandCents).toBe(4500)
    // Lo que queda del concepto sigue pagado entero: no hay deuda ni saldo.
    const returnable = await run(c.orgId, (tx) => getTicketReturnable(tx, c.orgId, null, sale.ticket.id))
    expect(returnable.lines.map((line) => [line.quantity, line.amountCents, line.paidCents])).toEqual([[3, 4500, 4500]])
    const list = await run(c.orgId, (tx) => listTickets(tx, c.orgId, { branchId: c.branchId }))
    expect(list.data.find((row) => row.id === sale.ticket.id)).toMatchObject({ returnedCents: 1500 })
    expect(list.totals?.[0]).toMatchObject({ cobradoCents: 6000, refundedCents: 1500 })
    // La devolución dice a quién, como el ticket, y se imprime.
    const stored = await run(c.orgId, (tx) => getPaymentReturn(tx, c.orgId, null, back.paymentReturn.id))
    expect(stored.snapshot.patient).toBeNull()
    expect(stored.snapshot.buyer).toEqual({ contactId: null, displayName: `Turista ${c.word}` })
    const pdf = await run(c.orgId, (tx) => renderReturnPdf(tx, c.orgId, null, back.paymentReturn.id))
    expect(Buffer.from(pdf.bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-")
    // Con una devolución, ya no se anula.
    await expect(
      run(c.orgId, (tx) => voidTicket(tx, c.orgId, c.actor, null, sale.ticket.id, { reason: "Error", allowPostClose: false })),
    ).rejects.toMatchObject({ code: "TICKET_HAS_REFUNDS" })
  })

  it("el ticket dice «Venta de mostrador» o «Cliente», en el rollo y en la hoja", async () => {
    const c = await counter()
    const sell = (buyer?: { name: string }) =>
      run(c.orgId, (tx) =>
        sellAtCounter(tx, c.orgId, c.actor, {
          branchId: c.branchId,
          requestId: randomUUID(),
          lines: [{ productId: c.drops.id }],
          ...(buyer ? { buyer } : {}),
          payments: [{ paymentMethodId: c.cash.id, amountCents: 1500 }],
        }, SEES_EVERYONE),
      )
    const nobody = await sell()
    const named = await sell({ name: "Ana Torres" })
    const plain = await run(c.orgId, (tx) => buildTicketSnapshot(tx, c.orgId, null, nobody.ticket.id))
    expect(plain).toMatchObject({ partyLabel: null, patientName: "Venta de mostrador", patientDoc: null, status: "vigente" })
    const client = await run(c.orgId, (tx) => buildTicketSnapshot(tx, c.orgId, null, named.ticket.id))
    expect(client).toMatchObject({ partyLabel: "Cliente", patientName: "Ana Torres" })
    for (const snap of [plain, client]) {
      expect(Buffer.from((await renderTicketPdf(snap)).slice(0, 5)).toString("latin1")).toBe("%PDF-")
      expect((await renderTicketPdf(snap, "A4")).length).toBeGreaterThan(1000)
    }
    // Un ticket de una ficha no se lee por el camino del mostrador.
    const f = await clinicalFixture()
    await f.run((tx) => createCharge(tx, ...f.args, { description: "Consulta", amountCents: 1000, currency: "PEN" }))
    const collected = await f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId: c.branchId,
        payments: [{ paymentMethodId: c.cash.id, amountCents: 1000 }],
        requestId: randomUUID(),
      }),
    )
    await expect(run(c.orgId, (tx) => buildTicketSnapshot(tx, c.orgId, null, collected.ticket.id))).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect((await f.run((tx) => buildTicketSnapshot(tx, "org_a", f.patient.id, collected.ticket.id))).partyLabel).toBe("Paciente")
  })
})

describe("Argos lee la venta de mostrador como lo demás", () => {
  it("lo cobrado del día en argos.cobros es lo de Finanzas, y las vistas la dicen «Venta de mostrador»", async () => {
    const orgId = `org_mostrador_${randomUUID().slice(0, 6)}`
    await insertOrg(ownerDb, orgId, orgId.replaceAll("_", "-"))
    const c = await counter(orgId)
    const f = await clinicalFixture(orgId)
    await f.run((tx) => createCharge(tx, orgId, f.actor, f.patient.id, { description: "Consulta", amountCents: 8000, currency: "PEN" }))
    await f.run((tx) =>
      collectCharge(tx, orgId, f.actor, f.patient.id, {
        branchId: c.branchId,
        payments: [{ paymentMethodId: c.cash.id, amountCents: 8000 }],
        requestId: randomUUID(),
      }),
    )
    const kept = await run(orgId, (tx) =>
      sellAtCounter(tx, orgId, c.actor, {
        branchId: c.branchId,
        requestId: randomUUID(),
        lines: [{ productId: c.sunglasses.id }, { productId: c.drops.id, quantity: 2 }],
        payments: [
          { paymentMethodId: c.cash.id, amountCents: 5000 },
          { paymentMethodId: c.yape.id, amountCents: 10000 },
        ],
      }, SEES_EVERYONE),
    )
    const undone = await run(orgId, (tx) =>
      sellAtCounter(tx, orgId, c.actor, {
        branchId: c.branchId,
        requestId: randomUUID(),
        lines: [{ productId: c.drops.id }],
        payments: [{ paymentMethodId: c.cash.id, amountCents: 1500 }],
      }, SEES_EVERYONE),
    )
    await run(orgId, (tx) => voidTicket(tx, orgId, c.actor, null, undone.ticket.id, { reason: "Error", allowPostClose: false }))
    const [drops] = (await run(orgId, (tx) => getTicketReturnable(tx, orgId, null, kept.ticket.id))).lines.filter(
      (line) => line.productName === c.drops.name,
    )
    await run(orgId, (tx) =>
      returnFromTicket(tx, orgId, c.actor, null, kept.ticket.id, {
        branchId: c.branchId,
        lines: [{ chargeId: drops!.chargeId, quantity: 1 }],
        paymentMethodId: c.cash.id,
        reason: "Vencido",
        requestId: randomUUID(),
      }),
    )
    const start = new Date(Date.now() - 6 * 3600_000)
    const end = new Date(Date.now() + 60_000)
    const [collected] = await run(orgId, (tx) => collectedNetMany(tx, orgId, [{ start, end }]))
    const cents = collected?.find((row) => row.currency === "PEN")?.cents
    // 8000 + 15000 + 1500 − 1500 (anulado) − 1500 (devuelto).
    expect(cents).toBe(21500)
    const argos = async (query: string) => (await runArgosQuery(appDb, { orgId, memberRole: "owner", query })).rows
    const [sum] = await argos(
      `select sum(importe) as v from cobros where momento >= '${start.toISOString()}' and momento < '${end.toISOString()}'`,
    )
    expect(Math.round(Number(sum?.v) * 100)).toBe(cents)
    const counterRows = await argos(
      "select count(*) as v from cobros where paciente = 'Venta de mostrador' and paciente_id is null",
    )
    // Dos pagos, un pago y su anulación, y una devolución.
    expect(Number(counterRows[0]?.v)).toBe(5)
    const [tickets] = await argos("select count(*) as v from tickets where paciente = 'Venta de mostrador' and paciente_id is null")
    expect(Number(tickets?.v)).toBe(2)
    const sales = await argos("select concepto, cantidad, pagado, saldo from ventas where paciente = 'Venta de mostrador' order by concepto")
    expect(sales.map((row) => [row.concepto, Number(row.cantidad), Number(row.pagado), Number(row.saldo)])).toEqual([
      [c.drops.name, 1, 15, 0],
      [c.sunglasses.name, 1, 120, 0],
    ])
    const [paid] = await argos("select sum(importe) as v from pagos_por_venta where paciente_id is null")
    expect(Number(paid?.v)).toBe(135)
  })
})
