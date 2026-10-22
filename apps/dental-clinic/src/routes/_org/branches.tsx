import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * Dirección antigua de Sedes, que ahora vive dentro de Configuración. Redirige
 * conservando la búsqueda (filtros y orden) para que los enlaces guardados
 * sigan abriendo lo mismo.
 */
export const Route = createFileRoute("/_org/branches")({
  beforeLoad: ({ location }) => {
    throw redirect({ to: "/settings/branches", search: location.search, hash: location.hash, replace: true })
  },
})
