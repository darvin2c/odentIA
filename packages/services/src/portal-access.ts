import type { Db } from "@odentia/db"
import { patient, patientContact } from "@odentia/db/schema/clinical"
import { documentText } from "@odentia/clinical"
import { channelConnection, contact, conversation, crmTask, } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { portalAccessLog, portalLink, portalSession } from "@odentia/db/schema/portal"
import {
  portalChallenge,
  portalGrant,
  portalPasskey,
  type PortalGrantStatus,
} from "@odentia/db/schema/portal-access"
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { createHash, randomBytes } from "node:crypto"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import {
  ensurePortalGrant,
  getPortalPolicy,
  isGrantUsable,
  PORTAL_FIXED,
  portalDisabled,
  requireActivePortalGrant,
  type PortalGrantRow,
} from "./portal-policy.js"
import {
  assertScope,
  assertShareRights,
  issuePortalActivationQr,
  issuePortalLink,
  requireActiveGrant,
  toSessionView,
  type IssuePortalLinkInput,
  type PortalContext,
  type PortalSessionView,
  type PortalShareRights,
} from "./portal.js"
import { contactDecides } from "./responsibilities.js"
import { createTask, settleTask } from "./tasks.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"

/**
 * Portal del paciente: dar acceso en un paso, grants persistentes y passkeys
 * WebAuthn (decisión 9 de la fase 3, ADR 0037). No hay solicitudes: pedir el
 * portal es un pedido más, que el agente deja en «Te espera» y atiende una
 * persona del equipo (`requestPortalReentry`).
 *
 * Invariantes de acceso:
 * - La coincidencia de teléfono NUNCA verifica identidad: no otorga, aprueba
 *   ni autocompleta nada. Tener el chat de alguien no prueba que sea esa persona.
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

const CHALLENGE_TTL_MINUTES = 5
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
    .select({ displayName: patientPerson.displayName })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
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

function passkeyView(row: typeof portalPasskey.$inferSelect): PortalPasskeyInfo {
  return {
    id: row.id,
    nickname: row.nickname,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  }
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

export interface CreatePortalGrantInput {
  patientId: string
  contactId: string
  relationship?: "self" | "guardian" | "family" | "other"
  scope: IssuePortalLinkInput["scope"]
  verifiedMethod: string
  evidenceNote?: string | null
}

/**
 * Grant directo del staff (activación en persona). Crea el vínculo si falta;
 * exige método del enum. La evidencia la escribe el sistema (qué documento vio).
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
  const evidenceNote = input.evidenceNote?.trim()?.slice(0, 500) || null
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
      .select({ isActive: patientPerson.isActive })
      .from(patient)
      .innerJoin(patientPerson, joinPatientPerson(patientPerson))
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
  const ttl = opts?.sessionTtlHours ?? PORTAL_FIXED.sessionTtlHours
  const bounded = Math.max(1, Math.min(Math.floor(ttl), PORTAL_FIXED.sessionTtlHours))
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
  if (!policy.enabled) throw portalDisabled()
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
  if (!policy.enabled) throw portalDisabled()
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
    challenge?.type !== "registro" ||
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
  if (!policy.enabled) throw portalDisabled()
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
  if (!policy.enabled) throw portalDisabled()
  if (!response || typeof response !== "object") throw validation("Respuesta de passkey inválida")
  const [challenge] = await tx
    .select()
    .from(portalChallenge)
    .where(and(eq(portalChallenge.id, challengeId), eq(portalChallenge.organizationId, orgId)))
    .for("update")
    .limit(1)
  if (challenge?.type !== "autenticacion" || challenge.usedAt) {
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
  const bounded = Math.max(1, Math.min(Math.floor(opts?.sessionTtlHours ?? PORTAL_FIXED.sessionTtlHours), PORTAL_FIXED.sessionTtlHours))
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

// ------------------------------------------------- el portal en un paso ---

/** «4•••••04»: el documento a la vista sin decirlo entero. */
function maskedDocument(docNumber: string): string {
  const clean = docNumber.trim()
  if (clean.length <= 3) return "•".repeat(clean.length)
  return `${clean.slice(0, 1)}${"•".repeat(Math.max(clean.length - 3, 1))}${clean.slice(-2)}`
}

export interface PortalAccessCandidate {
  contactId: string
  name: string
  /** La propia persona o su representante legal (si es menor). */
  relation: "self" | "representante"
  /**
   * Lo que recepción comprueba en persona: el tipo de su documento y el número
   * enmascarado («DNI 4•••••04»). Nulo si su ficha no tiene documento.
   */
  document: string | null
  /** Escribió por WhatsApp en las últimas 24 horas: el enlace puede ir por ahí. */
  whatsappReady: boolean
}

export interface PortalAccessRow {
  grantId: string
  contactId: string
  name: string
  relation: "self" | "representante"
  scope: PortalGrantRow["scope"]
  /** Guardó su acceso (llave) en algún teléfono. */
  saved: boolean
  /** La última vez que entró; nula si aún no entra. */
  lastEntryAt: Date | null
  /** Pidió volver a entrar y espera un enlace nuevo. */
  reentryRequested: boolean
}

export interface PortalAccessSummary {
  /** El portal está encendido en Configuración. */
  enabled: boolean
  /** Lo que la clínica deja ver (Configuración). */
  allowedScope: { appointments: boolean; budgets: boolean; account: boolean; documents: boolean }
  /** Una sola fila: quién entra, qué ve y su última entrada. */
  access: PortalAccessRow[]
  /** A quién se le puede dar acceso: la persona si es mayor de edad, o su representante legal. */
  candidates: PortalAccessCandidate[]
}

async function whatsappReady(tx: Db, orgId: string, contactId: string): Promise<{ conversationId: string } | null> {
  const [thread] = await tx
    .select({ id: conversation.id, lastInboundAt: conversation.lastInboundAt })
    .from(conversation)
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(
      and(
        eq(conversation.organizationId, orgId),
        eq(conversation.contactId, contactId),
        eq(channelConnection.channel, "whatsapp"),
        eq(channelConnection.status, "active"),
      ),
    )
    .orderBy(desc(conversation.lastInboundAt))
    .limit(1)
  if (!thread?.lastInboundAt || Date.now() - thread.lastInboundAt.getTime() > 24 * 3600_000) return null
  return { conversationId: thread.id }
}

/** Quién puede entrar al portal de este paciente: él mismo si es mayor de edad, si no su representante legal vigente. */
async function portalCandidates(tx: Db, orgId: string, patientId: string): Promise<PortalAccessCandidate[]> {
  await requirePatient(tx, orgId, patientId)
  const rows = await tx
    .select({
      contactId: contact.id,
      name: contact.displayName,
      docType: contact.docType,
      docNumber: contact.docNumber,
      relationship: patientContact.relationship,
      isActive: contact.isActive,
    })
    .from(patientContact)
    .innerJoin(contact, and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, orgId)))
    .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId)))
  const candidates: PortalAccessCandidate[] = []
  for (const row of rows) {
    if (!row.isActive) continue
    // La misma regla que vuelve a comprobar cada uso del portal (`requireActiveGrant`).
    if (!(await contactDecides(tx, orgId, patientId, row.contactId))) continue
    const relation: "self" | "representante" = row.relationship === "self" ? "self" : "representante"
    candidates.push({
      contactId: row.contactId,
      name: row.name,
      relation,
      document: row.docNumber ? `${documentText(row.docType, "").trim() || "Documento"} ${maskedDocument(row.docNumber)}` : null,
      whatsappReady: !!(await whatsappReady(tx, orgId, row.contactId)),
    })
  }
  return candidates.sort((a, b) => (a.relation === b.relation ? a.name.localeCompare(b.name, "es") : a.relation === "self" ? -1 : 1))
}

/** La fila de acceso al portal de la página de la persona (Datos › Acceso al portal). */
export async function getPortalAccessSummary(tx: Db, orgId: string, patientId: string): Promise<PortalAccessSummary> {
  const policy = await getPortalPolicy(tx, orgId)
  const grants = (
    await tx
      .select()
      .from(portalGrant)
      .where(and(eq(portalGrant.organizationId, orgId), eq(portalGrant.patientId, patientId), eq(portalGrant.status, "activo")))
      .orderBy(desc(portalGrant.createdAt))
  ).filter((grant) => isGrantUsable(grant))
  const access: PortalAccessRow[] = []
  for (const grant of grants) {
    const [person] = await tx
      .select({ name: contact.displayName })
      .from(contact)
      .where(and(eq(contact.organizationId, orgId), eq(contact.id, grant.contactId)))
      .limit(1)
    const [own] = await tx
      .select({ relationship: patientContact.relationship })
      .from(patientContact)
      .where(
        and(
          eq(patientContact.organizationId, orgId),
          eq(patientContact.patientId, patientId),
          eq(patientContact.contactId, grant.contactId),
        ),
      )
      .limit(1)
    const [saved] = await tx
      .select({ id: portalPasskey.id })
      .from(portalPasskey)
      .where(and(eq(portalPasskey.organizationId, orgId), eq(portalPasskey.grantId, grant.id), isNull(portalPasskey.revokedAt)))
      .limit(1)
    // «Entró el …»: el registro de accesos, leído donde sirve (decisión 9).
    const [entry] = await tx
      .select({ at: portalSession.createdAt })
      .from(portalSession)
      .where(and(eq(portalSession.organizationId, orgId), eq(portalSession.grantId, grant.id)))
      .orderBy(desc(portalSession.createdAt))
      .limit(1)
    const [reentry] = await tx
      .select({ id: crmTask.id })
      .from(crmTask)
      .where(
        and(
          eq(crmTask.organizationId, orgId),
          eq(crmTask.kind, "volver_al_portal"),
          eq(crmTask.patientId, patientId),
          eq(crmTask.contactId, grant.contactId),
          eq(crmTask.status, "open"),
        ),
      )
      .limit(1)
    access.push({
      grantId: grant.id,
      contactId: grant.contactId,
      name: person?.name ?? "",
      relation: own?.relationship === "self" ? "self" : "representante",
      scope: grant.scope,
      saved: !!saved,
      lastEntryAt: entry?.at ?? null,
      reentryRequested: !!reentry,
    })
  }
  return {
    enabled: policy.enabled,
    allowedScope: policy.allowedScope,
    access,
    candidates: await portalCandidates(tx, orgId, patientId),
  }
}

export interface GivePortalAccessInput {
  /** ¿Quién entra? La persona o su representante legal. */
  contactId: string
  /** ¿Qué verá? */
  scope: { appointments?: boolean; budgets?: boolean; account?: boolean; documentIds?: string[] }
  /** «Comprobé su identidad: vi su DNI 4•••••04». */
  identityChecked: boolean
  /** ¿Cómo le llega? Está aquí (QR) o por su WhatsApp. */
  delivery: "qr" | "whatsapp"
}

export interface PortalAccessGiven {
  grantId: string
  /** Para el QR, una sola vez. */
  activationUrlOnce: string | null
  /** El código de 6 dígitos, que se le dice en persona o por teléfono: nunca va con el enlace. */
  pinOnce: string
  /** A quién se le envió el enlace por WhatsApp. */
  sentTo: string | null
}

async function deliverPortalAccess(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: { patientId: string; contactId: string; scope: GivePortalAccessInput["scope"]; delivery: "qr" | "whatsapp" },
  deliver: { linkUrl: (rawLinkToken: string) => string } & PortalShareRights,
): Promise<{ activationUrlOnce: string | null; pinOnce: string; sentTo: string | null }> {
  if (input.delivery === "qr") {
    const issued = await issuePortalActivationQr(tx, orgId, actorUserId, {
      patientId: input.patientId,
      contactId: input.contactId,
      scope: input.scope,
    })
    return { activationUrlOnce: deliver.linkUrl(issued.rawTokenOnce), pinOnce: issued.pinOnce, sentTo: null }
  }
  const ready = await whatsappReady(tx, orgId, input.contactId)
  if (!ready) {
    const message =
      "No escribió por WhatsApp en las últimas 24 horas: dale acceso con el QR o pídele que escriba primero"
    throw new ServiceError("PORTAL_NO_WINDOW", 409, message, { delivery: message })
  }
  const issued = await issuePortalLink(
    tx,
    orgId,
    actorUserId,
    { patientId: input.patientId, contactId: input.contactId, conversationId: ready.conversationId, scope: input.scope },
    deliver,
  )
  if (!issued.pinOnce) throw new Error("No se pudo emitir el código")
  return { activationUrlOnce: null, pinOnce: issued.pinOnce, sentTo: issued.link.contactName }
}

/**
 * «Dar acceso al portal» en un paso (decisión 9): quién entra, qué verá, la
 * comprobación en persona con su documento y cómo le llega, en una sola
 * transacción. El grant se crea con el método que corresponde (su documento,
 * o la representación de un menor), el enlace vale 3 días y el código de 6
 * dígitos se le dice aparte. Recepción puede dar acceso a los presupuestos.
 */
export async function givePortalAccess(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: GivePortalAccessInput,
  deliver: { linkUrl: (rawLinkToken: string) => string } & PortalShareRights,
): Promise<PortalAccessGiven> {
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled) throw portalDisabled()
  const candidate = (await portalCandidates(tx, orgId, patientId)).find((item) => item.contactId === input.contactId)
  if (!candidate) {
    throw invalidField("contactId", "Entra la propia persona si es mayor de edad, o su representante legal si es menor")
  }
  if (!candidate.document) throw invalidField("contactId", "Primero completa su documento")
  if (input.identityChecked !== true)
    throw invalidField("identityChecked", "Marca que comprobaste su identidad con su documento")
  const scope = await assertScope(tx, orgId, patientId, input.scope)
  assertShareRights(scope, deliver)
  const grant = await createPortalGrant(tx, orgId, actorUserId, {
    patientId,
    contactId: input.contactId,
    scope: input.scope,
    verifiedMethod: candidate.relation === "self" ? "presencial_documento" : "representacion_verificada",
    // El tipo de documento que vio, sin su número.
    evidenceNote: `Vio su ${candidate.document.split(" ")[0] ?? "documento"} en persona`,
  })
  const delivered = await deliverPortalAccess(tx, orgId, actorUserId, { patientId, contactId: input.contactId, scope: input.scope, delivery: input.delivery }, deliver)
  await auditPortal(tx, orgId, actorUserId, "portal.access_given", "portal_grant", grant.id, {
    patientId,
    contactId: input.contactId,
    delivery: input.delivery,
  })
  return { grantId: grant.id, ...delivered }
}

/** «Cambiar»: lo que verá. No vuelve a comprobar su identidad ni le envía nada. */
export async function changePortalAccess(
  tx: Db,
  orgId: string,
  actorUserId: string,
  grantId: string,
  input: { scope: GivePortalAccessInput["scope"] },
  rights: PortalShareRights,
): Promise<PortalGrant> {
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled) throw portalDisabled()
  const [grant] = await tx
    .select()
    .from(portalGrant)
    .where(and(eq(portalGrant.organizationId, orgId), eq(portalGrant.id, grantId)))
    .limit(1)
  if (!grant || !isGrantUsable(grant)) throw notFound("Acceso del portal")
  const scope = await assertScope(tx, orgId, grant.patientId, input.scope)
  assertShareRights(scope, rights)
  const ensured = await ensurePortalGrant(tx, orgId, actorUserId, {
    patientId: grant.patientId,
    contactId: grant.contactId,
    scope,
    verifiedMethod: grant.verifiedMethod,
    audit: (action, entityId, metadata) => auditPortal(tx, orgId, actorUserId, action, "portal_grant", entityId, metadata),
  })
  return grantView(tx, orgId, ensured.grant)
}

/**
 * «Enviar nuevo enlace» (volver a entrar, decisión 9): lo hace una persona del
 * equipo, sin volver a comprobar su identidad, para un acceso que sigue
 * vigente. El enlace sale por su WhatsApp o en QR, y el código se le dice
 * aparte: nunca juntos. Atiende el pedido que dejó el agente en «Te espera».
 */
export async function resendPortalAccess(
  tx: Db,
  orgId: string,
  actorUserId: string,
  grantId: string,
  input: { delivery: "qr" | "whatsapp" },
  deliver: { linkUrl: (rawLinkToken: string) => string } & PortalShareRights,
): Promise<PortalAccessGiven> {
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled) throw portalDisabled()
  const [grant] = await tx
    .select()
    .from(portalGrant)
    .where(and(eq(portalGrant.organizationId, orgId), eq(portalGrant.id, grantId)))
    .limit(1)
  if (!grant || !isGrantUsable(grant)) throw notFound("Acceso del portal")
  // Volver a entrar exige lo mismo que darle acceso: mayor de edad o su representante legal vigente.
  if (!(await contactDecides(tx, orgId, grant.patientId, grant.contactId))) {
    throw new ServiceError(
      "PORTAL_NOT_ALLOWED",
      409,
      "Ya no puede entrar al portal por este paciente: quita este acceso y, si corresponde, dale uno a quien decide por él",
    )
  }
  const scope = grant.scope
  const delivered = await deliverPortalAccess(
    tx,
    orgId,
    actorUserId,
    {
      patientId: grant.patientId,
      contactId: grant.contactId,
      scope: { appointments: scope.appointments, budgets: scope.budgets, account: scope.account, documentIds: scope.documents },
      delivery: input.delivery,
    },
    // El acceso ya existe: el enlace nuevo lleva lo mismo que ya veía.
    { linkUrl: deliver.linkUrl, canShareBudgets: true, canShareAccount: true, canShareDocuments: true },
  )
  const pending = await tx
    .select({ id: crmTask.id })
    .from(crmTask)
    .where(
      and(
        eq(crmTask.organizationId, orgId),
        eq(crmTask.kind, "volver_al_portal"),
        eq(crmTask.patientId, grant.patientId),
        eq(crmTask.contactId, grant.contactId),
        eq(crmTask.status, "open"),
      ),
    )
  for (const task of pending) await settleTask(tx, orgId, task.id, "le enviaron un enlace nuevo al portal")
  await auditPortal(tx, orgId, actorUserId, "portal.access_resent", "portal_grant", grant.id, {
    patientId: grant.patientId,
    contactId: grant.contactId,
    delivery: input.delivery,
  })
  return { grantId: grant.id, ...delivered }
}

/**
 * Pedir volver a entrar al portal por el chat (decisión 9): el agente lo
 * entiende y lo deja en «Te espera» de recepción, con «Enviar nuevo enlace».
 * Nunca envía el enlace ni el código: tener el chat de alguien no prueba que
 * sea esa persona. Sin acceso vigente no hay nada que reenviar: el acceso se
 * da en la clínica, con su documento.
 */
export async function requestPortalReentry(
  tx: Db,
  orgId: string,
  input: { contactId: string; conversationId: string },
): Promise<{ status: "pedido" | "sin_acceso" | "portal_apagado"; names: string[] }> {
  const policy = await getPortalPolicy(tx, orgId)
  if (!policy.enabled) return { status: "portal_apagado", names: [] }
  const grants = (
    await tx
      .select()
      .from(portalGrant)
      .where(and(eq(portalGrant.organizationId, orgId), eq(portalGrant.contactId, input.contactId), eq(portalGrant.status, "activo")))
  ).filter((grant) => isGrantUsable(grant))
  if (grants.length === 0) return { status: "sin_acceso", names: [] }
  const [person] = await tx
    .select({ name: contact.displayName })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, input.contactId)))
    .limit(1)
  const day = new Date().toISOString().slice(0, 10)
  const names: string[] = []
  for (const grant of grants) {
    const [subject] = await tx
      .select({ name: patientPerson.displayName })
      .from(patient)
      .innerJoin(patientPerson, joinPatientPerson(patientPerson))
      .where(and(eq(patient.organizationId, orgId), eq(patient.id, grant.patientId)))
      .limit(1)
    names.push(subject?.name ?? "")
    await createTask(tx, orgId, {
      title: `${person?.name ?? "Una persona"} quiere volver a entrar al portal`,
      contactId: input.contactId,
      conversationId: input.conversationId,
      patientId: grant.patientId,
      area: "recepcion",
      createdBy: "agent",
      kind: "volver_al_portal",
      reason: "Lo pidió por el chat. Su acceso sigue vigente: envíale un enlace nuevo y dile el código en persona o por teléfono.",
      idempotencyKey: `volver-al-portal:${grant.id}:${day}`,
    })
  }
  return { status: "pedido", names }
}
