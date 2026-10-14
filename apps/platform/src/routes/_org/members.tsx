import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Dirección antigua de Equipo, que ahora vive dentro de Configuración. Redirige
 * conservando la búsqueda (filtros y orden) para que los enlaces guardados
 * sigan abriendo lo mismo.
 */
export const Route = createFileRoute("/_org/members")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/settings/team", search: location.search, hash: location.hash, replace: true })
  },
})
