import { Badge, Button } from "@odentia/ui"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "../../lib/api"
import { useCan } from "../../lib/crm"
import type { PhoneWhatsApp } from "../../lib/people"
import { mutationErrorMessage } from "../../lib/query-error"

/**
 * Junto a su teléfono (decisión 23): si ese número aún no es su WhatsApp,
 * «Usarlo como su WhatsApp» (la decisión es de quien lo pulsa, ADR 0027); si
 * WhatsApp lo rechazó, «Este número no tiene WhatsApp». Siendo su WhatsApp,
 * nada que decir.
 */
export function PhoneWhatsAppNote({ contactId, value }: { contactId: string; value: PhoneWhatsApp }) {
  const can = useCan()
  const queryClient = useQueryClient()
  const use = useMutation({
    mutationFn: () => apiFetch(`/api/people/${contactId}/whatsapp`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["person"] })
      await queryClient.invalidateQueries({ queryKey: ["agenda-appointment"] })
    },
  })
  if (value.state === "no_tiene") {
    return (
      <span className="mt-1 flex flex-col gap-1">
        <Badge variant="warning" className="w-fit">
          Este número no tiene WhatsApp
        </Badge>
        <span className="text-xs text-muted-foreground">
          WhatsApp no pudo entregarle un mensaje. Los recordatorios le llegan por correo; sin correo, «Te espera» pide
          llamarla.
        </span>
      </span>
    )
  }
  if (value.state !== "aun_no") return null
  const canUse = value.canUse && (can("conversations.write") || can("patients.write"))
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2">
      <Badge variant="outline">Aún no es su WhatsApp</Badge>
      {canUse ? (
        <Button type="button" size="sm" variant="outline" disabled={use.isPending} onClick={() => use.mutate()}>
          {use.isPending ? "Guardando…" : "Usarlo como su WhatsApp"}
        </Button>
      ) : null}
      {use.error ? (
        <span role="alert" className="w-full text-xs text-destructive">
          {mutationErrorMessage(use.error)}
        </span>
      ) : null}
    </span>
  )
}
