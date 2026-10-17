import type { BetterAuthPlugin } from "better-auth"
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  sessionMiddleware,
} from "better-auth/api"
import { z } from "zod"

import { AGREEMENT_VERSION, LEGAL, LEGAL_VERSION } from "./legal.js"

type LegalUser = { termsVersion?: string | null; processingAgreementVersion?: string | null }

/** Lo que le falta aceptar a una persona: nada, la primera vez o una versión nueva. */
export function termsState(user: LegalUser): "ok" | "first" | "updated" {
  if (user.termsVersion === LEGAL_VERSION) return "ok"
  return user.termsVersion ? "updated" : "first"
}

const acceptBody = z.object({
  termsVersion: z.string().max(32),
  processingAgreementVersion: z.string().max(32).optional(),
})

function checkVersions(body: {
  termsVersion?: unknown
  processingAgreementVersion?: unknown
}): void {
  const terms = body.termsVersion
  const agreement = body.processingAgreementVersion
  if (terms !== LEGAL_VERSION || (agreement !== undefined && agreement !== AGREEMENT_VERSION)) {
    const outdated = !!terms
    throw APIError.from("BAD_REQUEST", {
      code: outdated ? "TERMS_OUTDATED" : "TERMS_REQUIRED",
      message: outdated
        ? "Los documentos cambiaron. Recarga la página para leer la versión vigente."
        : "Acepta los documentos para seguir.",
    })
  }
}

/**
 * Crear cuenta con correo exige aceptar la versión vigente (y el contrato de
 * encargo si abre una clínica). Quien entra con Google acepta después, en
 * «Un paso antes de seguir» (`/legal/accept`); quien ya tenía cuenta, cuando
 * cambian (`/legal/status` dice qué le falta).
 */
export const legalAcceptance = () =>
  ({
    id: "legal-acceptance",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-up/email",
          handler: createAuthMiddleware(async (ctx) => {
            checkVersions((ctx.body ?? {}) as Record<string, unknown>)
          }),
        },
      ],
    },
    endpoints: {
      legalStatus: createAuthEndpoint(
        "/legal/status",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const user = ctx.context.session.user as LegalUser
          return ctx.json({
            terms: {
              state: termsState(user),
              version: LEGAL.terms.version,
              effectiveAt: LEGAL.terms.effectiveAt,
              changes: LEGAL.terms.changes,
            },
            agreement: {
              accepted: user.processingAgreementVersion === AGREEMENT_VERSION,
              version: LEGAL.agreement.version,
            },
          })
        },
      ),
      acceptLegal: createAuthEndpoint(
        "/legal/accept",
        { method: "POST", use: [sessionMiddleware], body: acceptBody },
        async (ctx) => {
          checkVersions(ctx.body)
          const now = new Date()
          await ctx.context.internalAdapter.updateUser(ctx.context.session.user.id, {
            termsVersion: ctx.body.termsVersion,
            termsAcceptedAt: now,
            ...(ctx.body.processingAgreementVersion
              ? {
                  processingAgreementVersion: ctx.body.processingAgreementVersion,
                  processingAgreementAcceptedAt: now,
                }
              : {}),
          })
          return ctx.json({ status: true })
        },
      ),
    },
  }) satisfies BetterAuthPlugin
