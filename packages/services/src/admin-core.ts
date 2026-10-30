/**
 * Núcleo de administración: personal interno, segundo factor vinculado a
 * sesión, invitaciones y auditoría append-only.
 *
 * El staff es independiente de `member`/OrgRole: no hereda membresía de
 * ningún tenant y ningún cliente accede a endpoints globales. Toda función
 * recibe el `ownerDb` (o un `tx` ya abierto sobre él) DESPUÉS del guard; jamás
 * se entrega la conexión owner al cliente.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { ADMIN_ROLES, type AdminRole, isAdminRole } from "@odentia/auth/admin-permissions"
import type { Db } from "@odentia/db"
import {
  adminAudit,
  adminInvitation,
  adminSessionVerification,
  adminStaff,
  adminTrustedDevice,
  twoFactor,
} from "@odentia/db/schema/admin-core"
import { account as authAccount, session, user } from "@odentia/db/schema/auth"
import { generateRandomString, type SecretConfig, symmetricEncrypt } from "better-auth/crypto"
import { and, count, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { invalidField, ServiceError } from "./errors.js"

/** Actor interno verificado por el guard (sesión + staff activo + MFA). */
export interface AdminActor {
  userId: string
  role: AdminRole
}
export type { AdminRole }
export { ADMIN_ROLES, isAdminRole }

/** Entrada de `writeAdminAudit` (contrato de auditoría administrativa). */
export interface AdminAuditInput {
  action: string
  organizationId?: string | null
  entityId?: string | null
  metadata?: Record<string, unknown>
}

/** Sesión mínima para aceptar invitaciones (identidad verificada). */
export interface VerifiedIdentity {
  id: string
  email: string
  emailVerified: boolean
}

/** Fila de staff con identidad para la UI de equipo. */
export interface AdminStaffRow {
  userId: string
  name: string
  email: string
  role: AdminRole
  active: boolean
  createdAt: Date
}

/** Invitación pendiente para la UI de equipo. */
export interface AdminInvitationRow {
  id: string
  email: string
  role: AdminRole
  status: string
  expiresAt: Date
  createdAt: Date
}

/** Vinculación MFA↔sesión viva. */
export interface AdminSessionBinding {
  id: string
  userId: string
  sessionId: string
  factorId: string
  method: "totp" | "recovery" | "device"
  /** País de la visita al verificar; otro país deja de contar (ADR 0090). */
  country: string | null
  verifiedAt: Date
  expiresAt: Date
}

/** El segundo factor rige 48 h por sesión (para no pedirlo a cada rato); la recuperación solo 30 min. */
export const ADMIN_MFA_SESSION_TTL_MS = 48 * 60 * 60 * 1000
export const ADMIN_RECOVERY_SESSION_TTL_MS = 30 * 60 * 1000
/** La invitación caduca a los 7 días; el primer enrolamiento exige sesión fresca (10 min) si no hay contraseña. */
export const ADMIN_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const ADMIN_FRESH_SESSION_MS = 10 * 60 * 1000
/** Ventana y tope de intentos de código MFA (persistidos en auditoría, por usuario). */
export const ADMIN_MFA_ATTEMPT_WINDOW_MS = 15 * 60 * 1000
export const ADMIN_MFA_MAX_ATTEMPTS = 10
/** Ventana anti-replay del código (tolerancia TOTP ±1 paso + paso + sesgo). */
export const ADMIN_MFA_REPLAY_WINDOW_MS = 150 * 1000

function forbidden(message: string): ServiceError {
  return new ServiceError("FORBIDDEN", 403, message)
}

/**
 * Auditoría administrativa (contrato). Append-only: solo inserta. `actor`
 * nulo = acción de sistema/bootstrap (p. ej. `staff.bootstrap`), el servicio
 * registra `actorRole: 'system'` en ese caso.
 */
export async function writeAdminAudit(
  tx: Db,
  actor: AdminActor | null,
  input: AdminAuditInput,
): Promise<void> {
  const action = input.action.trim()
  if (action.length === 0 || action.length > 120)
    throw new ServiceError("VALIDATION", 400, "Acción de auditoría inválida")
  await tx.insert(adminAudit).values({
    actorUserId: actor?.userId ?? null,
    actorRole: actor?.role ?? "system",
    action,
    organizationId: input.organizationId ?? null,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? null,
  })
}

/** Normaliza correos para comparar/invitar (sin duplicados por mayúsculas). */
export function normalizeStaffEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * ¿Quedaría la organización sin ningún admin activo si `targetUserId`
 * pierde el rol admin (baja o degradación)? Último admin protegido.
 */
export function isLastActiveAdmin(
  staff: ReadonlyArray<{ userId: string; role: string; active: boolean }>,
  targetUserId: string,
): boolean {
  const target = staff.find((row) => row.userId === targetUserId)
  if (!target || target.role !== "admin" || !target.active) return false
  return !staff.some((row) => row.userId !== targetUserId && row.role === "admin" && row.active)
}

/** ¿Puede `identity` aceptar `invitation`? Identidad verificada del mismo correo, invitación vigente. */
export function canAcceptAdminInvitation(
  invitation: { status: string; email: string; expiresAt: Date },
  identity: VerifiedIdentity,
  now: Date,
): boolean {
  return (
    invitation.status === "pending" &&
    invitation.expiresAt.getTime() > now.getTime() &&
    identity.emailVerified &&
    normalizeStaffEmail(identity.email) === normalizeStaffEmail(invitation.email)
  )
}

/** ¿Sigue vigente la vinculación MFA↔sesión? Sin revocar y sin expirar. */
export function isSessionBindingLive(
  binding: { expiresAt: Date; revokedAt: Date | null } | undefined,
  now: Date,
): boolean {
  return !!binding && binding.revokedAt === null && binding.expiresAt.getTime() > now.getTime()
}

/** sha256 hex del token de invitación (el crudo solo se muestra al crear). */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

/** Compara el token presentado con el hash guardado en tiempo constante. */
export function matchesInviteTokenHash(token: string, tokenHash: string): boolean {
  const presented = Buffer.from(hashInviteToken(token), "utf8")
  const expected = Buffer.from(tokenHash, "utf8")
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

/** Lista el personal con identidad para la UI de equipo. */
export async function listAdminStaff(ownerDb: Db): Promise<AdminStaffRow[]> {
  const rows = await ownerDb
    .select({
      userId: adminStaff.userId,
      role: adminStaff.role,
      active: adminStaff.active,
      createdAt: adminStaff.createdAt,
      name: user.name,
      email: user.email,
    })
    .from(adminStaff)
    .innerJoin(user, eq(user.id, adminStaff.userId))
  return rows.map((row) => ({
    userId: row.userId,
    name: row.name,
    email: row.email,
    role: isAdminRole(row.role) ? row.role : "support",
    active: row.active,
    createdAt: row.createdAt,
  }))
}

/** Invitaciones pendientes (para reenviar/revocar desde equipo). */
export async function listPendingAdminInvitations(
  ownerDb: Db,
  now: Date,
): Promise<AdminInvitationRow[]> {
  const rows = await ownerDb
    .select()
    .from(adminInvitation)
    .where(and(eq(adminInvitation.status, "pending"), gt(adminInvitation.expiresAt, now)))
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: isAdminRole(row.role) ? row.role : "support",
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }))
}

/**
 * Invita personal. Solo `admin`. No autoeleva por dominio: invitación nominal
 * por correo que exige aceptación con identidad verificada. Envía el correo
 * con `notify` (enlace accionable); el token crudo solo vuelve cuando el
 * envío FALLÓ de forma conocida (fallback explícito para copiar): con envío
 * incierto o exitoso no se reintenta ni se expone (claim durable en
 * `deliveryStatus`, sin duplicados ambiguos).
 */
export interface AdminInvitationCreated {
  invitationId: string
  email: string
  role: AdminRole
  expiresAt: Date
  /** sent = correo confirmado; uncertain = sin confirmar (el enlace copiable lo cubre, reenvío humano explícito). */
  delivery: "sent" | "uncertain"
  /** Token crudo siempre (no es secreto de factor): el enlace de aceptación. */
  token: string
}

export async function inviteAdminStaff(
  ownerDb: Db,
  actor: AdminActor,
  input: { email: string; role: string },
  notify: (email: string, acceptUrl: string) => Promise<void>,
  acceptUrlFor: (token: string) => string,
): Promise<AdminInvitationCreated> {
  if (actor.role !== "admin") throw forbidden("Solo administración puede invitar personal")
  if (!isAdminRole(input.role)) throw invalidField("role", "Rol interno inválido")
  const email = normalizeStaffEmail(input.email)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw invalidField("email", "Correo inválido")
  const [existingUser] = await ownerDb
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1)
  if (existingUser) {
    const [existingStaff] = await ownerDb
      .select({ active: adminStaff.active })
      .from(adminStaff)
      .where(eq(adminStaff.userId, existingUser.id))
      .limit(1)
    if (existingStaff?.active)
      throw new ServiceError("ALREADY_STAFF", 409, "Esa cuenta ya es personal activo", {
        email: "Esa cuenta ya es personal activo",
      })
  }
  const token = randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + ADMIN_INVITATION_TTL_MS)
  const [created] = await ownerDb
    .insert(adminInvitation)
    .values({
      email,
      role: input.role,
      tokenHash: hashInviteToken(token),
      invitedBy: actor.userId,
      expiresAt,
    })
    .returning({ id: adminInvitation.id })
  const invitationId = created?.id ?? ""
  let delivery: "sent" | "uncertain" = "uncertain"
  try {
    await notify(email, acceptUrlFor(token))
    delivery = "sent"
  } catch {
    delivery = "uncertain"
  }
  await ownerDb
    .update(adminInvitation)
    .set({ deliveryStatus: delivery })
    .where(eq(adminInvitation.id, invitationId))
  await writeAdminAudit(ownerDb, actor, {
    action: "staff.invite",
    entityId: invitationId || null,
    metadata: { email, role: input.role, delivery },
  })
  return { invitationId, email, role: input.role, expiresAt, delivery, token }
}

/**
 * Reenvía una invitación pendiente: revoca la anterior y crea una nueva con
 * token nuevo (motivo auditable). Nunca repite el envío automáticamente.
 */
export async function resendAdminInvitation(
  ownerDb: Db,
  actor: AdminActor,
  invitationId: string,
  reason: string,
  notify: (email: string, acceptUrl: string) => Promise<void>,
  acceptUrlFor: (token: string) => string,
): Promise<AdminInvitationCreated> {
  if (actor.role !== "admin") throw forbidden("Solo administración gestiona invitaciones")
  if (reason.trim().length < 8) throw invalidField("reason", "El motivo es obligatorio (mínimo 8 caracteres)")
  const [invitation] = await ownerDb
    .select()
    .from(adminInvitation)
    .where(eq(adminInvitation.id, invitationId))
    .limit(1)
  if (!invitation) throw new ServiceError("NOT_FOUND", 404, "Invitación no encontrada")
  if (invitation.status !== "pending")
    throw new ServiceError("INVITATION_USED", 409, "La invitación ya fue usada")
  await ownerDb
    .update(adminInvitation)
    .set({ status: "revoked" })
    .where(eq(adminInvitation.id, invitation.id))
  await writeAdminAudit(ownerDb, actor, {
    action: "staff.invite.revoke",
    entityId: invitation.id,
    metadata: { reason: reason.trim().slice(0, 280), resend: true },
  })
  return inviteAdminStaff(
    ownerDb,
    actor,
    { email: invitation.email, role: invitation.role },
    notify,
    acceptUrlFor,
  )
}

/**
 * Acepta una invitación con identidad verificada. La invitación no crea
 * cuenta: el usuario existe, su correo coincide y está verificado.
 */
export async function acceptAdminInvitation(
  ownerDb: Db,
  identity: VerifiedIdentity,
  token: string,
): Promise<AdminActor> {
  const presentedHash = hashInviteToken(token.trim())
  const [invitation] = await ownerDb
    .select()
    .from(adminInvitation)
    .where(eq(adminInvitation.tokenHash, presentedHash))
    .limit(1)
  if (!invitation || !matchesInviteTokenHash(token.trim(), invitation.tokenHash)) {
    throw new ServiceError("NOT_FOUND", 404, "Invitación no válida")
  }
  const now = new Date()
  if (invitation.status !== "pending" || invitation.expiresAt.getTime() <= now.getTime()) {
    throw new ServiceError("INVITATION_EXPIRED", 404, "La invitación caducó o ya fue usada")
  }
  if (!canAcceptAdminInvitation(invitation, identity, now)) {
    throw forbidden("La invitación exige iniciar sesión con el correo invitado y verificado")
  }
  const role = isAdminRole(invitation.role) ? invitation.role : "support"
  const [existing] = await ownerDb
    .select({ active: adminStaff.active })
    .from(adminStaff)
    .where(eq(adminStaff.userId, identity.id))
    .limit(1)
  if (existing?.active)
    throw new ServiceError("ALREADY_STAFF", 409, "Esa cuenta ya es personal activo")
  if (existing) {
    await ownerDb
      .update(adminStaff)
      .set({ role, active: true })
      .where(eq(adminStaff.userId, identity.id))
  } else {
    await ownerDb.insert(adminStaff).values({ userId: identity.id, role, active: true })
  }
  await ownerDb
    .update(adminInvitation)
    .set({ status: "accepted", acceptedUserId: identity.id })
    .where(eq(adminInvitation.id, invitation.id))
  const actor: AdminActor = { userId: identity.id, role }
  await writeAdminAudit(ownerDb, actor, { action: "staff.accept", entityId: invitation.id })
  return actor
}

/** Revoca una invitación pendiente. Solo `admin`. */
export async function revokeAdminInvitation(
  ownerDb: Db,
  actor: AdminActor,
  invitationId: string,
): Promise<void> {
  if (actor.role !== "admin") throw forbidden("Solo administración gestiona invitaciones")
  const [invitation] = await ownerDb
    .select({ id: adminInvitation.id, status: adminInvitation.status })
    .from(adminInvitation)
    .where(eq(adminInvitation.id, invitationId))
    .limit(1)
  if (!invitation) throw new ServiceError("NOT_FOUND", 404, "Invitación no encontrada")
  if (invitation.status !== "pending")
    throw new ServiceError("INVITATION_USED", 409, "La invitación ya fue usada")
  await ownerDb
    .update(adminInvitation)
    .set({ status: "revoked" })
    .where(eq(adminInvitation.id, invitation.id))
  await writeAdminAudit(ownerDb, actor, { action: "staff.invite.revoke", entityId: invitation.id })
}


/**
 * Lock compartido para TODA mutación de membresía staff (degradar,
 * desactivar, bloqueo global, cierre de cuenta): una sola llave consultiva
 * global `admin_staff`. Toda escritura sobre `admin_staff` DEBE usar este
 * helper para que el invariante del último admin no se rompa entre
 * transacciones concurrentes.
 */
export async function withAdminStaffLock<T>(ownerDb: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return ownerDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('admin_staff'))`)
    return fn(tx as Db)
  })
}

/**
 * Lee el conjunto de admins activos BLOQUEADO (`FOR UPDATE`): serializa
 * degradaciones/bajas concurrentes para que dos admins no puedan eliminarse
 * mutuamente viendo cada uno al otro como respaldo.
 */
async function lockedActiveAdmins(
  tx: Db,
): Promise<Array<{ userId: string; role: string; active: boolean }>> {
  return tx
    .select({ userId: adminStaff.userId, role: adminStaff.role, active: adminStaff.active })
    .from(adminStaff)
    .where(and(eq(adminStaff.role, "admin"), eq(adminStaff.active, true)))
    .for("update")
}

/** Cambia el rol interno. Solo `admin`; sin auto-cambio; último admin protegido. */
export async function setAdminStaffRole(
  ownerDb: Db,
  actor: AdminActor,
  targetUserId: string,
  role: string,
): Promise<void> {
  if (actor.role !== "admin") throw forbidden("Solo administración cambia roles")
  if (actor.userId === targetUserId) throw forbidden("Tu rol solo lo cambia otro admin")
  if (!isAdminRole(role)) throw new ServiceError("VALIDATION", 400, "Rol interno inválido")
  await withAdminStaffLock(ownerDb, async (tx) => {
    const actorRow = await tx
      .select({ role: adminStaff.role, active: adminStaff.active })
      .from(adminStaff)
      .where(eq(adminStaff.userId, actor.userId))
      .limit(1)
    if (!actorRow[0] || actorRow[0].role !== "admin" || !actorRow[0].active) {
      throw forbidden("Tu acceso de administración ya no está vigente")
    }
    const [target] = await tx
      .select({ role: adminStaff.role, active: adminStaff.active })
      .from(adminStaff)
      .where(eq(adminStaff.userId, targetUserId))
      .limit(1)
    if (!target) throw new ServiceError("NOT_FOUND", 404, "Personal no encontrado")
    if (target.role === "admin" && role !== "admin") {
      const locked = await lockedActiveAdmins(tx)
      if (isLastActiveAdmin(locked, targetUserId)) {
        throw new ServiceError("LAST_ADMIN", 409, "No se puede degradar al último admin activo")
      }
    }
    await tx.update(adminStaff).set({ role }).where(eq(adminStaff.userId, targetUserId))
    await writeAdminAudit(tx, actor, {
      action: "staff.role",
      entityId: targetUserId,
      metadata: { from: target.role, to: role },
    })
  })
}

/**
 * Activa/desactiva personal. Solo `admin`, con motivo obligatorio; sin
 * auto-baja; el último admin activo no se desactiva.
 */
export async function setAdminStaffActive(
  ownerDb: Db,
  actor: AdminActor,
  targetUserId: string,
  active: boolean,
  reason: string,
): Promise<void> {
  if (actor.role !== "admin") throw forbidden("Solo administración cambia el estado del personal")
  if (actor.userId === targetUserId) throw forbidden("Tu estado solo lo cambia otro admin")
  if (reason.trim().length < 8) throw invalidField("reason", "El motivo es obligatorio (mínimo 8 caracteres)")
  await withAdminStaffLock(ownerDb, async (tx) => {
    const actorRow = await tx
      .select({ role: adminStaff.role, active: adminStaff.active })
      .from(adminStaff)
      .where(eq(adminStaff.userId, actor.userId))
      .limit(1)
    if (!actorRow[0] || actorRow[0].role !== "admin" || !actorRow[0].active) {
      throw forbidden("Tu acceso de administración ya no está vigente")
    }
    const [target] = await tx
      .select({ role: adminStaff.role, active: adminStaff.active })
      .from(adminStaff)
      .where(eq(adminStaff.userId, targetUserId))
      .limit(1)
    if (!target) throw new ServiceError("NOT_FOUND", 404, "Personal no encontrado")
    if (!active && target.role === "admin" && target.active) {
      const locked = await lockedActiveAdmins(tx)
      if (isLastActiveAdmin(locked, targetUserId)) {
        throw new ServiceError("LAST_ADMIN", 409, "No se puede desactivar al último admin activo")
      }
    }
    await tx.update(adminStaff).set({ active }).where(eq(adminStaff.userId, targetUserId))
    if (!active) {
      // La baja invalida sesiones reales: una cookie conservada no debe seguir operando.
      await tx.delete(session).where(eq(session.userId, targetUserId))
      await tx
        .update(adminSessionVerification)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(adminSessionVerification.userId, targetUserId),
            isNull(adminSessionVerification.revokedAt),
          ),
        )
    }
    await writeAdminAudit(tx, actor, {
      action: active ? "staff.reactivate" : "staff.deactivate",
      entityId: targetUserId,
      metadata: { reason: reason.trim().slice(0, 280) },
    })
  })
}

/** Id de la credencial TOTP confirmada (`two_factor` verificado) o nulo. Un enrolamiento abandonado (`verified:false`) NO cuenta como factor. */
export async function getStaffFactorId(ownerDb: Db, userId: string): Promise<string | null> {
  const [row] = await ownerDb
    .select({ id: twoFactor.id })
    .from(twoFactor)
    .where(and(eq(twoFactor.userId, userId), eq(twoFactor.verified, true)))
    .limit(1)
  return row?.id ?? null
}

/** ¿Tiene `userId` factor TOTP confirmado? (fuente: tabla `two_factor`). */
export async function hasStaffFactor(ownerDb: Db, userId: string): Promise<boolean> {
  return (await getStaffFactorId(ownerDb, userId)) !== null
}

/**
 * El código se pide al abrir la administración, no al entrar: el personal
 * entra a sus clínicas como cualquier persona. Better Auth pide el factor al
 * iniciar sesión a toda cuenta con `twoFactorEnabled`, y lo enciende al
 * confirmar el primer código; la administración lo apaga después. El factor
 * (`two_factor` verificado) sigue siendo el que vale para la administración.
 */
export async function keepStaffSignInWithoutFactor(ownerDb: Db, userId: string): Promise<void> {
  await ownerDb.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, userId))
}

/** Cantidad y forma de los códigos de respaldo: las de Better Auth (`xxxxx-xxxxx`). */
const BACKUP_CODE_COUNT = 10

/**
 * Códigos de respaldo nuevos para el factor confirmado, cifrados como los
 * guarda Better Auth (`storeBackupCodes: "encrypted"`): su verificación los
 * sigue leyendo. Better Auth no los regenera sin `twoFactorEnabled`, que el
 * personal no tiene (ver `keepStaffSignInWithoutFactor`). Quien llama ya probó
 * la contraseña.
 */
export async function regenerateStaffBackupCodes(
  ownerDb: Db,
  userId: string,
  secretConfig: string | SecretConfig,
): Promise<string[]> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const code = generateRandomString(10, "a-z", "0-9", "A-Z")
    return `${code.slice(0, 5)}-${code.slice(5)}`
  })
  const encrypted = await symmetricEncrypt({ key: secretConfig, data: JSON.stringify(codes) })
  const updated = await ownerDb
    .update(twoFactor)
    .set({ backupCodes: encrypted })
    .where(and(eq(twoFactor.userId, userId), eq(twoFactor.verified, true)))
    .returning({ id: twoFactor.id })
  if (updated.length === 0) throw new ServiceError("MFA_REQUIRED", 403, "Enrola tu segundo factor para continuar")
  return codes
}

/**
 * Limpia un enrolamiento abandonado (fila `verified:false`) para permitir el
 * reinicio bajo las mismas exigencias de reautenticación. Devuelve true si
 * había pendiente. Audita el reinicio.
 */
export async function clearPendingStaffFactor(ownerDb: Db, actor: AdminActor): Promise<boolean> {
  const pending = await ownerDb
    .delete(twoFactor)
    .where(and(eq(twoFactor.userId, actor.userId), eq(twoFactor.verified, false)))
    .returning({ id: twoFactor.id })
  if (pending.length === 0) return false
  await writeAdminAudit(ownerDb, actor, { action: "staff.mfa.enroll.restart" })
  return true
}

/**
 * Registra la prueba MFA superada, vinculada a la sesión que la presentó y a
 * la credencial que la superó (una fila viva por sesión; reemplaza la
 * anterior: sin reuso/replay ni reuso entre sesiones).
 */
export async function recordAdminSessionBinding(
  ownerDb: Db,
  input: {
    userId: string
    sessionId: string
    factorId: string
    method: "totp" | "recovery" | "device"
    ttlMs: number
    country?: string | null
  },
): Promise<AdminSessionBinding> {
  await ownerDb
    .delete(adminSessionVerification)
    .where(eq(adminSessionVerification.sessionId, input.sessionId))
  const expiresAt = new Date(Date.now() + input.ttlMs)
  const [created] = await ownerDb
    .insert(adminSessionVerification)
    .values({
      userId: input.userId,
      sessionId: input.sessionId,
      factorId: input.factorId,
      method: input.method,
      country: input.country ?? null,
      expiresAt,
    })
    .returning()
  if (!created) throw new ServiceError("MFA_BINDING", 500, "No se pudo registrar la verificación")
  return {
    id: created.id,
    userId: created.userId,
    sessionId: created.sessionId,
    factorId: created.factorId,
    method: bindingMethod(created.method),
    country: created.country,
    verifiedAt: created.verifiedAt,
    expiresAt: created.expiresAt,
  }
}

/**
 * Vinculación viva de la sesión (para el guard y `GET /session`). Exige la
 * prueba temporal Y la credencial aún vigente: si el factor se revocó o
 * cambió (`/two-factor/disable`, reset), la prueba previa muere aquí aunque
 * no haya expirado (limpia la fila huérfana).
 */
export async function getLiveSessionBinding(
  ownerDb: Db,
  sessionId: string,
  now: Date,
): Promise<AdminSessionBinding | null> {
  const [row] = await ownerDb
    .select()
    .from(adminSessionVerification)
    .where(
      and(
        eq(adminSessionVerification.sessionId, sessionId),
        isNull(adminSessionVerification.revokedAt),
        gt(adminSessionVerification.expiresAt, now),
      ),
    )
    .orderBy(desc(adminSessionVerification.verifiedAt))
    .limit(1)
  if (!row || !isSessionBindingLive(row, now)) return null
  const [factor] = await ownerDb
    .select({ id: twoFactor.id })
    .from(twoFactor)
    .where(and(eq(twoFactor.id, row.factorId), eq(twoFactor.userId, row.userId)))
    .limit(1)
  if (!factor) {
    await ownerDb.delete(adminSessionVerification).where(eq(adminSessionVerification.id, row.id))
    return null
  }
  return {
    id: row.id,
    userId: row.userId,
    sessionId: row.sessionId,
    factorId: row.factorId,
    method: bindingMethod(row.method),
    country: row.country,
    verifiedAt: row.verifiedAt,
    expiresAt: row.expiresAt,
  }
}

function bindingMethod(method: string): AdminSessionBinding["method"] {
  return method === "recovery" || method === "device" ? method : "totp"
}

/** Revoca todas las vinculaciones y los equipos reconocidos de un usuario (baja, reset o revocación de factor). */
export async function revokeStaffBindings(ownerDb: Db, userId: string): Promise<number> {
  const revoked = await ownerDb
    .update(adminSessionVerification)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(adminSessionVerification.userId, userId), isNull(adminSessionVerification.revokedAt)),
    )
    .returning({ id: adminSessionVerification.id })
  await ownerDb
    .update(adminTrustedDevice)
    .set({ revokedAt: new Date() })
    .where(and(eq(adminTrustedDevice.userId, userId), isNull(adminTrustedDevice.revokedAt)))
  return revoked.length
}

// --- Equipo reconocido (ADR 0090) -----------------------------------------------------------
//
// El código se pide al abrir la administración solo si hace falta: en un
// equipo nuevo, desde otro país, tras 30 días sin abrirla en ese equipo o si
// cambió la contraseña o el factor. Si no, el equipo reconocido basta.

/** 30 días sin abrir la administración en un equipo y vuelve a pedir el código. Cada uso renueva el plazo. */
export const ADMIN_TRUSTED_DEVICE_IDLE_MS = 30 * 24 * 60 * 60 * 1000
/** La marca que deja un equipo reconocido dura una hora: así sus reglas se revisan seguido. */
export const ADMIN_DEVICE_SESSION_TTL_MS = 60 * 60 * 1000

function deviceTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

/** Huella de la contraseña guardada (hash del hash): cambiarla deja sin valor los equipos. */
async function passwordFingerprint(ownerDb: Db, userId: string): Promise<string | null> {
  const [row] = await ownerDb
    .select({ password: authAccount.password })
    .from(authAccount)
    .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, "credential")))
    .limit(1)
  return row?.password ? createHash("sha256").update(row.password, "utf8").digest("hex") : null
}

/**
 * Reconoce este equipo tras un código correcto. Si el navegador ya traía un
 * token suyo, lo pone al día (país, factor y contraseña de ahora); si no,
 * crea uno. Devuelve el token que guarda el navegador; aquí solo queda su hash.
 */
export async function trustAdminDevice(
  ownerDb: Db,
  input: { userId: string; factorId: string; country: string | null; currentToken: string | null },
): Promise<string> {
  const fingerprint = await passwordFingerprint(ownerDb, input.userId)
  const now = new Date()
  if (input.currentToken) {
    const [kept] = await ownerDb
      .update(adminTrustedDevice)
      .set({
        factorId: input.factorId,
        country: input.country,
        passwordFingerprint: fingerprint,
        lastUsedAt: now,
        revokedAt: null,
      })
      .where(
        and(
          eq(adminTrustedDevice.tokenHash, deviceTokenHash(input.currentToken)),
          eq(adminTrustedDevice.userId, input.userId),
        ),
      )
      .returning({ id: adminTrustedDevice.id })
    if (kept) return input.currentToken
  }
  const token = randomBytes(32).toString("base64url")
  await ownerDb.insert(adminTrustedDevice).values({
    userId: input.userId,
    factorId: input.factorId,
    tokenHash: deviceTokenHash(token),
    country: input.country,
    passwordFingerprint: fingerprint,
    lastUsedAt: now,
  })
  return token
}

export type AdminVerification =
  | {
      verified: true
      binding: AdminSessionBinding
      /** El equipo reconocido que la dejó pasar, para renovar su cookie; nulo si fue el código. */
      deviceToken: string | null
    }
  | {
      verified: false
      /** «country»: el código se pide porque la visita viene de otro país. */
      reason: "country" | null
    }

/**
 * ¿Pasó esta sesión el segundo factor? Vale la marca de la sesión si es del
 * mismo país; si no, el equipo reconocido, con sus cuatro reglas: mismo país,
 * usado en los últimos 30 días, la misma contraseña y el mismo factor. Un
 * equipo que ya no vale por contraseña, factor o tiempo se retira; el de otro
 * país se conserva y vuelve a valer al poner el código.
 */
export async function resolveAdminVerification(
  ownerDb: Db,
  input: { userId: string; sessionId: string; deviceToken: string | null; country: string | null; now: Date },
): Promise<AdminVerification> {
  const binding = await getLiveSessionBinding(ownerDb, input.sessionId, input.now)
  if (binding && binding.country === input.country) return { verified: true, binding, deviceToken: null }
  const otherCountry = binding !== null
  if (!input.deviceToken) return { verified: false, reason: otherCountry ? "country" : null }
  const [device] = await ownerDb
    .select()
    .from(adminTrustedDevice)
    .where(
      and(
        eq(adminTrustedDevice.tokenHash, deviceTokenHash(input.deviceToken)),
        eq(adminTrustedDevice.userId, input.userId),
        isNull(adminTrustedDevice.revokedAt),
      ),
    )
    .limit(1)
  if (!device) return { verified: false, reason: otherCountry ? "country" : null }
  const factorId = await getStaffFactorId(ownerDb, input.userId)
  if (
    factorId === null ||
    device.factorId !== factorId ||
    input.now.getTime() - device.lastUsedAt.getTime() > ADMIN_TRUSTED_DEVICE_IDLE_MS ||
    device.passwordFingerprint !== (await passwordFingerprint(ownerDb, input.userId))
  ) {
    await ownerDb
      .update(adminTrustedDevice)
      .set({ revokedAt: input.now })
      .where(eq(adminTrustedDevice.id, device.id))
    return { verified: false, reason: otherCountry ? "country" : null }
  }
  if (device.country !== input.country) return { verified: false, reason: "country" }
  await ownerDb
    .update(adminTrustedDevice)
    .set({ lastUsedAt: input.now })
    .where(eq(adminTrustedDevice.id, device.id))
  const fresh = await recordAdminSessionBinding(ownerDb, {
    userId: input.userId,
    sessionId: input.sessionId,
    factorId,
    method: "device",
    ttlMs: ADMIN_DEVICE_SESSION_TTL_MS,
    country: input.country,
  })
  return { verified: true, binding: fresh, deviceToken: input.deviceToken }
}

/**
 * Reserva atómica del intento MFA con freno de fuerza bruta y anti-replay,
 * persistida en auditoría. En UNA transacción con lock consultivo por usuario:
 * 1) cuenta los `staff.mfa.attempt` en ventana y lanza 429 si se agota (la
 * llamada a Better Auth es server call sin rateLimiter HTTP);
 * 2) rechaza con 409 el código ya presentado en la ventana de replay (mismo
 * hash), aunque Better Auth lo aceptaría de nuevo dentro de su tolerancia;
 * 3) registra el intento con su hash (nunca el código).
 * Cierra la carrera check-then-act entre concurrentes del mismo usuario.
 */
export async function claimMfaCode(
  ownerDb: Db,
  actor: AdminActor,
  input: { method: "totp" | "recovery"; codeHash: string },
): Promise<void> {
  const now = new Date()
  await ownerDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${actor.userId}))`)
    const [budget] = await tx
      .select({ attempts: count() })
      .from(adminAudit)
      .where(
        and(
          eq(adminAudit.action, "staff.mfa.attempt"),
          eq(adminAudit.actorUserId, actor.userId),
          gt(adminAudit.createdAt, new Date(now.getTime() - ADMIN_MFA_ATTEMPT_WINDOW_MS)),
        ),
      )
    if ((budget?.attempts ?? 0) >= ADMIN_MFA_MAX_ATTEMPTS) {
      throw new ServiceError(
        "MFA_LOCKED",
        429,
        "Demasiados intentos; espera unos minutos e intenta de nuevo",
      )
    }
    const [replay] = await tx
      .select({ id: adminAudit.id })
      .from(adminAudit)
      .where(
        and(
          eq(adminAudit.actorUserId, actor.userId),
          gt(adminAudit.createdAt, new Date(now.getTime() - ADMIN_MFA_REPLAY_WINDOW_MS)),
          sql`${adminAudit.metadata}->>'codeHash' = ${input.codeHash}`,
        ),
      )
      .limit(1)
    if (replay) {
      throw new ServiceError("MFA_REPLAY", 409, "Ese código ya fue usado; genera uno nuevo")
    }
    await tx.insert(adminAudit).values({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "staff.mfa.attempt",
      metadata: { method: input.method, codeHash: input.codeHash },
    })
  })
}

/** sha256 del par credencial+código: identifica replays sin guardar el código. */
export function hashMfaCode(factorId: string, code: string): string {
  return createHash("sha256").update(`${factorId}:${code.trim()}`, "utf8").digest("hex")
}
/** Lista la auditoría (paginación keyset por fecha+id, lo nuevo primero). */
export async function listAdminAudit(
  ownerDb: Db,
  input: { limit?: number; beforeTime?: Date; beforeId?: string },
): Promise<{
  rows: Array<typeof adminAudit.$inferSelect>
  nextCursor: { beforeTime: string; beforeId: string } | null
}> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
  const rows =
    input.beforeTime && input.beforeId
      ? await ownerDb
          .select()
          .from(adminAudit)
          .where(
            // Página anterior: lo estrictamente más viejo (fecha, o misma
            // fecha con id menor) para no saltar ni repetir filas.
            or(
              lt(adminAudit.createdAt, input.beforeTime),
              and(eq(adminAudit.createdAt, input.beforeTime), lt(adminAudit.id, input.beforeId)),
            ),
          )
          .orderBy(desc(adminAudit.createdAt), desc(adminAudit.id))
          .limit(limit + 1)
      : await ownerDb
          .select()
          .from(adminAudit)
          .orderBy(desc(adminAudit.createdAt), desc(adminAudit.id))
          .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    rows: page,
    nextCursor:
      rows.length > limit && last
        ? { beforeTime: last.createdAt.toISOString(), beforeId: last.id }
        : null,
  }
}

/** Pendientes de personal/seguridad para el Inicio admin (`/api/admin/overview`). */
export interface AdminCorePending {
  pendingInvitations: AdminInvitationRow[]
  staffWithoutFactor: Array<{ userId: string; name: string; email: string; role: AdminRole }>
  recentSecurity: Array<{
    action: string
    actorUserId: string | null
    createdAt: Date
    entityId: string | null
  }>
}

const SECURITY_ACTIONS = [
  "staff.bootstrap",
  "staff.deactivate",
  "staff.factor.reset",
  "staff.mfa.enroll.restart",
  "staff.mfa.backup-codes",
  "staff.mfa.revoke",
  "staff.recovery.used",
]

export async function getAdminCorePending(ownerDb: Db, now: Date): Promise<AdminCorePending> {
  const [invitations, withoutFactor, recent] = await Promise.all([
    listPendingAdminInvitations(ownerDb, now),
    ownerDb
      .select({
        userId: adminStaff.userId,
        role: adminStaff.role,
        name: user.name,
        email: user.email,
      })
      .from(adminStaff)
      .innerJoin(user, eq(user.id, adminStaff.userId))
      .leftJoin(twoFactor, eq(twoFactor.userId, adminStaff.userId))
      .where(and(eq(adminStaff.active, true), isNull(twoFactor.id))),
    ownerDb
      .select({
        action: adminAudit.action,
        actorUserId: adminAudit.actorUserId,
        createdAt: adminAudit.createdAt,
        entityId: adminAudit.entityId,
      })
      .from(adminAudit)
      .where(inArray(adminAudit.action, SECURITY_ACTIONS))
      .orderBy(desc(adminAudit.createdAt))
      .limit(10),
  ])
  return {
    pendingInvitations: invitations,
    staffWithoutFactor: withoutFactor.map((row) => ({
      userId: row.userId,
      name: row.name,
      email: row.email,
      role: isAdminRole(row.role) ? row.role : "support",
    })),
    recentSecurity: recent,
  }
}
/**
 * Reset privilegiado del factor de otro miembro (teléfono perdido, evidencia
 * de autoridad fuera de banda). Solo `admin`, con motivo; borra el secreto,
 * apaga la bandera y revoca sus sesiones. El afectado re-enrola desde cero.
 */
export async function adminResetStaffFactor(
  ownerDb: Db,
  actor: AdminActor,
  targetUserId: string,
  reason: string,
): Promise<void> {
  if (actor.role !== "admin") throw forbidden("Solo administración resetea factores")
  if (actor.userId === targetUserId)
    throw forbidden("Tu factor se revoca con tu contraseña, no con reset")
  if (reason.trim().length < 8) throw invalidField("reason", "El motivo es obligatorio (mínimo 8 caracteres)")
  await ownerDb.transaction(async (tx) => {
    const [target] = await tx
      .select({ userId: adminStaff.userId })
      .from(adminStaff)
      .where(eq(adminStaff.userId, targetUserId))
      .limit(1)
    if (!target) throw new ServiceError("NOT_FOUND", 404, "Personal no encontrado")
    await tx.delete(twoFactor).where(eq(twoFactor.userId, targetUserId))
    await tx.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, targetUserId))
    // Sesiones reales de Better Auth: sin esto la cookie robada/conservada
    // seguiría autenticada y podría enrolar factor nuevo (solo-OAuth fresca).
    await tx.delete(session).where(eq(session.userId, targetUserId))
    await tx
      .update(adminTrustedDevice)
      .set({ revokedAt: new Date() })
      .where(and(eq(adminTrustedDevice.userId, targetUserId), isNull(adminTrustedDevice.revokedAt)))
    await tx
      .update(adminSessionVerification)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(adminSessionVerification.userId, targetUserId),
          isNull(adminSessionVerification.revokedAt),
        ),
      )
    await writeAdminAudit(tx, actor, {
      action: "staff.factor.reset",
      entityId: targetUserId,
      metadata: { reason: reason.trim().slice(0, 280) },
    })
  })
}

/**
 * Alta inicial por CLI explícito. Solo procede si NO hay ningún admin activo;
 * exige cuenta existente con correo verificado. Jamás otorga por dominio ni
 * por variable de entorno: el correo nombra una cuenta real.
 */
export async function bootstrapAdminStaff(ownerDb: Db, email: string): Promise<AdminActor> {
  const normalized = normalizeStaffEmail(email)
  const admins = await ownerDb
    .select({ userId: adminStaff.userId })
    .from(adminStaff)
    .where(and(eq(adminStaff.role, "admin"), eq(adminStaff.active, true)))
    .limit(1)
  if (admins.length > 0) throw forbidden("Ya existe un admin activo: el alta es por invitación")
  const [account] = await ownerDb
    .select({ id: user.id, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, normalized))
    .limit(1)
  if (!account) throw new ServiceError("NOT_FOUND", 404, "No existe una cuenta con ese correo")
  if (!account.emailVerified) throw forbidden("La cuenta debe tener el correo verificado")
  const [existing] = await ownerDb
    .select({ active: adminStaff.active })
    .from(adminStaff)
    .where(eq(adminStaff.userId, account.id))
    .limit(1)
  if (existing?.active)
    throw new ServiceError("ALREADY_STAFF", 409, "Esa cuenta ya es personal activo")
  if (existing) {
    await ownerDb
      .update(adminStaff)
      .set({ role: "admin", active: true })
      .where(eq(adminStaff.userId, account.id))
  } else {
    await ownerDb.insert(adminStaff).values({ userId: account.id, role: "admin", active: true })
  }
  const actor: AdminActor = { userId: account.id, role: "admin" }
  await writeAdminAudit(ownerDb, null, {
    action: "staff.bootstrap",
    entityId: account.id,
    metadata: { email: normalized },
  })
  return actor
}
