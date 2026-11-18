import { toast } from "@odentia/ui"
import { useEffect, useState } from "react"
import { NewPasswordDialog } from "./new-password-dialog.js"

/** El rechazo de una ruta de acceso, ya plano (código, mensaje y estado). */
export interface AuthFetchError {
  message?: string
  code?: string
  status?: number
}

/** Lo mínimo del `$fetch` del cliente de Better Auth que usa la ventana. */
export type AuthFetch = (
  path: string,
  init?: { method?: "GET" | "POST"; body?: Record<string, unknown> },
) => Promise<{ data: unknown; error: AuthFetchError | null }>

const errorText = (error: AuthFetchError): string =>
  error.code === "ACCESS_LINK_REQUIRED"
    ? "El enlace ya venció. Pide uno nuevo desde «¿Olvidaste tu contraseña?»."
    : error.message || "No pudimos completarlo. Inténtalo de nuevo."

/** Lo que el servidor dice de la contraseña escrita (largo, filtración): va bajo el campo. */
const PASSWORD_CODES = new Set(["PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG", "PASSWORD_COMPROMISED", "PASSWORD_REQUIRED"])

/**
 * El rechazo de una ruta de acceso como error de la API (`status` + `shape`)
 * para `useAppForm`: los códigos de `field.codes` van al campo `field.name`.
 */
export function authFetchError(error: AuthFetchError, field?: { name: string; codes: ReadonlySet<string> }): Error {
  const message = errorText(error)
  const onField = field && error.code && field.codes.has(error.code) ? { [field.name]: message } : undefined
  return Object.assign(new Error(message), {
    status: error.status ?? 400,
    shape: { code: error.code, message, ...(onField ? { fields: onField } : {}) },
  })
}

/**
 * Después de entrar con el enlace de acceso, pide la nueva contraseña encima
 * de la pantalla en la que esté la persona (panel o clínica). El servidor
 * decide si corresponde (`/access-link/status`): la marca solo vale para la
 * sesión que abrió el enlace y por 30 minutos.
 */
export function AccessLinkPasswordGate({ request }: { request: AuthFetch }) {
  const [state, setState] = useState<{ pending: boolean; hasPassword: boolean } | null>(null)

  useEffect(() => {
    let alive = true
    void request("/access-link/status", { method: "GET" }).then(({ data }) => {
      const value = data as { pending?: boolean; hasPassword?: boolean } | null
      if (alive && value?.pending)
        setState({ pending: true, hasPassword: value.hasPassword !== false })
    })
    return () => {
      alive = false
    }
  }, [request])

  if (!state?.pending) return null
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  return (
    <NewPasswordDialog
      open
      hasPassword={state.hasPassword}
      onSave={async (newPassword) => {
        const { error } = await request("/access-link/set-password", {
          method: "POST",
          body: { newPassword, timeZone },
        })
        if (error) throw authFetchError(error, { name: "password", codes: PASSWORD_CODES })
        setState(null)
        toast.success("Listo. Tu contraseña cambió.")
      }}
      onSkip={async () => {
        try {
          const { error } = await request("/access-link/skip", { method: "POST" })
          if (error) {
            toast.error(errorText(error))
            return
          }
          setState(null)
        } catch {
          toast.error("No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.")
        }
      }}
    />
  )
}
