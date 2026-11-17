/**
 * «Conectar con Instagram»: Instagram API con inicio de sesión de Instagram
 * (Business Login), por redirección como Gmail. Sirve a una cuenta profesional
 * de Instagram con o sin página de Facebook unida. Usa la «app de Instagram»
 * del caso de uso de Instagram de la app de odentIA: su propio identificador y
 * su propia clave secreta, distintos de los de Facebook.
 *
 * - Ventana: `https://www.instagram.com/oauth/authorize?client_id&redirect_uri&response_type=code&scope&state`
 * - Código → clave corta: `POST https://api.instagram.com/oauth/access_token` (formulario)
 * - Clave corta → larga (60 días): `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token`
 * - Cuenta: `GET https://graph.instagram.com/<v>/me?fields=user_id,username`
 * - Avisos: `POST https://graph.instagram.com/<v>/me/subscribed_apps?subscribed_fields=…`
 *   https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
 *
 * La clave larga se renueva sola cada 7 días (`refreshInstagramLoginToken`).
 * Sin probar contra Meta real: las respuestas son las que publica Meta.
 */
import type { ChannelAdapterDeps } from "./protocol.js"
import { failure, type GraphAnswer, MetaSignupError, type MetaSignupStep, succeeded } from "./whatsapp-embedded-signup.js"

const IG_GRAPH = "https://graph.instagram.com"

/** La app de Instagram del caso de uso: identificador, clave secreta y versión del Graph. */
export interface InstagramLoginApp {
  appId: string
  appSecret: string
  graphVersion: string
}

/** Lo que pide la ventana: leer la cuenta y sus mensajes directos. */
export const INSTAGRAM_LOGIN_SCOPES = ["instagram_business_basic", "instagram_business_manage_messages"]

export function buildInstagramLoginUrl(app: Pick<InstagramLoginApp, "appId">, input: { redirectUri: string; state: string }): string {
  const query = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: INSTAGRAM_LOGIN_SCOPES.join(","),
    state: input.state,
  })
  return `https://www.instagram.com/oauth/authorize?${query.toString()}`
}

async function call(step: MetaSignupStep, url: string, init: RequestInit, deps: ChannelAdapterDeps): Promise<GraphAnswer> {
  let res: Response
  try {
    res = await deps.fetch(url, init)
  } catch {
    throw new MetaSignupError(step, 0, null, "Instagram no respondió")
  }
  const raw = await res.text().catch(() => "")
  let json: unknown = null
  try {
    json = JSON.parse(raw) as unknown
  } catch {
    json = null
  }
  return { status: res.status, json, raw }
}

const field = (json: unknown, key: string): unknown => (json && typeof json === "object" ? (json as Record<string, unknown>)[key] : undefined)

/** La cuenta conectada: su identificador (el que traen los avisos), su usuario y la clave larga. */
export interface InstagramLoginAccount {
  userId: string
  username: string | null
  accessToken: string
  expiresInSeconds: number | null
}

/** Cambia el código por la clave larga y lee la cuenta. */
export async function completeInstagramLoginCode(
  app: InstagramLoginApp,
  input: { code: string; redirectUri: string },
  deps: ChannelAdapterDeps,
): Promise<InstagramLoginAccount> {
  const form = new URLSearchParams({
    client_id: app.appId,
    client_secret: app.appSecret,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
    // Instagram agrega «#_» al final del código en la redirección.
    code: input.code.replace(/#_$/, ""),
  })
  const first = await call(
    "canjear",
    "https://api.instagram.com/oauth/access_token",
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() },
    deps,
  )
  // La respuesta llega sola o dentro de `data: [ … ]`, según la versión.
  const data = field(first.json, "data")
  const shortBody = Array.isArray(data) ? data[0] : first.json
  const shortToken = field(shortBody, "access_token")
  if (first.status >= 400 || typeof shortToken !== "string" || !shortToken) throw failure("canjear", first)
  const long = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: app.appSecret, access_token: shortToken })
  // La guía la muestra sin versión; si Instagram no la acepta así, con la versión del Graph.
  let second = await call("canjear", `${IG_GRAPH}/access_token?${long.toString()}`, { method: "GET" }, deps)
  if (second.status >= 400) {
    // Sin la clave: solo su tipo (las primeras letras) y lo que respondió Instagram.
    console.warn(
      `[instagram] la clave larga no salió sin versión (clave corta ${shortToken.slice(0, 4)}…, ${second.status}): ${second.raw.slice(0, 300)}`,
    )
    second = await call("canjear", `${IG_GRAPH}/${app.graphVersion}/access_token?${long.toString()}`, { method: "GET" }, deps)
  }
  const longToken = field(second.json, "access_token")
  if (second.status >= 400 || typeof longToken !== "string" || !longToken) {
    console.warn(`[instagram] la clave larga tampoco salió con versión (${second.status}): ${second.raw.slice(0, 300)}`)
    throw failure("canjear", second)
  }
  const expires = field(second.json, "expires_in")
  const me = await call(
    "leer",
    `${IG_GRAPH}/${app.graphVersion}/me?fields=user_id,username`,
    { method: "GET", headers: { Authorization: `Bearer ${longToken}` } },
    deps,
  )
  const userId = field(me.json, "user_id") ?? field(me.json, "id")
  if (me.status >= 400 || (typeof userId !== "string" && typeof userId !== "number")) throw failure("leer", me)
  const username = field(me.json, "username")
  return {
    userId: String(userId),
    username: typeof username === "string" && username ? username : null,
    accessToken: longToken,
    expiresInSeconds: typeof expires === "number" ? expires : null,
  }
}

/** Lo que escucha la app de cada cuenta: mensajes, botones y lecturas. */
export const INSTAGRAM_LOGIN_FIELDS = ["messages", "messaging_postbacks", "messaging_seen"]

/** Suscribe la app a los avisos de la cuenta. Repetirla no cambia nada. */
export async function subscribeAppToInstagram(
  app: Pick<InstagramLoginApp, "graphVersion">,
  accessToken: string,
  deps: ChannelAdapterDeps,
): Promise<void> {
  const query = new URLSearchParams({ subscribed_fields: INSTAGRAM_LOGIN_FIELDS.join(",") })
  const answer = await call(
    "suscribir",
    `${IG_GRAPH}/${app.graphVersion}/me/subscribed_apps?${query.toString()}`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } },
    deps,
  )
  if (answer.status >= 400 || !succeeded(answer.json)) throw failure("suscribir", answer)
}
