/**
 * Una atención cerrada, leída al lado (lienzo «Paciente: cada acción en su
 * sitio», tablero 2): «Ver» de la última atención ya no saca de la ficha. Es la
 * misma vista de lectura de la página de la atención; «Abrir la atención» lleva
 * a la página para quien necesita sus documentos o controles.
 */
import { buttonVariants } from "@odentia/ui"
import { DetailDrawer } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { apiFetch } from "../../lib/api"
import type { EncounterDetail } from "../../lib/patients"
import { EncounterDetailView } from "./encounter-detail-view"

export function EncounterReadDrawer({
  patientId,
  encounterId,
  title,
  onClose,
}: {
  patientId: string
  encounterId: string
  /** «12 oct · Corona cerámica»: lo que la tarjeta ya decía. */
  title: string
  onClose: () => void
}): React.JSX.Element {
  const query = useQuery({
    queryKey: ["encounter", patientId, encounterId],
    queryFn: () => apiFetch<{ data: EncounterDetail }>(`/api/patients/${patientId}/encounters/${encounterId}`),
  })
  return (
    <DetailDrawer
      open
      size="lg"
      title={title}
      isLoading={query.isPending}
      error={query.isError ? "No se pudo abrir la atención. Ciérrala y vuelve a intentarlo." : null}
      onClose={onClose}
      actions={
        <Link
          to="/patients/$patientId/encounters/$encounterId"
          params={{ patientId, encounterId }}
          className={buttonVariants({ variant: "ghost" })}
        >
          Abrir la atención
        </Link>
      }
    >
      {query.data ? <EncounterDetailView patientId={patientId} detail={query.data.data} showAddendum={false} /> : null}
    </DetailDrawer>
  )
}
