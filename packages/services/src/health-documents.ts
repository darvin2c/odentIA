/**
 * Papeles de salud de la atención para la persona: receta, orden,
 * consentimiento firmado y descanso médico (ADR 0033; decisión 3 de la fase 3;
 * issue 229, decisión 8).
 *
 * - Solo a la propia persona (si es mayor de edad) o a su representante legal
 *   vigente, nunca a otro número ni a un responsable económico: es información
 *   de salud.
 * - WhatsApp primero (el de su ficha); sin WhatsApp, por correo; sin ninguno
 *   de los dos, solo se imprime y se dice. Cada envío entrega lo que dice: el
 *   PDF. Pasadas las 24 horas de WhatsApp sale con «Documento listo», el
 *   mensaje aprobado con el PDF en su encabezado; si aún no está aprobado, el
 *   cajón lo dice y queda el correo o imprimir (ADR 0154).
 * - El nombre del archivo es neutro («Receta-12.pdf»): se ve en la
 *   notificación del teléfono y no debe decir nada clínico.
 * - El envío es el mismo de los documentos de cobro (`deliverDocumentPdf`): el
 *   PDF queda en la conversación de la persona y vuelve encolado; el worker lo
 *   entrega. Encolado nunca se presenta como entregado.
 */
import { createHash } from "node:crypto"
import type { Db } from "@odentia/db"
import { patientDocument } from "@odentia/db/schema/clinical"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"
import { ATTENTION_SHEET_LABEL, getAttentionSheetPrint } from "./attention-sheet.js"
import { getConsentPrint, getOrderPrint } from "./clinical-forms.js"
import {
  ORDER_KIND_WORDS,
  renderAttentionSheetPdf,
  renderMedicalLeavePdf,
  renderOrderPdf,
  renderPrescriptionPdf,
} from "./clinical-papers.js"
import { renderConsentPaperPdf, renderConsentPdf } from "./consent-pdf.js"
import { loadDocumentClinic } from "./document-clinic.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import {
  type DocumentChannelOption,
  deliverDocumentPdf,
  documentChannelsFor,
  requireDocumentConnection,
  type SendDeps,
} from "./financial-documents.js"
import { type IssuedPaperType, issuedPaperBytes, type PaperStorage } from "./issued-papers.js"
import { getMedicalLeavePrint } from "./medical-leaves.js"
import { updateContact } from "./contacts.js"
import { requirePatient } from "./patients.js"
import { getPrescriptionPrint } from "./prescriptions.js"
import { type DecisionRecipient, listDecisionRecipients } from "./responsibilities.js"

export const HEALTH_DOCUMENT_TYPES = [
  "prescription",
  "order",
  "consent",
  "medical_leave",
  "attention_sheet",
] as const
export type HealthDocumentType = (typeof HEALTH_DOCUMENT_TYPES)[number]

function assertHealthType(value: string): HealthDocumentType {
  if ((HEALTH_DOCUMENT_TYPES as readonly string[]).includes(value))
    return value as HealthDocumentType
  throw validation("Documento inválido: receta, orden, consentimiento, descanso médico u hoja de atención")
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
  if (type === "attention_sheet") {
    // Sin firmar no hay hoja: lo dice quien la lee.
    await getAttentionSheetPrint(tx, orgId, patientId, documentId)
    return {
      label: ATTENTION_SHEET_LABEL,
      own: "tu hoja de atención",
      other: "la hoja de atención",
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
  const { channels: all } = await documentChannelsFor(tx, orgId, recipient, { documentTemplate: true })
  const channels = all.filter((option) => option.channel === "whatsapp" || option.channel === "email")
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
      : `Por ahora no hay por dónde enviárselo a ${recipient.displayName}: imprímelo, o agrégale un correo`,
  }
}

/**
 * «Agregar correo» del cajón de un papel de salud: lo guarda en los datos de
 * quien lo recibe, solo si es la propia persona o su representante legal
 * vigente, con las reglas y la traza de editar el contacto.
 */
export async function saveHealthRecipientEmail(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: { recipientContactId: string; email: string },
): Promise<HealthDocumentRecipient> {
  const recipients = await listHealthDocumentRecipients(tx, orgId, patientId)
  const recipient = recipients.find((r) => r.contactId === input.recipientContactId)
  if (!recipient) {
    const message = "Un papel de salud solo se envía a la propia persona o a su representante legal"
    throw new ServiceError("DOCUMENT_RECIPIENT_NOT_AUTHORIZED", 403, message, { recipientContactId: message })
  }
  // Agregar, no reemplazar: cambiar el correo de alguien es de quien edita sus datos.
  if (recipient.email?.trim()) {
    const message = `${recipient.displayName} ya tiene correo: cambiarlo es de quien edita sus datos`
    throw new ServiceError("RECIPIENT_HAS_EMAIL", 409, message, { email: message })
  }
  const email = input.email.trim().toLowerCase()
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw invalidField("email", "El correo no tiene un formato válido")
  await updateContact(tx, orgId, recipient.contactId, { email }, { userId: actorUserId })
  return { ...recipient, email }
}

// --- PDF -----------------------------------------------------------------------

/** La fecha de un papel sin número en el nombre de su archivo (AAAA-MM-DD). */
function dateOfName(value: Date | string | null | undefined): string {
  const at = value ? new Date(value) : new Date()
  return Number.isNaN(at.getTime()) ? "documento" : at.toISOString().slice(0, 10)
}

/**
 * El PDF de un papel de salud: el mismo para enviarlo, para su portal y para
 * que el equipo lo vea. Receta, orden y descanso son el archivo guardado al emitirse
 * (`issuedPaperBytes`), con «ANULADA» encima si se anularon (enviarlos sigue prohibido:
 * `loadHealthMeta`). El consentimiento firmado es el guardado, el de la huella; el
 * pendiente es la hoja para firmar en papel o, si ya lo firmó en su enlace, lo que
 * firmó, a la espera de que lo confirmen.
 */
export async function renderHealthDocumentPdf(
  tx: Db,
  orgId: string,
  patientId: string,
  type: HealthDocumentType,
  documentId: string,
  /** Donde vive lo emitido: sin él no se guarda ni se lee nada. */
  storage: PaperStorage = {},
  /** Para verlo: lo que no se pudo guardar se genera al vuelo, sin trabar a quien lo abre. */
  options: { viewing?: boolean } = {},
): Promise<{ bytes: Uint8Array; filename: string; label: string; noticeLabel: string }> {
  const paper = { orgId, patientId, documentId }
  if (type === "prescription") {
    const data = await getPrescriptionPrint(tx, orgId, patientId, documentId)
    const rx = data.prescription
    return {
      bytes: await issuedPaperBytes(
        tx,
        {
          ...paper,
          type,
          patientName: data.patient.displayName,
          voided: rx.status === "anulada" ? { word: "ANULADA", reason: rx.cancelReason } : null,
          draw: (context) => renderPrescriptionPdf(data, context),
        },
        storage,
        options,
      ),
      filename: `Receta-${rx.prescriptionNumber}.pdf`,
      label: `Receta N.º ${rx.prescriptionNumber}`,
      noticeLabel: `Receta N.º ${rx.prescriptionNumber}`,
    }
  }
  if (type === "medical_leave") {
    const data = await getMedicalLeavePrint(tx, orgId, patientId, documentId)
    const { leave } = data
    return {
      bytes: await issuedPaperBytes(
        tx,
        {
          ...paper,
          type,
          patientName: data.patient.displayName,
          voided: leave.status === "anulado" ? { word: "ANULADO", reason: leave.cancelReason } : null,
          draw: (context) => renderMedicalLeavePdf(data, context),
        },
        storage,
        options,
      ),
      filename: `Descanso-${leave.leaveNumber}.pdf`,
      label: `Descanso médico N.º ${leave.leaveNumber}`,
      noticeLabel: `Descanso médico N.º ${leave.leaveNumber}`,
    }
  }
  if (type === "attention_sheet") {
    const data = await getAttentionSheetPrint(tx, orgId, patientId, documentId)
    return {
      bytes: await issuedPaperBytes(
        tx,
        {
          ...paper,
          type,
          patientName: data.patient.displayName,
          // Una atención firmada no se anula: la hoja siempre vale.
          voided: null,
          draw: (context) => renderAttentionSheetPdf(data, context),
        },
        storage,
        options,
      ),
      filename: "Hoja-de-atencion.pdf",
      label: ATTENTION_SHEET_LABEL,
      noticeLabel: ATTENTION_SHEET_LABEL,
    }
  }
  if (type === "order") {
    const data = await getOrderPrint(tx, orgId, documentId)
    const { order } = data
    if (order.patientId !== patientId) throw notFound("Orden")
    return {
      bytes: await issuedPaperBytes(
        tx,
        {
          ...paper,
          type,
          patientName: data.patient.displayName,
          voided: order.status === "cancelado" ? { word: "ANULADA", reason: order.cancelReason } : null,
          draw: (context) => renderOrderPdf(data, context),
        },
        storage,
        options,
      ),
      // Sin el título: «Orden-Biopsia….pdf» diría en la notificación lo que se estudia.
      filename: `Orden-${dateOfName(order.createdAt)}.pdf`,
      label: `${ORDER_KIND_WORDS[order.kind] ?? "Orden"} · ${order.title}`,
      noticeLabel: "Orden",
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
      filename: `Consentimiento-${dateOfName(doc.signedAt ?? doc.createdAt)}.pdf`,
      label: `Consentimiento · ${doc.titleSnapshot}`,
      noticeLabel: "Consentimiento",
    }
  }
  const named = {
    filename: `Consentimiento-${dateOfName(doc.signedAt ?? doc.createdAt)}.pdf`,
    label: `Consentimiento · ${doc.titleSnapshot}`,
    noticeLabel: "Consentimiento",
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
    filename: `Consentimiento-${dateOfName(doc.signedAt ?? doc.createdAt)}.pdf`,
    label: `Consentimiento · ${doc.titleSnapshot}`,
    noticeLabel: "Consentimiento",
  }
}

/** Cuánto espera quien emite a que el archivo se guarde. */
const KEEP_PAPER_WAIT_MS = 5000

/**
 * Deja guardado lo recién emitido, ya confirmada su emisión. Si falla no deshace nada:
 * el documento existe y se guarda la próxima vez que alguien lo abra. Si el almacenamiento
 * tarda, se responde igual y sigue guardándose: quien vea un error creería que no se
 * emitió y volvería a emitirlo.
 */
export async function keepIssuedPaper(input: {
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
  storage: PaperStorage
  orgId: string
  patientId: string
  type: IssuedPaperType
  documentId: string
  waitMs?: number
}): Promise<void> {
  const { run, storage, orgId, patientId, type, documentId } = input
  const work = run((tx) =>
    renderHealthDocumentPdf(tx, orgId, patientId, type, documentId, storage),
  ).then(
    () => undefined,
    (error: unknown) => console.error(`No se guardó el papel emitido (${type})`, error),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, input.waitMs ?? KEEP_PAPER_WAIT_MS)
    }),
  ])
  clearTimeout(timer)
}

/**
 * De qué paciente es el papel de salud que salió en este mensaje; null si no lleva uno.
 * El adjunto queda en la conversación, que recepción lee, pero sigue siendo historia clínica:
 * una receta, una orden o un descanso, y también la copia de la historia entera (ADR 0080).
 */
export async function healthDocumentPatientOfMessage(
  tx: Db,
  orgId: string,
  messageId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.organizationId, orgId),
        eq(auditEvent.entity, "message"),
        eq(auditEvent.entityId, messageId),
        inArray(auditEvent.action, ["health_document.sent", "patient_record.sent"]),
      ),
    )
    .limit(1)
  const patientId = (row?.metadata as { patientId?: unknown } | null | undefined)?.patientId
  return typeof patientId === "string" ? patientId : null
}

/**
 * La última vez que este papel salió hacia la persona: cuándo, por dónde y a
 * quién. Sirve para avisar, al anular una receta ya enviada, que el PDF que
 * tiene en su chat ya no vale (ADR 0154). Nulo si nunca se envió.
 */
export async function lastHealthDocumentSend(
  tx: Db,
  orgId: string,
  patientId: string,
  input: { documentType: string; documentId: string },
): Promise<{ at: Date; channel: string; recipientName: string } | null> {
  const type = assertHealthType(input.documentType)
  const [row] = await tx
    .select({ at: auditEvent.createdAt, metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.organizationId, orgId),
        eq(auditEvent.action, "health_document.sent"),
        sql`${auditEvent.metadata}->>'documentId' = ${input.documentId}`,
        sql`${auditEvent.metadata}->>'patientId' = ${patientId}`,
        sql`${auditEvent.metadata}->>'documentType' = ${type}`,
      ),
    )
    .orderBy(sql`${auditEvent.createdAt} desc`)
    .limit(1)
  if (!row) return null
  const sent = row.metadata as { channel?: string; recipientName?: string }
  return { at: row.at, channel: sent.channel ?? "", recipientName: sent.recipientName ?? "" }
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
  deps: SendDeps,
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
      // La primera línea es el asunto del correo en frío. Ni el pie de WhatsApp ni el asunto dicen
      // el título clínico: se ven en la notificación del teléfono, como el nombre del archivo.
      caption: `${rendered.noticeLabel}${clinic ? ` · ${clinic}` : ""}\n\n${body}`,
      allowTemplate: true,
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
