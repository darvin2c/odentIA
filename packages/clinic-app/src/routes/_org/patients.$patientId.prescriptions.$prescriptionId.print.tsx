import { EmptyState, LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { PrescriptionPaper } from "../../components/patient/document-papers"
import { fetchPrescriptionDetail } from "../../lib/clinical-journey"
import { QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/patients/$patientId/prescriptions/$prescriptionId/print")({
  component: PrescriptionPrintPage,
})

/**
 * La receta en su propia dirección: el PDF con «Enviar», «Descargar PDF» e «Imprimir».
 * Queda porque hay enlaces guardados; la hoja es el PDF, como en la superficie lateral.
 */
function PrescriptionPrintPage() {
  const { patientId, prescriptionId } = Route.useParams()
  const query = useQuery({
    queryKey: ["prescription", patientId, prescriptionId],
    queryFn: () => fetchPrescriptionDetail(patientId, prescriptionId),
  })
  if (query.isPending)
    return (
      <PageShell>
        <LoadingState kind="indeterminate" message="Preparando la receta…" />
      </PageShell>
    )
  if (query.isError)
    return (
      <PageShell>
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      </PageShell>
    )
  const found = query.data.data
  if (!found)
    return (
      <PageShell>
        <EmptyState title="No encontramos esta receta" description="Puede que este enlace sea de otra persona o ya no exista." />
      </PageShell>
    )
  return <PrescriptionPaper page patientId={patientId} prescription={found} />
}
