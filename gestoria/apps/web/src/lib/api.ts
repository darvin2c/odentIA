import { accountToken } from "./cuenta"

/** El servidor de gestorIA (`https://servidor.gestoria24.com`). */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? ""

export type StoreRole = "owner" | "admin" | "sales"

export interface MyStore {
  id: string
  name: string
  currency: string
  role: StoreRole
  permissions: string[]
}

export interface MyInvitation {
  id: string
  role: StoreRole
  expiresAt: string
  storeId: string
  storeName: string
  invitedBy: string | null
}

export interface Me {
  person: { userId: string; email: string; name: string }
  stores: MyStore[]
  invitations: MyInvitation[]
}

export interface TeamMember {
  userId: string
  role: StoreRole
  since: string
  name: string
  email: string
  image: string | null
}

export interface PendingInvitation {
  id: string
  email: string
  role: StoreRole
  expiresAt: string
  createdAt: string
  expired: boolean
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message)
  }
}

/** Sin sesión de la cuenta: la pantalla manda a entrar. */
export class SignedOut extends Error {}

/**
 * Llama al servidor de gestorIA con el token de la cuenta. Si el token venció entre medio,
 * pide otro una vez. Los errores llegan como `ApiError`, con el mensaje para la persona.
 */
export async function api<T>(
  path: string,
  init: {
    method?: string
    body?: unknown
    /** Un cuerpo que no es JSON: una foto o una hoja. */
    raw?: { type: string; data: Blob | string }
    /** La respuesta como archivo (una foto, la hoja de ejemplo). */
    as?: "blob"
  } = {},
): Promise<T> {
  for (const force of [false, true]) {
    // eslint-disable-next-line no-await-in-loop
    const token = await accountToken(force)
    if (!token) throw new SignedOut("Entra con tu cuenta para seguir.")
    let response: Response
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await fetch(`${API_URL}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.raw
            ? { "content-type": init.raw.type }
            : init.body === undefined
              ? {}
              : { "content-type": "application/json" }),
        },
        ...(init.raw
          ? { body: init.raw.data }
          : init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
      })
    } catch {
      throw new ApiError(
        0,
        "NETWORK",
        "No hay conexión con gestorIA. Revisa tu internet e inténtalo de nuevo.",
      )
    }
    if (response.status === 401 && !force) continue
    if (response.status === 204) return undefined as T
    // eslint-disable-next-line no-await-in-loop
    if (response.ok && init.as === "blob") return (await response.blob()) as T
    // eslint-disable-next-line no-await-in-loop
    const body = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string; fields?: Record<string, string> }
    }
    if (response.ok) return body as T
    // Con sesión en la cuenta y un token recién pedido, un rechazo no se arregla entrando otra
    // vez (volvería aquí): se dice, sin mandar a entrar.
    if (response.status === 401)
      throw new ApiError(
        401,
        "TOKEN_REJECTED",
        "No pudimos confirmar tu sesión con gestorIA. Recarga la página; si sigue, sal y vuelve a entrar.",
      )
    throw new ApiError(
      response.status,
      body.error?.code ?? "ERROR",
      body.error?.message ?? "Algo falló. Inténtalo de nuevo.",
      body.error?.fields ?? {},
    )
  }
  throw new SignedOut("Entra con tu cuenta para seguir.")
}

/** Los nombres de cada rol y lo que puede (decisión 7 del lienzo B), como los ve la persona. */
export const ROLES: Record<StoreRole, { name: string; can: string }> = {
  owner: { name: "Dueño", can: "Todo, también el plan." },
  admin: { name: "Administrador", can: "Todo menos el plan." },
  sales: { name: "Ventas", can: "Atiende, confirma pagos y entrega. No cambia la configuración." },
}

export function invitationLink(id: string): string {
  return `${window.location.origin}/invitacion/${id}`
}
