/**
 * Venta de mostrador (ADR 0172): productos del inventario que se cobran sin
 * ficha —unos lentes de sol, unas gotas, un cepillo—, a un contacto elegido, a
 * un nombre escrito o a nadie. No abre una historia ni toca la cuenta de nadie.
 *
 * No tiene reglas de dinero propias: el precio, el impuesto y la salida del
 * almacén son los de «Cobrar» (`productSaleOf`, `chargeTaxOf`, `sellFromStock`)
 * y el cobro usa lo mismo que `collectCharge` (medios, moneda en que entra,
 * cambio, vuelto, ticket numerado en la misma serie y la caja de la sede). Lo
 * único distinto: se paga entero en el momento, sin saldo a favor ni deuda; lo
 * único que sobra es el vuelto del efectivo.
 */
import { collectExchange } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import {
  patientCharge,
  patientPayment,
  patientPaymentApplication,
  paymentTicket,
} from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { chargeTaxOf, orgTaxes, splitTaxAcrossPayments, ticketTaxesOf } from "./clinic-taxes.js"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { lockOrgMoney, requireBranch } from "./finance.js"
import { buildTicketSnapshot, renderReturnPdf, renderTicketPdf } from "./financial-document-pdf.js"
import { assertPersonVisible, type PersonCan } from "./people.js"
import { findOrgLocale, formatOrgMoney, orgProfileRequired } from "./locale.js"
import {
  assertPositiveCents,
  type CollectMethodInput,
  cashChangeOf,
  collectMethodsOf,
  collectRate,
  getPaymentReturn,
  insertTicketPayments,
  nextTicketNumber,
  productSaleOf,
  recordTicketCash,
  sellFromStock,
  splitTenderOf,
  type TicketFrozen,
  tenderTermsOf,
  ticketClinicOf,
} from "./payments.js"
import { COUNTER_SALE_LABEL } from "./ticket-party.js"

/** Cuántos productos distintos lleva una venta de mostrador, como mucho. */
export const COUNTER_SALE_MAX_LINES = 30

export interface CounterSaleLineInput {
  productId: string
  /** Unidades de uso (1 por defecto). */
  quantity?: number
}

/** Para quién: un contacto (cualquiera, no solo pacientes), un nombre escrito o nadie. */
export type CounterSaleBuyer = { contactId: string } | { name: string } | null

export interface CounterSaleInput {
  branchId: string
  /** Clave del formulario: el reintento devuelve el mismo ticket; otro contenido con ella es un conflicto. */
  requestId: string
  lines: CounterSaleLineInput[]
  buyer?: CounterSaleBuyer
  /** Medios del cobro: entre todos pagan el total exacto. */
  payments: CollectMethodInput[]
  /** Solo con un medio en efectivo: lo recibido; el vuelto es recibido − parte en efectivo. */
  cashReceivedCents?: number
  /** Dos monedas (ADR 0135): en qué entra el dinero, el cambio de este cobro y en qué se da el vuelto. */
  tenderCurrency?: string
  exchangeRate?: string
  changeCurrency?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function sumOf(values: number[]): number {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) throw invalidField("lines", "El total excede el rango exacto admitido")
  }
  return total
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  entity: string,
  entityId: string,
  action: string,
  metadata?: Record<string, unknown>,
) {
  await tx
    .insert(auditEvent)
    .values({ organizationId: orgId, actorUserId, entity, entityId, action, ...(metadata ? { metadata } : {}) })
}

/** Quién compró, como lo pide el cuerpo: sin nombre escrito es nadie. */
function buyerOf(input: CounterSaleBuyer | undefined): { contactId: string } | { name: string } | null {
  if (!input) return null
  if ("contactId" in input) {
    if (typeof input.contactId !== "string" || !UUID.test(input.contactId))
      throw invalidField("contactId", "Elige a la persona de la lista")
    return { contactId: input.contactId.toLowerCase() }
  }
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : ""
  if (!name) return null
  if (name.length > 200) throw invalidField("buyerName", "Escribe el nombre en 200 caracteres como mucho")
  return { name }
}

/**
 * Vende en el mostrador en una sola transacción: un concepto por producto (sale
 * de la sede al venderse), el ticket numerado con lo que congela, un pago por
 * medio aplicado a esos conceptos y la caja de la sede. Todo o nada.
 * Idempotente por `requestId`, en el mismo orden que un cobro con esa clave.
 * `can` es lo que puede quien vende: quien solo ve pacientes (Caja) solo elige
 * a un paciente como quien compra, igual que en «Personas».
 */
export async function sellAtCounter(tx: Db, orgId: string, actorUserId: string, input: CounterSaleInput, can: PersonCan) {
  if (typeof input.requestId !== "string" || !UUID.test(input.requestId))
    throw invalidField("requestId", "No se pudo identificar esta venta: cierra la venta y vuelve a abrirla")
  const requestId = input.requestId.toLowerCase()
  // La misma clave que un cobro: un ticket por clave, sea de una ficha o del mostrador.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('collect:' || ${orgId} || ':' || ${requestId}))`)
  const money = await lockOrgMoney(tx, orgId)
  // Sin respaldo de un país: la moneda sale del perfil o no hay cobro.
  if (!money) throw orgProfileRequired()
  const { currency: business, secondCurrency: second } = money
  const rateText = collectRate(input.exchangeRate)
  const buyer = buyerOf(input.buyer)
  const lines = Array.isArray(input.lines) ? input.lines : []
  const fingerprint = JSON.stringify({
    counterSale: true,
    branchId: input.branchId,
    lines: lines.map((line) => ({ productId: line.productId, quantity: line.quantity ?? 1 })),
    buyer,
    payments: (input.payments ?? []).map((p) => ({
      paymentMethodId: p.paymentMethodId,
      amountCents: p.amountCents,
      reference: p.reference?.trim() || null,
    })),
    cashReceivedCents: input.cashReceivedCents ?? null,
    ...(input.tenderCurrency !== undefined ? { tenderCurrency: input.tenderCurrency } : {}),
    ...(rateText !== undefined ? { exchangeRate: rateText } : {}),
    ...(input.changeCurrency !== undefined ? { changeCurrency: input.changeCurrency } : {}),
  })
  const [replay] = await tx
    .select()
    .from(paymentTicket)
    .where(and(eq(paymentTicket.organizationId, orgId), eq(paymentTicket.requestId, requestId)))
  if (replay) {
    // El mismo formulario otra vez (un corte de red, un doble clic): el mismo ticket, sin registrar nada.
    // Dice cuál es: quizá se cobró y no llegó la respuesta. Lo que sigue (revisarlo o cobrar otra) lo decide quien cobra.
    if (replay.patientId !== null || (replay.snapshot as TicketFrozen | null)?.request !== fingerprint)
      throw new ServiceError(
        "REQUEST_ID_CONFLICT",
        409,
        `Esta venta ya se cobró con otros datos, en el ticket ${String(replay.ticketNumber).padStart(6, "0")}. Revísalo en Cobros; si es otra venta, vuelve a cobrarla.`,
      )
    const payments = await tx
      .select()
      .from(patientPayment)
      .where(
        and(
          eq(patientPayment.organizationId, orgId),
          isNull(patientPayment.patientId),
          eq(patientPayment.ticketId, replay.id),
        ),
      )
      .orderBy(asc(patientPayment.createdAt), asc(patientPayment.id))
    return { ticket: replay, payments, duplicate: true as const }
  }

  const branchRow = await requireBranch(tx, orgId, input.branchId)
  if (lines.length === 0 || lines.length > COUNTER_SALE_MAX_LINES)
    throw invalidField("lines", `Agrega lo que se vende (hasta ${COUNTER_SALE_MAX_LINES} productos)`)
  const seen = new Set<string>()
  const priced = []
  for (const [index, line] of lines.entries()) {
    const at = `lines[${index}].`
    if (typeof line.productId !== "string" || !UUID.test(line.productId))
      throw invalidField(`${at}productId`, "Elige el producto de la lista")
    if (seen.has(line.productId.toLowerCase()))
      throw invalidField(`${at}productId`, "Ese producto ya está en la venta: cambia su cantidad")
    seen.add(line.productId.toLowerCase())
    priced.push(await productSaleOf(tx, orgId, { productId: line.productId, quantity: line.quantity, branchId: branchRow.id }, at))
  }
  // Un cobro cancela una sola moneda: lo que tiene otro precio se vende aparte.
  const unit = priced[0]!.currency
  const orgCurrencies = second ? [business, second] : [business]
  const other = priced.findIndex((item) => item.currency !== unit)
  if (other >= 0)
    throw invalidField(`lines[${other}].productId`, "Su precio está en otra moneda: véndelo por separado")
  if (!orgCurrencies.includes(unit))
    throw invalidField("lines[0].productId", `Su precio está en ${unit}, que la clínica no cobra`)
  const total = sumOf(priced.map((item) => item.amountCents))

  let buyerFrozen: { contactId: string | null; displayName: string } | null = null
  if (buyer && "contactId" in buyer) {
    const [person] = await tx
      .select({ id: contact.id, displayName: contact.displayName, isActive: contact.isActive })
      .from(contact)
      .where(and(eq(contact.organizationId, orgId), eq(contact.id, buyer.contactId)))
      .limit(1)
    // Una persona archivada no se elige: para la venta, no existe. La historia bloqueada
    // siempre está archivada (`contact_record_lock_check`), así que tampoco.
    if (!person || !person.isActive)
      throw new ServiceError("NOT_FOUND", 404, "Contacto no encontrado", { contactId: "Contacto no encontrado" })
    await assertPersonVisible(tx, orgId, person.id, can)
    buyerFrozen = { contactId: person.id, displayName: person.displayName }
  } else if (buyer) buyerFrozen = { contactId: null, displayName: buyer.name }

  const methods = await collectMethodsOf(tx, orgId, input.payments ?? [])
  if (!methods.length) throw invalidField("payments", "Elige con qué paga")
  const { paidIn, rate, changeIn } = tenderTermsOf({
    hasMethods: true,
    unit,
    business,
    orgCurrencies,
    tenderCurrency: input.tenderCurrency,
    rateText,
    changeCurrency: input.changeCurrency,
  })
  const { cashReceived, change } = cashChangeOf(methods, input.cashReceivedCents)
  const tenders = methods.map((m) => m.amountCents)
  const totalNew = sumOf(tenders)
  const figures = collectExchange({
    paidCents: totalNew,
    paidCurrency: paidIn,
    dueCents: total,
    currency: unit,
    businessCurrency: business,
    rate,
    changeCents: change,
    changeIn,
  })
  const cancels = figures.cancels ?? totalNew
  // Se paga entero: sin ficha no hay cuenta donde quede lo que falta ni lo que sobra.
  if (cancels !== total) {
    const locale = await findOrgLocale(tx, orgId)
    const gap = formatOrgMoney(Math.abs(total - cancels), unit, locale)
    const message =
      cancels < total
        ? `Falta cobrar ${gap}: una venta de mostrador se paga entera.`
        : `Lo que paga pasa del total por ${gap}. Si da más en efectivo, escribe lo recibido y se le da el vuelto.`
    throw new ServiceError(cancels < total ? "COUNTER_SALE_SHORT" : "COUNTER_SALE_OVER", 409, message, { payments: message })
  }
  const { amounts, values } = splitTenderOf({ cancels, tenders, paidIn, unit, business, valueCents: figures.valueCents })

  // Los conceptos: salen de la sede al venderse, con el impuesto de productos de hoy.
  const taxes = await orgTaxes(tx, orgId)
  const tax = chargeTaxOf(taxes, true)
  const soldTo = buyerFrozen ? `${COUNTER_SALE_LABEL} a ${buyerFrozen.displayName}` : COUNTER_SALE_LABEL
  const charges: Array<typeof patientCharge.$inferSelect> = []
  for (const [index, item] of priced.entries()) {
    const [row] = await tx
      .insert(patientCharge)
      .values({
        organizationId: orgId,
        patientId: null,
        branchId: item.branchId,
        description: item.description,
        amountCents: assertPositiveCents(item.amountCents),
        currency: item.currency,
        productId: item.productId,
        productQuantity: item.quantity,
        requestKey: `${requestId}:${index}`,
        taxCategory: tax?.taxCategory ?? null,
        taxBps: tax?.taxBps ?? null,
        createdBy: actorUserId,
      })
      .returning()
    await sellFromStock(tx, orgId, actorUserId, { chargeId: row!.id, sale: item, patientId: null, reason: soldTo })
    await audit(tx, orgId, actorUserId, "patient_charge", row!.id, "charge.created", {
      counterSale: true,
      productId: item.productId,
      quantity: item.quantity,
    })
    charges.push(row!)
  }

  const ticketNumber = await nextTicketNumber(tx, orgId)
  const [issuer] = await tx.select({ name: user.name }).from(user).where(eq(user.id, actorUserId))
  const [profile] = await tx.select().from(orgProfile).where(eq(orgProfile.organizationId, orgId))
  if (!profile) throw orgProfileRequired()
  const ticketTaxes = ticketTaxesOf(
    taxes,
    charges.map((charge) => ({
      amountCents: charge.amountCents,
      taxCategory: charge.taxCategory,
      taxBps: charge.taxBps,
      scope: "productos" as const,
    })),
    profile.locale,
  )
  const paymentTaxes = splitTaxAcrossPayments(ticketTaxes?.taxCents ?? 0, amounts)
  const { crossChange, changeGiven } = figures
  const paidAt = new Date()
  const [ticket] = await tx
    .insert(paymentTicket)
    .values({
      organizationId: orgId,
      patientId: null,
      buyerContactId: buyerFrozen?.contactId ?? null,
      buyerName: buyerFrozen && buyerFrozen.contactId === null ? buyerFrozen.displayName : null,
      branchId: branchRow.id,
      ticketNumber,
      currency: unit,
      totalCents: cancels,
      creditAppliedCents: 0,
      cashReceivedCents: cashReceived,
      changeCents: changeGiven,
      changeCurrency: crossChange !== null ? changeIn : null,
      payerContactId: null,
      requestId,
      snapshot: {
        request: fingerprint,
        patient: null,
        buyer: buyerFrozen,
        payer: null,
        issuer: { userId: actorUserId, name: issuer?.name ?? "" },
        clinic: ticketClinicOf(profile),
        branch: { id: branchRow.id, name: branchRow.name },
        lines: charges.map((charge) => ({
          chargeId: charge.id,
          description: charge.description,
          amountCents: charge.amountCents,
          appliedCents: charge.amountCents,
          promotion: null,
        })),
        methods: methods.map((m, index) => ({
          paymentMethodId: m.paymentMethodId,
          name: m.name,
          typeCode: m.typeCode,
          amountCents: amounts[index] ?? 0,
          ...(paidIn !== unit ? { tenderCents: m.amountCents } : {}),
          reference: m.reference,
        })),
        notice: profile.ticketFooter,
        ...(rate !== null && (paidIn !== unit || crossChange !== null)
          ? {
              tender: {
                currency: paidIn,
                amountCents: totalNew,
                rate,
                businessCurrency: business,
                otherCurrency: unit === business ? paidIn : unit,
              },
            }
          : {}),
        remainingCents: 0,
        pending: [],
        taxes: ticketTaxes,
      } satisfies TicketFrozen,
      createdBy: actorUserId,
    })
    .returning()
  if (!ticket) throw new ServiceError("INTERNAL", 500, "No se pudo registrar la venta")
  const payments = await insertTicketPayments(tx, orgId, actorUserId, {
    patientId: null,
    ticketId: ticket.id,
    branchId: branchRow.id,
    payerContactId: null,
    methods,
    amounts,
    taxes: paymentTaxes,
    values,
    unit,
    paidIn,
    rate,
    paidAt,
  })
  // Cada concepto se paga entero con los medios, en orden: lo que cancela cada pago suma el total.
  const free = payments.map((payment) => payment.amountCents)
  for (const charge of charges) {
    let rest = charge.amountCents
    for (const [index, payment] of payments.entries()) {
      if (rest <= 0) break
      const take = Math.min(free[index] ?? 0, rest)
      if (take <= 0) continue
      const [app] = await tx
        .insert(patientPaymentApplication)
        .values({
          organizationId: orgId,
          patientId: null,
          paymentId: payment.id,
          chargeId: charge.id,
          ticketId: ticket.id,
          amountCents: take,
          createdBy: actorUserId,
        })
        .returning()
      await audit(tx, orgId, actorUserId, "patient_payment_application", app!.id, "payment.applied")
      free[index] = (free[index] ?? 0) - take
      rest -= take
    }
    if (rest !== 0) throw new ServiceError("INTERNAL", 500, "La venta no cuadró con lo pagado")
  }
  await recordTicketCash(tx, orgId, actorUserId, {
    branchId: branchRow.id,
    ticketNumber,
    methods,
    payments,
    tenders,
    paidIn,
    changeIn,
    crossChange,
    changeGiven,
  })
  await audit(tx, orgId, actorUserId, "payment_ticket", ticket.id, "ticket.created", { counterSale: true })
  await tx.execute(
    sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "payment.created", at: new Date().toISOString() })})`,
  )
  return { ticket, payments, duplicate: false as const }
}

/** El ticket de una venta de mostrador en PDF: la térmica de la clínica, u hoja A4 o Carta si se pide. */
export async function counterTicketPdf(
  tx: Db,
  orgId: string,
  ticketId: string,
  paper?: "A4" | "Letter" | null,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const snap = await buildTicketSnapshot(tx, orgId, null, ticketId)
  // Neutro, como el de un cobro: el nombre del archivo se ve en el teléfono.
  return { bytes: await renderTicketPdf(snap, paper ?? null), filename: `Comprobante-${snap.numberLabel}.pdf` }
}

/** Una devolución de una venta de mostrador en PDF; solo la de ese ticket. */
export async function counterReturnPdf(
  tx: Db,
  orgId: string,
  ticketId: string,
  returnId: string,
  paper?: "A4" | "Letter" | null,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const row = await getPaymentReturn(tx, orgId, null, returnId)
  if (row.ticketId !== ticketId) throw notFound("Devolución")
  const done = await renderReturnPdf(tx, orgId, null, returnId, paper ?? null)
  return { bytes: done.bytes, filename: done.filename }
}
