import { EmptyState, LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { OrderPaper } from "../../components/patient/document-papers"
import { fetchOrders } from "../../lib/clinical-forms"
import { QueryErrorState } from "../../lib/query-error"

export const Route = createFileRoute("/_org/patients/$patientId/orders/$orderId/print")({
  component: OrderPrintPage,
})

/**
 * La orden en su propia dirección: el PDF con «Enviar», «Descargar PDF» e «Imprimir».
 * Queda porque hay enlaces guardados; la hoja es el PDF, como en la superficie lateral.
 */
function OrderPrintPage() {
  const { patientId, orderId } = Route.useParams()
  const query = useQuery({
    queryKey: ["clinical-orders", patientId, "indice"],
    queryFn: () => fetchOrders({ patientId }),
  })
  if (query.isPending)
    return (
      <PageShell>
        <LoadingState kind="indeterminate" message="Preparando la orden…" />
      </PageShell>
    )
  if (query.isError)
    return (
      <PageShell>
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      </PageShell>
    )
  const found = query.data.data.find((row) => row.id === orderId)
  if (!found)
    return (
      <PageShell>
        <EmptyState title="No encontramos esta orden" description="Puede que este enlace sea de otra persona o ya no exista." />
      </PageShell>
    )
  return <OrderPaper page order={found} />
}
