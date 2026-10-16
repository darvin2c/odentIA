import type { Db } from "@odentia/db"
import { patient, patientContact } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { portalAccessLog, portalLink, portalSession } from "@odentia/db/schema/portal"
import {
  portalChallenge,
  portalGrant,
  portalPasskey,
  portalRequest,
  type PortalGrantStatus,
  type PortalRequestChannel,
  type PortalRequestStatus,
} from "@odentia/db/schema/portal-access"
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server"
import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm"
import { createHash, randomBytes } from "node:crypto"
import { sendOutbound } from "./conversations.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import {
  ensurePortalGrant,
  getPortalPolicy,
  hasPriorVerification,
  isGrantUsable,
  portalDisabled,
  requireActivePortalGrant,
  type PortalGrantRow,
  type PortalPolicy,
} from "./portal-policy.js"
import {
  assertScope,
  issuePortalLink,
  requireActiveGrant,
  toSessionView,
  type IssuePortalLinkInput,
  type IssuedPortalLink,
  type PortalContext,
  type PortalSessionView,
} from "./portal.js"
import { completeTask, createTask, settleTask } from "./tasks.js"

/**
 * Portal del paciente: solicitudes iniciadas por el paciente, grants
 * persistentes, passkeys WebAuthn y gancho de canal oficial.
 *
 * Invariantes de acceso:
 * - La coincidencia de teléfono NUNCA verifica identidad: no otorga, aprueba
 *   ni autocompleta nada. Las solicitudes web ni siquiera referencian contactos.
 * - Sin datos clínicos en mensajes de canal ni en títulos de tareas.
 * - El registro passkey exige sesión Bearer de un canje (nunca el token de
 *   activación crudo); challenges de 5 min y un solo uso con origin/rpID de
 *   configuración verificada por organización (PortalRpConfig lo provee la API).
 */

export interface PortalRpConfig {
  rpID: string
  rpName: string
  expectedOrigin: string
}

export interface PortalAccessRequest {
  id: string
  patientName: string | null
  contactName: string
  contactText: string | null
  channel: PortalRequestChannel
  status: PortalRequestStatus
  conversationId: string | null
  createdAt: Date
  expiresAt: Date
  decidedAt: Date | null
}

export interface PortalGrant {
  id: string
  patientId: string
  patientName: string
  contactId: string
  contactName: string
  scope: PortalGrantRow["scope"]
  status: PortalGrantStatus
  verifiedMethod: string
  verifiedAt: Date
  expiresAt: Date | null
  createdAt: Date
  revokedAt: Date | null
}

export interface PortalPasskeyInfo {
  id: string
  nickname: string | null
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

type RegistrationVerifyInput = Parameters<typeof verifyRegistrationResponse>[0]
type AuthenticationVerifyInput = Parameters<typeof verifyAuthenticationResponse>[0]
type StoredCredential = NonNullable<AuthenticationVerifyInput["credential"]>

const REQUEST_TTL_DAYS = 7
const CHALLENGE_TTL_MINUTES = 5
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Solicitud explícita de acceso en texto libre (intención + objeto). */
const REQUEST_RES = [
  /(solicit|quiero|necesito|necesitamos|pido|dame|denme|env[ií]ame|env[ií]enme|act[ií]vame|act[ií]venme|activar|darme de alta).{0,60}(portal|acceso|enlace|link|mi cuenta)/i,
  /(portal|enlace|link).{0,30}(por favor|porfa|act[ií]valo|act[ií]venlo|quiero|necesito|solicito)/i,
]

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
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(portalAccessLog).values({
    organizationId: orgId,
    sessionId,
    action,
    metadata: metadata ?? {},
  })
}

function assertRp(rp: PortalRpConfig): void {
  if (!rp || typeof rp.rpID !== "string" || rp.rpID.includes("/") || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/i.test(rp.rpID)) {
    throw validation("Configuración del portal inválida (rpID)")
  }
  if (typeof rp.rpName !== "string" || !rp.rpName.trim() || rp.rpName.length > 100) {
    throw validation("Configuración del portal inválida (nombre)")
  }
  let origin: URL
  try {
    origin = new URL(rp.expectedOrigin)
  } catch {
    throw validation("Configuración del portal inválida (origen)")
  }
  const local = origin.hostname === "localhost" || origin.hostname === "127.0.0.1"
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && local)) {
    throw validation("Configuración del portal inválida (origen)")
  }
}

function rawToken(): string {
  return randomBytes(32).toString("base64url")
}

function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}


/** Transportes declarados por el autenticador (lectura defensiva). */
function extractTransports(response: unknown): string[] {
  if (!response || typeof response !== "object" || !("response" in response)) return []
  const inner: unknown = response.response
  if (!inner || typeof inner !== "object" || !("transports" in inner)) return []
  const transports: unknown = inner.transports
  if (!Array.isArray(transports)) return []
  return transports.filter((item): item is string => typeof item === "string").slice(0, 8)
}

function extractCredentialId(response: unknown): string | null {
  if (!response || typeof response !== "object" || !("id" in response)) return null
  const id: unknown = response.id
  return typeof id === "string" && id.length > 0 && id.length <= 512 ? id : null
}

async function grantView(tx: Db, orgId: string, grant: PortalGrantRow): Promise<PortalGrant> {
  const [patientRow] = await tx
    .select({ displayName: patient.displayName })
    .from(patient)
    .where(and(eq(patient.id, grant.patientId), eq(patient.organizationId, orgId)))
    .limit(1)
  const [contactRow] = await tx
    .select({ displayName: contact.displayName })
    .from(contact)
    .where(and(eq(contact.id, grant.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  return {
    id: grant.id,
    patientId: grant.patientId,
    patientName: patientRow?.displayName ?? "Paciente",
    contactId: grant.contactId,
    contactName: contactRow?.displayName ?? "Contacto",
    scope: grant.scope,
    status: grant.status === "revocado" ? "revocado" : "activo",
    verifiedMethod: grant.verifiedMethod,
    verifiedAt: grant.verifiedAt,
    expiresAt: grant.expiresAt,
    createdAt: grant.createdAt,
    revokedAt: grant.revokedAt,
  }
}

function requestView(row: typeof portalRequest.$inferSelect): PortalAccessRequest {
  return {
    id: row.id,
    patientName: null,
    contactName: row.contactName,
    contactText: row.contactText,
    channel: row.channel === "conversacion" ? "conversacion" : "web_publica",
    status: (["pendiente", "aprobada", "rechazada", "expirada"] as const).includes(
      row.status as PortalRequestStatus,
    )
      ? (row.status as PortalRequestStatus)
      : "pendiente",
    conversationId: row.conversationId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
  }
}

function passkeyView(row: typeof portalPasskey.$inferSelect): PortalPasskeyInfo {
  return {
    id: row.id,
    nickname: row.nickname,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  }
}

/** Vencimiento perezoso: las pendientes vencidas pasan a expirada y liquidan su tarea. */
async function expireStaleRequests(tx: Db, orgId: string): Promise<void> {
  const now = new Date()
  const stale = await tx
    .update(portalRequest)
    .set({ status: "expirada", updatedAt: now })
    .where(
      and(
        eq(portalRequest.organizationId, orgId),
        eq(portalRequest.status, "pendiente"),
        lte(portalRequest.expiresAt, now),
      ),
    )
    .returning({ taskId: portalRequest.taskId, id: portalRequest.id })
  for (const row of stale) await settleRequestTask(tx, orgId, row.taskId, row.id, "la solicitud del portal venció")
}

/**
 * Solicitud web pública. Siempre responde { received: true } aunque el portal
 * esté deshabilitado (sin oráculo de existencia) y jamás referencia ni crea
 * pacientes o contactos: el texto libre nunca se matchea automáticamente.
 */
export async function createPublicPortalRequest(
  tx: Db,
  orgId: string,
  input: { contactName: string; contactText: string; patientHint?: string; idempotencyKey?: string },
): Promise<{ received: true }> {
  const policy = await getPortalPolicy(tx, orgId)
  const contactName = input.contactName?.trim() ?? ""
  const contactText = input.contactText?.trim() ?? ""
  const patientHint = input.patientHint?.trim()?.slice(0, 200) || null
  const idempotencyKey = input.idempotencyKey?.trim() || null
  if (contactName.length < 2 || contactName.length > 120) throw validation("Indícanos tu nombre (2–120 caracteres)")
  if (contactText.length < 2 || contactText.length > 200) {
    throw validation("Indícanos un teléfono o correo de contacto (2–200 caracteres)")
  }
  if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
    throw validation("La clave de idempotencia debe tener 8–128 caracteres")
  }
  if (!policy.enabled || !policy.requestsEnabled || !policy.publicRequestsEnabled) {
    return { received: true }
  }
  if (idempotencyKey) {
    const [existing] = await tx
      .select({ id: portalRequest.id })
      .from(portalRequest)
      .where(and(eq(portalRequest.organizationId, orgId), eq(portalRequest.idempotencyKey, idempotencyKey)))
      .limit(1)
    if (existing) return { received: true }
  }
  const task = await createTask(tx, orgId, {
    title: "Revisar solicitud de acceso al portal",
    createdBy: "agent",
  })
  const [request] = await tx
    .insert(portalRequest)
    .values({
      organizationId: orgId,
      channel: "web_publica",
      status: "pendiente",
      contactName,
      contactText,
      patientHint,
      taskId: task.id,
      idempotencyKey,
      expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 86_400_000),
    })
    .returning()
  if (!request) throw new Error("No se pudo registrar la solicitud")
  await auditPortal(tx, orgId, null, "portal.request_created", "portal_request", request.id, {
    channel: "web_publica",
  })
  return { received: true }
}

/**
 * Gancho de canal oficial: detecta solicitudes explícitas de acceso al portal
 * en mensajes entrantes ya persistidos. Funciona sin IA (solo servicios) y
 * solo en conexiones autorizadas por la política. Nunca usa coincidencia de
 * teléfono y nunca emite credenciales (sin token, sin PIN, sin ampliar grants).
 *
 * - Contacto ya verificado (grant activo y vigente + passkey vigente) con
 *   `autoApproveVerified`: responde el enlace genérico de ingreso con passkey
 *   y registra la solicitud como aprobada (sin tarea pendiente).
 * - Resto (no verificado, ambiguo o modo manual): crea la solicitud pendiente
 *   + tarea genérica y responde un texto genérico sin datos clínicos.
 * Devuelve si lo gestionó.
 */
export async function handlePortalChannelRequest(
  tx: Db,
  orgId: string,
  ids: { conversationId: string; messageId: string },
  opts: { portalUrl: () => string },
): Promise<boolean> {
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled || !policy.requestsEnabled || !policy.channelRequestsEnabled) return false
  const [msg] = await tx
    .select()
    .from(message)
    .where(and(eq(message.id, ids.messageId), eq(message.organizationId, orgId)))
    .limit(1)
  if (!msg || msg.direction !== "in" || msg.conversationId !== ids.conversationId) return false
  const body = msg.body ?? ""
  if (!REQUEST_RES.some((re) => re.test(body))) return false
  const [conv] = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.id, ids.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!conv || conv.status !== "open") return false
  const [connection] = await tx
    .select()
    .from(channelConnection)
    .where(eq(channelConnection.id, conv.channelConnectionId))
    .limit(1)
  if (!connection || connection.organizationId !== orgId) return false
  if (connection.status !== "active" || !policy.allowedConnectionIds.includes(connection.id)) return false
  const [contactRow] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.id, conv.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!contactRow || !contactRow.isActive) return false
  const [duplicate] = await tx
    .select({ id: portalRequest.id })
    .from(portalRequest)
    .where(
      and(eq(portalRequest.organizationId, orgId), eq(portalRequest.triggerMessageId, ids.messageId)),
    )
    .limit(1)
  if (duplicate) return true
  // Ruta automática: contacto ya verificado (grant activo y vigente + passkey
  // vigente) con autoApproveVerified. Sin credenciales nuevas: solo el enlace
  // genérico de ingreso con passkey, sin token, sin PIN y sin ampliar grants.
  if (policy.autoApproveVerified && policy.passkeysEnabled) {
    const candidateGrants = await tx
      .select()
      .from(portalGrant)
      .where(
        and(
          eq(portalGrant.organizationId, orgId),
          eq(portalGrant.contactId, contactRow.id),
          eq(portalGrant.status, "activo"),
        ),
      )
    const usable = candidateGrants.filter((grant) => isGrantUsable(grant))
    if (usable.length > 0) {
      const creds = await tx
        .select({ id: portalPasskey.id })
        .from(portalPasskey)
        .where(
          and(
            eq(portalPasskey.organizationId, orgId),
            inArray(
              portalPasskey.grantId,
              usable.map((grant) => grant.id),
            ),
            isNull(portalPasskey.revokedAt),
          ),
        )
        .limit(1)
      if (creds.length > 0) {
        const now = new Date()
        const [auto] = await tx
          .insert(portalRequest)
          .values({
            organizationId: orgId,
            channel: "conversacion",
            status: "aprobada",
            contactName: contactRow.displayName,
            contactId: contactRow.id,
            conversationId: conv.id,
            triggerMessageId: ids.messageId,
            expiresAt: new Date(now.getTime() + REQUEST_TTL_DAYS * 86_400_000),
            decidedAt: now,
            decisionNote: "Acceso con passkey existente.",
          })
          .returning()
        if (!auto) throw new Error("No se pudo registrar la solicitud")
        await auditPortal(tx, orgId, null, "portal.request_auto_approved", "portal_request", auto.id, {
          channel: "conversacion",
          conversationId: conv.id,
        })
        try {
          await sendOutbound(tx, orgId, {
            conversationId: conv.id,
            senderKind: "agent",
            content: {
              type: "text",
              text: `Ya tienes acceso al portal: entra con tu passkey aquí: ${opts.portalUrl()}. Si perdiste tu dispositivo, avísanos por este medio y lo recuperamos en recepción.`,
            },
          })
        } catch {
          await auditPortal(tx, orgId, null, "portal.request_reply_failed", "portal_request", auto.id, {
            conversationId: conv.id,
          })
        }
        return true
      }
    }
  }
  const task = await createTask(tx, orgId, {
    title: "Revisar solicitud de acceso al portal",
    contactId: contactRow.id,
    conversationId: conv.id,
    createdBy: "agent",
  })
  const [request] = await tx
    .insert(portalRequest)
    .values({
      organizationId: orgId,
      channel: "conversacion",
      status: "pendiente",
      contactName: contactRow.displayName,
      contactId: contactRow.id,
      conversationId: conv.id,
      triggerMessageId: ids.messageId,
      taskId: task.id,
      expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 86_400_000),
    })
    .returning()
  if (!request) throw new Error("No se pudo registrar la solicitud")
  await auditPortal(tx, orgId, null, "portal.request_created", "portal_request", request.id, {
    channel: "conversacion",
    conversationId: conv.id,
  })
  try {
    await sendOutbound(tx, orgId, {
      conversationId: conv.id,
      senderKind: "agent",
      content: {
        type: "text",
        text: "Recibimos tu solicitud de acceso al portal. Te avisaremos por este medio cuando esté lista; no necesitas hacer nada más. Por este chat no compartas datos clínicos.",
      },
    })
  } catch {
    await auditPortal(tx, orgId, null, "portal.request_reply_failed", "portal_request", request.id, {
      conversationId: conv.id,
    })
  }
  return true
}

export async function listPortalRequests(
  tx: Db,
  orgId: string,
  status?: PortalRequestStatus,
): Promise<PortalAccessRequest[]> {
  await expireStaleRequests(tx, orgId)
  const rows = await tx
    .select()
    .from(portalRequest)
    .where(
      and(
        eq(portalRequest.organizationId, orgId),
        status ? eq(portalRequest.status, status) : undefined,
      ),
    )
    .orderBy(desc(portalRequest.createdAt))
    .limit(100)
  return rows.map(requestView)
}

/** El vínculo representante↔paciente: sin fila no hay grant ni enlace. */
async function ensurePatientLink(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  contactId: string,
  relationship: "self" | "guardian" | "family" | "other",
): Promise<void> {
  const [existing] = await tx
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
  if (existing) return
  try {
    await tx.insert(patientContact).values({
      organizationId: orgId,
      patientId,
      contactId,
      relationship,
      createdBy: actorUserId,
    })
  } catch {
    throw validation("El vínculo ya existe con otra relación; revísalo en la ficha del paciente")
  }
}

/**
 * Evidencia de verificación: en modo manual siempre se exige nota fresca del
 * acto; en modo verificado-automático puede apoyarse en verificación previa.
 */
async function assertApprovalEvidence(
  tx: Db,
  orgId: string,
  policy: PortalPolicy,
  patientId: string,
  contactId: string,
  note: string | null | undefined,
): Promise<string | null> {
  const fresh = note?.trim()?.slice(0, 500) || null
  if (fresh) return fresh
  if (policy.autoApproveVerified && (await hasPriorVerification(tx, orgId, patientId, contactId))) {
    return null
  }
  throw validation("En modo manual, registra la evidencia de la verificación presencial (qué documento revisaste)")
}

/**
 * La tarea de revisar una solicitud: hecha cuando alguien la aprueba; si se
 * rechaza o vence, se cierra sola diciendo por qué (ADR 0028).
 */
async function settleRequestTask(tx: Db, orgId: string, taskId: string | null, requestId: string, reason?: string): Promise<void> {
  if (!taskId) return
  try {
    if (reason) await settleTask(tx, orgId, taskId, reason)
    else await completeTask(tx, orgId, taskId)
  } catch {
    await auditPortal(tx, orgId, null, "portal.request_task_missing", "portal_request", requestId, {})
  }
}

export interface DecidePortalRequestInput {
  patientId: string
  contactId: string
  relationship?: "self" | "guardian" | "family" | "other"
  scope: IssuePortalLinkInput["scope"]
  verifiedMethod: string
  evidenceNote?: string | null
  conversationId: string
  deliver: { linkUrl: (rawLinkToken: string) => string; canShareFinance: boolean }
}

/**
 * Aprueba una solicitud pendiente: verifica paciente+contacto, exige método
 * del enum con evidencia, crea el vínculo y el grant, y emite el enlace
 * asistido por la conversación indicada. La aprobación nunca usa coincidencia
 * de teléfono: las identidades vienen del staff en el input.
 */
export async function approvePortalRequest(
  tx: Db,
  orgId: string,
  actorUserId: string,
  requestId: string,
  input: DecidePortalRequestInput,
): Promise<{ grant: PortalGrant; link: IssuedPortalLink }> {
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled) throw portalDisabled()
  const [request] = await tx
    .select()
    .from(portalRequest)
    .where(and(eq(portalRequest.id, requestId), eq(portalRequest.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!request) throw notFound("Solicitud de acceso")
  if (request.status !== "pendiente" || request.expiresAt.getTime() <= Date.now()) {
    await tx
      .update(portalRequest)
      .set({ status: "expirada", updatedAt: new Date() })
      .where(and(eq(portalRequest.id, requestId), eq(portalRequest.organizationId, orgId)))
    await settleRequestTask(tx, orgId, request.taskId, requestId, "la solicitud del portal venció")
    throw new ServiceError("PORTAL_EXPIRED", 409, "Esta solicitud venció; crea una nueva")
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
  const evidenceNote = await assertApprovalEvidence(tx, orgId, policy, input.patientId, input.contactId, input.evidenceNote)
  const [conv] = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!conv) throw notFound("Conversación")
  if (conv.contactId !== input.contactId) throw validation("La conversación no pertenece a este contacto")
  // Una conversación cerrada no impide entregar el acceso: escribir en ella la reabre (ADR 0024).
  await ensurePatientLink(tx, orgId, actorUserId, input.patientId, input.contactId, input.relationship ?? "other")
  const scope = await assertScope(tx, orgId, input.patientId, input.scope)
  const ensured = await ensurePortalGrant(tx, orgId, actorUserId, {
    patientId: input.patientId,
    contactId: input.contactId,
    scope,
    verifiedMethod: input.verifiedMethod,
    evidenceNote,
    requestId,
    audit: (action, entityId, metadata) =>
      auditPortal(tx, orgId, actorUserId, action, "portal_grant", entityId, metadata),
  })
  // El grant ya quedó verificado arriba; la emisión solo entrega.
  const link = await issuePortalLink(
    tx,
    orgId,
    actorUserId,
    {
      patientId: input.patientId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      scope: input.scope,
    },
    input.deliver,
  )
  const now = new Date()
  await tx
    .update(portalRequest)
    .set({ status: "aprobada", decidedBy: actorUserId, decidedAt: now, updatedAt: now })
    .where(and(eq(portalRequest.id, requestId), eq(portalRequest.organizationId, orgId)))
  await settleRequestTask(tx, orgId, request.taskId, requestId)
  await auditPortal(tx, orgId, actorUserId, "portal.request_approved", "portal_request", requestId, {
    patientId: input.patientId,
    contactId: input.contactId,
    grantId: ensured.grant.id,
  })
  return { grant: await grantView(tx, orgId, ensured.grant), link }
}

export async function rejectPortalRequest(
  tx: Db,
  orgId: string,
  actorUserId: string,
  requestId: string,
  note?: string,
): Promise<PortalAccessRequest> {
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled) throw portalDisabled()
  const [request] = await tx
    .select()
    .from(portalRequest)
    .where(and(eq(portalRequest.id, requestId), eq(portalRequest.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!request) throw notFound("Solicitud de acceso")
  if (request.status !== "pendiente") throw new ServiceError("PORTAL_STATUS", 409, "Esta solicitud ya fue decidida")
  const now = new Date()
  const [updated] = await tx
    .update(portalRequest)
    .set({
      status: "rechazada",
      decidedBy: actorUserId,
      decidedAt: now,
      decisionNote: note?.trim()?.slice(0, 500) || null,
      updatedAt: now,
    })
    .where(and(eq(portalRequest.id, requestId), eq(portalRequest.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Solicitud de acceso")
  // Rechazar cierra su tarea, igual que aprobar o vencer: ya no hay nada que revisar.
  await settleRequestTask(tx, orgId, request.taskId, requestId, "la solicitud del portal se rechazó")
  await auditPortal(tx, orgId, actorUserId, "portal.request_rejected", "portal_request", requestId, {})
  return requestView(updated)
}

export interface CreatePortalGrantInput {
  patientId: string
  contactId: string
  relationship?: "self" | "guardian" | "family" | "other"
  scope: IssuePortalLinkInput["scope"]
  verifiedMethod: string
  evidenceNote?: string | null
}

/**
 * Grant directo del staff sin solicitud (activación en persona). Crea el
 * vínculo si falta; exige método del enum con evidencia según la política.
 */
export async function createPortalGrant(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreatePortalGrantInput,
): Promise<PortalGrant> {
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled) throw portalDisabled()
  const patientRow = await requirePatient(tx, orgId, input.patientId)
  if (!patientRow.isActive) throw notFound("Paciente")
  const [contactRow] = await tx
    .select({ isActive: contact.isActive })
    .from(contact)
    .where(and(eq(contact.id, input.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!contactRow) throw notFound("Contacto")
  if (!contactRow.isActive) throw validation("El contacto está inactivo")
  const evidenceNote = await assertApprovalEvidence(tx, orgId, policy, input.patientId, input.contactId, input.evidenceNote)
  await ensurePatientLink(tx, orgId, actorUserId, input.patientId, input.contactId, input.relationship ?? "other")
  const scope = await assertScope(tx, orgId, input.patientId, input.scope)
  const ensured = await ensurePortalGrant(tx, orgId, actorUserId, {
    patientId: input.patientId,
    contactId: input.contactId,
    scope,
    verifiedMethod: input.verifiedMethod,
    evidenceNote,
    audit: (action, entityId, metadata) =>
      auditPortal(tx, orgId, actorUserId, action, "portal_grant", entityId, metadata),
  })
  return grantView(tx, orgId, ensured.grant)
}

export async function listPortalGrants(tx: Db, orgId: string, patientId?: string): Promise<PortalGrant[]> {
  const rows = await tx
    .select()
    .from(portalGrant)
    .where(
      and(
        eq(portalGrant.organizationId, orgId),
        patientId ? eq(portalGrant.patientId, patientId) : undefined,
      ),
    )
    .orderBy(desc(portalGrant.createdAt))
    .limit(100)
  return Promise.all(rows.map((row) => grantView(tx, orgId, row)))
}

/**
 * Grants de la identidad autenticada. Solo usables y con vínculo y fichas
 * activas (nada revocado/caducado ni nombres de accesos muertos). Anti-escalada:
 * una sesión de enlace+PIN solo verifica ese par, así que solo ve su grant
 * actual; únicamente una sesión passkey (identidad del contacto) lista todos.
 */
export async function listMyPortalGrants(tx: Db, ctx: PortalContext): Promise<PortalGrant[]> {
  const candidates =
    ctx.session.authMethod !== "passkey" || !ctx.session.grantId
      ? await tx
          .select()
          .from(portalGrant)
          .where(
            and(
              eq(portalGrant.id, ctx.session.grantId ?? "00000000-0000-0000-0000-000000000000"),
              eq(portalGrant.organizationId, ctx.orgId),
            ),
          )
          .limit(1)
      : await tx
          .select()
          .from(portalGrant)
          .where(
            and(eq(portalGrant.organizationId, ctx.orgId), eq(portalGrant.contactId, ctx.session.contactId)),
          )
          .orderBy(desc(portalGrant.createdAt))
          .limit(50)
  const views: PortalGrant[] = []
  for (const grant of candidates) {
    if (!isGrantUsable(grant)) continue
    const [link] = await tx
      .select({ id: patientContact.id })
      .from(patientContact)
      .where(
        and(
          eq(patientContact.organizationId, ctx.orgId),
          eq(patientContact.patientId, grant.patientId),
          eq(patientContact.contactId, grant.contactId),
        ),
      )
      .limit(1)
    if (!link) continue
    const [patientRow] = await tx
      .select({ isActive: patient.isActive })
      .from(patient)
      .where(and(eq(patient.id, grant.patientId), eq(patient.organizationId, ctx.orgId)))
      .limit(1)
    const [contactRow] = await tx
      .select({ isActive: contact.isActive })
      .from(contact)
      .where(and(eq(contact.id, grant.contactId), eq(contact.organizationId, ctx.orgId)))
      .limit(1)
    if (!patientRow?.isActive || !contactRow?.isActive) continue
    views.push(await grantView(tx, ctx.orgId, grant))
  }
  return views
}

/**
 * Cambio de identidad entre grants del mismo contacto. Cruzar a otro grant
 * exige sesión passkey: el PIN solo verificó el par original (sin escalada).
 * Rota la sesión anterior (la revoca) para no acumular sesiones vivas.
 */
export async function selectPortalGrant(
  tx: Db,
  ctx: PortalContext,
  grantId: string,
  opts?: { sessionTtlHours?: number },
): Promise<{ sessionToken: string; session: PortalSessionView }> {
  const policy = await getPortalPolicy(tx, ctx.orgId)
  if (!policy.enabled) throw portalDisabled()
  const [grant] = await tx
    .select()
    .from(portalGrant)
    .where(and(eq(portalGrant.id, grantId), eq(portalGrant.organizationId, ctx.orgId)))
    .limit(1)
  if (!grant || grant.contactId !== ctx.session.contactId) {
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "Este acceso no está autorizado en tu sesión")
  }
  await requireActiveGrant(tx, ctx.orgId, grant.patientId, grant.contactId)
  const required = await requireActivePortalGrant(tx, ctx.orgId, grant.patientId, grant.contactId)
  if (required.id !== grant.id) {
    throw new ServiceError("PORTAL_REVOKED", 409, "Este acceso fue revocado; pide uno nuevo en recepción")
  }
  const patientRow = await requirePatient(tx, ctx.orgId, grant.patientId)
  if (!patientRow.isActive) throw notFound("Sesión del portal")
  if (grant.id !== ctx.session.grantId && ctx.session.authMethod !== "passkey") {
    throw new ServiceError(
      "PORTAL_FORBIDDEN",
      404,
      "Cambia de acceso con tu passkey o pide un enlace nuevo en recepción",
    )
  }
  const ttl = opts?.sessionTtlHours ?? policy.sessionTtlHours
  const bounded = Math.max(1, Math.min(Math.floor(ttl), policy.sessionTtlHours))
  const sessionToken = rawToken()
  const now = new Date()
  const [session] = await tx
    .insert(portalSession)
    .values({
      organizationId: ctx.orgId,
      patientId: grant.patientId,
      contactId: grant.contactId,
      grantId: grant.id,
      authMethod: ctx.session.authMethod === "passkey" ? "passkey" : "enlace_pin",
      passkeyId: ctx.session.passkeyId,
      scope: grant.scope,
      tokenHash: hashToken(sessionToken),
      expiresAt: new Date(now.getTime() + bounded * 3600_000),
      issuedBy: grant.verifiedBy ?? grant.createdBy ?? ctx.session.issuedBy,
      lastSeenAt: now,
    })
    .returning()
  if (!session) throw new Error("No se pudo cambiar de acceso")
  await tx
    .update(portalSession)
    .set({ revokedAt: now, revokedBy: null, updatedAt: now })
    .where(and(eq(portalSession.id, ctx.session.id), eq(portalSession.organizationId, ctx.orgId)))
  await logAccess(tx, ctx.orgId, session.id, "session.switched", { grantId: grant.id })
  return { sessionToken, session: toSessionView(session) }
}

/**
 * Revoca un grant y todo lo que cuelga de él: sesiones activas, enlaces
 * pendientes del par y passkeys de sus grants. El vínculo se conserva.
 */
export async function revokePortalGrant(
  tx: Db,
  orgId: string,
  actorUserId: string,
  grantId: string,
  reason?: string,
): Promise<PortalGrant> {
  const [grant] = await tx
    .select()
    .from(portalGrant)
    .where(and(eq(portalGrant.id, grantId), eq(portalGrant.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!grant) throw notFound("Acceso del portal")
  if (grant.status === "revocado") return grantView(tx, orgId, grant)
  const now = new Date()
  const [revoked] = await tx
    .update(portalGrant)
    .set({
      status: "revocado",
      revokedAt: now,
      revokedBy: actorUserId,
      revokeReason: reason?.trim()?.slice(0, 500) || null,
      updatedAt: now,
    })
    .where(and(eq(portalGrant.id, grantId), eq(portalGrant.organizationId, orgId)))
    .returning()
  if (!revoked) throw notFound("Acceso del portal")
  const sessions = await tx
    .update(portalSession)
    .set({ revokedAt: now, revokedBy: actorUserId, updatedAt: now })
    .where(
      and(
        eq(portalSession.organizationId, orgId),
        eq(portalSession.grantId, grantId),
        isNull(portalSession.revokedAt),
      ),
    )
    .returning({ id: portalSession.id })
  await tx
    .update(portalLink)
    .set({ status: "revocado", revokedAt: now, revokedBy: actorUserId, updatedAt: now })
    .where(
      and(
        eq(portalLink.organizationId, orgId),
        eq(portalLink.patientId, grant.patientId),
        eq(portalLink.contactId, grant.contactId),
        eq(portalLink.status, "pendiente"),
      ),
    )
  const creds = await tx
    .update(portalPasskey)
    .set({ revokedAt: now, revokedBy: actorUserId })
    .where(
      and(
        eq(portalPasskey.organizationId, orgId),
        eq(portalPasskey.grantId, grantId),
        isNull(portalPasskey.revokedAt),
      ),
    )
    .returning({ id: portalPasskey.id })
  await auditPortal(tx, orgId, actorUserId, "portal.grant_revoked", "portal_grant", grantId, {
    patientId: grant.patientId,
    contactId: grant.contactId,
    sessions: sessions.length,
    passkeys: creds.length,
  })
  return grantView(tx, orgId, revoked)
}

export async function listPortalSessions(
  tx: Db,
  orgId: string,
  opts?: { patientId?: string; contactId?: string; grantId?: string },
): Promise<PortalSessionView[]> {
  const rows = await tx
    .select()
    .from(portalSession)
    .where(
      and(
        eq(portalSession.organizationId, orgId),
        opts?.patientId ? eq(portalSession.patientId, opts.patientId) : undefined,
        opts?.contactId ? eq(portalSession.contactId, opts.contactId) : undefined,
        opts?.grantId ? eq(portalSession.grantId, opts.grantId) : undefined,
      ),
    )
    .orderBy(desc(portalSession.createdAt))
    .limit(100)
  return rows.map(toSessionView)
}

/**
 * Opciones de registro passkey. SOLO desde la sesión Bearer de un canje
 * token+PIN (ctx): nunca con el token de activación crudo. Vincula la
 * credencial al grant de la sesión.
 */
export async function createPasskeyRegistrationOptions(
  tx: Db,
  ctx: PortalContext,
  rp: PortalRpConfig,
): Promise<{ challengeId: string; options: Record<string, unknown> }> {
  assertRp(rp)
  const policy = await getPortalPolicy(tx, ctx.orgId)
  if (!policy.enabled || !policy.passkeysEnabled) throw portalDisabled()
  if (!ctx.session.grantId) {
    throw new ServiceError("PORTAL_GRANT_REQUIRED", 409, "Tu acceso es anterior; pide un enlace nuevo en recepción")
  }
  const grant = await requireActivePortalGrant(tx, ctx.orgId, ctx.session.patientId, ctx.session.contactId)
  const existing = await tx
    .select({ credentialId: portalPasskey.credentialId })
    .from(portalPasskey)
    .where(
      and(
        eq(portalPasskey.organizationId, ctx.orgId),
        eq(portalPasskey.grantId, grant.id),
        isNull(portalPasskey.revokedAt),
      ),
    )
  const [contactRow] = await tx
    .select({ displayName: contact.displayName })
    .from(contact)
    .where(and(eq(contact.id, grant.contactId), eq(contact.organizationId, ctx.orgId)))
    .limit(1)
  const userName = contactRow?.displayName ?? "Paciente"
  const options = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userID: new TextEncoder().encode(grant.id),
    userName,
    userDisplayName: userName,
    timeout: 60_000,
    attestationType: "none",
    excludeCredentials: existing.map((cred) => ({ id: cred.credentialId })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: [-7, -257],
  })
  const [challenge] = await tx
    .insert(portalChallenge)
    .values({
      organizationId: ctx.orgId,
      type: "registro",
      grantId: grant.id,
      sessionId: ctx.session.id,
      challenge: options.challenge,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MINUTES * 60_000),
    })
    .returning()
  if (!challenge) throw new Error("No se pudo iniciar el registro")
  await logAccess(tx, ctx.orgId, ctx.session.id, "passkey.registration_started")
  return { challengeId: challenge.id, options: { ...options } }
}

export async function verifyPasskeyRegistration(
  tx: Db,
  ctx: PortalContext,
  challengeId: string,
  response: unknown,
  rp: PortalRpConfig,
): Promise<PortalPasskeyInfo> {
  assertRp(rp)
  const policy = await getPortalPolicy(tx, ctx.orgId)
  if (!policy.enabled || !policy.passkeysEnabled) throw portalDisabled()
  if (!response || typeof response !== "object") throw validation("Respuesta de passkey inválida")
  const credentialId = extractCredentialId(response)
  if (!credentialId) throw validation("Respuesta de passkey inválida")
  const [challenge] = await tx
    .select()
    .from(portalChallenge)
    .where(and(eq(portalChallenge.id, challengeId), eq(portalChallenge.organizationId, ctx.orgId)))
    .for("update")
    .limit(1)
  if (
    !challenge ||
    challenge.type !== "registro" ||
    challenge.usedAt ||
    challenge.expiresAt.getTime() <= Date.now() ||
    challenge.sessionId !== ctx.session.id ||
    !challenge.grantId
  ) {
    throw new ServiceError("PORTAL_CHALLENGE", 409, "El registro venció; inicia de nuevo")
  }
  const grant = await requireActivePortalGrant(tx, ctx.orgId, ctx.session.patientId, ctx.session.contactId)
  if (challenge.grantId !== grant.id) {
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "Este registro no corresponde a tu acceso")
  }
  const [duplicate] = await tx
    .select()
    .from(portalPasskey)
    .where(and(eq(portalPasskey.credentialId, credentialId), eq(portalPasskey.organizationId, ctx.orgId)))
    .limit(1)
  if (duplicate) throw validation("Esta passkey ya está registrada; revócala antes de registrarla de nuevo")
  // Respuesta ya acotada a objeto con id; el detalle lo valida la librería.
  const credentialResponse: RegistrationVerifyInput["response"] = response as RegistrationVerifyInput["response"]
  const verification = await verifyRegistrationResponse({
    response: credentialResponse,
    expectedChallenge: challenge.challenge,
    expectedOrigin: rp.expectedOrigin,
    expectedRPID: rp.rpID,
    requireUserVerification: true,
  })
  if (!verification.verified || !verification.registrationInfo) {
    throw validation("No se pudo registrar la passkey; intenta de nuevo")
  }
  const registered = verification.registrationInfo.credential
  const [created] = await tx
    .insert(portalPasskey)
    .values({
      organizationId: ctx.orgId,
      grantId: grant.id,
      credentialId: registered.id,
      publicKey: Buffer.from(registered.publicKey).toString("base64url"),
      counter: registered.counter,
      transports: extractTransports(response),
    })
    .returning()
  if (!created) throw new Error("No se pudo guardar la passkey")
  await tx.update(portalChallenge).set({ usedAt: new Date() }).where(eq(portalChallenge.id, challenge.id))
  // Lo guarda la persona en su dispositivo: queda a su nombre, no al de quien le dio el acceso.
  await auditPortal(tx, ctx.orgId, `contact:${ctx.session.contactId}`, "portal.passkey_registered", "portal_passkey", created.id, {
    grantId: grant.id,
    sessionId: ctx.session.id,
  })
  await logAccess(tx, ctx.orgId, ctx.session.id, "passkey.registered")
  return passkeyView(created)
}

/**
 * Opciones de autenticación passkey (credenciales descubribles; sin grantId
 * expuesto: la credencial resuelve el grant al verificar).
 */
export async function createPasskeyAuthOptions(
  tx: Db,
  orgId: string,
  rp: PortalRpConfig,
): Promise<{ challengeId: string; options: Record<string, unknown> }> {
  assertRp(rp)
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled || !policy.passkeysEnabled) throw portalDisabled()
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    timeout: 60_000,
    userVerification: "required",
  })
  const [challenge] = await tx
    .insert(portalChallenge)
    .values({
      organizationId: orgId,
      type: "autenticacion",
      challenge: options.challenge,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MINUTES * 60_000),
    })
    .returning()
  if (!challenge) throw new Error("No se pudo iniciar la autenticación")
  return { challengeId: challenge.id, options: { ...options } }
}

/**
 * Verifica la autenticación y abre una sesión ligada al grant de la
 * credencial (alcance congelado del grant). Contador WebAuthn estricto salvo
 * autenticadores sin contador (0/0).
 */
export async function verifyPasskeyAuth(
  tx: Db,
  orgId: string,
  challengeId: string,
  response: unknown,
  rp: PortalRpConfig,
  opts?: { sessionTtlHours?: number },
): Promise<{ sessionToken: string; session: PortalSessionView }> {
  assertRp(rp)
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled || !policy.passkeysEnabled) throw portalDisabled()
  if (!response || typeof response !== "object") throw validation("Respuesta de passkey inválida")
  const [challenge] = await tx
    .select()
    .from(portalChallenge)
    .where(and(eq(portalChallenge.id, challengeId), eq(portalChallenge.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!challenge || challenge.type !== "autenticacion" || challenge.usedAt) {
    throw new ServiceError("PORTAL_CHALLENGE", 409, "La autenticación venció; inicia de nuevo")
  }
  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw new ServiceError("PORTAL_CHALLENGE", 409, "La autenticación venció; inicia de nuevo")
  }
  const credentialId = extractCredentialId(response)
  if (!credentialId) throw validation("Respuesta de passkey inválida")
  // Orden de bloqueo: credencial (FOR UPDATE) y luego grant/sesión; el mismo
  // orden en revocación evita interbloqueos. Serializa contador y revocación.
  const [cred] = await tx
    .select()
    .from(portalPasskey)
    .where(and(eq(portalPasskey.credentialId, credentialId), eq(portalPasskey.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (!cred) throw notFound("Passkey")
  if (cred.revokedAt) {
    throw new ServiceError("PORTAL_REVOKED", 409, "Esta passkey fue revocada; pide un acceso nuevo en recepción")
  }
  const [grantRow] = await tx
    .select()
    .from(portalGrant)
    .where(and(eq(portalGrant.id, cred.grantId), eq(portalGrant.organizationId, orgId)))
    .limit(1)
  if (!grantRow) {
    throw new ServiceError("PORTAL_REVOKED", 409, "Este acceso fue revocado; pide uno nuevo en recepción")
  }
  const grant = await requireActivePortalGrant(tx, orgId, grantRow.patientId, grantRow.contactId)
  if (grant.id !== grantRow.id) {
    throw new ServiceError("PORTAL_REVOKED", 409, "Este acceso fue revocado; pide uno nuevo en recepción")
  }
  await requireActiveGrant(tx, orgId, grant.patientId, grant.contactId)
  const patientRow = await requirePatient(tx, orgId, grant.patientId)
  if (!patientRow.isActive) throw notFound("Sesión del portal")
  const [contactRow] = await tx
    .select({ isActive: contact.isActive })
    .from(contact)
    .where(and(eq(contact.id, grant.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!contactRow?.isActive) throw notFound("Sesión del portal")
  // Transports persistidos tal cual los declaró el autenticador (mismo dominio que la unión de la librería).
  const transports = cred.transports as StoredCredential["transports"]
  const stored: AuthenticationVerifyInput["credential"] = {
    id: cred.credentialId,
    publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")),
    counter: cred.counter,
    transports,
  }
  // Respuesta ya acotada a objeto con id; la firma la verifica la librería.
  const authResponse: AuthenticationVerifyInput["response"] = response as AuthenticationVerifyInput["response"]
  const verification = await verifyAuthenticationResponse({
    response: authResponse,
    expectedChallenge: challenge.challenge,
    expectedOrigin: rp.expectedOrigin,
    expectedRPID: rp.rpID,
    credential: stored,
    requireUserVerification: true,
  })
  if (!verification.verified) throw validation("No se pudo verificar la passkey; intenta de nuevo")
  const freshCounter = verification.authenticationInfo.newCounter
  const counterless = cred.counter === 0 && freshCounter === 0
  if (!counterless && freshCounter <= cred.counter) {
    throw new ServiceError(
      "PORTAL_CLONE",
      409,
      "La credencial devolvió un contador inválido; registra tu passkey de nuevo en recepción",
    )
  }
  await tx
    .update(portalPasskey)
    .set({ counter: freshCounter, lastUsedAt: new Date() })
    .where(eq(portalPasskey.id, cred.id))
  await tx.update(portalChallenge).set({ usedAt: new Date() }).where(eq(portalChallenge.id, challenge.id))
  const bounded = Math.max(1, Math.min(Math.floor(opts?.sessionTtlHours ?? policy.sessionTtlHours), policy.sessionTtlHours))
  const sessionToken = rawToken()
  const now = new Date()
  const [session] = await tx
    .insert(portalSession)
    .values({
      organizationId: orgId,
      patientId: grant.patientId,
      contactId: grant.contactId,
      grantId: grant.id,
      authMethod: "passkey",
      passkeyId: cred.id,
      scope: grant.scope,
      tokenHash: hashToken(sessionToken),
      expiresAt: new Date(now.getTime() + bounded * 3600_000),
      // Firma operadora: el staff que verificó el grant; el contacto va en la sesión.
      issuedBy: grant.verifiedBy ?? grant.createdBy,
      lastSeenAt: now,
    })
    .returning()
  if (!session) throw new Error("No se pudo abrir la sesión del portal")
  await auditPortal(tx, orgId, null, "portal.passkey_authenticated", "portal_passkey", cred.id, {
    grantId: grant.id,
    sessionId: session.id,
  })
  await logAccess(tx, orgId, session.id, "session.opened", { via: "passkey" })
  return { sessionToken, session: toSessionView(session) }
}

/** Passkeys de un contacto (recuperación ante dispositivo perdido). */
export async function listPortalPasskeys(tx: Db, orgId: string, contactId: string): Promise<PortalPasskeyInfo[]> {
  const grants = await tx
    .select({ id: portalGrant.id })
    .from(portalGrant)
    .where(and(eq(portalGrant.organizationId, orgId), eq(portalGrant.contactId, contactId)))
  if (grants.length === 0) return []
  const rows = await tx
    .select()
    .from(portalPasskey)
    .where(
      and(
        eq(portalPasskey.organizationId, orgId),
        inArray(
          portalPasskey.grantId,
          grants.map((grant) => grant.id),
        ),
      ),
    )
    .orderBy(desc(portalPasskey.createdAt))
    .limit(50)
  return rows.map(passkeyView)
}

/**
 * Revoca una credencial y las sesiones que abrió con ella (revocación
 * precisa por passkeyId). Idempotente.
 */
export async function revokePortalPasskey(
  tx: Db,
  orgId: string,
  actorUserId: string,
  credentialId: string,
): Promise<{ revoked: boolean }> {
  if (!UUID_RE.test(credentialId)) throw notFound("Passkey")
  const [cred] = await tx
    .select()
    .from(portalPasskey)
    .where(and(eq(portalPasskey.id, credentialId), eq(portalPasskey.organizationId, orgId)))
    .limit(1)
  if (!cred) throw notFound("Passkey")
  if (cred.revokedAt) return { revoked: true }
  const now = new Date()
  await tx
    .update(portalPasskey)
    .set({ revokedAt: now, revokedBy: actorUserId })
    .where(and(eq(portalPasskey.id, cred.id), eq(portalPasskey.organizationId, orgId)))
  const sessions = await tx
    .update(portalSession)
    .set({ revokedAt: now, revokedBy: actorUserId, updatedAt: now })
    .where(
      and(
        eq(portalSession.organizationId, orgId),
        eq(portalSession.passkeyId, cred.id),
        isNull(portalSession.revokedAt),
      ),
    )
    .returning({ id: portalSession.id })
  await auditPortal(tx, orgId, actorUserId, "portal.passkey_revoked", "portal_passkey", cred.id, {
    grantId: cred.grantId,
    sessions: sessions.length,
  })
  return { revoked: true }
}
