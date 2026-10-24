/**
 * «Hecho hoy», dentro de «Plan y controles»: los tratamientos vinculados a la
 * atención en curso (por una sesión registrada o porque los trajo la cita).
 *
 * Muestra en qué estado clínico están y permite cerrarlos cuando el trabajo
 * terminó. Completar aquí es explícito: la atención puede finalizar con el
 * tratamiento aún en curso para continuar en una sesión posterior.
 */
import { Badge, Button } from "@odentia/ui"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { planDecisionLabel } from "../../lib/budgets"
import { completeTreatmentApi, formatDate, mutationMessage } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { type PlanItem, planStatusLabel } from "../../lib/patients"

function decisionBadge(status: string): "default" | "secondary" | "success" | "destructive" {
  if (status === "aceptado") return "success"
  if (status === "rechazado" || status === "reemplazado") return "destructive"
  if (status === "pospuesto") return "secondary"
  return "default"
}

export function EncounterTreatments({
  patientId,
  encounterId,
  items,
  disabled = false,
  beforeWrite,
  onChanged,
}: {
  patientId: string
  encounterId: string
  items: PlanItem[]
  disabled?: boolean
  beforeWrite?: () => Promise<void>
  onChanged?: () => void
}): React.JSX.Element {
  const canWrite = usePermission("clinical.write")
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [completingId, setCompletingId] = useState<string | null>(null)
  const completeMutation = useMutation({
    mutationFn: (itemId: string) => completeTreatmentApi(patientId, itemId, { encounterId }),
    onSuccess: () => {
      setCompletingId(null)
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ["encounter", patientId, encounterId] })
      void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
      void queryClient.invalidateQueries({ queryKey: ["plan-items", patientId] })
      void queryClient.invalidateQueries({ queryKey: ["treatment-journey", patientId] })
      onChanged?.()
    },
    onError: (mutationError) => {
      setCompletingId(null)
      setError(mutationMessage(mutationError))
    },
  })

  const complete = async (itemId: string) => {
    setError(null)
    setCompletingId(itemId)
    try {
      if (beforeWrite) await beforeWrite()
      completeMutation.mutate(itemId)
    } catch (caught) {
      setCompletingId(null)
      setError(mutationMessage(caught))
    }
  }

  const openJourney = (itemId: string) => {
    void navigate({
      to: "/patients/$patientId",
      params: { patientId },
      search: { tab: "plan", itemId },
    })
  }

  return (
    <div className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-col gap-1.5">
        <h3 className="font-heading text-base font-medium">Hecho hoy</h3>
        <p className="text-sm text-muted-foreground">
          Registrar una sesión lo deja en curso; «Completar» lo cierra. Un servicio directo queda
          realizado al registrarlo.
        </p>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Ningún tratamiento del plan en esta atención. Al registrar un procedimiento de un
          tratamiento indicado, aparece aquí.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {items.map((item) => {
            const canComplete =
              item.decisionStatus === "aceptado" &&
              ["pendiente", "programado", "en_curso"].includes(item.status)
            return (
              <li key={item.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{item.title}</span>
                  <Badge variant={decisionBadge(item.decisionStatus)}>
                    {planDecisionLabel(item.decisionStatus)}
                  </Badge>
                  <Badge variant="secondary">{planStatusLabel(item.status)}</Badge>
                  <span className="text-sm text-muted-foreground">
                    {item.completedAt
                      ? `Completado el ${formatDate(item.completedAt)}`
                      : item.startedAt
                        ? `En curso desde ${formatDate(item.startedAt)}`
                        : ""}
                  </span>
                </div>
                {item.statusReason ? (
                  <p className="text-sm text-muted-foreground">
                    Motivo del estado: {item.statusReason}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => openJourney(item.id)}
                  >
                    Ver recorrido
                  </Button>
                  {canWrite && !disabled && canComplete ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={completingId != null}
                      onClick={() => void complete(item.id)}
                    >
                      {completingId === item.id ? "Completando…" : "Completar"}
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
