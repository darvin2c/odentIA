import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Dirección antigua de Chat web, que ahora se abre desde Integraciones.
 * Redirige conservando la búsqueda.
 */
export const Route = createFileRoute("/_org/settings/webchat")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/settings/integrations/webchat", search: location.search, hash: location.hash, replace: true })
  },
})
