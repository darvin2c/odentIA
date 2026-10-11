/**
 * Envío de documentos económicos al paciente (Fase 7 Finanzas).
 *
 * - PDF desde snapshot (financial-document-pdf.ts, generador único también
 *   usado por impresión): ticket del cobro, presupuesto del plan.
 * - Destinatario: la propia persona o un pagador autorizado (responsable
 *   económico, representante legal o autorizado de información vigente). Nunca
 *   se verifica identidad por coincidencia de teléfono.
 * - Canal: correo si la persona tiene uno y hay conexión de correo activa;
 *   si no, su medio preferido entre los conectados; quien envía puede
 *   cambiarlo. Sin canal utilizable se devuelve el texto para configurar.
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
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { findChannelIdentity, lockChannelIdentity, normalizeChannelIdentity } from "./contacts.js"
import { sendOutbound, startContactConversation } from "./conversations.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { deliverBudget, requireOwnPlan } from "./budgets.js"
import {
  buildBudgetSnapshot,
  buildTicketSnapshot,
  renderBudgetPdf,
  renderTicketPdf,
} from "./financial-document-pdf.js"
import type { Storage } from "./storage.js"
import { requirePatient } from "./patients.js"

export const FINANCIAL_DOCUMENT_TYPES = ["ticket", "budget"] as const
export type FinancialDocumentType = (typeof FINANCIAL_DOCUMENT_TYPES)[number]
/** Ventana de sesión para texto/media (igual que conversaciones: 24 h). */
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000

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

/** Personas autorizadas a recibir el documento económico del paciente. */
export async function listDocumentRecipients(
  tx: Db,
  orgId: string,
  patientId: string,
  preferContactId?: string | null,
): Promise<DocumentRecipient[]> {
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
): Promise<DocumentRecipient> {
  const recipients = await listDocumentRecipients(tx, orgId, patientId, preferContactId)
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
      statusLabel: budget.status === "borrador" ? "Borrador (se entrega al enviar)" : budget.status,
      isDraft: budget.status === "borrador",
    },
    preferContactId: budget.decisionContactId,
  }
}

interface UsableConnection {
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

/** Propuesta pura de canal: correo con conexión > preferido utilizable > última conversación > primero utilizable. */
export function proposeChannel<T extends { channel: string; usable: boolean; hasThread: boolean; connectionId: string }>(
  options: T[],
  input: { email: string | null; preferredChannel: string | null; lastChannel: string | null },
): T | null {
  const usable = options.filter((o) => o.usable)
  if (usable.length === 0) return null
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
): Promise<DocumentSendOptions> {
  const documentType = assertDocumentType(input.documentType)
  const { meta, preferContactId } = await loadDocumentMeta(tx, orgId, patientId, documentType, input.documentId)
  const recipients = await listDocumentRecipients(tx, orgId, patientId, preferContactId)
  if (recipients.length === 0) throw notFound("Destinatario del documento")
  const recipient =
    (input.recipientContactId && recipients.find((r) => r.contactId === input.recipientContactId)) ||
    recipients.find((r) => r.isDefault) ||
    recipients[0]
  if (!recipient) throw notFound("Destinatario del documento")
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
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.contactId, recipient.contactId),
        eq(conversation.status, "open"),
      ),
    )
    .orderBy(desc(conversation.lastMessageAt))
  const connections = await listMediaConnections(tx, orgId)
  const now = Date.now()
  const channels: DocumentChannelOption[] = connections.map((conn) => {
    const thread = threads.find((t) => t.conversation.channelConnectionId === conn.id)
    const lastInboundAt = thread?.conversation.lastInboundAt?.getTime() ?? null
    const withinWindow = lastInboundAt !== null && now - lastInboundAt <= SESSION_WINDOW_MS
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
  const proposed = proposeChannel(channels, {
    email: recipient.email,
    preferredChannel: recipientRow?.preferredChannel ?? null,
    lastChannel: threads[0]?.connection.channel ?? null,
  })
  if (proposed) proposed.isProposed = true
  return { recipients, recipient, channels, proposed, document: meta }
}

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

// Plan propio del odontólogo al enviar presupuestos ya entregados
// (`deliverBudget` aplica la misma regla al entregar el borrador).
async function requireDentistOwnPlan(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
): Promise<void> {
  const [head] = await tx
    .select({ planId: treatmentBudget.planId })
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
  await requireOwnPlan(tx, orgId, head.planId, actorUserId, "dentist")
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
}

export interface SendFinancialDocumentResult {
  conversationId: string
  messageId: string
  /** Siempre `encolado` al responder: el worker entrega por el adaptador real. */
  status: "queued"
  channel: string
  documentLabel: string
  deliveredBudget: boolean
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

async function ensureEmailIdentity(
  tx: Db,
  orgId: string,
  recipient: DocumentRecipient,
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

async function resolveConversation(
  tx: Db,
  orgId: string,
  actorUserId: string,
  recipient: DocumentRecipient,
  conn: UsableConnection,
): Promise<{ id: string }> {
  if (conn.channel === "email") {
    const identity = await ensureEmailIdentity(tx, orgId, recipient)
    const [thread] = await tx
      .select({ id: conversation.id, status: conversation.status })
      .from(conversation)
      .where(
        and(
          eq(conversation.organizationId, orgId),
          eq(conversation.contactId, recipient.contactId),
          eq(conversation.channelConnectionId, conn.id),
          eq(conversation.status, "open"),
        ),
      )
      .orderBy(desc(conversation.lastMessageAt))
      .limit(1)
    if (thread) return { id: thread.id }
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
    if (!retry || retry.contactId !== recipient.contactId || retry.status !== "open") {
      throw new ServiceError(
        "AMBIGUOUS_CHANNEL_HISTORY",
        409,
        "El hilo ya existe con otro estado: resuélvelo manualmente",
      )
    }
    return { id: retry.id }
  }
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
    if (started.status !== "open") {
      throw new ServiceError("CONVERSATION_CLOSED", 409, "La conversación está cerrada: reábela antes de enviar")
    }
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
        eq(conversation.status, "open"),
      ),
    )
    .orderBy(desc(conversation.lastMessageAt))
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
  const recipient = await requireAuthorizedRecipient(tx, orgId, input.patientId, input.recipientContactId, preferContactId)
  const [conn] = await tx
    .select()
    .from(channelConnection)
    .where(and(eq(channelConnection.id, input.connectionId), eq(channelConnection.organizationId, orgId)))
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
  const usable: UsableConnection = { id: conn.id, channel: conn.channel, provider: conn.provider, displayName: conn.displayName }

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
    const snap = await buildBudgetSnapshot(tx, orgId, input.patientId, input.documentId)
    pdf = await renderBudgetPdf(snap, input.paper ?? null)
    filename = asciiFilename(`Presupuesto-${snap.numberLabel.replace(/\D/g, "")}-r${snap.sourceId.slice(0, 4)}.pdf`)
    subject = `Presupuesto ${snap.numberLabel} · ${snap.org.tradeName}`
    defaultBody = "Te enviamos tu presupuesto en PDF."
  }
  if (pdf.byteLength > 20 * 1024 * 1024) throw validation("El documento supera 20 MB: no se puede adjuntar")

  const { id: conversationId } = await resolveConversation(tx, orgId, actorUserId, recipient, usable)
  const ref = await deps.storage.putAttachment({
    orgId,
    conversationId,
    bytes: pdf,
    contentType: "application/pdf",
    ext: "pdf",
  })
  const body = cleanMessage(input.message) ?? defaultBody
  const created = await sendOutbound(tx, orgId, {
    conversationId,
    senderKind: "user",
    senderUserId: actorUserId,
    content: {
      type: "media",
      attachment: { ...ref, filename },
      caption: captionWithSubject(subject, `${body}\n${meta.label}`),
    },
  })
  if (input.savePreferredChannel) {
    await tx
      .update(contact)
      .set({ preferredChannel: conn.channel, updatedAt: new Date() })
      .where(and(eq(contact.id, recipient.contactId), eq(contact.organizationId, orgId)))
  }
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
      channel: conn.channel,
      deliveredBudget,
    },
  })
  return {
    conversationId,
    messageId: created.id,
    status: "queued",
    channel: conn.channel,
    documentLabel: meta.label,
    deliveredBudget,
  }
}

/** PDF del documento para previsualizar/descargar (impresión usa el mismo). */
export async function getFinancialDocumentPdf(
  tx: Db,
  orgId: string,
  patientId: string,
  input: { documentType: string; documentId: string; paper?: string | null },
): Promise<{ bytes: Uint8Array; filename: string }> {
  const documentType = assertDocumentType(input.documentType)
  if (documentType === "ticket") {
    const snap = await buildTicketSnapshot(tx, orgId, patientId, input.documentId)
    return {
      bytes: await renderTicketPdf(snap, input.paper ?? null),
      filename: asciiFilename(`Ticket-${snap.numberLabel}.pdf`),
    }
  }
  const snap = await buildBudgetSnapshot(tx, orgId, patientId, input.documentId)
  return {
      bytes: await renderBudgetPdf(snap, input.paper ?? null),
    filename: asciiFilename(`Presupuesto-${snap.numberLabel.replace(/\D/g, "")}.pdf`),
  }
}
