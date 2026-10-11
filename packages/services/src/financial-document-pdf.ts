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
import { branch, orgProfile } from "@odentia/db/schema/org"
import type { Db } from "@odentia/db"
import { treatmentBudget } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib"
import { and, eq } from "drizzle-orm"
import { getBudgetDetail } from "./budgets.js"
import { notFound, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import { getTicketReceipt } from "./payments.js"

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

async function loadOrg(tx: Db, orgId: string, branchId: string | null): Promise<DocOrg> {
  const [profile] = await tx
    .select()
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  // Sin defaults de país: moneda, locale, zona y textos salen del perfil.
  if (!profile) {
    throw validation("La organización no tiene perfil regional: configúralo antes de generar documentos")
  }
  let branchRow: { name: string; addressLine1: string | null; phone: string | null } | null = null
  if (branchId) {
    const [found] = await tx
      .select({ name: branch.name, addressLine1: branch.addressLine1, phone: branch.phone })
      .from(branch)
      .where(and(eq(branch.id, branchId), eq(branch.organizationId, orgId)))
      .limit(1)
    branchRow = found ?? null
  }
  return {
    tradeName: profile.tradeName ?? profile.legalName,
    legalName: profile.legalName,
    address: profile.fiscalAddress ?? branchRow?.addressLine1 ?? null,
    phone: branchRow?.phone ?? null,
    branchName: branchRow?.name ?? null,
    currency: profile.currency,
    locale: profile.locale,
    timezone: profile.timezone,
    ticketFooter: profile.ticketFooter,
    receiptWidth: profile.receiptWidth,
    sheetSize: profile.sheetSize,
  }
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
  amountCents: number
  /** Promoción aplicada al concepto (snapshot; null = sin promoción). */
  promotion: string | null
}

export interface TicketMethod {
  label: string
  amountCents: number
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
  paidAt: Date
  currency: string
  lines: TicketLine[]
  methods: TicketMethod[]
  creditAppliedCents: number
  cashReceivedCents: number | null
  changeCents: number | null
  totalCents: number
  org: DocOrg
}

/**
 * Snapshot del ticket numerado (CobrosCaja `getTicketReceipt`): cabecera
 * inmutable, aplicaciones vigentes con sus cargos, medios congelados y sede.
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
  const { ticket, payments, applications, chargeById } = receipt
  const profile = receipt.orgProfile
  // Sin defaults de país: el perfil regional es obligatorio.
  if (!profile) {
    throw validation("La organización no tiene perfil regional: configúralo antes de generar documentos")
  }
  const branchRow = receipt.branch
  const org: DocOrg = {
    tradeName: profile.tradeName ?? profile.legalName,
    legalName: profile.legalName,
    address: profile.fiscalAddress ?? branchRow?.addressLine1 ?? null,
    phone: branchRow?.phone ?? null,
    branchName: branchRow?.name ?? null,
    currency: profile.currency,
    locale: profile.locale,
    timezone: profile.timezone,
    ticketFooter: profile.ticketFooter,
    receiptWidth: profile.receiptWidth,
    sheetSize: profile.sheetSize,
  }
  let payerName: string | null = null
  if (ticket.payerContactId) {
    const [payer] = await tx
      .select({ displayName: contact.displayName })
      .from(contact)
      .where(and(eq(contact.id, ticket.payerContactId), eq(contact.organizationId, orgId)))
      .limit(1)
    payerName = payer?.displayName ?? null
  }
  // Solo suman las aplicaciones vigentes, en orden de registro.
  const live = applications
    .filter((a) => !a.voidedAt)
    .sort(
      (x, y) =>
        x.createdAt.getTime() - y.createdAt.getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    )
  const docLabel = patientRow.docNumber ? `${patientRow.docType ?? "Doc."} ${patientRow.docNumber}` : null
  return {
    kind: "ticket",
    sourceId: ticket.id,
    numberLabel: String(ticket.ticketNumber).padStart(6, "0"),
    status: ticket.voidedAt ? "anulado" : "vigente",
    voidReason: ticket.voidReason ?? null,
    patientName: patientRow.displayName,
    patientDoc: docLabel,
    payerName,
    paidAt: ticket.createdAt,
    currency: ticket.currency,
    lines: live.map((a) => ({
      description: chargeById[a.chargeId]?.description ?? "Concepto",
      amountCents: a.amountCents,
      promotion: chargeById[a.chargeId]?.promotionName ?? null,
    })),
    methods: payments
      .filter((p) => !p.voidedAt)
      .map((p) => ({ label: p.methodName ?? p.method ?? "otro", amountCents: p.amountCents })),
    creditAppliedCents: ticket.creditAppliedCents,
    cashReceivedCents: ticket.cashReceivedCents,
    changeCents: ticket.changeCents,
    totalCents: ticket.totalCents,
    org,
  }
}

export async function renderTicketPdf(snap: TicketSnapshot, paper?: string | null): Promise<Uint8Array> {
  const org = snap.org
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
      w.text(
        `${formatDate(snap.paidAt, org)}${org.branchName ? ` · ${org.branchName}` : ""}`,
        { size: 9, color: MUTED },
      )
      w.text(`Paciente: ${snap.patientName}`, { size: 10 })
      if (snap.patientDoc) w.text(snap.patientDoc, { size: 9, color: MUTED })
      if (snap.payerName && snap.payerName !== snap.patientName) {
        w.text(`Pagó: ${snap.payerName}`, { size: 10 })
      }
      w.gap(4)
      w.rule()
      if (snap.lines.length === 0) {
        w.text("Adelanto / saldo a favor (sin conceptos aplicados).", { size: 10 })
      } else {
        for (const line of snap.lines) {
          w.text(
            `${line.description} — ${formatMoney(line.amountCents, snap.currency, org.locale)}`,
            { size: 10 },
          )
          if (line.promotion) w.text(`Promo: ${line.promotion}`, { size: 9, color: MUTED })
        }
      }
      w.gap(4)
      w.rule()
      w.text(`TOTAL: ${formatMoney(snap.totalCents, snap.currency, org.locale)}`, { size: 12, bold: true })
      for (const method of snap.methods) {
        w.text(
          `${method.label}: ${formatMoney(method.amountCents, snap.currency, org.locale)}`,
          { size: 10 },
        )
      }
      if (snap.creditAppliedCents > 0) {
        w.text(
          `Saldo a favor aplicado: ${formatMoney(snap.creditAppliedCents, snap.currency, org.locale)}`,
          { size: 10 },
        )
      }
      if (snap.cashReceivedCents != null) {
        w.text(
          `Recibido: ${formatMoney(snap.cashReceivedCents, snap.currency, org.locale)}`,
          { size: 10 },
        )
      }
      if (snap.changeCents != null && snap.changeCents > 0) {
        w.text(`Vuelto: ${formatMoney(snap.changeCents, snap.currency, org.locale)}`, { size: 10 })
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
  presentedAt: Date | null
  patientName: string
  patientDoc: string | null
  title: string
  currency: string
  lines: { description: string; detail: string | null; amountCents: number | null; promotion: string | null }[]
  totalCents: number | null
  notes: string | null
  org: DocOrg
}

export async function buildBudgetSnapshot(
  tx: Db,
  orgId: string,
  patientId: string,
  budgetId: string,
): Promise<BudgetSnapshot> {
  const patientRow = await requirePatient(tx, orgId, patientId)
  const [budgetHead] = await tx
    .select({ presentedAt: treatmentBudget.presentedAt })
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .limit(1)
  if (!budgetHead) throw notFound("Presupuesto")
  const detail = await getBudgetDetail(tx, orgId, patientId, budgetId)
  const org = await loadOrg(tx, orgId, null)
  const docLabel = patientRow.docNumber
    ? `${patientRow.docType ?? "Doc."} ${patientRow.docNumber}`
    : null
  return {
    kind: "budget",
    sourceId: detail.id,
    numberLabel: `N.º ${String(detail.budgetNumber).padStart(4, "0")}`,
    status: detail.status,
    isDraft: detail.status === "borrador",
    presentedAt: budgetHead.presentedAt,
    patientName: patientRow.displayName,
    patientDoc: docLabel,
    title: detail.title,
    currency: detail.currency,
    lines: detail.items.map((item) => {
      const extras = [
        item.toothNumber ? `pieza ${item.toothNumber}` : null,
        item.scope && item.scope !== "pieza" ? item.scope : null,
      ].filter(Boolean)
      return {
        description: item.title,
        detail: extras.length > 0 ? extras.join(" · ") : null,
        amountCents: item.priceCents,
        promotion: item.promotionName ?? null,
      }
    }),
    totalCents: detail.totalCents,
    notes: detail.notes,
    org,
  }
}

export async function renderBudgetPdf(snap: BudgetSnapshot, paper?: string | null): Promise<Uint8Array> {
  const org = snap.org
  const title = `Presupuesto ${snap.numberLabel}`
  return buildPdf(
    title,
    (w) => {
      header(w, org, "PRESUPUESTO", snap.numberLabel)
      if (snap.isDraft) {
        w.text("BORRADOR — documento no entregado", { size: 12, bold: true, color: ACCENT })
        w.gap(2)
      } else if (snap.presentedAt) {
        w.text(`Presentado el ${formatDate(snap.presentedAt, org)} · Estado: ${snap.status}`, {
          size: 9,
          color: MUTED,
        })
      } else {
        w.text(`Estado: ${snap.status}`, { size: 9, color: MUTED })
      }
      w.text(`Paciente: ${snap.patientName}`, { size: 10 })
      if (snap.patientDoc) w.text(snap.patientDoc, { size: 9, color: MUTED })
      w.text(`Plan: ${snap.title}`, { size: 10 })
      w.gap(4)
      w.rule()
      for (const line of snap.lines) {
        const amount =
          line.amountCents == null
            ? "precio por definir"
            : formatMoney(line.amountCents, snap.currency, org.locale)
        w.text(
          `${line.description}${line.detail ? ` (${line.detail})` : ""} — ${amount}`,
          { size: 10 },
        )
        if (line.promotion) {
          w.text(`Promoción: ${line.promotion}`, { size: 9, color: MUTED })
        }
      }
      w.gap(4)
      w.rule()
      w.text(
        snap.totalCents == null
          ? "TOTAL: por definir"
          : `TOTAL: ${formatMoney(snap.totalCents, snap.currency, org.locale)}`,
        { size: 12, bold: true },
      )
      w.gap(2)
      w.text("Cada tratamiento se paga cuando se realiza, salvo adelanto acordado.", {
        size: 9,
        color: MUTED,
      })
      if (snap.notes) {
        w.gap(2)
        w.text(snap.notes, { size: 9 })
      }
      w.gap(6)
      w.text("Este presupuesto no es un documento fiscal.", { size: 8, color: MUTED })
    },
    org,
    budgetFormat(org, paper),
  )
}
