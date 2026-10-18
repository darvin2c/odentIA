import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Dirección antigua de los ajustes del agente. El modelo ya no se elige
 * (ADR 0052): Integraciones dice si responde. Hay avisos guardados con esta
 * dirección, así que redirige conservando la búsqueda.
 */
export const Route = createFileRoute("/_org/settings/agent")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/settings/integrations", search: location.search, hash: location.hash, replace: true })
  },
})
