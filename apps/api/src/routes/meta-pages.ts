// «Conectar con Facebook» de Messenger e Instagram: inicio con sesión de la
// clínica y vuelta pública desde Facebook con el state firmado, como el correo.
// Montaje: app.route("/api/meta-pages", createMetaPagesRoute(...)), fuera de
// guarded porque la vuelta llega sin el contexto de la clínica.
import type { Auth } from "@odentia/auth"
import { type Db, withOrgContext } from "@odentia/db"
import {
  beginInstagramLogin,
  beginMetaPagesLogin,
  chooseMetaPage,
  completeInstagramLogin,
  completeMetaPagesLogin,
  type InstagramLoginConfig,
  listPagesToChoose,
  type MetaPagesApp,
  ServiceError,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf, requireOrgContext, requireSession } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { clinicReturnBase, orgOfOauthState } from "../lib/clinic-return.js"
import { runService, validationError } from "./helpers.js"

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
  /** «Conectar con Instagram»: la app de Instagram del caso de uso. Sin ella, Instagram usa Facebook. */
  instagram?: InstagramLoginConfig | undefined
  fetch?: typeof fetch
}

/** La app de Instagram (META_INSTAGRAM_*): con alguna de menos, apagado. */
export function instagramLoginFromEnv(env: {
  META_INSTAGRAM_APP_ID: string
  META_INSTAGRAM_APP_SECRET: string
  META_INSTAGRAM_REDIRECT_URI: string
  META_GRAPH_VERSION: string
}): InstagramLoginConfig | undefined {
  const appId = env.META_INSTAGRAM_APP_ID.trim()
  const appSecret = env.META_INSTAGRAM_APP_SECRET.trim()
  const redirectUri = env.META_INSTAGRAM_REDIRECT_URI.trim()
  if (!appId || !appSecret || !redirectUri) {
    if (appId || appSecret || redirectUri) {
      console.warn("«Conectar con Instagram» queda apagado: faltan META_INSTAGRAM_APP_ID, META_INSTAGRAM_APP_SECRET o META_INSTAGRAM_REDIRECT_URI.")
    }
    return undefined
  }
  return { appId, appSecret, redirectUri, graphVersion: env.META_GRAPH_VERSION }
}

const pickInput = z.object({
  pick: z.string().regex(/^[0-9a-f]{64}$/),
  pageId: z.string().regex(/^\d{1,40}$/),
  withInstagram: z.boolean(),
})

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
  authed.get("/status", (c) => c.json({ data: { enabled: Boolean(deps.app), instagram: Boolean(deps.instagram) } }, 200))

  // Las páginas que marcó en Facebook, sin sus claves, para elegir una.
  authed.get("/pick/:pick", async (c) => {
    const { memberRole, orgId, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Conecta los canales quien administra la clínica."), 403)
    }
    return runService(c, 200, () => listPagesToChoose(deps.ownerDb, deps.secretsKey, { pick: c.req.param("pick"), userId, orgId }))
  })

  // Conecta la página elegida (y, si se pide, su Instagram).
  authed.post("/pick", async (c) => {
    const { memberRole, orgId, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Conecta los canales quien administra la clínica."), 403)
    }
    const meta = deps.app
    if (!meta) return c.json(errorBody(c, "NOT_FOUND", "«Conectar con Facebook» no está disponible en esta instalación."), 404)
    const parsed = pickInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      chooseMetaPage(deps.ownerDb, (id, fn) => withOrgContext(deps.db, id, fn), deps.secretsKey, meta, { fetch: httpFetch }, {
        ...parsed.data,
        userId,
        orgId,
      }),
    )
  })

  authed.post("/instagram/start", async (c) => {
    const { memberRole, orgId, userId } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Conecta los canales quien administra la clínica."), 403)
    }
    const instagram = deps.instagram
    if (!instagram) return c.json(errorBody(c, "NOT_FOUND", "«Conectar con Instagram» no está disponible en esta instalación."), 404)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => beginInstagramLogin(tx, orgId, userId, deps.secretsKey, instagram)))
  })

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
    const state = params.get("state") ?? ""
    const code = params.get("code") ?? ""
    // La clínica se lee del state antes de usarlo: también se vuelve a ella si algo falla.
    const base = await clinicReturnBase(deps.ownerDb, webBase, await orgOfOauthState(deps.ownerDb, deps.secretsKey, state))
    const back = (query: string, page = "/settings/integrations"): Response => c.redirect(base ? `${base}${page}?${query}` : `${webBase}/`, 302)
    if (params.get("error") || !state || !code) return back("facebook=cancelado")
    if (!deps.app) return back("facebook=fallo")
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null)
    const userId = session?.user.id
    if (!userId) return back("facebook=sin-sesion")
    try {
      const done = await completeMetaPagesLogin(
        deps.ownerDb,
        (orgId, fn) => withOrgContext(deps.db, orgId, fn),
        deps.secretsKey,
        deps.app,
        { fetch: httpFetch },
        { state, code, userId },
      )
      // Varias páginas marcadas: se elige una en la página de Messenger.
      if (done.kind === "choose") return back(`facebook=elegir&pick=${done.pick}`, "/settings/integrations/messenger")
      // Solo cuántas: los nombres se ven en la lista al volver.
      const query = new URLSearchParams({
        facebook: "ok",
        messenger: String(done.messenger.length),
        instagram: String(done.instagram.length),
        sinig: String(done.withoutInstagram.length),
        otra: String(done.elsewhere.length),
      })
      return back(query.toString())
    } catch (error) {
      // Sin detalle de Meta en la dirección: queda en el registro del servidor.
      console.warn("[meta-pages] la vuelta de Facebook falló", error)
      const reason = error instanceof ServiceError && error.code === "NO_PAGES" ? "sin-paginas" : "fallo"
      return back(`facebook=${reason}`)
    }
  })

  // La vuelta de Instagram: como la de Facebook, a la página de Instagram.
  app.get("/instagram/callback", async (c) => {
    const params = new URL(c.req.url).searchParams
    const state = params.get("state") ?? ""
    const code = params.get("code") ?? ""
    const base = await clinicReturnBase(deps.ownerDb, webBase, await orgOfOauthState(deps.ownerDb, deps.secretsKey, state))
    const back = (result: string): Response => c.redirect(base ? `${base}/settings/integrations/instagram?conectado=${result}` : `${webBase}/`, 302)
    if (params.get("error") || !state || !code) return back("cancelado")
    if (!deps.instagram) return back("fallo")
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null)
    const userId = session?.user.id
    if (!userId) return back("sin-sesion")
    try {
      const done = await completeInstagramLogin(
        deps.ownerDb,
        (orgId, fn) => withOrgContext(deps.db, orgId, fn),
        deps.secretsKey,
        deps.instagram,
        { fetch: httpFetch },
        { state, code, userId },
      )
      return back(done.elsewhere ? "otra" : "ok")
    } catch (error) {
      console.warn("[meta-pages] la vuelta de Instagram falló", error)
      return back("fallo")
    }
  })

  app.route("/", authed)
  return app
}
