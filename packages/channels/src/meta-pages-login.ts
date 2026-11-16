/**
 * «Conectar con Facebook» de Messenger e Instagram: Facebook Login for Business
 * por redirección, como Gmail. La clínica va a la ventana de Facebook con la
 * configuración de páginas de la app de odentIA, marca sus páginas (y el
 * Instagram unido a cada una) y vuelve a una dirección fija de la API con un
 * código. Con él se pide la clave de la persona, se cambia por una de larga
 * duración y de ahí salen las claves de cada página, que no vencen mientras la
 * persona siga administrando la página y no quite el permiso.
 *
 * - Ventana: `https://www.facebook.com/<v>/dialog/oauth?client_id&redirect_uri&state&config_id&response_type=code`
 *   https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
 * - Clave larga: `GET /oauth/access_token?grant_type=fb_exchange_token`
 *   https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 * - Páginas: `GET /me/accounts?fields=id,name,access_token,instagram_business_account{id,username}`
 * - Avisos de la página: `POST /<PAGE-ID>/subscribed_apps?subscribed_fields=…`
 *   https://developers.facebook.com/docs/messenger-platform/webhooks
 *
 * Sin probar contra Meta real: la app de odentIA todavía no tiene aprobados los
 * permisos de páginas e Instagram. Las respuestas son las que publica Meta.
 */
import type { ChannelAdapterDeps } from "./protocol.js"
import {
  base,
  failure,
  graph,
  type MetaPlatformApp,
  MetaSignupError,
  succeeded,
} from "./whatsapp-embedded-signup.js"

/** Lo que pide la ventana: los permisos los fija la configuración (`config_id`). */
export function buildPagesLoginUrl(
  app: Pick<MetaPlatformApp, "appId" | "graphVersion">,
  input: { configId: string; redirectUri: string; state: string },
): string {
  const query = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: input.redirectUri,
    state: input.state,
    config_id: input.configId,
    response_type: "code",
    override_default_response_type: "true",
  })
  return `https://www.facebook.com/${app.graphVersion}/dialog/oauth?${query.toString()}`
}

/** El código de la ventana, cambiado por la clave de larga duración de la persona. */
export async function exchangePagesCode(
  app: MetaPlatformApp,
  input: { code: string; redirectUri: string },
  deps: ChannelAdapterDeps,
): Promise<string> {
  const short = new URLSearchParams({
    client_id: app.appId,
    client_secret: app.appSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
  })
  const first = await graph("canjear", `${base(app)}/oauth/access_token?${short.toString()}`, { method: "GET" }, deps)
  const shortToken = tokenOf(first.json)
  if (first.status >= 400 || !shortToken) throw failure("canjear", first)
  // La de larga duración: de ella salen claves de página que no vencen.
  const long = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: app.appId,
    client_secret: app.appSecret,
    fb_exchange_token: shortToken,
  })
  const second = await graph("canjear", `${base(app)}/oauth/access_token?${long.toString()}`, { method: "GET" }, deps)
  const longToken = tokenOf(second.json)
  if (second.status >= 400 || !longToken) throw failure("canjear", second)
  return longToken
}

function tokenOf(json: unknown): string | null {
  return json && typeof json === "object" && "access_token" in json && typeof json.access_token === "string" && json.access_token
    ? json.access_token
    : null
}

/** Una página que la persona dejó compartir, con su clave y el Instagram unido, si tiene. */
export interface SharedPage {
  id: string
  name: string
  accessToken: string
  instagram: { id: string; username: string | null } | null
}

/** Las páginas que la persona marcó en la ventana, con su clave y su Instagram. */
export async function listSharedPages(
  app: Pick<MetaPlatformApp, "graphVersion">,
  userToken: string,
  deps: ChannelAdapterDeps,
): Promise<SharedPage[]> {
  const fields = "id,name,access_token,instagram_business_account{id,username}"
  const answer = await graph("paginas", `${base(app)}/me/accounts?fields=${encodeURIComponent(fields)}&limit=100`, { method: "GET", token: userToken }, deps)
  if (answer.status >= 400) throw failure("paginas", answer)
  const data = answer.json && typeof answer.json === "object" && "data" in answer.json ? answer.json.data : null
  if (!Array.isArray(data)) throw new MetaSignupError("paginas", answer.status, null, "Meta respondió sin las páginas")
  return data.flatMap((row: unknown): SharedPage[] => {
    if (!row || typeof row !== "object") return []
    const page = row as Record<string, unknown>
    const id = typeof page["id"] === "string" ? page["id"] : ""
    const token = typeof page["access_token"] === "string" ? page["access_token"] : ""
    if (!id || !token) return []
    const ig = page["instagram_business_account"]
    const instagram =
      ig && typeof ig === "object" && typeof (ig as Record<string, unknown>)["id"] === "string"
        ? {
            id: (ig as Record<string, string>)["id"] as string,
            username: typeof (ig as Record<string, unknown>)["username"] === "string" ? ((ig as Record<string, string>)["username"] as string) : null,
          }
        : null
    return [{ id, name: typeof page["name"] === "string" && page["name"] ? page["name"] : id, accessToken: token, instagram }]
  })
}

/** Lo que la app de odentIA escucha de cada página: mensajes, botones y lo que se responde desde Meta. */
export const PAGE_FIELDS = ["messages", "messaging_postbacks", "message_echoes", "message_deliveries", "message_reads"]

/** Suscribe la app de odentIA a los avisos de la página (Messenger y su Instagram). Repetirla no cambia nada. */
export async function subscribeAppToPage(
  app: Pick<MetaPlatformApp, "graphVersion">,
  pageId: string,
  pageToken: string,
  deps: ChannelAdapterDeps,
): Promise<void> {
  const query = new URLSearchParams({ subscribed_fields: PAGE_FIELDS.join(",") })
  const answer = await graph("suscribir", `${base(app)}/${encodeURIComponent(pageId)}/subscribed_apps?${query.toString()}`, { method: "POST", token: pageToken }, deps)
  if (answer.status >= 400 || !succeeded(answer.json)) throw failure("suscribir", answer)
}

/** Al desconectar la última cuenta de la página: deja de escuchar sus avisos. No toca la página. */
export async function unsubscribeAppFromPage(
  app: Pick<MetaPlatformApp, "graphVersion">,
  pageId: string,
  pageToken: string,
  deps: ChannelAdapterDeps,
): Promise<void> {
  const answer = await graph("desuscribir", `${base(app)}/${encodeURIComponent(pageId)}/subscribed_apps`, { method: "DELETE", token: pageToken }, deps)
  if (answer.status >= 400 || !succeeded(answer.json)) throw failure("desuscribir", answer)
}
