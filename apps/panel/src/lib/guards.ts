import { redirect } from "@tanstack/react-router"
import { createIsomorphicFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { authClient } from "./auth-client"

export interface SessionInfo {
  userId: string
  email: string
  name: string
  firstName: string
  lastName: string
  emailVerified: boolean
}

/** Cabeceras de la petición entrante en SSR (cookies); vacío en el cliente. */
export const ssrFetchOptions = createIsomorphicFn()
  .server(() => ({ headers: getRequestHeaders() }))
  .client(() => ({}))

/** Sesión actual o redirect a /login. Para beforeLoad de rutas privadas. */
export async function requireSession(): Promise<SessionInfo> {
  // En SSR el fetch corre en Node y no ve las cookies del navegador: hay que
  // reenviar las cabeceras de la petición entrante.
  const { data } = await authClient.getSession({
    fetchOptions: ssrFetchOptions(),
  })
  if (!data) {
    throw redirect({ to: "/login" })
  }
  return {
    userId: data.user.id,
    email: data.user.email,
    name: data.user.name,
    firstName: data.user.firstName ?? "",
    lastName: data.user.lastName ?? "",
    emailVerified: data.user.emailVerified,
  }
}

/** Sesión con correo verificado; si no, a /verify-email-sent. */
export async function requireVerifiedSession(): Promise<SessionInfo> {
  const session = await requireSession()
  if (!session.emailVerified) {
    throw redirect({ to: "/verify-email-sent" })
  }
  return session
}

/**
 * Quien nunca aceptó los términos (entró con Google, o su cuenta es anterior)
 * pasa por «Un paso antes de seguir» y vuelve adonde iba. Una versión nueva no
 * redirige: la pide la ventana (`LegalGate`).
 */
export async function requireTermsAccepted(location: { href: string }): Promise<void> {
  const { data } = await authClient.$fetch<{ terms: { state: "ok" | "first" | "updated" } }>("/legal/status", {
    method: "GET",
    ...ssrFetchOptions(),
  })
  if (data?.terms.state === "first") throw redirect({ to: "/terminos", search: { next: location.href } })
}
