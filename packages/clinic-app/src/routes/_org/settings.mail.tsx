import { createFileRoute, redirect } from "@tanstack/react-router"
import { validateIntegrationsSearch } from "../../lib/integrations"

/**
 * Dirección antigua de Correo: sus buzones son filas de Integraciones. El
 * servidor vuelve a esta dirección tras autorizar un buzón, con el resultado en
 * la búsqueda (`ok`, `buzon`, `error`): se conserva para que Integraciones lo
 * diga. También hay avisos guardados que apuntan aquí.
 */
export const Route = createFileRoute("/_org/settings/mail")({
  validateSearch: validateIntegrationsSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/integrations", search, replace: true })
  },
})
