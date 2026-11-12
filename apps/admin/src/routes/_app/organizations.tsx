/**
 * La lista de clínicas de antes. Una clínica con cuenta es ahora un cliente
 * (ADR 0183): la lista abre Clientes en «Con cuenta», con su producto y su
 * búsqueda; las demos están en Demos («?clase=demo»), y «Alta asistida» es
 * «Dar de alta» en la ficha del cliente. Queda como ruta que solo redirige:
 * hay enlaces guardados con ella.
 */
import { isClinicalProduct } from "@odentia/clinical"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { ClientsPageSkeleton } from "../../components/skeletons/clients"
import { clientsSearchOf } from "../../lib/list-search"

interface ListSearch {
  q?: string | undefined
  producto?: string | undefined
  clase?: "real" | "demo" | undefined
  /** Enlace de antes: abría la ficha al lado. */
  org?: string | undefined
}

export const Route = createFileRoute("/_app/organizations")({
  validateSearch: (search: Record<string, unknown>): ListSearch => ({
    q: typeof search.q === "string" && search.q ? search.q : undefined,
    producto: isClinicalProduct(search.producto) ? search.producto : undefined,
    clase: search.clase === "real" || search.clase === "demo" ? search.clase : undefined,
    org: typeof search.org === "string" && search.org ? search.org : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.org)
      throw redirect({
        to: "/organizations/$organizationId",
        params: { organizationId: search.org },
        replace: true,
      })
    if (search.clase === "demo")
      throw redirect({
        to: "/demos",
        search: { producto: isClinicalProduct(search.producto) ? search.producto : undefined },
        replace: true,
      })
    throw redirect({
      to: "/clients",
      search: clientsSearchOf({ vista: "con_cuenta", producto: search.producto, q: search.q }),
      replace: true,
    })
  },
  pendingComponent: ClientsPageSkeleton,
})
