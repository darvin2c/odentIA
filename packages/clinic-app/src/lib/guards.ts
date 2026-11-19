import { redirect } from "@tanstack/react-router"
import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { authClient } from "./auth-client"
import { orgSlugFromHostname, panelUrl, requestHostname, tenantUrl } from "./host"

export interface SessionInfo {
  userId: string
  email: string
  name: string
  /** Foto de Mi perfil, para el avatar de la barra lateral; sin ella, las iniciales. */
  image: string | null
  emailVerified: boolean
}

/**
 * En SSR, la cookie de la petición entrante; vacío en el cliente. Solo la cookie, como `apiFetch`:
 * las demás cabeceras de la visita (su `Host`, las de Cloudflare) no son de la API, y en Workers
 * (ADR 0138) no hay `fetch` de Node que las descarte.
 */
export const ssrFetchOptions = createIsomorphicFn()
  .server(() => {
    const cookie = getRequestHeaders().get("cookie")
    return cookie ? { headers: { cookie } } : {}
  })
  .client(() => ({}))

/** URL absoluta actual (cliente o SSR): el `next` de vuelta al tenant. */
function currentAbsoluteUrl(href: string): string {
  if (typeof window !== "undefined") return window.location.href
  const slug = orgSlugFromHostname(requestHostname())
  const base = slug ? tenantUrl(slug) : panelUrl("/")
  const location = new URL(href, base)
  const result = new URL(base)
  result.pathname = location.pathname
  result.search = location.search
  result.hash = location.hash
  return result.href
}

/**
 * La API no respondió (un corte, un despliegue o un fallo suyo): no se sabe si hay sesión ni de
 * qué clínica. No es «sin sesión», así que no se manda a nadie al login (QA del 18 nov, novato 5:
 * con la API reiniciándose, la app sacaba al login a mitad de la atención). Lo muestra la pantalla
 * de error de la ruta, con «Reintentar»; con lo ya comprobado en esta pantalla, se sigue en ella.
 */
export class ApiUnavailableError extends Error {
  constructor() {
    super("No se pudo comprobar tu acceso: puede ser un corte momentáneo.")
    this.name = "ApiUnavailableError"
  }
}

/**
 * Lo que dice la API al preguntar por la sesión: `none` solo cuando responde que no la hay (sin
 * datos y sin error, o 401/403). Cualquier otro error, o no responder, es `unavailable`.
 */
export function sessionAnswer(result: { data: unknown; error?: { status?: number } | null }): "session" | "none" | "unavailable" {
  if (result.data) return "session"
  const status = result.error?.status
  if (!result.error || status === 401 || status === 403) return "none"
  return "unavailable"
}

/** Un error de la API que no dice nada de quién es ni de su clínica: no respondió bien. */
export function apiUnavailable(error: { status?: number } | null | undefined): boolean {
  if (!error) return false
  const status = error.status
  return status === undefined || status === 0 || status === 408 || status === 429 || status >= 500
}

/** Sesión actual o redirect al login del panel (con `next` de vuelta al tenant). */
export async function requireSession(location: { href: string }): Promise<SessionInfo> {
  // En SSR el fetch corre en el servidor y no ve las cookies del navegador: hay que
  // reenviar la de la petición entrante.
  const result = await authClient
    .getSession({
      fetchOptions: ssrFetchOptions(),
    })
    .catch(() => {
      throw new ApiUnavailableError()
    })
  const answer = sessionAnswer(result)
  if (answer === "unavailable") throw new ApiUnavailableError()
  const { data } = result
  if (!data) {
    throw redirect({
      href: panelUrl(`/login?next=${encodeURIComponent(currentAbsoluteUrl(location.href))}`),
    })
  }
  return {
    userId: data.user.id,
    email: data.user.email,
    name: data.user.name,
    image: data.user.image ?? null,
    emailVerified: data.user.emailVerified,
  }
}

/** Sesión con correo verificado; si no, al panel a verificarlo. */
export async function requireVerifiedSession(location: { href: string }): Promise<SessionInfo> {
  const session = await requireSession(location)
  if (!session.emailVerified) {
    throw redirect({ href: panelUrl("/verify-email-sent") })
  }
  return session
}

/**
 * Quien nunca aceptó los términos (entró con Google, o su cuenta es anterior)
 * los acepta en el panel antes de seguir y vuelve aquí. Una versión nueva no
 * redirige: la pide la ventana de la clínica (`LegalGate`).
 */
export async function requireTermsAccepted(location: { href: string }): Promise<void> {
  const { data } = await authClient.$fetch<{ terms: { state: "ok" | "first" | "updated" } }>("/legal/status", {
    method: "GET",
    ...ssrFetchOptions(),
  })
  if (data?.terms.state === "first") {
    throw redirect({ href: panelUrl(`/terminos?next=${encodeURIComponent(currentAbsoluteUrl(location.href))}`) })
  }
}
