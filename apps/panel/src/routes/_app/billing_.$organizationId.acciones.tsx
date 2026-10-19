/** Dirección vieja de «Cada acción»: lleva a la página dentro de la clínica (ADR 0065). */
import { createFileRoute } from "@tanstack/react-router"
import { PlanRedirect } from "../../components/plan-redirect"

export const Route = createFileRoute("/_app/billing_/$organizationId/acciones")({
  component: () => <PlanRedirect organizationId={Route.useParams().organizationId} path="/settings/plan/acciones" />,
})
