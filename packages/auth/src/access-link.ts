import { createHash } from "node:crypto"
import { accessLinkTemplate, type Mailer, passwordChangedTemplate } from "@odentia/mail"
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"
import { generateRandomString } from "better-auth/crypto"
import { z } from "zod"

/**
 * «¿Olvidaste tu contraseña?» con un enlace que deja a la persona dentro de su
 * clínica; adentro elige la nueva contraseña (lienzo «Recuperar el acceso»,
 * aprobado el 2026-10-17).
 *
 * Reglas:
 * - El enlace sirve una sola vez y dura 30 minutos; pedir otro anula el anterior.
 * - Pedirlo responde igual exista o no la cuenta (no revela quién tiene cuenta)
 *   y solo envía correo a una cuenta que existe. Como mucho 3 pedidos cada 15
 *   minutos por correo, cuente o no con cuenta.
 * - Con segundo factor el enlace no basta: deja pendiente el código, igual que
 *   entrar con contraseña (`twoFactor` de Better Auth no mira esta ruta).
 * - Entrar con el enlace deja una marca de 30 minutos ligada a esa sesión: solo
 *   con ella se puede fijar la contraseña sin escribir la anterior. Al
 *   guardarla se cierran las demás sesiones y llega un aviso por correo.
 *
 * Se escribe aparte del `magicLink` de Better Auth porque ese no anula enlaces
 * anteriores, envía correo aunque la cuenta no exista y se salta el segundo
 * factor.
 */

export const ACCESS_LINK_TTL_SECONDS = 30 * 60
const REQUEST_WINDOW_SECONDS = 15 * 60
const MAX_REQUESTS_PER_WINDOW = 3
/** Igual que el `twoFactorCookieMaxAge` por defecto de Better Auth. */
const TWO_FACTOR_COOKIE_MAX_AGE = 600
const TWO_FACTOR_COOKIE_NAME = "two_factor"

const LINK_PREFIX = "access-link:"
const SENT_PREFIX = "access-link-sent:"
const MARK_PREFIX = "password-link:"

export interface AccessLinkOptions {
  mailer: Mailer
  /** Origen del panel: adonde vuelve la persona tras abrir el enlace. */
  webURL: string
}

type PasswordMark = { session: string | null; createdAt: string }

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("base64url")
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** «9:20 (hora de Lima)» en la zona de quien pidió el enlace; sin una zona válida, nada. */
export function expiresText(at: Date, timeZone: string | undefined): string | undefined {
  if (!timeZone) return undefined
  try {
    const time = new Intl.DateTimeFormat("es", {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(at)
    const city = timeZone.split("/").pop()?.replace(/_/g, " ")
    return city ? `${time} (hora de ${city})` : time
  } catch {
    return undefined
  }
}

/** «Chrome en Windows» a partir del agente de usuario; sin datos claros, nada. */
export function deviceText(userAgent: string | null | undefined): string | undefined {
  if (!userAgent) return undefined
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : undefined
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /iPhone|iPad/.test(userAgent)
        ? "iPhone"
        : /Mac OS X/.test(userAgent)
          ? "Mac"
          : /Linux/.test(userAgent)
            ? "Linux"
            : undefined
  if (browser && os) return `${browser} en ${os}`
  return browser ?? os
}

/** La marca vale para la sesión que abrió el enlace o, si hubo segundo factor, para la que se creó después. */
export function markAllows(
  mark: PasswordMark,
  session: { token: string; createdAt: Date },
): boolean {
  if (mark.session) return mark.session === session.token
  return session.createdAt.getTime() >= new Date(mark.createdAt).getTime()
}

function parseMark(value: string): PasswordMark | null {
  try {
    const v = JSON.parse(value) as Partial<PasswordMark>
    if (typeof v.createdAt !== "string") return null
    return { session: typeof v.session === "string" ? v.session : null, createdAt: v.createdAt }
  } catch {
    return null
  }
}

const timeZoneSchema = z.string().max(64).optional()

export const accessLink = (options: AccessLinkOptions) => {
  const panel = options.webURL.replace(/\/$/, "")
  const expired = `${panel}/forgot-password?vencido=1`

  return {
    id: "access-link",
    endpoints: {
      requestAccessLink: createAuthEndpoint(
        "/access-link/request",
        {
          method: "POST",
          body: z.object({ email: z.string().email(), timeZone: timeZoneSchema }),
        },
        async (ctx) => {
          const email = normalizeEmail(ctx.body.email)
          const adapter = ctx.context.internalAdapter
          const now = new Date()

          // Límite por correo, también para los que no tienen cuenta: así no revela cuáles existen.
          const sentId = `${SENT_PREFIX}${sha256(email)}`
          const sent = await adapter.findVerificationValue(sentId)
          const live = sent && sent.expiresAt > now ? sent : null
          const count = live ? Number(live.value) || 0 : 0
          if (count >= MAX_REQUESTS_PER_WINDOW) {
            throw APIError.from("TOO_MANY_REQUESTS", {
              code: "ACCESS_LINK_TOO_MANY",
              message: "Ya te enviamos varios enlaces. Espera unos minutos.",
            })
          }
          if (sent) await adapter.deleteVerificationByIdentifier(sentId)
          await adapter.createVerificationValue({
            identifier: sentId,
            value: String(count + 1),
            expiresAt: live
              ? live.expiresAt
              : new Date(now.getTime() + REQUEST_WINDOW_SECONDS * 1000),
          })

          const found = await adapter.findUserByEmail(email)
          const user = found?.user
          if (!user) return ctx.json({ status: true })

          // Solo sirve el último enlace.
          await ctx.context.adapter.deleteMany({
            model: "verification",
            where: [
              { field: "identifier", operator: "starts_with", value: LINK_PREFIX },
              { field: "value", value: user.id },
            ],
          })
          const token = generateRandomString(32, "a-z", "A-Z", "0-9")
          const expiresAt = new Date(now.getTime() + ACCESS_LINK_TTL_SECONDS * 1000)
          await adapter.createVerificationValue({
            identifier: `${LINK_PREFIX}${sha256(token)}`,
            value: user.id,
            expiresAt,
          })
          const url = new URL(`${ctx.context.baseURL}/access-link/verify`)
          url.searchParams.set("token", token)
          const firstName = (user as { firstName?: string }).firstName || user.name.split(" ")[0]
          await options.mailer.send({
            to: user.email,
            ...accessLinkTemplate({
              firstName,
              url: url.toString(),
              expiresText: expiresText(expiresAt, ctx.body.timeZone),
            }),
          })
          return ctx.json({ status: true })
        },
      ),

      verifyAccessLink: createAuthEndpoint(
        "/access-link/verify",
        { method: "GET", query: z.object({ token: z.string().max(128) }) },
        async (ctx) => {
          const adapter = ctx.context.internalAdapter
          const record = await adapter.consumeVerificationValue(
            `${LINK_PREFIX}${sha256(ctx.query.token)}`,
          )
          if (!record || record.expiresAt < new Date()) throw ctx.redirect(expired)
          const user = await adapter.findUserById(record.value)
          if (!user) throw ctx.redirect(expired)
          // Abrir el enlace prueba que el correo es suyo.
          const verified = user.emailVerified
            ? user
            : await adapter.updateUser(user.id, { emailVerified: true })
          const now = new Date()
          const markExpires = new Date(now.getTime() + ACCESS_LINK_TTL_SECONDS * 1000)
          await adapter.deleteVerificationByIdentifier(`${MARK_PREFIX}${user.id}`)

          if ((user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled) {
            // Lo mismo que hace `twoFactor` al entrar con contraseña: sin sesión hasta el código.
            const identifier = `2fa-${generateRandomString(20)}`
            const twoFactorExpires = new Date(now.getTime() + TWO_FACTOR_COOKIE_MAX_AGE * 1000)
            await adapter.createVerificationValue({
              identifier,
              value: user.id,
              expiresAt: twoFactorExpires,
            })
            await adapter.createVerificationValue({
              identifier: `2fa-attempts-${identifier}`,
              value: "0",
              expiresAt: twoFactorExpires,
            })
            const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME, {
              maxAge: TWO_FACTOR_COOKIE_MAX_AGE,
            })
            await ctx.setSignedCookie(
              cookie.name,
              identifier,
              ctx.context.secret,
              cookie.attributes,
            )
            await adapter.createVerificationValue({
              identifier: `${MARK_PREFIX}${user.id}`,
              value: JSON.stringify({
                session: null,
                createdAt: now.toISOString(),
              } satisfies PasswordMark),
              expiresAt: markExpires,
            })
            throw ctx.redirect(`${panel}/two-factor?enlace=1`)
          }

          let session: Awaited<ReturnType<typeof adapter.createSession>>
          try {
            session = await adapter.createSession(user.id)
          } catch {
            // Cuenta bloqueada: el gancho de sesiones la rechaza.
            throw ctx.redirect(`${panel}/login?bloqueada=1`)
          }
          if (!session) throw ctx.redirect(expired)
          await setSessionCookie(ctx, { session, user: verified ?? user })
          await adapter.createVerificationValue({
            identifier: `${MARK_PREFIX}${user.id}`,
            value: JSON.stringify({
              session: session.token,
              createdAt: now.toISOString(),
            } satisfies PasswordMark),
            expiresAt: markExpires,
          })
          throw ctx.redirect(`${panel}/`)
        },
      ),

      accessLinkStatus: createAuthEndpoint(
        "/access-link/status",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const { session, user } = ctx.context.session
          const adapter = ctx.context.internalAdapter
          const record = await adapter.findVerificationValue(`${MARK_PREFIX}${user.id}`)
          const mark = record && record.expiresAt > new Date() ? parseMark(record.value) : null
          const pending = !!mark && markAllows(mark, session)
          const hasPassword = pending ? !!(await adapter.findCredentialAccount(user.id)) : true
          return ctx.json({ pending, hasPassword })
        },
      ),

      setPasswordFromAccessLink: createAuthEndpoint(
        "/access-link/set-password",
        {
          method: "POST",
          use: [sessionMiddleware],
          body: z.object({ newPassword: z.string(), timeZone: timeZoneSchema }),
        },
        async (ctx) => {
          const { session, user } = ctx.context.session
          const adapter = ctx.context.internalAdapter
          const markId = `${MARK_PREFIX}${user.id}`
          const record = await adapter.findVerificationValue(markId)
          const mark = record && record.expiresAt > new Date() ? parseMark(record.value) : null
          if (!mark || !markAllows(mark, session)) {
            throw APIError.from("FORBIDDEN", {
              code: "ACCESS_LINK_REQUIRED",
              message: "Para cambiarla así, entra con un enlace nuevo.",
            })
          }
          const { newPassword } = ctx.body
          const config = ctx.context.password.config
          if (newPassword.length < config.minPasswordLength) {
            throw APIError.from("BAD_REQUEST", {
              code: "PASSWORD_TOO_SHORT",
              message: `Usa al menos ${config.minPasswordLength} caracteres.`,
            })
          }
          if (newPassword.length > config.maxPasswordLength) {
            throw APIError.from("BAD_REQUEST", {
              code: "PASSWORD_TOO_LONG",
              message: `Usa como mucho ${config.maxPasswordLength} caracteres.`,
            })
          }
          const hash = await ctx.context.password.hash(newPassword)
          if (await adapter.findCredentialAccount(user.id))
            await adapter.updatePassword(user.id, hash)
          else
            await adapter.createAccount({
              userId: user.id,
              providerId: "credential",
              accountId: user.id,
              password: hash,
            })
          await adapter.deleteVerificationByIdentifier(markId)

          // Decisión 3: se cierran las demás sesiones; esta sigue abierta.
          const sessions = await adapter.listSessions(user.id)
          const others = sessions.map((s) => s.token).filter((token) => token !== session.token)
          if (others.length) await adapter.deleteSessions(others)

          const firstName = (user as { firstName?: string }).firstName || user.name.split(" ")[0]
          const when = new Date()
          let whenText: string
          try {
            whenText = new Intl.DateTimeFormat("es", {
              hour: "numeric",
              minute: "2-digit",
              timeZone: ctx.body.timeZone || "UTC",
              timeZoneName: ctx.body.timeZone ? undefined : "short",
            }).format(when)
          } catch {
            whenText = `${when.toISOString().slice(11, 16)} UTC`
          }
          try {
            await options.mailer.send({
              to: user.email,
              ...passwordChangedTemplate({
                firstName,
                whenText: `a las ${whenText}`,
                deviceText: deviceText(ctx.request?.headers.get("user-agent")),
                url: `${panel}/forgot-password`,
              }),
            })
          } catch {
            // La contraseña ya cambió: el aviso es un extra y no deshace el cambio.
          }
          return ctx.json({ status: true })
        },
      ),

      skipAccessLinkPassword: createAuthEndpoint(
        "/access-link/skip",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const { user } = ctx.context.session
          const adapter = ctx.context.internalAdapter
          // Solo quien entra únicamente con Google puede seguir sin contraseña.
          if (await adapter.findCredentialAccount(user.id)) {
            throw APIError.from("BAD_REQUEST", {
              code: "PASSWORD_REQUIRED",
              message: "Elige tu nueva contraseña para seguir.",
            })
          }
          await adapter.deleteVerificationByIdentifier(`${MARK_PREFIX}${user.id}`)
          return ctx.json({ status: true })
        },
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path: string) => path.startsWith("/access-link/"),
        window: 60,
        max: 10,
      },
    ],
  } satisfies BetterAuthPlugin
}
