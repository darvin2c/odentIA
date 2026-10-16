import { Button } from "@odentia/ui"
import { ConfirmDialog } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { formatDate } from "../../lib/clinical-journey"

interface SendPreview {
  recipient: { contactId: string; name: string; relation: string }
  channel: "whatsapp" | "email" | null
  label: string | null
  blocked: string | null
  text: string
  /** Hasta cuándo sirve el enlace que ya tiene; nulo si no tiene uno. */
  liveUntil: string | null
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
  const revoke = useMutation({
    mutationFn: () => apiFetch<{ data: { revoked: number } }>(`/api/patients/${patientId}/personal-link`, { method: "DELETE" }),
    onSuccess: () => void preview.refetch(),
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
          revoke.reset()
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
      >
        {preview.isError ? (
          <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => void preview.refetch()}>
            Reintentar
          </Button>
        ) : null}
        {!send.isSuccess && revoke.isSuccess && !data?.liveUntil ? (
          <p role="status" className="text-sm text-muted-foreground">
            Enlace quitado: el que tenía ya no sirve. Lo que hizo con él se conserva.
          </p>
        ) : null}
        {!send.isSuccess && data?.liveUntil ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm">
            <span>Ya tiene un enlace que sirve hasta el {formatDate(data.liveUntil)}.</span>
            <Button type="button" size="sm" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
              Quitar enlace
            </Button>
            {revoke.isError ? <p className="w-full text-destructive">No se pudo quitar. Vuelve a intentarlo.</p> : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </>
  )
}
