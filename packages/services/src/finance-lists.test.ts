/**
 * Las listas de Finanzas: Cobros (todos los tickets con búsqueda, filtros,
 * totales por medio y páginas), Deudas por páginas, Gastos con búsqueda y
 * tipo, y Cierres con «No cuadró» y lo que contó cada uno.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { branch } from "@odentia/db/schema/org"
import { describe, expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  closeCashWindow,
  createExpense,
  getClosureSheet,
  getMonthExpenses,
  listClosures,
  listDebts,
  listTickets,
} from "./finance.js"
import { getOrgLocale } from "./locale.js"
import { collectCharge, createCharge, getTicketReceiptById, voidTicket } from "./payments.js"
import { createPaymentMethod } from "./payment-methods.js"
import { nextPatientNumber } from "./patients.js"
import { insertTestPatients } from "./test-patient.js"
import { ownerDb, setupTestDb } from "./test-setup.js"
setupTestDb()

type Run = <T>(fn: (tx: Db) => Promise<T>) => Promise<T>

async function seedBranch(run: Run, actor: string) {
  const [branchRow] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede listas ${randomUUID()}` })
    .returning()
  const cash = await run((tx) => createPaymentMethod(tx, "org_a", actor, { name: "Efectivo", typeCode: "10" }))
  const card = await run((tx) => createPaymentMethod(tx, "org_a", actor, { name: "Tarjeta", typeCode: "48" }))
  return { branchId: branchRow.id, cash, card }
}

async function secondPatient(displayName: string, docNumber: string) {
  const [person] = await insertTestPatients(ownerDb, {
    organizationId: "org_a",
    displayName,
    docType: "1",
    docNumber,
    patientNumber: await nextPatientNumber(ownerDb, "org_a"),
  })
  return person
}

/** Cobra un concepto nuevo de una persona con un medio y devuelve su ticket. */
async function collectOne(
  run: Run,
  actor: string,
  patientId: string,
  branchId: string,
  description: string,
  amountCents: number,
  paymentMethodId: string,
) {
  await run((tx) => createCharge(tx, "org_a", actor, patientId, { description, amountCents, currency: "PEN", branchId }))
  const result = await run((tx) =>
    collectCharge(tx, "org_a", actor, patientId, {
      branchId,
      payments: [{ paymentMethodId, amountCents }],
      requestId: randomUUID(),
    }),
  )
  return result.ticket
}

describe("Cobros: todos los tickets de la sede", () => {
  it("lista el ticket entero, suma por medio sin lo anulado y busca por nombre, documento o número", async () => {
    const f = await clinicalFixture()
    const { branchId, cash, card } = await seedBranch(f.run, f.actor)
    const rosa = await secondPatient("Rosa Quispe Mamani", "45120987")
    const first = await collectOne(f.run, f.actor, f.patient.id, branchId, "Consulta", 30000, cash.id)
    const second = await collectOne(f.run, f.actor, rosa.id, branchId, "Resina compuesta", 20000, card.id)
    const third = await collectOne(f.run, f.actor, rosa.id, branchId, "Profilaxis", 10000, cash.id)
    await f.run((tx) =>
      voidTicket(tx, "org_a", f.actor, rosa.id, third.id, { reason: "Se cobró dos veces", allowPostClose: true }),
    )

    const all = await f.run((tx) => listTickets(tx, "org_a", { branchId }))
    expect(all.data.map((row) => row.id)).toEqual([third.id, second.id, first.id])
    expect(all.total).toBe(3)
    expect(all.allDates).toBe(false)
    expect(all.totals).toEqual([
      expect.objectContaining({ currency: "PEN", tickets: 2, cobradoCents: 50000, refundedCents: 0 }),
    ])
    expect(all.totals?.[0]?.byMethod).toEqual([
      { name: "Efectivo", cents: 30000 },
      { name: "Tarjeta", cents: 20000 },
    ])
    const voided = all.data[0]
    expect(voided?.voided).toMatchObject({ reason: "Se cobró dos veces" })
    expect(all.data[1]).toMatchObject({
      number: second.ticketNumber,
      displayName: "Rosa Quispe Mamani",
      docNumber: "45120987",
      totalCents: 20000,
      lines: [{ description: "Resina compuesta", appliedCents: 20000 }],
      methods: [{ name: "Tarjeta", amountCents: 20000 }],
      voided: null,
    })
    expect(all.data[1]?.cashierName).toBeTruthy()
    expect(all.cashiers?.map((person) => person.id)).toEqual([f.actor])

    const byName = await f.run((tx) => listTickets(tx, "org_a", { branchId, q: "quispe rosa" }))
    expect(byName.data.map((row) => row.id)).toEqual([third.id, second.id])
    const byDocument = await f.run((tx) => listTickets(tx, "org_a", { branchId, q: "45120987" }))
    expect(byDocument.data.map((row) => row.id)).toEqual([third.id, second.id])
    expect(byDocument.allDates).toBe(true)
    const byNumber = await f.run((tx) =>
      listTickets(tx, "org_a", { branchId, q: String(first.ticketNumber).padStart(6, "0") }),
    )
    expect(byNumber.data.map((row) => row.id)).toEqual([first.id])

    // Un número se busca en todas las fechas: la fecha de los filtros no lo esconde.
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)
    const future = await f.run((tx) => listTickets(tx, "org_a", { branchId, from: tomorrow, to: tomorrow }))
    expect(future.data).toEqual([])
    const futureByNumber = await f.run((tx) =>
      listTickets(tx, "org_a", { branchId, from: tomorrow, to: tomorrow, q: String(first.ticketNumber) }),
    )
    expect(futureByNumber.data.map((row) => row.id)).toEqual([first.id])
  })

  it("filtra por medio, quién cobró y estado, ordena por monto y pagina sin repetir", async () => {
    const f = await clinicalFixture()
    const { branchId, cash, card } = await seedBranch(f.run, f.actor)
    const small = await collectOne(f.run, f.actor, f.patient.id, branchId, "Consulta", 5000, cash.id)
    const big = await collectOne(f.run, f.actor, f.patient.id, branchId, "Corona", 80000, card.id)
    const middle = await collectOne(f.run, f.actor, f.patient.id, branchId, "Resina", 20000, cash.id)
    await f.run((tx) =>
      voidTicket(tx, "org_a", f.actor, f.patient.id, middle.id, { reason: "Error", allowPostClose: true }),
    )

    const byCard = await f.run((tx) => listTickets(tx, "org_a", { branchId, methodIds: [card.id] }))
    expect(byCard.data.map((row) => row.id)).toEqual([big.id])

    // Un ticket pagado con dos medios: filtrado por uno, lo cobrado es solo lo de ese medio.
    await f.run((tx) =>
      createCharge(tx, ...f.args, { description: "Puente", amountCents: 30000, currency: "PEN", branchId }),
    )
    const split = await f.run((tx) =>
      collectCharge(tx, ...f.args, {
        branchId,
        payments: [
          { paymentMethodId: cash.id, amountCents: 10000 },
          { paymentMethodId: card.id, amountCents: 20000 },
        ],
        requestId: randomUUID(),
      }),
    )
    const cashOnly = await f.run((tx) => listTickets(tx, "org_a", { branchId, methodIds: [cash.id], state: "vigentes" }))
    expect(cashOnly.data.map((row) => row.id)).toEqual([split.ticket.id, small.id])
    expect(cashOnly.totals?.[0]).toMatchObject({ cobradoCents: 15000, byMethod: [{ name: "Efectivo", cents: 15000 }] })
    await f.run((tx) =>
      voidTicket(tx, "org_a", f.actor, f.patient.id, split.ticket.id, { reason: "Prueba", allowPostClose: true }),
    )
    const byCashier = await f.run((tx) => listTickets(tx, "org_a", { branchId, cashierIds: [f.actor] }))
    expect(byCashier.total).toBe(4)
    const nobody = await f.run((tx) => listTickets(tx, "org_a", { branchId, cashierIds: [randomUUID()] }))
    expect(nobody.data).toEqual([])
    const voided = await f.run((tx) => listTickets(tx, "org_a", { branchId, state: "anulados" }))
    expect(voided.data.map((row) => row.id)).toEqual([split.ticket.id, middle.id])
    const live = await f.run((tx) => listTickets(tx, "org_a", { branchId, state: "vigentes" }))
    expect(live.data.map((row) => row.id)).toEqual([big.id, small.id])

    const byAmount = await f.run((tx) => listTickets(tx, "org_a", { branchId, sort: "monto" }))
    expect(byAmount.data.map((row) => row.id)).toEqual([big.id, split.ticket.id, middle.id, small.id])

    const page1 = await f.run((tx) => listTickets(tx, "org_a", { branchId, limit: 2 }))
    expect(page1.data).toHaveLength(2)
    expect(page1.nextCursor).toBeTruthy()
    const page2 = await f.run((tx) =>
      listTickets(tx, "org_a", { branchId, limit: 2, cursor: page1.nextCursor ?? undefined }),
    )
    expect(page2.nextCursor).toBeNull()
    // Lo que suma la lista viene solo con la primera página.
    expect(page2.cashiers).toBeNull()
    expect(page2.totals).toBeNull()
    expect([...page1.data, ...page2.data].map((row) => row.id)).toEqual([split.ticket.id, middle.id, big.id, small.id])
    const amountPage2 = await f.run(async (tx) => {
      const first = await listTickets(tx, "org_a", { branchId, sort: "monto", limit: 1 })
      return listTickets(tx, "org_a", { branchId, sort: "monto", limit: 1, cursor: first.nextCursor ?? undefined })
    })
    expect(amountPage2.data.map((row) => row.id)).toEqual([split.ticket.id])

    await expect(f.run((tx) => listTickets(tx, "org_a", { branchId, cursor: "no-es-una-pagina" }))).rejects.toThrow()
  })

  it("cada sede ve sus tickets y uno se abre por su identificador", async () => {
    const f = await clinicalFixture()
    const a = await seedBranch(f.run, f.actor)
    const b = await seedBranch(f.run, f.actor)
    const inA = await collectOne(f.run, f.actor, f.patient.id, a.branchId, "Consulta", 15000, a.cash.id)
    await collectOne(f.run, f.actor, f.patient.id, b.branchId, "Consulta", 15000, b.cash.id)
    const listA = await f.run((tx) => listTickets(tx, "org_a", { branchId: a.branchId }))
    expect(listA.data.map((row) => row.id)).toEqual([inA.id])

    const receipt = await f.run((tx) => getTicketReceiptById(tx, "org_a", inA.id))
    expect(receipt.patientId).toBe(f.patient.id)
    expect(receipt.ticket.id).toBe(inA.id)
    await expect(f.run((tx) => getTicketReceiptById(tx, "org_a", randomUUID()))).rejects.toThrow()
  })
})

describe("Deudas por páginas", () => {
  it("busca por nombre o documento, ordena por lo que se debe y resume la sede", async () => {
    const f = await clinicalFixture()
    const { branchId } = await seedBranch(f.run, f.actor)
    const rosa = await secondPatient("Rosa Quispe Mamani", "47031265")
    await f.run((tx) =>
      createCharge(tx, ...f.args, { description: "Endodoncia", amountCents: 60000, currency: "PEN", branchId }),
    )
    await f.run((tx) =>
      createCharge(tx, "org_a", f.actor, rosa.id, { description: "Resina compuesta", amountCents: 15000, currency: "PEN", branchId }),
    )
    await f.run((tx) =>
      createCharge(tx, "org_a", f.actor, rosa.id, { description: "Profilaxis", amountCents: 5000, currency: "PEN", branchId }),
    )

    const all = await f.run((tx) => listDebts(tx, "org_a", { branchId }))
    expect(all.total).toBe(2)
    expect(all.data.map((row) => row.patientId)).toEqual([f.patient.id, rosa.id])
    expect(all.summary).toMatchObject({ people: 2, totals: [{ currency: "PEN", cents: 80000 }] })
    expect(all.summary.over30.people).toBe(0)
    const rosaRow = all.data[1]
    expect(rosaRow).toMatchObject({ dueCents: 20000, docNumber: "47031265", ageDays: 0, nextAppointmentAt: null })
    expect(rosaRow?.items.map((item) => [item.description, item.outstandingCents])).toEqual([
      ["Resina compuesta", 15000],
      ["Profilaxis", 5000],
    ])

    const byName = await f.run((tx) => listDebts(tx, "org_a", { branchId, q: "rosa" }))
    expect(byName.data.map((row) => row.patientId)).toEqual([rosa.id])
    expect(byName.summary.people).toBe(2)
    const byDocument = await f.run((tx) => listDebts(tx, "org_a", { branchId, q: "4703 1265" }))
    expect(byDocument.data.map((row) => row.patientId)).toEqual([rosa.id])
    const old = await f.run((tx) => listDebts(tx, "org_a", { branchId, age: "30" }))
    expect(old.data).toEqual([])

    const page1 = await f.run((tx) => listDebts(tx, "org_a", { branchId, limit: 1 }))
    expect(page1.nextCursor).toBe("1")
    const page2 = await f.run((tx) => listDebts(tx, "org_a", { branchId, limit: 1, cursor: "1" }))
    expect(page2.data.map((row) => row.patientId)).toEqual([rosa.id])
    expect(page2.nextCursor).toBeNull()

    // Lo anotado hoy es de «Por cobrar ahora» en la Caja; nada se debe de antes.
    const today = await f.run((tx) => listDebts(tx, "org_a", { branchId, when: "hoy" }))
    expect(today.total).toBe(2)
    expect(today.summary.earlier.people).toBe(0)
  })
})

describe("Gastos y cierres", () => {
  it("Gastos busca por concepto y filtra por tipo sin cambiar el total del mes", async () => {
    const f = await clinicalFixture()
    const { branchId } = await seedBranch(f.run, f.actor)
    await f.run((tx) =>
      createExpense(tx, "org_a", f.actor, { branchId, category: "Materiales", concept: "Guantes y mascarillas", amountCents: 8550 }),
    )
    await f.run((tx) =>
      createExpense(tx, "org_a", f.actor, {
        branchId,
        category: "Alquiler",
        concept: "Alquiler del local",
        amountCents: 350000,
        receiptKind: "Factura",
        receiptNumber: "F001-2231",
      }),
    )
    const { timezone } = await f.run((tx) => getOrgLocale(tx, "org_a"))
    const [year, month] = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" })
      .format(new Date())
      .split("-")
      .map(Number)
    const ref = { branchId, year: year as number, month: month as number }

    const bySearch = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...ref, q: "guantes" }))
    expect(bySearch.expenses.map((row) => row.concept)).toEqual(["Guantes y mascarillas"])
    expect(bySearch.shown).toEqual({ count: 1, totalCents: 8550 })
    expect(bySearch.totalCents).toBe(358550)
    const byReceipt = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...ref, q: "F001" }))
    expect(byReceipt.expenses.map((row) => row.concept)).toEqual(["Alquiler del local"])
    const byCategory = await f.run((tx) => getMonthExpenses(tx, "org_a", { ...ref, category: "Alquiler" }))
    expect(byCategory.shown).toEqual({ count: 1, totalCents: 350000 })
    expect(byCategory.byCategory).toHaveLength(2)
  })

  it("Cierres deja ver los que no cuadraron y la hoja dice lo que contó en efectivo", async () => {
    const f = await clinicalFixture()
    const { branchId, cash, card } = await seedBranch(f.run, f.actor)
    const ticket = await collectOne(f.run, f.actor, f.patient.id, branchId, "Consulta", 30000, cash.id)
    await collectOne(f.run, f.actor, f.patient.id, branchId, "Radiografía", 10000, card.id)
    await f.run((tx) =>
      createExpense(tx, "org_a", f.actor, { branchId, category: "Materiales", concept: "Algodón", amountCents: 2000, fromCash: true }),
    )
    // Debía haber 280.00 y se contaron 270.00: faltaron 10.00.
    const short = await f.run((tx) =>
      closeCashWindow(tx, "org_a", f.actor, { branchId, countedCents: 27000, retainedCents: 0, deliveredCents: 27000 }),
    )
    expect(short.differenceCents).toBe(-1000)
    await collectOne(f.run, f.actor, f.patient.id, branchId, "Control", 5000, cash.id)
    await f.run((tx) =>
      closeCashWindow(tx, "org_a", f.actor, { branchId, countedCents: 5000, retainedCents: 0, deliveredCents: 5000 }),
    )

    const all = await f.run((tx) => listClosures(tx, "org_a", { branchId }))
    expect(all).toHaveLength(2)
    const off = await f.run((tx) => listClosures(tx, "org_a", { branchId, result: "descuadre" }))
    expect(off.map((row) => row.differenceCents)).toEqual([-1000])

    const sheet = await f.run((tx) => getClosureSheet(tx, "org_a", off[0]?.id ?? ""))
    const counted = sheet.counted.filter((row) => row.kind !== "apertura")
    expect(counted.map((row) => [row.kind, row.amountCents, row.ticketNumber])).toEqual([
      ["cobro", 30000, ticket.ticketNumber],
      ["gasto", 2000, null],
    ])
  })
})
