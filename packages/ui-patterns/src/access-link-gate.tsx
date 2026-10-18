import { toast } from "@odentia/ui"
import { useEffect, useState } from "react"
import { NewPasswordDialog } from "./new-password-dialog.js"

/** Lo mínimo del `$fetch` del cliente de Better Auth que usa la ventana. */
export type AuthFetch = (
  path: string,
  init?: { method?: "GET" | "POST"; body?: Record<string, unknown> },
) => Promise<{ data: unknown; error: { message?: string; code?: string; status?: number } | null }>

const errorText = (error: { message?: string; code?: string } | null): string =>
  error?.code === "ACCESS_LINK_REQUIRED"
    ? "El enlace ya venció. Pide uno nuevo desde «¿Olvidaste tu contraseña?»."
    : error?.message || "No pudimos guardarla. Revisa tu conexión e inténtalo de nuevo."

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
        if (error) return errorText(error)
        setState(null)
        toast.success("Listo. Tu contraseña cambió.")
        return null
      }}
      onSkip={async () => {
        const { error } = await request("/access-link/skip", { method: "POST" })
        if (error) {
          toast.error(errorText(error))
          return
        }
        setState(null)
      }}
    />
  )
}
