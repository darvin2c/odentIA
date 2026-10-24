import { Button } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError } from "../../lib/api"
import { fetchAutomationLink, submitAutomationLink } from "../../lib/public-automations"

export const Route = createFileRoute("/baja/$token")({
  head: () => ({
    meta: [
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: PublicUnsubscribePage,
})

/**
 * Baja verificable de un tipo de mensaje (sin sesión): apaga el del mensaje del
 * que salió el enlace y cancela lo que de ese tipo estaba por salir. Lo que deja
 * de recibir lo dice el servidor (`stops`); la página no lo deduce.
 */
function PublicUnsubscribePage() {
  const { token } = Route.useParams()
  const [done, setDone] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const infoQuery = useQuery({
    queryKey: ["public-automation-baja", token],
    queryFn: () => fetchAutomationLink("baja", token),
    enabled: typeof window !== "undefined",
    retry: false,
    staleTime: 30_000,
  })

  const stops = infoQuery.data?.data.stops ?? null

  if (done) {
    return (
      <PageShell maxWidth="md">
        <EmptyState
          title="Baja confirmada"
          description={`Ya no recibirás ${stops?.what ?? "estos mensajes"}. Si cambias de opinión, avísale a recepción.`}
        />
      </PageShell>
    )
  }

  if (infoQuery.isPending) {
    return (
      <PageShell maxWidth="md">
        <LoadingState message="Cargando la solicitud de baja…" />
      </PageShell>
    )
  }

  if (infoQuery.isError) {
    return (
      <PageShell maxWidth="md">
        <ErrorState
          title="Enlace no disponible"
          error={
            infoQuery.error instanceof ApiError
              ? infoQuery.error.shape
              : infoQuery.error instanceof Error
                ? infoQuery.error
                : "No pudimos cargar la solicitud. Inténtalo más tarde."
          }
          onRetry={() => void infoQuery.refetch()}
        />
      </PageShell>
    )
  }

  const info = infoQuery.data.data
  if (info.expired || info.used || info.purpose !== "baja") {
    return (
      <PageShell maxWidth="md">
        <EmptyState
          title="Enlace no disponible"
          description="Este enlace ya fue usado o venció. Comunícate con recepción si deseas dejar de recibir mensajes."
        />
      </PageShell>
    )
  }

  async function handleUnsubscribe() {
    setSubmitError(null)
    setSubmitting(true)
    try {
      await submitAutomationLink("baja", token, "baja")
      setDone(true)
    } catch (error) {
      const shape = error instanceof ApiError ? error.shape : null
      setSubmitError(shape?.message ?? "No pudimos completar la baja. Inténtalo de nuevo.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <PageShell maxWidth="md">
      <PageHeader
        title={`Dejar de recibir ${stops?.what ?? "estos mensajes"}`}
        subtitle={[stops?.detail, "Al confirmar, dejan de llegarte y se cancelan los que estaban por salir.", stops?.keeps]
          .filter(Boolean)
          .join(" ")}
      />
      {submitError ? (
        <p role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          {submitError}
        </p>
      ) : null}
      <div className="mt-6">
        <Button type="button" className="min-h-11 w-full" disabled={submitting} onClick={handleUnsubscribe}>
          {submitting ? "Procesando…" : "Confirmar baja"}
        </Button>
      </div>
    </PageShell>
  )
}
