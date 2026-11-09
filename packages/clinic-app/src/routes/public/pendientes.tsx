import { createFileRoute } from "@tanstack/react-router"
import {
  PersonalLinkPage,
  personalLinkHead,
  validatePersonalLinkSearch,
} from "../../components/public/personal-link-page"

/**
 * «Tus pendientes» (ADR 0167, «Un enlace por cosa»): lo que la persona tiene por
 * hacer con la clínica, sin sesión. Cada mensaje abre directo lo suyo con
 * `?abre=firma|presupuesto|cita|datos|mensajes`; arriba, siempre, «‹ Tus
 * pendientes» lleva a la lista con el mismo token.
 */
export const Route = createFileRoute("/pendientes")({
  validateSearch: validatePersonalLinkSearch,
  head: personalLinkHead,
  component: PendingPage,
})

function PendingPage() {
  return <PersonalLinkPage entry="pendientes" search={Route.useSearch()} />
}
