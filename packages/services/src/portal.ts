import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import {
  patient,
  patientContact,
  patientDocument,
} from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import { auditEvent, branch } from "@odentia/db/schema/org"
import {
  portalAccessLog,
  portalLink,
  portalSession,
  type PortalScope,
} from "@odentia/db/schema/portal"
import { portalPasskey } from "@odentia/db/schema/portal-access"
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt } from "drizzle-orm"
import { moveAppointment, setAppointmentStatus } from "./appointments.js"
import {
  listAvailableSlots,
  type AvailableSlotsResult,
} from "./availability.js"
import { decideBudget, getBudgetDetail, listBudgets, type BudgetWithTotals } from "./budgets.js"
import { getPatientDocument, listPatientDocuments } from "./clinical.js"
import { sendOutbound } from "./conversations.js"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import { getPatientAccount } from "./payments.js"
import type { Storage } from "./storage.js"
import { createWorkspaceNotification } from "./workspace.js"
import { getPortalPolicy, portalDisabled, requireActivePortalGrant } from "./portal-policy.js"

/**
 * Portal del paciente: enlaces de un solo uso + sesiones revocables.
 *
 * - El token crudo solo existe en memoria y en el mensaje de entrega; en DB
 *   solo vive su hash sha256.
 * - La entrega del enlace exige una conversación abierta del mismo contacto
 *   (canal ya validado por el operador): la API staff jamás devuelve el token.
 * - Cada sesión queda ligada a UN paciente + UN contacto + alcance congelado.
 * - Las acciones que escriben (confirmar/reprogramar/decidir) se firman con
 *   el operador emisor (issuedBy, usuario real) y el contacto verificado va
 *   en decidedByContactId / metadata; cada lectura sensible se registra en
 *   portal_access_log.
 */

const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const SESSION_TTL_HOURS_DEFAULT = 48
const SESSION_TTL_HOURS_MAX = 168
const LINK_TTL_HOURS_DEFAULT = 72
const LINK_TTL_HOURS_MAX = 720
const RESCHEDULE_HORIZON_DAYS = 120

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

async function logAccess(
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
  ttlHours?: number
  idempotencyKey?: string
}

function assertTtl(ttlHours: number | undefined, def: number, max: number, field: string): number {
  const ttl = ttlHours ?? def
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > max) {
    throw validation(`${field} debe estar entre 1 y ${max} horas`)
  }
  return Math.floor(ttl)
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

/** El vínculo puede retirarse tras emitir: sin fila el acceso equivale a revocado. */
export async function requireActiveGrant(tx: Db, orgId: string, patientId: string, contactId: string): Promise<void> {
  const [grant] = await tx
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
  if (!grant) throw conflict("PORTAL_REVOKED", "Este acceso fue revocado; pide uno nuevo en recepción")
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
    .select({ displayName: patient.displayName })
    .from(patient)
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
  deliver: { linkUrl: (rawLinkToken: string) => string; canShareFinance: boolean },
): Promise<IssuedPortalLink> {
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled) throw portalDisabled()
  const ttlHours = assertTtl(input.ttlHours, LINK_TTL_HOURS_DEFAULT, LINK_TTL_HOURS_MAX, "La vigencia")
  const linkTtlMs = Math.min(ttlHours * 3600_000, policy.linkTtlMinutes * 60_000)
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
  if ((scope.budgets || scope.account) && !deliver.canShareFinance) {
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "El alcance financiero requiere permiso de finanzas")
  }
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
  // La emisión exige el grant verificado ya creado (vía grants/solicitud
  // aprobada): nunca crea grants implícitos ni toca las passkeys (la
  // recuperación usa el endpoint dedicado de revocación).
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
  if (conv.status !== "open") throw conflict("CONVERSATION_CLOSED", "La conversación está cerrada")
  // La emisión por canal exige conexión autorizada en la política.
  const [issuanceConnection] = await tx
    .select({ id: channelConnection.id, status: channelConnection.status })
    .from(channelConnection)
    .where(eq(channelConnection.id, conv.channelConnectionId))
    .limit(1)
  if (
    !issuanceConnection ||
    issuanceConnection.status !== "active" ||
    !policy.allowedConnectionIds.includes(issuanceConnection.id)
  ) {
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "Esta conversación no está autorizada para el portal")
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
  const vence = row.expiresAt.toLocaleString("es-PE", { dateStyle: "medium", timeStyle: "short" })
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
  ttlHours?: number
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
  const ttlHours = assertTtl(input.ttlHours, LINK_TTL_HOURS_DEFAULT, LINK_TTL_HOURS_MAX, "La vigencia")
  const linkTtlMs = Math.min(ttlHours * 3600_000, policy.linkTtlMinutes * 60_000)
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
  sessionTtlHours?: number
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
  if (!policy.enabled || !policy.assistedRecoveryEnabled) throw portalDisabled()
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

  const sessionTtl = Math.min(
    assertTtl(input?.sessionTtlHours, SESSION_TTL_HOURS_DEFAULT, SESSION_TTL_HOURS_MAX, "La sesión"),
    policy.sessionTtlHours,
  )
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

function requireScope(session: PortalSessionRow, key: "appointments" | "budgets" | "account"): void {
  if (session.scope?.[key] !== true) {
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "Esta sección no está autorizada en tu acceso")
  }
}

function requireDocumentInScope(session: PortalSessionRow, documentId: string): void {
  const allowed = Array.isArray(session.scope?.documents) && session.scope.documents.includes(documentId)
  if (!allowed) throw new ServiceError("PORTAL_FORBIDDEN", 404, "Este documento no está autorizado en tu acceso")
}

function requireIssuer(session: PortalSessionRow): string {
  if (!session.issuedBy) throw conflict("PORTAL_ISSUER", "El acceso no tiene operador emisor")
  return session.issuedBy
}

export interface PortalAppointmentView {
  id: string
  startsAt: string
  endsAt: string
  serviceName: string | null
  status: string
  branchName: string
  version: number
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
      branchName: branch.name,
    })
    .from(appointment)
    .innerJoin(branch, eq(branch.id, appointment.branchId))
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
  return rows.map((row) => ({
    ...row,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
  }))
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
  if (current.status !== "programada") {
    throw conflict("APPOINTMENT_STATUS", "Solo puedes confirmar una cita programada")
  }
  if (current.startsAt.getTime() <= Date.now()) {
    throw conflict("APPOINTMENT_STATUS", "Esta cita ya pasó; pide una nueva en recepción")
  }
  const updated = await setAppointmentStatus(tx, ctx.orgId, requireIssuer(ctx.session), current.id, "confirmada")
  await auditPortal(tx, ctx.orgId, ctx.session.issuedBy, "portal.appointment_confirmed", "appointment", current.id, {
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
  const [branchRow] = await tx
    .select({ name: branch.name })
    .from(branch)
    .where(eq(branch.id, updated.branchId))
    .limit(1)
  if (!branchRow) throw notFound("Sucursal")
  return {
    id: updated.id,
    startsAt: updated.startsAt,
    endsAt: updated.endsAt,
    serviceName: updated.serviceName,
    status: updated.status,
    branchName: branchRow.name,
    version: updated.version,
  }
}

export interface ReschedulePortalAppointmentInput {
  expectedVersion: number
  startsAt: string
}

/**
 * Reprograma manteniendo profesional y sillón (reglas de Agenda: exclusión
 * anti-solapamiento y bloqueo optimista). Sin disponibilidad ficticia: si el
 * recurso está ocupado, la cita no se mueve (APPOINTMENT_CONFLICT).
 */
export async function reschedulePortalAppointment(
  tx: Db,
  ctx: PortalContext,
  appointmentId: string,
  input: ReschedulePortalAppointmentInput,
): Promise<PortalAppointmentView> {
  requireScope(ctx.session, "appointments")
  const current = await requireOwnAppointment(tx, ctx, appointmentId)
  if (current.status !== "programada" && current.status !== "confirmada") {
    throw conflict("APPOINTMENT_STATUS", "Esta cita ya no puede reprogramarse")
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validation("La versión de la cita es inválida; recarga e intenta de nuevo")
  }
  const startsAt = new Date(input.startsAt)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(input.startsAt) || !Number.isFinite(startsAt.getTime())) {
    throw validation("Fecha ISO inválida")
  }
  if (startsAt.getTime() <= Date.now()) throw validation("Elige una fecha futura")
  if (startsAt.getTime() > Date.now() + RESCHEDULE_HORIZON_DAYS * 24 * 3600_000) {
    throw validation(`Solo puedes reprogramar dentro de ${RESCHEDULE_HORIZON_DAYS} días`)
  }
  const moved = await moveAppointment(tx, ctx.orgId, requireIssuer(ctx.session), current.id, {
    expectedVersion: input.expectedVersion,
    startsAt: startsAt.toISOString(),
  })
  await auditPortal(tx, ctx.orgId, ctx.session.issuedBy, "portal.appointment_rescheduled", "appointment", current.id, {
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
  const [branchRow] = await tx
    .select({ name: branch.name })
    .from(branch)
    .where(eq(branch.id, moved.branchId))
    .limit(1)
  return {
    id: moved.id,
    startsAt: moved.startsAt,
    endsAt: moved.endsAt,
    serviceName: moved.serviceName,
    status: moved.status,
    branchName: branchRow?.name ?? "",
    version: moved.version,
  }
}

export interface PortalRescheduleSlotsInput {
  from: string
  to: string
}

/**
 * Huecos reales para reprogramar la cita, con sus mismos recursos
 * (sucursal, profesional, sillón y duración). Delega en Agenda
 * (listAvailableSlots): el portal nunca calcula disponibilidad.
 */
export async function getPortalRescheduleSlots(
  tx: Db,
  ctx: PortalContext,
  appointmentId: string,
  input: PortalRescheduleSlotsInput,
): Promise<AvailableSlotsResult> {
  requireScope(ctx.session, "appointments")
  const current = await requireOwnAppointment(tx, ctx, appointmentId)
  if (current.status !== "programada" && current.status !== "confirmada") {
    throw conflict("APPOINTMENT_STATUS", "Esta cita ya no puede reprogramarse")
  }
  if (typeof input.from !== "string" || typeof input.to !== "string") {
    throw validation("Rango de fechas inválido")
  }
  const slots = await listAvailableSlots(tx, ctx.orgId, {
    branchId: current.branchId,
    dentistUserId: current.dentistUserId,
    chairId: current.chairId,
    from: input.from,
    to: input.to,
    durationMin: current.durationMin,
  })
  await logAccess(tx, ctx.orgId, ctx.session.id, "appointment.slots_viewed", "appointment", current.id)
  return slots
}

export interface PortalBudgetLineView {
  planItemId: string
  title: string
  scope: string | null
  toothNumber: number | null
  priceCents: number | null
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
  totalCents: number | null
  acceptedCents: number | null
  presentedAt: Date | null
  decidedAt: Date | null
  acceptedByName: string | null
  decisionNote: string | null
  items: PortalBudgetLineView[]
}

function toPortalBudget(budget: BudgetWithTotals): PortalBudgetView {
  return {
    id: budget.id,
    planId: budget.planId,
    budgetNumber: budget.budgetNumber,
    revisionNumber: budget.revisionNumber,
    title: budget.title,
    notes: budget.notes,
    status: budget.status,
    currency: budget.currency,
    totalCents: budget.totalCents,
    acceptedCents: budget.acceptedCents,
    presentedAt: budget.presentedAt,
    decidedAt: budget.decidedAt,
    acceptedByName: budget.acceptedByName,
    decisionNote: budget.decisionNote,
    items: budget.items.map((line) => ({
      planItemId: line.planItemId,
      title: line.title,
      scope: line.scope,
      toothNumber: line.toothNumber,
      priceCents: line.priceCents,
      currency: line.currency,
      decision: line.decision,
      itemStatus: line.itemStatus,
    })),
  }
}

/** Presupuestos visibles del paciente: nunca borradores ni internos. */
export async function listPortalBudgets(tx: Db, ctx: PortalContext): Promise<PortalBudgetView[]> {
  requireScope(ctx.session, "budgets")
  const budgets = await listBudgets(tx, ctx.orgId, ctx.session.patientId)
  await logAccess(tx, ctx.orgId, ctx.session.id, "budgets.listed")
  return budgets.filter((budget) => budget.status !== "borrador").map(toPortalBudget)
}

export interface DecidePortalBudgetInput {
  decisions: Array<{ planItemId: string; decision: "aceptado" | "rechazado" | "pospuesto" }>
  decisionNote?: string | null
}

/**
 * Decisión del representante verificado sobre un presupuesto presentado.
 * Idempotente: si el mismo contacto ya decidió este presupuesto, se devuelve
 * el resultado sin reescribir (replay de red seguro).
 */
export async function decidePortalBudget(
  tx: Db,
  ctx: PortalContext,
  budgetId: string,
  input: DecidePortalBudgetInput,
): Promise<{ budget: PortalBudgetView; replay: boolean }> {
  requireScope(ctx.session, "budgets")
  const current = await getBudgetDetail(tx, ctx.orgId, ctx.session.patientId, budgetId)
  if (current.status !== "presentado") {
    const decided = ["aceptado", "parcial", "rechazado", "pospuesto"].includes(current.status)
    if (decided && current.decisionContactId === ctx.session.contactId) {
      await logAccess(tx, ctx.orgId, ctx.session.id, "budget.decision_replayed", "treatment_budget", budgetId)
      return { budget: toPortalBudget(current), replay: true }
    }
    throw conflict("BUDGET_STATUS", "Este presupuesto ya no admite decisión")
  }
  if (!Array.isArray(input.decisions) || input.decisions.length === 0) {
    throw validation("Debe decidir cada línea exactamente una vez")
  }
  let decided: BudgetWithTotals
  try {
    decided = await decideBudget(tx, ctx.orgId, requireIssuer(ctx.session), ctx.session.patientId, budgetId, {
      decisions: input.decisions,
      decidedByContactId: ctx.session.contactId,
      decisionNote: input.decisionNote ?? null,
    })
  } catch (error) {
    if (error instanceof ServiceError && error.code === "BUDGET_STATUS") {
      const current = await getBudgetDetail(tx, ctx.orgId, ctx.session.patientId, budgetId)
      if (current.decisionContactId === ctx.session.contactId) {
        await logAccess(tx, ctx.orgId, ctx.session.id, "budget.decision_replayed", "treatment_budget", budgetId)
        return { budget: toPortalBudget(current), replay: true }
      }
    }
    throw error
  }
  await auditPortal(tx, ctx.orgId, ctx.session.issuedBy, "portal.budget_decided", "treatment_budget", budgetId, {
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
  return { budget: toPortalBudget(decided), replay: false }
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
  await auditPortal(tx, ctx.orgId, ctx.session.issuedBy, "portal.document_read", "patient_document", documentId, {
    sessionId: ctx.session.id,
    contactId: ctx.session.contactId,
  })
  await logAccess(tx, ctx.orgId, ctx.session.id, "document.read", "patient_document", documentId)
  const expiresInSeconds = 300
  const url = await storage.attachmentUrl(doc.storageKey, expiresInSeconds)
  return { url, expiresInSeconds }
}

export interface PortalAccountView {
  byCurrency: Array<{
    currency: string
    agreedCents: number
    chargedCents: number
    paidCents: number
    appliedCents: number
    refundedCents: number
    outstandingCents: number
    availableCreditCents: number
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
        method: payment.method,
        reference: payment.reference,
        paidAt: payment.paidAt,
        voidedAt: payment.voidedAt,
      })),
  }
}
