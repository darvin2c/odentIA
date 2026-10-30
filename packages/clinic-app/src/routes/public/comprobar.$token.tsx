import { LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import {
  DocumentCheckResult,
  DocumentCheckUnavailable,
} from "../../components/public/document-check"
import { fetchDocumentCheck } from "../../lib/document-check"

export const Route = createFileRoute("/comprobar/$token")({
  head: () => ({
    meta: [
      { title: "Comprobar documento" },
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: CheckDocumentPage,
})

/**
 * Comprobar un papel con su QR (ADR 0112), sin cuenta: lo abre quien lo tiene en
 * la mano. Un código inválido y un documento que no está dicen lo mismo.
 */
function CheckDocumentPage() {
  const { token } = Route.useParams()
  const query = useQuery({
    queryKey: ["document-check", token],
    queryFn: () => fetchDocumentCheck(token),
    enabled: typeof window !== "undefined",
    retry: false,
    staleTime: 30_000,
  })
  if (query.isError) return <DocumentCheckUnavailable onRetry={() => void query.refetch()} />
  if (query.isPending)
    return (
      <PageShell maxWidth="md">
        <LoadingState message="Comprobando el documento…" />
      </PageShell>
    )
  return query.data ? <DocumentCheckResult check={query.data} /> : <DocumentCheckUnavailable />
}
