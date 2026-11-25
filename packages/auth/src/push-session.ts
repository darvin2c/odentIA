import type { Db } from "@odentia/db"
import type { BetterAuthPlugin } from "better-auth"
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api"
import { sql } from "drizzle-orm"

/**
 * Los avisos del equipo van atados a la sesión y se borran con ella (ADR 0215). Cambiar la
 * contraseña cierra todas las sesiones, también la de este navegador, y abre una nueva: sin esto,
 * este equipo dejaría de recibir los avisos sin que nadie lo note. Antes se sueltan de la sesión
 * que se va a cerrar y después se atan a la nueva.
 */
export const keepPushOnPasswordChange = (ownerDb: Db) =>
  ({
    id: "keep-push-on-password-change",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/change-password",
          handler: createAuthMiddleware(async (ctx) => {
            const current = await getSessionFromCtx(ctx).catch(() => null)
            if (!current) return
            await ownerDb.execute(
              sql`update push_subscription set session_id = null where session_id = ${current.session.id}`,
            )
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/change-password",
          handler: createAuthMiddleware(async (ctx) => {
            // Si el cambio no se hizo (la contraseña actual no coincidía), vuelven a la sesión de siempre.
            const kept = ctx.context.newSession ?? (await getSessionFromCtx(ctx).catch(() => null))
            if (!kept) return
            await ownerDb.execute(
              sql`update push_subscription set session_id = ${kept.session.id} where session_id is null and user_id = ${kept.user.id}`,
            )
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
