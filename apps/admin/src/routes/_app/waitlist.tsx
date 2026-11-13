/**
 * La lista de espera de antes. Cada solicitud de la web es ahora un momento de
 * su cliente (ADR 0185): `?solicitud=<id>` abre la ficha de su cliente en
 * Venta, donde viven su seguimiento y la invitación; sin solicitud, Clientes
 * con la vista equivalente a la etapa (`?etapa=`), su producto y su búsqueda.
 * Queda como ruta que solo redirige: hay enlaces y correos guardados con ella.
 */
import { createFileRoute, redirect } from "@tanstack/react-router"
import { lookupClient } from "../../components/arm/client-lookup"
import { ClientsPageSkeleton } from "../../components/skeletons/clients"
import {
  clientsSearchFromWaitlist,
  type WaitlistSearch,
  waitlistSearchOf,
} from "../../lib/list-search"

export const Route = createFileRoute("/_app/waitlist")({
  validateSearch: (search: Record<string, unknown>): WaitlistSearch => waitlistSearchOf(search),
  beforeLoad: async ({ search }) => {
    if (search.solicitud) {
      const clientId = await lookupClient({ request: search.solicitud })
      if (clientId)
        throw redirect({
          to: "/clients/$clientId",
          params: { clientId },
          search: { tab: "venta" },
          replace: true,
        })
    }
    throw redirect({ to: "/clients", search: clientsSearchFromWaitlist(search), replace: true })
  },
  pendingComponent: ClientsPageSkeleton,
})
