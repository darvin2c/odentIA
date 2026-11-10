import { Button, Skeleton, toast } from "@odentia/ui"
import { ConfirmDialog, DetailDrawer, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
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
  /** Cuántos días sirve desde que se envía o se muestra. */
  ttlDays: number
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
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: ShownLink }>(`/api/patients/${patientId}/personal-link/show`, { method: "POST", body: "{}" }),
    // Mostrarlo crea o renueva su enlace: «hasta cuándo sirve» se vuelve a leer.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: previewKey(patientId) }),
  })
}

/**
 * Las vías de su enlace en «Pendientes» (lienzo «Su enlace y el código QR»):
 * «Enviarle su enlace» cuando se puede enviar; si no (fuera de las 24 horas,
 * sin mensaje aprobado, sin permiso), no se abre ninguna ventana: se dice por
 * qué ahí mismo y quedan «Copiar enlace» y «Mostrar su código». Con un enlace
 * vigente, «Quitar enlace» va junto a ellos: así lo corta también quien solo
 * escribe por el chat web (entrega 2). `leading` va primero en la fila (p. ej.
 * «Completar»).
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
  const queryClient = useQueryClient()
  const preview = usePersonalLinkPreview(patientId)
  const data = preview.data?.data
  const copy = useShownLink(patientId)
  const revoke = useMutation({
    mutationFn: () => apiFetch<{ data: { revoked: number } }>(`/api/patients/${patientId}/personal-link`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: previewKey(patientId) })
      toast.success("Enlace quitado: el que tenía ya no sirve, tampoco el botón de sus correos. Lo que hizo con él se conserva.")
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
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
      {!blocked ? <SendPersonalLinkButton patientId={patientId} missing={missing} /> : null}
      {!data || data.canShow ? <ShowPersonalCodeButton patientId={patientId} missing={missing} /> : null}
      {data?.liveUntil ? (
        <Button type="button" size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
          {revoke.isPending ? "Quitando…" : "Quitar enlace"}
        </Button>
      ) : null}
    </span>
  )
  if (!blocked) return row
  return (
    <span className="flex flex-col gap-2">
      <span className="text-sm text-muted-foreground">
        {data?.canShow
          ? `No se le puede enviar ahora: ${/^\p{Lu}\p{Ll}*$/u.test(blocked.split(/\s/)[0] ?? "") ? blocked.charAt(0).toLowerCase() : blocked.charAt(0)}${blocked.slice(1).replace(/\.$/, "")}. Cópialo para pegarlo cuando escriba, o muéstrale su código.`
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
        description={
          missing.trim()
            ? "Gira la pantalla: lo escanea con su celular y completa sus datos mientras espera."
            : "Gira la pantalla: lo escanea con su celular y ve lo que tiene pendiente con la clínica."
        }
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
            {missing.trim() ? (
              <span className="text-sm text-muted-foreground">Le falta: {missing.replace(/\.$/, "").toLowerCase()}, y su salud.</span>
            ) : null}
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
export function SendPersonalLinkButton({
  patientId,
  missing = "",
  size = "sm",
}: {
  patientId: string
  /** Lo que le falta, en palabras; vacío si no le falta nada. */
  missing?: string
  size?: "sm" | "default"
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const preview = usePersonalLinkPreview(patientId, open)
  const send = useMutation({
    mutationFn: () =>
      apiFetch<{ data: { recipientName: string } }>(`/api/patients/${patientId}/personal-link`, {
        method: "POST",
        body: JSON.stringify({ requestId }),
      }),
    // Enviarlo crea o renueva su enlace: «hasta cuándo sirve» se vuelve a leer.
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: previewKey(patientId) }),
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
            ? `Le llega a ${data.recipient.name} ${by} ${missing.trim() ? "para completar sus datos y su salud" : "para ver lo que tiene pendiente con la clínica"}.`
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
        {/* «Quitar enlace» va junto a «Copiar enlace» y «Mostrar su código» (`PersonalLinkActions`). */}
        {!send.isSuccess && data?.liveUntil ? (
          <p className="text-sm text-muted-foreground">
            Ya tiene un enlace que sirve hasta el {formatDate(data.liveUntil)}: le llega el mismo.
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  )
}

/** Hasta cuándo sirve su enlace, o que aún no tiene uno: solo lo que se sabe. */
function LinkValidity({ preview }: { preview: ReturnType<typeof usePersonalLinkPreview> }) {
  if (preview.isPending) return <p className="text-muted-foreground">Revisando su enlace…</p>
  if (preview.isError)
    return (
      <span className="flex flex-col items-start gap-2">
        <span className="text-muted-foreground">{submitErrorMessage(preview.error)}</span>
        <Button type="button" size="sm" variant="outline" onClick={() => void preview.refetch()}>
          Reintentar
        </Button>
      </span>
    )
  const { liveUntil, ttlDays } = preview.data.data
  return (
    <p>
      {liveUntil
        ? `El que tiene sirve hasta el ${formatDate(liveUntil)}. Al enviarlo o mostrarlo, sirve ${ttlDays} días desde ese momento.`
        : `Aún no tiene uno vigente: al enviarlo o mostrarlo, sirve ${ttlDays} días.`}
    </p>
  )
}

/**
 * Datos › Enlace y portal: su enlace en la misma sección, sin abrir otro cajón (el de la
 * cabecera es el único de la página).
 */
export function PersonalLinkSummary({ patientId, missing = "" }: { patientId: string; missing?: string }) {
  const preview = usePersonalLinkPreview(patientId)
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        Le llega con cada aviso de la clínica y abre sin crear una cuenta, directo en lo que cada mensaje dice: su cita,
        lo que le falta completar, sus presupuestos, lo que tiene por firmar y sus mensajes.
      </p>
      <LinkValidity preview={preview} />
      <PersonalLinkActions patientId={patientId} missing={missing} />
    </div>
  )
}
