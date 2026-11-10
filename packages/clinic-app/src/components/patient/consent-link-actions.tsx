import { Button, Skeleton, toast } from "@odentia/ui"
import { ConfirmDialog, DetailDrawer, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { brandedQrDataUrl } from "../../lib/branded-qr"
import {
  type ConsentDocument,
  confirmLinkSignedConsent,
  sendConsentByLink,
  showConsentLink,
} from "../../lib/clinical-forms"
import { formatDate } from "../../lib/clinical-journey"

/** Lo que dice el consentimiento sobre «Su enlace»: enviado, firmado por la persona o nada. */
export function consentLinkWords(document: Pick<ConsentDocument, "status" | "linkSentAt" | "personSignedAt">): string | null {
  if (document.status !== "pendiente") return null
  if (document.personSignedAt) return `Lo firmó desde su enlace el ${formatDate(document.personSignedAt)}: confírmalo en su atención, antes de empezar.`
  if (document.linkSentAt) return `Lo tiene en su enlace desde el ${formatDate(document.linkSentAt)}: espera su firma.`
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
        <>
          <Button type="button" size={size} variant="outline" onClick={() => setAsking(true)}>
            {document.linkSentAt ? "Enviar otra vez" : "Enviar para firmar"}
          </Button>
          <ConsentPhoneButton document={document} size={size} onShown={onChanged} />
        </>
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

/**
 * «Firmar en su teléfono» (consentimientos, 10 nov): su enlace, que abre la hoja, en un código
 * para escanearlo en la clínica o copiado para pegarlo en su chat. No se le envía ningún
 * mensaje; queda en «Su enlace» y la traza dice que se le mostró.
 */
export function ConsentPhoneButton({
  document,
  size = "sm",
  onShown,
}: {
  document: Pick<ConsentDocument, "id" | "titleSnapshot">
  size?: "sm" | "default"
  onShown?: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" size={size} variant="ghost" onClick={() => setOpen(true)}>
        Firmar en su teléfono
      </Button>
      <ConsentPhoneDrawer document={open ? document : null} onClose={() => setOpen(false)} onShown={onShown} />
    </>
  )
}

/** El cajón con el código y «Copiar enlace»; se abre con un consentimiento y se cierra con `null`. */
export function ConsentPhoneDrawer({
  document,
  onClose,
  onShown,
}: {
  document: Pick<ConsentDocument, "id" | "titleSnapshot"> | null
  onClose: () => void
  onShown?: () => void | Promise<void>
}) {
  const [qr, setQr] = useState<string | null>(null)
  const link = useMutation({
    mutationFn: (consentId: string) => showConsentLink(consentId),
    onSuccess: async () => {
      await onShown?.()
    },
  })
  const consentId = document?.id ?? null
  const { mutate, reset } = link
  useEffect(() => {
    if (!consentId) return
    setQr(null)
    reset()
    mutate(consentId)
  }, [consentId, mutate, reset])
  const url = link.data?.data.url
  useEffect(() => {
    if (!url) return
    let alive = true
    void brandedQrDataUrl(url).then((data) => {
      if (alive) setQr(data)
    })
    return () => {
      alive = false
    }
  }, [url])
  const name = link.data?.data.recipientName
  return (
    <DetailDrawer
      open={document !== null}
      onClose={onClose}
      title="Firmar en su teléfono"
      description="Gira la pantalla: lo escanea con su celular, lo lee y lo firma escribiendo su documento. No se le envía ningún mensaje."
      closeLabel="Listo"
      error={link.isError ? submitErrorMessage(link.error) : null}
      actions={
        url ? (
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url)
                toast.success("Enlace copiado: pégalo en su chat cuando escriba.")
              } catch {
                toast.error("No pudimos copiarlo. Usa el código o vuelve a intentarlo.")
              }
            }}
          >
            Copiar enlace
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col items-center gap-4">
        <div className="flex size-64 max-w-full items-center justify-center rounded-3xl border bg-white p-3">
          {qr ? (
            <img src={qr} alt={name ? `Código para que ${name} lo firme` : "Código para firmarlo"} className="size-full" />
          ) : link.isError ? (
            <span className="text-center text-sm text-muted-foreground">Sin código</span>
          ) : (
            <Skeleton className="size-full rounded-2xl" />
          )}
        </div>
        <div className="flex flex-col gap-1 text-center">
          {document ? <span className="font-medium">{document.titleSnapshot}</span> : null}
          {name ? <span className="text-sm text-muted-foreground">Lo firma {name}</span> : null}
        </div>
        {link.data ? (
          <p className="w-full rounded-2xl bg-muted/60 p-4 text-sm">
            Es su mismo enlace, sirve hasta el {formatDate(link.data.data.expiresAt)}. Cuando lo firme, lo confirmas
            en su atención, con la persona delante.
          </p>
        ) : null}
      </div>
    </DetailDrawer>
  )
}

/**
 * «Enviar para firmar» desde el menú «…»: la misma confirmación que en la ficha, que dice qué le
 * llega y que después se confirma en su atención (consentimientos, 10 nov).
 */
export function SendToSignDialog({
  document,
  onClose,
  onSent,
}: {
  document: Pick<ConsentDocument, "id" | "titleSnapshot"> | null
  onClose: () => void
  onSent: () => void | Promise<void>
}) {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const documentId = document?.id ?? null
  useEffect(() => {
    if (documentId) setRequestId(crypto.randomUUID())
  }, [documentId])
  const send = useMutation({
    mutationFn: (consentId: string) => sendConsentByLink(consentId, requestId),
    onSuccess: async () => {
      toast.success("Se lo enviamos: aparece en «Su enlace»")
      onClose()
      await onSent()
    },
  })
  return (
    <ConfirmDialog
      open={document !== null}
      title="Enviar para firmar"
      description={
        document
          ? `Le llega «${document.titleSnapshot}» para leerlo y firmarlo desde su teléfono, escribiendo su documento. Después lo confirmas tú en su atención, antes de empezar.`
          : ""
      }
      error={send.error ? submitErrorMessage(send.error) : null}
      confirmLabel="Enviar"
      variant="default"
      pending={send.isPending}
      onClose={() => {
        if (!send.isPending) {
          send.reset()
          onClose()
        }
      }}
      onConfirm={() => {
        if (document) send.mutate(document.id)
      }}
    />
  )
}
