import { ApiError } from "./api"

/** El cuerpo anidado de un middleware de Hono dentro del error de better-fetch. */
export interface HonoAuthErrorBody {
  code?: string
  message?: string
  fields?: Record<string, string>
}

/**
 * Lo que devuelve `authClient` cuando `/api/auth/*` rechaza: better-fetch copia
 * el cuerpo dentro de `error`. Better Auth responde plano (`{ code, message }`)
 * y los middlewares de Hono, anidado (`{ error: { code, message, fields } }`):
 * `RESERVED_SLUG`, `INVITATION_*`…
 */
export interface AuthClientError {
  status?: number
  code?: string
  message?: string
  error?: HonoAuthErrorBody | unknown
}

const AUTH_RATE_LIMITED = "Hiciste varios intentos seguidos. Espera unos minutos e inténtalo de nuevo."

/**
 * Better Auth responde en inglés: lo que puede llegar a una pantalla del panel
 * se dice en español. Los códigos propios (ganchos de `packages/auth`, Hono)
 * ya traen su mensaje en español y lo conservan.
 */
const BETTER_AUTH_WORDS: Record<string, string> = {
  INVALID_EMAIL: "Escribe un correo válido, como nombre@clinica.com",
  INVALID_PASSWORD: "La contraseña no coincide. Revísala.",
  PASSWORD_TOO_SHORT: "Usa al menos 8 caracteres.",
  PASSWORD_TOO_LONG: "Usa como mucho 128 caracteres.",
  INVALID_CODE: "Ese código no coincide. Escribe el que muestra ahora tu app.",
  INVALID_BACKUP_CODE: "Ese código de respaldo no coincide o ya se usó.",
  INVALID_TWO_FACTOR_COOKIE: "La verificación venció. Vuelve a entrar con tu correo y contraseña.",
  ACCOUNT_TEMPORARILY_LOCKED: AUTH_RATE_LIMITED,
  ACCOUNT_BLOCKED: "Tu cuenta está bloqueada. Escribe a soporte para revisarla.",
  CREDENTIAL_ACCOUNT_NOT_FOUND:
    "Entras con Google y aún no tienes contraseña. Crea una desde «¿Olvidaste tu contraseña?» al entrar.",
  EMAIL_NOT_VERIFIED: "Tu correo aún no está verificado. Abre el enlace que te enviamos.",
  ORGANIZATION_ALREADY_EXISTS: "Esa dirección ya está en uso. Elige otra.",
  ORGANIZATION_SLUG_ALREADY_TAKEN: "Esa dirección ya está en uso. Elige otra.",
  SESSION_EXPIRED: "Tu sesión venció. Vuelve a entrar para seguir.",
  FAILED_TO_GET_SESSION: "Tu sesión venció. Vuelve a entrar para seguir.",
  TWO_FACTOR_NOT_ENABLED: "La verificación en dos pasos no está activa.",
  SESSION_NOT_FRESH: "Por seguridad, vuelve a entrar antes de hacer este cambio.",
}

const AUTH_GENERIC = "No pudimos completarlo. Inténtalo de nuevo en un momento."

/** Lo que se lee de un rechazo de `authClient`, plano o anidado. */
export interface AuthFailure {
  status: number
  code: string | null
  /** El mensaje en español (el propio de la pantalla, el traducido o el del servidor). */
  message: string
  /** Campos que el servidor señaló (rutas de Hono con `validationError`). */
  fields: Record<string, string>
}

function nested(error: AuthClientError): HonoAuthErrorBody {
  const inner = error.error
  return typeof inner === "object" && inner !== null ? (inner as HonoAuthErrorBody) : {}
}

/** Código, estado y mensaje en español de un rechazo de `authClient`. */
export function authFailureOf(error: AuthClientError): AuthFailure {
  const inner = nested(error)
  const status = typeof error.status === "number" ? error.status : 400
  const code = error.code || inner.code || null
  const own = inner.message?.trim() || null
  const server = error.message?.trim() || null
  const message =
    (code ? BETTER_AUTH_WORDS[code] : undefined) ??
    (status === 429 ? AUTH_RATE_LIMITED : undefined) ??
    // Sin traducción conocida: el mensaje de Hono es nuestro (en español); el de Better Auth solo si es un código propio.
    own ??
    (code && server ? server : null) ??
    AUTH_GENERIC
  return { status, code, message, fields: inner.fields ?? {} }
}

export interface AuthErrorRoute {
  /** Código → campo del formulario donde se dice (formato de lo escrito, datos dentro de la sesión). */
  fields?: Record<string, string>
  /** Código (o `"429"`) → texto propio de la pantalla. */
  messages?: Record<string, string>
  /**
   * Mensaje neutro para todo lo demás (credenciales, recuperar acceso: OWASP,
   * un solo mensaje que no revela si la cuenta existe). Sin él, el de cada código.
   */
  neutral?: string
  /** Códigos que se dicen tal cual aunque haya `neutral` (cuenta bloqueada tras validar la contraseña, 429…). */
  keep?: readonly string[]
}

/**
 * Convierte el rechazo de `authClient` en el error de la API que entienden
 * `useAppForm`/`submitErrorOf`: lanzarlo en `onSubmit` lo lleva a su campo
 * (`route.fields`) o junto a los botones.
 */
export function authError(error: AuthClientError, route: AuthErrorRoute = {}): ApiError {
  const failure = authFailureOf(error)
  const key = failure.code ?? ""
  const rateLimited = failure.status === 429 || key === "ACCOUNT_TEMPORARILY_LOCKED"
  const kept = rateLimited || (route.keep?.includes(key) ?? false) || key in (route.fields ?? {})
  const message =
    route.messages?.[key] ??
    (failure.status === 429 ? route.messages?.["429"] : undefined) ??
    (route.neutral && !kept ? route.neutral : failure.message)
  const field = failure.code ? route.fields?.[failure.code] : undefined
  const fields = field ? { ...failure.fields, [field]: message } : failure.fields
  // 5xx: `submitErrorOf` dice que no se pudo confirmar; lo demás se dice con su mensaje.
  return new ApiError(failure.status, { code: failure.code ?? undefined, message, fields })
}

/** Sin red: better-fetch lanza el `TypeError` de `fetch`. */
export const AUTH_NETWORK = "No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo."

/**
 * `formMessage` de las pantallas de acceso: sin red se dice que no hubo
 * conexión (no hay nada que duplicar al entrar o pedir un enlace).
 */
export function authFormMessage(error: unknown): string | null {
  return error instanceof TypeError ? AUTH_NETWORK : null
}

/** Una sola frase para una acción suelta de `authClient` (cerrar una sesión, un interruptor). */
export function authErrorMessage(error: AuthClientError): string {
  return authFailureOf(error).message
}
