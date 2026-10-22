import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Dirección antigua de «Aprobaciones», que ahora se llama «Pendientes». Hay
 * enlaces y avisos guardados con esta dirección, así que redirige conservando
 * la búsqueda (`conversationId`, `status`).
 */
export const Route = createFileRoute("/_org/agent/approvals")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/agent/pendientes", search: location.search, hash: location.hash, replace: true })
  },
})
