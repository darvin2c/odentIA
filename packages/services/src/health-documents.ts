/**
 * Papeles de salud de la atención para la persona: receta, orden y
 * consentimiento firmado (ADR 0033; decisión 3 de la fase 3).
 *
 * - Solo a la propia persona (si es mayor de edad) o a su representante legal
 *   vigente, nunca a otro número ni a un responsable económico: es información
 *   de salud.
 * - WhatsApp primero (el de su ficha, con la conversación abierta); sin
 *   WhatsApp, por correo; sin ninguno de los dos, solo se imprime y se dice.
 *   Una receta pasadas las 24 horas de WhatsApp sale con «Su enlace», la
 *   plantilla ya aprobada, y se descarga en «Tus papeles» (decisión 8).
 * - El envío es el mismo de los documentos de cobro (`deliverDocumentPdf`): el
 *   PDF queda en la conversación de la persona y vuelve encolado; el worker lo
 *   entrega. Encolado nunca se presenta como entregado.
 */
import type { Db } from "@odentia/db"
import { patientContact, patientResponsibility } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, eq, isNull, sql } from "drizzle-orm"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { getConsentPrint, getOrderPrint } from "./clinical-forms.js"
import { renderConsentPdf } from "./consent-pdf.js"
import { notFound, ServiceError, validation } from "./errors.js"
import {
  deliverDocumentPdf,
  type DocumentChannelOption,
  documentChannelsFor,
  requireDocumentConnection,
  type SendDeps,
} from "./financial-documents.js"
import { NEUTRAL_LOCALE, NEUTRAL_TIMEZONE } from "./locale.js"
import { requirePatient } from "./patients.js"
import { MUTED, safe, when, Writer, type Zone } from "./pdf-writer.js"
import { getPrescriptionPrint } from "./prescriptions.js"
import { sendPersonalLink } from "./su-enlace.js"

export const HEALTH_DOCUMENT_TYPES = ["prescription", "order", "consent"] as const
export type HealthDocumentType = (typeof HEALTH_DOCUMENT_TYPES)[number]

function assertHealthType(value: string): HealthDocumentType {
  if ((HEALTH_DOCUMENT_TYPES as readonly string[]).includes(value)) return value as HealthDocumentType
  throw validation("Documento inválido: receta, orden o consentimiento")
}

export interface HealthDocumentRecipient {
  contactId: string
  displayName: string
  relation: "paciente" | "representante_legal"
  email: string | null
  phone: string | null
  isDefault: boolean
}

function ageOn(birthDate: string, on: Date): number {
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number]
  let age = on.getUTCFullYear() - y
  const month = on.getUTCMonth() + 1
  if (month < m || (month === m && on.getUTCDate() < d)) age -= 1
  return age
}

/**
 * Quién puede recibir un papel de salud: la propia persona si es mayor de edad
 * y su representante legal vigente. Un menor no lo recibe en su propio chat.
 */
export async function listHealthDocumentRecipients(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<HealthDocumentRecipient[]> {
  const subject = await requirePatient(tx, orgId, patientId)
  const minor = subject.birthDate ? ageOn(subject.birthDate, new Date()) < 18 : false
  const today = new Date().toISOString().slice(0, 10)
  const out: HealthDocumentRecipient[] = []
  if (!minor) {
    const [self] = await tx
      .select({ contact })
      .from(patientContact)
      .innerJoin(contact, and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, orgId)))
      .where(
        and(
          eq(patientContact.organizationId, orgId),
          eq(patientContact.patientId, patientId),
          eq(patientContact.relationship, "self"),
          eq(contact.isActive, true),
        ),
      )
      .limit(1)
    if (self)
      out.push({
        contactId: self.contact.id,
        displayName: self.contact.displayName,
        relation: "paciente",
        email: self.contact.email,
        phone: self.contact.phone,
        isDefault: false,
      })
  }
  const representatives = await tx
    .select({ contact })
    .from(patientResponsibility)
    .innerJoin(contact, and(eq(contact.id, patientResponsibility.contactId), eq(contact.organizationId, orgId)))
    .where(
      and(
        eq(patientResponsibility.organizationId, orgId),
        eq(patientResponsibility.patientId, patientId),
        eq(patientResponsibility.kind, "representante_legal"),
        isNull(patientResponsibility.revokedAt),
        sql`${patientResponsibility.startsAt} <= ${today}`,
        sql`(${patientResponsibility.endsAt} IS NULL OR ${patientResponsibility.endsAt} >= ${today})`,
        eq(contact.isActive, true),
      ),
    )
  for (const row of representatives) {
    if (out.some((r) => r.contactId === row.contact.id)) continue
    out.push({
      contactId: row.contact.id,
      displayName: row.contact.displayName,
      relation: "representante_legal",
      email: row.contact.email,
      phone: row.contact.phone,
      isDefault: false,
    })
  }
  if (out[0]) out[0].isDefault = true
  return out
}

/** WhatsApp primero; sin WhatsApp, el correo. Ningún otro canal lleva papeles de salud. */
/** Lo que dice la opción de WhatsApp de una receta pasadas las 24 horas. */
export const RECIPE_BY_LINK = "Pasaron 24 horas: le llega «Su enlace» y descarga la receta en «Tus papeles»"

/**
 * Una receta fuera de las 24 horas de WhatsApp no espera a que la persona
 * escriba: sale «Su enlace» (ya aprobado) y la receta queda en «Tus papeles».
 */
function viaPersonalLink(option: DocumentChannelOption): DocumentChannelOption {
  if (option.channel !== "whatsapp" || option.usable || !option.reason?.startsWith("Fuera de la ventana")) return option
  return { ...option, usable: true, reason: RECIPE_BY_LINK }
}

export function proposeHealthChannel<T extends { channel: string; usable: boolean }>(options: T[]): T | null {
  return (
    options.find((o) => o.channel === "whatsapp" && o.usable) ??
    options.find((o) => o.channel === "email" && o.usable) ??
    null
  )
}

export interface HealthDocumentSendOptions {
  recipients: HealthDocumentRecipient[]
  recipient: HealthDocumentRecipient | null
  /** Solo WhatsApp y correo, con si sirven y por qué no. */
  channels: DocumentChannelOption[]
  proposed: DocumentChannelOption | null
  document: { type: HealthDocumentType; label: string }
  message: string
  /** Sin nadie a quien enviarlo o sin canal: solo se imprime, y por qué. */
  printOnly: string | null
}

interface HealthDocumentMeta {
  label: string
  /** Lo que se dice en el mensaje: «tu receta», «la orden de Mateo». */
  own: string
  other: string
}

async function loadHealthMeta(
  tx: Db,
  orgId: string,
  patientId: string,
  type: HealthDocumentType,
  documentId: string,
): Promise<HealthDocumentMeta> {
  if (type === "prescription") {
    const print = await getPrescriptionPrint(tx, orgId, patientId, documentId)
    if (print.prescription.status !== "emitida") throw validation("La receta está anulada: no se envía")
    return { label: `Receta N.º ${print.prescription.prescriptionNumber}`, own: "tu receta", other: "la receta" }
  }
  if (type === "order") {
    const print = await getOrderPrint(tx, orgId, documentId)
    if (print.order.patientId !== patientId) throw notFound("Orden")
    if (print.order.status === "cancelado") throw validation("La orden está cancelada: no se envía")
    return { label: `Orden · ${print.order.title}`, own: "tu orden", other: "la orden" }
  }
  const print = await getConsentPrint(tx, orgId, documentId)
  if (print.document.patientId !== patientId) throw notFound("Consentimiento")
  if (print.document.status !== "firmado")
    throw validation("Solo se envía un consentimiento firmado")
  return {
    label: `Consentimiento · ${print.document.titleSnapshot}`,
    own: "tu consentimiento firmado",
    other: "el consentimiento firmado",
  }
}

function proposeHealthMessage(
  meta: HealthDocumentMeta,
  recipient: HealthDocumentRecipient,
  patientName: string,
  clinicName: string,
): string {
  const where = clinicName ? ` de ${clinicName}` : ""
  return (
    recipient.relation === "paciente"
      ? `Hola, ${recipient.displayName}. Te enviamos ${meta.own}${where}.`
      : `Hola, ${recipient.displayName}. Te enviamos ${meta.other} de ${patientName}${where}.`
  ).slice(0, 500)
}

export async function getHealthDocumentSendOptions(
  tx: Db,
  orgId: string,
  patientId: string,
  input: { documentType: string; documentId: string; recipientContactId?: string },
): Promise<HealthDocumentSendOptions> {
  const type = assertHealthType(input.documentType)
  const meta = await loadHealthMeta(tx, orgId, patientId, type, input.documentId)
  const recipients = await listHealthDocumentRecipients(tx, orgId, patientId)
  const document = { type, label: meta.label }
  const recipient =
    (input.recipientContactId && recipients.find((r) => r.contactId === input.recipientContactId)) ||
    recipients.find((r) => r.isDefault) ||
    null
  if (!recipient) {
    return {
      recipients,
      recipient: null,
      channels: [],
      proposed: null,
      document,
      message: "",
      printOnly: "Es menor de edad y no tiene representante legal vigente: solo se puede imprimir",
    }
  }
  const { channels: all } = await documentChannelsFor(tx, orgId, recipient)
  const channels = all
    .filter((option) => option.channel === "whatsapp" || option.channel === "email")
    .map((option) => (type === "prescription" ? viaPersonalLink(option) : option))
  const proposed = proposeHealthChannel(channels)
  if (proposed) proposed.isProposed = true
  const person = await requirePatient(tx, orgId, patientId)
  const [profile] = await tx
    .select({ tradeName: orgProfile.tradeName, legalName: orgProfile.legalName })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  return {
    recipients,
    recipient,
    channels,
    proposed,
    document,
    message: proposeHealthMessage(meta, recipient, person.displayName, profile?.tradeName || profile?.legalName || ""),
    printOnly: proposed
      ? null
      : `${recipient.displayName} no tiene WhatsApp ni correo por donde enviarlo: solo se puede imprimir`,
  }
}

// --- PDF -----------------------------------------------------------------------

async function newWriter(title: string): Promise<{ pdf: PDFDocument; w: Writer }> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(safe(title))
  pdf.setProducer("odentIA")
  const w = new Writer(
    pdf,
    await pdf.embedFont(StandardFonts.Helvetica),
    await pdf.embedFont(StandardFonts.HelveticaBold),
  )
  return { pdf, w }
}

interface Establishment {
  legalName: string | null
  tradeName: string | null
  fiscalDocType: string | null
  fiscalDocNumber: string | null
  address: string | null
  locale?: string | null
  timezone?: string | null
}

function header(w: Writer, establishment: Establishment | null) {
  if (!establishment) return
  w.text(establishment.tradeName ?? establishment.legalName ?? "", { size: 12, bold: true })
  w.text(
    [
      establishment.legalName,
      establishment.fiscalDocNumber &&
        [establishment.fiscalDocType, establishment.fiscalDocNumber].filter(Boolean).join(" "),
      establishment.address,
    ]
      .filter(Boolean)
      .join(" · "),
    { size: 8, color: MUTED },
  )
  w.gap()
}

function patientLine(person: {
  displayName: string
  patientNumber: number
  docType: string | null
  docNumber: string | null
  birthDate: string | null
}): string {
  return `Paciente: ${person.displayName} · HC ${String(person.patientNumber).padStart(6, "0")}${
    person.docNumber ? ` · ${person.docType ?? ""} ${person.docNumber}` : ""
  }${person.birthDate ? ` · nacimiento ${person.birthDate}` : ""}`
}

function zoneOf(establishment: Establishment | null): Zone {
  return {
    locale: establishment?.locale || NEUTRAL_LOCALE,
    timezone: establishment?.timezone || NEUTRAL_TIMEZONE,
  }
}

/** PDF de la receta: lo mismo que su hoja impresa. */
export async function renderPrescriptionPdf(data: Awaited<ReturnType<typeof getPrescriptionPrint>>) {
  const { prescription: rx, patient: person, establishment } = data
  const zone = zoneOf(establishment)
  const { pdf, w } = await newWriter(`Receta ${rx.prescriptionNumber}`)
  header(w, establishment)
  w.text("RECETA", { size: 9, bold: true, color: MUTED })
  w.text(`Receta N.º ${rx.prescriptionNumber}`, { size: 15, bold: true })
  w.text(`Emitida ${when(rx.issuedAt, zone)}`, { size: 8, color: MUTED })
  w.gap()
  w.text(patientLine(person))
  if (rx.diagnosisCode) w.text(`Diagnóstico: ${rx.diagnosisCode} ${data.diagnosisDescription ?? ""}`.trim())
  w.heading("Medicamentos")
  for (const item of rx.items) {
    w.text(
      `${item.genericName ?? item.medicationName}${item.strength ? ` ${item.strength}` : ""}${
        item.dosageForm ? ` · ${item.dosageForm}` : ""
      }${item.brandName ? ` (${item.brandName})` : ""}`,
      { bold: true },
    )
    w.text(
      `${item.dose} · vía ${item.route} · ${item.frequency} · ${item.duration}${
        item.quantity ? ` · cantidad ${item.quantity}` : ""
      }`,
      { indent: 10 },
    )
    if (item.instructions) w.text(item.instructions, { indent: 10 })
  }
  if (rx.notes) {
    w.heading("Indicaciones")
    w.text(rx.notes)
  }
  if (rx.validUntil) w.text(`Válida hasta ${rx.validUntil}`, { size: 9 })
  w.gap(14)
  w.text(
    `${rx.prescriberName ?? "-"}${rx.prescriberTitle ? ` · ${rx.prescriberTitle}` : ""}${
      rx.prescriberRegistration ? ` · ${rx.prescriberRegistration}` : ""
    }`,
    { size: 9, bold: true },
  )
  w.text("Firma con su perfil profesional.", { size: 8, color: MUTED })
  return pdf.save({ useObjectStreams: false })
}

const ORDER_KIND_WORDS: Record<string, string> = {
  imagen: "Orden de imagen",
  laboratorio: "Orden de laboratorio",
  interconsulta: "Derivación",
}

/** PDF de la orden: lo mismo que su hoja impresa. */
export async function renderOrderPdf(data: Awaited<ReturnType<typeof getOrderPrint>>) {
  const { order, patient: person, establishment, requestedBy } = data
  const zone = zoneOf(establishment)
  const kind = ORDER_KIND_WORDS[order.kind] ?? "Orden"
  const { pdf, w } = await newWriter(`${kind} · ${order.title}`)
  header(w, establishment)
  w.text(kind.toUpperCase(), { size: 9, bold: true, color: MUTED })
  w.text(order.title, { size: 15, bold: true })
  w.text(`Pedida ${when(order.createdAt, zone)}`, { size: 8, color: MUTED })
  w.gap()
  w.text(patientLine(person))
  w.text(`Para: ${order.recipient}`)
  if (order.diagnosisCode) w.text(`Diagnóstico: ${order.diagnosisCode} ${data.diagnosisDescription ?? ""}`.trim())
  if (order.detail) {
    w.heading("Detalle")
    w.text(order.detail)
  }
  w.gap(14)
  if (requestedBy) {
    w.text(
      `${requestedBy.name}${requestedBy.title ? ` · ${requestedBy.title}` : ""}${
        requestedBy.registration ? ` · ${requestedBy.registration}` : ""
      }`,
      { size: 9, bold: true },
    )
    w.text("Pide con su perfil profesional.", { size: 8, color: MUTED })
  }
  return pdf.save({ useObjectStreams: false })
}

/** El PDF de un papel de salud, para enviarlo; imprimir usa su hoja en pantalla. */
export async function renderHealthDocumentPdf(
  tx: Db,
  orgId: string,
  patientId: string,
  type: HealthDocumentType,
  documentId: string,
): Promise<{ bytes: Uint8Array; filename: string; label: string }> {
  if (type === "prescription") {
    const data = await getPrescriptionPrint(tx, orgId, patientId, documentId)
    return {
      bytes: await renderPrescriptionPdf(data),
      filename: `Receta-${data.prescription.prescriptionNumber}.pdf`,
      label: `Receta N.º ${data.prescription.prescriptionNumber}`,
    }
  }
  if (type === "order") {
    const data = await getOrderPrint(tx, orgId, documentId)
    if (data.order.patientId !== patientId) throw notFound("Orden")
    return {
      bytes: await renderOrderPdf(data),
      filename: `Orden-${data.order.title}.pdf`,
      label: `${ORDER_KIND_WORDS[data.order.kind] ?? "Orden"} · ${data.order.title}`,
    }
  }
  const data = await getConsentPrint(tx, orgId, documentId)
  if (data.document.patientId !== patientId) throw notFound("Consentimiento")
  return {
    bytes: await renderConsentPdf(data),
    filename: `Consentimiento-${data.document.titleSnapshot}.pdf`,
    label: `Consentimiento · ${data.document.titleSnapshot}`,
  }
}

// --- Envío ---------------------------------------------------------------------

export interface SendHealthDocumentInput {
  patientId: string
  documentType: string
  documentId: string
  recipientContactId?: string
  connectionId: string
  message?: string
  /** Clave del intento: reenviar con la misma no manda el papel dos veces. */
  requestId?: string | null
}

export interface SendHealthDocumentResult {
  conversationId: string
  messageId: string
  /** Siempre `encolado` al responder: el worker entrega por el adaptador real. */
  status: "queued"
  channel: string
  documentLabel: string
  recipientName: string
}

export async function sendHealthDocument(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: SendHealthDocumentInput,
  /** `secretsKey`: para «Su enlace» cuando una receta sale pasadas las 24 horas. */
  deps: SendDeps & { secretsKey?: Buffer },
): Promise<SendHealthDocumentResult> {
  const type = assertHealthType(input.documentType)
  if (!input.connectionId) throw validation("Elige por dónde enviarlo")
  const meta = await loadHealthMeta(tx, orgId, input.patientId, type, input.documentId)
  if (input.requestId) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('health-doc-send:' || ${orgId} || ':' || ${input.requestId}))`,
    )
    const [previous] = await tx
      .select({ entityId: auditEvent.entityId, metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.organizationId, orgId),
          eq(auditEvent.action, "health_document.sent"),
          sql`${auditEvent.metadata}->>'requestId' = ${input.requestId}`,
        ),
      )
      .limit(1)
    if (previous) {
      const sent = previous.metadata as {
        documentId?: string
        conversationId?: string
        channel?: string
        recipientName?: string
      }
      if (sent.documentId !== input.documentId)
        throw new ServiceError("REQUEST_ID_CONFLICT", 409, "Esa clave de envío ya se usó con otro documento")
      return {
        conversationId: sent.conversationId ?? "",
        messageId: previous.entityId ?? "",
        status: "queued",
        channel: sent.channel ?? "",
        documentLabel: meta.label,
        recipientName: sent.recipientName ?? "",
      }
    }
  }
  const recipients = await listHealthDocumentRecipients(tx, orgId, input.patientId)
  const recipient = input.recipientContactId
    ? recipients.find((r) => r.contactId === input.recipientContactId)
    : recipients.find((r) => r.isDefault)
  if (!recipient) {
    throw new ServiceError(
      "DOCUMENT_RECIPIENT_NOT_AUTHORIZED",
      403,
      "Un papel de salud solo se envía a la propia persona o a su representante legal",
    )
  }
  const conn = await requireDocumentConnection(tx, orgId, input.connectionId)
  if (conn.channel !== "whatsapp" && conn.channel !== "email")
    throw validation("Un papel de salud se envía por WhatsApp o por correo")
  // Receta pasadas las 24 horas: «Su enlace» y la descarga en «Tus papeles» (decisión 8).
  if (type === "prescription" && conn.channel === "whatsapp" && deps.secretsKey) {
    const { channels } = await documentChannelsFor(tx, orgId, recipient)
    const option = channels.find((item) => item.connectionId === conn.id)
    if (option && viaPersonalLink(option).reason === RECIPE_BY_LINK) {
      const sent = await sendPersonalLink(
        tx,
        orgId,
        actorUserId,
        { patientId: input.patientId, ...(input.requestId ? { requestId: input.requestId } : {}) },
        { secretsKey: deps.secretsKey },
      )
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId,
        action: "health_document.sent",
        entity: "message",
        entityId: sent.messageId,
        metadata: {
          patientId: input.patientId,
          documentType: type,
          documentId: input.documentId,
          recipientContactId: sent.recipientName ? recipient.contactId : null,
          recipientName: sent.recipientName,
          conversationId: sent.conversationId,
          channel: sent.channel,
          via: "su_enlace",
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
      })
      return {
        conversationId: sent.conversationId,
        messageId: sent.messageId,
        status: "queued",
        channel: sent.channel,
        documentLabel: meta.label,
        recipientName: sent.recipientName,
      }
    }
  }
  const rendered = await renderHealthDocumentPdf(tx, orgId, input.patientId, type, input.documentId)
  const message = input.message?.trim()
  if (message && message.length > 500) throw validation("El mensaje admite hasta 500 caracteres")
  const person = await requirePatient(tx, orgId, input.patientId)
  const [profile] = await tx
    .select({ tradeName: orgProfile.tradeName, legalName: orgProfile.legalName })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  const clinic = profile?.tradeName || profile?.legalName || ""
  const body = message || proposeHealthMessage(meta, recipient, person.displayName, clinic)
  const { conversationId, messageId } = await deliverDocumentPdf(
    tx,
    orgId,
    actorUserId,
    {
      recipient,
      conn,
      pdf: rendered.bytes,
      filename: rendered.filename,
      // La primera línea es el asunto del correo en frío.
      caption: `${rendered.label}${clinic ? ` · ${clinic}` : ""}\n\n${body}`,
    },
    deps,
  )
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "health_document.sent",
    entity: "message",
    entityId: messageId,
    metadata: {
      patientId: input.patientId,
      documentType: type,
      documentId: input.documentId,
      recipientContactId: recipient.contactId,
      recipientName: recipient.displayName,
      relation: recipient.relation,
      connectionId: conn.id,
      conversationId,
      channel: conn.channel,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    },
  })
  return {
    conversationId,
    messageId,
    status: "queued",
    channel: conn.channel,
    documentLabel: meta.label,
    recipientName: recipient.displayName,
  }
}
