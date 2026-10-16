import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * La página de contacto ya no existe: la persona tiene una sola página
 * (ADR 0029) y su dirección usa el mismo id. Esta dirección se conserva
 * porque hay avisos y enlaces guardados con ella: solo redirige.
 */
export const Route = createFileRoute("/_org/contacts/$contactId")({
  beforeLoad: ({ params, location }) => {
    throw redirect({
      to: "/people/$personId",
      params: { personId: params.contactId },
      search: location.search,
      hash: location.hash,
      replace: true,
    })
  },
})
