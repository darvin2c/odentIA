import type { Db } from "@odentia/db"
import { portalLink } from "@odentia/db/schema/portal"
import { channelConnection } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import {
  portalGrant,
  portalPasskey,
  portalPolicy,
  portalVerification,
  type PortalGrantStatus,
  type PortalVerifiedMethod,
} from "@odentia/db/schema/portal-access"
import type { PortalScope } from "@odentia/db/schema/portal"
import { and, eq, inArray, sql } from "drizzle-orm"
import { createHash } from "node:crypto"
import { ServiceError, validation } from "./errors.js"

/**
 * Portal: política por organización, grants persistentes y antifuerza bruta.
 * Sin dependencias de otros servicios (lo importan portal.ts y
 * portal-access.ts): este módulo nunca abre contexto ni envía mensajes.
 */

export interface PortalAllowedScope {
  appointments: boolean
  budgets: boolean
  account: boolean
  documents: boolean
}

export interface PortalPolicy {
  enabled: boolean
  requestsEnabled: boolean
  publicRequestsEnabled: boolean
  channelRequestsEnabled: boolean
  autoApproveVerified: boolean
  allowedConnectionIds: string[]
  linkTtlMinutes: number
  sessionTtlHours: number
  grantTtlDays: number | null
  allowedScope: PortalAllowedScope
  passkeysEnabled: boolean
  assistedRecoveryEnabled: boolean
  updatedAt: Date
}

export type PortalPolicyInput = Omit<PortalPolicy, "updatedAt">

export type PortalGrantRow = typeof portalGrant.$inferSelect

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const LINK_TTL_MINUTES_MAX = 43200
const SESSION_TTL_HOURS_MAX = 168
const MAX_PIN_ATTEMPTS = 10

function defaultPolicy(): PortalPolicy {
  return {
    enabled: false,
    requestsEnabled: true,
    publicRequestsEnabled: true,
    channelRequestsEnabled: true,
    autoApproveVerified: false,
    allowedConnectionIds: [],
    linkTtlMinutes: 4320,
    sessionTtlHours: 48,
    grantTtlDays: null,
    allowedScope: { appointments: true, budgets: true, account: true, documents: true },
    passkeysEnabled: true,
    assistedRecoveryEnabled: true,
    updatedAt: new Date(0),
  }
}

function toPolicy(row: typeof portalPolicy.$inferSelect): PortalPolicy {
  return {
    enabled: row.portalEnabled,
    requestsEnabled: row.requestsEnabled,
    publicRequestsEnabled: row.publicRequestsEnabled,
    channelRequestsEnabled: row.channelRequestsEnabled,
    autoApproveVerified: row.autoApproveVerified,
    allowedConnectionIds: [...row.allowedChannelIds],
    linkTtlMinutes: row.linkTtlMinutes,
    sessionTtlHours: row.sessionTtlHours,
    grantTtlDays: row.grantTtlDays,
    allowedScope: { ...row.allowedScope },
    passkeysEnabled: row.passkeysEnabled,
    assistedRecoveryEnabled: row.assistedRecoveryEnabled,
    updatedAt: row.updatedAt,
  }
}
/** Sin fila = portal deshabilitado (producción nueva exige configuración). */
export async function getPortalPolicy(tx: Db, orgId: string): Promise<PortalPolicy> {
  const [row] = await tx
    .select()
    .from(portalPolicy)
    .where(eq(portalPolicy.organizationId, orgId))
    .limit(1)
  if (!row) return defaultPolicy()
  return toPolicy(row)
}
function assertScopeFlags(value: unknown): PortalAllowedScope {
  if (!value || typeof value !== "object") throw validation("El alcance permitido es inválido")
  if (
    !("appointments" in value) ||
    !("budgets" in value) ||
    !("account" in value) ||
    !("documents" in value) ||
    typeof value.appointments !== "boolean" ||
    typeof value.budgets !== "boolean" ||
    typeof value.account !== "boolean" ||
    typeof value.documents !== "boolean"
  ) {
    throw validation("El alcance permitido es inválido")
  }
  return {
    appointments: value.appointments,
    budgets: value.budgets,
    account: value.account,
    documents: value.documents,
  }
}


export async function upsertPortalPolicy(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: PortalPolicyInput,
): Promise<PortalPolicy> {
  const allowedScope = assertScopeFlags(input.allowedScope)
  const linkTtlMinutes = Math.floor(input.linkTtlMinutes)
  if (!Number.isFinite(linkTtlMinutes) || linkTtlMinutes < 1 || linkTtlMinutes > LINK_TTL_MINUTES_MAX) {
    throw validation(`La vigencia del enlace debe estar entre 1 y ${LINK_TTL_MINUTES_MAX} minutos`)
  }
  const sessionTtlHours = Math.floor(input.sessionTtlHours)
  if (!Number.isFinite(sessionTtlHours) || sessionTtlHours < 1 || sessionTtlHours > SESSION_TTL_HOURS_MAX) {
    throw validation(`La vigencia de la sesión debe estar entre 1 y ${SESSION_TTL_HOURS_MAX} horas`)
  }
  const grantTtlDays =
    input.grantTtlDays === null || input.grantTtlDays === undefined ? null : Math.floor(input.grantTtlDays)
  if (grantTtlDays !== null && (!Number.isFinite(grantTtlDays) || grantTtlDays < 1 || grantTtlDays > 3650)) {
    throw validation("La vigencia del grant debe estar entre 1 y 3650 días o vacía")
  }
  const allowedConnectionIds = [...new Set((input.allowedConnectionIds ?? []).filter((id) => typeof id === "string"))]
  if (allowedConnectionIds.length > 50) throw validation("Demasiadas conexiones autorizadas (máximo 50)")
  for (const id of allowedConnectionIds) {
    if (!UUID_RE.test(id)) throw validation("Una conexión autorizada no es válida")
  }
  if (allowedConnectionIds.length > 0) {
    const found = await tx
      .select({ id: channelConnection.id, status: channelConnection.status })
      .from(channelConnection)
      .where(
        and(
          eq(channelConnection.organizationId, orgId),
          inArray(channelConnection.id, allowedConnectionIds),
        ),
      )
    const active = new Set(
      found.filter((row) => row.status === "active").map((row) => row.id),
    )
    const invalid = allowedConnectionIds.filter((id) => !active.has(id))
    if (invalid.length > 0) {
      throw validation("Una conexión autorizada no existe o no está activa en esta organización")
    }
  }
  const [row] = await tx
    .insert(portalPolicy)
    .values({
      organizationId: orgId,
      portalEnabled: input.enabled,
      requestsEnabled: input.requestsEnabled,
      publicRequestsEnabled: input.publicRequestsEnabled,
      channelRequestsEnabled: input.channelRequestsEnabled,
      autoApproveVerified: input.autoApproveVerified,
      allowedChannelIds: allowedConnectionIds,
      linkTtlMinutes,
      sessionTtlHours,
      grantTtlDays,
      allowedScope,
      passkeysEnabled: input.passkeysEnabled,
      assistedRecoveryEnabled: input.assistedRecoveryEnabled,
      updatedBy: actorUserId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: portalPolicy.organizationId,
      set: {
        portalEnabled: input.enabled,
        requestsEnabled: input.requestsEnabled,
        publicRequestsEnabled: input.publicRequestsEnabled,
        channelRequestsEnabled: input.channelRequestsEnabled,
        autoApproveVerified: input.autoApproveVerified,
        allowedChannelIds: allowedConnectionIds,
        linkTtlMinutes,
        sessionTtlHours,
        grantTtlDays,
        allowedScope,
        passkeysEnabled: input.passkeysEnabled,
        assistedRecoveryEnabled: input.assistedRecoveryEnabled,
        updatedBy: actorUserId,
        updatedAt: new Date(),
      },
    })
    .returning()
  if (!row) throw new Error("No se pudo guardar la política del portal")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "portal.policy_updated",
    entity: "portal_policy",
    entityId: orgId,
    metadata: { enabled: input.enabled, requestsEnabled: input.requestsEnabled },
  })
  return toPolicy(row)
}

export function portalDisabled(): ServiceError {
  return new ServiceError("PORTAL_DISABLED", 404, "El portal no está habilitado en Configuración")
}

/** El grant está activo y vigente (no revocado ni caducado). */
export function isGrantUsable(grant: PortalGrantRow, now = Date.now()): boolean {
  if (grant.status !== "activo" || grant.revokedAt) return false
  if (grant.expiresAt && grant.expiresAt.getTime() <= now) return false
  return true
}

export async function findActivePortalGrant(
  tx: Db,
  orgId: string,
  patientId: string,
  contactId: string,
): Promise<PortalGrantRow | null> {
  const [grant] = await tx
    .select()
    .from(portalGrant)
    .where(
      and(
        eq(portalGrant.organizationId, orgId),
        eq(portalGrant.patientId, patientId),
        eq(portalGrant.contactId, contactId),
        eq(portalGrant.status, "activo"),
      ),
    )
    .limit(1)
  if (!grant || !isGrantUsable(grant)) return null
  return grant
}

/**
 * Exige grant activo y vigente. Sin grant (o revocado/caducado) el acceso
 * equivale a revocado: el intercambio y cada lectura fallan aunque el vínculo
 * representante↔paciente siga existiendo.
 */
export async function requireActivePortalGrant(
  tx: Db,
  orgId: string,
  patientId: string,
  contactId: string,
): Promise<PortalGrantRow> {
  const grant = await findActivePortalGrant(tx, orgId, patientId, contactId)
  if (!grant) {
    throw new ServiceError("PORTAL_REVOKED", 409, "Este acceso fue revocado; pide uno nuevo en recepción")
  }
  return grant
}

function assertVerifiedMethod(method: unknown): PortalVerifiedMethod {
  if (method === "presencial_documento" || method === "representacion_verificada") return method
  throw validation("El método de verificación debe ser presencial_documento o representacion_verificada")
}

/**
 * Crea (o reutiliza) el grant verificado del par. La verificación es siempre
 * un acto explícito del staff con método del enum: el canje del PIN jamás
 * crea grants (los enlaces anteriores al corte se invalidaron en migración).
 * Si el grant ya existe y el alcance difiere, lo actualiza con auditoría.
 */
export async function ensurePortalGrant(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: {
    patientId: string
    contactId: string
    scope: PortalScope
    verifiedMethod: string
    evidenceNote?: string | null
    requestId?: string | null
    audit: (action: string, entityId: string, metadata: Record<string, unknown>) => Promise<void>
  },
): Promise<{ grant: PortalGrantRow; created: boolean }> {
  const verifiedMethod = assertVerifiedMethod(input.verifiedMethod)
  const policy = await getPortalPolicy(tx, orgId)
  const existing = await findActivePortalGrant(tx, orgId, input.patientId, input.contactId)
  if (existing) {
    if (JSON.stringify(existing.scope) === JSON.stringify(input.scope)) {
      return { grant: existing, created: false }
    }
    const [updated] = await tx
      .update(portalGrant)
      .set({ scope: input.scope, updatedAt: new Date() })
      .where(and(eq(portalGrant.id, existing.id), eq(portalGrant.organizationId, orgId)))
      .returning()
    if (!updated) throw new Error("No se pudo actualizar el grant del portal")
    await input.audit("portal.grant_scope_updated", updated.id, {
      patientId: input.patientId,
      contactId: input.contactId,
      scope: input.scope,
    })
    return { grant: updated, created: false }
  }
  const now = new Date()
  const [grant] = await tx
    .insert(portalGrant)
    .values({
      organizationId: orgId,
      patientId: input.patientId,
      contactId: input.contactId,
      scope: input.scope,
      status: "activo",
      verifiedMethod,
      verifiedBy: actorUserId,
      verifiedAt: now,
      expiresAt: policy.grantTtlDays === null ? null : new Date(now.getTime() + policy.grantTtlDays * 86_400_000),
      createdBy: actorUserId,
    })
    .returning()
  if (!grant) throw new Error("No se pudo crear el grant del portal")
  await tx.insert(portalVerification).values({
    organizationId: orgId,
    patientId: input.patientId,
    contactId: input.contactId,
    grantId: grant.id,
    requestId: input.requestId ?? null,
    method: verifiedMethod,
    verifiedBy: actorUserId,
    evidenceNote: input.evidenceNote?.trim()?.slice(0, 500) || null,
  })
  await input.audit("portal.grant_created", grant.id, {
    patientId: input.patientId,
    contactId: input.contactId,
    verifiedMethod,
    requestId: input.requestId ?? null,
  })
  return { grant, created: true }
}

/** ¿El par tiene verificación previa registrada? (modo verificado-automático). */
export async function hasPriorVerification(
  tx: Db,
  orgId: string,
  patientId: string,
  contactId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: portalVerification.id })
    .from(portalVerification)
    .where(
      and(
        eq(portalVerification.organizationId, orgId),
        eq(portalVerification.patientId, patientId),
        eq(portalVerification.contactId, contactId),
      ),
    )
    .limit(1)
  return !!row
}
/**
 * Registra un PIN fallido con SQL atómico (carrera-seguro). Se llama en una
 * transacción NUEVA después del rollback del canje: la API captura
 * PORTAL_PIN_INVALID y luego invoca con el token crudo del request (nunca el
 * id interno). Solo cuenta enlaces pendientes; el bloqueo a los 10 intentos
 * revoca el enlace en la misma sentencia.
 */
export async function recordPortalPinFailure(
  tx: Db,
  orgId: string,
  rawToken: string,
): Promise<{ attempts: number; locked: boolean }> {
  if (typeof rawToken !== "string" || !LINK_TOKEN_RE.test(rawToken)) {
    return { attempts: 0, locked: false }
  }
  const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex")
  const [row] = await tx
    .update(portalLink)
    .set({
      failedAttempts: sql`${portalLink.failedAttempts} + 1`,
      status: sql<string>`CASE WHEN ${portalLink.failedAttempts} + 1 >= ${MAX_PIN_ATTEMPTS} THEN 'revocado' ELSE ${portalLink.status} END`,
      revokedAt: sql<Date | null>`CASE WHEN ${portalLink.failedAttempts} + 1 >= ${MAX_PIN_ATTEMPTS} AND ${portalLink.revokedAt} IS NULL THEN now() ELSE ${portalLink.revokedAt} END`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(portalLink.organizationId, orgId),
        eq(portalLink.tokenHash, tokenHash),
        eq(portalLink.status, "pendiente"),
      ),
    )
    .returning({ attempts: portalLink.failedAttempts, status: portalLink.status })
  if (!row) return { attempts: 0, locked: false }
  return { attempts: row.attempts, locked: row.status === "revocado" }
}

export type { PortalGrantStatus }
