/**
 * Ticket, devolución y constancia de devolución (Fase 7 Finanzas), con el kit único
 * (`document-kit.ts`): se renderizan desde lo congelado al cobrar (nunca joins mutables
 * a tarifas vigentes). Un ticket anulado se imprime completo con su marca.
 *
 * - Importes con `formatMoney` según moneda y locale de lo congelado; fechas con su
 *   zona. Nada de PEN/es-PE fijos.
 * - Papel: la térmica de la clínica, u hoja A4 o Carta si se pide.
 */
import { formatMoney, ticketFooterLines, ticketUntaxedNote } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { contact } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import type { TicketTaxes } from "./clinic-taxes.js"
import { loadFrozenDocumentClinic } from "./document-clinic.js"
import {
  dayTimeWords,
  dayWords,
  DocumentKit,
  type DocumentClinic,
  shortDayTime,
  SIZE,
  ticketFormat,
} from "./document-kit.js"
import { requirePatient } from "./patients.js"
import { getPaymentReturn, getRefundReceipt, getTicketReceipt, type TicketFrozen } from "./payments.js"

export { ticketFormat } from "./document-kit.js"

/** Lo que el papel de caja suma a la clínica: la frase al pie congelada. */
export interface DocOrg extends DocumentClinic {
  currency: string
  ticketFooter: string
}

export interface TicketLine {
  description: string
  /** Lo que este cobro pagó del concepto. */
  amountCents: number
  /** Precio completo del concepto, si este cobro solo pagó una parte. */
  ofCents: number | null
  /** Promoción aplicada al concepto (snapshot; null = sin promoción). */
  promotion: string | null
}

export interface TicketMethod {
  label: string
  amountCents: number
  reference: string | null
}

export interface TicketSnapshot {
  kind: "ticket"
  sourceId: string
  /** Número único por organización (contador sin saltos). */
  numberLabel: string
  status: "vigente" | "anulado"
  voidReason: string | null
  patientName: string
  patientDoc: string | null
  payerName: string | null
  /** Quién cobró. */
  issuerName: string | null
  paidAt: Date
  currency: string
  lines: TicketLine[]
  /** Importe del adelanto, si el cobro dejó saldo a favor sin conceptos. */
  advanceCents: number | null
  methods: TicketMethod[]
  creditAppliedCents: number
  cashReceivedCents: number | null
  changeCents: number | null
  totalCents: number
  /** Lo que quedó por cobrar de esos conceptos al momento del cobro. */
  remainingCents: number | null
  /** Lo que falta pagar de cada concepto (ADR 0083); null en tickets de antes. */
  pending: Array<{ description: string; amountCents: number; remainingCents: number }> | null
  /** El impuesto de lo cobrado, congelado al cobrar (ADR 0083). */
  taxes: TicketTaxes | null
  org: DocOrg
}

/**
 * Ticket desde lo que se congeló al cobrar (`payment_ticket.snapshot`): conceptos,
 * medios, clínica, sede, frase al pie y quién cobró. Cambiar después el nombre de la
 * clínica, el medio o el concepto no reescribe lo ya emitido. El papel y el logo salen
 * del perfil actual: son de la impresora y de la marca. `documentId` es `paymentTicket.id`.
 */
export async function buildTicketSnapshot(
  tx: Db,
  orgId: string,
  patientId: string,
  documentId: string,
): Promise<TicketSnapshot> {
  const patientRow = await requirePatient(tx, orgId, patientId)
  const receipt = await getTicketReceipt(tx, orgId, patientId, documentId)
  const { ticket } = receipt
  const frozen = ticket.snapshot as TicketFrozen
  const org: DocOrg = {
    ...(await loadFrozenDocumentClinic(tx, orgId, { clinic: frozen.clinic, branch: frozen.branch ?? null })),
    currency: ticket.currency,
    ticketFooter: frozen.notice,
  }
  // Tickets anteriores a congelar pagador y documento: se leen de la ficha.
  let payerName = frozen.payer?.displayName ?? null
  if (!frozen.payer && ticket.payerContactId) {
    const [payer] = await tx
      .select({ displayName: contact.displayName })
      .from(contact)
      .where(and(eq(contact.id, ticket.payerContactId), eq(contact.organizationId, orgId)))
      .limit(1)
    payerName = payer?.displayName ?? null
  }
  const docType = frozen.patient.docType === undefined ? patientRow.docType : frozen.patient.docType
  const docNumber = frozen.patient.docNumber === undefined ? patientRow.docNumber : frozen.patient.docNumber
  const lines = frozen.lines ?? []
  const advance = lines.find((line) => line.chargeId === null) ?? null
  return {
    kind: "ticket",
    sourceId: ticket.id,
    numberLabel: String(ticket.ticketNumber).padStart(6, "0"),
    status: ticket.voidedAt ? "anulado" : "vigente",
    voidReason: ticket.voidReason ?? null,
    patientName: frozen.patient.displayName || patientRow.displayName,
    patientDoc: docNumber ? `${docType ?? "Doc."} ${docNumber}` : null,
    payerName,
    issuerName: frozen.issuer?.name || null,
    paidAt: ticket.createdAt,
    currency: ticket.currency,
    lines: lines
      .filter((line) => line.chargeId !== null)
      .map((line) => ({
        description: line.description,
        amountCents: line.appliedCents,
        ofCents: line.appliedCents < line.amountCents ? line.amountCents : null,
        promotion: line.promotion,
      })),
    advanceCents: advance ? advance.amountCents : null,
    methods: (frozen.methods ?? []).map((method) => ({
      label: method.name,
      amountCents: method.amountCents,
      reference: method.reference,
    })),
    creditAppliedCents: ticket.creditAppliedCents,
    cashReceivedCents: ticket.cashReceivedCents,
    changeCents: ticket.changeCents,
    totalCents: ticket.totalCents,
    remainingCents: frozen.remainingCents ?? null,
    pending: frozen.pending ?? null,
    taxes: frozen.taxes ?? null,
    org,
  }
}

/** Una fila de texto e importe, con letra del cuerpo del ticket. */
function moneyRow(kit: DocumentKit, label: string, amount: string, options: { strong?: boolean } = {}) {
  const face = options.strong ? ("sansSemi" as const) : ("sans" as const)
  const size = kit.thermal ? SIZE.second : SIZE.table
  kit.spread({ text: label, face, size }, { text: amount, face, size }, { size, leading: 1.45 })
}

function smallNote(kit: DocumentKit, text: string) {
  kit.text(text, { size: kit.thermal ? SIZE.label : SIZE.second, tone: "gray", leading: 1.4 })
}

function thermalRule(kit: DocumentKit) {
  kit.gap(7)
  kit.rule({ tone: "ink" })
  kit.gap(6)
}

function ticketTotals(kit: DocumentKit, snap: TicketSnapshot, money: (cents: number) => string) {
  if (snap.taxes) {
    // Como una boleta: lo cobrado hoy sin impuesto y el impuesto de cada tasa.
    moneyRow(kit, "Subtotal", money(snap.taxes.subtotalCents))
    for (const group of snap.taxes.groups.filter((item) => item.taxCents > 0)) moneyRow(kit, group.label, money(group.taxCents))
    const note = ticketUntaxedNote(snap.taxes)
    if (note) smallNote(kit, note)
  }
  if (kit.thermal) {
    kit.gap(2)
    kit.total("TOTAL", money(snap.totalCents))
  } else {
    kit.gap(4)
    kit.rule({ tone: "ink" })
    kit.total({ text: "Total", face: "sansSemi" }, money(snap.totalCents), { before: 5 })
  }
}

function howPaid(kit: DocumentKit, snap: TicketSnapshot, money: (cents: number) => string) {
  for (const method of snap.methods) {
    moneyRow(kit, method.label, money(method.amountCents))
    if (method.reference) smallNote(kit, `Operación ${method.reference}`)
  }
  if (snap.creditAppliedCents > 0) moneyRow(kit, "Saldo a favor usado", money(snap.creditAppliedCents))
  if (snap.cashReceivedCents != null) moneyRow(kit, "Recibido", money(snap.cashReceivedCents))
  if (snap.changeCents != null && snap.changeCents > 0) moneyRow(kit, "Vuelto", money(snap.changeCents))
}

/** Lo que falta del tratamiento va aparte del pago, con su nombre, y solo si falta algo. */
function stillOwed(kit: DocumentKit, snap: TicketSnapshot, money: (cents: number) => string) {
  if (snap.remainingCents == null || snap.remainingCents <= 0 || snap.lines.length === 0) return
  // En la hoja, «Le falta pagar» ya es el título de la sección.
  moneyRow(kit, kit.thermal ? "Le falta pagar" : "Por este tratamiento", money(snap.remainingCents), { strong: true })
  for (const item of snap.pending ?? []) {
    smallNote(kit, `${item.description}: pagó ${money(item.amountCents - item.remainingCents)} de ${money(item.amountCents)}`)
  }
}

export async function renderTicketPdf(snap: TicketSnapshot, paper?: string | null): Promise<Uint8Array> {
  const org = snap.org
  const money = (cents: number) => formatMoney(cents, snap.currency, org.locale)
  const label = `Ticket N.º ${snap.numberLabel}`
  const format = ticketFormat(org, paper)
  const kit = await DocumentKit.open(org, format, {
    title: label,
    docLabel: label,
    patientLabel: snap.patientName,
    legalNote: ticketFooterLines(org.ticketFooter).join(" "),
    createdAt: snap.paidAt,
  })
  const voided = () => {
    if (snap.status !== "anulado") return
    kit.gap(8)
    kit.stateBox({ kind: "alert", title: "ANULADO", detail: snap.voidReason ? `Motivo: ${snap.voidReason}` : null })
  }
  if (kit.thermal) {
    kit.gap(8)
    kit.spread({ text: "Ticket", face: "serif", size: SIZE.h2small }, { text: `N.º ${snap.numberLabel}`, face: "sansBold", size: SIZE.table }, { size: SIZE.table, leading: 1.3 })
    kit.text(shortDayTime(snap.paidAt, org), { size: SIZE.label, leading: 1.4 })
    voided()
    thermalRule(kit)
    kit.text([{ text: "Paciente: ", face: "sansSemi" }, snap.patientName], { size: SIZE.second, leading: 1.4 })
    if (snap.patientDoc) kit.text(snap.patientDoc, { size: SIZE.label, leading: 1.4 })
    if (snap.payerName && snap.payerName !== snap.patientName) kit.text(`Pagó: ${snap.payerName}`, { size: SIZE.label, leading: 1.4 })
    if (snap.issuerName) kit.text(`Caja: ${snap.issuerName}`, { size: SIZE.label, leading: 1.4 })
    thermalRule(kit)
    for (const line of snap.lines) {
      moneyRow(kit, line.description, money(line.amountCents))
      if (line.ofCents != null) smallNote(kit, `Paga una parte: cuesta ${money(line.ofCents)}`)
      if (line.promotion) smallNote(kit, `Promoción: ${line.promotion}`)
      kit.gap(3)
    }
    if (snap.advanceCents != null) moneyRow(kit, "Adelanto (queda como saldo a favor)", money(snap.advanceCents))
    thermalRule(kit)
    ticketTotals(kit, snap, money)
    thermalRule(kit)
    howPaid(kit, snap, money)
    if (snap.remainingCents != null && snap.remainingCents > 0 && snap.lines.length > 0) {
      thermalRule(kit)
      stillOwed(kit, snap, money)
    }
    return kit.finish()
  }
  kit.gap(22)
  kit.titleWithDetails("Ticket", [{ text: `N.º ${snap.numberLabel}`, strong: true }, { text: dayTimeWords(snap.paidAt, org) }])
  voided()
  kit.gap(16)
  kit.facts(
    [
      { label: "Paciente", value: snap.patientName, strong: true, ...(snap.patientDoc ? { sub: snap.patientDoc } : {}) },
      ...(snap.payerName ? [{ label: "Pagó", value: snap.payerName, strong: true }] : []),
      ...(snap.issuerName ? [{ label: "Caja", value: snap.issuerName, strong: true }] : []),
    ],
    3,
  )
  kit.gap(20)
  kit.table({
    columns: [{ label: "Concepto" }, { label: "Importe", width: 90, align: "right", pad: 0 }],
    size: SIZE.table,
    rowPad: 8,
    rows: [
      ...snap.lines.map((line) => [
        [
          { inlines: line.description, face: "sansMedium" as const },
          ...(line.ofCents != null ? [{ inlines: `Paga una parte: cuesta ${money(line.ofCents)}`, size: SIZE.second, tone: "gray" as const }] : []),
          ...(line.promotion ? [{ inlines: `Promoción: ${line.promotion}`, size: SIZE.second, tone: "gray" as const }] : []),
        ],
        money(line.amountCents),
      ]),
      ...(snap.advanceCents != null ? [["Adelanto (queda como saldo a favor)", money(snap.advanceCents)]] : []),
    ],
  })
  kit.gap(8)
  ticketTotals(kit, snap, money)
  kit.gap(20)
  kit.subheading("Cómo pagó", { face: "sansSemi", before: 0, after: 3 })
  howPaid(kit, snap, money)
  if (snap.remainingCents != null && snap.remainingCents > 0 && snap.lines.length > 0) {
    kit.subheading("Le falta pagar", { face: "sansSemi", before: 14, after: 3 })
    stillOwed(kit, snap, money)
  }
  return kit.finish()
}

// --- Constancia de devolución ------------------------------------------------

/**
 * Constancia de una devolución de saldo a favor, desde lo que se congeló al
 * devolver. Mismo papel que el ticket: la térmica del perfil, u hoja si se pide.
 */
export async function getRefundReceiptPdf(
  tx: Db,
  orgId: string,
  patientId: string,
  receiptId: string,
  paper?: string | null,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const frozen = await getRefundReceipt(tx, orgId, patientId, receiptId)
  const org = await loadFrozenDocumentClinic(tx, orgId, { clinic: frozen.clinic, branch: frozen.branch })
  const money = (cents: number) => formatMoney(cents, frozen.currency, org.locale)
  const title = "Constancia de devolución"
  const kit = await DocumentKit.open(org, ticketFormat(org, paper), {
    title,
    docLabel: title,
    patientLabel: frozen.patient.displayName,
    legalNote: ticketFooterLines(null).join(" "),
    createdAt: new Date(frozen.refundedAt),
  })
  const patientDoc = frozen.patient.docNumber ? `${frozen.patient.docType ?? "Doc."} ${frozen.patient.docNumber}` : null
  if (kit.thermal) {
    kit.gap(8)
    kit.text(title, { face: "serif", size: SIZE.h2small, leading: 1.25 })
    kit.text(shortDayTime(frozen.refundedAt, org), { size: SIZE.label, leading: 1.4 })
    thermalRule(kit)
    kit.text([{ text: "Paciente: ", face: "sansSemi" }, frozen.patient.displayName], { size: SIZE.second, leading: 1.4 })
    if (patientDoc) kit.text(patientDoc, { size: SIZE.label, leading: 1.4 })
    if (frozen.issuer.name) kit.text(`Caja: ${frozen.issuer.name}`, { size: SIZE.label, leading: 1.4 })
    thermalRule(kit)
    kit.total("Devuelto de su saldo a favor", money(frozen.amountCents))
    kit.gap(4)
    kit.text(`Se devolvió por: ${frozen.methodName}`, { size: SIZE.second, leading: 1.4 })
    kit.text(`Motivo: ${frozen.reason}`, { size: SIZE.second, leading: 1.4 })
    kit.signLine("Recibí conforme: nombre y firma")
  } else {
    kit.gap(22)
    kit.titleWithDetails(title, [{ text: dayTimeWords(frozen.refundedAt, org) }], SIZE.titleBudget)
    kit.gap(16)
    kit.facts(
      [
        { label: "Paciente", value: frozen.patient.displayName, strong: true, ...(patientDoc ? { sub: patientDoc } : {}) },
        ...(frozen.issuer.name ? [{ label: "Caja", value: frozen.issuer.name, strong: true }] : []),
      ],
      3,
    )
    kit.gap(14)
    kit.total({ text: "Devuelto de su saldo a favor", face: "sansSemi" }, money(frozen.amountCents))
    kit.gap(22)
    kit.table({
      columns: [{ label: "" }, { label: "" }],
      plain: true,
      rows: [
        [
          [{ inlines: "Se devolvió por", face: "sansSemi" as const }, { inlines: frozen.methodName, tone: "soft" as const }],
          [{ inlines: "Motivo", face: "sansSemi" as const }, { inlines: frozen.reason, tone: "soft" as const }],
        ],
      ],
      size: SIZE.table,
    })
    kit.anchorBottom(62)
    kit.signLine("Recibí conforme: nombre y firma", "Fecha")
  }
  return { bytes: await kit.finish(), filename: `Devolucion-${frozen.refundedAt.slice(0, 10)}.pdf` }
}

// --- Devolución de un cobro --------------------------------------------------

/**
 * Devolución de un cobro (ADR 0068), desde lo que se congeló al devolver: de qué
 * ticket sale, qué se devolvió, si volvió a la sede y cómo se le devolvió el dinero.
 * Mismo papel que el ticket.
 */
export async function renderReturnPdf(
  tx: Db,
  orgId: string,
  patientId: string,
  returnId: string,
  paper?: string | null,
): Promise<{ bytes: Uint8Array; filename: string; numberLabel: string; tradeName: string }> {
  const row = await getPaymentReturn(tx, orgId, patientId, returnId)
  const frozen = row.snapshot
  const org = await loadFrozenDocumentClinic(tx, orgId, { clinic: frozen.clinic, branch: frozen.branch })
  const money = (cents: number) => formatMoney(cents, row.currency, org.locale)
  const numberLabel = String(row.returnNumber).padStart(6, "0")
  const ticketLabel = String(frozen.ticket.number).padStart(6, "0")
  const label = `Devolución N.º ${numberLabel}`
  const kit = await DocumentKit.open(org, ticketFormat(org, paper), {
    title: label,
    docLabel: label,
    patientLabel: frozen.patient.displayName,
    legalNote: ticketFooterLines(frozen.notice).join(" "),
    createdAt: row.createdAt,
  })
  const patientDoc = frozen.patient.docNumber ? `${frozen.patient.docType ?? "Doc."} ${frozen.patient.docNumber}` : null
  if (kit.thermal) {
    kit.gap(8)
    kit.spread({ text: "Devolución", face: "serif", size: SIZE.h2small }, { text: `N.º ${numberLabel}`, face: "sansBold", size: SIZE.table }, { size: SIZE.table, leading: 1.3 })
    kit.text(shortDayTime(row.createdAt, org), { size: SIZE.label, leading: 1.4 })
    kit.text(`Del ticket N.º ${ticketLabel} del ${dayWords(frozen.ticket.createdAt, org)}`, { size: SIZE.label, leading: 1.4 })
    thermalRule(kit)
    kit.text([{ text: "Paciente: ", face: "sansSemi" }, frozen.patient.displayName], { size: SIZE.second, leading: 1.4 })
    if (patientDoc) kit.text(patientDoc, { size: SIZE.label, leading: 1.4 })
    if (frozen.issuer.name) kit.text(`Caja: ${frozen.issuer.name}`, { size: SIZE.label, leading: 1.4 })
    thermalRule(kit)
    for (const line of frozen.lines) {
      moneyRow(kit, line.description, money(line.amountCents))
      if (line.kind === "producto" && line.backToStock === false) smallNote(kit, "No volvió a la venta")
    }
    thermalRule(kit)
    kit.total("TOTAL DEVUELTO", money(row.totalCents))
    if (frozen.payout.kind === "pagado") moneyRow(kit, frozen.payout.methodName, money(row.totalCents))
    else kit.text("Queda como saldo a favor del paciente.", { size: SIZE.second, leading: 1.4 })
    kit.text(`Motivo: ${frozen.reason}`, { size: SIZE.second, leading: 1.4 })
    if (frozen.payout.kind === "pagado") kit.signLine("Recibí conforme: nombre y firma")
  } else {
    kit.gap(22)
    kit.titleWithDetails("Devolución", [{ text: `N.º ${numberLabel}`, strong: true }, { text: dayTimeWords(row.createdAt, org) }])
    kit.gap(16)
    kit.facts(
      [
        { label: "Paciente", value: frozen.patient.displayName, strong: true, ...(patientDoc ? { sub: patientDoc } : {}) },
        { label: "Del ticket", value: `N.º ${ticketLabel}`, strong: true, sub: dayWords(frozen.ticket.createdAt, org) },
        ...(frozen.issuer.name ? [{ label: "Caja", value: frozen.issuer.name, strong: true }] : []),
      ],
      3,
    )
    kit.gap(20)
    kit.table({
      columns: [{ label: "Se devuelve" }, { label: "Importe", width: 90, align: "right", pad: 0 }],
      size: SIZE.table,
      rowPad: 8,
      rows: frozen.lines.map((line) => [
        [
          { inlines: line.description, face: "sansMedium" as const },
          ...(line.kind === "producto" && line.backToStock === false
            ? [{ inlines: "No volvió a la venta", size: SIZE.second, tone: "gray" as const }]
            : []),
        ],
        money(line.amountCents),
      ]),
    })
    kit.total({ text: "Total devuelto", face: "sansSemi" }, money(row.totalCents), { before: 9 })
    kit.gap(22)
    kit.table({
      columns: [{ label: "" }, { label: "" }],
      plain: true,
      size: SIZE.table,
      rows: [
        [
          frozen.payout.kind === "pagado"
            ? [{ inlines: "Se devolvió por", face: "sansSemi" as const }, { inlines: frozen.payout.methodName, tone: "soft" as const }]
            : [{ inlines: "Se devolvió como", face: "sansSemi" as const }, { inlines: "Saldo a favor del paciente", tone: "soft" as const }],
          [{ inlines: "Motivo", face: "sansSemi" as const }, { inlines: frozen.reason, tone: "soft" as const }],
        ],
      ],
    })
    if (frozen.payout.kind === "pagado") {
      kit.anchorBottom(62)
      kit.signLine("Recibí conforme: nombre y firma", "Fecha")
    }
  }
  return { bytes: await kit.finish(), filename: `Devolucion-${numberLabel}.pdf`, numberLabel, tradeName: org.tradeName }
}
