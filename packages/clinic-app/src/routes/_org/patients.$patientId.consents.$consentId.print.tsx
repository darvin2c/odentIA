import { EmptyState, LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ConsentPaper } from "../../components/patient/document-papers"
import { fetchConsents } from "../../lib/clinical-forms"
import { QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/patients/$patientId/consents/$consentId/print")({
  component: ConsentPrintPage,
})

/**
 * El consentimiento en su propia dirección: pendiente, la hoja para firmar en papel o lo que firmó en su enlace; firmado, el guardado.
 * Queda porque hay enlaces guardados; la hoja es el PDF, como en la superficie lateral.
 */
function ConsentPrintPage() {
  const { patientId, consentId } = Route.useParams()
  const query = useQuery({
    queryKey: ["consents", patientId],
    queryFn: () => fetchConsents({ patientId }),
  })
  if (query.isPending)
    return (
      <PageShell>
        <LoadingState kind="indeterminate" message="Preparando el consentimiento…" />
      </PageShell>
    )
  if (query.isError)
    return (
      <PageShell>
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      </PageShell>
    )
  const found = query.data.data.find((row) => row.id === consentId)
  if (!found)
    return (
      <PageShell>
        <EmptyState
          title="No encontramos este consentimiento"
          description="Puede que este enlace sea de otra persona o ya no exista."
        />
      </PageShell>
    )
  return <ConsentPaper page document={found} />
}
