import { ConfirmDialog } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { type ReactNode, useState } from "react"
import { apiFetch } from "../../lib/api"
import { resolveWords } from "../../lib/conversation-state"
import type { ResolvePreview } from "../../lib/crm"
import { mutationErrorMessage } from "../../lib/query-error"
import { invalidateAgentPanelQueries } from "../agent-panel"

/**
 * Lo que pasará al resolver una conversación, con lo que devuelve el servidor
 * (`resolve-preview`): qué más se cierra y la despedida que se le enviará. Lo
 * usan «Resolver» en la Bandeja y completar la tarea de un caso del agente en
 * Tareas y en «Contexto»: la misma pieza, no un texto propio por pantalla.
 */
export function ResolvePreviewDetails({ name, preview }: { name: string; preview: ResolvePreview }) {
  const { also } = resolveWords(name, preview)
  return (
    <>
      {also.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {also.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {preview.farewell && preview.farewellText ? (
        <p className="rounded-lg bg-muted/60 p-3 text-sm">
          <span className="font-semibold">Despedida: </span>«{preview.farewellText}»
        </p>
      ) : null}
    </>
  )
}

/** Lo que devuelve `GET /api/tasks/:id/resolve-preview`: null si completar no cierra ninguna conversación. */
interface TaskResolvePreview {
  conversationId: string
  contactName: string
  preview: ResolvePreview
}

/**
 * Completar una tarea (decisión 7 de la fase 2). Si es la del último caso que
 * el agente pasó en una conversación abierta, completarla despide a la persona
 * y cierra la conversación: antes se muestra lo mismo que «Resolver». Si no,
 * se completa sin preguntar. `dialog` va montado en la pantalla que la usa.
 */
export function useCompleteTask(onCompleted: () => void): {
  complete: (taskId: string) => Promise<void>
  pendingId: string | null
  error: string | null
  dialog: ReactNode
} {
  const queryClient = useQueryClient()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<{ taskId: string; result: TaskResolvePreview } | null>(null)

  async function markDone(taskId: string) {
    await apiFetch(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) })
    // Completar puede resolver el caso y cerrar su conversación.
    invalidateAgentPanelQueries(queryClient)
    for (const key of ["tasks", "workspace-home", "crm-context", "conversations"]) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
    onCompleted()
  }

  async function complete(taskId: string) {
    setError(null)
    setPendingId(taskId)
    try {
      const preview = await apiFetch<{ data: TaskResolvePreview | null }>(`/api/tasks/${taskId}/resolve-preview`)
      if (preview.data) {
        setConfirming({ taskId, result: preview.data })
        return
      }
      await markDone(taskId)
    } catch (cause) {
      setError(mutationErrorMessage(cause) ?? "No se pudo completar la tarea. Inténtalo de nuevo.")
    } finally {
      setPendingId(null)
    }
  }

  async function confirm() {
    if (!confirming) return
    setPendingId(confirming.taskId)
    try {
      await markDone(confirming.taskId)
      setConfirming(null)
    } catch (cause) {
      setError(mutationErrorMessage(cause) ?? "No se pudo completar la tarea. Inténtalo de nuevo.")
    } finally {
      setPendingId(null)
    }
  }

  const name = confirming?.result.contactName ?? ""
  const dialog = (
    <ConfirmDialog
      open={confirming !== null}
      title="¿Dar por resuelto el caso?"
      description={confirming ? resolveWords(name, confirming.result.preview).description : ""}
      confirmLabel="Completar y resolver"
      variant="default"
      pending={pendingId !== null && confirming !== null}
      onClose={() => setConfirming(null)}
      onConfirm={() => void confirm()}
    >
      {confirming ? <ResolvePreviewDetails name={name} preview={confirming.result.preview} /> : null}
      {confirming && error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  )
  return { complete, pendingId, error: confirming ? null : error, dialog }
}
