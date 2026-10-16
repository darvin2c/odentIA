import { Button } from "@odentia/ui"
import { ConfirmDialog } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"

interface SendPreview {
  recipient: { contactId: string; name: string; relation: string }
  channel: "whatsapp" | "email" | null
  label: string | null
  blocked: string | null
  text: string
}

/**
 * «Enviarle su enlace» (decisión 8, ADR 0037): junto a «Completar», para que
 * la persona complete lo que falta (y vea su cita o su presupuesto) desde su
 * teléfono. Antes de enviar dice a quién y por dónde le llega; el servidor
 * elige el canal con la regla de siempre y no lo envía dos veces.
 */
export function SendPersonalLinkButton({ patientId, size = "sm" }: { patientId: string; size?: "sm" | "default" }) {
  const [open, setOpen] = useState(false)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const preview = useQuery({
    queryKey: ["personal-link-preview", patientId],
    queryFn: () => apiFetch<{ data: SendPreview }>(`/api/patients/${patientId}/personal-link/preview`),
    enabled: open,
    retry: false,
  })
  const send = useMutation({
    mutationFn: () =>
      apiFetch<{ data: { recipientName: string } }>(`/api/patients/${patientId}/personal-link`, {
        method: "POST",
        body: JSON.stringify({ requestId }),
      }),
  })
  const data = preview.data?.data
  const problem = send.error instanceof ApiError ? (send.error.shape.message ?? "No se pudo enviar.") : send.error ? "No se pudo enviar. Revisa tu conexión." : null
  const description = send.isSuccess
    ? `Listo: le llegó a ${send.data.data.recipientName}. Cuando lo envíe, lo verás en su página.`
    : preview.isPending
      ? "Revisando por dónde le llega…"
      : preview.isError
        ? "No pudimos revisar por dónde le llega."
        : data?.blocked
          ? data.blocked
          : data
            ? `Le llega a ${data.recipient.name} ${data.channel === "email" ? "por correo" : "por WhatsApp"}: «${data.text}» Ahí completa lo que falta, y ve su cita y lo que tenga pendiente.`
            : ""
  return (
    <>
      <Button
        type="button"
        size={size}
        variant="outline"
        onClick={() => {
          send.reset()
          setRequestId(crypto.randomUUID())
          setOpen(true)
        }}
      >
        Enviarle su enlace
      </Button>
      <ConfirmDialog
        open={open}
        title="Enviarle su enlace"
        description={problem ? `${description} ${problem}` : description}
        confirmLabel={send.isSuccess ? "Listo" : (data?.label ?? "Enviar")}
        cancelLabel={send.isSuccess ? "Cerrar" : "Cancelar"}
        variant="default"
        pending={send.isPending}
        confirmDisabled={!send.isSuccess && (!data || data.blocked !== null)}
        onClose={() => {
          if (!send.isPending) setOpen(false)
        }}
        onConfirm={() => {
          if (send.isSuccess) setOpen(false)
          else send.mutate()
        }}
      />
    </>
  )
}
