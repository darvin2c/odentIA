/**
 * Documentos económicos en PDF (Fase 7 Finanzas): generador único servidor
 * para impresión y envío. Ticket y presupuesto se renderizan desde snapshots
 * inmutables (nunca joins mutables a tarifas vigentes).
 *
 * - Importes con `formatMoney` (@odentia/clinical) según moneda/locale del
 *   perfil de la organización; fechas con su zona horaria. Nada de PEN/es-PE
 *   fijos.
 * - Fuente Noto Sans embebida (OFL en `src/assets/fonts/`): imprime nombres
 *   reales sin mutarlos ni transliterarlos y sin red en runtime. Los glifos
 *   fuera de su cobertura fallan con error claro en vez de salir como `?`.
 * - Un presupuesto en borrador lleva marca BORRADOR visible: generar la vista
 *   previa nunca lo presenta como entregado. Entregar es un cambio explícito
 *   (`deliverBudget`, propiedad PresupuestosPromociones).
 */
import { formatMoney } from "@odentia/clinical"
import fontkit from "@pdf-lib/fontkit"
import type { Font } from "@pdf-lib/fontkit"
import { readFileSync } from "node:fs"
import type { Db } from "@odentia/db"
import { contact } from "@odentia/db/schema/crm"
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import { and, eq } from "drizzle-orm"
import { type BudgetPrintLine, type BudgetPrintOption, getBudgetPrintPayload } from "./budgets.js"
import { orgProfile } from "@odentia/db/schema/org"
import { validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import { getPaymentReturn, getRefundReceipt, getTicketReceipt, type TicketFrozen } from "./payments.js"

const INK = rgb(0.07, 0.09, 0.15)
const MUTED = rgb(0.4, 0.42, 0.47)
const ACCENT = rgb(0.6, 0.16, 0.16)

/**
 * Fuente Unicode embebida (Noto Sans OFL, `src/assets/fonts/`): imprime
 * nombres reales sin mutarlos ni transliterarlos, sin red en runtime.
 * Lo que la fuente no cubre falla con error claro en vez de salir como `?`.
 */
interface KitFonts {
  regular: Uint8Array
  bold: Uint8Array
}

let kitCache: { fonts: KitFonts; regular: Font; bold: Font } | null = null

function loadKit(): { fonts: KitFonts; regular: Font; bold: Font } {
  if (!kitCache) {
    const dir = new URL("./assets/fonts/", import.meta.url)
    const fonts: KitFonts = {
      regular: readFileSync(new URL("NotoSans-Regular.ttf", dir)),
      bold: readFileSync(new URL("NotoSans-Bold.ttf", dir)),
    }
    kitCache = {
      fonts,
      regular: fontkit.create(fonts.regular),
      bold: fontkit.create(fonts.bold),
    }
  }
  return kitCache
}

function assertPrintable(value: string): void {
  const { regular } = loadKit()
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (!regular.hasGlyphForCodePoint(code)) {
      throw validation(
        `El documento no puede imprimir «${char}» (U+${code.toString(16).toUpperCase()}): revisa el texto o amplía la fuente embebida`,
      )
    }
  }
}

class Writer {
  page: PDFPage
  y: number
  private pages = 1
  constructor(
    private readonly pdf: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
    private readonly pageWidth: number,
    private readonly pageHeight: number,
    private readonly margin: number,
    private readonly exactFit: boolean,
  ) {
    this.page = pdf.addPage([pageWidth, pageHeight])
    this.y = pageHeight - margin
  }
  private ensure(height: number) {
    if (this.y - height < this.margin) {
      this.page = this.pdf.addPage([this.pageWidth, this.pageHeight])
      this.pages += 1
      this.y = this.pageHeight - this.margin
    }
  }
  /** Recorta la página al contenido (papel térmico): solo una página. */
  finish(): void {
    if (!this.exactFit || this.pages !== 1) return
    const used = this.pageHeight - this.margin - this.y + this.margin * 2
    this.page.setSize(this.pageWidth, Math.max(used, this.margin * 4))
  }
  text(value: string, opts: { size?: number; bold?: boolean; color?: typeof INK } = {}) {
    const size = opts.size ?? 10
    const font = opts.bold ? this.bold : this.regular
    const width = this.pageWidth - this.margin * 2
    // Normalización solo de blancos heredados (\r, tabuladores): la identidad
    // y los textos salen tal cual, sin sustituciones.
    const clean = value.replace(/\r\n?/g, "\n").replace(/\t/g, " ")
    for (const paragraph of clean.split("\n")) {
      assertPrintable(paragraph)
      const words = paragraph.split(/\s+/).filter(Boolean)
      let line = ""
      const flush = () => {
        this.ensure(size + 4)
        this.page.drawText(line, {
          x: this.margin,
          y: this.y - size,
          size,
          font,
          color: opts.color ?? INK,
        })
        this.y -= size + 4
        line = ""
      }
      for (const word of words) {
        const next = line ? `${line} ${word}` : word
        if (font.widthOfTextAtSize(next, size) > width && line) {
          flush()
          line = word
        } else {
          line = next
        }
      }
      if (line) flush()
      if (words.length === 0) this.y -= size / 2
    }
  }
  /** Fila de tabla: texto a la izquierda (con salto) e importe alineado a la derecha. */
  row(label: string, amount: string, opts: { size?: number; bold?: boolean; color?: typeof INK } = {}) {
    const size = opts.size ?? 10
    const font = opts.bold ? this.bold : this.regular
    assertPrintable(amount)
    const amountWidth = font.widthOfTextAtSize(amount, size)
    const full = this.pageWidth - this.margin * 2
    const labelWidth = Math.max(full - amountWidth - 8, full * 0.4)
    const lines: string[] = []
    let line = ""
    assertPrintable(label)
    for (const word of label.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) > labelWidth && line) {
        lines.push(line)
        line = word
      } else {
        line = next
      }
    }
    if (line) lines.push(line)
    if (lines.length === 0) lines.push("")
    lines.forEach((text, index) => {
      this.ensure(size + 4)
      this.page.drawText(text, { x: this.margin, y: this.y - size, size, font, color: opts.color ?? INK })
      if (index === 0) {
        this.page.drawText(amount, {
          x: this.pageWidth - this.margin - amountWidth,
          y: this.y - size,
          size,
          font,
          color: opts.color ?? INK,
        })
      }
      this.y -= size + 4
    })
  }
  /** Línea para firmar con su leyenda debajo. */
  signature(caption: string, widthRatio = 0.55) {
    this.ensure(46)
    this.y -= 30
    this.page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: this.margin + (this.pageWidth - this.margin * 2) * widthRatio, y: this.y },
      thickness: 0.5,
      color: INK,
    })
    this.y -= 4
    this.text(caption, { size: 8, color: MUTED })
  }
  gap(height = 8) {
    this.y -= height
  }
  rule() {
    this.ensure(10)
    this.page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: this.pageWidth - this.margin, y: this.y },
      thickness: 0.5,
      color: MUTED,
    })
    this.y -= 10
  }
}

export interface DocOrg {
  tradeName: string
  legalName: string
  address: string | null
  phone: string | null
  branchName: string | null
  currency: string
  locale: string
  timezone: string
  ticketFooter: string
  /** Ancho del ticket: '58', '80' u 'hoja' (del perfil, sin default de país). */
  receiptWidth: string
  /** Hoja del presupuesto: 'A4' o 'Carta'. */
  sheetSize: string
}

export interface DocFormat {
  width: number
  height: number
  margin: number
  /** Papel térmico: recorta la página al contenido. */
  exactFit: boolean
}

const MM = 72 / 25.4
const SHEET_MARGIN = 48

function sheetPaperFormat(paper: string): DocFormat {
  const sheet = paper.trim().toLowerCase()
  if (sheet !== "a4" && sheet !== "carta" && sheet !== "letter") {
    throw validation("Papel inválido: solo A4 o Carta")
  }
  if (sheet === "carta" || sheet === "letter") {
    return { width: 612, height: 792, margin: SHEET_MARGIN, exactFit: false }
  }
  return { width: 595.28, height: 841.89, margin: SHEET_MARGIN, exactFit: false }
}

function sheetFormat(org: DocOrg): DocFormat {
  return sheetPaperFormat(org.sheetSize)
}

/**
 * Papel del ticket: térmica 58/80 según el perfil (schema: solo '58'|'80'),
 * u hoja A4/Carta cuando se pide explícito (`paper`, impresión).
 */
export function ticketFormat(org: DocOrg, paper?: string | null): DocFormat {
  if (paper) return sheetPaperFormat(paper)
  if (org.receiptWidth.trim() === "58") return { width: 58 * MM, height: 1400, margin: 10, exactFit: true }
  return { width: 80 * MM, height: 1400, margin: 12, exactFit: true }
}

/** Papel del presupuesto: hoja del perfil, u hoja explícita (`paper`). */
export function budgetFormat(org: DocOrg, paper?: string | null): DocFormat {
  return paper ? sheetPaperFormat(paper) : sheetFormat(org)
}

export function formatDate(value: Date, org: DocOrg): string {
  return new Intl.DateTimeFormat(org.locale, {
    timeZone: org.timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value)
}

/** Fecha larga sin hora, para la hoja del presupuesto. */
function formatDay(value: Date, org: DocOrg): string {
  return new Intl.DateTimeFormat(org.locale, {
    timeZone: org.timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(value)
}

async function buildPdf(
  title: string,
  draw: (w: Writer, org: DocOrg) => void,
  org: DocOrg,
  format: DocFormat,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  pdf.setTitle(title)
  pdf.setProducer("odentIA")
  pdf.setCreationDate(new Date())
  const { fonts } = loadKit()
  const w = new Writer(
    pdf,
    await pdf.embedFont(fonts.regular, { subset: true }),
    await pdf.embedFont(fonts.bold, { subset: true }),
    format.width,
    format.height,
    format.margin,
    format.exactFit,
  )
  draw(w, org)
  w.finish()
  return pdf.save({ useObjectStreams: false })
}

function header(w: Writer, org: DocOrg, docTitle: string, docNumber: string | null) {
  w.text(org.tradeName, { size: 14, bold: true })
  if (org.branchName) w.text(org.branchName, { size: 10, color: MUTED })
  if (org.address) w.text(org.address, { size: 9, color: MUTED })
  if (org.phone) w.text(`Tel. ${org.phone}`, { size: 9, color: MUTED })
  w.gap(4)
  w.rule()
  w.text(docTitle, { size: 13, bold: true })
  if (docNumber) w.text(docNumber, { size: 11, bold: true })
  w.gap(2)
}

// --- Ticket ---------------------------------------------------------------

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
  org: DocOrg
}

/**
 * Ticket desde lo que se congeló al cobrar (`payment_ticket.snapshot`):
 * conceptos, medios, clínica, sede, frase al pie y quién cobró. Un ticket
 * anulado se imprime completo con su marca; cambiar después el nombre de la
 * clínica, el medio o el concepto no reescribe lo ya emitido. Solo el papel
 * (ancho de la térmica u hoja) sale del perfil actual: es de la impresora.
 * `documentId` es `paymentTicket.id`.
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
  const profile = receipt.orgProfile
  // Sin defaults de país: el perfil regional es obligatorio.
  if (!profile) {
    throw validation("La organización no tiene perfil regional: configúralo antes de generar documentos")
  }
  const frozen = ticket.snapshot as TicketFrozen
  const clinic = frozen.clinic
  const org: DocOrg = {
    tradeName: clinic.tradeName || clinic.legalName,
    legalName: clinic.legalName,
    address: clinic.fiscalAddress ?? receipt.branch?.addressLine1 ?? null,
    phone: receipt.branch?.phone ?? null,
    branchName: frozen.branch?.name ?? null,
    currency: ticket.currency,
    locale: clinic.locale,
    timezone: clinic.timezone,
    ticketFooter: frozen.notice,
    receiptWidth: profile.receiptWidth,
    sheetSize: profile.sheetSize,
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
    org,
  }
}

export async function renderTicketPdf(snap: TicketSnapshot, paper?: string | null): Promise<Uint8Array> {
  const org = snap.org
  const money = (cents: number) => formatMoney(cents, snap.currency, org.locale)
  const title = `Ticket N.º ${snap.numberLabel}`
  return buildPdf(
    title,
    (w) => {
      header(w, org, "TICKET", `N.º ${snap.numberLabel}`)
      if (snap.status === "anulado") {
        w.text(
          `ANULADO${snap.voidReason ? ` · Motivo: ${snap.voidReason}` : ""}`,
          { size: 12, bold: true, color: ACCENT },
        )
        w.gap(2)
      }
      w.text(formatDate(snap.paidAt, org), { size: 9, color: MUTED })
      w.text(`Paciente: ${snap.patientName}`, { size: 10 })
      if (snap.patientDoc) w.text(snap.patientDoc, { size: 9, color: MUTED })
      if (snap.payerName && snap.payerName !== snap.patientName) {
        w.text(`Pagó: ${snap.payerName}`, { size: 10 })
      }
      if (snap.issuerName) w.text(`Caja: ${snap.issuerName}`, { size: 9, color: MUTED })
      w.gap(4)
      w.rule()
      for (const line of snap.lines) {
        w.row(line.description, money(line.amountCents), { size: 10 })
        if (line.ofCents != null) w.text(`A cuenta de ${money(line.ofCents)}`, { size: 9, color: MUTED })
        if (line.promotion) w.text(`Promoción: ${line.promotion}`, { size: 9, color: MUTED })
      }
      if (snap.advanceCents != null) {
        w.row("Adelanto (queda como saldo a favor)", money(snap.advanceCents), { size: 10 })
      }
      w.gap(4)
      w.rule()
      w.row("TOTAL", money(snap.totalCents), { size: 12, bold: true })
      for (const method of snap.methods) {
        w.row(method.label, money(method.amountCents), { size: 10 })
        if (method.reference) w.text(`Operación ${method.reference}`, { size: 8, color: MUTED })
      }
      if (snap.creditAppliedCents > 0) w.row("Saldo a favor usado", money(snap.creditAppliedCents), { size: 10 })
      if (snap.cashReceivedCents != null) w.row("Recibido", money(snap.cashReceivedCents), { size: 10 })
      if (snap.changeCents != null && snap.changeCents > 0) w.row("Vuelto", money(snap.changeCents), { size: 10 })
      if (snap.remainingCents != null && snap.lines.length > 0) {
        w.row("Saldo por cobrar", money(snap.remainingCents), { size: 10 })
      }
      w.gap(6)
      w.text(org.ticketFooter, { size: 8, color: MUTED })
    },
    org,
    ticketFormat(org, paper),
  )
}

// --- Presupuesto ------------------------------------------------------------

export interface BudgetSnapshot {
  kind: "budget"
  sourceId: string
  numberLabel: string
  status: string
  isDraft: boolean
  issuedAt: Date
  patientName: string
  patientDoc: string | null
  professional: string | null
  planTitle: string
  currency: string
  lines: BudgetPrintLine[]
  /** Con más de una opción, cada una con su total (nunca sumadas); vacío con una sola. */
  options: BudgetPrintOption[]
  subtotalCents: number | null
  totalCents: number | null
  notes: string | null
  org: DocOrg
}

/**
 * Hoja del presupuesto desde su contenido imprimible (`getBudgetPrintPayload`).
 * `actor` aplica la misma frontera que la pantalla: un odontólogo solo
 * obtiene la hoja de los presupuestos de sus planes.
 */
export async function buildBudgetSnapshot(
  tx: Db,
  orgId: string,
  patientId: string,
  budgetId: string,
  actor: { actorUserId?: string; memberRole?: string } = {},
): Promise<BudgetSnapshot> {
  const payload = await getBudgetPrintPayload(tx, orgId, patientId, budgetId, actor)
  const [profile] = await tx
    .select({ receiptWidth: orgProfile.receiptWidth, ticketFooter: orgProfile.ticketFooter })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  if (!profile) {
    throw validation("La organización no tiene perfil regional: configúralo antes de generar documentos")
  }
  const org: DocOrg = {
    tradeName: payload.clinic.name,
    legalName: payload.clinic.name,
    address: payload.clinic.address,
    phone: payload.clinic.phone,
    branchName: payload.clinic.branchName,
    currency: payload.currency,
    locale: payload.locale,
    timezone: payload.timezone,
    ticketFooter: profile.ticketFooter,
    receiptWidth: profile.receiptWidth,
    sheetSize: payload.paper,
  }
  const professional = payload.professional
    ? [payload.professional.title, payload.professional.name].filter(Boolean).join(" ")
    : null
  return {
    kind: "budget",
    sourceId: budgetId,
    numberLabel: `N.º ${String(payload.budgetNumber).padStart(4, "0")}${
      payload.revisionNumber > 1 ? ` · revisión ${payload.revisionNumber}` : ""
    }`,
    status: payload.status,
    isDraft: payload.isDraft,
    issuedAt: payload.issuedAt,
    patientName: payload.patient.displayName,
    patientDoc: payload.patient.docNumber
      ? `${payload.patient.docType ?? "Doc."} ${payload.patient.docNumber}`
      : null,
    professional,
    planTitle: payload.planTitle,
    currency: payload.currency,
    lines: payload.lines,
    options: payload.options,
    subtotalCents: payload.subtotalCents,
    totalCents: payload.totalCents,
    notes: payload.notes,
    org,
  }
}

export async function renderBudgetPdf(snap: BudgetSnapshot, paper?: string | null): Promise<Uint8Array> {
  const org = snap.org
  const money = (cents: number | null) =>
    cents == null ? "por definir" : formatMoney(cents, snap.currency, org.locale)
  const title = `Presupuesto ${snap.numberLabel}`
  return buildPdf(
    title,
    (w) => {
      header(w, org, "PRESUPUESTO", snap.numberLabel)
      if (snap.isDraft) {
        w.text("BORRADOR — documento no entregado", { size: 12, bold: true, color: ACCENT })
        w.gap(2)
      } else {
        w.text(formatDay(snap.issuedAt, org), { size: 9, color: MUTED })
      }
      w.text(`Paciente: ${snap.patientName}${snap.patientDoc ? ` · ${snap.patientDoc}` : ""}`, { size: 10 })
      if (snap.professional) w.text(`Profesional: ${snap.professional}`, { size: 10 })
      w.text(`Plan: ${snap.planTitle}`, { size: 10 })
      w.gap(4)
      /** Una opción (o el presupuesto entero): líneas, descuentos y su total. */
      const block = (
        lines: BudgetPrintLine[],
        subtotalCents: number | null,
        totalCents: number | null,
        totalLabel: string,
      ) => {
        w.rule()
        w.row("Tratamiento", "Precio", { size: 9, bold: true, color: MUTED })
        for (const line of lines) {
          const label = `${line.title}${line.detail ? `, ${line.detail}` : ""}`
          w.row(label, money(line.listTotalCents), { size: 10 })
          if (line.billingMode === "session") {
            // Lo que se cobra por sesión: el paciente ve el total, pero la deuda
            // nace visita a visita.
            w.text(
              `Se cobra por sesión: ${money(line.listUnitCents)} en cada visita · ${line.units} ${
                line.units === 1 ? "visita prevista" : "visitas previstas"
              }`,
              { size: 9, color: MUTED },
            )
          }
        }
        w.gap(4)
        w.rule()
        const discounts = lines.filter((line) => (line.discountCents ?? 0) > 0)
        if (discounts.length > 0) {
          w.row("Subtotal", money(subtotalCents), { size: 10 })
          for (const line of discounts) {
            const reason = line.promotionName ? `Promoción ${line.promotionName}` : "Descuento"
            w.row(`${reason} en ${line.title}`, `− ${money(line.discountCents)}`, { size: 10 })
          }
        }
        w.row(totalLabel, money(totalCents), { size: 12, bold: true })
      }
      if (snap.options.length > 1) {
        // Dos o tres caminos para lo mismo (decisión 13): cada uno con su total;
        // se elige uno, nunca se suman.
        w.text(`Elige una de estas ${snap.options.length} opciones. Cada una tiene su propio total.`, { size: 10 })
        for (const option of snap.options) {
          w.gap(4)
          const state =
            option.decision === "elegida" ? " · elegida" : option.decision === "no_elegida" ? " · no elegida" : ""
          w.text(`${option.label}${option.isRecommended ? " · recomendada" : ""}${state}`, { size: 11, bold: true })
          block(option.lines, option.subtotalCents, option.totalCents, `TOTAL ${option.label.toUpperCase()}`)
        }
      } else {
        block(snap.lines, snap.subtotalCents, snap.totalCents, "TOTAL")
      }
      w.gap(6)
      w.text("Cómo se paga", { size: 10, bold: true })
      w.text(
        "Cada tratamiento se paga cuando se realiza. Puede dejar un adelanto, que se descuenta de lo siguiente que deba.",
        { size: 9, color: MUTED },
      )
      if (snap.notes) {
        w.gap(2)
        w.text(snap.notes, { size: 9 })
      }
      if (!snap.isDraft) {
        w.gap(6)
        w.text(snap.options.length > 1 ? "Acepto la opción ____" : "Acepto este presupuesto", { size: 10, bold: true })
        w.signature("Nombre y firma del paciente o su representante")
        w.signature("Fecha", 0.25)
      }
      w.gap(6)
      w.text("Este presupuesto no es un documento fiscal.", { size: 8, color: MUTED })
    },
    org,
    budgetFormat(org, paper),
  )
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
  const [profile] = await tx.select().from(orgProfile).where(eq(orgProfile.organizationId, orgId))
  if (!profile) {
    throw validation("La organización no tiene perfil regional: configúralo antes de generar documentos")
  }
  const clinic = frozen.clinic
  const org: DocOrg = {
    tradeName: clinic.tradeName || clinic.legalName,
    legalName: clinic.legalName,
    address: clinic.fiscalAddress,
    phone: null,
    branchName: frozen.branch.name,
    currency: frozen.currency,
    locale: clinic.locale,
    timezone: clinic.timezone,
    ticketFooter: "",
    receiptWidth: profile.receiptWidth,
    sheetSize: profile.sheetSize,
  }
  const money = (cents: number) => formatMoney(cents, frozen.currency, org.locale)
  const bytes = await buildPdf(
    "Constancia de devolución",
    (w) => {
      header(w, org, "CONSTANCIA DE DEVOLUCIÓN", null)
      w.text(formatDate(new Date(frozen.refundedAt), org), { size: 9, color: MUTED })
      w.text(`Paciente: ${frozen.patient.displayName}`, { size: 10 })
      if (frozen.patient.docNumber) {
        w.text(`${frozen.patient.docType ?? "Doc."} ${frozen.patient.docNumber}`, { size: 9, color: MUTED })
      }
      if (frozen.issuer.name) w.text(`Caja: ${frozen.issuer.name}`, { size: 9, color: MUTED })
      w.gap(4)
      w.rule()
      w.row("Devuelto de su saldo a favor", money(frozen.amountCents), { size: 12, bold: true })
      w.text(`Se devolvió por: ${frozen.methodName}`, { size: 10 })
      w.text(`Motivo: ${frozen.reason}`, { size: 10 })
      w.signature("Recibí conforme")
    },
    org,
    ticketFormat(org, paper),
  )
  return { bytes, filename: `Devolucion-${frozen.refundedAt.slice(0, 10)}.pdf` }
}

// --- Devolución de un cobro --------------------------------------------------

/**
 * Devolución de un cobro (ADR 0068), desde lo que se congeló al devolver: de
 * qué ticket sale, qué se devolvió, si volvió a la sede y cómo se le devolvió
 * el dinero. Mismo papel que el ticket.
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
  const [profile] = await tx.select().from(orgProfile).where(eq(orgProfile.organizationId, orgId))
  if (!profile) {
    throw validation("La organización no tiene perfil regional: configúralo antes de generar documentos")
  }
  const clinic = frozen.clinic
  const org: DocOrg = {
    tradeName: clinic.tradeName || clinic.legalName,
    legalName: clinic.legalName,
    address: clinic.fiscalAddress,
    phone: null,
    branchName: frozen.branch.name,
    currency: row.currency,
    locale: clinic.locale,
    timezone: clinic.timezone,
    ticketFooter: frozen.notice,
    receiptWidth: profile.receiptWidth,
    sheetSize: profile.sheetSize,
  }
  const money = (cents: number) => formatMoney(cents, row.currency, org.locale)
  const numberLabel = String(row.returnNumber).padStart(6, "0")
  const ticketLabel = String(frozen.ticket.number).padStart(6, "0")
  const bytes = await buildPdf(
    `Devolución N.º ${numberLabel}`,
    (w) => {
      header(w, org, "DEVOLUCIÓN", `N.º ${numberLabel}`)
      w.text(formatDate(row.createdAt, org), { size: 9, color: MUTED })
      w.text(`Del ticket N.º ${ticketLabel} del ${formatDay(new Date(frozen.ticket.createdAt), org)}`, { size: 9, color: MUTED })
      w.text(`Paciente: ${frozen.patient.displayName}`, { size: 10 })
      if (frozen.patient.docNumber) {
        w.text(`${frozen.patient.docType ?? "Doc."} ${frozen.patient.docNumber}`, { size: 9, color: MUTED })
      }
      if (frozen.issuer.name) w.text(`Caja: ${frozen.issuer.name}`, { size: 9, color: MUTED })
      w.gap(4)
      w.rule()
      for (const line of frozen.lines) {
        w.row(line.description, money(line.amountCents), { size: 10 })
        if (line.kind === "producto" && line.backToStock === false) {
          w.text("No volvió a la venta", { size: 9, color: MUTED })
        }
      }
      w.gap(4)
      w.rule()
      w.row("TOTAL DEVUELTO", money(row.totalCents), { size: 12, bold: true })
      if (frozen.payout.kind === "pagado") {
        w.row(frozen.payout.methodName, money(row.totalCents), { size: 10 })
      } else {
        w.text("Queda como saldo a favor del paciente.", { size: 10 })
      }
      w.text(`Motivo: ${frozen.reason}`, { size: 10 })
      if (frozen.payout.kind === "pagado") w.signature("Recibí conforme")
      w.gap(6)
      if (org.ticketFooter) w.text(org.ticketFooter, { size: 8, color: MUTED })
    },
    org,
    ticketFormat(org, paper),
  )
  return { bytes, filename: `Devolucion-${numberLabel}.pdf`, numberLabel, tradeName: org.tradeName }
}
