import type { Db } from "@odentia/db"
import {
  changeEmailConfirmationTemplate,
  changeEmailVerificationTemplate,
  invitationTemplate,
  type Mailer,
  verifyEmailTemplate,
} from "@odentia/mail"
import { betterAuth } from "better-auth"
import { APIError } from "better-auth/api"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { organization } from "better-auth/plugins"
import { adminAc, defaultAc, memberAc, ownerAc } from "better-auth/plugins/organization/access"
import { twoFactor } from "better-auth/plugins"
import { sql } from "drizzle-orm"
import { accessLink } from "./access-link.js"
import { passwordBreachCheck } from "./password-breach.js"
import { requireTermsOnSignUp } from "./terms.js"

export interface CreateAuthOptions {
  db: Db
  mailer: Mailer
  secret: string
  baseURL: string
  webURL: string
  cookieDomain: string
  trustedOrigins: string[]
  /** Client ID de Google OAuth; vacío si no hay OAuth configurado. */
  googleClientId: string
  /** Client secret de Google OAuth; vacío si no hay OAuth configurado. */
  googleClientSecret: string
  /** Conexión owner: denial de sesiones con bloqueo global activo. */
  ownerDb: Db
  /** Rechazar contraseñas filtradas (Have I Been Pwned); se apaga en pruebas sin red. */
  passwordBreachCheck?: boolean
}

function isChangeEmailToken(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
      requestType?: string
    }
    return payload.requestType === "change-email-verification"
  } catch {
    return false
  }
}

export function createAuth({
  db,
  mailer,
  secret,
  baseURL,
  webURL,
  cookieDomain,
  trustedOrigins,
  googleClientId,
  googleClientSecret,
  ownerDb,
  passwordBreachCheck: breachCheck = true,
}: CreateAuthOptions) {
  return betterAuth({
    appName: "odentIA",
    secret,
    baseURL,
    database: drizzleAdapter(db, { provider: "pg" }),
    socialProviders: {
      ...(googleClientId && googleClientSecret
        ? { google: { clientId: googleClientId, clientSecret: googleClientSecret } }
        : {}),
    },
    // Sin `sendResetPassword`: la contraseña olvidada se recupera con el enlace
    // de acceso (`access-link.ts`), que deja a la persona adentro.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url, token }) => {
        const template = isChangeEmailToken(token)
          ? changeEmailVerificationTemplate({ url })
          : verifyEmailTemplate({ url })
        await mailer.send({ to: user.email, ...template })
      },
    },
    user: {
      additionalFields: {
        firstName: { type: "string", required: false, defaultValue: "" },
        lastName: { type: "string", required: false, defaultValue: "" },
        // Lo pone el registro con correo (`requireTermsOnSignUp`); la fecha la escribe el servidor.
        termsVersion: { type: "string", required: false },
        termsAcceptedAt: { type: "date", required: false, input: false },
      },
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          const template = changeEmailConfirmationTemplate({ newEmail, url })
          await mailer.send({ to: user.email, ...template })
        },
      },
    },
    advanced: {
      crossSubDomainCookies: { enabled: true, domain: cookieDomain },
    },
    trustedOrigins,
    // Denial de sesiones para cuentas con bloqueo global (tabla user_global_block).
    // Sin fallback fail-open: la frontera siempre rechaza closed/blocked.
    databaseHooks: {
      user: {
        create: {
          before: async (data) => {
            if (typeof data.termsVersion === "string" && data.termsVersion) {
              return { data: { ...data, termsAcceptedAt: new Date() } }
            }
            return { data }
          },
        },
      },
      session: {
        create: {
          before: async (created) => {
            // Despliegue exige migraciones antes del API: sin tolerancias.
            // Un error de infra propaga (no suprime el denial).
            const rows = await ownerDb.execute(
              sql`select 1 from "user_global_block" where "user_id" = ${created.userId} and "active" and ("expires_at" is null or "expires_at" > now()) limit 1`,
            )
            if (Array.isArray(rows) && rows.length > 0) {
              throw APIError.from("FORBIDDEN", { code: "ACCOUNT_BLOCKED", message: "Cuenta bloqueada" })
            }
            return { data: created }
          },
        },
      },
    },
    plugins: [
      // Segundo factor TOTP del personal admin (estándar Better Auth: sin
      // cripto propia; secreto + códigos de respaldo cifrados en `two_factor`).
      // Aditivo: el panel no cambia salvo que alguien lo active. Solo TOTP;
      // sin OTP por correo/SMS (sin otpOptions el método `otp` queda inútil).
      // allowPasswordless: las cuentas solo-OAuth (Google) enrolan con sesión
      // fresca verificada en /api/admin/access (regla propia); con credencial
      // siempre exige contraseña. Solo lo enrolan staff (única UI).
      twoFactor({ allowPasswordless: true }),
      accessLink({ mailer, webURL }),
      passwordBreachCheck({ enabled: breachCheck }),
      requireTermsOnSignUp(),
      organization({
        // `permissions.ts` decida por dominio. Sin gestión de miembros ni
        // invitaciones (igual que `member`): solo owner/admin administran,
        // BetterAuth impide la escalada propia y el último owner persiste.
        roles: {
          owner: ownerAc,
          admin: adminAc,
          member: memberAc,
          reception: defaultAc.newRole({
            organization: [],
            member: [],
            invitation: [],
            team: [],
            ac: ["read"],
          }),
          dentist: defaultAc.newRole({
            organization: [],
            member: [],
            invitation: [],
            team: [],
            ac: ["read"],
          }),
          cashier: defaultAc.newRole({
            organization: [],
            member: [],
            invitation: [],
            team: [],
            ac: ["read"],
          }),
        },
        organizationHooks: { beforeUpdateOrganization: lockClinicIdentityFields },
        sendInvitationEmail: async ({ email, inviter, organization: org, invitation }) => {
          const template = invitationTemplate({
            organizationName: org.name,
            inviterName: inviter.user.name,
            url: `${webURL}/accept-invitation/${invitation.id}`,
          })
          await mailer.send({ to: email, ...template })
        },
      }),
    ],
  })
}

/**
 * `/api/auth/organization/update` no cambia el logo ni el nombre de la
 * clínica: el logo se sube en «Datos de la clínica» (`/org-profile/logo`, que
 * solo borra dentro de su carpeta) y el nombre visible sale del nombre
 * comercial (ADR 0043). Una dirección de logo guardada a mano podría apuntar
 * al de otra clínica y borrarlo al cambiarlo.
 */
export async function lockClinicIdentityFields({ organization: changes }: { organization: Record<string, unknown> }): Promise<void> {
  if ("logo" in changes || "name" in changes) {
    throw APIError.from("FORBIDDEN", {
      code: "ORGANIZATION_FIELD_LOCKED",
      message: "El logo y el nombre se cambian en «Datos de la clínica»",
    })
  }
}

export type Auth = ReturnType<typeof createAuth>
export type Session = Auth["$Infer"]["Session"]
export { ACCESS_LINK_TTL_SECONDS } from "./access-link.js"
export { LEGAL_VERSION } from "./terms.js"
export * from "./permissions.js"
