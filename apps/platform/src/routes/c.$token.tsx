import { Button } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError } from "../lib/api"
import { fetchAutomationLink, submitAutomationLink } from "../lib/public-automations"

export const Route = createFileRoute("/c/$token")({
  head: () => ({
    meta: [
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: PublicAppointmentPage,
})

/**
 * Página pública amable de confirmación/cancelación de cita (sin sesión).
 * El token opaco resuelve el tenant en el servidor; la página nunca recibe
 * ni muestra datos del paciente: solo fecha/hora y la acción del enlace.
 */
function PublicAppointmentPage() {
  const { token } = Route.useParams()
  const [done, setDone] = useState<"confirmada" | "cancelada" | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const infoQuery = useQuery({
    queryKey: ["public-automation-cita", token],
    queryFn: () => fetchAutomationLink("cita", token),
    enabled: typeof window !== "undefined",
    retry: false,
    staleTime: 30_000,
  })

  if (done !== null) {
    return (
      <PageShell maxWidth="md">
        <EmptyState
          title={done === "confirmada" ? "Cita confirmada" : "Cita cancelada"}
          description={
            done === "confirmada"
              ? "Tu asistencia quedó registrada. Te esperamos en la fecha indicada."
              : "Tu cita quedó cancelada. Responde al mensaje de la clínica si deseas reprogramarla."
          }
        />
      </PageShell>
    )
  }

  if (infoQuery.isPending) {
    return (
      <PageShell maxWidth="md">
        <LoadingState message="Cargando tu cita…" />
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
                : "No pudimos cargar la cita. Inténtalo más tarde."
          }
          onRetry={() => void infoQuery.refetch()}
        />
      </PageShell>
    )
  }

  const info = infoQuery.data.data
  if (info.expired || info.used || info.purpose === "baja") {
    return (
      <PageShell maxWidth="md">
        <EmptyState
          title="Enlace no disponible"
          description="Este enlace ya fue usado o venció. Comunícate con recepción para confirmar tu cita."
        />
      </PageShell>
    )
  }

  const isConfirm = info.purpose === "confirm"

  async function handleAction() {
    setSubmitError(null)
    setSubmitting(true)
    try {
      await submitAutomationLink("cita", token, isConfirm ? "confirmar" : "cancelar")
      setDone(isConfirm ? "confirmada" : "cancelada")
    } catch (error) {
      const shape = error instanceof ApiError ? error.shape : null
      setSubmitError(shape?.message ?? "No pudimos completar la solicitud. Inténtalo de nuevo.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <PageShell maxWidth="md">
      <PageHeader
        title={isConfirm ? "Confirma tu cita" : "Cancela tu cita"}
        subtitle={
          info.when
            ? `Cita programada para el ${info.when} (hora local). ${
                isConfirm
                  ? "Al confirmar, tu lugar queda reservado. Si no puedes asistir, usa el enlace de cancelación del mensaje."
                  : "Al cancelar, tu lugar queda libre. Esta acción no se puede deshacer desde aquí."
              }`
            : isConfirm
              ? "Al confirmar, tu lugar queda reservado. Si no puedes asistir, usa el enlace de cancelación del mensaje."
              : "Al cancelar, tu lugar queda libre. Esta acción no se puede deshacer desde aquí."
        }
      />
      {submitError ? (
        <p role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          {submitError}
        </p>
      ) : null}
      <div className="mt-6">
        <Button type="button" className="min-h-11 w-full" disabled={submitting} onClick={handleAction}>
          {submitting ? "Procesando…" : isConfirm ? "Confirmar mi cita" : "Cancelar mi cita"}
        </Button>
      </div>
    </PageShell>
  )
}
