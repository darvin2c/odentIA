import { Button, toast } from "@odentia/ui"
import { ConfirmDialog, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { api } from "../lib/api"
import { focusInsideLater } from "../lib/focus"

/**
 * Las dos salidas de un informe que quedó «no se sabe si salió» (ADR 0104 y 0183), en el
 * registro de Alta y en la tarea urgente de Hoy. Las decide una persona después de mirar
 * en Zoho: «Revisé en Zoho: salió» lo cierra como enviado sin reenviarlo, y «No salió:
 * reenviar» manda el mismo informe (mismo número, PDF y destinatario) una vez por
 * pulsación. Si se vuelve a cortar, queda otra vez sin saberse: nada se reintenta solo.
 * Solo Administración; el servidor lo exige.
 */
export function UnknownReportActions({
  organizationId,
  number,
  to,
  canResend,
  size = "default",
}: {
  organizationId: string
  number: number
  to: string | null
  /** Sin el PDF o el correo guardados (un informe de antes), no se reenvía desde aquí. */
  canResend: boolean
  size?: "default" | "sm"
}) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  // Al quedar enviado, estos botones (y en Hoy, la fila) se van: el foco pasa a su sección.
  const box = useRef<HTMLDivElement>(null)
  const keepFocus = () => {
    const section = box.current?.closest("section") ?? null
    focusInsideLater(() => section)
  }
  const base = `/api/admin/imports/${organizationId}/reports/${number}`
  // Lo que cambia: el registro, la ficha, Hoy y Kairós (la tarea se cierra al quedar enviado).
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "org-load-record", organizationId] })
    void queryClient.invalidateQueries({ queryKey: ["admin", "client"] })
    void queryClient.invalidateQueries({ queryKey: ["admin", "clients"] })
    void queryClient.invalidateQueries({ queryKey: ["admin", "kairos"] })
    void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
  }
  const confirmSent = useMutation({
    mutationFn: () => api(`${base}/confirm-sent`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      toast.success(`El informe N.º ${number} quedó como enviado`)
      keepFocus()
      refresh()
    },
    onError: (error) => {
      toast.error(submitErrorMessage(error))
      refresh()
    },
  })
  const resend = useMutation({
    mutationFn: () => api(`${base}/resend`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      toast.success(`Salió otra vez el informe N.º ${number}${to ? ` a ${to}` : ""}`)
      setConfirming(false)
      keepFocus()
      refresh()
    },
    // Si se cortó otra vez, queda sin saberse: se cierra la pregunta (otra pulsación es otro
    // envío, a propósito) y se vuelve a leer el estado.
    onError: (error) => {
      toast.error(submitErrorMessage(error))
      setConfirming(false)
      refresh()
    },
  })
  const busy = confirmSent.isPending || resend.isPending
  return (
    <div ref={box} className="flex flex-wrap gap-2">
      <Button
        type="button"
        size={size}
        variant="outline"
        className={size === "default" ? "min-h-11 sm:min-h-9" : undefined}
        disabled={busy}
        onClick={() => confirmSent.mutate()}
      >
        Revisé en Zoho: salió
      </Button>
      {canResend ? (
        <Button
          type="button"
          size={size}
          variant="outline"
          className={size === "default" ? "min-h-11 sm:min-h-9" : undefined}
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          No salió: reenviar
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title={`Reenviar el informe N.º ${number}`}
        description={`Reenvía el mismo informe N.º ${number} a ${to ?? "la misma persona"}. Hazlo solo si en Zoho no aparece en Enviados.`}
        confirmLabel="Reenviar"
        variant="default"
        pending={resend.isPending}
        onConfirm={() => resend.mutate()}
        onClose={() => setConfirming(false)}
      />
    </div>
  )
}
