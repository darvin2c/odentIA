import { Button } from "@odentia/ui"
import { ConfirmDialog, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { type ConsentDocument, confirmLinkSignedConsent, sendConsentByLink } from "../../lib/clinical-forms"
import { formatDate } from "../../lib/clinical-journey"

/** Lo que dice el consentimiento sobre «Su enlace»: enviado, firmado por la persona o nada. */
export function consentLinkWords(document: Pick<ConsentDocument, "status" | "linkSentAt" | "personSignedAt">): string | null {
  if (document.status !== "pendiente") return null
  if (document.personSignedAt) return `Lo firmó desde su enlace el ${formatDate(document.personSignedAt)}: confírmalo en su atención, antes de empezar.`
  if (document.linkSentAt) return `Se le envió para firmar el ${formatDate(document.linkSentAt)}: espera su firma.`
  return null
}

/**
 * Firmar por enlace (tablero 2, «Antes de llegar»): «Enviar para firmar» lo
 * deja en «Su enlace» y se lo envía; cuando la persona firma, el profesional
 * lo confirma y recién entonces queda firmado. Aprobación de la persona y
 * confirmación del profesional son pasos distintos. Confirmar se hace solo
 * dentro de la atención en curso de ese paciente (`encounterId`); fuera de
 * ella, la fila dice «Lo confirmas en su atención».
 */
export function ConsentLinkActions({
  document,
  onChanged,
  size = "sm",
  encounterId = null,
}: {
  document: ConsentDocument
  onChanged: () => void | Promise<void>
  size?: "sm" | "default"
  /** La atención en curso donde se muestra: solo ahí se ofrece «Confirmar consentimiento». */
  encounterId?: string | null
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
    mutationFn: (inAttention: string) => confirmLinkSignedConsent(document.id, inAttention),
    onSuccess: async () => {
      await onChanged()
    },
  })
  if (document.status !== "pendiente") return null
  const failure = send.error ?? confirm.error
  const error = failure ? submitErrorMessage(failure) : null
  return (
    <>
      {document.personSignedAt ? (
        encounterId ? (
          <Button type="button" size={size} disabled={confirm.isPending} onClick={() => confirm.mutate(encounterId)}>
            {confirm.isPending ? "Confirmando…" : "Confirmar consentimiento"}
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground">Lo confirmas en su atención</span>
        )
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
        description={`Le llega «${document.titleSnapshot}» para leerlo y firmarlo desde su teléfono, escribiendo su documento. Después lo confirmas tú en su atención, antes de empezar.`}
        error={send.error ? submitErrorMessage(send.error) : null}
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
