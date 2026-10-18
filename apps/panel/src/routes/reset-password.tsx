import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Los enlaces de «Restablece tu contraseña» de antes del enlace de acceso
 * llegan aquí: ya no sirven, y la pantalla de recuperar lo dice y ofrece otro.
 */
export const Route = createFileRoute("/reset-password")({
  beforeLoad: () => {
    throw redirect({ to: "/forgot-password", search: { vencido: 1 } })
  },
})
