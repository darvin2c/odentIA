import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Dirección antigua de los ajustes del agente: el modelo se cambia desde
 * Integraciones. Hay avisos guardados con esta dirección, así que redirige
 * conservando la búsqueda.
 */
export const Route = createFileRoute("/_org/settings/agent")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/settings/integrations/model", search: location.search, hash: location.hash, replace: true })
  },
})
