import { EmptyState, ErrorState, LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { ApiError } from "../lib/api"
import { personalLinkFromEmail } from "../lib/public-automations"

export const Route = createFileRoute("/c/$token")({
  head: () => ({
    meta: [
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: EmailAppointmentLink,
})

/**
 * Los enlaces de confirmar o cancelar de un correo quedan como redirección a
 * «Su enlace» (ADR 0037): ahí la persona confirma, cambia o cancela su cita,
 * igual que desde WhatsApp. Esta página no muestra nada de la cita.
 */
function EmailAppointmentLink() {
  const { token } = Route.useParams()
  const query = useQuery({
    queryKey: ["public-automation-cita", token],
    queryFn: () => personalLinkFromEmail(token),
    enabled: typeof window !== "undefined",
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const url = query.data?.data.url ?? null
  useEffect(() => {
    if (url) window.location.replace(url)
  }, [url])

  if (query.isError) {
    if (query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 409)) {
      return (
        <PageShell maxWidth="md">
          <EmptyState title="Este enlace ya no sirve" description="Responde el mensaje y te enviamos uno nuevo." />
        </PageShell>
      )
    }
    return (
      <PageShell maxWidth="md">
        <ErrorState title="No pudimos abrir tu cita" message="Revisa tu conexión y vuelve a intentarlo." onRetry={() => void query.refetch()} />
      </PageShell>
    )
  }
  if (query.isSuccess && !url) {
    return (
      <PageShell maxWidth="md">
        <EmptyState title="No pudimos abrir tu cita" description="Escribe a la clínica y te ayudamos." />
      </PageShell>
    )
  }
  return (
    <PageShell maxWidth="md">
      <LoadingState kind="indeterminate" message="Abriendo tu cita…" />
    </PageShell>
  )
}
