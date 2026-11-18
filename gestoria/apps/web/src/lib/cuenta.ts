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
 * El token firmado de la cuenta para el servidor de gestorIA (15 minutos). Se guarda en memoria
 * (nunca en el navegador) y se pide otro un minuto antes de vencer. Null si no hay sesión.
 */
export async function accountToken(force = false): Promise<string | null> {
  if (!force && cached && cached.expiresAt - Date.now() > 60_000) return cached.token
  const { data, error } = await authClient.$fetch<{ token: string }>("/token", { method: "GET" })
  if (error || !data?.token) {
    cached = null
    return null
  }
  cached = { token: data.token, expiresAt: expiresAtOf(data.token) }
  return data.token
}

export function forgetToken(): void {
  cached = null
}

/** Una dirección de vuelta de la propia app; nunca otra web. */
export function safeNext(next: string | undefined | null): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null
  return next
}
