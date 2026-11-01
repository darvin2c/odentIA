import { submitErrorMessage } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { apiFetch } from "../../lib/api"
import { invalidateAgentWork } from "../../lib/agent-work"

/**
 * «Hecha» en una tarea, la misma en Inicio, Tareas, Contexto y la oportunidad.
 * Completar la de un tema no cierra su conversación (ADR 0050): no hay nada que
 * avisar antes.
 */
export function useCompleteTask(onCompleted: () => void): {
  complete: (taskId: string) => Promise<void>
  pendingId: string | null
  error: string | null
} {
  const queryClient = useQueryClient()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function complete(taskId: string) {
    setError(null)
    setPendingId(taskId)
    try {
      await apiFetch(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) })
      invalidateAgentWork(queryClient)
      for (const key of ["tasks", "workspace-home", "crm-context", "conversations"]) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
      onCompleted()
    } catch (cause) {
      setError(submitErrorMessage(cause))
    } finally {
      setPendingId(null)
    }
  }

  return { complete, pendingId, error }
}
