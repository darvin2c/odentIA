import { AccountUnavailable, accountToken } from "./cuenta"

/** El servidor de gestorIA (`https://servidor.gestoria24.com`). */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? ""

export type StoreRole = "owner" | "admin" | "sales"

export interface MyStore {
  id: string
  name: string
  currency: string
  /** La hora de la tienda (IANA, «America/Lima»): con ella se cuenta «hoy». */
  timeZone: string
  /** ISO 3166-1 alfa-2, si lo dijo. */
  country: string | null
  /** El color de «Tu marca» (`#be185d`): pinta la app de todo el equipo. Null: el de gestorIA. */
  brandColor: string | null
  /** «support»: soporte de gestorIA con una entrada aceptada, solo a mirar. */
  role: StoreRole | "support"
  permissions: string[]
  /** Hasta cuándo puede mirar soporte; null si es del equipo. */
  supportUntil: string | null
  /** Es la única persona con el rol de Dueño: antes de cerrar su cuenta, se lo da a otra. */
  onlyOwner: boolean
}

/** Cómo terminó una entrada de soporte (ADR 0219). */
export type SupportEnding = "tiempo" | "quitado" | "salio" | "rechazado" | "sin_respuesta"

/**
 * La entrada de soporte de gestorIA a la tienda, como la ve el equipo. El Dueño y un
 * Administrador la ven entera; Ventas, solo quién mira ahora y hasta cuándo (sin lo demás).
 */
export interface SupportAccess {
  id: string
  staffName: string
  status: "por_aceptar" | "vigente" | "terminado" | "rechazado"
  expiresAt: string | null
  usedAt: string | null
  minutes?: number
  reason?: string
  requestedAt?: string
  answeredAt?: string | null
  /** Quién la dejó entrar o dijo que no, y su nombre (si sigue en el equipo). */
  answeredBy?: string | null
  answeredByName?: string | null
  ending?: { reason: SupportEnding; at: string; by: string | null; byName: string | null } | null
}

/** Cómo está la entrada de quien es soporte, dicho por el servidor (ADR 0219). */
export type MySupportState =
  | { state: "pendiente"; requestedAt: string }
  | { state: "falta_codigo"; until: string }
  | { state: "puede_mirar"; until: string }
  | { state: "terminado"; reason: SupportEnding; at: string; byName: string | null }

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
    /** Un formulario con archivo (la captura de un pago): el navegador pone su tipo. */
    form?: FormData
    /** La respuesta como archivo (una foto, la hoja de ejemplo). */
    as?: "blob"
  } = {},
): Promise<T> {
  for (const force of [false, true]) {
    let token: string | null
    try {
      // eslint-disable-next-line no-await-in-loop
      token = await accountToken(force)
    } catch (error) {
      // La cuenta no respondió: se dice y se reintenta, sin mandar a entrar.
      if (error instanceof AccountUnavailable)
        throw new ApiError(503, "ACCOUNT_UNAVAILABLE", error.message)
      throw error
    }
    if (!token) throw new SignedOut("Entra con tu cuenta para seguir.")
    let response: Response
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await fetch(`${API_URL}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.form
            ? {}
            : init.raw
              ? { "content-type": init.raw.type }
              : init.body === undefined
                ? {}
                : { "content-type": "application/json" }),
        },
        ...(init.form
          ? { body: init.form }
          : init.raw
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
export const ROLES: Record<StoreRole | "support", { name: string; can: string }> = {
  support: {
    name: "Soporte de gestorIA",
    can: "Solo mira la tienda, su equipo y su catálogo, mientras la tienda lo deja.",
  },
  owner: { name: "Dueño", can: "Todo, también el plan." },
  admin: { name: "Administrador", can: "Todo menos el plan." },
  sales: { name: "Ventas", can: "Atiende, confirma pagos y entrega. No cambia la configuración." },
}

export function invitationLink(id: string): string {
  return `${window.location.origin}/invitacion/${id}`
}
