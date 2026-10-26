import { createHash } from "node:crypto"
import type { Db } from "@odentia/db"
import { adminTrustedDevice } from "@odentia/db/schema/admin-core"
import type { BetterAuthPlugin } from "better-auth"
import { createAuthMiddleware } from "better-auth/api"
import { and, eq, isNull } from "drizzle-orm"

/** Cookie del equipo reconocido de la administración (ADR 0090); la pone la API en `/api`. */
export const ADMIN_DEVICE_COOKIE = "odentia_admin_device"

/**
 * Cerrar sesión olvida el equipo reconocido de la administración (ADR 0090):
 * en un equipo prestado, quien entre después tendrá que poner el código. El
 * hash es el mismo con que lo guarda `trustAdminDevice`.
 */
export const forgetAdminDeviceOnSignOut = (ownerDb: Db) =>
  ({
    id: "forget-admin-device",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-out",
          handler: createAuthMiddleware(async (ctx) => {
            const cookie = ctx.headers?.get("cookie") ?? ""
            const token = cookie.match(new RegExp(`(?:^|;\\s*)${ADMIN_DEVICE_COOKIE}=([A-Za-z0-9_-]+)`))?.[1]
            if (!token) return
            await ownerDb
              .update(adminTrustedDevice)
              .set({ revokedAt: new Date() })
              .where(
                and(
                  eq(adminTrustedDevice.tokenHash, createHash("sha256").update(token, "utf8").digest("hex")),
                  isNull(adminTrustedDevice.revokedAt),
                ),
              )
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
