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
 * Quién entró por última vez en este navegador, para dibujar el marco y el
 * esqueleto al recargar mientras la API confirma la sesión. Decide qué se dibuja
 * un instante, nunca qué se permite: lo que se muestra después lo da la API.
 */
const SEEN_KEY = "odentia-admin-session"
let seen: { raw: string | null; session: AdminSession | null } = { raw: null, session: null }

function readSeenSession(): AdminSession | null {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY)
    if (raw !== seen.raw) {
      const parsed = raw ? adminSessionSchema.safeParse(JSON.parse(raw)) : null
      seen = { raw, session: parsed?.success ? parsed.data : null }
    }
    return seen.session
  } catch {
    return null
  }
}

/** También se olvida al salir y cuando la API ya no la reconoce. */
export function rememberSeenSession(session: AdminSession | null): void {
  try {
    if (session) window.localStorage.setItem(SEEN_KEY, JSON.stringify(session))
    else window.localStorage.removeItem(SEEN_KEY)
  } catch {
    // Sin almacenamiento, la recarga solo dibuja menos mientras llega la sesión.
  }
}

const NO_CHANGES = () => () => undefined

/** Lo mismo al hidratar que en el servidor (nada) y, enseguida, lo guardado. */
export function useSeenSession(): AdminSession | null {
  return useSyncExternalStore(NO_CHANGES, readSeenSession, () => null)
}

export async function requireAdminSession(): Promise<AdminSession> {
  let session: AdminSession
  try {
    session = adminSessionSchema.parse(await api<unknown>("/api/admin/access/session"))
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      rememberSeenSession(null)
      throw redirect({ href: loginUrl() })
    }
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
 * Quien mira, sin ningún pedido: lo trae el `beforeLoad` de `/_app`. Mientras
 * corre (al recargar la página) el esqueleto se dibuja con lo visto la última vez.
 */
function useViewer(): AdminSession | null {
  const confirmed = appRoute.useRouteContext({ select: (context) => (context as { adminSession?: AdminSession }).adminSession })
  const lastSeen = useSeenSession()
  return confirmed ?? lastSeen
}

/** Si quien mira es de la administración. Decide qué se muestra, no qué se permite. */
export function useIsAdmin(): boolean {
  return useViewer()?.actor.role === "admin"
}

/** Quién es quien mira, del mismo lugar que `useIsAdmin`. */
export function useAdminUserId(): string {
  return useViewer()?.actor.userId ?? ""
}
