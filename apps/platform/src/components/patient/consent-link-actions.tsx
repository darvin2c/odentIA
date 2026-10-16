import { Button } from "@odentia/ui"
import { ConfirmDialog } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError } from "../../lib/api"
import { type ConsentDocument, confirmLinkSignedConsent, sendConsentByLink } from "../../lib/clinical-forms"
import { formatDate } from "../../lib/clinical-journey"

function problemOf(error: unknown): string | null {
  if (!error) return null
  return error instanceof ApiError ? (error.shape.message ?? "No se pudo completar.") : "No se pudo completar. Revisa tu conexión."
}

/** Lo que dice el consentimiento sobre «Su enlace»: enviado, firmado por la persona o nada. */
export function consentLinkWords(document: Pick<ConsentDocument, "status" | "linkSentAt" | "personSignedAt">): string | null {
  if (document.status !== "pendiente") return null
  if (document.personSignedAt) return `Lo firmó desde su enlace el ${formatDate(document.personSignedAt)}: confírmalo antes de empezar.`
  if (document.linkSentAt) return `Se le envió para firmar el ${formatDate(document.linkSentAt)}: espera su firma.`
  return null
}

/**
 * Firmar por enlace (tablero 2, «Antes de llegar»): «Enviar para firmar» lo
 * deja en «Su enlace» y se lo envía; cuando la persona firma, el profesional
 * lo confirma y recién entonces queda firmado. Aprobación de la persona y
 * confirmación del profesional son pasos distintos.
 */
export function ConsentLinkActions({
  document,
  onChanged,
  size = "sm",
}: {
  document: ConsentDocument
  onChanged: () => void | Promise<void>
  size?: "sm" | "default"
}) {
  const [asking, setAsking] = useState(false)
  const [requestId] = useState(() => crypto.randomUUID())
  const send = useMutation({
    mutationFn: () => sendConsentByLink(document.id, requestId),
    onSuccess: async () => {
      setAsking(false)
      await onChanged()
    },
  })
  const confirm = useMutation({
    mutationFn: () => confirmLinkSignedConsent(document.id),
    onSuccess: async () => {
      await onChanged()
    },
  })
  if (document.status !== "pendiente") return null
  const error = problemOf(send.error) ?? problemOf(confirm.error)
  return (
    <>
      {document.personSignedAt ? (
        <Button type="button" size={size} disabled={confirm.isPending} onClick={() => confirm.mutate()}>
          {confirm.isPending ? "Confirmando…" : "Confirmar"}
        </Button>
      ) : (
        <Button type="button" size={size} variant="outline" onClick={() => setAsking(true)}>
          {document.linkSentAt ? "Enviar otra vez" : "Enviar para firmar"}
        </Button>
      )}
      {error && !asking ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={asking}
        title="Enviar para firmar"
        description={`«${document.titleSnapshot}» aparece en «Su enlace»: lo lee, escribe su documento y firma desde su teléfono. Después lo confirmas tú antes de empezar.${error ? ` ${error}` : ""}`}
        confirmLabel="Enviar"
        variant="default"
        pending={send.isPending}
        onClose={() => {
          if (!send.isPending) setAsking(false)
        }}
        onConfirm={() => send.mutate()}
      />
    </>
  )
}
