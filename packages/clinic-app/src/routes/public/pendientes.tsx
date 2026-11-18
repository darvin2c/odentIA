import { createFileRoute } from "@tanstack/react-router"
import {
  PersonalLinkPage,
  personalLinkHead,
  validatePersonalLinkSearch,
} from "../../components/public/personal-link-page"
import { RecordCopyPage } from "../../components/public/record-copy-page"

/**
 * «Tus pendientes» (ADR 0167, «Un enlace por cosa»): lo que la persona tiene por
 * hacer con la clínica, sin sesión. Cada mensaje abre directo lo suyo con
 * `?abre=firma|presupuesto|cita|datos|mensajes`; arriba, siempre, «‹ Tus
 * pendientes» lleva a la lista con el mismo token. `abre=copia` es la copia de su
 * historia, que llega dentro del PDF y no es un pendiente: su propia página.
 */
export const Route = createFileRoute("/pendientes")({
  validateSearch: validatePersonalLinkSearch,
  head: personalLinkHead,
  component: PendingPage,
})

function PendingPage() {
  const search = Route.useSearch()
  if (search.abre === "copia") return <RecordCopyPage token={search.token} />
  return <PersonalLinkPage entry="pendientes" search={search} />
}
