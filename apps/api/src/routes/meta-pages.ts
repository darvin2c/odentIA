// «Conectar con Facebook» de Messenger e Instagram: inicio con sesión de la
// clínica y vuelta pública desde Facebook con el state firmado, como el correo.
// Montaje: app.route("/api/meta-pages", createMetaPagesRoute(...)), fuera de
// guarded porque la vuelta llega sin el contexto de la clínica.
import type { Auth } from "@odentia/auth"
import { type Db, withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { beginMetaPagesLogin, completeMetaPagesLogin, type MetaPagesApp, ServiceError } from "@odentia/services"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { canAccess, orgContextOf, requireOrgContext, requireSession } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { runService } from "./helpers.js"

export interface MetaPagesDeps {
  auth: Auth
  db: Db
  /** Rol owner: el state de un solo uso y la clínica de la vuelta, sin contexto de org. */
  ownerDb: Db
  secretsKey: Buffer
  /** Base pública de la clínica para volver (WEB_URL, con `?org=`, como el correo). */
  webUrl: string
  /** Sin la app ni la configuración de páginas, el botón no existe (404). */
  app?: MetaPagesApp | undefined
  fetch?: typeof fetch
}

/** Las variables de la configuración de páginas: con alguna de menos, apagado. */
export function metaPagesFromEnv(
  meta: { appId: string; appSecret: string; graphVersion: string } | undefined,
  env: { META_PAGES_CONFIG_ID: string; META_PAGES_REDIRECT_URI: string },
): MetaPagesApp | undefined {
  const configId = env.META_PAGES_CONFIG_ID.trim()
  const redirectUri = env.META_PAGES_REDIRECT_URI.trim()
  if (!meta || !configId || !redirectUri) {
    if (meta && (configId || redirectUri)) {
      console.warn("«Conectar con Facebook» de Messenger e Instagram queda apagado: faltan META_PAGES_CONFIG_ID o META_PAGES_REDIRECT_URI.")
    }
    return undefined
  }
  return { ...meta, configId, redirectUri }
}

export function createMetaPagesRoute(deps: MetaPagesDeps) {
  const app = new Hono()
  const httpFetch = deps.fetch ?? fetch
  const webBase = deps.webUrl.replace(/\/$/, "")

  const authed = new Hono()
  authed.use("*", requireSession({ auth: deps.auth }))
  authed.use("*", requireOrgContext({ db: deps.db, ownerDb: deps.ownerDb }))

  // Si está el botón: la pantalla lo ofrece solo entonces.
  authed.get("/status", (c) => c.json({ data: { enabled: Boolean(deps.app) } }, 200))

  // Empieza: la pantalla navega a la ventana de Facebook que devuelve.
  authed.post("/start", async (c) => {
    const { memberRole, orgId, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Conecta los canales quien administra la clínica."), 403)
    }
    const meta = deps.app
    if (!meta) return c.json(errorBody(c, "NOT_FOUND", "«Conectar con Facebook» no está disponible en esta instalación."), 404)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => beginMetaPagesLogin(tx, orgId, userId, deps.secretsKey, meta)))
  })

  // La vuelta de Facebook: la clínica y la persona viajan en el state firmado,
  // de un solo uso; la sesión tiene que ser la misma que lo empezó.
  app.get("/callback", async (c) => {
    const params = new URL(c.req.url).searchParams
    const back = (slug: string | null, query: string): Response => {
      const org = slug ? `org=${encodeURIComponent(slug)}&` : ""
      return c.redirect(`${webBase}/settings/integrations?${org}${query}`, 302)
    }
    const state = params.get("state") ?? ""
    const code = params.get("code") ?? ""
    if (params.get("error") || !state || !code) return back(null, "facebook=cancelado")
    if (!deps.app) return back(null, "facebook=fallo")
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null)
    const userId = session?.user.id
    if (!userId) return back(null, "facebook=sin-sesion")
    try {
      const done = await completeMetaPagesLogin(
        deps.ownerDb,
        (orgId, fn) => withOrgContext(deps.db, orgId, fn),
        deps.secretsKey,
        deps.app,
        { fetch: httpFetch },
        { state, code, userId },
      )
      const [org] = await deps.ownerDb
        .select({ slug: organization.slug })
        .from(organization)
        .where(eq(organization.id, done.orgId))
        .limit(1)
      // Solo cuántas: los nombres se ven en la lista al volver.
      const query = new URLSearchParams({
        facebook: "ok",
        messenger: String(done.messenger.length),
        instagram: String(done.instagram.length),
        sinig: String(done.withoutInstagram.length),
        otra: String(done.elsewhere.length),
      })
      return back(org?.slug ?? null, query.toString())
    } catch (error) {
      // Sin detalle de Meta en la dirección: queda en el registro del servidor.
      console.warn("[meta-pages] la vuelta de Facebook falló", error)
      const reason = error instanceof ServiceError && error.code === "NO_PAGES" ? "sin-paginas" : "fallo"
      return back(null, `facebook=${reason}`)
    }
  })

  app.route("/", authed)
  return app
}
