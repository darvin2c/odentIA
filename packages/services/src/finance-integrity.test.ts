/**
 * Integridad del dinero: lo que la revisión de la rama encontró roto y no
 * debe volver. Cada caso parte de una situación real de caja.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { cashMovement } from "@odentia/db/schema/finance"
import { branch } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  addCashMovement,
  closeCashWindow,
  getCashState,
  getDebts,
  listClosures,
  voidMovement,
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

async function newBranch(): Promise<string> {
  const [row] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede ${randomUUID()}` })
    .returning()
  return row!.id
}

async function seedCashbox(f: Fixture) {
  const branchId = await newBranch()
  const cash = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Efectivo", typeCode: "10" }),
  )
  const wallet = await f.run((tx) =>
    createPaymentMethod(tx, "org_a", f.actor, { name: "Billetera", typeCode: "68" }),
  )
  return { branchId, cash, wallet }
}

const pen = (rows: Array<{ currency: string }>) => rows.find((row) => row.currency === "PEN")

// Va primero: la clínica aún no tiene fila de contador en esta base.
it("los dos primeros cobros de una clínica, a la vez y de pacientes distintos, toman números seguidos", async () => {
  const a = await clinicalFixture()
  const b = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(a)
  await a.run((tx) =>
    createCharge(tx, ...a.args, { description: "Consulta", amountCents: 5000, currency: "PEN", branchId }),
  )
  await b.run((tx) =>
    createCharge(tx, ...b.args, { description: "Consulta", amountCents: 7000, currency: "PEN", branchId }),
  )
  const [first, second] = await Promise.all([
    a.run((tx) =>
      collectCharge(tx, ...a.args, {
        branchId,
        payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
        requestId: randomUUID(),
      }),
    ),
    b.run((tx) =>
      collectCharge(tx, ...b.args, {
        branchId,
        payments: [{ paymentMethodId: cash.id, amountCents: 7000 }],
        requestId: randomUUID(),
      }),
    ),
  ])
  expect([first.ticket.ticketNumber, second.ticket.ticketNumber].sort()).toEqual([1, 2])
})

it("un cobro que falla no gasta número: el siguiente ticket sigue la serie", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Resina", amountCents: 9000, currency: "PEN", branchId }),
  )
  const before = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 4000 }],
      requestId: randomUUID(),
    }),
  )
  // La transacción falla después de numerar: el número vuelve con todo lo demás.
  let lost = 0
  await expect(
    f.run(async (tx) => {
      const doomed = await collectCharge(tx, ...f.args, {
        branchId,
        payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
        requestId: randomUUID(),
      })
      lost = doomed.ticket.ticketNumber
      throw new Error("fallo posterior al cobro")
    }),
  ).rejects.toThrow("fallo posterior al cobro")
  expect(lost).toBe(before.ticket.ticketNumber + 1)
  const after = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 5000 }],
      requestId: randomUUID(),
    }),
  )
  expect(after.ticket.ticketNumber).toBe(before.ticket.ticketNumber + 1)
})

it("anular un adelanto ya usado devuelve el concepto a por cobrar", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  const advance = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 20000,
      payments: [{ paymentMethodId: cash.id, amountCents: 20000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Corona", amountCents: 60000, currency: "PEN", branchId }),
  )
  const second = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 40000 }],
      requestId: randomUUID(),
    }),
  )
  expect(second.creditAppliedCents).toBe(20000)
  expect(second.remainingCents).toBe(0)

  const undone = await f.run((tx) =>
    voidTicket(tx, ...f.args, advance.ticket.id, { reason: "Adelanto mal registrado", allowPostClose: false }),
  )
  expect(undone.reopenedCents).toBe(20000)

  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  // Las tres cifras y el pendiente dicen lo mismo: se deben 200.
  expect(pen(summary.byCurrency)).toMatchObject({ porCobrar: 20000, pagado: 40000, aFavor: 0 })
  expect(summary.pendiente.map((row) => row.saldoCents)).toEqual([20000])
  const state = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  expect(state.cashOnHandCents).toBe(40000)

  // Y se puede volver a cobrar lo que quedó.
  const again = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 20000 }],
      requestId: randomUUID(),
    }),
  )
  expect(again.remainingCents).toBe(0)
})

it("lo que sale por un medio que no es efectivo no toca el efectivo de la caja", async () => {
  const f = await clinicalFixture()
  const { branchId, cash, wallet } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Resina", amountCents: 30000, currency: "PEN", branchId }),
  )
  const paid = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: wallet.id, amountCents: 30000, reference: "OP-1" }],
      requestId: randomUUID(),
    }),
  )
  const closed = await f.run((tx) =>
    closeCashWindow(tx, "org_a", f.actor, { branchId, countedCents: 0, retainedCents: 0, deliveredCents: 0 }),
  )
  expect(closed.differenceCents).toBe(0)
  // Administración anula después del cierre: el dinero vuelve por la billetera.
  const undone = await f.run((tx) =>
    voidTicket(tx, ...f.args, paid.ticket.id, { reason: "Cobro duplicado", allowPostClose: true }),
  )
  expect(undone.compensated).toBe(true)
  const state = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  expect(state.cashOnHandCents).toBe(0)

  // Devolver un saldo a favor por la billetera tampoco exige ni resta efectivo.
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 8000,
      payments: [{ paymentMethodId: wallet.id, amountCents: 8000, reference: "OP-2" }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    refundCredit(tx, ...f.args, { branchId, amountCents: 8000, paymentMethodId: wallet.id, reason: "No se atendió" }),
  )
  const afterRefund = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  expect(afterRefund.cashOnHandCents).toBe(0)

  // En efectivo sí exige que haya con qué devolver.
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 5000,
      payments: [{ paymentMethodId: wallet.id, amountCents: 5000, reference: "OP-3" }],
      requestId: randomUUID(),
    }),
  )
  await expect(
    f.run((tx) =>
      refundCredit(tx, ...f.args, { branchId, amountCents: 5000, paymentMethodId: cash.id, reason: "Pide efectivo" }),
    ),
  ).rejects.toMatchObject({ code: "INSUFFICIENT_CASH" })
})

it("repetir el cierre devuelve el mismo cierre y no abre otro con diferencia", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Limpieza", amountCents: 43000, currency: "PEN", branchId }),
  )
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 43000 }],
      requestId: randomUUID(),
    }),
  )
  const seen = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  expect(seen.shiftId).toBeTruthy()
  const input = { branchId, shiftId: seen.shiftId, countedCents: 43000, retainedCents: 20000, deliveredCents: 23000 }
  const first = await f.run((tx) => closeCashWindow(tx, "org_a", f.actor, input))
  const repeated = await f.run((tx) => closeCashWindow(tx, "org_a", f.actor, input))
  expect(repeated.id).toBe(first.id)
  expect(repeated.differenceCents).toBe(0)
  const closures = await f.run((tx) => listClosures(tx, "org_a", { branchId }))
  expect(closures).toHaveLength(1)

  // Quien afirma que no había caja y ya nació una debe volver a contar.
  await expect(
    f.run((tx) =>
      closeCashWindow(tx, "org_a", f.actor, {
        branchId,
        shiftId: null,
        countedCents: 43000,
        retainedCents: 20000,
        deliveredCents: 23000,
      }),
    ),
  ).rejects.toMatchObject({ code: "CASH_WINDOW_CHANGED" })
  // La ventana nueva abrió con lo que quedó, sin contarlo como cobro.
  const next = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  expect(next.cashOnHandCents).toBe(20000)
  expect(next.tickets).toBe(0)
})

it("lo que se debe sin sede aparece en la caja de cualquier sede; lo de otra sede, no", async () => {
  const f = await clinicalFixture()
  const here = await newBranch()
  const other = await newBranch()
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Endodoncia", amountCents: 60000, currency: "PEN" }),
  )
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Radiografía", amountCents: 8000, currency: "PEN", branchId: here }),
  )
  const mine = (rows: Awaited<ReturnType<typeof getDebts>>) =>
    rows.filter((row) => row.patientId === f.patient.id)
  const inHere = mine(await f.run((tx) => getDebts(tx, "org_a", { branchId: here })))
  // Una sola fila por persona, con todo lo que debe cobrarse aquí.
  expect(inHere).toHaveLength(1)
  expect(inHere[0]).toMatchObject({ totalCents: 68000, chargesCount: 2, branchId: here })
  const inOther = mine(await f.run((tx) => getDebts(tx, "org_a", { branchId: other })))
  expect(inOther).toHaveLength(1)
  expect(inOther[0]).toMatchObject({ totalCents: 60000, chargesCount: 1 })
})

it("el mismo concepto repetido se cobra una vez y siempre lo más antiguo primero", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  const old = await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Consulta", amountCents: 10000, currency: "PEN", branchId }),
  )
  const recent = await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Profilaxis", amountCents: 12000, currency: "PEN", branchId }),
  )
  // Repetido y pedido al revés: paga 100 de 220.
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      chargeIds: [recent.id, old.id, recent.id],
      payments: [{ paymentMethodId: cash.id, amountCents: 10000 }],
      requestId: randomUUID(),
    }),
  )
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(pen(summary.byCurrency)).toMatchObject({ porCobrar: 12000, pagado: 10000, aFavor: 0 })
  // Quedó pendiente el más nuevo, entero.
  expect(summary.pendiente).toHaveLength(1)
  expect(summary.pendiente[0]).toMatchObject({ chargeId: recent.id, saldoCents: 12000 })
})

it("el movimiento de un cobro no se anula suelto; un retiro a mano sí", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Profilaxis", amountCents: 12000, currency: "PEN", branchId }),
  )
  const paid = await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 12000 }],
      requestId: randomUUID(),
    }),
  )
  const [movement] = await ownerDb
    .select()
    .from(cashMovement)
    .where(and(eq(cashMovement.organizationId, "org_a"), eq(cashMovement.patientPaymentId, paid.payments[0]!.id)))
  await expect(
    f.run((tx) => voidMovement(tx, "org_a", f.actor, movement!.id, { reason: "Por error" })),
  ).rejects.toMatchObject({ code: "MOVEMENT_NOT_MANUAL" })
  expect((await f.run((tx) => getCashState(tx, "org_a", { branchId }))).cashOnHandCents).toBe(12000)

  const withdrawal = await f.run((tx) =>
    addCashMovement(tx, "org_a", f.actor, { branchId, kind: "retiro", amountCents: 5000, concept: "Depósito al banco" }),
  )
  expect((await f.run((tx) => getCashState(tx, "org_a", { branchId }))).cashOnHandCents).toBe(7000)
  await f.run((tx) => voidMovement(tx, "org_a", f.actor, withdrawal.id, { reason: "No se llevó" }))
  expect((await f.run((tx) => getCashState(tx, "org_a", { branchId }))).cashOnHandCents).toBe(12000)
})

it("una sede nueva recibe su fondo inicial sin haber cobrado antes", async () => {
  const f = await clinicalFixture()
  const branchId = await newBranch()
  expect((await f.run((tx) => getCashState(tx, "org_a", { branchId }))).shiftId).toBeNull()
  await f.run((tx) =>
    addCashMovement(tx, "org_a", f.actor, { branchId, kind: "aporte", amountCents: 20000, concept: "Fondo inicial" }),
  )
  const state = await f.run((tx) => getCashState(tx, "org_a", { branchId }))
  expect(state.shiftId).toBeTruthy()
  expect(state.cashOnHandCents).toBe(20000)
  // No hay más efectivo del que entró.
  await expect(
    f.run((tx) =>
      addCashMovement(tx, "org_a", f.actor, { branchId, kind: "retiro", amountCents: 20001, concept: "De más" }),
    ),
  ).rejects.toMatchObject({ code: "INSUFFICIENT_CASH" })
})

it("el reintento de un cobro devuelve lo mismo que el original", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Corona", amountCents: 50000, currency: "PEN", branchId }),
  )
  const input = {
    branchId,
    payments: [{ paymentMethodId: cash.id, amountCents: 20000 }],
    requestId: randomUUID(),
  }
  const original = await f.run((tx) => collectCharge(tx, ...f.args, input))
  const retry = await f.run((tx) => collectCharge(tx, ...f.args, input))
  expect(retry.duplicate).toBe(true)
  expect(retry.ticket.id).toBe(original.ticket.id)
  expect(retry.payments.map((payment) => payment.id)).toEqual(original.payments.map((payment) => payment.id))
  expect(retry.remainingCents).toBe(original.remainingCents)
  expect(retry.remainingCents).toBe(30000)
  expect(retry.creditAppliedCents).toBe(original.creditAppliedCents)
})

it("un cobro pagado solo con saldo a favor también lo anula administración después del cierre", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      advanceCents: 10000,
      payments: [{ paymentMethodId: cash.id, amountCents: 10000 }],
      requestId: randomUUID(),
    }),
  )
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Control", amountCents: 10000, currency: "PEN", branchId }),
  )
  const onlyCredit = await f.run((tx) =>
    collectCharge(tx, ...f.args, { branchId, requestId: randomUUID() }),
  )
  expect(onlyCredit.payments).toHaveLength(0)
  await f.run((tx) =>
    closeCashWindow(tx, "org_a", f.actor, { branchId, countedCents: 10000, retainedCents: 0, deliveredCents: 10000 }),
  )
  await expect(
    f.run((tx) => voidTicket(tx, ...f.args, onlyCredit.ticket.id, { reason: "Tarde", allowPostClose: false })),
  ).rejects.toMatchObject({ code: "POST_CLOSE_NEEDS_ADMIN" })
  const undone = await f.run((tx) =>
    voidTicket(tx, ...f.args, onlyCredit.ticket.id, { reason: "Autoriza administración", allowPostClose: true }),
  )
  expect(undone.ticket.voidedAt).toBeTruthy()
  const summary = await f.run((tx) => getAccountSummary(tx, "org_a", f.patient.id))
  expect(pen(summary.byCurrency)).toMatchObject({ porCobrar: 10000, aFavor: 10000 })
})

it("la diferencia del cierre avisa al dueño y a quien administra, con el importe de la clínica", async () => {
  const f = await clinicalFixture()
  const { branchId, cash } = await seedCashbox(f)
  const people: Record<string, string> = {}
  for (const role of ["owner", "admin", "cashier"]) {
    const id = randomUUID()
    people[role] = id
    await ownerDb.insert(user).values({ id, name: role, email: `${id}@example.test` })
    await ownerDb.insert(member).values({
      id: randomUUID(),
      organizationId: "org_a",
      userId: id,
      role,
      createdAt: new Date(),
    })
  }
  await f.run((tx) =>
    createCharge(tx, ...f.args, { description: "Control", amountCents: 15000, currency: "PEN", branchId }),
  )
  await f.run((tx) =>
    collectCharge(tx, ...f.args, {
      branchId,
      payments: [{ paymentMethodId: cash.id, amountCents: 15000 }],
      requestId: randomUUID(),
    }),
  )
  const closed = await f.run((tx) =>
    closeCashWindow(tx, "org_a", f.actor, { branchId, countedCents: 14500, retainedCents: 4500, deliveredCents: 10000 }),
  )
  expect(closed.differenceCents).toBe(-500)
  const notices = await ownerDb
    .select()
    .from(workspaceNotification)
    .where(eq(workspaceNotification.dedupeKey, `cash-shift-diff:${closed.id}`))
  const recipients = notices.map((notice) => notice.userId)
  expect(recipients).toContain(people["owner"])
  expect(recipients).toContain(people["admin"])
  expect(recipients).not.toContain(people["cashier"])
  // Importe con el formato de la clínica; nunca la unidad menor cruda.
  expect(notices[0]!.body).toMatch(/faltaron/)
  expect(notices[0]!.body).toMatch(/5[.,]00/)
  // El nombre de la sede de prueba lleva un identificador aleatorio: se mira solo el importe.
  expect(notices[0]!.body).not.toMatch(/centavos|faltaron\D*500/)
})
