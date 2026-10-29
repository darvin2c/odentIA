import type { Db } from "@odentia/db"
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import { sql } from "drizzle-orm"

/**
 * No se desactiva la verificación en dos pasos mientras una clínica de la
 * persona la pida a su equipo (ADR 0107): se puede cambiar de teléfono, no
 * quedarse sin ella. Y el personal de odentIA no la enciende por esta vía: su
 * factor es el de la administración y su cuenta la deja apagada
 * (`keepStaffSignInWithoutFactor`). Ni se vuelve a activar estando activa.
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
            const rows = await ownerDb.execute(sql`select 1 from admin.admin_staff where user_id = ${current.user.id} limit 1`)
            if ([...rows].length > 0) {
              throw APIError.from("FORBIDDEN", {
                code: "STAFF_FACTOR",
                message: "Tu verificación es la de la administración de odentIA",
              })
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
