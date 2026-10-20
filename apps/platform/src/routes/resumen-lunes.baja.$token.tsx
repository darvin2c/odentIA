import { Button } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ApiError } from "../lib/api"
import { confirmReportDigestStop, fetchReportDigestStop } from "../lib/public-automations"

export const Route = createFileRoute("/resumen-lunes/baja/$token")({
  head: () => ({
    meta: [
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: ReportDigestStopPage,
})

/**
 * «Dejar de recibirlo» del resumen del lunes (sin sesión, ADR 0071): el enlace
 * del correo lleva a la persona firmada, así que basta con confirmar. Solo
 * apaga; volver a recibirlo es desde Reportes.
 */
function ReportDigestStopPage() {
  const { token } = Route.useParams()
  const info = useQuery({
    queryKey: ["report-digest-stop", token],
    queryFn: () => fetchReportDigestStop(token),
    enabled: typeof window !== "undefined",
    retry: false,
  })
  const stop = useMutation({ retry: false, mutationFn: () => confirmReportDigestStop(token) })

  if (stop.isSuccess || info.data?.data.enabled === false) {
    return (
      <PageShell maxWidth="md">
        <EmptyState
          title="Ya no te llega el resumen del lunes"
          description={`Dejaste de recibirlo${info.data?.data.clinic ? ` de ${info.data.data.clinic}` : ""}. Si quieres volver a recibirlo, préndelo en Reportes.`}
        />
      </PageShell>
    )
  }
  if (info.isPending) {
    return (
      <PageShell maxWidth="md">
        <LoadingState />
      </PageShell>
    )
  }
  if (info.isError) {
    return (
      <PageShell maxWidth="md">
        <ErrorState
          title="Enlace no disponible"
          error={info.error instanceof ApiError ? info.error.shape : "No pudimos abrir el enlace. Inténtalo más tarde."}
          onRetry={() => void info.refetch()}
        />
      </PageShell>
    )
  }
  return (
    <PageShell maxWidth="md">
      <PageHeader
        title="Dejar de recibir el resumen del lunes"
        subtitle={`El correo de cada lunes con las cifras de la semana de ${info.data.data.clinic}. Las cifras siguen en Reportes.`}
      />
      {stop.isError ? (
        <p role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          {stop.error instanceof ApiError && stop.error.shape.message ? stop.error.shape.message : "No pudimos completarlo. Inténtalo de nuevo."}
        </p>
      ) : null}
      <div className="mt-6">
        <Button type="button" className="min-h-11 w-full" disabled={stop.isPending} onClick={() => stop.mutate()}>
          {stop.isPending ? "Procesando…" : "Dejar de recibirlo"}
        </Button>
      </div>
    </PageShell>
  )
}
