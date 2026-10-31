import { createFileRoute, redirect } from "@tanstack/react-router"
import { PeopleLoading } from "../../components/person/person-loading"

/**
 * La lista de pacientes es la lista única de personas (ADR 0029), que abre
 * en «Pacientes». Se conserva la búsqueda de los enlaces guardados.
 */
export const Route = createFileRoute("/_org/patients/")({
  pendingComponent: PeopleLoading,
  beforeLoad: ({ location }) => {
    const search = location.search as Record<string, unknown>
    throw redirect({
      to: "/people",
      search: {
        ...(search.isActive === "false" ? { ver: "archivados" as const } : {}),
        ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
      },
      hash: location.hash,
      replace: true,
    })
  },
})
