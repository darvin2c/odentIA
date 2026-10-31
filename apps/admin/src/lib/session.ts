import { getRouteApi, redirect } from "@tanstack/react-router"
import { useSyncExternalStore } from "react"
import { z } from "zod"
import { ApiError, api } from "./api"
import { loginUrl } from "./host"

export const adminSessionSchema = z.object({
  actor: z.object({ userId: z.string(), role: z.enum(["admin", "support"]) }),
  user: z.object({ name: z.string(), email: z.string(), image: z.string().nullable().optional() }),
  verified: z.boolean(),
})
export type AdminSession = z.infer<typeof adminSessionSchema>

/**
 * Quién trabaja en esta pestaña, para dibujar el marco y el esqueleto al recargar
 * mientras la API confirma la sesión. Solo lo que se dibuja y solo mientras la
 * pestaña siga abierta: en un equipo prestado no queda nada al cerrarla. Decide qué
 * se dibuja un instante, nunca qué se permite.
 */
const SEEN_KEY = "odentia-admin-session"
const seenSchema = z.object({ role: z.enum(["admin", "support"]), user: adminSessionSchema.shape.user })
export type SeenSession = z.infer<typeof seenSchema>
let seen: { raw: string | null; session: SeenSession | null } = { raw: null, session: null }

function readSeenSession(): SeenSession | null {
  try {
    const raw = window.sessionStorage.getItem(SEEN_KEY)
    if (raw !== seen.raw) {
      const parsed = raw ? seenSchema.safeParse(JSON.parse(raw)) : null
      seen = { raw, session: parsed?.success ? parsed.data : null }
    }
    return seen.session
  } catch {
    return null
  }
}

/** También se olvida al salir y cuando la API la rechaza. */
export function rememberSeenSession(session: AdminSession | null): void {
  try {
    if (session) window.sessionStorage.setItem(SEEN_KEY, JSON.stringify({ role: session.actor.role, user: session.user }))
    else window.sessionStorage.removeItem(SEEN_KEY)
  } catch {
    // Sin almacenamiento, la recarga solo dibuja menos mientras llega la sesión.
  }
}

const NO_CHANGES = () => () => undefined

/** Lo mismo al hidratar que en el servidor (nada) y, enseguida, lo guardado. */
export function useSeenSession(): SeenSession | null {
  return useSyncExternalStore(NO_CHANGES, readSeenSession, () => null)
}

export async function requireAdminSession(): Promise<AdminSession> {
  let session: AdminSession
  try {
    session = adminSessionSchema.parse(await api<unknown>("/api/admin/access/session"))
  } catch (error) {
    // Un rechazo (otra cuenta, sin rol de personal) la olvida; un fallo del servidor o de la red, no.
    if (error instanceof ApiError && error.status < 500) rememberSeenSession(null)
    if (error instanceof ApiError && error.status === 401) throw redirect({ href: loginUrl() })
    throw error
  }
  if (!session.verified) {
    rememberSeenSession(null)
    throw redirect({ to: "/security" })
  }
  rememberSeenSession(session)
  return session
}

/**
 * Las pantallas solo de la administración (Cobros y planes, Comisiones): el
 * menú no las muestra a soporte y, si entra con la dirección, vuelve a Inicio
 * en vez de ver errores de acceso. La API tampoco le da los datos (ADR 0094).
 */
export function requireAdminRole({ context }: { context: { adminSession: AdminSession } }): void {
  if (context.adminSession.actor.role !== "admin") throw redirect({ to: "/" })
}

const appRoute = getRouteApi("/_app")

/**
 * Si quien mira es de la administración, sin ningún pedido: lo trae el `beforeLoad`
 * de `/_app`; mientras corre (al recargar) un esqueleto solo se dibuja con lo visto
 * en esta pestaña. Decide qué se muestra, no qué se permite.
 */
export function useIsAdmin(): boolean {
  const confirmed = appRoute.useRouteContext({ select: (context) => (context as { adminSession?: AdminSession }).adminSession })
  const lastSeen = useSeenSession()
  return (confirmed?.actor.role ?? lastSeen?.role) === "admin"
}

/** Quién es quien mira: solo lo piden pantallas ya confirmadas. */
export function useAdminUserId(): string {
  return appRoute.useRouteContext().adminSession.actor.userId
}
