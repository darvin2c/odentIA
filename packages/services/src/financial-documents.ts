/**
 * Envío de documentos económicos al paciente (Fase 7 Finanzas).
 *
 * - PDF desde snapshot (financial-document-pdf.ts, generador único también
 *   usado por impresión): ticket del cobro, presupuesto del plan.
 * - Destinatario: la propia persona o un pagador autorizado (responsable
 *   económico, representante legal o autorizado de información vigente). Nunca
 *   se verifica identidad por coincidencia de teléfono.
 * - Canal (decisión 20 v2): cada papel por su canal natural. El comprobante
 *   (ticket del cobro) por correo, y al cobrar se envía solo
 *   (`sendTicketReceiptByEmail`); por WhatsApp sale solo si la persona lo pide
 *   en el chat. El presupuesto, primero por WhatsApp y, si no, por correo.
 *   Quien envía puede cambiarlo. Sin canal utilizable se devuelve el texto para configurar.
 * - El envío queda en la conversación de la persona como adjunto PDF y vuelve
 *   en estado `encolado`: el worker lo entrega por el adaptador real y solo
 *   entonces pasa a `enviado`. Nunca se presenta encolado como entregado.
 */
import { channelAdapters } from "@odentia/channels"
import type { Db } from "@odentia/db"
import {
  patientContact,
  patientResponsibility,
  paymentTicket,
  treatmentBudget,
} from "@odentia/db/schema/clinical"
import {
  channelConnection,
  contact,
  contactIdentity,
  conversation,
} from "@odentia/db/schema/crm"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { NOTICE_PURPOSE } from "./automation-messages.js"
import { findChannelIdentity, lockChannelIdentity, normalizeChannelIdentity, updateContact } from "./contacts.js"
import { reopenIfClosed, sendOutbound, startContactConversation } from "./conversations.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { mayWriteFirst, permitsMessage } from "./message-permission.js"
import { windowOpen } from "./message-window.js"
import { budgetStateText } from "@odentia/clinical"
import { deliverBudget, requireOwnBudget } from "./budgets.js"
import {
  buildBudgetSnapshot,
  buildTicketSnapshot,
  renderBudgetPdf,
  renderTicketPdf,
} from "./financial-document-pdf.js"
import type { Storage } from "./storage.js"
import { requirePatient } from "./patients.js"
import { listDecisionRecipients } from "./responsibilities.js"

export const FINANCIAL_DOCUMENT_TYPES = ["ticket", "budget"] as const
export type FinancialDocumentType = (typeof FINANCIAL_DOCUMENT_TYPES)[number]

/** Prefijos de hilo de las respuestas de correo (contrato de los slices Email). */
const EMAIL_THREAD_PREFIXES = ["gmail-thread:", "m365-conv:"]

function assertDocumentType(value: string): FinancialDocumentType {
  if (value === "ticket" || value === "budget") return value
  throw validation("Documento inválido: solo ticket o budget")
}

// --- Destinatarios ------------------------------------------------------------

export type RecipientRelation =
  | "paciente"
  | "representante_legal"
  | "responsable_economico"
  | "autorizado_informacion"

export interface DocumentRecipient {
  contactId: string
  displayName: string
  email: string | null
  phone: string | null
  relation: RecipientRelation
  isDefault: boolean
}

/**
 * Personas autorizadas a recibir el documento económico del paciente. Un
 * presupuesto es una decisión sobre su salud: va solo a quien decide
 * (`listDecisionRecipients`, la regla única de a quién se le manda). El
 * comprobante puede ir además al responsable económico.
 */
export async function listDocumentRecipients(
  tx: Db,
  orgId: string,
  patientId: string,
  preferContactId?: string | null,
  documentType: FinancialDocumentType = "ticket",
): Promise<DocumentRecipient[]> {
  if (documentType === "budget") {
    const decides = await listDecisionRecipients(tx, orgId, patientId)
    const preferred = decides.find((r) => r.contactId === preferContactId)
    return decides.map((r) => ({ ...r, isDefault: preferred ? r === preferred : r.isDefault }))
  }
  await requirePatient(tx, orgId, patientId)
  const today = new Date().toISOString().slice(0, 10)
  const links = await tx
    .select({ contact, relationship: patientContact.relationship })
    .from(patientContact)
    .innerJoin(
      contact,
      and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, orgId)),
    )
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, patientId),
        eq(contact.isActive, true),
      ),
    )
  const self = links.find((l) => l.relationship === "self")
  const responsibilities = await tx
    .select({ contact, kind: patientResponsibility.kind })
    .from(patientResponsibility)
    .innerJoin(
      contact,
      and(eq(contact.id, patientResponsibility.contactId), eq(contact.organizationId, orgId)),
    )
    .where(
      and(
        eq(patientResponsibility.organizationId, orgId),
        eq(patientResponsibility.patientId, patientId),
        isNull(patientResponsibility.revokedAt),
        sql`${patientResponsibility.startsAt} <= ${today}`,
        sql`(${patientResponsibility.endsAt} IS NULL OR ${patientResponsibility.endsAt} >= ${today})`,
        eq(contact.isActive, true),
      ),
    )
  const out: DocumentRecipient[] = []
  const seen = new Set<string>()
  const push = (row: typeof contact.$inferSelect, relation: RecipientRelation) => {
    if (seen.has(row.id)) return
    seen.add(row.id)
    out.push({
      contactId: row.id,
      displayName: row.displayName,
      email: row.email,
      phone: row.phone,
      relation,
      isDefault: false,
    })
  }
  if (self) push(self.contact, "paciente")
  for (const r of responsibilities) {
    if (r.kind === "representante_legal" || r.kind === "responsable_economico" || r.kind === "autorizado_informacion") {
      push(r.contact, r.kind)
    }
  }
  const preferred = out.find((r) => r.contactId === preferContactId) ?? out.find((r) => r.relation === "paciente") ?? out[0]
  if (preferred) preferred.isDefault = true
  return out
}

async function requireAuthorizedRecipient(
  tx: Db,
  orgId: string,
  patientId: string,
  contactId: string | undefined,
  preferContactId?: string | null,
  documentType: FinancialDocumentType = "ticket",
): Promise<DocumentRecipient> {
  const recipients = await listDocumentRecipients(tx, orgId, patientId, preferContactId, documentType)
  if (recipients.length === 0) throw notFound("Destinatario del documento")
  const chosen = contactId
    ? recipients.find((r) => r.contactId === contactId)
    : recipients.find((r) => r.isDefault)
  if (!chosen) {
    throw new ServiceError(
      "DOCUMENT_RECIPIENT_NOT_AUTHORIZED",
      403,
      "El destinatario no es la persona ni un pagador autorizado del paciente",
    )
  }
  return chosen
}

// --- Canales ------------------------------------------------------------------

export interface DocumentChannelOption {
  channel: string
  connectionId: string
  connectionName: string
  provider: string
  usable: boolean
  reason: string | null
  hasThread: boolean
  isPreferred: boolean
  isProposed: boolean
}

export interface DocumentMeta {
  type: FinancialDocumentType
  label: string
  statusLabel: string
  isDraft: boolean
}

export interface DocumentSendOptions {
  recipients: DocumentRecipient[]
  recipient: DocumentRecipient
  channels: DocumentChannelOption[]
  proposed: DocumentChannelOption | null
  document: DocumentMeta
  /** Mensaje que acompaña al documento: lo propone el servidor y quien envía puede editarlo. */
  message: string
}

/** Texto propuesto: saluda a quien lo recibe y dice de quién es el documento si no es suyo. */
function proposeMessage(
  documentType: FinancialDocumentType,
  recipient: DocumentRecipient,
  patientName: string,
  clinicName: string,
): string {
  const where = clinicName ? ` en ${clinicName}` : ""
  const own = recipient.relation === "paciente"
  const text =
    documentType === "ticket"
      ? own
        ? `Hola, ${recipient.displayName}. Te enviamos el ticket de tu pago${where}. Gracias por tu visita.`
        : `Hola, ${recipient.displayName}. Te enviamos el ticket del pago de ${patientName}${where}. Gracias por tu visita.`
      : own
        ? `Hola, ${recipient.displayName}. Te enviamos el presupuesto de tu tratamiento${where}.`
        : `Hola, ${recipient.displayName}. Te enviamos el presupuesto del tratamiento de ${patientName}${where}.`
  return text.slice(0, 500)
}

async function loadDocumentMeta(
  tx: Db,
  orgId: string,
  patientId: string,
  documentType: FinancialDocumentType,
  documentId: string,
): Promise<{ meta: DocumentMeta; preferContactId: string | null }> {
  if (documentType === "ticket") {
    const [ticket] = await tx
      .select()
      .from(paymentTicket)
      .where(
        and(
          eq(paymentTicket.id, documentId),
          eq(paymentTicket.organizationId, orgId),
          eq(paymentTicket.patientId, patientId),
        ),
      )
      .limit(1)
    if (!ticket) throw notFound("Ticket")
    return {
      meta: {
        type: "ticket",
        label: `Ticket N.º ${String(ticket.ticketNumber).padStart(6, "0")}`,
        statusLabel: ticket.voidedAt
          ? `Anulado${ticket.voidReason ? ` · ${ticket.voidReason}` : ""}`
          : "Vigente",
        isDraft: false,
      },
      preferContactId: ticket.payerContactId,
    }
  }
  const [budget] = await tx
    .select()
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.id, documentId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .limit(1)
  if (!budget) throw notFound("Presupuesto")
  return {
    meta: {
      type: "budget",
      label: `Presupuesto N.º ${String(budget.budgetNumber).padStart(4, "0")}`,
      // El estado con su nombre de siempre; «Aceptó N de M» necesita las líneas: aquí basta «en parte».
      statusLabel:
        budget.status === "borrador"
          ? "Por enviar (se entrega al enviarlo)"
          : budget.status === "parcial"
            ? "Aceptó una parte"
            : budgetStateText({ status: budget.status, items: [] }),
      isDraft: budget.status === "borrador",
    },
    preferContactId: budget.decisionContactId,
  }
}

export interface UsableConnection {
  id: string
  channel: string
  provider: string
  displayName: string
}

async function listMediaConnections(tx: Db, orgId: string): Promise<UsableConnection[]> {
  const rows = await tx
    .select()
    .from(channelConnection)
    .where(and(eq(channelConnection.organizationId, orgId), eq(channelConnection.status, "active")))
  return rows
    .filter((row) => {
      const adapter = channelAdapters[row.provider as keyof typeof channelAdapters]
      return !!adapter && adapter.capabilities.media
    })
    .map((row) => ({ id: row.id, channel: row.channel, provider: row.provider, displayName: row.displayName }))
}

/**
 * Propuesta pura de canal (decisión 20 v2). El comprobante: correo con
 * conexión > preferido utilizable > última conversación > primero utilizable.
 * El presupuesto, que hay que leer enseguida (`first: "whatsapp"`): WhatsApp
 * utilizable > correo > lo demás.
 */
export function proposeChannel<T extends { channel: string; usable: boolean; hasThread: boolean; connectionId: string }>(
  options: T[],
  input: { email: string | null; preferredChannel: string | null; lastChannel: string | null; first?: "email" | "whatsapp" },
): T | null {
  const usable = options.filter((o) => o.usable)
  if (usable.length === 0) return null
  if (input.first === "whatsapp") {
    const whatsapp = usable.find((o) => o.channel === "whatsapp")
    if (whatsapp) return whatsapp
  }
  if (input.email) {
    const email = usable.find((o) => o.channel === "email")
    if (email) return email
  }
  if (input.preferredChannel) {
    const preferred = usable.find((o) => o.channel === input.preferredChannel)
    if (preferred) return preferred
  }
  if (input.lastChannel) {
    const last = usable.find((o) => o.channel === input.lastChannel)
    if (last) return last
  }
  return usable[0] ?? null
}

export async function getDocumentSendOptions(
  tx: Db,
  orgId: string,
  patientId: string,
  input: { documentType: string; documentId: string; recipientContactId?: string },
  /** Quién lo pide: un odontólogo solo prepara el envío de presupuestos de sus planes. */
  actor: { actorUserId?: string; memberRole?: string } = {},
): Promise<DocumentSendOptions> {
  const documentType = assertDocumentType(input.documentType)
  if (documentType === "budget" && actor.memberRole === "dentist" && actor.actorUserId)
    await requireDentistOwnPlan(tx, orgId, actor.actorUserId, patientId, input.documentId)
  const { meta, preferContactId } = await loadDocumentMeta(tx, orgId, patientId, documentType, input.documentId)
  const recipients = await listDocumentRecipients(tx, orgId, patientId, preferContactId, documentType)
  if (recipients.length === 0) throw notFound("Destinatario del documento")
  const recipient =
    (input.recipientContactId && recipients.find((r) => r.contactId === input.recipientContactId)) ||
    recipients.find((r) => r.isDefault) ||
    recipients[0]
  if (!recipient) throw notFound("Destinatario del documento")
  const { channels, preferredChannel, lastChannel } = await documentChannelsFor(tx, orgId, recipient)
  const proposed = proposeChannel(channels, {
    email: recipient.email,
    preferredChannel,
    lastChannel,
    first: documentType === "budget" ? "whatsapp" : "email",
  })
  if (proposed) proposed.isProposed = true
  const patientRow = await requirePatient(tx, orgId, patientId)
  const [profile] = await tx
    .select({ tradeName: orgProfile.tradeName, legalName: orgProfile.legalName })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  const message = proposeMessage(
    documentType,
    recipient,
    patientRow.displayName,
    profile?.tradeName || profile?.legalName || "",
  )
  return { recipients, recipient, channels, proposed, document: meta, message }
}

/**
 * Por dónde puede llegarle un documento a una persona: una opción por cada
 * conexión activa que admite adjuntos, con si sirve y por qué no. La comparten
 * los documentos de cobro y los papeles de salud (`health-documents.ts`); cada
 * uno propone su canal.
 */
export async function documentChannelsFor(
  tx: Db,
  orgId: string,
  recipient: Pick<DocumentRecipient, "contactId" | "email">,
): Promise<{ channels: DocumentChannelOption[]; preferredChannel: string | null; lastChannel: string | null }> {
  const [recipientRow] = await tx
    .select({ preferredChannel: contact.preferredChannel })
    .from(contact)
    .where(and(eq(contact.id, recipient.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  const identities = await tx
    .select()
    .from(contactIdentity)
    .where(and(eq(contactIdentity.organizationId, orgId), eq(contactIdentity.contactId, recipient.contactId)))
  const threads = await tx
    .select({ conversation, connection: channelConnection })
    .from(conversation)
    .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
    // Abiertas o cerradas: escribir reabre (ADR 0024). Cuenta desde cuándo
    // escribió la persona, con la misma ventana que todo lo demás (ADR 0042).
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.contactId, recipient.contactId)))
    .orderBy(desc(conversation.lastMessageAt))
  const connections = await listMediaConnections(tx, orgId)
  const now = Date.now()
  // Es un aviso que manda el equipo: como respuesta sale siempre; si no, solo
  // lo frena «No quiero ningún mensaje de la clínica» (la misma puerta).
  const allowed = await mayWriteFirst(tx, orgId, recipient.contactId, "avisos")
  const refused = (option: DocumentChannelOption): DocumentChannelOption =>
    allowed || !option.usable ? option : { ...option, usable: false, reason: DOCUMENT_OPTED_OUT }
  const options: DocumentChannelOption[] = connections.map((conn) => {
    const own = threads.filter((t) => t.conversation.channelConnectionId === conn.id)
    const thread = own[0]
    const lastInboundAt = own.reduce<Date | null>(
      (latest, t) => (t.conversation.lastInboundAt && (!latest || t.conversation.lastInboundAt > latest) ? t.conversation.lastInboundAt : latest),
      null,
    )
    const withinWindow = windowOpen(lastInboundAt, now)
    if (conn.channel === "email") {
      const hasThread =
        !!thread && EMAIL_THREAD_PREFIXES.some((p) => thread.conversation.externalThreadId.startsWith(p))
      if (!recipient.email) {
        return {
          channel: conn.channel,
          connectionId: conn.id,
          connectionName: conn.displayName,
          provider: conn.provider,
          usable: false,
          reason: "La persona no tiene correo registrado",
          hasThread,
          isPreferred: recipientRow?.preferredChannel === conn.channel,
          isProposed: false,
        }
      }
      return {
        channel: conn.channel,
        connectionId: conn.id,
        connectionName: conn.displayName,
        provider: conn.provider,
        usable: true,
        reason: null,
        hasThread,
        isPreferred: recipientRow?.preferredChannel === conn.channel,
        isProposed: false,
      }
    }
    if (conn.channel === "whatsapp") {
      const identity = identities.find((i) => i.channel === "whatsapp")
      if (!identity) {
        return {
          channel: conn.channel, connectionId: conn.id, connectionName: conn.displayName, provider: conn.provider,
          usable: false, reason: "Esta persona no tiene WhatsApp vinculado", hasThread: false,
          isPreferred: recipientRow?.preferredChannel === conn.channel, isProposed: false,
        }
      }
      if (!withinWindow) {
        return {
          channel: conn.channel, connectionId: conn.id, connectionName: conn.displayName, provider: conn.provider,
          usable: false, reason: "Fuera de la ventana de 24 h de WhatsApp: necesita un mensaje reciente", hasThread: !!thread,
          isPreferred: recipientRow?.preferredChannel === conn.channel, isProposed: false,
        }
      }
      return {
        channel: conn.channel, connectionId: conn.id, connectionName: conn.displayName, provider: conn.provider,
        usable: true, reason: null, hasThread: !!thread,
        isPreferred: recipientRow?.preferredChannel === conn.channel, isProposed: false,
      }
    }
    if (conn.channel === "messenger" || conn.channel === "instagram") {
      if (!thread || !withinWindow) {
        return {
          channel: conn.channel, connectionId: conn.id, connectionName: conn.displayName, provider: conn.provider,
          usable: false, reason: "Necesita un mensaje reciente de la persona (ventana de 24 h)", hasThread: !!thread,
          isPreferred: recipientRow?.preferredChannel === conn.channel, isProposed: false,
        }
      }
      return {
        channel: conn.channel, connectionId: conn.id, connectionName: conn.displayName, provider: conn.provider,
        usable: true, reason: null, hasThread: true,
        isPreferred: recipientRow?.preferredChannel === conn.channel, isProposed: false,
      }
    }
    if (!thread) {
      return {
        channel: conn.channel, connectionId: conn.id, connectionName: conn.displayName, provider: conn.provider,
        usable: false, reason: "La persona aún no escribió por este canal", hasThread: false,
        isPreferred: recipientRow?.preferredChannel === conn.channel, isProposed: false,
      }
    }
    return {
      channel: conn.channel, connectionId: conn.id, connectionName: conn.displayName, provider: conn.provider,
      usable: true, reason: null, hasThread: true,
      isPreferred: recipientRow?.preferredChannel === conn.channel, isProposed: false,
    }
  })
  const channels = options.map((option, index) => {
    // Dentro de la ventana es una respuesta: sale aunque haya pedido no recibir mensajes.
    const conn = connections[index]
    const inWindow = !!conn && threads.some(
      (t) => t.conversation.channelConnectionId === conn.id && windowOpen(t.conversation.lastInboundAt, now),
    )
    return inWindow ? option : refused(option)
  })
  return {
    channels,
    preferredChannel: recipientRow?.preferredChannel ?? null,
    lastChannel: threads[0]?.connection.channel ?? null,
  }
}

/** Lo que dice la pantalla de un documento cuando la persona pidió no recibir nada. */
export const DOCUMENT_OPTED_OUT = "Pidió no recibir ningún mensaje de la clínica: entrégaselo impreso, o envíaselo si te escribe."

// --- Entrega de borrador --------------------------------------------------------
// Enviar un borrador lo entrega en la misma transacción (equivale a entregar):
// `deliverBudget` exige borrador con líneas y plan propio para el odontólogo.
async function deliverIfDraft(
  tx: Db,
  orgId: string,
  actorUserId: string,
  memberRole: string,
  patientId: string,
  budgetId: string,
): Promise<boolean> {
  const [head] = await tx
    .select({ status: treatmentBudget.status })
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .limit(1)
  if (!head) throw notFound("Presupuesto")
  if (head.status !== "borrador") return false
  try {
    await deliverBudget(tx, orgId, actorUserId, patientId, budgetId, { memberRole })
    return true
  } catch (e) {
    if (e instanceof ServiceError && e.code === "BUDGET_STATUS") return false
    throw e
  }
}

// Lo propio del odontólogo al enviar presupuestos ya entregados: lo que él
// indicó (`deliverBudget` aplica la misma regla al entregar el borrador).
async function requireDentistOwnPlan(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
): Promise<void> {
  const [head] = await tx
    .select({ id: treatmentBudget.id })
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .limit(1)
  if (!head) throw notFound("Presupuesto")
  await requireOwnBudget(tx, orgId, budgetId, actorUserId, "dentist")
}

// --- Envío ----------------------------------------------------------------------

export interface SendFinancialDocumentInput {
  patientId: string
  documentType: string
  documentId: string
  recipientContactId?: string
  connectionId: string
  message?: string
  savePreferredChannel?: boolean
  /** Hoja explícita para el PDF ('A4'|'Carta'); nulo = papel del perfil. */
  paper?: string | null
  /**
   * Clave del intento (una por apertura del panel). Reenviar con la misma
   * clave —doble clic, reintento tras un corte— devuelve el envío ya hecho en
   * vez de mandar el documento otra vez.
   */
  requestId?: string | null
  /**
   * Otro correo, escrito en el momento, en lugar del registrado. Solo por un
   * buzón de correo y con `confirmOtherEmail`: quien envía confirma que la
   * persona pidió recibirlo ahí. Queda en auditoría a qué dirección se envió.
   */
  otherEmail?: string | null
  confirmOtherEmail?: boolean
}

export interface SendFinancialDocumentResult {
  conversationId: string
  messageId: string
  /** Siempre `encolado` al responder: el worker entrega por el adaptador real. */
  status: "queued"
  channel: string
  documentLabel: string
  deliveredBudget: boolean
  /** Dirección a la que salió cuando fue por correo. */
  sentToEmail: string | null
}

export interface SendDeps {
  storage: Storage
}

function cleanMessage(value: string | undefined): string | null {
  if (value === undefined) return null
  const text = value.trim()
  if (!text) return null
  if (text.length > 500) throw validation("El mensaje admite hasta 500 caracteres")
  if (/[\r]/.test(text)) throw validation("El mensaje no admite saltos de línea especiales")
  return text
}

function assertEmail(value: string): string {
  const email = value.trim().toLowerCase()
  if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw validation("El correo no tiene un formato válido")
  return email
}

function asciiFilename(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80)
}

/** La primera línea del caption es el asunto del correo en frío. */
function captionWithSubject(subject: string, body: string): string {
  return `${subject}\n\n${body}`
}

/** A quién se le escribe por correo: la persona y la dirección de su ficha. */
export type EmailRecipient = Pick<DocumentRecipient, "contactId" | "email">

async function ensureEmailIdentity(
  tx: Db,
  orgId: string,
  recipient: EmailRecipient,
): Promise<typeof contactIdentity.$inferSelect> {
  const email = recipient.email?.trim().toLowerCase()
  if (!email || !email.includes("@")) throw validation("La persona no tiene correo registrado")
  const externalUserId = `mail:${email}`
  await lockChannelIdentity(tx, orgId, "email", externalUserId)
  const existing = await findChannelIdentity(tx, orgId, "email", externalUserId)
  if (existing) {
    if (existing.contactId !== recipient.contactId) {
      throw new ServiceError(
        "AMBIGUOUS_CHANNEL_HISTORY",
        409,
        "Ese correo ya está vinculado a otra persona: resuélvelo manualmente",
      )
    }
    return existing
  }
  // Alta explícita del operador (eligió persona + correo de su ficha): evita
  // que la respuesta cree una ficha paralela al ingresar por el proveedor.
  const [created] = await tx
    .insert(contactIdentity)
    .values({
      organizationId: orgId,
      contactId: recipient.contactId,
      channel: "email",
      externalUserId,
      displayName: recipient.email,
      isPrimary: false,
    })
    .onConflictDoNothing({
      target: [contactIdentity.organizationId, contactIdentity.channel, contactIdentity.externalUserId],
    })
    .returning()
  const row = created ?? (await findChannelIdentity(tx, orgId, "email", externalUserId))
  if (!row || row.contactId !== recipient.contactId) {
    throw new ServiceError(
      "AMBIGUOUS_CHANNEL_HISTORY",
      409,
      "Ese correo ya está vinculado a otra persona: resuélvelo manualmente",
    )
  }
  return row
}

/**
 * Hilo de correo con una persona: el último por esa conexión (si está cerrado
 * se reabre: escribir reabre, ADR 0024) o uno nuevo a la dirección de su ficha. El correo es el único canal, junto con
 * WhatsApp y su plantilla, por el que la clínica puede escribir primero. La
 * usan el envío de documentos y los mensajes automáticos (sin actor).
 */
export async function openEmailThread(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  recipient: EmailRecipient,
  conn: { id: string },
  /** Con otro correo el hilo es el de esa dirección, no el último abierto de la persona. */
  exactAddress = false,
): Promise<{ id: string }> {
  {
    const identity = await ensureEmailIdentity(tx, orgId, recipient)
    const [thread] = exactAddress ? [] : await tx
      .select({ id: conversation.id, status: conversation.status })
      .from(conversation)
      .where(
        and(
          eq(conversation.organizationId, orgId),
          eq(conversation.contactId, recipient.contactId),
          eq(conversation.channelConnectionId, conn.id),
        ),
      )
      .orderBy(sql`${conversation.status} = 'open' desc`, sql`${conversation.lastMessageAt} desc nulls last`)
      .limit(1)
    if (thread) {
      await reopenIfClosed(tx, orgId, thread.id, { userId: actorUserId, via: "envio" })
      return { id: thread.id }
    }
    await lockChannelIdentity(tx, orgId, "email", identity.externalUserId)
    const [created] = await tx
      .insert(conversation)
      .values({
        organizationId: orgId,
        contactId: recipient.contactId,
        contactIdentityId: identity.id,
        channelConnectionId: conn.id,
        externalThreadId: identity.externalUserId,
      })
      .onConflictDoNothing({
        target: [conversation.channelConnectionId, conversation.externalThreadId],
      })
      .returning({ id: conversation.id })
    if (created) {
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId,
        action: "conversation.started",
        entity: "conversation",
        entityId: created.id,
        metadata: { contactId: recipient.contactId, connectionId: conn.id, channel: "email" },
      })
      return { id: created.id }
    }
    const [retry] = await tx
      .select({ id: conversation.id, contactId: conversation.contactId, status: conversation.status })
      .from(conversation)
      .where(
        and(
          eq(conversation.organizationId, orgId),
          eq(conversation.channelConnectionId, conn.id),
          eq(conversation.externalThreadId, identity.externalUserId),
        ),
      )
      .limit(1)
    if (!retry || retry.contactId !== recipient.contactId) {
      throw new ServiceError(
        "AMBIGUOUS_CHANNEL_HISTORY",
        409,
        "Ese correo ya tiene un hilo con otra persona: resuélvelo manualmente",
      )
    }
    await reopenIfClosed(tx, orgId, retry.id, { userId: actorUserId, via: "envio" })
    return { id: retry.id }
  }
}

async function resolveConversation(
  tx: Db,
  orgId: string,
  actorUserId: string,
  recipient: Pick<DocumentRecipient, "contactId" | "email" | "phone">,
  conn: UsableConnection,
  /** Con otro correo el hilo es el de esa dirección, no el último abierto de la persona. */
  exactAddress = false,
): Promise<{ id: string }> {
  if (conn.channel === "email") return openEmailThread(tx, orgId, actorUserId, recipient, conn, exactAddress)
  if (conn.channel === "whatsapp") {
    const phone = recipient.phone?.trim()
    if (!phone) throw validation("La persona no tiene teléfono registrado")
    const normalized = normalizeChannelIdentity("whatsapp", phone)
    const identity = await findChannelIdentity(tx, orgId, "whatsapp", normalized.externalUserId)
    if (!identity || identity.contactId !== recipient.contactId) {
      throw new ServiceError(
        "CHANNEL_IDENTITY_MISSING",
        409,
        "Esta persona no tiene WhatsApp vinculado: vincúlalo desde su ficha antes de enviar",
      )
    }
    const started = await startContactConversation(tx, orgId, actorUserId, recipient.contactId, {
      identityId: identity.id,
      connectionId: conn.id,
    })
    // Cerrada o abierta: el envío la reabre (ADR 0024).
    return { id: started.id }
  }
  const [thread] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.contactId, recipient.contactId),
        eq(conversation.channelConnectionId, conn.id),
      ),
    )
    .orderBy(sql`${conversation.status} = 'open' desc`, sql`${conversation.lastMessageAt} desc nulls last`)
    .limit(1)
  if (!thread) {
    throw new ServiceError(
      "CHANNEL_REQUIRES_INBOUND",
      409,
      "Sin conversación previa por este canal no se puede enviar: la persona debe escribir primero",
    )
  }
  return { id: thread.id }
}

/** Conexión por la que puede salir un documento: activa, registrada y con adjuntos. */
export async function requireDocumentConnection(
  tx: Db,
  orgId: string,
  connectionId: string,
): Promise<UsableConnection> {
  const [conn] = await tx
    .select()
    .from(channelConnection)
    .where(and(eq(channelConnection.id, connectionId), eq(channelConnection.organizationId, orgId)))
    .limit(1)
  if (!conn) throw notFound("Conexión")
  if (conn.status !== "active") {
    throw new ServiceError("CONNECTION_DISABLED", 409, "Conexión desactivada: elige otra o conéctala de nuevo")
  }
  const adapter = channelAdapters[conn.provider as keyof typeof channelAdapters]
  if (!adapter) throw new ServiceError("PROVIDER_NOT_REGISTERED", 409, `Proveedor no registrado: ${conn.provider}`)
  if (!adapter.capabilities.media) {
    throw validation("Esa conexión no admite adjuntos: elige otro canal")
  }
  return { id: conn.id, channel: conn.channel, provider: conn.provider, displayName: conn.displayName }
}

/**
 * Deja un PDF en la conversación de la persona por esa conexión (la abre o la
 * reabre: escribir reabre, ADR 0024) y vuelve encolado; el worker lo entrega.
 * La única forma de enviar un documento: la usan cobros y papeles de salud.
 */
export async function deliverDocumentPdf(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  input: {
    recipient: Pick<DocumentRecipient, "contactId" | "email" | "phone">
    /** La conexión; sin ella, `conversationId` (el hilo que ya eligió la regla de envío). */
    conn?: UsableConnection
    /** El hilo ya elegido (`routeMessage`): no se busca otro. */
    conversationId?: string
    pdf: Uint8Array
    filename: string
    caption: string
    /** Con otro correo el hilo es el de esa dirección. */
    exactAddress?: boolean
    /** Quién lo deja en el hilo: una persona del equipo o el agente. */
    senderKind?: "user" | "agent"
  },
  deps: SendDeps,
): Promise<{ conversationId: string; messageId: string }> {
  if (input.pdf.byteLength > 20 * 1024 * 1024) throw validation("El documento supera 20 MB: no se puede adjuntar")
  let conversationId = input.conversationId
  if (!conversationId) {
    if (!input.conn) throw validation("Elige el canal de envío")
    if (!actorUserId) throw validation("Sin conversación elegida, el envío lo hace una persona del equipo")
    conversationId = (
      await resolveConversation(tx, orgId, actorUserId, input.recipient, input.conn, input.exactAddress ?? false)
    ).id
  }
  // La misma puerta que todo envío (ADR 0042): un aviso que manda el equipo
  // sale como respuesta a quien acaba de escribir o con su permiso.
  const [thread] = await tx
    .select({ lastInboundAt: conversation.lastInboundAt })
    .from(conversation)
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  const via = windowOpen(thread?.lastInboundAt) ? "respuesta" : "otra"
  if (!(await permitsMessage(tx, orgId, input.recipient.contactId, { purpose: "avisos", initiative: "equipo", via }))) {
    throw new ServiceError("DOCUMENT_OPTED_OUT", 409, DOCUMENT_OPTED_OUT)
  }
  const ref = await deps.storage.putAttachment({
    orgId,
    conversationId,
    bytes: input.pdf,
    contentType: "application/pdf",
    ext: "pdf",
  })
  const senderKind = input.senderKind ?? (actorUserId ? "user" : "agent")
  const created = await sendOutbound(tx, orgId, {
    conversationId,
    senderKind,
    ...(senderKind === "user" && actorUserId ? { senderUserId: actorUserId } : {}),
    content: {
      type: "media",
      attachment: { ...ref, filename: asciiFilename(input.filename) },
      caption: input.caption,
    },
  })
  return { conversationId, messageId: created.id }
}

export async function sendFinancialDocument(
  tx: Db,
  orgId: string,
  actorUserId: string,
  memberRole: string,
  input: SendFinancialDocumentInput,
  deps: SendDeps,
): Promise<SendFinancialDocumentResult> {
  const documentType = assertDocumentType(input.documentType)
  if (!input.connectionId) throw validation("Elige el canal de envío")
  const { meta, preferContactId } = await loadDocumentMeta(tx, orgId, input.patientId, documentType, input.documentId)
  if (input.requestId) {
    // Mismo intento = un solo envío: se serializa por clave y se devuelve lo ya hecho.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('doc-send:' || ${orgId} || ':' || ${input.requestId}))`,
    )
    const [previous] = await tx
      .select({ entityId: auditEvent.entityId, metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.organizationId, orgId),
          eq(auditEvent.action, "financial_document.sent"),
          sql`${auditEvent.metadata}->>'requestId' = ${input.requestId}`,
        ),
      )
      .limit(1)
    if (previous) {
      const sent = previous.metadata as {
        documentId?: string
        conversationId?: string
        channel?: string
        deliveredBudget?: boolean
        sentToEmail?: string | null
      }
      if (sent.documentId !== input.documentId)
        throw new ServiceError("REQUEST_ID_CONFLICT", 409, "Esa clave de envío ya se usó con otro documento")
      return {
        conversationId: sent.conversationId ?? "",
        messageId: previous.entityId ?? "",
        status: "queued",
        channel: sent.channel ?? "",
        documentLabel: meta.label,
        deliveredBudget: sent.deliveredBudget ?? false,
        sentToEmail: sent.sentToEmail ?? null,
      }
    }
  }
  const registered = await requireAuthorizedRecipient(tx, orgId, input.patientId, input.recipientContactId, preferContactId, documentType)
  // Otro correo: lo decide quien envía, de forma explícita, y queda registrado.
  const otherEmail = input.otherEmail?.trim() ? assertEmail(input.otherEmail) : null
  if (otherEmail && !input.confirmOtherEmail)
    throw validation("Confirma que la persona pidió recibirlo en ese correo")
  const recipient: DocumentRecipient = otherEmail ? { ...registered, email: otherEmail } : registered
  const conn = await requireDocumentConnection(tx, orgId, input.connectionId)
  if (otherEmail && conn.channel !== "email")
    throw validation("Otro correo solo se puede usar enviando por correo")

  let filename: string
  let subject: string
  let defaultBody: string
  let pdf: Uint8Array
  let deliveredBudget = false
  if (documentType === "ticket") {
    const snap = await buildTicketSnapshot(tx, orgId, input.patientId, input.documentId)
    pdf = await renderTicketPdf(snap, input.paper ?? null)
    filename = asciiFilename(`Ticket-${snap.numberLabel}.pdf`)
    subject = `Ticket N.º ${snap.numberLabel} · ${snap.org.tradeName}`
    defaultBody = "Te enviamos tu ticket de cobro en PDF."
  } else {
    if (memberRole === "dentist") {
      await requireDentistOwnPlan(tx, orgId, actorUserId, input.patientId, input.documentId)
    }
    deliveredBudget = await deliverIfDraft(tx, orgId, actorUserId, memberRole, input.patientId, input.documentId)
    const snap = await buildBudgetSnapshot(tx, orgId, input.patientId, input.documentId, {
      actorUserId,
      memberRole,
    })
    pdf = await renderBudgetPdf(snap, input.paper ?? null)
    filename = asciiFilename(`Presupuesto-${snap.numberLabel.replace(/\D/g, "")}-r${snap.sourceId.slice(0, 4)}.pdf`)
    subject = `Presupuesto ${snap.numberLabel} · ${snap.org.tradeName}`
    defaultBody = "Te enviamos tu presupuesto en PDF."
  }
  const body = cleanMessage(input.message) ?? defaultBody
  const { conversationId, messageId } = await deliverDocumentPdf(
    tx,
    orgId,
    actorUserId,
    {
      recipient,
      conn,
      pdf,
      filename,
      caption: captionWithSubject(subject, `${body}\n${meta.label}`),
      exactAddress: !!otherEmail,
    },
    deps,
  )
  const created = { id: messageId }
  if (input.savePreferredChannel) {
    await tx
      .update(contact)
      .set({ preferredChannel: conn.channel, updatedAt: new Date() })
      .where(and(eq(contact.id, recipient.contactId), eq(contact.organizationId, orgId)))
  }
  const sentToEmail = conn.channel === "email" ? (recipient.email?.trim().toLowerCase() ?? null) : null
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "financial_document.sent",
    entity: "message",
    entityId: created.id,
    metadata: {
      patientId: input.patientId,
      documentType,
      documentId: input.documentId,
      recipientContactId: recipient.contactId,
      connectionId: conn.id,
      conversationId,
      channel: conn.channel,
      deliveredBudget,
      sentToEmail,
      // Dirección distinta de la registrada: decisión explícita de quien envió.
      ...(otherEmail ? { otherEmail: true, registeredEmail: registered.email, decidedBy: actorUserId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
    },
  })
  return {
    conversationId,
    messageId: created.id,
    status: "queued",
    channel: conn.channel,
    documentLabel: meta.label,
    deliveredBudget,
    sentToEmail,
  }
}

export type TicketReceiptOutcome =
  | { sent: "correo"; email: string; conversationId: string; messageId: string }
  /** Lo que dice Caja: «Sin correo: entrégalo impreso o pídele su correo». */
  | { sent: null; reason: "sin_correo" | "sin_conexion" | "correo_ajeno" | "sin_permiso"; text: string }

const RECEIPT_WORDS: Record<"sin_correo" | "sin_conexion" | "correo_ajeno" | "sin_permiso", string> = {
  sin_correo: "Sin correo: entrégalo impreso o pídele su correo",
  sin_conexion: "La clínica no tiene un correo conectado: entrégalo impreso",
  correo_ajeno: "Su correo está vinculado a otra persona: entrégalo impreso",
  sin_permiso: "Pidió no recibir ningún mensaje de la clínica: entrégalo impreso",
}

/**
 * Al cobrar, el comprobante (el ticket) sale solo por correo a quien pagó o a
 * la persona (decisión 20 v2) y queda en «Tus papeles». Por WhatsApp no se
 * envía: solo si la persona lo pide en el chat, y entonces lo manda el agente
 * en esa conversación (`sendReceiptInConversation`). Sin correo no sale nada y
 * Caja lo dice. Es un aviso de lo que pasó: solo lo frena «No quiero ningún mensaje».
 */
export async function sendTicketReceiptByEmail(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  ticketId: string,
  deps: SendDeps,
): Promise<TicketReceiptOutcome> {
  const { preferContactId } = await loadDocumentMeta(tx, orgId, patientId, "ticket", ticketId)
  const recipient = await requireAuthorizedRecipient(tx, orgId, patientId, undefined, preferContactId)
  const no = (reason: "sin_correo" | "sin_conexion" | "correo_ajeno" | "sin_permiso"): TicketReceiptOutcome => ({
    sent: null,
    reason,
    text: RECEIPT_WORDS[reason],
  })
  if (!recipient.email?.trim()) return no("sin_correo")
  if (!(await mayWriteFirst(tx, orgId, recipient.contactId, NOTICE_PURPOSE))) return no("sin_permiso")
  const [mailbox] = await tx
    .select()
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, "email"),
        eq(channelConnection.status, "active"),
      ),
    )
    .orderBy(channelConnection.createdAt)
    .limit(1)
  if (!mailbox) return no("sin_conexion")
  const conn = await requireDocumentConnection(tx, orgId, mailbox.id)
  const snap = await buildTicketSnapshot(tx, orgId, patientId, ticketId)
  const pdf = await renderTicketPdf(snap, null)
  let delivered: { conversationId: string; messageId: string }
  try {
    delivered = await deliverDocumentPdf(
      tx,
      orgId,
      actorUserId,
      {
        recipient,
        conn,
        pdf,
        filename: asciiFilename(`Comprobante-${snap.numberLabel}.pdf`),
        caption: captionWithSubject(
          `Comprobante N.º ${snap.numberLabel} · ${snap.org.tradeName}`,
          "Te enviamos el comprobante de tu pago en PDF. También lo encuentras en tu enlace, en «Tus papeles».",
        ),
      },
      deps,
    )
  } catch (error) {
    if (error instanceof ServiceError && error.code === "AMBIGUOUS_CHANNEL_HISTORY") return no("correo_ajeno")
    throw error
  }
  const email = recipient.email.trim().toLowerCase()
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "financial_document.sent",
    entity: "message",
    entityId: delivered.messageId,
    metadata: {
      patientId,
      documentType: "ticket",
      documentId: ticketId,
      recipientContactId: recipient.contactId,
      connectionId: conn.id,
      conversationId: delivered.conversationId,
      channel: "email",
      sentToEmail: email,
      automatic: true,
    },
  })
  return { sent: "correo", email, ...delivered }
}

/**
 * El comprobante por WhatsApp, cuando la persona lo pide en el chat (decisión
 * 20 v2): el agente lo deja como respuesta en esa misma conversación, sin
 * gastar un mensaje aprobado. Solo de un paciente por el que quien escribe
 * decide (la propia persona o su representante legal) y de los últimos 30
 * días, como «Tus papeles». Sin uno, devuelve null.
 */
export async function sendReceiptInConversation(
  tx: Db,
  orgId: string,
  input: { conversationId: string; patientId: string },
  deps: SendDeps,
): Promise<{ label: string; messageId: string } | null> {
  const [thread] = await tx
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!thread) throw notFound("Conversación")
  // El comprobante lista lo que se le hizo (datos de salud): por el chat solo
  // va a quien decide por el paciente, con la regla única y el corte a los 18
  // años con el día de la clínica (`listDecisionRecipients`).
  const decides = await listDecisionRecipients(tx, orgId, input.patientId)
  const recipient = decides.find((row) => row.contactId === thread.contactId)
  if (!recipient) return null
  const [ticket] = await tx
    .select({ id: paymentTicket.id })
    .from(paymentTicket)
    .where(
      and(
        eq(paymentTicket.organizationId, orgId),
        eq(paymentTicket.patientId, input.patientId),
        isNull(paymentTicket.voidedAt),
        sql`${paymentTicket.createdAt} >= now() - interval '30 days'`,
      ),
    )
    .orderBy(desc(paymentTicket.createdAt))
    .limit(1)
  if (!ticket) return null
  const snap = await buildTicketSnapshot(tx, orgId, input.patientId, ticket.id)
  const pdf = await renderTicketPdf(snap, null)
  const label = `Comprobante N.º ${snap.numberLabel}`
  const delivered = await deliverDocumentPdf(
    tx,
    orgId,
    null,
    {
      recipient,
      conversationId: input.conversationId,
      pdf,
      filename: asciiFilename(`Comprobante-${snap.numberLabel}.pdf`),
      caption: label,
      senderKind: "agent",
    },
    deps,
  )
  return { label, messageId: delivered.messageId }
}

/**
 * «Agregar correo»: guarda el correo en los datos de quien recibe (la propia
 * persona o un responsable vigente del paciente), con las mismas reglas y la
 * misma traza que editar el contacto.
 */
export async function saveRecipientEmail(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: { recipientContactId: string; email: string },
): Promise<DocumentRecipient> {
  const recipient = await requireAuthorizedRecipient(tx, orgId, patientId, input.recipientContactId)
  const email = assertEmail(input.email)
  await updateContact(tx, orgId, recipient.contactId, { email }, { userId: actorUserId })
  return { ...recipient, email }
}

/** PDF del documento para previsualizar/descargar (impresión usa el mismo). */
export async function getFinancialDocumentPdf(
  tx: Db,
  orgId: string,
  patientId: string,
  input: { documentType: string; documentId: string; paper?: string | null },
  /** Quién lo pide: un odontólogo solo obtiene presupuestos de sus planes. */
  actor: { actorUserId?: string; memberRole?: string } = {},
): Promise<{ bytes: Uint8Array; filename: string }> {
  const documentType = assertDocumentType(input.documentType)
  if (documentType === "ticket") {
    const snap = await buildTicketSnapshot(tx, orgId, patientId, input.documentId)
    return {
      bytes: await renderTicketPdf(snap, input.paper ?? null),
      filename: asciiFilename(`Ticket-${snap.numberLabel}.pdf`),
    }
  }
  const snap = await buildBudgetSnapshot(tx, orgId, patientId, input.documentId, actor)
  return {
    bytes: await renderBudgetPdf(snap, input.paper ?? null),
    filename: asciiFilename(`Presupuesto-${snap.numberLabel.replace(/\D/g, "")}.pdf`),
  }
}
