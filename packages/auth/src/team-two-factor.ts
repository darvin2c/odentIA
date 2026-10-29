import type { Db } from "@odentia/db"
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import { sql } from "drizzle-orm"

/**
 * La sesión que pasó el segundo factor (ADR 0107): la clínica que pide la
 * verificación exige esta marca, no solo que la persona la tenga activa. Así
 * no cuentan la vuelta de Google (Better Auth no pide el código ahí), las
 * sesiones abiertas solo con contraseña antes de activarla ni el enlace sin
 * código. Vive en `verification`, con el id de la sesión.
 */
export const SESSION_TWO_FACTOR_PREFIX = "2fa-session-"
const SESSION_MARK_TTL_MS = 400 * 86_400_000

/** Operaciones de Better Auth sobre el equipo de una clínica: piden la marca si la clínica pide la verificación. */
const TEAM_PATHS = new Set([
  "/organization/invite-member",
  "/organization/update-member-role",
  "/organization/remove-member",
  "/organization/cancel-invitation",
  "/organization/update",
  "/organization/delete",
])

/**
 * No se desactiva la verificación en dos pasos mientras una clínica de la
 * persona la pida a su equipo (ADR 0107): se puede cambiar de teléfono, no
 * quedarse sin ella. Ni se vuelve a activar estando activa. (Al personal de la
 * administración, `createAdminFactorBoundary` de la API ya le cierra
 * `/two-factor/*` por HTTP: su factor se maneja en la administración.)
 * Marca la sesión que pasó el código y protege las operaciones del equipo.
 * Sin sesión, Better Auth responde lo suyo.
 */
export const keepTwoFactorWhileRequired = (ownerDb: Db) =>
  ({
    id: "keep-two-factor-while-required",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/two-factor/disable",
          handler: createAuthMiddleware(async (ctx) => {
            const current = await getSessionFromCtx(ctx)
            if (!current) return
            const rows = await ownerDb.execute<{ name: string }>(sql`
              select o.name from member m
              join organization o on o.id = m.organization_id
              join org_profile p on p.organization_id = m.organization_id
              where m.user_id = ${current.user.id} and p.require_two_factor
              order by o.name`)
            const names = [...rows].map((row) => row.name)
            if (names.length > 0) {
              throw APIError.from("FORBIDDEN", {
                code: "TWO_FACTOR_REQUIRED_BY_CLINIC",
                message: `${names.join(", ")} la pide a su equipo: no puedes desactivarla`,
              })
            }
          }),
        },
        {
          // Solo lo que llega del navegador: la administración enrola al personal
          // llamando a `auth.api.enableTwoFactor` desde el servidor (sin `request`).
          matcher: (ctx) => ctx.path === "/two-factor/enable" && ctx.request !== undefined,
          handler: createAuthMiddleware(async (ctx) => {
            const current = await getSessionFromCtx(ctx)
            if (!current) return
            // Volver a activarla la deja sin confirmar hasta escribir un código nuevo:
            // quien la deje a medias no podría entrar. Para otro teléfono, la misma clave.
            if ((current.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled) {
              throw APIError.from("BAD_REQUEST", {
                code: "TWO_FACTOR_ALREADY_ENABLED",
                message: "Ya está activa: para otro teléfono usa «Cambiar de teléfono»",
              })
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path !== undefined && TEAM_PATHS.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const current = await getSessionFromCtx(ctx)
            if (!current) return
            const body = (ctx.body ?? {}) as { organizationId?: unknown }
            const orgId =
              typeof body.organizationId === "string"
                ? body.organizationId
                : ((current.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null)
            if (!orgId) return
            const rows = await ownerDb.execute(sql`
              select 1 from org_profile p
              where p.organization_id = ${orgId} and p.require_two_factor
                and not exists (
                  select 1 from verification v
                  where v.identifier = ${SESSION_TWO_FACTOR_PREFIX + current.session.id} and v.expires_at > now())
              limit 1`)
            if ([...rows].length > 0) {
              throw APIError.from("FORBIDDEN", {
                code: "TWO_FACTOR_REQUIRED",
                message: "Esta clínica pide verificación en dos pasos: escribe tu código o actívala en Mi perfil",
              })
            }
          }),
        },
      ],
      after: [
        {
          // El código de la app o uno de respaldo, al entrar, al activarla o en la
          // administración; y la entrada con contraseña que el navegador recordado
          // deja pasar (Better Auth borra la sesión si en cambio pide el código).
          matcher: (ctx) =>
            ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/verify-backup-code" || ctx.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.returned instanceof APIError) return
            let marked = ctx.context.newSession
            if (ctx.path === "/sign-in/email") {
              if (!marked || !(marked.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled) return
              const alive = await ctx.context.internalAdapter.findSession(marked.session.token)
              if (!alive) return
            } else {
              marked ??= await getSessionFromCtx(ctx)
            }
            if (!marked) return
            await ctx.context.internalAdapter.createVerificationValue({
              identifier: `${SESSION_TWO_FACTOR_PREFIX}${marked.session.id}`,
              value: marked.user.id,
              expiresAt: new Date(Date.now() + SESSION_MARK_TTL_MS),
            })
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
