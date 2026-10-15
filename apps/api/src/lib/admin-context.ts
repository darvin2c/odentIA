import type { Auth } from "@odentia/auth"
import { isAdminRole } from "@odentia/auth/admin-permissions"
import type { Db } from "@odentia/db"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { type AdminActor, getLiveSessionBinding, hasStaffFactor } from "@odentia/services"
import { eq, sql } from "drizzle-orm"
import type { Context, Next } from "hono"
import { errorBody } from "./error.js"

export type { AdminActor }

export interface AdminContextDeps {
  auth: Auth
  ownerDb: Db
}

/** Identidad de sesión para endpoints abiertos (p. ej. aceptar invitación). */
export interface AdminSessionIdentity {
  userId: string
  sessionId: string
  email: string
  emailVerified: boolean
  sessionCreatedAt: Date
}

/**
 * Colas sin vinculación MFA: solo estado, enrolamiento (sin factor previo),
 * challenge y aceptar invitación. Revocar/regenerar exigen binding vigente:
 * con `allowPasswordless`, la contraseña sola no prueba nada en cuentas
 * solo-OAuth (cualquier texto la supera); la recuperación ya crea binding.
 */
export const OPEN_TAILS = [
  "/access/session",
  "/access/mfa/status",
  "/access/mfa/enroll/start",
  "/access/mfa/enroll/confirm",
  "/access/challenge/verify",
  "/access/recovery/verify",
  "/access/invitations/accept",
]

/**
 * Guard del personal: sesión + staff activo + segundo factor vinculado a la
 * sesión (si el usuario ya tiene factor enrolado). El staff nunca hereda
 * membresía de tenant y ningún cliente pasa este guard.
 *
 * Va montado antes de las rutas admin. Las rutas comprueban el
 * rol para cada acción (ver `forbidUnlessManager`); la UI no decide accesos.
 */
export function requireAdminContext({ auth, ownerDb }: AdminContextDeps) {
  return async (c: Context, next: Next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) {
      return c.json(errorBody(c, "UNAUTHORIZED", "Sesión requerida"), 401)
    }
    if (!session.user.emailVerified) {
      return c.json(errorBody(c, "EMAIL_UNVERIFIED", "Verifica tu correo para operar"), 403)
    }
    const identity: AdminSessionIdentity = {
      userId: session.user.id,
      sessionId: session.session.id,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      sessionCreatedAt: session.session.createdAt,
    }
    c.set("adminIdentity", identity)

    const path = c.req.path
    if (path.endsWith("/access/invitations/accept")) {
      // La invitada aún no es staff: solo sesión (la ruta exige identidad verificada).
      await next()
      return
    }

    const [staff] = await ownerDb
      .select({ role: adminStaff.role, active: adminStaff.active })
      .from(adminStaff)
      .where(eq(adminStaff.userId, identity.userId))
      .limit(1)
    if (!staff || !staff.active || !isAdminRole(staff.role)) {
      return c.json(errorBody(c, "STAFF_ONLY", "Sin acceso de personal"), 403)
    }
    // Bloqueo global (tabla user_global_block): Better Auth no lo sabe, así que se
    // honra aquí con owner aunque la sesión siga válida. Expirado = desbloqueado.
    const blockRows = await ownerDb.execute(
      sql`select 1 from "user_global_block" where "user_id" = ${identity.userId} and "active" and ("expires_at" is null or "expires_at" > now()) limit 1`,
    )
    if (Array.isArray(blockRows) && blockRows.length > 0) {
      return c.json(
        errorBody(c, "GLOBAL_BLOCK", "Cuenta bloqueada. Contacta a administración."),
        403,
      )
    }
    const actor: AdminActor = { userId: identity.userId, role: staff.role }
    c.set("adminActor", actor)

    if (OPEN_TAILS.some((tail) => path.endsWith(tail))) {
      await next()
      return
    }

    // Con factor enrolado, la sesión sola no basta: exige prueba vinculada.
    if (!(await hasStaffFactor(ownerDb, identity.userId))) {
      return c.json(
        errorBody(c, "MFA_ENROLL_REQUIRED", "Enrola tu segundo factor para continuar"),
        403,
      )
    }
    const binding = await getLiveSessionBinding(ownerDb, identity.sessionId, new Date())
    if (!binding) {
      return c.json(errorBody(c, "MFA_REQUIRED", "Verifica tu segundo factor para continuar"), 403)
    }
    c.set("adminBindingMethod", binding.method)
    await next()
  }
}

/** Actor verificado por `requireAdminContext`. Falla si el guard no corrió. */
export function adminContextOf(c: Context): AdminActor {
  const actor = c.get("adminActor") as AdminActor | undefined
  if (!actor) throw new Error("adminContextOf exige requireAdminContext")
  return actor
}

/** Identidad de sesión guardada por el guard (para enrolamiento/aceptación). */
export function adminIdentityOf(c: Context): AdminSessionIdentity {
  const identity = c.get("adminIdentity") as AdminSessionIdentity | undefined
  if (!identity) throw new Error("adminIdentityOf exige requireAdminContext")
  return identity
}

/**
 * 403 si el actor no es `admin`. Las rutas lo usan por acción (gestión de
 * equipo, resets, auditoría sensible); `support` opera solo su ámbito.
 */
export function forbidUnlessManager(c: Context, actor: AdminActor) {
  if (actor.role !== "admin") {
    return c.json(errorBody(c, "FORBIDDEN", "Solo administración"), 403)
  }
  return null
}
