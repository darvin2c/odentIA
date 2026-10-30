import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import {
  patient,
  patientContact,
  patientDocument,
  treatmentBudget,
} from "@odentia/db/schema/clinical"
import { type PatientGuide, parsePatientGuide } from "@odentia/clinical"
import { channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import { user } from "@odentia/db/schema/auth"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import {
  portalAccessLog,
  portalLink,
  portalSession,
  type PortalScope,
} from "@odentia/db/schema/portal"
import { portalPasskey } from "@odentia/db/schema/portal-access"
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, max } from "drizzle-orm"
import {
  assertOwnAppointmentChangeable,
  cancelOwnAppointment,
  confirmOwnAppointment,
  moveOwnAppointment,
} from "./own-appointment.js"
import { type BookingLinkSlot, listWeekSlots } from "./booking-links.js"
import { decideBudget, getBudgetDetail, listBudgets, type BudgetWithTotals } from "./budgets.js"
import { getPatientDocument, listPatientDocuments } from "./clinical.js"
import { sendOutbound } from "./conversations.js"
import {
  isUniqueViolation,
  notFound,
  ServiceError,
  validation,
} from "./errors.js"
import { requirePatient } from "./patients.js"
import { contactDecides } from "./responsibilities.js"
import { getPatientAccount } from "./payments.js"
import { branchAddressColumns, branchAddressWriter, branchDirectionsWriter } from "./branches.js"
import { appointmentCalendarDownload } from "./appointment-calendar.js"
import { findOrgLocale, getOrgLocale } from "./locale.js"
import type { Storage } from "./storage.js"
import { createWorkspaceNotification } from "./workspace.js"
import { getPortalPolicy, PORTAL_FIXED, portalDisabled, requireActivePortalGrant } from "./portal-policy.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"

/**
 * Quién puede compartir qué en el portal: los presupuestos, quien los envía
 * (recepción incluida, decisión 4); la cuenta, quien ve la caja; los
 * documentos, quien lee la historia.
 */
export interface PortalShareRights {
  canShareBudgets: boolean
  canShareAccount: boolean
  canShareDocuments: boolean
}

export function assertShareRights(scope: PortalScope, rights: PortalShareRights): void {
  if (scope.budgets && !rights.canShareBudgets)
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "Dar acceso a los presupuestos requiere poder enviarlos")
  if (scope.account && !rights.canShareAccount)
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "Dar acceso a la cuenta requiere permiso de caja")
  if (scope.documents.length > 0 && !rights.canShareDocuments)
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "Dar acceso a los documentos requiere leer la historia")
}

/**
 * Portal del paciente: enlaces de un solo uso + sesiones revocables.
 *
 * - El token crudo solo existe en memoria y en el mensaje de entrega; en DB
 *   solo vive su hash sha256.
 * - La entrega del enlace exige una conversación abierta del mismo contacto
 *   (canal ya validado por el operador): la API staff jamás devuelve el token.
 * - Cada sesión queda ligada a UN paciente + UN contacto + alcance congelado.
 * - Lo que hace la persona en el portal (confirmar, reprogramar, decidir, abrir
 *   un documento) queda a su nombre: el actor es `contact:<id>` (`portalActor`),
 *   nunca quien emitió el enlace, que solo recibe el aviso. Cada lectura
 *   sensible se registra en portal_access_log.
 */

const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

function rawToken(): string {
  return randomBytes(32).toString("base64url")
}

function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function assertTokenFormat(value: unknown): string {
  if (typeof value !== "string" || !LINK_TOKEN_RE.test(value)) throw notFound("Enlace de acceso")
  return value
}

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

async function auditPortal(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  action: string,
  entity: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity,
    entityId,
    metadata: metadata ?? {},
  })
}

export async function logAccess(
  tx: Db,
  orgId: string,
  sessionId: string,
  action: string,
  entityType?: string,
  entityId?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(portalAccessLog).values({
    organizationId: orgId,
    sessionId,
    action,
    entityType: entityType ?? null,
    entityId: entityId ?? null,
    metadata: metadata ?? {},
  })
}

/**
 * Aviso dirigido al operador emisor ante acciones del portal. Sin token ni
 * PII en el texto: el detalle vive en la pantalla interna del href.
 */
async function notifyIssuer(
  tx: Db,
  orgId: string,
  session: PortalSessionRow,
  input: { dedupeKey: string; title: string; body: string; href: string },
): Promise<void> {
  if (!session.issuedBy) return
  await createWorkspaceNotification(tx, orgId, {
    userId: session.issuedBy,
    dedupeKey: input.dedupeKey,
    title: input.title,
    body: input.body,
    href: input.href,
    permission: "patients.read",
  })
}

export type PortalLinkRow = typeof portalLink.$inferSelect
export type PortalSessionRow = typeof portalSession.$inferSelect

export interface PortalLinkView {
  id: string
  patientId: string
  patientName: string
  contactId: string
  contactName: string
  scope: PortalScope
  status: string
  expiresAt: Date
  usedAt: Date | null
  revokedAt: Date | null
  deliveryConversationId: string | null
  deliveryMessageId: string | null
  createdAt: Date
}

export interface PortalSessionView {
  id: string
  patientId: string
  contactId: string
  scope: PortalScope
  expiresAt: Date
  /** Cerrada por el equipo, por un acceso retirado o por la persona: ya no sirve aunque no haya vencido. */
  revokedAt: Date | null
  grantId: string | null
  authMethod: "enlace_pin" | "passkey"
}

export function toSessionView(row: PortalSessionRow): PortalSessionView {
  return {
    id: row.id,
    patientId: row.patientId,
    contactId: row.contactId,
    scope: row.scope,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    grantId: row.grantId,
    authMethod: row.authMethod === "passkey" ? "passkey" : "enlace_pin",
  }
}

export interface IssuePortalLinkInput {
  patientId: string
  contactId: string
  conversationId: string
  scope: {
    appointments?: boolean
    budgets?: boolean
    account?: boolean
    documentIds?: string[]
  }
  idempotencyKey?: string
}

/** Vínculo representante↔paciente explícito: sin fila no hay enlace. */
async function requirePatientLink(tx: Db, orgId: string, patientId: string, contactId: string) {
  const [link] = await tx
    .select({ id: patientContact.id })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, patientId),
        eq(patientContact.contactId, contactId),
      ),
    )
    .limit(1)
  if (!link) throw validation("El contacto no está vinculado a este paciente")
}

/**
 * El acceso se vuelve a comprobar en cada uso, con la regla de quién puede
 * entrar (`portalCandidates`): la propia persona mayor de edad o su
 * representante legal vigente. Sin vínculo, con la tutela revocada o con la
 * hija que ya cumplió 18 (su madre la representaba de menor), el acceso
 * equivale a revocado.
 */
export async function requireActiveGrant(tx: Db, orgId: string, patientId: string, contactId: string): Promise<void> {
  if (!(await contactDecides(tx, orgId, patientId, contactId))) {
    throw conflict("PORTAL_REVOKED", "Este acceso fue revocado; pide uno nuevo en recepción")
  }
}

export async function assertScope(
  tx: Db,
  orgId: string,
  patientId: string,
  scope: IssuePortalLinkInput["scope"],
): Promise<PortalScope> {
  const appointments = scope?.appointments === true
  const budgets = scope?.budgets === true
  const account = scope?.account === true
  const raw = Array.isArray(scope?.documentIds) ? scope.documentIds : []
  const documentIds = [...new Set(raw.filter((id) => typeof id === "string" && id.length > 0))]
  if (documentIds.length > 100) throw validation("Demasiados documentos autorizados (máximo 100)")
  if (!appointments && !budgets && !account && documentIds.length === 0) {
    throw validation("El alcance no puede estar vacío")
  }
  if (documentIds.length > 0) {
    const found = await tx
      .select({ id: patientDocument.id })
      .from(patientDocument)
      .where(
        and(
          eq(patientDocument.organizationId, orgId),
          eq(patientDocument.patientId, patientId),
          inArray(patientDocument.id, documentIds),
        ),
      )
    if (found.length !== documentIds.length) {
      throw notFound("Documento")
    }
  }
  return { appointments, budgets, account, documents: documentIds }
}

async function linkView(tx: Db, orgId: string, row: PortalLinkRow): Promise<PortalLinkView> {
  const [patientRow] = await tx
    .select({ displayName: patientPerson.displayName })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.id, row.patientId), eq(patient.organizationId, orgId)))
    .limit(1)
  const [contactRow] = await tx
    .select({ displayName: contact.displayName })
    .from(contact)
    .where(and(eq(contact.id, row.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  return {
    id: row.id,
    patientId: row.patientId,
    patientName: patientRow?.displayName ?? "Paciente",
    contactId: row.contactId,
    contactName: contactRow?.displayName ?? "Contacto",
    scope: row.scope,
    status: row.status,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    revokedAt: row.revokedAt,
    deliveryConversationId: row.deliveryConversationId,
    deliveryMessageId: row.deliveryMessageId,
    createdAt: row.createdAt,
  }
}

export interface IssuedPortalLink {
  link: PortalLinkView
  delivery: { conversationId: string; messageId: string }
  replay: boolean
  /** PIN de 6 dígitos, visible una sola vez para el operador (vía independiente). */
  pinOnce: string | null
}

/**
 * Emite un enlace de un solo uso y lo entrega por la conversación indicada.
 * Todo o nada: si el envío falla, el enlace no se crea (el cliente reintenta
 * con la misma idempotencyKey). El token crudo jamás se persiste ni se
 * devuelve en esta respuesta: viaja solo en el mensaje al contacto.
 */
export async function issuePortalLink(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: IssuePortalLinkInput,
  deliver: { linkUrl: (rawLinkToken: string) => string } & PortalShareRights,
): Promise<IssuedPortalLink> {
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled) throw portalDisabled()
  const linkTtlMs = PORTAL_FIXED.linkTtlHours * 3600_000
  const idempotencyKey = input.idempotencyKey?.trim() || null
  if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
    throw validation("La clave de idempotencia debe tener 8–128 caracteres")
  }
  const patientRow = await requirePatient(tx, orgId, input.patientId)
  if (!patientRow.isActive) throw notFound("Paciente")
  const [contactRow] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.id, input.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!contactRow) throw notFound("Contacto")
  if (!contactRow.isActive) throw validation("El contacto está inactivo")
  await requirePatientLink(tx, orgId, input.patientId, input.contactId)
  const scope = await assertScope(tx, orgId, input.patientId, input.scope)
  if (scope.appointments && !policy.allowedScope.appointments) {
    throw validation("Las citas no están permitidas por la política del portal")
  }
  if (scope.budgets && !policy.allowedScope.budgets) {
    throw validation("Los presupuestos no están permitidos por la política del portal")
  }
  if (scope.account && !policy.allowedScope.account) {
    throw validation("La cuenta no está permitida por la política del portal")
  }
  if (scope.documents.length > 0 && !policy.allowedScope.documents) {
    throw validation("Los documentos no están permitidos por la política del portal")
  }
  assertShareRights(scope, deliver)
  if (idempotencyKey) {
    const [existing] = await tx
      .select()
      .from(portalLink)
      .where(and(eq(portalLink.organizationId, orgId), eq(portalLink.idempotencyKey, idempotencyKey)))
      .limit(1)
    if (existing && existing.status === "pendiente" && existing.expiresAt.getTime() > Date.now()) {
      const view = await linkView(tx, orgId, existing)
      return {
        link: view,
        delivery: {
          conversationId: existing.deliveryConversationId ?? "",
          messageId: existing.deliveryMessageId ?? "",
        },
        replay: true,
        pinOnce: null,
      }
    }
  }
  // La emisión exige el grant verificado ya creado: nunca crea grants
  // implícitos ni toca las passkeys (la recuperación usa el endpoint dedicado
  // de revocación). Volver a dar acceso con el código siempre se puede.
  await requireActivePortalGrant(tx, orgId, input.patientId, input.contactId)

  const [conv] = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!conv) throw notFound("Conversación")
  if (conv.contactId !== input.contactId) {
    throw validation("La conversación no pertenece a este contacto")
  }
  // Cerrada no impide emitir: el envío por la conversación la reabre (ADR 0024).
  // Sale por la conversación de la propia persona, con su conexión activa.
  const [issuanceConnection] = await tx
    .select({ id: channelConnection.id, status: channelConnection.status })
    .from(channelConnection)
    .where(eq(channelConnection.id, conv.channelConnectionId))
    .limit(1)
  if (issuanceConnection?.status !== "active") {
    throw new ServiceError("PORTAL_NO_CHANNEL", 409, "Su conversación ya no tiene un canal activo: dale acceso con el QR en recepción")
  }

  const token = rawToken()
  const pin = String(randomInt(0, 1_000_000)).padStart(6, "0")
  const now = new Date()
  let row: PortalLinkRow
  try {
    const [inserted] = await tx
      .insert(portalLink)
      .values({
        organizationId: orgId,
        patientId: input.patientId,
        contactId: input.contactId,
        scope,
        tokenHash: hashToken(token),
        pinHash: hashToken(pin),
        status: "pendiente",
        expiresAt: new Date(now.getTime() + linkTtlMs),
        idempotencyKey,
        createdBy: actorUserId,
      })
      .returning()
    if (!inserted) throw new Error("No se pudo emitir el enlace")
    row = inserted
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("PORTAL_REPLAY", "Ya se emitió un enlace con esa clave; recarga la lista")
    }
    throw error
  }

  const url = deliver.linkUrl(token)
  const zone = await getOrgLocale(tx, orgId)
  const vence = row.expiresAt.toLocaleString(zone.locale, { dateStyle: "medium", timeStyle: "short", timeZone: zone.timezone })
  // Mensaje genérico y discreto: sin nombres, sin datos clínicos ni PIN.
  const text =
    `Tienes un acceso al portal del paciente: ${url}\nVence el ${vence}. Al abrirlo te pedirá un código ` +
    `de 6 dígitos: pídelo a quien te envió este mensaje. No lo compartas: es personal y vence pronto.`
  const sent = await sendOutbound(tx, orgId, {
    conversationId: conv.id,
    senderKind: "user",
    senderUserId: actorUserId,
    content: { type: "text", text },
  })
  const [updated] = await tx
    .update(portalLink)
    .set({ deliveryConversationId: conv.id, deliveryMessageId: sent.id, updatedAt: new Date() })
    .where(and(eq(portalLink.id, row.id), eq(portalLink.organizationId, orgId)))
    .returning()
  await auditPortal(tx, orgId, actorUserId, "portal.link_issued", "portal_link", row.id, {
    patientId: input.patientId,
    contactId: input.contactId,
    conversationId: conv.id,
    messageId: sent.id,
    scope,
  })
  return {
    link: await linkView(tx, orgId, updated ?? row),
    delivery: { conversationId: conv.id, messageId: sent.id },
    replay: false,
    pinOnce: pin,
  }
}

export interface IssuePortalActivationQrInput {
  patientId: string
  contactId: string
  scope: IssuePortalLinkInput["scope"]
  idempotencyKey?: string
}

export interface IssuedPortalActivationQr {
  link: PortalLinkView
  /** Token crudo de un solo uso: la UI lo muestra en QR una sola vez. */
  rawTokenOnce: string
  /** PIN de 6 dígitos: el operador lo dicta en persona (nunca en bandeja). */
  pinOnce: string
}

/**
 * Activación directa con QR individual (paciente presente). Sin entrega por
 * conversación: el token crudo se devuelve UNA vez para renderizar el QR y el
 * PIN se comunica verbalmente. Exige el grant verificado ya creado y nunca
 * toca las passkeys (la recuperación usa el endpoint dedicado de revocación).
 */
export async function issuePortalActivationQr(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: IssuePortalActivationQrInput,
): Promise<IssuedPortalActivationQr> {
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled) throw portalDisabled()
  const linkTtlMs = PORTAL_FIXED.linkTtlHours * 3600_000
  const idempotencyKey = input.idempotencyKey?.trim() || null
  if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
    throw validation("La clave de idempotencia debe tener 8–128 caracteres")
  }
  const patientRow = await requirePatient(tx, orgId, input.patientId)
  if (!patientRow.isActive) throw notFound("Paciente")
  const [contactRow] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.id, input.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!contactRow) throw notFound("Contacto")
  if (!contactRow.isActive) throw validation("El contacto está inactivo")
  await requirePatientLink(tx, orgId, input.patientId, input.contactId)
  const scope = await assertScope(tx, orgId, input.patientId, input.scope)
  if (scope.appointments && !policy.allowedScope.appointments) {
    throw validation("Las citas no están permitidas por la política del portal")
  }
  if (scope.budgets && !policy.allowedScope.budgets) {
    throw validation("Los presupuestos no están permitidos por la política del portal")
  }
  if (scope.account && !policy.allowedScope.account) {
    throw validation("La cuenta no está permitida por la política del portal")
  }
  if (scope.documents.length > 0 && !policy.allowedScope.documents) {
    throw validation("Los documentos no están permitidos por la política del portal")
  }
  if (idempotencyKey) {
    throw conflict("PORTAL_REPLAY", "La activación QR no admite reintentos con la misma clave")
  }
  await requireActivePortalGrant(tx, orgId, input.patientId, input.contactId)
  const token = rawToken()
  const pin = String(randomInt(0, 1_000_000)).padStart(6, "0")
  const now = new Date()
  let row: PortalLinkRow
  try {
    const [inserted] = await tx
      .insert(portalLink)
      .values({
        organizationId: orgId,
        patientId: input.patientId,
        contactId: input.contactId,
        scope,
        tokenHash: hashToken(token),
        pinHash: hashToken(pin),
        status: "pendiente",
        expiresAt: new Date(now.getTime() + linkTtlMs),
        idempotencyKey,
        createdBy: actorUserId,
      })
      .returning()
    if (!inserted) throw new Error("No se pudo emitir la activación")
    row = inserted
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict("PORTAL_REPLAY", "Ya existe una activación con esa clave; recarga la lista")
    }
    throw error
  }
  await auditPortal(tx, orgId, actorUserId, "portal.link_issued", "portal_link", row.id, {
    patientId: input.patientId,
    contactId: input.contactId,
    via: "qr",
    scope,
  })
  return { link: await linkView(tx, orgId, row), rawTokenOnce: token, pinOnce: pin }
}

export async function listPortalLinks(
  tx: Db,
  orgId: string,
  patientId?: string,
): Promise<PortalLinkView[]> {
  const rows = await tx
    .select()
    .from(portalLink)
    .where(
      and(
        eq(portalLink.organizationId, orgId),
        patientId ? eq(portalLink.patientId, patientId) : undefined,
      ),
    )
    .orderBy(desc(portalLink.createdAt))
    .limit(100)
  return Promise.all(rows.map((row) => linkView(tx, orgId, row)))
}

/** Revoca un enlace y las sesiones activas que nacieron de él. */
export async function revokePortalLink(
  tx: Db,
  orgId: string,
  actorUserId: string,
  linkId: string,
): Promise<PortalLinkView> {
  const [row] = await tx
    .select()
    .from(portalLink)
    .where(and(eq(portalLink.id, linkId), eq(portalLink.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!row) throw notFound("Enlace de acceso")
  const now = new Date()
  if (row.status === "pendiente") {
    const [updated] = await tx
      .update(portalLink)
      .set({ status: "revocado", revokedAt: now, revokedBy: actorUserId, updatedAt: now })
      .where(and(eq(portalLink.id, linkId), eq(portalLink.organizationId, orgId)))
      .returning()
    if (!updated) throw notFound("Enlace de acceso")
    await auditPortal(tx, orgId, actorUserId, "portal.link_revoked", "portal_link", linkId, {
      patientId: row.patientId,
      contactId: row.contactId,
    })
    return linkView(tx, orgId, updated)
  }
  await tx
    .update(portalSession)
    .set({ revokedAt: now, revokedBy: actorUserId, updatedAt: now })
    .where(
      and(
        eq(portalSession.linkId, linkId),
        eq(portalSession.organizationId, orgId),
        isNull(portalSession.revokedAt),
      ),
    )
  await auditPortal(tx, orgId, actorUserId, "portal.link_sessions_revoked", "portal_link", linkId, {
    patientId: row.patientId,
    contactId: row.contactId,
  })
  return linkView(tx, orgId, row)
}

/** Revoca una sesión (el paciente puede cerrar la suya; el staff cualquiera). */
export async function revokePortalSession(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  sessionId: string,
): Promise<{ revoked: boolean }> {
  const [row] = await tx
    .select({ id: portalSession.id, revokedAt: portalSession.revokedAt })
    .from(portalSession)
    .where(and(eq(portalSession.id, sessionId), eq(portalSession.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Sesión del portal")
  if (row.revokedAt) return { revoked: true }
  const now = new Date()
  await tx
    .update(portalSession)
    .set({ revokedAt: now, revokedBy: actorUserId, updatedAt: now })
    .where(and(eq(portalSession.id, sessionId), eq(portalSession.organizationId, orgId)))
  await auditPortal(tx, orgId, actorUserId, "portal.session_revoked", "portal_session", sessionId, {})
  return { revoked: true }
}

/** Resuelve el tenant desde el hash (para ownerDb, patrón de enlaces públicos). */
export async function resolvePortalOrgByLinkToken(db: Db, rawLinkToken: string): Promise<string | null> {
  if (typeof rawLinkToken !== "string" || !LINK_TOKEN_RE.test(rawLinkToken)) return null
  const [link] = await db
    .select({ organizationId: portalLink.organizationId })
    .from(portalLink)
    .where(eq(portalLink.tokenHash, hashToken(rawLinkToken)))
    .limit(1)
  return link?.organizationId ?? null
}

export async function resolvePortalOrgBySessionToken(db: Db, rawSessionToken: string): Promise<string | null> {
  if (typeof rawSessionToken !== "string" || !LINK_TOKEN_RE.test(rawSessionToken)) return null
  const [session] = await db
    .select({ organizationId: portalSession.organizationId })
    .from(portalSession)
    .where(eq(portalSession.tokenHash, hashToken(rawSessionToken)))
    .limit(1)
  return session?.organizationId ?? null
}

export interface PortalExchangeResult {
  sessionToken: string
  session: PortalSessionView
  patientName: string
  contactName: string
}

export interface ExchangePortalTokenInput {
  pin: string
}

const PIN_RE = /^\d{6}$/
const MAX_PIN_ATTEMPTS = 10

function pinMatches(expectedHash: string | null, pin: string): boolean {
  if (!expectedHash) return false
  const actual = hashToken(pin)
  const expected = Buffer.from(expectedHash, "hex")
  const candidate = Buffer.from(actual, "hex")
  return expected.length === candidate.length && timingSafeEqual(expected, candidate)
}

/**
 * Canjea un enlace de un solo uso por una sesión revocable. Exige el PIN que
 * el operador comunicó por vía independiente de la bandeja y un grant
 * persistente verificado por el staff (el canje jamás crea grants: los
 * enlaces anteriores al corte se invalidaron en migración).
 *
 * Antifuerza bruta: ante un PIN incorrecto NO se escribe en esta transacción
 * (el rollback del llamante borraría el conteo). Se lanza PORTAL_PIN_INVALID
 * y la API registra el intento con recordPortalPinFailure en un contexto
 * nuevo con SQL atómico.
 */
export async function exchangePortalToken(
  tx: Db,
  orgId: string,
  rawLinkToken: string,
  input: ExchangePortalTokenInput,
): Promise<PortalExchangeResult> {
  const policy = await getPortalPolicy(tx, orgId)
  // El código siempre activa el acceso, también para volver a entrar (ADR 0037).
  if (!policy.enabled) throw portalDisabled()
  const token = assertTokenFormat(rawLinkToken)
  if (typeof input?.pin !== "string" || !PIN_RE.test(input.pin)) {
    throw validation("El código de 6 dígitos es inválido")
  }
  const hash = hashToken(token)
  const [link] = await tx
    .select()
    .from(portalLink)
    .where(and(eq(portalLink.tokenHash, hash), eq(portalLink.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!link) throw notFound("Enlace de acceso")
  const now = new Date()
  if (link.status === "revocado" || link.revokedAt || link.failedAttempts >= MAX_PIN_ATTEMPTS) {
    throw conflict("PORTAL_REVOKED", "Este acceso fue revocado; pide uno nuevo en recepción")
  }
  if (link.status === "usado" || link.usedAt) {
    throw conflict("PORTAL_USED", "Este enlace ya fue usado")
  }
  if (link.expiresAt.getTime() <= now.getTime()) {
    throw conflict("PORTAL_EXPIRED", "Este enlace venció; pide uno nuevo en recepción")
  }
  await requireActiveGrant(tx, orgId, link.patientId, link.contactId)
  const grant = await requireActivePortalGrant(tx, orgId, link.patientId, link.contactId)
  if (!pinMatches(link.pinHash, input.pin)) {
    throw new ServiceError("PORTAL_PIN_INVALID", 400, "El código es incorrecto")
  }
  const [consumed] = await tx
    .update(portalLink)
    .set({ status: "usado", usedAt: now, updatedAt: now })
    .where(
      and(
        eq(portalLink.tokenHash, hash),
        eq(portalLink.organizationId, orgId),
        eq(portalLink.status, "pendiente"),
        isNull(portalLink.usedAt),
        isNull(portalLink.revokedAt),
        gt(portalLink.expiresAt, now),
        lt(portalLink.failedAttempts, MAX_PIN_ATTEMPTS),
      ),
    )
    .returning()
  if (!consumed) {
    const [current] = await tx
      .select({ status: portalLink.status, revokedAt: portalLink.revokedAt })
      .from(portalLink)
      .where(and(eq(portalLink.tokenHash, hash), eq(portalLink.organizationId, orgId)))
      .limit(1)
    if (current && (current.status === "revocado" || current.revokedAt)) {
      throw conflict("PORTAL_REVOKED", "Este acceso fue revocado; pide uno nuevo en recepción")
    }
    throw conflict("PORTAL_USED", "Este enlace ya fue usado")
  }

  const sessionTtl = PORTAL_FIXED.sessionTtlHours
  const sessionToken = rawToken()
  const [session] = await tx
    .insert(portalSession)
    .values({
      organizationId: orgId,
      patientId: link.patientId,
      contactId: link.contactId,
      linkId: link.id,
      grantId: grant.id,
      authMethod: "enlace_pin",
      scope: link.scope,
      tokenHash: hashToken(sessionToken),
      expiresAt: new Date(now.getTime() + sessionTtl * 3600_000),
      issuedBy: link.createdBy,
      lastSeenAt: now,
    })
    .returning()
  if (!session) throw new Error("No se pudo abrir la sesión del portal")
  await logAccess(tx, orgId, session.id, "session.opened")
  const view = await linkView(tx, orgId, { ...link, status: "usado", usedAt: now })
  return {
    sessionToken,
    session: toSessionView(session),
    patientName: view.patientName,
    contactName: view.contactName,
  }
}

export interface PortalContext {
  orgId: string
  session: PortalSessionRow
  patientName: string
}

/**
 * Valida el token de sesión en cada lectura: portal habilitado, revocación,
 * expiración, fichas activas, vínculo + grant vigente, sesión atada al grant
 * vigente (nunca a uno anterior reemitido), passkey no revocada y alcance
 * efectivo como intersección (solo reduce: grant y política solo recortan,
 * jamás amplían el alcance congelado de la sesión).
 */
export async function requirePortalSession(tx: Db, orgId: string, rawSessionToken: string): Promise<PortalContext> {
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled) throw portalDisabled()
  const token = assertTokenFormat(rawSessionToken)
  const [session] = await tx
    .select()
    .from(portalSession)
    .where(and(eq(portalSession.tokenHash, hashToken(token)), eq(portalSession.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!session) throw notFound("Sesión del portal")
  if (session.revokedAt) throw conflict("PORTAL_REVOKED", "Esta sesión fue revocada")
  if (session.expiresAt.getTime() <= Date.now()) {
    throw conflict("PORTAL_EXPIRED", "Esta sesión venció; pide un nuevo acceso en recepción")
  }
  const patientRow = await requirePatient(tx, orgId, session.patientId)
  if (!patientRow.isActive) throw notFound("Sesión del portal")
  const [contactRow] = await tx
    .select({ isActive: contact.isActive })
    .from(contact)
    .where(and(eq(contact.id, session.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!contactRow?.isActive) throw notFound("Sesión del portal")
  await requireActiveGrant(tx, orgId, session.patientId, session.contactId)
  const grant = await requireActivePortalGrant(tx, orgId, session.patientId, session.contactId)
  if (!session.grantId || session.grantId !== grant.id) {
    throw conflict("PORTAL_REVOKED", "Este acceso fue revocado; pide uno nuevo en recepción")
  }
  if (session.passkeyId) {
    const [cred] = await tx
      .select({ revokedAt: portalPasskey.revokedAt, grantId: portalPasskey.grantId })
      .from(portalPasskey)
      .where(and(eq(portalPasskey.id, session.passkeyId), eq(portalPasskey.organizationId, orgId)))
      .limit(1)
    if (!cred || cred.revokedAt || cred.grantId !== grant.id) {
      throw conflict("PORTAL_REVOKED", "Esta sesión fue revocada")
    }
  }
  const stored = session.scope ?? { appointments: false, budgets: false, account: false, documents: [] }
  const granted = grant.scope ?? { appointments: false, budgets: false, account: false, documents: [] }
  const storedDocs = Array.isArray(stored.documents) ? stored.documents : []
  const grantedDocs = Array.isArray(granted.documents) ? granted.documents : []
  const effective: PortalScope = {
    appointments: stored.appointments === true && granted.appointments === true && policy.allowedScope.appointments,
    budgets: stored.budgets === true && granted.budgets === true && policy.allowedScope.budgets,
    account: stored.account === true && granted.account === true && policy.allowedScope.account,
    documents: policy.allowedScope.documents ? storedDocs.filter((id) => grantedDocs.includes(id)) : [],
  }
  let effectiveRow = session
  if (JSON.stringify(effective) !== JSON.stringify(session.scope)) {
    const [refreshed] = await tx
      .update(portalSession)
      .set({ scope: effective, lastSeenAt: new Date(), updatedAt: new Date() })
      .where(and(eq(portalSession.id, session.id), eq(portalSession.organizationId, orgId)))
      .returning()
    if (refreshed) effectiveRow = refreshed
    await auditPortal(tx, orgId, session.issuedBy, "portal.session_scope_refreshed", "portal_session", session.id, {
      grantId: grant.id,
    })
  } else {
    await tx
      .update(portalSession)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(portalSession.id, session.id), eq(portalSession.organizationId, orgId)))
  }
  return { orgId, session: effectiveRow, patientName: patientRow.displayName }
}

export function requireScope(session: PortalSessionRow, key: "appointments" | "budgets" | "account"): void {
  if (session.scope?.[key] !== true) {
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "Esta sección no está autorizada en tu acceso")
  }
}

function requireDocumentInScope(session: PortalSessionRow, documentId: string): void {
  const allowed = Array.isArray(session.scope?.documents) && session.scope.documents.includes(documentId)
  if (!allowed) throw new ServiceError("PORTAL_FORBIDDEN", 404, "Este documento no está autorizado en tu acceso")
}

/**
 * Quien actúa en el portal es la persona de la sesión, no quien le emitió el
 * enlace: «Actividad del equipo» lo dice como del paciente o su contacto.
 */
function portalActor(session: PortalSessionRow): string {
  return `contact:${session.contactId}`
}

export interface PortalAppointmentView {
  id: string
  startsAt: string
  endsAt: string
  serviceName: string | null
  status: string
  branchId: string
  branchName: string
  /** La dirección de la sede en una línea y «Cómo llegar», como en «Su enlace». */
  branchAddress: string | null
  branchDirectionsUrl: string | null
  /** Quién la atiende: el bloque de la cita es el mismo de «Su enlace». */
  professionalName: string
  /** Zona de la sede (o de la clínica): la hora de la cita se dice en ella, no en la del teléfono. */
  timeZone: string
  version: number
}

/**
 * Lo que la página del portal necesita de su sesión: quién es y el formato y la
 * zona de la clínica, para decir cada fecha como en la clínica y no como en el
 * teléfono de la persona.
 */
export async function getPortalSessionInfo(tx: Db, ctx: PortalContext) {
  const zone = await findOrgLocale(tx, ctx.orgId)
  const [saved] = ctx.session.grantId
    ? await tx
        .select({ id: portalPasskey.id })
        .from(portalPasskey)
        .where(
          and(
            eq(portalPasskey.organizationId, ctx.orgId),
            eq(portalPasskey.grantId, ctx.session.grantId),
            isNull(portalPasskey.revokedAt),
          ),
        )
        .limit(1)
    : []
  return {
    session: {
      id: ctx.session.id,
      patientId: ctx.session.patientId,
      contactId: ctx.session.contactId,
      scope: ctx.session.scope,
      expiresAt: ctx.session.expiresAt,
      grantId: ctx.session.grantId,
      authMethod: ctx.session.authMethod,
    },
    patientName: ctx.patientName,
    /** Ya guardó su acceso en algún teléfono: no se le vuelve a proponer como paso principal. */
    accessSaved: !!saved,
    /** Esta sesión ya se recuerda 30 días en este teléfono. */
    remembered: isRemembered(ctx.session),
    locale: zone.locale,
    timeZone: zone.timezone,
  }
}

/** La sesión ya se alargó a los 30 días de «recordar en este teléfono». */
function isRemembered(session: PortalSessionRow): boolean {
  return session.expiresAt.getTime() - session.createdAt.getTime() > PORTAL_FIXED.sessionTtlHours * 3600_000 + 60_000
}

/**
 * «Si tu teléfono no puede guardarlo, lo recordamos 30 días» (decisión 9): la
 * sesión que se abrió con el enlace y el código se alarga a 30 días desde que
 * se abrió, una sola vez. Lo pide la página cuando el teléfono no puede
 * guardar la llave; una sesión que ya entró con su llave no lo necesita.
 */
export async function rememberPortalSession(tx: Db, ctx: PortalContext): Promise<{ expiresAt: Date }> {
  if (ctx.session.authMethod !== "enlace_pin") {
    throw conflict("PORTAL_REMEMBER", "Este acceso ya entra con tu huella o tu cara")
  }
  if (isRemembered(ctx.session)) return { expiresAt: ctx.session.expiresAt }
  const expiresAt = new Date(ctx.session.createdAt.getTime() + PORTAL_FIXED.rememberDays * 86_400_000)
  await tx
    .update(portalSession)
    .set({ expiresAt, updatedAt: new Date() })
    .where(and(eq(portalSession.id, ctx.session.id), eq(portalSession.organizationId, ctx.orgId)))
  await logAccess(tx, ctx.orgId, ctx.session.id, "session.remembered")
  return { expiresAt }
}

/** Nombre y zona de la sede de una cita: sin zona propia, la de la clínica. */
async function branchPlace(tx: Db, orgId: string, branchId: string): Promise<{ name: string; timeZone: string } | null> {
  const [row] = await tx
    .select({ name: branch.name, timezone: branch.timezone })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.organizationId, orgId)))
    .limit(1)
  if (!row) return null
  return { name: row.name, timeZone: row.timezone ?? (await findOrgLocale(tx, orgId)).timezone }
}

/** Próximas citas del paciente autorizado (sin datos del profesional). */
export async function getPortalAppointments(
  tx: Db,
  ctx: PortalContext,
): Promise<PortalAppointmentView[]> {
  requireScope(ctx.session, "appointments")
  const since = new Date(Date.now() - 24 * 3600_000)
  const rows = await tx
    .select({
      id: appointment.id,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      serviceName: appointment.serviceName,
      status: appointment.status,
      version: appointment.version,
      branchId: appointment.branchId,
      branchName: branch.name,
      branchAddress: branchAddressColumns,
      branchPlaceId: branch.googlePlaceId,
      branchTimeZone: branch.timezone,
      professionalName: user.name,
    })
    .from(appointment)
    .innerJoin(branch, eq(branch.id, appointment.branchId))
    .innerJoin(user, eq(user.id, appointment.professionalUserId))
    .where(
      and(
        eq(appointment.organizationId, ctx.orgId),
        eq(appointment.patientId, ctx.session.patientId),
        gte(appointment.startsAt, since),
      ),
    )
    .orderBy(asc(appointment.startsAt))
    .limit(50)
  await logAccess(tx, ctx.orgId, ctx.session.id, "appointments.listed")
  const clinicZone = (await findOrgLocale(tx, ctx.orgId)).timezone
  const addressText = await branchAddressWriter(tx, ctx.orgId)
  const directions = await branchDirectionsWriter(tx, ctx.orgId)
  return rows.map(({ branchTimeZone, branchAddress, branchPlaceId, ...row }) => ({
    ...row,
    branchAddress: addressText(branchAddress),
    branchDirectionsUrl: directions({ address: branchAddress, placeId: branchPlaceId }),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    timeZone: branchTimeZone ?? clinicZone,
  }))
}

/**
 * «Añadir al calendario» del portal (issue 46): el `.ics` de una cita del
 * paciente, el mismo evento que el de «Su enlace» y el del correo.
 */
export async function getPortalAppointmentCalendar(tx: Db, ctx: PortalContext, appointmentId: string): Promise<string> {
  requireScope(ctx.session, "appointments")
  const [row] = await tx
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, ctx.orgId),
        eq(appointment.id, appointmentId),
        eq(appointment.patientId, ctx.session.patientId),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Cita")
  await logAccess(tx, ctx.orgId, ctx.session.id, "appointments.calendar", "appointment", row.id)
  return appointmentCalendarDownload(tx, ctx.orgId, row.id)
}

/** Una cita del paciente como la ve el portal. */
async function portalAppointmentView(tx: Db, orgId: string, appointmentId: string): Promise<PortalAppointmentView> {
  const [row] = await tx
    .select({
      id: appointment.id,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      serviceName: appointment.serviceName,
      status: appointment.status,
      version: appointment.version,
      branchId: appointment.branchId,
      branchName: branch.name,
      branchAddress: branchAddressColumns,
      branchPlaceId: branch.googlePlaceId,
      branchTimeZone: branch.timezone,
      professionalName: user.name,
    })
    .from(appointment)
    .innerJoin(branch, eq(branch.id, appointment.branchId))
    .innerJoin(user, eq(user.id, appointment.professionalUserId))
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, appointmentId)))
    .limit(1)
  if (!row) throw notFound("Cita")
  const { branchTimeZone, branchAddress, branchPlaceId, ...rest } = row
  return {
    ...rest,
    branchAddress: (await branchAddressWriter(tx, orgId))(branchAddress),
    branchDirectionsUrl: (await branchDirectionsWriter(tx, orgId))({ address: branchAddress, placeId: branchPlaceId }),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    timeZone: branchTimeZone ?? (await findOrgLocale(tx, orgId)).timezone,
  }
}

async function requireOwnAppointment(tx: Db, ctx: PortalContext, appointmentId: string) {
  const [row] = await tx
    .select()
    .from(appointment)
    .where(
      and(
        eq(appointment.id, appointmentId),
        eq(appointment.organizationId, ctx.orgId),
        eq(appointment.patientId, ctx.session.patientId),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Cita")
  return row
}

export async function confirmPortalAppointment(
  tx: Db,
  ctx: PortalContext,
  appointmentId: string,
): Promise<PortalAppointmentView> {
  requireScope(ctx.session, "appointments")
  const current = await requireOwnAppointment(tx, ctx, appointmentId)
  // La misma regla que el enlace y el agente: si ya estaba confirmada, queda como está.
  const { item: updated, already } = await confirmOwnAppointment(tx, ctx.orgId, portalActor(ctx.session), current, "portal")
  if (already) return portalAppointmentView(tx, ctx.orgId, updated.id)
  await auditPortal(tx, ctx.orgId, portalActor(ctx.session), "portal.appointment_confirmed", "appointment", current.id, {
    sessionId: ctx.session.id,
    contactId: ctx.session.contactId,
  })
  await logAccess(tx, ctx.orgId, ctx.session.id, "appointment.confirmed", "appointment", current.id)
  await notifyIssuer(tx, ctx.orgId, ctx.session, {
    dedupeKey: `portal-cita-confirmada-${current.id}`,
    title: "Cita confirmada desde el portal",
    body: "Un paciente confirmó su cita desde el portal.",
    href: "/agenda",
  })
  return portalAppointmentView(tx, ctx.orgId, updated.id)
}

export interface ReschedulePortalAppointmentInput {
  expectedVersion: number
  startsAt: string
  /** El horario elegido en la semana: con quién y en qué unidad dental está libre. */
  professionalUserId: string
  roomId?: string
}

/**
 * Cambia la cita a otro horario de la semana, como en «Su enlace»: misma sede
 * y duración, con quien lo tenga libre (reglas de Agenda: exclusión
 * anti-solapamiento y bloqueo optimista). Sin disponibilidad ficticia: si el
 * horario se ocupó, la cita no se mueve (APPOINTMENT_CONFLICT).
 */
export async function reschedulePortalAppointment(
  tx: Db,
  ctx: PortalContext,
  appointmentId: string,
  input: ReschedulePortalAppointmentInput,
): Promise<PortalAppointmentView> {
  requireScope(ctx.session, "appointments")
  const current = await requireOwnAppointment(tx, ctx, appointmentId)
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validation("La versión de la cita es inválida; recarga e intenta de nuevo")
  }
  // La misma regla que el enlace y el agente: en pie, hora futura y dentro del horizonte.
  const moved = await moveOwnAppointment(tx, ctx.orgId, portalActor(ctx.session), current, input)
  const startsAt = new Date(moved.startsAt)
  await auditPortal(tx, ctx.orgId, portalActor(ctx.session), "portal.appointment_rescheduled", "appointment", current.id, {
    sessionId: ctx.session.id,
    contactId: ctx.session.contactId,
    startsAt: startsAt.toISOString(),
  })
  await logAccess(tx, ctx.orgId, ctx.session.id, "appointment.rescheduled", "appointment", current.id)
  await notifyIssuer(tx, ctx.orgId, ctx.session, {
    dedupeKey: `portal-cita-reprogramada-${current.id}-${startsAt.toISOString()}`,
    title: "Cita reprogramada desde el portal",
    body: "Un paciente reprogramó su cita desde el portal.",
    href: "/agenda",
  })
  return portalAppointmentView(tx, ctx.orgId, moved.id)
}

/** Cancela su cita desde el portal: el mismo cambio de estado de la Agenda, con el motivo «paciente». */
export async function cancelPortalAppointment(
  tx: Db,
  ctx: PortalContext,
  appointmentId: string,
): Promise<PortalAppointmentView> {
  requireScope(ctx.session, "appointments")
  const current = await requireOwnAppointment(tx, ctx, appointmentId)
  await cancelOwnAppointment(tx, ctx.orgId, portalActor(ctx.session), current, "La canceló la persona desde el portal")
  await auditPortal(tx, ctx.orgId, portalActor(ctx.session), "portal.appointment_cancelled", "appointment", current.id, {
    sessionId: ctx.session.id,
    contactId: ctx.session.contactId,
  })
  await logAccess(tx, ctx.orgId, ctx.session.id, "appointment.cancelled", "appointment", current.id)
  await notifyIssuer(tx, ctx.orgId, ctx.session, {
    dedupeKey: `portal-cita-cancelada-${current.id}`,
    title: "Cita cancelada desde el portal",
    body: "Un paciente canceló su cita desde el portal.",
    href: "/agenda",
  })
  return portalAppointmentView(tx, ctx.orgId, current.id)
}

export interface PortalRescheduleSlotsInput {
  from: string
  to: string
}

/**
 * La semana de horarios para cambiar su cita, la misma de «Su enlace»: su
 * sede y su duración, con quien lo tenga libre. Delega en Agenda
 * (listAvailableSlots): el portal nunca calcula disponibilidad.
 */
export async function getPortalRescheduleSlots(
  tx: Db,
  ctx: PortalContext,
  appointmentId: string,
  input: PortalRescheduleSlotsInput,
): Promise<{ slots: BookingLinkSlot[]; timeZone: string; truncated: boolean }> {
  requireScope(ctx.session, "appointments")
  const current = await requireOwnAppointment(tx, ctx, appointmentId)
  assertOwnAppointmentChangeable(current)
  if (typeof input.from !== "string" || typeof input.to !== "string") {
    throw validation("Rango de fechas inválido")
  }
  const slots = await listWeekSlots(tx, ctx.orgId, {
    branchId: current.branchId,
    from: input.from,
    to: input.to,
    durationMin: current.durationMin,
  })
  await logAccess(tx, ctx.orgId, ctx.session.id, "appointment.slots_viewed", "appointment", current.id)
  return slots
}

export interface PortalBudgetLineView {
  /** Cómo se hace, qué incluye y qué sigue, congelado al entregar. */
  patientGuide: PatientGuide | null
  planItemId: string
  /** La opción de la línea (con una sola opción, la única). */
  optionId: string
  title: string
  scope: string | null
  toothNumber: number | null
  /** Precio acordado: el total o, si se cobra por sesión, el de cada visita. */
  priceCents: number | null
  tariffCents: number | null
  /** 'treatment' se cobra una vez; 'session', en cada visita atendida. */
  billingMode: string
  /** Visitas previstas de lo que se cobra por sesión. */
  sessionsPlanned: number | null
  /** Total de la línea: el precio o, por sesión, precio por visita × visitas previstas. */
  lineTotalCents: number | null
  /** El mismo total a la tarifa de referencia. */
  tariffLineTotalCents: number | null
  promotionName: string | null
  currency: string
  decision: string
  itemStatus: string
}

export interface PortalBudgetView {
  id: string
  planId: string
  budgetNumber: number
  revisionNumber: number
  title: string
  notes: string | null
  status: string
  currency: string
  /**
   * Formato regional de la clínica (`org_profile.locale`): el portal presenta
   * los importes igual que la ficha. `null` si la clínica aún no lo configuró.
   */
  locale: string | null
  totalCents: number | null
  acceptedCents: number | null
  /** Suma a la tarifa de referencia y rebaja acordada (null si falta algún precio). */
  tariffTotalCents: number | null
  discountCents: number | null
  presentedAt: Date | null
  decidedAt: Date | null
  acceptedByName: string | null
  decisionNote: string | null
  /** El estado con su nombre de siempre («Enviado · espera respuesta», «Aceptó 2 de 3»). */
  stateText: string
  /** AAAA-MM-DD; imprimir o mostrarlo vencido no impide aceptar. */
  validUntil: string | null
  /** «Lo que encontramos»: solo para la propia persona o su representante. */
  findings: string | null
  proposal: string | null
  /** Las condiciones de la clínica; vacías, esa sección no sale. */
  terms: { payment: string | null; change: string | null }
  /** Con más de una, la persona elige una (decisión 13); cada una con su total. */
  options: Array<{
    id: string
    label: string
    name: string | null
    pros: string | null
    cons: string | null
    isRecommended: boolean
    decision: string
    totalCents: number | null
  }>
  items: PortalBudgetLineView[]
}

/** Formato regional de la clínica para el portal; sin perfil no se inventa uno. */
export async function portalBudgetLocale(tx: Db, orgId: string): Promise<string | null> {
  try {
    return (await getOrgLocale(tx, orgId)).locale
  } catch (error) {
    if (error instanceof ServiceError && error.status === 404) return null
    throw error
  }
}

/** Lo que la vista de la persona suma al presupuesto. */
export interface PortalBudgetContext {
  locale: string | null
  terms: PortalBudgetView["terms"]
  findings: ReadonlyMap<string, string | null>
}

/**
 * Formato, condiciones y lo encontrado de estos presupuestos. `findings` es dato clínico
 * y no viaja en el detalle: se lee aquí, solo para quien decide por el paciente.
 */
export async function portalBudgetContext(
  tx: Db,
  orgId: string,
  budgetIds: string[],
  clinicalAllowed: boolean,
): Promise<PortalBudgetContext> {
  const [profile] = await tx
    .select({ payment: orgProfile.budgetPaymentTerms, change: orgProfile.budgetChangeTerms })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  const rows =
    clinicalAllowed && budgetIds.length > 0
      ? await tx
          .select({ id: treatmentBudget.id, findings: treatmentBudget.findings })
          .from(treatmentBudget)
          .where(and(eq(treatmentBudget.organizationId, orgId), inArray(treatmentBudget.id, budgetIds)))
      : []
  return {
    locale: await portalBudgetLocale(tx, orgId),
    terms: { payment: profile?.payment?.trim() || null, change: profile?.change?.trim() || null },
    findings: new Map(rows.map((row) => [row.id, row.findings])),
  }
}

export function toPortalBudget(budget: BudgetWithTotals, context: PortalBudgetContext): PortalBudgetView {
  const { locale } = context
  return {
    id: budget.id,
    planId: budget.planId,
    budgetNumber: budget.budgetNumber,
    revisionNumber: budget.revisionNumber,
    title: budget.title,
    notes: budget.notes,
    status: budget.status,
    currency: budget.currency,
    locale,
    totalCents: budget.totalCents,
    acceptedCents: budget.acceptedCents,
    tariffTotalCents: budget.tariffTotalCents,
    discountCents: budget.discountCents,
    presentedAt: budget.presentedAt,
    decidedAt: budget.decidedAt,
    acceptedByName: budget.acceptedByName,
    decisionNote: budget.decisionNote,
    stateText: budget.stateText,
    validUntil: budget.validUntil,
    findings: context.findings.get(budget.id) ?? null,
    proposal: budget.proposal,
    terms: context.terms,
    options: budget.options.map((option) => ({
      id: option.id,
      label: option.label,
      name: option.name,
      pros: option.pros,
      cons: option.cons,
      isRecommended: option.isRecommended,
      decision: option.decision,
      totalCents: option.totalCents,
    })),
    items: budget.items.map((line) => ({
      planItemId: line.planItemId,
      optionId: line.optionId,
      title: line.title,
      scope: line.scope,
      // La pieza que dice el producto (odentIA); sin ella, nada.
      toothNumber: typeof line.toothNumber === "number" ? line.toothNumber : null,
      priceCents: line.priceCents,
      tariffCents: line.tariffPriceCents ?? line.priceCents,
      billingMode: line.billingMode,
      sessionsPlanned: line.sessionsPlanned,
      lineTotalCents: line.lineTotalCents,
      tariffLineTotalCents: line.tariffLineTotalCents,
      promotionName: line.promotionName,
      currency: line.currency,
      decision: line.decision,
      itemStatus: line.itemStatus,
      // Lo congelado al entregar: lo que se le explicó a esta persona.
      patientGuide: parsePatientGuide(line.patientGuide),
    })),
  }
}

/** Presupuestos visibles del paciente: nunca borradores ni internos. */
export async function listPortalBudgets(tx: Db, ctx: PortalContext): Promise<PortalBudgetView[]> {
  requireScope(ctx.session, "budgets")
  const budgets = (await listBudgets(tx, ctx.orgId, ctx.session.patientId)).filter((budget) => budget.status !== "borrador")
  // Lo encontrado va a quien decide por el paciente, no a cualquiera con acceso al portal.
  const decides = await contactDecides(tx, ctx.orgId, ctx.session.patientId, ctx.session.contactId)
  const context = await portalBudgetContext(tx, ctx.orgId, budgets.map((budget) => budget.id), decides)
  await logAccess(tx, ctx.orgId, ctx.session.id, "budgets.listed")
  return budgets.map((budget) => toPortalBudget(budget, context))
}

export interface DecidePortalBudgetInput {
  /** La opción elegida; obligatoria si el presupuesto tiene más de una. */
  optionId?: string | null
  decisions: Array<{ planItemId: string; decision: "aceptado" | "rechazado" | "pospuesto" }>
  decisionNote?: string | null
}

/**
 * Decisión del representante verificado sobre un presupuesto presentado.
 * Idempotente: si el mismo contacto ya decidió este presupuesto, se devuelve
 * el resultado sin reescribir (replay de red seguro).
 */
/**
 * La persona (o su representante) responde su presupuesto: la misma regla para
 * el portal y para «Su enlace». Decide ella, no el equipo: el presupuesto no
 * queda a nombre de nadie de la clínica. Responder después admite completar lo
 * pospuesto con la misma autoridad; repetir lo ya decidido devuelve lo que hay.
 */
export async function decideBudgetByPerson(
  tx: Db,
  orgId: string,
  input: { patientId: string; contactId: string; budgetId: string; decision: DecidePortalBudgetInput; via: "portal" | "enlace" },
): Promise<{ budget: BudgetWithTotals; replay: boolean }> {
  const current = await getBudgetDetail(tx, orgId, input.patientId, input.budgetId)
  const followUp =
    (current.status === "parcial" || current.status === "pospuesto") && current.decisionContactId === input.contactId
  if (current.status !== "presentado" && !followUp) {
    const decided = ["aceptado", "parcial", "rechazado", "pospuesto"].includes(current.status)
    if (decided && current.decisionContactId === input.contactId) return { budget: current, replay: true }
    throw conflict("BUDGET_STATUS", "Este presupuesto ya no admite decisión")
  }
  if (!Array.isArray(input.decision.decisions) || input.decision.decisions.length === 0) {
    throw validation("Debe decidir cada línea exactamente una vez")
  }
  try {
    const budget = await decideBudget(tx, orgId, null, input.patientId, input.budgetId, {
      optionId: input.decision.optionId ?? null,
      decisions: input.decision.decisions,
      decidedByContactId: input.contactId,
      decisionNote: input.decision.decisionNote ?? null,
    }, { skipOwnPlan: true, via: input.via })
    return { budget, replay: false }
  } catch (error) {
    if (error instanceof ServiceError && error.code === "BUDGET_STATUS") {
      const again = await getBudgetDetail(tx, orgId, input.patientId, input.budgetId)
      if (again.decisionContactId === input.contactId) return { budget: again, replay: true }
    }
    throw error
  }
}

export async function decidePortalBudget(
  tx: Db,
  ctx: PortalContext,
  budgetId: string,
  input: DecidePortalBudgetInput,
): Promise<{ budget: PortalBudgetView; replay: boolean }> {
  requireScope(ctx.session, "budgets")
  // Quien responde decide por el paciente: lo valida la misma regla al decidir.
  const context = await portalBudgetContext(tx, ctx.orgId, [budgetId], true)
  const result = await decideBudgetByPerson(tx, ctx.orgId, {
    patientId: ctx.session.patientId,
    contactId: ctx.session.contactId,
    budgetId,
    decision: input,
    via: "portal",
  })
  if (result.replay) {
    await logAccess(tx, ctx.orgId, ctx.session.id, "budget.decision_replayed", "treatment_budget", budgetId)
    return { budget: toPortalBudget(result.budget, context), replay: true }
  }
  const decided = result.budget
  await auditPortal(tx, ctx.orgId, portalActor(ctx.session), "portal.budget_decided", "treatment_budget", budgetId, {
    sessionId: ctx.session.id,
    contactId: ctx.session.contactId,
    status: decided.status,
  })
  await logAccess(tx, ctx.orgId, ctx.session.id, "budget.decided", "treatment_budget", budgetId, {
    status: decided.status,
  })
  await notifyIssuer(tx, ctx.orgId, ctx.session, {
    dedupeKey: `portal-presupuesto-decidido-${budgetId}`,
    title: "Presupuesto decidido desde el portal",
    body: "Un representante decidió un presupuesto desde el portal.",
    href: `/patients/${ctx.session.patientId}?tab=plan`,
  })
  return { budget: toPortalBudget(decided, context), replay: false }
}

/**
 * La persona abrió un presupuesto en el portal: «Lo vio en el portal el …» en
 * su presupuesto, para quien lleva la venta (decisión 9). Solo se anota la
 * lectura de lo que su acceso permite ver.
 */
export async function markPortalBudgetSeen(tx: Db, ctx: PortalContext, budgetId: string): Promise<void> {
  requireScope(ctx.session, "budgets")
  const current = await getBudgetDetail(tx, ctx.orgId, ctx.session.patientId, budgetId)
  if (current.status === "borrador") throw notFound("Presupuesto")
  await logAccess(tx, ctx.orgId, ctx.session.id, "budget.viewed", "treatment_budget", budgetId)
}

/**
 * «Lo vio en el portal el …» (decisión 9): la última vez que la persona abrió
 * cada presupuesto en el portal, leída del registro de accesos, para quien
 * lleva la venta. Sin lectura no hay fila.
 */
export async function budgetsSeenInPortal(tx: Db, orgId: string, budgetIds: readonly string[]): Promise<Map<string, Date>> {
  if (budgetIds.length === 0) return new Map()
  const rows = await tx
    .select({ budgetId: portalAccessLog.entityId, at: max(portalAccessLog.createdAt) })
    .from(portalAccessLog)
    .where(
      and(
        eq(portalAccessLog.organizationId, orgId),
        eq(portalAccessLog.action, "budget.viewed"),
        eq(portalAccessLog.entityType, "treatment_budget"),
        inArray(portalAccessLog.entityId, [...budgetIds]),
      ),
    )
    .groupBy(portalAccessLog.entityId)
  return new Map(rows.filter((row) => row.budgetId && row.at).map((row) => [row.budgetId as string, row.at as Date]))
}

export interface PortalDocumentView {
  id: string
  category: string
  label: string
  contentType: string
  sizeBytes: number
  createdAt: Date
}

/** Solo documentos explícitamente autorizados en el alcance (sin storageKey). */
export async function listPortalDocuments(tx: Db, ctx: PortalContext): Promise<PortalDocumentView[]> {
  const authorized = ctx.session.scope?.documents ?? []
  if (authorized.length === 0) return []
  const docs = await listPatientDocuments(tx, ctx.orgId, ctx.session.patientId)
  await logAccess(tx, ctx.orgId, ctx.session.id, "documents.listed")
  return docs
    .filter((doc) => authorized.includes(doc.id))
    .map((doc) => ({
      id: doc.id,
      category: doc.category,
      label: doc.label,
      contentType: doc.contentType,
      sizeBytes: doc.sizeBytes,
      createdAt: doc.createdAt,
    }))
}

/**
 * URL firmada de lectura (5 min) con control en cada acceso: verifica alcance
 * + pertenencia y registra la lectura antes de firmar.
 */
export async function getPortalDocumentUrl(
  tx: Db,
  ctx: PortalContext,
  documentId: string,
  storage: Pick<Storage, "attachmentUrl">,
): Promise<{ url: string; expiresInSeconds: number }> {
  requireDocumentInScope(ctx.session, documentId)
  const doc = await getPatientDocument(tx, ctx.orgId, ctx.session.patientId, documentId)
  await auditPortal(tx, ctx.orgId, portalActor(ctx.session), "portal.document_read", "patient_document", documentId, {
    sessionId: ctx.session.id,
    contactId: ctx.session.contactId,
  })
  await logAccess(tx, ctx.orgId, ctx.session.id, "document.read", "patient_document", documentId)
  const expiresInSeconds = 300
  const url = await storage.attachmentUrl(doc.storageKey, expiresInSeconds)
  return { url, expiresInSeconds }
}

export interface PortalAccountView {
  /** Formato regional de la clínica; `null` si aún no lo configuró. */
  locale: string | null
  /** Los mismos montos que Caja (`accountBalances`), más lo aceptado de sus presupuestos. */
  byCurrency: Array<{
    currency: string
    /** Lo aceptado: todas las visitas de lo que se cobra por sesión. */
    agreedCents: number
    /** Debe. */
    porCobrar: number
    /** Pagado neto: lo cobrado menos lo devuelto. */
    pagado: number
    /** A favor. */
    aFavor: number
    /** Saldo: lo que debe menos lo que tiene a favor. */
    saldo: number
  }>
  charges: Array<{
    id: string
    description: string
    amountCents: number
    currency: string
    dueAt: Date | null
    voidedAt: Date | null
    createdAt: Date
  }>
  payments: Array<{
    id: string
    amountCents: number
    currency: string
    method: string
    reference: string | null
    paidAt: Date
    voidedAt: Date | null
  }>
}

/**
 * Cuenta real del paciente (historial + saldo). Solo lectura: la pasarela no
 * está elegida y el portal jamás crea cargos ni pagos.
 */
export async function getPortalAccount(tx: Db, ctx: PortalContext): Promise<PortalAccountView> {
  requireScope(ctx.session, "account")
  const account = await getPatientAccount(tx, ctx.orgId, ctx.session.patientId)
  await logAccess(tx, ctx.orgId, ctx.session.id, "account.viewed")
  return {
    locale: await portalBudgetLocale(tx, ctx.orgId),
    byCurrency: account.byCurrency,
    charges: account.charges.map((charge) => ({
      id: charge.id,
      description: charge.description,
      amountCents: charge.amountCents,
      currency: charge.currency,
      dueAt: charge.dueAt,
      voidedAt: charge.voidedAt,
      createdAt: charge.createdAt,
    })),
    payments: account.payments
      .filter((payment) => !payment.voidedAt)
      .map((payment) => ({
        id: payment.id,
        amountCents: payment.amountCents,
        currency: payment.currency,
        method: payment.methodName,
        reference: payment.reference,
        paidAt: payment.paidAt,
        voidedAt: payment.voidedAt,
      })),
  }
}
