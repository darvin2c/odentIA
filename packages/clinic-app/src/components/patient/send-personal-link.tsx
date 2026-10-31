import { Button, Skeleton, toast } from "@odentia/ui"
import { ConfirmDialog, DetailDrawer, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import { type ReactNode, useEffect, useState } from "react"
import { apiFetch } from "../../lib/api"
import { brandedQrDataUrl } from "../../lib/branded-qr"
import { formatDate } from "../../lib/clinical-journey"

interface SendPreview {
  recipient: { contactId: string; name: string; relation: string }
  channel: "whatsapp" | "email" | null
  label: string | null
  blocked: string | null
  /** Si se puede copiar o mostrar en un código aunque no se pueda enviar. */
  canShow: boolean
  text: string
  /** Hasta cuándo sirve el enlace que ya tiene; nulo si no tiene uno. */
  liveUntil: string | null
}

interface ShownLink {
  url: string
  expiresAt: string
  recipientName: string
}

const previewKey = (patientId: string) => ["personal-link-preview", patientId]

function usePersonalLinkPreview(patientId: string, enabled = true) {
  return useQuery({
    queryKey: previewKey(patientId),
    queryFn: () => apiFetch<{ data: SendPreview }>(`/api/patients/${patientId}/personal-link/preview`),
    enabled,
    retry: false,
  })
}

/**
 * Su enlace para copiarlo o mostrarlo, sin enviar nada: el servidor da el que
 * ya tiene vivo (renovado) o uno nuevo, y deja la traza de que se mostró.
 */
function useShownLink(patientId: string) {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: ShownLink }>(`/api/patients/${patientId}/personal-link/show`, { method: "POST", body: "{}" }),
  })
}

/**
 * Las vías de su enlace en «Pendientes» (lienzo «Su enlace y el código QR»):
 * «Enviarle su enlace» cuando se puede enviar; si no (fuera de las 24 horas,
 * sin mensaje aprobado, sin permiso), no se abre ninguna ventana: se dice por
 * qué ahí mismo y quedan «Copiar enlace» y «Mostrar su código». `leading` va
 * primero en la fila (p. ej. «Completar»).
 */
export function PersonalLinkActions({
  patientId,
  missing,
  leading,
}: {
  patientId: string
  /** Lo que le falta, en palabras, para decirlo junto a su código. */
  missing: string
  leading?: ReactNode
}) {
  const preview = usePersonalLinkPreview(patientId)
  const data = preview.data?.data
  const copy = useShownLink(patientId)
  const blocked = data?.blocked ?? null
  const row = (
    <span className="flex flex-wrap gap-2">
      {leading}
      {blocked && data?.canShow ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={copy.isPending}
          onClick={() =>
            copy.mutate(undefined, {
              onSuccess: async (result) => {
                try {
                  await navigator.clipboard.writeText(result.data.url)
                  toast.success("Enlace copiado: pégalo en su chat cuando escriba.")
                } catch {
                  toast.error("No pudimos copiarlo. Usa «Mostrar su código» o vuelve a intentarlo.")
                }
              },
              onError: (error) => toast.error(submitErrorMessage(error)),
            })
          }
        >
          Copiar enlace
        </Button>
      ) : null}
      {!blocked ? <SendPersonalLinkButton patientId={patientId} /> : null}
      {!data || data.canShow ? <ShowPersonalCodeButton patientId={patientId} missing={missing} /> : null}
    </span>
  )
  if (!blocked) return row
  return (
    <span className="flex flex-col gap-2">
      <span className="text-sm text-muted-foreground">
        {data?.canShow
          ? `No se le puede enviar ahora: ${blocked.replace(/\.$/, "")}. Cópialo para pegarlo cuando escriba, o muéstrale su código.`
          : blocked}
      </span>
      {row}
    </span>
  )
}

/**
 * «Mostrar su código»: su enlace en un código QR para que lo escanee en la
 * clínica y complete sus datos mientras espera. Es el cajón estándar (columna
 * a la derecha si cabe, hoja que sube en el celular). No envía nada.
 */
export function ShowPersonalCodeButton({
  patientId,
  missing,
  size = "sm",
}: {
  patientId: string
  missing: string
  size?: "sm" | "default"
}) {
  const [open, setOpen] = useState(false)
  const link = useShownLink(patientId)
  const [qr, setQr] = useState<string | null>(null)
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
    <>
      <Button
        type="button"
        size={size}
        variant="outline"
        onClick={() => {
          setQr(null)
          link.reset()
          link.mutate()
          setOpen(true)
        }}
      >
        Mostrar su código
      </Button>
      <DetailDrawer
        open={open}
        onClose={() => setOpen(false)}
        title="Mostrar su código"
        description="Gira la pantalla: lo escanea con su celular y completa sus datos mientras espera."
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
                  toast.success("Enlace copiado")
                } catch {
                  toast.error("No pudimos copiarlo. Vuelve a intentarlo.")
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
              <img src={qr} alt={name ? `Código con el enlace de ${name}` : "Código con su enlace"} className="size-full" />
            ) : link.isError ? (
              <span className="text-center text-sm text-muted-foreground">Sin código</span>
            ) : (
              <Skeleton className="size-full rounded-2xl" />
            )}
          </div>
          <div className="flex flex-col gap-1 text-center">
            {name ? <span className="font-medium">{name}</span> : null}
            <span className="text-sm text-muted-foreground">Le falta: {missing.replace(/\.$/, "").toLowerCase()}, y su salud.</span>
          </div>
          {link.data ? (
            <p className="w-full rounded-2xl bg-muted/60 p-4 text-sm">
              Es su mismo enlace, sirve hasta el {formatDate(link.data.data.expiresAt)}. Mostrarlo no le envía nada.
            </p>
          ) : null}
        </div>
      </DetailDrawer>
    </>
  )
}

/**
 * «Enviarle su enlace» (decisión 8, ADR 0037): la confirmación corta, solo
 * cuando se puede enviar —dice a quién y por dónde le llega—. El servidor
 * elige el canal con la regla de siempre y no lo envía dos veces. Si no se
 * puede enviar, `PersonalLinkActions` ni lo ofrece.
 */
export function SendPersonalLinkButton({ patientId, size = "sm" }: { patientId: string; size?: "sm" | "default" }) {
  const [open, setOpen] = useState(false)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const preview = usePersonalLinkPreview(patientId, open)
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
  const problem = send.error ? submitErrorMessage(send.error) : null
  const by = data?.channel === "email" ? "por correo" : "por WhatsApp"
  const description = send.isSuccess
    ? `Listo: le llegó a ${send.data.data.recipientName}. Cuando lo envíe, lo verás en su página.`
    : preview.isPending
      ? "Revisando por dónde le llega…"
      : preview.isError
        ? "No pudimos revisar por dónde le llega."
        : data?.blocked
          ? data.blocked
          : data
            ? `Le llega a ${data.recipient.name} ${by} para completar sus datos y su salud.`
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
        title={send.isSuccess ? "Enviado" : `¿Enviarle su enlace ${data?.channel ? by : ""}?`.replace(" ?", "?")}
        description={problem ? `${description} ${problem}` : description}
        confirmLabel={send.isSuccess ? "Listo" : "Enviar"}
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
        {/* «Quitar enlace» se conserva (deja sin efecto el que tiene) como una línea discreta. */}
        {!send.isSuccess && data?.liveUntil ? (
          <p className="text-sm text-muted-foreground">
            Ya tiene un enlace que sirve hasta el {formatDate(data.liveUntil)}: le llega el mismo.{" "}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 align-baseline"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              Quitar enlace
            </Button>
            {revoke.isError ? <span className="block text-destructive">{submitErrorMessage(revoke.error)}</span> : null}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  )
}
