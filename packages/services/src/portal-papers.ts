/**
 * «Tus documentos» del portal: todo lo suyo, sin que nadie lo elija (ADR 0154).
 *
 * La lista la arma el servidor con una sola regla por papel, la misma para
 * cualquier acceso, de hoy o de antes:
 * - Solo lo terminado: la receta, la orden y el descanso desde que se emiten;
 *   la hoja de atención solo si se emitió; el consentimiento firmado y
 *   confirmado (nunca el pendiente, el anulado ni el firmado por enlace sin
 *   confirmar); el comprobante del cobro; el archivo subido sin retirar; la
 *   imagen con su informe terminado o que no lo requiere.
 * - Lo anulado se ve marcado («Anulada», «Revocado») y se descarga con su
 *   sello; la receta que pasó su vigencia dice «Vencida».
 * - Cada papel sale una vez: el PDF de un consentimiento, su hoja escaneada y
 *   el informe que es resultado de una orden van dentro de su papel.
 * - La clínica oculta un archivo con «No mostrar en su portal»; la tomografía
 *   no va al portal (no se abre en el teléfono).
 * - La historia clínica (las notas de cada atención) no está aquí.
 *
 * Quién lo ve ya lo decide la sesión: la propia persona o su representante
 * legal vigente (`requirePortalSession`). Cada apertura queda registrada.
 */
import type { Db } from "@odentia/db"
import {
  patientDocument,
  patientDocumentContext,
  patientResponsibility,
  paymentTicket,
  prescription,
} from "@odentia/db/schema/clinical"
import {
  clinicalOrder,
  consentDocument,
  issuedPaper,
  medicalLeave,
} from "@odentia/db/schema/clinical-forms"
import { auditEvent } from "@odentia/db/schema/org"
import { portalAccessLog, portalSession } from "@odentia/db/schema/portal"
import { and, desc, eq, inArray, isNotNull, isNull, lt, max } from "drizzle-orm"
import { ATTENTION_SHEET_LABEL } from "./attention-sheet.js"
import { ORDER_KIND_WORDS } from "./clinical-papers.js"
import { ServiceError } from "./errors.js"
import { buildTicketSnapshot, renderTicketPdf } from "./financial-document-pdf.js"
import { renderHealthDocumentPdf } from "./health-documents.js"
import type { PaperStorage } from "./issued-papers.js"
import { getOrgLocale } from "./locale.js"
import { getPortalPolicy } from "./portal-policy.js"
import type { PortalContext } from "./portal.js"
import type { Storage } from "./storage.js"

export const PORTAL_PAPER_KINDS = [
  "receta",
  "orden",
  "descanso",
  "hoja",
  "consentimiento",
  "comprobante",
  "archivo",
] as const
export type PortalPaperKind = (typeof PORTAL_PAPER_KINDS)[number]

export function isPortalPaperKind(value: string): value is PortalPaperKind {
  return (PORTAL_PAPER_KINDS as readonly string[]).includes(value)
}

/** Un papel de «Tus documentos», dicho con palabras. */
export interface PortalPaper {
  kind: PortalPaperKind
  id: string
  /** El tipo para la persona: «Receta», «Radiografía», «Comprobante». */
  type: string
  title: string
  /** Cuándo se emitió, firmó o subió (ISO 8601). */
  at: string
  /** «Anulada», «Vencida», «Revocado»…; nulo si vale. Es texto, no solo un color. */
  stateWord: string | null
  /** Apareció desde su visita anterior al portal. */
  isNew: boolean
  /** Radiografía o foto: se abre como imagen. */
  image: boolean
}

/** Las palabras de cada archivo subido; nunca el código («foto_clinica»). */
const FILE_TYPE_WORDS: Record<string, string> = {
  radiografia: "Radiografía",
  foto_clinica: "Foto",
  informe: "Informe",
  consentimiento: "Consentimiento",
  otro: "Archivo",
}

const IMAGE_CATEGORIES = new Set(["radiografia", "foto_clinica"])

/** Desde cuándo un papel es «Nuevo»: después de su visita anterior (una hora sin volver). */
const VISIT_GAP_MS = 60 * 60_000

/** La visita anterior de este acceso al portal: la última vez que vio sus documentos antes de esta. */
async function previousVisitAt(tx: Db, ctx: PortalContext): Promise<Date | null> {
  if (!ctx.session.grantId) return null
  const [row] = await tx
    .select({ at: max(portalAccessLog.createdAt) })
    .from(portalAccessLog)
    .innerJoin(
      portalSession,
      and(
        eq(portalSession.id, portalAccessLog.sessionId),
        eq(portalSession.organizationId, portalAccessLog.organizationId),
      ),
    )
    .where(
      and(
        eq(portalAccessLog.organizationId, ctx.orgId),
        eq(portalSession.grantId, ctx.session.grantId),
        eq(portalAccessLog.action, "papers.listed"),
        lt(portalAccessLog.createdAt, new Date(Date.now() - VISIT_GAP_MS)),
      ),
    )
  return row?.at ?? null
}

/** Hoy en la zona de la clínica (AAAA-MM-DD), para decir si una receta ya venció. */
async function clinicToday(tx: Db, orgId: string): Promise<string> {
  const zone = await getOrgLocale(tx, orgId)
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone.timezone }).format(new Date())
}

/**
 * Lo que tiene en su portal, lo más reciente primero. Sin documentos en la
 * política de la clínica, nada. El comprobante es de la cuenta: sale si la
 * clínica también deja ver la cuenta.
 */
export async function collectPortalPapers(
  tx: Db,
  orgId: string,
  patientId: string,
  options: { account: boolean; since?: Date | null },
): Promise<PortalPaper[]> {
  const since = options.since ?? null
  const fresh = (at: Date) => (since ? at.getTime() > since.getTime() : false)
  // `arrived`: cuándo llegó a su portal; «Nuevo» se cuenta con ella, no con la fecha que se muestra
  // (una radiografía tomada hace un año y subida hoy es nueva para la persona).
  const papers: Array<Omit<PortalPaper, "at" | "isNew"> & { at: Date; arrived?: Date }> = []

  const recipes = await tx
    .select({
      id: prescription.id,
      number: prescription.prescriptionNumber,
      status: prescription.status,
      validUntil: prescription.validUntil,
      at: prescription.issuedAt,
    })
    .from(prescription)
    .where(and(eq(prescription.organizationId, orgId), eq(prescription.patientId, patientId)))
  const today = recipes.some((row) => row.validUntil) ? await clinicToday(tx, orgId) : ""
  for (const row of recipes) {
    papers.push({
      kind: "receta",
      id: row.id,
      type: "Receta",
      title: `Receta N.º ${row.number}`,
      at: row.at,
      stateWord:
        row.status === "anulada"
          ? "Anulada"
          : row.validUntil && row.validUntil < today
            ? "Vencida"
            : null,
      image: false,
    })
  }

  const orders = await tx
    .select({
      id: clinicalOrder.id,
      kind: clinicalOrder.kind,
      title: clinicalOrder.title,
      status: clinicalOrder.status,
      resultDocumentId: clinicalOrder.resultDocumentId,
      at: clinicalOrder.createdAt,
    })
    .from(clinicalOrder)
    .where(and(eq(clinicalOrder.organizationId, orgId), eq(clinicalOrder.patientId, patientId)))
  for (const row of orders) {
    papers.push({
      kind: "orden",
      id: row.id,
      type: ORDER_KIND_WORDS[row.kind] ?? "Orden",
      title: row.title,
      at: row.at,
      stateWord: row.status === "cancelado" ? "Anulada" : null,
      image: false,
    })
  }

  const leaves = await tx
    .select({
      id: medicalLeave.id,
      number: medicalLeave.leaveNumber,
      status: medicalLeave.status,
      at: medicalLeave.issuedAt,
    })
    .from(medicalLeave)
    .where(and(eq(medicalLeave.organizationId, orgId), eq(medicalLeave.patientId, patientId)))
  for (const row of leaves) {
    papers.push({
      kind: "descanso",
      id: row.id,
      type: "Descanso médico",
      title: `Descanso médico N.º ${row.number}`,
      at: row.at,
      stateWord: row.status === "anulado" ? "Anulado" : null,
      image: false,
    })
  }

  // La hoja de atención solo si ya se emitió: no una por cada atención firmada.
  const sheets = await tx
    .select({ id: issuedPaper.documentId, at: issuedPaper.createdAt })
    .from(issuedPaper)
    .where(
      and(
        eq(issuedPaper.organizationId, orgId),
        eq(issuedPaper.patientId, patientId),
        eq(issuedPaper.documentType, "attention_sheet"),
      ),
    )
  for (const row of sheets) {
    papers.push({
      kind: "hoja",
      id: row.id,
      type: ATTENTION_SHEET_LABEL,
      title: ATTENTION_SHEET_LABEL,
      at: row.at,
      stateWord: null,
      image: false,
    })
  }

  const consents = await tx
    .select({
      id: consentDocument.id,
      title: consentDocument.titleSnapshot,
      status: consentDocument.status,
      signedAt: consentDocument.signedAt,
      createdAt: consentDocument.createdAt,
      pdfDocumentId: consentDocument.pdfDocumentId,
      revokePdfDocumentId: consentDocument.revokePdfDocumentId,
      paperDocumentId: consentDocument.paperDocumentId,
    })
    .from(consentDocument)
    .where(and(eq(consentDocument.organizationId, orgId), eq(consentDocument.patientId, patientId)))
  // Lo que ya está dentro de otro papel no sale suelto (la misma regla que Documentos).
  const inside = new Set<string>()
  for (const row of consents) {
    for (const id of [row.pdfDocumentId, row.revokePdfDocumentId, row.paperDocumentId])
      if (id) inside.add(id)
    if (row.status !== "firmado" && row.status !== "revocado") continue
    papers.push({
      kind: "consentimiento",
      id: row.id,
      type: "Consentimiento",
      title: row.title,
      at: row.signedAt ?? row.createdAt,
      stateWord: row.status === "revocado" ? "Revocado" : null,
      image: false,
    })
  }

  if (options.account) {
    const tickets = await tx
      .select({
        id: paymentTicket.id,
        number: paymentTicket.ticketNumber,
        voidedAt: paymentTicket.voidedAt,
        at: paymentTicket.createdAt,
      })
      .from(paymentTicket)
      .where(and(eq(paymentTicket.organizationId, orgId), eq(paymentTicket.patientId, patientId)))
    for (const row of tickets) {
      papers.push({
        kind: "comprobante",
        id: row.id,
        type: "Comprobante",
        title: `Comprobante N.º ${String(row.number).padStart(6, "0")}`,
        at: row.at,
        stateWord: row.voidedAt ? "Anulado" : null,
        image: false,
      })
    }
  }

  const files = await tx
    .select({
      id: patientDocument.id,
      category: patientDocument.category,
      label: patientDocument.label,
      imageType: patientDocument.imageType,
      reportStatus: patientDocument.reportStatus,
      contentType: patientDocument.contentType,
      at: patientDocument.createdAt,
      capturedAt: patientDocument.capturedAt,
    })
    .from(patientDocument)
    .where(
      and(
        eq(patientDocument.organizationId, orgId),
        eq(patientDocument.patientId, patientId),
        isNull(patientDocument.retiredAt),
        isNull(patientDocument.portalHiddenAt),
      ),
    )
  // El resultado de una orden sale como archivo propio: el PDF de la orden es la
  // solicitud guardada al emitirla y no lo lleva.
  const foreign = await filesOfOthers(tx, orgId, patientId, files.map((file) => file.id))
  for (const file of files) {
    if (inside.has(file.id) || foreign.has(file.id)) continue
    // La tomografía y el DICOM no van al portal en esta entrega: no se abren en el teléfono.
    if (notForPhone(file)) continue
    const image = IMAGE_CATEGORIES.has(file.category)
    // Una imagen se ve con su informe terminado o si no lo requiere: el hallazgo, primero con quien lo explica.
    if (image && file.reportStatus === "pendiente") continue
    papers.push({
      kind: "archivo",
      id: file.id,
      type: FILE_TYPE_WORDS[file.category] ?? "Archivo",
      title: file.label,
      at: file.capturedAt ?? file.at,
      arrived: file.at,
      stateWord: null,
      image,
    })
  }

  return papers
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .map(({ arrived, ...paper }) => ({ ...paper, at: paper.at.toISOString(), isNew: fresh(arrived ?? paper.at) }))
}

/** La tomografía y el DICOM: el teléfono no los abre. */
function notForPhone(file: { imageType: string | null; contentType: string }): boolean {
  return file.imageType === "tomografia" || /dicom/i.test(file.contentType)
}

/**
 * Archivos de la ficha que no son de la persona para su portal: la prueba de
 * una representación (el DNI del representante, una resolución) y lo ligado a
 * un pago (un voucher). Los ve el equipo, no el portal.
 */
async function filesOfOthers(
  tx: Db,
  orgId: string,
  patientId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const evidence = await tx
    .select({ id: patientResponsibility.evidenceDocumentId })
    .from(patientResponsibility)
    .where(
      and(
        eq(patientResponsibility.organizationId, orgId),
        eq(patientResponsibility.patientId, patientId),
        isNotNull(patientResponsibility.evidenceDocumentId),
      ),
    )
  const contexts = await tx
    .selectDistinctOn([patientDocumentContext.documentId], {
      documentId: patientDocumentContext.documentId,
      paymentId: patientDocumentContext.paymentId,
    })
    .from(patientDocumentContext)
    .where(
      and(
        eq(patientDocumentContext.organizationId, orgId),
        eq(patientDocumentContext.patientId, patientId),
        inArray(patientDocumentContext.documentId, ids),
      ),
    )
    .orderBy(patientDocumentContext.documentId, desc(patientDocumentContext.version))
  return new Set([
    ...evidence.map((row) => row.id).filter((id): id is string => !!id),
    ...contexts.filter((row) => row.paymentId).map((row) => row.documentId),
  ])
}

/** Cómo está un archivo de la ficha respecto de su portal: lo dice el servidor, con la misma regla. */
export type DocumentPortalStateKind = "visible" | "oculto" | "espera_informe" | "no_va" | "apagado" | "retirado"

export interface DocumentPortalState {
  state: DocumentPortalStateKind
  /** Lo que dice la ficha, en palabras de la clínica. */
  words: string
  /** Tiene sentido «No mostrar en su portal» / «Mostrar en su portal». */
  canHide: boolean
}

/**
 * Si un archivo de la ficha se ve en el portal de la persona, con la misma
 * regla que arma «Tus documentos» (`collectPortalPapers`): la ficha no lo
 * deduce por su cuenta.
 */
export async function documentPortalState(
  tx: Db,
  orgId: string,
  patientId: string,
  documentId: string,
): Promise<DocumentPortalState> {
  const [file] = await tx
    .select()
    .from(patientDocument)
    .where(
      and(
        eq(patientDocument.organizationId, orgId),
        eq(patientDocument.patientId, patientId),
        eq(patientDocument.id, documentId),
      ),
    )
    .limit(1)
  if (!file) throw new ServiceError("NOT_FOUND", 404, "Documento no encontrado")
  if (file.retiredAt) return { state: "retirado", words: "Retirado: no va a su portal", canHide: false }
  const consents = await tx
    .select({
      pdf: consentDocument.pdfDocumentId,
      revoke: consentDocument.revokePdfDocumentId,
      paper: consentDocument.paperDocumentId,
    })
    .from(consentDocument)
    .where(and(eq(consentDocument.organizationId, orgId), eq(consentDocument.patientId, patientId)))
  if (consents.some((row) => [row.pdf, row.revoke, row.paper].includes(file.id)))
    return { state: "no_va", words: "Va dentro de su consentimiento, no suelto", canHide: false }
  if ((await filesOfOthers(tx, orgId, patientId, [file.id])).has(file.id))
    return { state: "no_va", words: "Es de otra persona o de un pago: no va a su portal", canHide: false }
  if (notForPhone(file))
    return { state: "no_va", words: "No va a su portal: no se abre en el teléfono", canHide: false }
  if (file.portalHiddenAt) return { state: "oculto", words: "Oculto en su portal", canHide: true }
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled || !policy.allowedScope.documents)
    return { state: "apagado", words: "La clínica no muestra documentos en el portal", canHide: true }
  if (IMAGE_CATEGORIES.has(file.category) && file.reportStatus === "pendiente")
    return { state: "espera_informe", words: "Se verá en su portal cuando tenga su informe", canHide: true }
  return { state: "visible", words: "Se ve en su portal", canHide: true }
}

function papersAllowed(ctx: PortalContext): boolean {
  return ctx.session.scope?.papers === true
}

/** «Tus documentos»: todo lo suyo, lo más reciente primero, con lo nuevo desde su visita anterior. */
export async function listPortalPapers(tx: Db, ctx: PortalContext): Promise<PortalPaper[]> {
  if (!papersAllowed(ctx)) return []
  const since = await previousVisitAt(tx, ctx)
  const papers = await collectPortalPapers(tx, ctx.orgId, ctx.session.patientId, {
    account: ctx.session.scope?.account === true,
    since,
  })
  await tx.insert(portalAccessLog).values({
    organizationId: ctx.orgId,
    sessionId: ctx.session.id,
    action: "papers.listed",
  })
  return papers
}

/** El papel tiene que estar en su lista, con las mismas reglas: lo que no está, no existe. */
async function requirePortalPaper(
  tx: Db,
  ctx: PortalContext,
  kind: string,
  id: string,
): Promise<PortalPaper> {
  const unavailable = () =>
    new ServiceError("PORTAL_FORBIDDEN", 404, "Este documento no está en tu portal")
  if (!papersAllowed(ctx) || !isPortalPaperKind(kind)) throw unavailable()
  const papers = await collectPortalPapers(tx, ctx.orgId, ctx.session.patientId, {
    account: ctx.session.scope?.account === true,
  })
  const paper = papers.find((item) => item.kind === kind && item.id === id)
  if (!paper) throw unavailable()
  return paper
}

async function tracePaperRead(tx: Db, ctx: PortalContext, paper: PortalPaper): Promise<void> {
  // A nombre de la persona, nunca de quien le dio el acceso.
  await tx.insert(auditEvent).values({
    organizationId: ctx.orgId,
    actorUserId: `contact:${ctx.session.contactId}`,
    action: "portal.document_read",
    entity: paper.kind === "archivo" ? "patient_document" : `portal_paper:${paper.kind}`,
    entityId: paper.id,
    // Quién emitió el acceso con el que se leyó: la lectura es de la persona, pero se sabe por dónde entró.
    metadata: {
      sessionId: ctx.session.id,
      contactId: ctx.session.contactId,
      kind: paper.kind,
      issuedBy: ctx.session.issuedBy,
    },
  })
  await tx.insert(portalAccessLog).values({
    organizationId: ctx.orgId,
    sessionId: ctx.session.id,
    action: "document.read",
    entityType: paper.kind,
    entityId: paper.id,
  })
}

const HEALTH_TYPE_OF: Partial<
  Record<PortalPaperKind, "prescription" | "order" | "medical_leave" | "attention_sheet" | "consent">
> = {
  receta: "prescription",
  orden: "order",
  descanso: "medical_leave",
  hoja: "attention_sheet",
  consentimiento: "consent",
}

/**
 * El PDF de un papel de su portal: el mismo que ve el equipo, con «ANULADA»
 * encima si se anuló y, de un consentimiento revocado, el de la revocación. El
 * nombre del archivo es neutro: se ve en la notificación del teléfono.
 */
export async function getPortalPaperPdf(
  tx: Db,
  ctx: PortalContext,
  kind: string,
  id: string,
  storage: PaperStorage,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const paper = await requirePortalPaper(tx, ctx, kind, id)
  if (paper.kind === "archivo")
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "Este documento no está en tu portal")
  await tracePaperRead(tx, ctx, paper)
  if (paper.kind === "comprobante") {
    const snap = await buildTicketSnapshot(tx, ctx.orgId, ctx.session.patientId, paper.id)
    return { bytes: await renderTicketPdf(snap, null), filename: `Comprobante-${snap.numberLabel}.pdf` }
  }
  const type = HEALTH_TYPE_OF[paper.kind]
  if (!type) throw new ServiceError("PORTAL_FORBIDDEN", 404, "Este documento no está en tu portal")
  const rendered = await renderHealthDocumentPdf(
    tx,
    ctx.orgId,
    ctx.session.patientId,
    type,
    paper.id,
    storage,
    { viewing: true },
  )
  return { bytes: rendered.bytes, filename: rendered.filename }
}

/** Un archivo subido o una imagen de su portal: una dirección firmada de 5 minutos. */
export async function getPortalPaperFileUrl(
  tx: Db,
  ctx: PortalContext,
  id: string,
  storage: Pick<Storage, "attachmentUrl">,
): Promise<{ url: string; expiresInSeconds: number }> {
  const paper = await requirePortalPaper(tx, ctx, "archivo", id)
  const [file] = await tx
    .select({ storageKey: patientDocument.storageKey })
    .from(patientDocument)
    .where(and(eq(patientDocument.organizationId, ctx.orgId), eq(patientDocument.id, paper.id)))
    .limit(1)
  if (!file) throw new ServiceError("PORTAL_FORBIDDEN", 404, "Este documento no está en tu portal")
  await tracePaperRead(tx, ctx, paper)
  const expiresInSeconds = 300
  return { url: await storage.attachmentUrl(file.storageKey, expiresInSeconds), expiresInSeconds }
}

