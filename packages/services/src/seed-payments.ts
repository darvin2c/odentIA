/**
 * Lo cobrado de una historia sembrada (semilla de Reportes y demos para
 * presentar, ADR 0096), como lo deja «Cobrar»: cada pago con su ticket
 * numerado, su aplicación al concepto que pagó y su movimiento en la caja de
 * su sede. Los días ya pasados se cierran con su arqueo, sin diferencia y sin
 * dejar fondo; lo de hoy queda en la caja abierta. Así Reportes, Finanzas ›
 * Cobros y la Caja cuentan los mismos cobros: un pago sin ticket se ve como
 * «pago anterior a los tickets», y uno sin caja no cuadra con los cierres.
 *
 * Se insertan directo (son del pasado: «Cobrar» fecha con la hora de ahora) y
 * no se envía nada. Sirve a cualquier producto.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import {
  patient,
  patientPayment,
  patientPaymentApplication,
  paymentTicket,
  ticketCounter,
} from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { cashClosure, cashMovement, cashShift } from "@odentia/db/schema/finance"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { organizationPaymentMethod } from "@odentia/db/schema/org-payments"
import { and, eq, inArray, sql } from "drizzle-orm"
import { orgTaxes, ticketTaxesOf } from "./clinic-taxes.js"
import { ensureOpenShift } from "./finance.js"
import type { TicketFrozen } from "./payments.js"
import { dayStart, reportDayOf } from "./report-periods.js"

/** Un pago de la historia: lo que entró por un medio para un concepto. */
export interface SeedPayment {
  patientId: string
  branchId: string
  /** El concepto que paga: el ticket dice qué se pagó y cuánto falta. */
  chargeId: string
  amountCents: number
  taxCents: number
  currency: string
  paidAt: Date
  methodName: string
  methodTypeCode: string
  /** Quien cobró. */
  createdBy: string
}

/** Lo que el ticket congela del concepto. */
export interface SeedCharge {
  description: string
  amountCents: number
  promotionName: string | null
  taxCategory: string | null
  taxBps: number | null
}

const HOUR = 3_600_000
/** El tipo UN/CEFACT 4461 del efectivo: lo único que se cuenta en el arqueo. */
const CASH = "10"

const chunks = <T>(items: T[], size = 500): T[][] => {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size))
  return out
}

/**
 * Guarda los pagos con su ticket, su aplicación y su caja. `openFrom` es el día
 * de la clínica (AAAA-MM-DD) desde el que la caja sigue abierta: lo pagado
 * antes queda en el cierre de su día, salvo que ya haya una caja abierta (la
 * de una presentación) o un cierre posterior en esa sede, y entonces entra en
 * la caja abierta, como un cobro de hoy.
 */
export async function insertSeedPayments(
  tx: Db,
  input: {
    orgId: string
    payments: readonly SeedPayment[]
    charges: ReadonlyMap<string, SeedCharge>
    openFrom: string
    /** Quien abre y cierra la caja (recepción). */
    cashierUserId: string
  },
): Promise<void> {
  const { orgId } = input
  if (input.payments.length === 0) return
  const [profile] = await tx
    .select()
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  if (!profile) throw new Error("Falta el perfil de la clínica")
  const timezone = profile.timezone
  // En orden de cobro: los números de ticket van con el tiempo, sin saltos.
  const sorted = [...input.payments].sort(
    (a, b) => a.paidAt.getTime() - b.paidAt.getTime() || a.chargeId.localeCompare(b.chargeId),
  )
  await tx
    .insert(ticketCounter)
    .values({ organizationId: orgId, nextNumber: 1 })
    .onConflictDoNothing()
  const [counter] = await tx
    .update(ticketCounter)
    .set({ nextNumber: sql`${ticketCounter.nextNumber} + ${sorted.length}` })
    .where(eq(ticketCounter.organizationId, orgId))
    .returning({ next: ticketCounter.nextNumber })
  const firstNumber = (counter?.next ?? sorted.length + 1) - sorted.length

  const branches = new Map(
    (
      await tx
        .select({ id: branch.id, name: branch.name })
        .from(branch)
        .where(eq(branch.organizationId, orgId))
    ).map((row) => [row.id, row.name]),
  )
  const methods = new Map(
    (
      await tx
        .select({ id: organizationPaymentMethod.id, name: organizationPaymentMethod.name })
        .from(organizationPaymentMethod)
        .where(eq(organizationPaymentMethod.organizationId, orgId))
    ).map((row) => [row.name, row.id]),
  )
  const issuers = new Map(
    (
      await tx
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(inArray(user.id, [...new Set(sorted.map((item) => item.createdBy))]))
    ).map((row) => [row.id, row.name]),
  )
  const people = new Map<
    string,
    { displayName: string; docType: string | null; docNumber: string | null }
  >()
  for (const ids of chunks([...new Set(sorted.map((item) => item.patientId))], 1000)) {
    const rows = await tx
      .select({
        id: patient.id,
        displayName: contact.displayName,
        docType: contact.docType,
        docNumber: contact.docNumber,
      })
      .from(patient)
      .innerJoin(
        contact,
        and(eq(contact.organizationId, patient.organizationId), eq(contact.id, patient.personId)),
      )
      .where(and(eq(patient.organizationId, orgId), inArray(patient.id, ids)))
    for (const row of rows) people.set(row.id, row)
  }
  const taxes = await orgTaxes(tx, orgId)

  const tickets: Array<typeof paymentTicket.$inferInsert> = []
  const payments: Array<typeof patientPayment.$inferInsert & { id: string }> = []
  const applications: Array<typeof patientPaymentApplication.$inferInsert> = []
  const entries: Array<{ item: SeedPayment; paymentId: string; number: number }> = []
  const paidOf = new Map<string, number>()
  for (const [index, item] of sorted.entries()) {
    const ticketId = randomUUID()
    const paymentId = randomUUID()
    const number = firstNumber + index
    const charge = input.charges.get(item.chargeId) ?? {
      description: "Atención",
      amountCents: item.amountCents,
      promotionName: null,
      taxCategory: null,
      taxBps: null,
    }
    const paid = (paidOf.get(item.chargeId) ?? 0) + item.amountCents
    paidOf.set(item.chargeId, paid)
    const remaining = Math.max(0, charge.amountCents - paid)
    const person = people.get(item.patientId)
    const methodId = methods.get(item.methodName) ?? null
    tickets.push({
      id: ticketId,
      organizationId: orgId,
      patientId: item.patientId,
      branchId: item.branchId,
      ticketNumber: number,
      currency: item.currency,
      totalCents: item.amountCents,
      creditAppliedCents: 0,
      snapshot: {
        request: `semilla:${ticketId}`,
        patient: {
          id: item.patientId,
          displayName: person?.displayName ?? "",
          docType: person?.docType ?? null,
          docNumber: person?.docNumber ?? null,
        },
        payer: null,
        issuer: { userId: item.createdBy, name: issuers.get(item.createdBy) ?? "" },
        clinic: {
          legalName: profile.legalName ?? "",
          tradeName: profile.tradeName ?? null,
          fiscalDocType: profile.fiscalDocType ?? null,
          fiscalDocNumber: profile.fiscalDocNumber ?? null,
          fiscalAddress: profile.fiscalAddress ?? null,
          locale: profile.locale,
          currency: profile.currency,
          timezone,
        },
        branch: { id: item.branchId, name: branches.get(item.branchId) ?? "" },
        lines: [
          {
            chargeId: item.chargeId,
            description: charge.description,
            amountCents: charge.amountCents,
            appliedCents: item.amountCents,
            promotion: charge.promotionName,
          },
        ],
        methods: [
          {
            paymentMethodId: methodId ?? "",
            name: item.methodName,
            typeCode: item.methodTypeCode,
            amountCents: item.amountCents,
            reference: null,
          },
        ],
        notice: profile.ticketFooter,
        remainingCents: remaining,
        pending:
          remaining > 0
            ? [
                {
                  chargeId: item.chargeId,
                  description: charge.description,
                  amountCents: charge.amountCents,
                  remainingCents: remaining,
                },
              ]
            : [],
        taxes: ticketTaxesOf(
          taxes,
          [
            {
              amountCents: item.amountCents,
              taxCategory: charge.taxCategory,
              taxBps: charge.taxBps,
              scope: "servicios",
            },
          ],
          profile.locale,
        ),
      } satisfies TicketFrozen,
      createdBy: item.createdBy,
      createdAt: item.paidAt,
    })
    payments.push({
      id: paymentId,
      organizationId: orgId,
      patientId: item.patientId,
      ticketId,
      branchId: item.branchId,
      paymentMethodId: methodId,
      methodName: item.methodName,
      methodTypeCode: item.methodTypeCode,
      amountCents: item.amountCents,
      taxCents: item.taxCents,
      currency: item.currency,
      paidAt: item.paidAt,
      createdBy: item.createdBy,
      createdAt: item.paidAt,
    })
    applications.push({
      organizationId: orgId,
      patientId: item.patientId,
      paymentId,
      chargeId: item.chargeId,
      ticketId,
      amountCents: item.amountCents,
      createdBy: item.createdBy,
      createdAt: item.paidAt,
    })
    entries.push({ item, paymentId, number })
  }
  for (const batch of chunks(tickets)) await tx.insert(paymentTicket).values(batch)
  for (const batch of chunks(payments)) await tx.insert(patientPayment).values(batch)
  for (const batch of chunks(applications)) await tx.insert(patientPaymentApplication).values(batch)

  // --- La caja de cada sede y moneda, día por día ---------------------------------------------
  const keyOf = (branchId: string, currency: string) => `${branchId}|${currency}`
  // Las ventanas que ya tiene cada caja (la abierta llega hasta hoy): un día cerrado no se
  // superpone con ninguna.
  const windows = new Map<string, Array<[number, number]>>()
  for (const row of await tx
    .select({
      branchId: cashShift.branchId,
      currency: cashShift.currency,
      openedAt: cashShift.openedAt,
      closedAt: cashShift.closedAt,
    })
    .from(cashShift)
    .where(eq(cashShift.organizationId, orgId))) {
    const box = keyOf(row.branchId, row.currency)
    windows.set(box, [
      ...(windows.get(box) ?? []),
      [row.openedAt.getTime(), row.closedAt?.getTime() ?? Number.POSITIVE_INFINITY],
    ])
  }
  const days = new Map<string, Array<(typeof entries)[number]>>()
  for (const entry of entries) {
    const key = `${keyOf(entry.item.branchId, entry.item.currency)}|${reportDayOf(timezone, entry.item.paidAt)}`
    const list = days.get(key)
    if (list) list.push(entry)
    else days.set(key, [entry])
  }
  const movement = (
    shiftId: string,
    entry: (typeof entries)[number],
  ): typeof cashMovement.$inferInsert => ({
    organizationId: orgId,
    shiftId,
    direction: "ingreso",
    kind: "cobro",
    amountCents: entry.item.amountCents,
    currency: entry.item.currency,
    method: entry.item.methodName.slice(0, 60),
    methodTypeCode: entry.item.methodTypeCode,
    concept: `Ticket ${entry.number}`,
    patientPaymentId: entry.paymentId,
    createdBy: entry.item.createdBy,
    createdAt: entry.item.paidAt,
  })
  const shifts: Array<typeof cashShift.$inferInsert> = []
  const closures: Array<typeof cashClosure.$inferInsert> = []
  const moves: Array<typeof cashMovement.$inferInsert> = []
  for (const [key, list] of days) {
    const [branchId, currency, day] = key.split("|") as [string, string, string]
    const box = keyOf(branchId, currency)
    const [year, month, date] = day.split("-").map(Number) as [number, number, number]
    const start = dayStart(timezone, year, month, date).getTime()
    const firstAt = (list[0] as (typeof entries)[number]).item.paidAt.getTime()
    const lastAt = (list[list.length - 1] as (typeof entries)[number]).item.paidAt.getTime()
    const openedAt = Math.min(start + 8 * HOUR, firstAt - 15 * 60_000)
    const closedAt = Math.max(start + 19 * HOUR, lastAt + 30 * 60_000)
    const taken = windows.get(box) ?? []
    const closable = day < input.openFrom && !taken.some(([from, to]) => openedAt < to && from < closedAt)
    if (!closable) {
      // Hoy, o un día que ya cubre una caja (la abierta de una presentación): entra en la abierta.
      const shift = await ensureOpenShift(tx, orgId, input.cashierUserId, branchId, currency)
      if (!taken.some(([from]) => from === shift.openedAt.getTime()))
        windows.set(box, [...taken, [shift.openedAt.getTime(), Number.POSITIVE_INFINITY]])
      moves.push(...list.map((entry) => movement(shift.id, entry)))
      continue
    }
    windows.set(box, [...taken, [openedAt, closedAt]])
    const shiftId = randomUUID()
    const cash = list.filter((entry) => entry.item.methodTypeCode === CASH)
    const cashCents = cash.reduce((sum, entry) => sum + entry.item.amountCents, 0)
    const electronic = new Map<
      string,
      {
        name: string
        typeCode: string | null
        count: number
        amountCents: number
        refundedCents: number
      }
    >()
    for (const entry of list) {
      if (entry.item.methodTypeCode === CASH) continue
      const total = electronic.get(entry.item.methodName) ?? {
        name: entry.item.methodName,
        typeCode: entry.item.methodTypeCode,
        count: 0,
        amountCents: 0,
        refundedCents: 0,
      }
      total.count += 1
      total.amountCents += entry.item.amountCents
      electronic.set(entry.item.methodName, total)
    }
    const electronicCents = [...electronic.values()].reduce(
      (sum, total) => sum + total.amountCents,
      0,
    )
    // Se cuenta lo que debe haber y se entrega todo: la caja no deja fondo para el día siguiente.
    shifts.push({
      id: shiftId,
      organizationId: orgId,
      branchId,
      currency,
      openingCents: 0,
      status: "cerrada",
      openedBy: input.cashierUserId,
      openedAt: new Date(openedAt),
      closedBy: input.cashierUserId,
      closedAt: new Date(closedAt),
      expectedCents: cashCents,
      electronicCents,
      countedCents: cashCents,
      differenceCents: 0,
      retainedCents: 0,
      deliveredCents: cashCents,
    })
    closures.push({
      organizationId: orgId,
      branchId,
      currency,
      shiftId,
      windowFrom: new Date(openedAt),
      windowTo: new Date(closedAt),
      cashCollectedCents: cashCents,
      expectedCents: cashCents,
      countedCents: cashCents,
      differenceCents: 0,
      retainedCents: 0,
      deliveredCents: cashCents,
      totalsByMethod: [...electronic.values()],
      closedBy: input.cashierUserId,
      closedAt: new Date(closedAt),
    })
    moves.push(...list.map((entry) => movement(shiftId, entry)))
  }
  for (const batch of chunks(shifts)) await tx.insert(cashShift).values(batch)
  for (const batch of chunks(moves)) await tx.insert(cashMovement).values(batch)
  for (const batch of chunks(closures)) await tx.insert(cashClosure).values(batch)
}
