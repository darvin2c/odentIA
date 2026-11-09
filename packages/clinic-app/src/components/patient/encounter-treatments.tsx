/**
 * «Realizado hoy» de la atención: los tratamientos vinculados a la
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

  // Sin tratamientos del plan en la atención, «Realizado hoy» muestra solo lo registrado.
  if (items.length === 0) return <>{null}</>
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        Lo que con la sesión de hoy llega a sus sesiones previstas queda realizado al firmar;
        «Completar» lo termina antes.
      </p>
      {
        <ul className="flex flex-col divide-y" aria-label="Tratamientos de esta atención">
          {items.map((item) => {
            const open =
              item.decisionStatus === "aceptado" &&
              ["pendiente", "programado", "en_curso"].includes(item.status)
            // Completar pide la sesión de hoy; sin ella, se registra primero.
            const hasSession = sessionItemIds.has(item.id)
            // Mientras falten sesiones previstas, «Completar» no es la acción principal.
            const planned = item.plannedSessions ?? 1
            // Las hechas cuentan esta atención si ya tiene su sesión (el servidor la cuenta); si no, hoy es la siguiente.
            const done = item.sessionsDone ?? 0
            const today = hasSession ? Math.max(done, 1) : done + 1
            const session = showsSession(today, planned)
              ? ` · ${sessionWords(today, planned)}${hasSession ? "" : " · por registrar"}`
              : ""
            // Lo que se hizo en esta atención, aún sin firmar: «Aceptado · Realizado ·
            // Completado el…» lo daba por cerrado antes de la firma (QA del 9 nov).
            const doneToday = item.status === "realizado" && hasSession
            return (
              <li key={item.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{item.title}</span>
                  {doneToday ? (
                    <>
                      <Badge variant="secondary">Se hace hoy</Badge>
                      <span className="text-sm text-muted-foreground">Queda realizado al firmar</span>
                    </>
                  ) : (
                    <>
                      <Badge variant={decisionBadge(item.decisionStatus)}>
                        {planDecisionLabel(item.decisionStatus)}
                      </Badge>
                      <Badge variant="secondary">{planStatusLabel(item.status)}</Badge>
                    </>
                  )}
                  <span className="text-sm text-muted-foreground" hidden={doneToday}>
                    {item.completedAt
                      ? `Completado el ${formatDate(item.completedAt)}`
                      : item.startedAt
                        ? `En curso desde ${formatDate(item.startedAt)}${session}`
                        : session.replace(/^ · /, "")}
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
                    variant="ghost"
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
      }

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
