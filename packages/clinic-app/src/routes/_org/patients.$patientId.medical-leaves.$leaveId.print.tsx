import { EmptyState, LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { MedicalLeavePaper } from "../../components/patient/document-papers"
import { fetchMedicalLeaves } from "../../lib/medical-leaves"
import { QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/patients/$patientId/medical-leaves/$leaveId/print")({
  component: MedicalLeavePrintPage,
})

/**
 * El descanso médico en su propia dirección: el PDF con «Enviar», «Descargar PDF» e «Imprimir».
 * Queda porque hay enlaces guardados; la hoja es el PDF, como en la superficie lateral.
 */
function MedicalLeavePrintPage() {
  const { patientId, leaveId } = Route.useParams()
  const query = useQuery({
    queryKey: ["medical-leaves", patientId],
    queryFn: () => fetchMedicalLeaves(patientId),
  })
  if (query.isPending)
    return (
      <PageShell>
        <LoadingState kind="indeterminate" message="Preparando el descanso médico…" />
      </PageShell>
    )
  if (query.isError)
    return (
      <PageShell>
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      </PageShell>
    )
  const found = query.data.data.find((row) => row.id === leaveId)
  if (!found)
    return (
      <PageShell>
        <EmptyState title="No encontramos este descanso médico" description="Puede que este enlace sea de otra persona o ya no exista." />
      </PageShell>
    )
  return <MedicalLeavePaper page patientId={patientId} leave={found} />
}
