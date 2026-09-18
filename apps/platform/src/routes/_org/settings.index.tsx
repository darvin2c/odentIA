import { createFileRoute, redirect } from "@tanstack/react-router"

/** `/settings` no tiene pantalla propia: entra por el primer apartado, así el
 * ítem de Configuración del sidebar tiene destino y queda activo en toda la
 * sección por prefijo. */
export const Route = createFileRoute("/_org/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/channels" })
  },
})
