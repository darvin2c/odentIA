import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"

/**
 * Versión vigente de los Términos del servicio, el Aviso de privacidad y el
 * Contrato de encargo de tratamiento: la fecha que muestran en la web
 * (`LEGAL_UPDATED_ISO` de `apps/web/src/lib/legal/types.ts`). Se cambian juntas.
 */
export const LEGAL_VERSION = "2026-10-17"

/**
 * Crear una cuenta con correo exige aceptar los tres documentos en su versión
 * vigente; la cuenta guarda cuál y cuándo (`user.terms_version`,
 * `user.terms_accepted_at`). Si la pantalla quedó con una versión anterior, se
 * le pide recargar en vez de guardar una aceptación de otro texto.
 */
export const requireTermsOnSignUp = () =>
  ({
    id: "require-terms-on-sign-up",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-up/email",
          handler: createAuthMiddleware(async (ctx) => {
            const version = (ctx.body as { termsVersion?: unknown } | undefined)?.termsVersion
            if (version !== LEGAL_VERSION) {
              throw APIError.from("BAD_REQUEST", {
                code: version ? "TERMS_OUTDATED" : "TERMS_REQUIRED",
                message: version
                  ? "Los documentos cambiaron. Recarga la página para leer la versión vigente."
                  : "Acepta los términos, el aviso de privacidad y el contrato de encargo para crear tu cuenta.",
              })
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
