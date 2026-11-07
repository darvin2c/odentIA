/**
 * «Hecho hoy», dentro de «Plan y controles»: los tratamientos vinculados a la
 * atención en curso (por una sesión registrada o porque los trajo la cita).
 *
 * Muestra en qué estado clínico están y permite cerrarlos cuando el trabajo
 * terminó. Completar aquí es explícito: la atención puede finalizar con el
 * tratamiento aún en curso para continuar en una sesión posterior. Sin la sesión
 * de hoy (un procedimiento suyo en esta atención) no se ofrece «Completar»: el
 * botón es «Registrar la sesión», que abre el registro con ese tratamiento puesto.
 */
import { sessionWords, showsSession } from "@odentia/clinical"
import { Badge, Button } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { planDecisionLabel } from "../../lib/budgets"
import { completeTreatmentApi, formatDate } from "../../lib/clinical-journey"
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
  sessionItemIds,
  onRegisterSession,
  disabled = false,
  beforeWrite,
  onChanged,
}: {
  patientId: string
  encounterId: string
  items: PlanItem[]
  /** Los que ya tienen la sesión de hoy (un procedimiento vigente en esta atención). */
  sessionItemIds: ReadonlySet<string>
  onRegisterSession: (itemId: string) => void
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
      setError(submitErrorMessage(mutationError))
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
      setError(submitErrorMessage(caught))
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
          ¿Hiciste la sesión de hoy? Regístrala. «Completar» solo cuando terminaste el tratamiento.
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
            const open =
              item.decisionStatus === "aceptado" &&
              ["pendiente", "programado", "en_curso"].includes(item.status)
            // Completar pide la sesión de hoy; sin ella, se registra primero.
            const hasSession = sessionItemIds.has(item.id)
            // Mientras falten sesiones previstas, «Completar» no es la acción principal.
            const planned = item.plannedSessions ?? 1
            const done = item.sessionsDone ?? 0
            const session = showsSession(Math.max(done, 1), planned) ? ` · ${sessionWords(Math.max(done, 1), planned)}` : ""
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
                        ? `En curso desde ${formatDate(item.startedAt)}${session}`
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
                  {canWrite && !disabled && open && hasSession ? (
                    <Button
                      type="button"
                      size="sm"
                      variant={done < planned ? "outline" : "default"}
                      disabled={completingId != null}
                      onClick={() => void complete(item.id)}
                    >
                      {completingId === item.id ? "Completando…" : "Completar"}
                    </Button>
                  ) : null}
                  {canWrite && !disabled && open && !hasSession ? (
                    <Button type="button" size="sm" onClick={() => onRegisterSession(item.id)}>
                      Registrar la sesión
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
