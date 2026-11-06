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
      {!blocked ? <SendPersonalLinkButton patientId={patientId} missing={missing} /> : null}
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

/**
 * Lo que su enlace le muestra (`getPersonalLinkView`), en palabras para quien atiende. Cada
 * parte sale solo si le corresponde: sin cita no hay cita, y lo de su salud y sus papeles es
 * de quien decide por el paciente.
 */
const LINK_SHOWS = [
  "su próxima cita, para confirmarla o cambiarla, y el cuestionario «Antes de tu cita» si hay uno",
  "los datos y lo de su salud que le faltan, para completarlos",
  "los presupuestos que se le enviaron, para responderlos",
  "lo que tiene por firmar",
  "sus recetas y comprobantes de los últimos 30 días",
  "sus mensajes: qué avisos quiere recibir",
]

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
        Le llega con cada aviso de la clínica, y abre sin crear una cuenta: ve su cita, lo que le falta completar, sus
        presupuestos, lo que tiene por firmar, sus recetas y comprobantes, y sus mensajes.
      </p>
      <LinkValidity preview={preview} />
      <PersonalLinkActions patientId={patientId} missing={missing} />
    </div>
  )
}

/**
 * «Su enlace», siempre a mano en la ficha (decisión del 2026-11-05), falten o
 * no datos: qué le muestra, hasta cuándo sirve y cómo dárselo. Es el mismo
 * enlace que le llega con cada aviso; no hace falta el portal.
 */
export function PersonalLinkDrawer({
  patientId,
  open,
  onClose,
  missing = "",
}: {
  patientId: string
  open: boolean
  onClose: () => void
  /** Lo que le falta, en palabras; vacío si no le falta nada. */
  missing?: string
}) {
  const preview = usePersonalLinkPreview(patientId, open)
  return (
    <DetailDrawer
      open={open}
      onClose={onClose}
      title="Su enlace"
      description="Una página suya, que abre sin crear una cuenta y le llega con cada aviso de la clínica."
      closeLabel="Listo"
    >
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex flex-col gap-1">
          <p className="font-medium">Con su enlace ve:</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {LINK_SHOWS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="text-muted-foreground">Cada parte aparece solo si le corresponde hoy.</p>
        </div>
        <LinkValidity preview={preview} />
        <PersonalLinkActions patientId={patientId} missing={missing} />
      </div>
    </DetailDrawer>
  )
}
