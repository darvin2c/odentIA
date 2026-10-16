import type { Db } from "@odentia/db"
import { portalLink } from "@odentia/db/schema/portal"
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
  allowedScope: PortalAllowedScope
  updatedAt: Date
}

export type PortalPolicyInput = Omit<PortalPolicy, "updatedAt">

export type PortalGrantRow = typeof portalGrant.$inferSelect

/**
 * Valores fijos del portal (decisión 9, ADR 0037), en lugar de las «Opciones
 * avanzadas» de antes: el enlace de la primera entrada vale 3 días, la sesión
 * dura 48 horas y, si el teléfono no puede guardar la llave, se recuerda 30
 * días. El acceso no vence: dura hasta «Quitar acceso». La llave guardada y
 * el código de 6 dígitos valen siempre.
 */
export const PORTAL_FIXED = {
  linkTtlHours: 72,
  sessionTtlHours: 48,
  rememberDays: 30,
} as const

const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const MAX_PIN_ATTEMPTS = 10

function defaultPolicy(): PortalPolicy {
  return {
    enabled: false,
    allowedScope: { appointments: true, budgets: true, account: true, documents: true },
    updatedAt: new Date(0),
  }
}

function toPolicy(row: typeof portalPolicy.$inferSelect): PortalPolicy {
  return {
    enabled: row.portalEnabled,
    allowedScope: { ...row.allowedScope },
    updatedAt: row.updatedAt,
  }
}
/** Sin fila = portal apagado: está apagado por defecto. */
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

/** Encender o apagar el portal y decir lo que el paciente puede ver: lo único que se configura. */
export async function upsertPortalPolicy(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: PortalPolicyInput,
): Promise<PortalPolicy> {
  const allowedScope = assertScopeFlags(input.allowedScope)
  const [row] = await tx
    .insert(portalPolicy)
    .values({
      organizationId: orgId,
      portalEnabled: input.enabled,
      allowedScope,
      updatedBy: actorUserId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: portalPolicy.organizationId,
      set: {
        portalEnabled: input.enabled,
        allowedScope,
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
    metadata: { enabled: input.enabled },
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
    audit: (action: string, entityId: string, metadata: Record<string, unknown>) => Promise<void>
  },
): Promise<{ grant: PortalGrantRow; created: boolean }> {
  const verifiedMethod = assertVerifiedMethod(input.verifiedMethod)
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
      // El acceso no vence: dura hasta «Quitar acceso».
      expiresAt: null,
      createdBy: actorUserId,
    })
    .returning()
  if (!grant) throw new Error("No se pudo crear el grant del portal")
  await tx.insert(portalVerification).values({
    organizationId: orgId,
    patientId: input.patientId,
    contactId: input.contactId,
    grantId: grant.id,
    method: verifiedMethod,
    verifiedBy: actorUserId,
    evidenceNote: input.evidenceNote?.trim()?.slice(0, 500) || null,
  })
  await input.audit("portal.grant_created", grant.id, {
    patientId: input.patientId,
    contactId: input.contactId,
    verifiedMethod,
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
