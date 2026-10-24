import { Button } from "@odentia/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { mutationErrorMessage } from "../../lib/query-error"

/**
 * Escribe alguien desde un número que es el «Teléfono» de otra persona de la
 * clínica (decisión 23, caso 3). Nunca se une por coincidencia (ADR 0027): se
 * pregunta, y solo «Sí, es Carmen» de alguien del equipo la une a su ficha,
 * con la misma operación que «Reasignar canal».
 */
export function PhoneMatchPrompt({ conversationId }: { conversationId: string }) {
  const canWrite = usePermission("conversations.write")
  const queryClient = useQueryClient()
  const match = useQuery({
    queryKey: ["conversation-phone-match", conversationId],
    queryFn: () =>
      apiFetch<{ data: { personId: string; personName: string } | null }>(
        `/api/conversations/${conversationId}/phone-match`,
      ),
    enabled: canWrite,
    retry: false,
  })
  const confirm = useMutation({
    mutationFn: (personId: string) =>
      apiFetch(`/api/conversations/${conversationId}/phone-match`, {
        method: "POST",
        body: JSON.stringify({ personId }),
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversation-phone-match", conversationId] }),
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["conversation"] }),
        queryClient.invalidateQueries({ queryKey: ["person"] }),
      ])
    },
  })
  const found = match.data?.data
  if (!canWrite || !found) return null
  const first = found.personName.split(/\s+/)[0] ?? found.personName
  return (
    <div role="status" className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm">
      <p>
        Este número es el teléfono de <span className="font-medium">{found.personName}</span>. ¿Es la misma persona?
      </p>
      <p className="text-xs text-muted-foreground">
        No se une sola: un mismo teléfono puede ser de otra persona. Si es ella, su conversación pasa a su página y el
        número queda como su WhatsApp.
      </p>
      <div>
        <Button size="sm" disabled={confirm.isPending} onClick={() => confirm.mutate(found.personId)}>
          {confirm.isPending ? "Uniendo…" : `Sí, es ${first}`}
        </Button>
      </div>
      {confirm.error ? (
        <p role="alert" className="text-xs text-destructive">
          {mutationErrorMessage(confirm.error)}
        </p>
      ) : null}
    </div>
  )
}
