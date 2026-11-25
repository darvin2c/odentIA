import type { AuthFetch } from "@odentia/ui-patterns"
import { inferAdditionalFields, twoFactorClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

/**
 * La cuenta única (ADR 0201): una por persona para todas las apps del Grupo Sallca. En el
 * dominio de gestorIA solo responde su entrada (`https://api.gestoria24.com/api/auth/*`), con
 * la marca de gestorIA. Aquí se entra, se crea la cuenta y se recupera el acceso; el servidor de
 * gestorIA reconoce a la persona por el token que firma la cuenta, nunca por esta sesión.
 */
export const ACCOUNT_URL = (import.meta.env.VITE_ACCOUNT_URL as string | undefined) ?? ""

/**
 * La API de la cuenta en el dominio de gestorIA, sin `/api/auth`: ahí también responde lo de la
 * persona que usan Mi perfil y Soporte de la cuenta (`/api/account/*`, la foto), nunca lo de sus
 * clínicas (ADR 0216).
 */
export const ACCOUNT_API = ACCOUNT_URL.replace(/\/api\/auth\/?$/, "").replace(/\/+$/, "")

/**
 * La versión de los documentos que se aceptan al crear la cuenta. La cuenta exige la vigente
 * (`LEGAL_VERSION` de las clínicas, que gestorIA no importa); si cambia, la cuenta responde
 * `TERMS_OUTDATED` y la pantalla lo dice. Los textos propios de gestorIA llegan antes de abrirla.
 */
export const TERMS_VERSION = "2026-10-26"

export const authClient = createAuthClient({
  baseURL: ACCOUNT_URL,
  fetchOptions: { credentials: "include" },
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect() {
        const next = new URLSearchParams(window.location.search).get("next")
        window.location.href = `/two-factor${next ? `?next=${encodeURIComponent(next)}` : ""}`
      },
    }),
    inferAdditionalFields({
      user: {
        firstName: { type: "string", required: false, defaultValue: "" },
        lastName: { type: "string", required: false, defaultValue: "" },
        termsVersion: { type: "string", required: false },
      },
    }),
  ],
})

/** Las rutas propias de la cuenta (el enlace de acceso), con el mismo cliente y sus cookies. */
export const authFetch: AuthFetch = async (path, init) => {
  const { data, error } = await authClient.$fetch(path, {
    method: init?.method ?? "GET",
    body: init?.body,
  })
  return {
    data,
    error: error
      ? { message: error.message, code: (error as { code?: string }).code, status: error.status }
      : null,
  }
}

/** Un error de la cuenta, en palabras de la persona. */
export function accountErrorText(
  error: { code?: string; message?: string; status?: number } | null | undefined,
): string {
  if (!error) return "No pudimos completarlo. Inténtalo de nuevo."
  switch (error.code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return "El correo o la contraseña no coinciden. Revísalos o recupera tu contraseña."
    case "EMAIL_NOT_VERIFIED":
      return "Tu correo aún no está verificado. Abre el enlace que te enviamos."
    case "ACCOUNT_BLOCKED":
      return "Tu cuenta está bloqueada. Escribe a soporte para revisarla."
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "Ya hay una cuenta con ese correo. Entra con ella: es la misma de odentIA, latidIA y vistIA."
    case "TERMS_OUTDATED":
    case "TERMS_REQUIRED":
      return "Los documentos cambiaron. Recarga la página y vuelve a intentarlo."
    case "PASSWORD_TOO_SHORT":
      return "La contraseña es muy corta."
    case "PASSWORD_COMPROMISED":
      return "Esa contraseña apareció en una filtración conocida. Elige otra."
    case "INVALID_CODE":
    case "INVALID_TWO_FACTOR_CODE":
      return "El código no coincide. Revisa la hora de tu teléfono y vuelve a intentarlo."
  }
  if (error.status === 429) return "Hiciste varios intentos seguidos. Espera unos minutos."
  return error.message || "No pudimos completarlo. Inténtalo de nuevo."
}

let cached: { token: string; expiresAt: number } | null = null

/** Lee la expiración (en ms) de un token, sin comprobarlo: eso lo hace el servidor. */
function expiresAtOf(token: string): number {
  try {
    const payload = JSON.parse(
      atob((token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number }
    return (payload.exp ?? 0) * 1000
  } catch {
    return 0
  }
}

/**
 * La cuenta no respondió (caída, error del servidor, sin red). No es «sin sesión»: quien ya
 * entró no tiene que volver a entrar por eso (ADR 0203).
 */
export class AccountUnavailable extends Error {
  constructor() {
    super("Tu cuenta no responde en este momento. Reintenta en unos segundos.")
  }
}

/** Solo un 401 o 403 de la cuenta quiere decir «sin sesión»; lo demás es que no respondió. */
function accountSaysSignedOut(status: number | undefined): boolean {
  return status === 401 || status === 403
}

/**
 * El token firmado de la cuenta para el servidor de gestorIA (15 minutos). Se guarda en memoria
 * (nunca en el navegador) y se pide otro un minuto antes de vencer. Null si no hay sesión. Si la
 * cuenta no responde, sigue el token que ya había mientras no venza; sin él, `AccountUnavailable`.
 */
export async function accountToken(force = false): Promise<string | null> {
  if (!force && cached && cached.expiresAt - Date.now() > 60_000) return cached.token
  const result = await authClient
    .$fetch<{ token: string }>("/token", { method: "GET" })
    .catch(() => null)
  if (!result || (result.error && !accountSaysSignedOut(result.error.status))) {
    if (cached && cached.expiresAt > Date.now()) return cached.token
    throw new AccountUnavailable()
  }
  if (result.error || !result.data?.token) {
    cached = null
    return null
  }
  cached = { token: result.data.token, expiresAt: expiresAtOf(result.data.token) }
  return result.data.token
}

/**
 * ¿Hay sesión en la cuenta? `true` o `false` cuando la cuenta lo dice; si no responde,
 * `AccountUnavailable`, para que la pantalla no mande a entrar a quien ya entró.
 */
export async function hasSession(): Promise<boolean> {
  const result = await authClient.getSession().catch(() => null)
  if (!result || (result.error && !accountSaysSignedOut(result.error.status))) {
    throw new AccountUnavailable()
  }
  return Boolean(result.data?.session)
}

export function forgetToken(): void {
  cached = null
}

/** Una dirección de vuelta de la propia app; nunca otra web. */
export function safeNext(next: string | undefined | null): string | null {
  if (!next?.startsWith("/")) return null
  // El navegador quita tabulaciones y saltos y lee «\» como «/»: se resuelve como él y se
  // acepta solo si queda en el mismo origen.
  try {
    const url = new URL(next, window.location.origin)
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : null
  } catch {
    return null
  }
}

/**
 * Lo que la entrada recuerda de la última persona que entró desde este navegador, como la de las
 * clínicas: su nombre y su correo, para mostrárselos enteros y pedirle solo la contraseña. Nunca
 * la contraseña. «Entrar con otra cuenta» lo borra. Si el navegador no deja guardar, se pide todo.
 */
export interface RememberedUser {
  name: string
  email: string
}

const REMEMBERED = "gestoria.ultimo-acceso"

export function readRememberedUser(): RememberedUser | null {
  try {
    const raw = window.localStorage.getItem(REMEMBERED)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<RememberedUser>
    if (typeof value.email !== "string" || !value.email || typeof value.name !== "string")
      return null
    return { name: value.name, email: value.email }
  } catch {
    return null
  }
}

export function rememberUser(user: RememberedUser): void {
  try {
    window.localStorage.setItem(REMEMBERED, JSON.stringify(user))
  } catch {
    // Sin almacenamiento, la próxima vez se pide el correo; nada más.
  }
}

export function forgetUser(): void {
  try {
    window.localStorage.removeItem(REMEMBERED)
  } catch {
    // Igual que arriba.
  }
}
