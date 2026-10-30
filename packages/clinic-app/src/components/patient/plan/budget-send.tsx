/**
 * Enviar el presupuesto por la regla de siempre (WhatsApp primero, correo si
 * no): el botón dice por dónde saldrá y a quién le llega antes de pulsarlo,
 * con lo que entrega el servidor (`send-preview`). Si no hay vía, dice por qué
 * y deja «Imprimir y entregar» como camino. Lo usan el Plan, el cierre de la
 * atención, «Plan y controles» e Inicio: una sola operación.
 */
import { Button, toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import type { ComponentProps } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import {
  fetchBudgetSendPreview,
  PLAN_QUERY_KEYS,
  type SendBudgetResult,
  sendBudgetApi,
} from "../../../lib/budgets"
import { usePermission } from "../../../lib/crm"

/** Lo que dice el aviso cuando sale: «Enviado a Lucía por WhatsApp». */
function sentText(result: SendBudgetResult): string {
  const where = result.channel === "whatsapp" ? "por WhatsApp" : "por correo"
  const first = result.recipientName.trim().split(/\s+/)[0] ?? result.recipientName
  return result.via === "plantilla"
    ? `Enviado a ${first} ${where}: le llega el aviso y, al tocarlo, el PDF`
    : `Enviado a ${first} ${where}, con el PDF`
}

export function useBudgetSendPreview(patientId: string, budgetId: string | null, enabled = true) {
  const canSend = usePermission("budgets.send")
  return useQuery({
    queryKey: ["budget-send-preview", patientId, budgetId],
    queryFn: () => fetchBudgetSendPreview(patientId, budgetId as string),
    enabled: enabled && canSend && budgetId != null,
    retry: false,
  })
}

export function BudgetSendButton({
  patientId,
  budgetId,
  onSent,
  showRecipient = true,
  size = "default",
  variant = "default",
  beforeSend,
}: {
  patientId: string
  budgetId: string
  onSent?: (result: SendBudgetResult) => void
  /** Debajo del botón, a quién le llega. */
  showRecipient?: boolean
  size?: ComponentProps<typeof Button>["size"]
  variant?: ComponentProps<typeof Button>["variant"]
  /** Lo que hay que guardar antes (el borrador de la atención, por ejemplo). */
  beforeSend?: () => Promise<void>
}): React.JSX.Element | null {
  const canSend = usePermission("budgets.send")
  const queryClient = useQueryClient()
  const preview = useBudgetSendPreview(patientId, budgetId)
  // Una clave por intento: repetir el clic o reintentar tras un corte no lo envía dos veces.
  const requestId = useRef<string>(crypto.randomUUID())
  const [error, setError] = useState<string | null>(null)
  const send = useMutation({
    mutationFn: async () => {
      await beforeSend?.()
      return sendBudgetApi(patientId, budgetId, { requestId: requestId.current })
    },
    onSuccess: async (result) => {
      requestId.current = crypto.randomUUID()
      setError(null)
      toast.success(sentText(result.data))
      await Promise.all(
        [...PLAN_QUERY_KEYS, "budget-send-preview"].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key, patientId] }),
        ),
      )
      onSent?.(result.data)
    },
    onError: (err) => setError(submitErrorMessage(err)),
  })
  if (!canSend) return null
  const data = preview.data?.data
  const blocked = data?.blocked ?? null
  const label = data?.label ?? "Enviar"
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        size={size}
        variant={variant}
        disabled={preview.isPending || blocked != null || send.isPending}
        onClick={() => {
          setError(null)
          send.mutate()
        }}
      >
        {send.isPending ? "Enviando…" : label}
      </Button>
      {showRecipient && data && !blocked ? (
        <span className="text-xs text-muted-foreground">
          Le llega a {data.recipient.name}
          {data.recipient.relation === "representante_legal" ? ", su representante" : ""}
        </span>
      ) : null}
      {blocked ? (
        <span role="status" className="text-xs text-muted-foreground">
          {blocked}
        </span>
      ) : null}
      {preview.isError ? (
        <span role="alert" className="text-xs text-destructive">
          {submitErrorMessage(preview.error)}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  )
}
