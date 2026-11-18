import {
  EmptyState,
  LoadingState,
  PageShell,
  SubmitButton,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery } from "@tanstack/react-query"
import { CircleCheck, Hospital, Link2Off, Lock } from "lucide-react"
import { useState } from "react"
import { z } from "zod"
import { ApiError } from "../../lib/api"
import {
  checkRecordCopy,
  fetchRecordCopy,
  type RecordCopyView,
  submitRecordCopyDownload,
} from "../../lib/booking-link"
import { sizeWords } from "../../lib/data-requests"
import { orgSlugFromHostname, requestHostname } from "../../lib/host"
import { useHydrated } from "../../lib/hydrated"
import { setOrgLocale } from "../../lib/locale"

/** «25 de noviembre», en la zona de la clínica. */
function untilWords(at: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone }).format(
    new Date(at),
  )
}

/** Vencido, quitado o que nunca existió: lo mismo, sin nada de la persona. */
function Unavailable() {
  return (
    <PageShell maxWidth="md">
      <EmptyState
        icon={Link2Off}
        title="Este enlace ya no sirve"
        description="Si todavía necesitas tu copia, pídele a la clínica que te la envíe de nuevo."
      />
    </PageShell>
  )
}

/**
 * «Tu historia completa» (`/pendientes?abre=copia`, mesa del 18 nov): de la familia de «Su
 * enlace», sin sesión. Abrirla no descarga nada; «Descargar» pide su número de documento,
 * como firmar a distancia, y baja el ZIP. A quien decide por un menor le habla de la
 * historia de él. Lo que puede hacer lo decide el servidor: la página no tiene reglas propias.
 */
export function RecordCopyPage({ token }: { token: string | undefined }) {
  const slug = orgSlugFromHostname(requestHostname())
  const hydrated = useHydrated()
  const ready = hydrated && slug !== null && token !== undefined
  const query = useQuery({
    queryKey: ["record-copy-link", slug, token ?? null],
    queryFn: () => fetchRecordCopy(slug ?? "", token ?? ""),
    enabled: ready,
    retry: false,
  })
  if (hydrated && !ready) return <Unavailable />
  if (!ready || query.isPending)
    return (
      <PageShell maxWidth="md">
        <LoadingState kind="indeterminate" message="Abriendo tu copia…" />
      </PageShell>
    )
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) return <Unavailable />
    return (
      <PageShell maxWidth="md">
        <EmptyState
          icon={Link2Off}
          title="No pudimos abrir tu copia"
          description="Revisa tu conexión y vuelve a abrir el enlace."
          actionLabel="Volver a intentar"
          onAction={() => void query.refetch()}
        />
      </PageShell>
    )
  }
  const view = query.data.data
  setOrgLocale(view.locale, undefined, view.countryCode)
  if (!slug || !token) return <Unavailable />
  return (
    <CopyScreen view={view} slug={slug} token={token} onDownloaded={() => void query.refetch()} />
  )
}

function CopyScreen({
  view,
  slug,
  token,
  onDownloaded,
}: {
  view: RecordCopyView
  slug: string
  token: string
  onDownloaded: () => void
}) {
  const [started, setStarted] = useState(false)
  // Se agotaron las descargas mientras la página estaba abierta: se dice, no un error suelto.
  const [exhausted, setExhausted] = useState(false)
  const theirs = view.patientFirstName
  const title = theirs ? `La historia de ${theirs}` : "Tu historia completa"
  const size = sizeWords(view.approxBytes)
  // Desde unos 20 MB conviene el wifi (una tomografía pesa cientos).
  const heavy = (view.approxBytes ?? 0) > 20 * 1024 * 1024
  const docLabel = view.documentLabel ?? "documento"
  const form = useAppForm({
    defaultValues: { docNumber: "" },
    validators: {
      onSubmit: z.object({
        docNumber: z
          .string()
          .trim()
          .min(1, `Escribe tu número de ${docLabel}.`)
          .max(40, "Escribe como mucho 40 caracteres."),
      }),
    },
    onSubmit: async ({ value }) => {
      const docNumber = value.docNumber.trim()
      // Primero se comprueba: si no es el suyo, se dice en su campo y no se baja nada.
      try {
        await checkRecordCopy(slug, token, docNumber)
      } catch (error) {
        if (error instanceof ApiError && error.shape.code === "RECORD_COPY_LIMIT") {
          setExhausted(true)
          return
        }
        throw error
      }
      submitRecordCopyDownload(slug, token, docNumber)
      setStarted(true)
      // La descarga quedó anotada: la página cuenta las que le quedan.
      setTimeout(onDownloaded, 4000)
    },
  })
  const submit = useFormSubmit(form)
  const error = useFormSubmitError(form)
  const pending = useStore(form.store, (state) => state.isSubmitting)
  const what = theirs
    ? `Su historia en PDF, cada papel que le emitimos, sus imágenes y un archivo en el formato internacional para que otra clínica la cargue en su sistema.`
    : "Tu historia en PDF, cada papel que te emitimos, tus imágenes y un archivo en el formato internacional para que otra clínica la cargue en su sistema."
  const header = (
    <header className="flex flex-col gap-1">
      <p className="text-sm font-semibold text-muted-foreground">{view.clinicName}</p>
      <h1 className="text-xl font-semibold text-balance break-words">{title}</h1>
      <p className="text-sm text-muted-foreground">{what}</p>
    </header>
  )
  let body: React.ReactNode
  if (!view.canDownload) {
    body = (
      <EmptyState
        icon={Hospital}
        title="Esta copia la recibes en la clínica"
        description={`Para bajarla desde aquí necesitamos tu documento en tu ficha, y no lo tenemos. Pídela en ${view.clinicName} y te la entregamos.`}
      />
    )
  } else if ((view.downloadsLeft <= 0 || exhausted) && !started) {
    body = (
      <EmptyState
        icon={Lock}
        title="Ya la bajaste con este enlace"
        description={`Si la necesitas otra vez, pídele a ${view.clinicName} que te la envíe de nuevo.`}
      />
    )
  } else if (started) {
    body = (
      <div role="status" className="flex flex-col items-start gap-2 rounded-xl border bg-card p-4">
        <p className="flex items-center gap-2 font-semibold">
          <CircleCheck className="size-5 text-success" aria-hidden />
          Tu copia se está descargando
        </p>
        <p className="text-sm text-muted-foreground">
          Búscala en las descargas de tu celular o tu computadora: es un archivo ZIP. Ábrelo y
          dentro está «LÉEME», que explica qué trae y cómo la carga otra clínica.
        </p>
        <p className="text-sm text-muted-foreground">
          Disponible hasta el {untilWords(view.until, view.locale, view.timezone)}.
        </p>
      </div>
    )
  } else {
    body = (
      <form
        className="flex flex-col gap-4 rounded-xl border bg-card p-4"
        onSubmit={submit}
        noValidate
      >
        <form.AppField name="docNumber">
          {(field) => (
            <field.TextField
              label={`Tu número de ${docLabel}`}
              description="Lo comparamos con el de tu ficha para saber que eres tú; no lo mostramos."
              inputClassName="min-h-11 text-base"
              autoComplete="off"
              inputMode={docLabel === "DNI" ? "numeric" : undefined}
              enterKeyHint="go"
              maxLength={20}
            />
          )}
        </form.AppField>
        <SubmitButton type="submit" className="min-h-11 w-full" pending={pending}>
          {pending
            ? "Comprobando…"
            : `Descargar (ZIP${size ? `, ${size.replace("unos ", "")}` : ""})`}
        </SubmitButton>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Disponible hasta el {untilWords(view.until, view.locale, view.timezone)}.
          {heavy ? " Pesa bastante: mejor con wifi." : ""}
        </p>
      </form>
    )
  }
  return (
    <PageShell maxWidth="md">
      <div className="flex flex-col gap-4">
        {header}
        {body}
      </div>
    </PageShell>
  )
}
