import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * La oportunidad no tiene página propia (ADR 0028): se abre al lado del
 * tablero, y después en la página de la persona. Esta dirección se conserva
 * porque hay avisos y enlaces guardados con ella: solo redirige.
 */
export const Route = createFileRoute("/_org/opportunities/$opportunityId")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/pipeline", search: { oportunidad: params.opportunityId }, replace: true })
  },
})
