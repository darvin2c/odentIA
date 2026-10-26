import { ADMIN_DEVICE_COOKIE, type Auth } from "@odentia/auth"
import { isAdminRole } from "@odentia/auth/admin-permissions"
import type { Db } from "@odentia/db"
import { adminStaff } from "@odentia/db/schema/admin-core"
import {
  ADMIN_TRUSTED_DEVICE_IDLE_MS,
  type AdminActor,
  hasStaffFactor,
  resolveAdminVerification,
} from "@odentia/services"
import { eq, sql } from "drizzle-orm"
import type { Context, Next } from "hono"
import { getCookie } from "hono/cookie"
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


/** Token del equipo reconocido que trae el navegador, o nulo. */
export function adminDeviceTokenOf(c: Context): string | null {
  const token = getCookie(c, ADMIN_DEVICE_COOKIE)
  return token && /^[A-Za-z0-9_-]{20,100}$/.test(token) ? token : null
}

/**
 * País de la visita: la cabecera que pone Cloudflare delante de todo acceso.
 * Sin ella (desarrollo, pruebas) es nulo, y nulo con nulo cuenta como el mismo.
 */
export function visitCountryOf(c: Context): string | null {
  const country = c.req.header("cf-ipcountry")?.trim().toUpperCase()
  return country && /^[A-Z0-9]{2}$/.test(country) ? country : null
}

/**
 * `Set-Cookie` que reconoce este equipo por 30 días; cada uso la renueva. Va
 * en `/api` y no solo en la administración: cerrar sesión (`/api/auth/sign-out`)
 * la lee para olvidar el equipo.
 */
export function adminDeviceCookie(token: string): string {
  const maxAge = Math.floor(ADMIN_TRUSTED_DEVICE_IDLE_MS / 1000)
  return `${ADMIN_DEVICE_COOKIE}=${token}; Path=/api; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`
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
    // El código vale por la marca de la sesión o por el equipo reconocido (ADR 0090).
    const verification = await resolveAdminVerification(ownerDb, {
      userId: identity.userId,
      sessionId: identity.sessionId,
      deviceToken: adminDeviceTokenOf(c),
      country: visitCountryOf(c),
      now: new Date(),
    })
    if (!verification.verified) {
      return c.json(errorBody(c, "MFA_REQUIRED", "Verifica tu segundo factor para continuar"), 403)
    }
    if (verification.deviceToken) c.header("set-cookie", adminDeviceCookie(verification.deviceToken), { append: true })
    c.set("adminBindingMethod", verification.binding.method)
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
