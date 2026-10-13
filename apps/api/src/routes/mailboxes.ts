// API de buzones de correo (Gmail / Microsoft 365): estado, inicio OAuth,
// callback público con state firmado y gestión de la conexión.
// Montaje del padre (una línea, junto a webhooks, fuera de guarded):
// app.route("/api/mail", createMailboxesRoute({ auth: deps.auth, db: deps.db,
//   ownerDb: deps.ownerDb, secretsKey: deps.secretsKey, webUrl: deps.webURL,
//   mailbox: { gmail: {...}, microsoft365: {...} }, fetch }))
// Permisos: lectura de metadatos con conversations.read (recepción puede ver
// para conversar); conectar/probar/desconectar con settings.write.
import type { Auth } from "@odentia/auth"
import { type Db, withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { channelConnection } from "@odentia/db/schema/crm"
import {
  beginMailboxOAuth,
  completeMailboxOAuth,
  disconnectMailbox,
  listMailboxConnections,
  mailboxProviderStatus,
  type MailboxEnv,
  notFound,
  ServiceError,
  testMailboxConnection,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf, requireOrgContext, requireSession } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { runService, validationError } from "./helpers.js"

export interface MailboxesDeps {
  auth: Auth
  /** Rol app: operaciones bajo RLS de la org. */
  db: Db
  /** Rol owner: nonce OAuth y slug para el redirect (sin contexto de org). */
  ownerDb: Db
  secretsKey: Buffer
  /** Base pública del panel para el redirect post-OAuth (WEB_URL). */
  webUrl: string
  /** Clientes OAuth por proveedor; ausente = deshabilitado explícito. */
  mailbox: MailboxEnv
  fetch?: typeof fetch
}

const startInput = z.object({
  provider: z.enum(["gmail", "microsoft365"]),
})

function forbid(c: Parameters<typeof orgContextOf>[0], permission: string) {
  const { memberRole } = orgContextOf(c)
  if (!canAccess(memberRole, permission)) {
    return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para esta operación"), 403)
  }
  return null
}

export function createMailboxesRoute(deps: MailboxesDeps) {
  const app = new Hono()
  const httpFetch = deps.fetch ?? fetch
  const webBase = deps.webUrl.replace(/\/$/, "")

  // Montado fuera de guarded (el callback es público): todo salvo el callback
  // exige sesión + membresía verificada con los mismos guards centrales.
  const authed = new Hono()
  authed.use("*", requireSession({ auth: deps.auth }))
  authed.use("*", requireOrgContext({ db: deps.db }))

  // Conexiones y metadatos de proveedores (configurado o no, sin secretos): recepción lee.
  authed.get("/connections", async (c) => {
    const denied = forbid(c, "conversations.read")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => ({
        providers: mailboxProviderStatus(deps.mailbox),
        connections: await listMailboxConnections(tx, orgId),
      })),
    )
  })

  // Inicia OAuth: devuelve la URL del proveedor (la UI navega a ella).
  authed.post("/oauth/start", async (c) => {
    const denied = forbid(c, "settings.write")
    if (denied) return denied
    const parsed = startInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        beginMailboxOAuth(tx, orgId, userId, deps.secretsKey, deps.mailbox, parsed.data.provider),
      ),
    )
  })

  // Callback público del proveedor: la org y el usuario viajan en el state
  // firmado + nonce de un solo uso (no se confía en sesión activa ni slug).
  app.get("/oauth/callback", async (c) => {
    const params = new URL(c.req.url).searchParams
    const providerError = params.get("error")
    const state = params.get("state") ?? ""
    const code = params.get("code") ?? ""
    const back = (orgSlug: string | null, query: string): Response => {
      const org = orgSlug ? `?org=${encodeURIComponent(orgSlug)}&${query}` : `?${query}`
      return c.redirect(`${webBase}/settings/mail${org}`, 302)
    }
    if (providerError || !state || !code) {
      return back(null, "error=oauth-denegado")
    }
    const session = await deps.auth.api
      .getSession({ headers: c.req.raw.headers })
      .catch(() => null)
    const userId = session?.user.id
    if (!userId) return back(null, "error=oauth-sin-sesion")
    try {
      const done = await completeMailboxOAuth(
        deps.ownerDb,
        (orgId, fn) => withOrgContext(deps.db, orgId, fn),
        deps.secretsKey,
        deps.mailbox,
        { fetch: httpFetch },
        { state, code, userId },
      )
      return back(await slugOfConnection(done.connectionId), `buzon=${done.provider}&ok=1`)
    } catch {
      // Sin volcar detalle del proveedor: la UI muestra el motivo genérico y
      // el reintento. El error queda en el log del servidor (onError).
      return back(null, "error=oauth-fallo")
    }
  })

  async function slugOfConnection(connectionId: string): Promise<string | null> {
    const [conn] = await deps.ownerDb
      .select({ organizationId: channelConnection.organizationId })
      .from(channelConnection)
      .where(eq(channelConnection.id, connectionId))
      .limit(1)
      .catch(() => [])
    if (!conn) return null
    const [org] = await deps.ownerDb
      .select({ slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, conn.organizationId))
      .limit(1)
      .catch(() => [])
    return org?.slug ?? null
  }

  authed.post("/:id/test", async (c) => {
    const denied = forbid(c, "settings.write")
    if (denied) return denied
    const { orgId } = orgContextOf(c)
    const id = c.req.param("id")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const current = await listMailboxConnections(tx, orgId)
        const found = current.find((conn) => conn.id === id)
        if (!found) throw notFound("Conexión de correo")
        const client = deps.mailbox[found.provider]
        if (!client?.clientId || !client.clientSecret || !client.redirectUri) {
          throw new ServiceError(
            "MAILBOX_NOT_CONFIGURED",
            503,
            "Proveedor no configurado en este entorno: la conexión queda deshabilitada",
          )
        }
        return testMailboxConnection(tx, orgId, id, deps.secretsKey, client, {
          fetch: httpFetch,
        })
      }),
    )
  })

  authed.post("/:id/disconnect", async (c) => {
    const denied = forbid(c, "settings.write")
    if (denied) return denied
    const { orgId, userId } = orgContextOf(c)
    const id = c.req.param("id")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        disconnectMailbox(tx, orgId, id, userId, deps.secretsKey, { fetch: httpFetch }),
      ),
    )
  })

  app.route("/", authed)
  return app
}
