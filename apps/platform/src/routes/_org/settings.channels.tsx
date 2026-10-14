import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Dirección antigua de Canales: sus conexiones son filas de Integraciones. Hay
 * avisos guardados con esta dirección, así que redirige conservando la búsqueda.
 */
export const Route = createFileRoute("/_org/settings/channels")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/settings/integrations", search: location.search, hash: location.hash, replace: true })
  },
})
