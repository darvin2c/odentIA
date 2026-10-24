import { type ClinicalProduct, productWords } from "@odentia/clinical"
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
import { AGREEMENT_VERSION } from "./legal.js"
import { legalAcceptance } from "./terms.js"

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
  /** Cabecera con la IP de quien pide; vacía, ninguna (ver `clientIpAddress`). */
  clientIpHeader?: string
  /**
   * El producto en cuyo dominio va la sesión (odentIA o latidIA; decisión 9 del
   * issue 229): una instancia por dominio, con la misma base y el mismo secreto.
   * Da el nombre de la app (segundo factor, passkeys) y la marca de sus correos.
   */
  product?: ClinicalProduct
}

/**
 * De dónde toma Better Auth la IP de quien pide: con ella separa el límite de
 * intentos por persona (p. ej. 3 inicios de sesión cada 10 s) y anota la IP de
 * cada sesión.
 *
 * Una sola cabecera, la que el proxy de delante reescribe siempre con la
 * dirección que vio conectar. Cualquier otra la puede escribir el cliente y
 * estrenar un límite en cada intento. Por eso no varias (la que el proxy no
 * reescriba quedaría en manos del cliente) ni la lista por defecto de Better
 * Auth (`x-forwarded-for`, que los proxies alargan con lo que trajo el cliente).
 *
 * Sin cabecera, o si la petición no la trae o trae varias direcciones, Better
 * Auth no conoce la IP y aplica un único límite por ruta para todos: más
 * estricto, nunca sin límite.
 */
export function clientIpAddress(header: string | undefined): { ipAddressHeaders: string[] } {
  return { ipAddressHeaders: header ? [header.toLowerCase()] : [] }
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
  clientIpHeader,
  product = "dental",
}: CreateAuthOptions) {
  const { name: appName, brand } = productWords(product)
  return betterAuth({
    appName,
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
          ? changeEmailVerificationTemplate({ url, brand })
          : verifyEmailTemplate({ url, brand })
        await mailer.send({ to: user.email, ...template })
      },
    },
    user: {
      additionalFields: {
        firstName: { type: "string", required: false, defaultValue: "" },
        lastName: { type: "string", required: false, defaultValue: "" },
        // Lo pone el registro con correo (`legalAcceptance`); la fecha la escribe el servidor.
        termsVersion: { type: "string", required: false },
        termsAcceptedAt: { type: "date", required: false, input: false },
        // Contrato de encargo: solo quien abre una clínica; la clínica lo copia al crearse.
        processingAgreementVersion: { type: "string", required: false },
        processingAgreementAcceptedAt: { type: "date", required: false, input: false },
      },
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          const template = changeEmailConfirmationTemplate({ newEmail, url, brand })
          await mailer.send({ to: user.email, ...template })
        },
      },
    },
    advanced: {
      crossSubDomainCookies: { enabled: true, domain: cookieDomain },
      ipAddress: clientIpAddress(clientIpHeader),
    },
    trustedOrigins,
    // Denial de sesiones para cuentas con bloqueo global (tabla user_global_block).
    // Sin fallback fail-open: la frontera siempre rechaza closed/blocked.
    databaseHooks: {
      user: {
        create: {
          before: async (data) => {
            const now = new Date()
            return {
              data: {
                ...data,
                ...(typeof data.termsVersion === "string" && data.termsVersion ? { termsAcceptedAt: now } : {}),
                ...(typeof data.processingAgreementVersion === "string" && data.processingAgreementVersion
                  ? { processingAgreementAcceptedAt: now }
                  : {}),
              },
            }
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
      accessLink({ mailer, webURL, brand }),
      passwordBreachCheck({ enabled: breachCheck }),
      legalAcceptance(),
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
          clinician: defaultAc.newRole({
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
        organizationHooks: {
          beforeUpdateOrganization: lockClinicIdentityFields,
          // La clínica nace con el contrato de encargo que aceptó quien la abre; si no lo
          // aceptó (entró invitado a otra), se le pide en la clínica al entrar.
          afterCreateOrganization: async ({ organization: org, user }) => {
            if ((user as { processingAgreementVersion?: string | null }).processingAgreementVersion !== AGREEMENT_VERSION) return
            await ownerDb.execute(sql`
              insert into processing_agreement_acceptance (organization_id, version, accepted_by, accepted_at)
              values (${org.id}, ${AGREEMENT_VERSION}, ${user.id}, coalesce(
                (select processing_agreement_accepted_at from "user" where id = ${user.id}), now()))
              on conflict (organization_id, version) do nothing`)
          },
        },
        sendInvitationEmail: async ({ email, inviter, organization: org, invitation }) => {
          const template = invitationTemplate({
            organizationName: org.name,
            inviterName: inviter.user.name,
            url: `${webURL}/accept-invitation/${invitation.id}`,
            brand,
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
export { emailVerificationUrl, REMINDER_VERIFICATION_TTL_SECONDS } from "./email-verification.js"
export { AGREEMENT_VERSION, LEGAL, LEGAL_VERSION } from "./legal.js"
export { termsState } from "./terms.js"
export * from "./permissions.js"
