import { createFileRoute, redirect } from "@tanstack/react-router"
import { PeopleLoading } from "../../components/person/person-loading"

/**
 * La lista de contactos es la de «Pacientes» con la vista «Todos»
 * (ADR 0029). Se conserva la búsqueda de los enlaces guardados.
 */
export const Route = createFileRoute("/_org/contacts/")({
  pendingComponent: PeopleLoading,
  beforeLoad: ({ location }) => {
    const search = location.search as Record<string, unknown>
    throw redirect({
      to: "/people",
      search: {
        ver: search.isActive === "false" ? "archivados" : "todos",
        ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
      },
      hash: location.hash,
      replace: true,
    })
  },
})
