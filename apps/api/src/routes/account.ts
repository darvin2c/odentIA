import type { Db } from "@odentia/db"
import {
  closeMyAccount,
  forgetTrustedBrowsers,
  getMyTwoFactor,
  leaveOrganization,
  listMyInvitations,
  listMyOrganizations,
} from "@odentia/services"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { AppDeps } from "../app.js"
import { errorBody } from "../lib/error.js"
import { runService, validationError } from "./helpers.js"

export interface AccountDeps extends Pick<AppDeps, "auth" | "ownerDb"> {}

const closeInput = z.object({
  confirm: z.literal(true, { message: "Confirma el cierre de tu cuenta" }),
})

interface AccountSession {
  userId: string
  email: string
}

/**
 * Cuenta propia del panel (`/api/account`; fuera del guard de org porque
 * opera sobre el usuario, no sobre una clínica). Exige sesión en cada
 * llamada; las escrituras las limita el servicio (bloqueados y último
 * propietario protegidos).
 */
export function createAccountRoute(deps: AccountDeps) {
  const app = new Hono()

  function owner<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return deps.ownerDb.transaction((tx) => fn(tx as Db))
  }

  async function accountSession(c: Context): Promise<AccountSession | null> {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return null
    return { userId: session.user.id, email: session.user.email }
  }

  app.get("/invitations/pending", async (c) => {
    const who = await accountSession(c)
    if (!who) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión requerida"), 401)
    return runService(c, 200, () => owner((tx) => listMyInvitations(tx, who.email)))
  })

  app.get("/organizations", async (c) => {
    const who = await accountSession(c)
    if (!who) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión requerida"), 401)
    return runService(c, 200, () => owner((tx) => listMyOrganizations(tx, who.userId)))
  })

  app.post("/organizations/:id/leave", async (c) => {
    const who = await accountSession(c)
    if (!who) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión requerida"), 401)
    return runService(c, 200, () =>
      owner((tx) => leaveOrganization(tx, who.userId, c.req.param("id"))).then(() => ({
        ok: true,
      })),
    )
  })

  // Verificación en dos pasos (ADR 0106): activar, cambiar de teléfono y los
  // códigos son de Better Auth; aquí, lo que Mi perfil dice y olvidar los
  // navegadores recordados.
  app.get("/two-factor", async (c) => {
    const who = await accountSession(c)
    if (!who) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión requerida"), 401)
    return runService(c, 200, () => getMyTwoFactor(deps.ownerDb, who.userId))
  })

  app.post("/two-factor/forget-browsers", async (c) => {
    const who = await accountSession(c)
    if (!who) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión requerida"), 401)
    return runService(c, 200, async () => ({ forgotten: await forgetTrustedBrowsers(deps.ownerDb, who.userId) }))
  })

  app.post("/close", async (c) => {
    const who = await accountSession(c)
    if (!who) return c.json(errorBody(c, "UNAUTHORIZED", "Sesión requerida"), 401)
    const parsed = closeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      owner((tx) => closeMyAccount(tx, who.userId)).then(() => ({ ok: true })),
    )
  })

  return app
}
