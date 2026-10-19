import { adminStaff, twoFactor } from "@odentia/db/schema/admin-core"
import { account } from "@odentia/db/schema/auth"
import {
  ADMIN_FRESH_SESSION_MS,
  ADMIN_INVITATION_TTL_MS,
  ADMIN_MFA_SESSION_TTL_MS,
  ADMIN_RECOVERY_SESSION_TTL_MS,
  acceptAdminInvitation,
  adminResetStaffFactor,
  claimMfaCode,
  clearPendingStaffFactor,
  getLiveSessionBinding,
  getStaffFactorId,
  hashMfaCode,
  hasStaffFactor,
  inviteAdminStaff,
  listAdminAudit,
  listAdminStaff,
  listPendingAdminInvitations,
  recordAdminSessionBinding,
  resendAdminInvitation,
  revokeAdminInvitation,
  revokeStaffBindings,
  ServiceError,
  setAdminStaffActive,
  setAdminStaffRole,
  writeAdminAudit,
} from "@odentia/services"
import { staffInvitationTemplate } from "@odentia/mail"
import { and, eq } from "drizzle-orm"
import { type Context, Hono, type Next } from "hono"
import { z } from "zod"
import type { AppDeps } from "../app.js"
import { adminContextOf, adminIdentityOf, forbidUnlessManager } from "../lib/admin-context.js"
import { errorBody } from "../lib/error.js"
import { runService, serviceErrorResponse, validationError } from "./helpers.js"

type CoreDeps = Pick<AppDeps, "auth" | "ownerDb" | "mailer" | "adminURL">

/** Enlace accionable de aceptación (nunca IDs técnicos sueltos). */
function staffAcceptUrl(adminURL: string, token: string): string {
  return `${adminURL.replace(/\/+$/, "")}/security?invitation=${encodeURIComponent(token)}`
}

/** Correo real de invitación con URL admin; el fallo conocido habilita el fallback copiable. */
async function sendStaffInvite(
  mailer: CoreDeps["mailer"],
  email: string,
  acceptUrl: string,
): Promise<void> {
  await mailer.send({ to: email, ...staffInvitationTemplate({ url: acceptUrl }) })
}

const passwordInput = z.object({ password: z.string().min(1).max(200).optional() })
const codeInput = z.object({ code: z.string().trim().min(4).max(16) })
const challengeInput = z.object({
  code: z.string().trim().min(4).max(16),
  method: z.enum(["totp", "recovery"]).optional(),
})
const inviteInput = z.object({
  email: z.string().trim().email("Correo inválido").max(160),
  role: z.enum(["admin", "support"]),
})
const roleInput = z.object({ role: z.enum(["admin", "support"]) })
const activeInput = z.object({
  active: z.boolean(),
  reason: z.string().trim().min(8, "El motivo es obligatorio").max(280),
})
const reasonInput = z.object({
  reason: z.string().trim().min(8, "El motivo es obligatorio").max(280),
})
const acceptInput = z.object({ token: z.string().trim().min(16).max(128) })
const userIdParam = z.object({ userId: z.string().min(1).max(128) })
const invitationIdParam = z.object({ id: z.string().uuid("Invitación inválida") })
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  beforeTime: z.iso.datetime({ offset: true }).optional(),
  beforeId: z.uuid().optional(),
})

type AuthStatus = 400 | 401 | 403 | 404 | 409 | 429

/** Traduce errores de Better Auth a dominio (mensajes en español, sin filtrar detalles). */
function authFailure(endpoint: "enroll" | "verify" | "revoke", e: unknown): ServiceError {
  if (e instanceof ServiceError) return e
  let status: AuthStatus = 400
  if (typeof e === "object" && e !== null && "statusCode" in e) {
    const code = e.statusCode
    if (code === 401) status = 401
    else if (code === 403) status = 403
    else if (code === 404) status = 404
    else if (code === 429) status = 429
  } else {
    throw e
  }
  if (status === 429 || status === 403) {
    return new ServiceError(
      "MFA_LOCKED",
      status,
      "Demasiados intentos; espera unos minutos e intenta de nuevo",
    )
  }
  if (endpoint === "enroll" || endpoint === "revoke") {
    return new ServiceError("BAD_PASSWORD", status, "Contraseña incorrecta")
  }
  return new ServiceError("MFA_INVALID", status, "Código incorrecto o caducado")
}

/**
 * Llama a un endpoint Better Auth con `asResponse` y propaga sus `Set-Cookie`:
 * al confirmar TOTP por primera vez Auth rota la sesión (crea una y elimina
 * la anterior). Sin reenviarlas, el navegador conserva la cookie muerta y el
 * binding quedaría atado a una sesión inexistente. Resuelve además la sesión
 * EFECTIVA (nueva o intacta) combinando cookies para vincular lo correcto.
 *
 * CRÍTICO: exige `raw.ok`. Un código inválido devuelve Response 400 (no
 * throw); sin este cheque el wrapper crearía el binding igual (bypass MFA).
 * Sin sesión efectiva no hay fallback: UNAUTHORIZED.
 */
async function authVerifyRefresh(
  deps: CoreDeps,
  entryUserId: string,
  headers: Headers,
  failureKind: "verify" | "revoke",
  call: (init: { headers: Headers }) => Promise<Response>,
): Promise<{ sessionId: string; setCookies: string[] }> {
  const raw = await call({ headers })
  if (!raw.ok) {
    if (raw.status === 429) {
      throw new ServiceError(
        "MFA_LOCKED",
        429,
        "Demasiados intentos; espera unos minutos e intenta de nuevo",
      )
    }
    if (raw.status === 401) {
      throw new ServiceError("UNAUTHORIZED", 401, "Sesión requerida")
    }
    if (failureKind === "revoke") {
      throw new ServiceError("BAD_PASSWORD", 400, "Contraseña incorrecta")
    }
    throw new ServiceError("MFA_INVALID", 400, "Código incorrecto o caducado")
  }
  const setCookies =
    typeof raw.headers.getSetCookie === "function" ? raw.headers.getSetCookie() : []
  const pairs = new Map<string, string>()
  const original = headers.get("cookie")
  for (const part of (original ?? "").split(";")) {
    const at = part.indexOf("=")
    if (at > 0) pairs.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  for (const setCookie of setCookies) {
    const semi = setCookie.indexOf(";")
    const pair = semi >= 0 ? setCookie.slice(0, semi) : setCookie
    const at = pair.indexOf("=")
    if (at > 0) {
      const name = pair.slice(0, at).trim()
      const value = pair.slice(at + 1).trim()
      if (value === "" || value === "null") pairs.delete(name)
      else pairs.set(name, value)
    }
  }
  const merged = [...pairs.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
  const current = await deps.auth.api.getSession({
    headers: new Headers(merged ? { cookie: merged } : {}),
  })
  if (!current || current.user.id !== entryUserId) {
    throw new ServiceError("UNAUTHORIZED", 401, "Sesión requerida")
  }
  return { sessionId: current.session.id, setCookies }
}

/** Responde JSON `{data}` reenviando las cookies de Better Auth (rotación). */
function verifiedJson(data: Record<string, unknown>, setCookies: string[]) {
  const headers = new Headers({ "content-type": "application/json; charset=UTF-8" })
  for (const setCookie of setCookies) headers.append("set-cookie", setCookie)
  return new Response(JSON.stringify({ data }), { status: 200, headers })
}
/**
 * Acceso del personal (`/api/admin/access`; el guard `requireAdminContext`
 * va montado antes). Define rutas relativas al namespace.
 */
export function createAdminCoreRoute(deps: CoreDeps) {
  const app = new Hono()

  /** Sesión del shell admin: actor + usuario + factor vinculado o no. */
  app.get("/session", async (c) => {
    const actor = adminContextOf(c)
    const identity = adminIdentityOf(c)
    const now = new Date()
    const [binding, enrolled] = await Promise.all([
      getLiveSessionBinding(deps.ownerDb, identity.sessionId, now),
      hasStaffFactor(deps.ownerDb, actor.userId),
    ])
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers })
    return runService(c, 200, async () => ({
      actor,
      user: {
        name: session?.user.name ?? "",
        email: session?.user.email ?? identity.email,
        image: session?.user.image ?? null,
      },
      enrolled,
      // verified exige las tres: factor enrolado, prueba viva y credencial vigente
      // (getLiveSessionBinding ya mata pruebas de factores retirados).
      verified: enrolled && binding !== null,
      method: enrolled ? (binding?.method ?? null) : null,
    }))
  })

  /** Estado del factor para la página de seguridad. */
  app.get("/mfa/status", async (c) => {
    const actor = adminContextOf(c)
    const identity = adminIdentityOf(c)
    const now = new Date()
    const [binding, enrolled] = await Promise.all([
      getLiveSessionBinding(deps.ownerDb, identity.sessionId, now),
      hasStaffFactor(deps.ownerDb, actor.userId),
    ])
    return runService(c, 200, async () => ({
      enrolled,
      verified: enrolled && binding !== null,
      method: enrolled ? (binding?.method ?? null) : null,
    }))
  })

  /**
   * Inicia el enrolamiento TOTP (solo sin factor). Exige contraseña salvo
   * cuenta solo-OAuth, que prueba identidad con sesión fresca (10 min):
   * una sesión robada vieja no puede registrar un factor.
   */
  app.post("/mfa/enroll/start", async (c) => {
    const actor = adminContextOf(c)
    const identity = adminIdentityOf(c)
    const parsed = passwordInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      if (await hasStaffFactor(deps.ownerDb, actor.userId)) {
        throw new ServiceError("MFA_ENROLLED", 409, "Ya tienes un factor enrolado")
      }
      // Enrolamiento abandonado: limpia el pendiente y reinicia bajo las mismas pruebas.
      await clearPendingStaffFactor(deps.ownerDb, actor)
      const [credential] = await deps.ownerDb
        .select({ id: account.id })
        .from(account)
        .where(and(eq(account.userId, actor.userId), eq(account.providerId, "credential")))
        .limit(1)
      if (!credential) {
        const age = Date.now() - identity.sessionCreatedAt.getTime()
        if (age > ADMIN_FRESH_SESSION_MS) {
          throw new ServiceError(
            "FRESH_LOGIN_REQUIRED",
            403,
            "Vuelve a iniciar sesión para enrolar tu factor",
          )
        }
      } else if (!parsed.data.password) {
        throw new ServiceError("VALIDATION", 400, "Ingresa tu contraseña para enrolar el factor")
      }
      try {
        const result = await deps.auth.api.enableTwoFactor({
          headers: c.req.raw.headers,
          body: { password: parsed.data.password ?? "", method: "totp" },
        })
        if (result.method !== "totp" || !result.totpURI) {
          throw new ServiceError("MFA_ENROLL", 500, "No se pudo iniciar el enrolamiento")
        }
        return { totpURI: result.totpURI, backupCodes: result.backupCodes ?? [] }
      } catch (e) {
        throw authFailure("enroll", e)
      }
    })
  })

  /** Confirma el enrolamiento con un código válido (vincula la sesión 12 h). */
  app.post("/mfa/enroll/confirm", async (c) => {
    const actor = adminContextOf(c)
    const parsed = codeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const code = parsed.data.code
    try {
      // La credencial a probar puede ser el pendiente recién creado por start.
      const [pendingRow] = await deps.ownerDb
        .select({ id: twoFactor.id })
        .from(twoFactor)
        .where(and(eq(twoFactor.userId, actor.userId), eq(twoFactor.verified, false)))
        .limit(1)
      const confirmedId = await getStaffFactorId(deps.ownerDb, actor.userId)
      const claimFactorId = confirmedId ?? pendingRow?.id ?? null
      if (!claimFactorId)
        throw new ServiceError("MFA_ENROLL", 409, "Inicia el enrolamiento primero")
      await claimMfaCode(deps.ownerDb, actor, {
        method: "totp",
        codeHash: hashMfaCode(claimFactorId, code),
      })
      let refreshed: { sessionId: string; setCookies: string[] }
      try {
        refreshed = await authVerifyRefresh(
          deps,
          actor.userId,
          c.req.raw.headers,
          "verify",
          ({ headers }) => deps.auth.api.verifyTOTP({ headers, body: { code }, asResponse: true }),
        )
      } catch (e) {
        throw authFailure("verify", e)
      }
      const factorId = await getStaffFactorId(deps.ownerDb, actor.userId)
      if (!factorId) throw new ServiceError("MFA_ENROLL", 500, "El factor no quedó registrado")
      const binding = await recordAdminSessionBinding(deps.ownerDb, {
        userId: actor.userId,
        sessionId: refreshed.sessionId,
        factorId,
        method: "totp",
        ttlMs: ADMIN_MFA_SESSION_TTL_MS,
      })
      await writeAdminAudit(deps.ownerDb, actor, {
        action: "staff.mfa.enroll",
        metadata: { method: "totp", codeHash: hashMfaCode(factorId, code) },
      })
      return verifiedJson(
        { verified: true, expiresAt: binding.expiresAt.toISOString() },
        refreshed.setCookies,
      )
    } catch (e) {
      const mapped = serviceErrorResponse(c, e)
      if (mapped) return mapped
      throw e
    }
  })

  /**
   * Challenge del factor (vincula la sesión). TOTP = 12 h; código de
   * respaldo = 30 min y obliga a re-enrolar (un solo uso, lo consume Auth).
   */
  app.post("/challenge/verify", async (c) => {
    const actor = adminContextOf(c)
    const parsed = challengeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const method = parsed.data.method ?? "totp"
    const code = parsed.data.code
    try {
      const challengeFactorId = await getStaffFactorId(deps.ownerDb, actor.userId)
      if (!challengeFactorId)
        throw new ServiceError("MFA_REQUIRED", 403, "Enrola tu segundo factor para continuar")
      await claimMfaCode(deps.ownerDb, actor, {
        method,
        codeHash: hashMfaCode(challengeFactorId, code),
      })
      let refreshed: { sessionId: string; setCookies: string[] }
      try {
        refreshed = await authVerifyRefresh(
          deps,
          actor.userId,
          c.req.raw.headers,
          "verify",
          ({ headers }) =>
            method === "recovery"
              ? deps.auth.api.verifyBackupCode({ headers, body: { code }, asResponse: true })
              : deps.auth.api.verifyTOTP({ headers, body: { code }, asResponse: true }),
        )
      } catch (e) {
        throw authFailure("verify", e)
      }
      const binding = await recordAdminSessionBinding(deps.ownerDb, {
        userId: actor.userId,
        sessionId: refreshed.sessionId,
        factorId: challengeFactorId,
        method,
        ttlMs: method === "recovery" ? ADMIN_RECOVERY_SESSION_TTL_MS : ADMIN_MFA_SESSION_TTL_MS,
      })
      await writeAdminAudit(deps.ownerDb, actor, {
        action: method === "recovery" ? "staff.recovery.used" : "staff.mfa.challenge",
        metadata: { method, codeHash: hashMfaCode(challengeFactorId, code) },
      })
      return verifiedJson(
        { verified: true, method, expiresAt: binding.expiresAt.toISOString() },
        refreshed.setCookies,
      )
    } catch (e) {
      const mapped = serviceErrorResponse(c, e)
      if (mapped) return mapped
      throw e
    }
  })

  /** Revoca el factor propio con contraseña (revoca además sus sesiones). */
  app.post("/mfa/revoke", async (c) => {
    const actor = adminContextOf(c)
    const parsed = passwordInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    if (!parsed.data.password)
      return c.json(errorBody(c, "VALIDATION", "Ingresa tu contraseña"), 400)
    const password = parsed.data.password
    try {
      let setCookies: string[] = []
      try {
        const refreshed = await authVerifyRefresh(
          deps,
          actor.userId,
          c.req.raw.headers,
          "revoke",
          ({ headers }) =>
            deps.auth.api.disableTwoFactor({ headers, body: { password }, asResponse: true }),
        )
        setCookies = refreshed.setCookies
      } catch (e) {
        throw authFailure("revoke", e)
      }
      await revokeStaffBindings(deps.ownerDb, actor.userId)
      await writeAdminAudit(deps.ownerDb, actor, { action: "staff.mfa.revoke" })
      return verifiedJson({ ok: true }, setCookies)
    } catch (e) {
      const mapped = serviceErrorResponse(c, e)
      if (mapped) return mapped
      throw e
    }
  })

  /**
   * Regenera códigos de respaldo con contraseña (wrapper del endpoint nativo,
   * bloqueado en `/api/auth` por la frontera de factor: expondría material sin prueba).
   * No exige binding (la contraseña es la prueba); audita la regeneración.
   */
  app.post("/mfa/backup-codes", async (c) => {
    const actor = adminContextOf(c)
    const parsed = passwordInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    if (!parsed.data.password)
      return c.json(errorBody(c, "VALIDATION", "Ingresa tu contraseña"), 400)
    const password = parsed.data.password
    return runService(c, 200, async () => {
      try {
        const result = await deps.auth.api.generateBackupCodes({
          headers: c.req.raw.headers,
          body: { password },
        })
        await writeAdminAudit(deps.ownerDb, actor, { action: "staff.mfa.backup-codes" })
        return { backupCodes: result.backupCodes ?? [] }
      } catch (e) {
        throw authFailure("revoke", e)
      }
    })
  })
  /** Equipo: personal + invitaciones pendientes. Solo admin (PII e invitaciones). */
  app.get("/team", async (c) => {
    const actor = adminContextOf(c)
    const manager = forbidUnlessManager(c, actor)
    if (manager) return manager
    return runService(c, 200, async () => ({
      staff: await listAdminStaff(deps.ownerDb),
      invitations: await listPendingAdminInvitations(deps.ownerDb, new Date()),
      invitationTtlMs: ADMIN_INVITATION_TTL_MS,
    }))
  })

  /** Invita personal (nominal, sin autoelevación por dominio). Solo admin. */
  app.post("/team/invite", async (c) => {
    const actor = adminContextOf(c)
    const manager = forbidUnlessManager(c, actor)
    if (manager) return manager
    const parsed = inviteInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      inviteAdminStaff(
        deps.ownerDb,
        actor,
        parsed.data,
        (email, acceptUrl) => sendStaffInvite(deps.mailer, email, acceptUrl),
        (token) => staffAcceptUrl(deps.adminURL, token),
      ),
    )
  })

  /** Reenvía invitación pendiente con token nuevo (motivo auditable). Solo admin. */
  app.post("/team/invitations/:id/resend", async (c) => {
    const actor = adminContextOf(c)
    const manager = forbidUnlessManager(c, actor)
    if (manager) return manager
    const param = invitationIdParam.safeParse({ id: c.req.param("id") })
    if (!param.success) return validationError(c, param.error.issues)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      resendAdminInvitation(
        deps.ownerDb,
        actor,
        param.data.id,
        parsed.data.reason,
        (email, acceptUrl) => sendStaffInvite(deps.mailer, email, acceptUrl),
        (token) => staffAcceptUrl(deps.adminURL, token),
      ),
    )
  })

  /** Cambia el rol interno. Solo admin; último admin protegido. */
  app.post("/team/:userId/role", async (c) => {
    const actor = adminContextOf(c)
    const manager = forbidUnlessManager(c, actor)
    if (manager) return manager
    const param = userIdParam.safeParse({ userId: c.req.param("userId") })
    if (!param.success) return validationError(c, param.error.issues)
    const parsed = roleInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      await setAdminStaffRole(deps.ownerDb, actor, param.data.userId, parsed.data.role)
      return { ok: true as const }
    })
  })

  /** Activa/desactiva con motivo. Solo admin; sin auto-baja; último admin protegido. */
  app.post("/team/:userId/active", async (c) => {
    const actor = adminContextOf(c)
    const manager = forbidUnlessManager(c, actor)
    if (manager) return manager
    const param = userIdParam.safeParse({ userId: c.req.param("userId") })
    if (!param.success) return validationError(c, param.error.issues)
    const parsed = activeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      await setAdminStaffActive(
        deps.ownerDb,
        actor,
        param.data.userId,
        parsed.data.active,
        parsed.data.reason,
      )
      return { ok: true as const }
    })
  })

  /** Revoca una invitación pendiente. Solo admin. */
  app.post("/team/invitations/:id/revoke", async (c) => {
    const actor = adminContextOf(c)
    const manager = forbidUnlessManager(c, actor)
    if (manager) return manager
    const param = invitationIdParam.safeParse({ id: c.req.param("id") })
    if (!param.success) return validationError(c, param.error.issues)
    return runService(c, 200, async () => {
      await revokeAdminInvitation(deps.ownerDb, actor, param.data.id)
      return { ok: true as const }
    })
  })

  /** Reset del factor de otro miembro (autoridad fuera de banda + motivo). Solo admin. */
  app.post("/team/:userId/factor-reset", async (c) => {
    const actor = adminContextOf(c)
    const manager = forbidUnlessManager(c, actor)
    if (manager) return manager
    const param = userIdParam.safeParse({ userId: c.req.param("userId") })
    if (!param.success) return validationError(c, param.error.issues)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, async () => {
      await adminResetStaffFactor(deps.ownerDb, actor, param.data.userId, parsed.data.reason)
      return { ok: true as const }
    })
  })

  /**
   * Acepta la invitación con identidad verificada (sesión sin staff).
   * No crea cuenta ni autoeleva: correo invitado + verificado.
   */
  app.post("/invitations/accept", async (c) => {
    const identity = adminIdentityOf(c)
    const parsed = acceptInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      acceptAdminInvitation(
        deps.ownerDb,
        { id: identity.userId, email: identity.email, emailVerified: identity.emailVerified },
        parsed.data.token,
      ),
    )
  })

  /** Auditoría global. Solo admin (incluye eventos y metadatos financieros de otras slices). */
  app.get("/audit", async (c) => {
    const actor = adminContextOf(c)
    const manager = forbidUnlessManager(c, actor)
    if (manager) return manager
    const parsed = auditQuery.safeParse({
      limit: c.req.query("limit"),
      beforeTime: c.req.query("beforeTime"),
      beforeId: c.req.query("beforeId"),
    })
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const beforeTime = parsed.data.beforeTime ? new Date(parsed.data.beforeTime) : undefined
    if (beforeTime && Number.isNaN(beforeTime.getTime())) {
      return c.json(errorBody(c, "VALIDATION", "beforeTime inválido"), 400)
    }
    return runService(c, 200, () =>
      listAdminAudit(deps.ownerDb, {
        limit: parsed.data.limit,
        beforeTime,
        beforeId: parsed.data.beforeId,
      }),
    )
  })

  return app
}

/**
 * Enlace admin en el panel (`/api/account/admin-access`, lo monta el parent).
 * Sesión actual, sin factor y sin datos globales: solo si la propia cuenta es
 * personal activo. Sin sesión responde `{ staff: false }` (nada que revelar).
 */
export function createAccountAdminAccessRoute(deps: Pick<CoreDeps, "auth" | "ownerDb">) {
  const app = new Hono()
  app.get("/", async (c) => {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.json({ data: { staff: false } }, 200)
    const [row] = await deps.ownerDb
      .select({ active: adminStaff.active })
      .from(adminStaff)
      .where(eq(adminStaff.userId, session.user.id))
      .limit(1)
    return c.json({ data: { staff: row?.active === true } }, 200)
  })
  return app
}

/**
 * Frontera de factor nativo (montada ANTES de `auth.handler` en
 * `/api/auth/*`). El plugin twoFactor expone gestión sin prueba MFA
 * (`enable`/`disable`/`get-totp-uri`/`generate-backup-codes`); el staff DEBE
 * pasar por el wrapper admin (binding o reautenticación equivalente).
 * - Gestión: denegada a todo staff registrado, activo o no (la baja no
 *   borra la cuenta y una sesión residual no debe gestionar factores).
 * - `verify-totp`/`verify-backup-code`: abiertos SOLO sin sesión autenticada
 *   (challenge del login con cookie pendiente). Con sesión de staff (activa
 *   o no) se deniegan: el wrapper aplica claim anti-replay, presupuesto y
 *   binding. Jamás crean binding por sí solos.
 * Las llamadas `auth.api.*` servidor-a-servidor no pasan por aquí (proceso).
 */
export function createAdminFactorBoundary(deps: Pick<CoreDeps, "auth" | "ownerDb">) {
  return async (c: Context, next: Next) => {
    if (!c.req.path.startsWith("/api/auth/two-factor/")) {
      await next()
      return
    }
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) {
      await next()
      return
    }
    const [staff] = await deps.ownerDb
      .select({ userId: adminStaff.userId })
      .from(adminStaff)
      .where(eq(adminStaff.userId, session.user.id))
      .limit(1)
    if (!staff) {
      await next()
      return
    }
    return c.json(
      errorBody(c, "FORBIDDEN", "Gestiona tu segundo factor desde Seguridad de acceso"),
      403,
    )
  }
}
