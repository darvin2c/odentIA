/**
 * Papeles de salud de la atención para la persona: receta, orden,
 * consentimiento firmado y descanso médico (ADR 0033; decisión 3 de la fase 3;
 * issue 229, decisión 8).
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
import { createHash } from "node:crypto"
import type { Db } from "@odentia/db"
import { patientDocument } from "@odentia/db/schema/clinical"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, eq, isNull, sql } from "drizzle-orm"
import { getConsentPrint, getOrderPrint } from "./clinical-forms.js"
import {
  ORDER_KIND_WORDS,
  renderMedicalLeavePdf,
  renderOrderPdf,
  renderPrescriptionPdf,
} from "./clinical-papers.js"
import { renderConsentPaperPdf, renderConsentPdf } from "./consent-pdf.js"
import { type CheckableDocument, documentCheckUrl } from "./document-check.js"
import { loadDocumentClinic } from "./document-clinic.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import {
  type DocumentChannelOption,
  deliverDocumentPdf,
  documentChannelsFor,
  requireDocumentConnection,
  type SendDeps,
} from "./financial-documents.js"
import { getMedicalLeavePrint } from "./medical-leaves.js"
import { requirePatient } from "./patients.js"
import { getPrescriptionPrint } from "./prescriptions.js"
import { type DecisionRecipient, listDecisionRecipients } from "./responsibilities.js"
import type { Storage } from "./storage.js"
import { sendPersonalLink } from "./su-enlace.js"

export const HEALTH_DOCUMENT_TYPES = ["prescription", "order", "consent", "medical_leave"] as const
export type HealthDocumentType = (typeof HEALTH_DOCUMENT_TYPES)[number]

function assertHealthType(value: string): HealthDocumentType {
  if ((HEALTH_DOCUMENT_TYPES as readonly string[]).includes(value))
    return value as HealthDocumentType
  throw validation("Documento inválido: receta, orden, consentimiento o descanso médico")
}

export type HealthDocumentRecipient = DecisionRecipient

/**
 * Quién puede recibir un papel de salud: la regla única de a quién se le
 * manda algo (`listDecisionRecipients`): la propia persona si es mayor de
 * edad y su representante legal vigente. Un menor no lo recibe en su propio
 * chat, y al cumplir 18 deja de recibirlo quien lo representó de niño.
 */
export function listHealthDocumentRecipients(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<HealthDocumentRecipient[]> {
  return listDecisionRecipients(tx, orgId, patientId)
}

/** WhatsApp primero; sin WhatsApp, el correo. Ningún otro canal lleva papeles de salud. */
/** Lo que dice la opción de WhatsApp de una receta pasadas las 24 horas. */
export const RECIPE_BY_LINK =
  "Pasaron 24 horas: le llega «Su enlace» y descarga la receta en «Tus papeles»"

/**
 * Una receta fuera de las 24 horas de WhatsApp no espera a que la persona
 * escriba: sale «Su enlace» (ya aprobado) y la receta queda en «Tus papeles».
 */
function viaPersonalLink(option: DocumentChannelOption): DocumentChannelOption {
  if (
    option.channel !== "whatsapp" ||
    option.usable ||
    !option.reason?.startsWith("Fuera de la ventana")
  )
    return option
  return { ...option, usable: true, reason: RECIPE_BY_LINK }
}

export function proposeHealthChannel<T extends { channel: string; usable: boolean }>(
  options: T[],
): T | null {
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
    if (print.prescription.status !== "emitida")
      throw validation("La receta está anulada: no se envía")
    return {
      label: `Receta N.º ${print.prescription.prescriptionNumber}`,
      own: "tu receta",
      other: "la receta",
    }
  }
  if (type === "medical_leave") {
    const print = await getMedicalLeavePrint(tx, orgId, patientId, documentId)
    if (print.leave.status !== "emitido")
      throw validation("El descanso médico está anulado: no se envía")
    return {
      label: `Descanso médico N.º ${print.leave.leaveNumber}`,
      own: "tu descanso médico",
      other: "el descanso médico",
    }
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
    (input.recipientContactId &&
      recipients.find((r) => r.contactId === input.recipientContactId)) ||
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
    message: proposeHealthMessage(
      meta,
      recipient,
      person.displayName,
      profile?.tradeName || profile?.legalName || "",
    ),
    printOnly: proposed
      ? null
      : `${recipient.displayName} no tiene WhatsApp ni correo por donde enviarlo: solo se puede imprimir`,
  }
}

// --- PDF -----------------------------------------------------------------------

const CHECK_TYPE: Record<HealthDocumentType, CheckableDocument> = {
  prescription: "prescription",
  order: "order",
  medical_leave: "medical_leave",
  consent: "consent",
}

/**
 * El PDF de un papel de salud: el mismo para enviarlo, para «Tus papeles» y para
 * que el equipo lo vea. Receta, orden y descanso se generan, con su sello si se
 * anularon (enviarlos sigue prohibido: `loadHealthMeta`). El consentimiento firmado
 * es el guardado, el de la huella; el pendiente es la hoja para firmar en papel o,
 * si ya lo firmó en su enlace, lo que firmó, a la espera de que lo confirmen.
 */
export async function renderHealthDocumentPdf(
  tx: Db,
  orgId: string,
  patientId: string,
  type: HealthDocumentType,
  documentId: string,
  /** Para leer el consentimiento guardado; receta y orden no lo usan. */
  storage: Pick<Storage, "getAttachment"> = {},
  /** Para verlo el equipo: lo que no tiene PDF guardado se genera al vuelo, sin guardarlo. */
  options: { viewing?: boolean } = {},
): Promise<{ bytes: Uint8Array; filename: string; label: string }> {
  const context = async () => ({
    clinic: await loadDocumentClinic(tx, orgId),
    checkUrl: await documentCheckUrl(tx, orgId, CHECK_TYPE[type], documentId),
  })
  if (type === "prescription") {
    const data = await getPrescriptionPrint(tx, orgId, patientId, documentId)
    return {
      bytes: await renderPrescriptionPdf(data, await context()),
      filename: `Receta-${data.prescription.prescriptionNumber}.pdf`,
      label: `Receta N.º ${data.prescription.prescriptionNumber}`,
    }
  }
  if (type === "medical_leave") {
    const data = await getMedicalLeavePrint(tx, orgId, patientId, documentId)
    return {
      bytes: await renderMedicalLeavePdf(data, await context()),
      filename: `Descanso-medico-${data.leave.leaveNumber}.pdf`,
      label: `Descanso médico N.º ${data.leave.leaveNumber}`,
    }
  }
  if (type === "order") {
    const data = await getOrderPrint(tx, orgId, documentId)
    if (data.order.patientId !== patientId) throw notFound("Orden")
    return {
      bytes: await renderOrderPdf(data, await context()),
      filename: `Orden-${data.order.title}.pdf`,
      label: `${ORDER_KIND_WORDS[data.order.kind] ?? "Orden"} · ${data.order.title}`,
    }
  }
  const data = await getConsentPrint(tx, orgId, documentId)
  if (data.document.patientId !== patientId) throw notFound("Consentimiento")
  const doc = data.document
  if (doc.status === "pendiente") {
    const clinic = await loadDocumentClinic(tx, orgId)
    return {
      bytes: doc.personSignedAt
        ? await renderConsentPdf(data, clinic)
        : await renderConsentPaperPdf(data, clinic),
      filename: `Consentimiento-${doc.titleSnapshot}.pdf`,
      label: `Consentimiento · ${doc.titleSnapshot}`,
    }
  }
  const named = {
    filename: `Consentimiento-${doc.titleSnapshot}.pdf`,
    label: `Consentimiento · ${doc.titleSnapshot}`,
  }
  // Revocado, el que se ve es el de la revocación: dice que ya no vale.
  const revoked = options.viewing && doc.status === "revocado"
  const storedId = revoked ? (doc.revokePdfDocumentId ?? null) : doc.pdfDocumentId
  const storedSha = revoked ? (doc.revokePdfSha256 ?? null) : doc.pdfSha256
  if (options.viewing && (!storedId || !storedSha)) {
    // Un anulado nunca tuvo PDF; un firmado cuyo guardado falló no traba a quien lo abre.
    const clinic = await loadDocumentClinic(tx, orgId)
    return { ...named, bytes: await renderConsentPdf(data, clinic) }
  }
  // Se envía el PDF que se guardó al firmar, no uno nuevo: es el de la huella (#47).
  if (!storedId || !storedSha)
    throw new ServiceError(
      "CONSENT_PDF_MISSING",
      409,
      "El consentimiento aún no tiene su PDF guardado",
    )
  if (!storage.getAttachment)
    throw new ServiceError("STORAGE_UNAVAILABLE", 503, "No se pudo leer el PDF guardado")
  const [file] = await tx
    .select({ storageKey: patientDocument.storageKey })
    .from(patientDocument)
    .where(
      and(eq(patientDocument.id, storedId), eq(patientDocument.organizationId, orgId)),
    )
    .limit(1)
  if (!file) throw notFound("PDF del consentimiento")
  const bytes = await storage.getAttachment(file.storageKey)
  if (createHash("sha256").update(bytes).digest("hex") !== storedSha)
    throw new ServiceError(
      "CONSENT_PDF_ALTERED",
      409,
      "El PDF guardado no coincide con su huella: no se envía",
    )
  return {
    bytes,
    filename: `Consentimiento-${doc.titleSnapshot}.pdf`,
    label: `Consentimiento · ${doc.titleSnapshot}`,
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
  if (!input.connectionId) throw invalidField("connectionId", "Elige por dónde enviarlo")
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
        throw new ServiceError(
          "REQUEST_ID_CONFLICT",
          409,
          "Esa clave de envío ya se usó con otro documento",
        )
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
    const message = "Un papel de salud solo se envía a la propia persona o a su representante legal"
    throw new ServiceError("DOCUMENT_RECIPIENT_NOT_AUTHORIZED", 403, message, {
      recipientContactId: message,
    })
  }
  const conn = await requireDocumentConnection(tx, orgId, input.connectionId)
  if (conn.channel !== "whatsapp" && conn.channel !== "email")
    throw invalidField("connectionId", "Un papel de salud se envía por WhatsApp o por correo")
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
  const rendered = await renderHealthDocumentPdf(
    tx,
    orgId,
    input.patientId,
    type,
    input.documentId,
    deps.storage,
  )
  const message = input.message?.trim()
  if (message && message.length > 500)
    throw invalidField("message", "El mensaje admite hasta 500 caracteres")
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
