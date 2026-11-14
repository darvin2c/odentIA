import type {
  RegistrationConfig,
  RegistrationFieldKey,
  RegistrationFieldMode,
} from "@odentia/clinical"
import { DEFAULT_REGISTRATION_CONFIG, registrationConfigSchema } from "@odentia/clinical"
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  buttonVariants,
  Checkbox,
  cn,
  ScrollArea,
  toast,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  EmptyState,
  PageHeader,
  SubmitButton,
  submitForm,
  useAppForm,
  useFormSubmitError,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { QrCode } from "lucide-react"
import { useEffect, useState } from "react"
import { RegistrationQuestionnaire } from "../../components/patient/registration-questionnaire"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import {
  type RegistrationFieldErrors,
  RegistrationFieldsPicker,
} from "../../components/settings/registration-fields-picker"
import { ADMIN_NAME, useReceptionName } from "../../lib/agent-names"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { orgSlugFromHostname, requestHostname, tenantUrl } from "../../lib/host"
import { useClinicalProfile, useOrgProfile } from "../../lib/org"
import { PageDraftGuard } from "../../lib/page-draft-guard"
import {
  fetchRegistrationConfig,
  markRegistrationQuestionsSeen,
  saveRegistrationConfig,
} from "../../lib/patient-registration"
import { brandedQrDataUrl, brandedQrPng, registrationSheetPng } from "../../lib/branded-qr"
import { PatientRegistrationPageSkeleton, PatientRegistrationSkeleton } from "../../components/skeletons/settings"

export const Route = createFileRoute("/_org/settings/patient-registration")({
  pendingComponent: PatientRegistrationPageSkeleton,
  component: PatientRegistrationSettingsPage,
})

const orgRouteApi = getRouteApi("/_org")

const TITLE = "Preguntas al paciente"
const SUBTITLE =
  "Lo que se le pregunta al paciente al registrarse y en su enlace, lo registre recepción o se registre solo. Lo que responde llega a su ficha como «lo dijo él» y quien atiende lo revisa con él."

/** La tarjeta de página, la misma en toda la plataforma. */
const CARD = "elevated flex flex-col gap-5 rounded-xl border bg-card p-5 sm:p-6"

type Draft = Pick<
  RegistrationConfig,
  "fields" | "enabled" | "privacyNotice" | "askReminders" | "askMessages"
>

function draftOf(config: Draft): Draft {
  return {
    fields: { ...config.fields },
    enabled: config.enabled,
    privacyNotice: config.privacyNotice,
    askReminders: config.askReminders,
    askMessages: config.askMessages,
  }
}

const FIELD_PREFIX = "fields."

/**
 * Reparte un rechazo (del esquema o del servidor): lo de cada dato del
 * selector (`fields.<dato>`) va a su fila; lo demás sigue al formulario.
 */
function splitPickerErrors(error: unknown): { picker: RegistrationFieldErrors; rest: unknown } {
  if (!(error instanceof ApiError) || !error.shape.fields) return { picker: {}, rest: error }
  const picker: RegistrationFieldErrors = {}
  const others: Record<string, string> = {}
  for (const [key, message] of Object.entries(error.shape.fields)) {
    if (key.startsWith(FIELD_PREFIX)) picker[key.slice(FIELD_PREFIX.length) as RegistrationFieldKey] ??= message
    else others[key] = message
  }
  if (Object.keys(picker).length === 0) return { picker, rest: error }
  // El motivo ya está en su fila: el pie solo dice que hay datos marcados.
  return {
    picker,
    rest: new ApiError(error.status, { code: error.shape.code, fields: Object.keys(others).length > 0 ? others : undefined }),
  }
}

function PatientRegistrationSettingsPage() {
  const canRead = usePermission("settings.read")
  if (!canRead) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }
  return <RegistrationSettings />
}

function RegistrationSettings() {
  const queryClient = useQueryClient()
  const canWrite = usePermission("settings.write")
  // El país del perfil define la máscara y el ejemplo de los teléfonos de la vista previa.
  const profile = useOrgProfile()
  // Y lo que solo se pide en un país (la procedencia en Perú; ADR 0036).
  const clinicalProfile = useClinicalProfile()
  const { org } = orgRouteApi.useRouteContext()
  const slug = org?.slug ?? orgSlugFromHostname(requestHostname()) ?? ""
  const publicLink = tenantUrl(slug, "/registro")
  const qrLink = tenantUrl(slug, "/registro?via=qr")

  const configQuery = useQuery({
    queryKey: ["patient-registration-config"],
    queryFn: fetchRegistrationConfig,
    retry: 1,
  })

  const [ready, setReady] = useState(false)
  const [expectedVersion, setExpectedVersion] = useState(0)
  const [pickerErrors, setPickerErrors] = useState<RegistrationFieldErrors>({})
  /** Otra persona guardó antes: el borrador se conserva y hay que volver a guardar. */
  const [conflict, setConflict] = useState(false)
  const [previewDone, setPreviewDone] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  /** La hoja del mostrador (A5) y el PNG del código, listos para descargar. */
  const [qrPng, setQrPng] = useState<string | null>(null)
  const [sheetPng, setSheetPng] = useState<string | null>(null)
  const [qrPending, setQrPending] = useState(false)
  const [qrError, setQrError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** «Lo revisé», para el aviso sugerido (ADR 0141). */
  const [reviewed, setReviewed] = useState(false)
  const receptionName = useReceptionName()

  const form = useAppForm({
    defaultValues: draftOf(DEFAULT_REGISTRATION_CONFIG),
    onSubmit: async ({ value }) => {
      setPickerErrors({})
      setConflict(false)
      try {
        const parsed = registrationConfigSchema.safeParse({ version: expectedVersion, ...value })
        if (!parsed.success) {
          throw new ApiError(400, {
            fields: Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join("."), issue.message])),
          })
        }
        const result = await saveRegistrationConfig({ expectedVersion, ...value, ...(reviewed ? { noticeReviewed: true } : {}) })
        setReviewed(false)
        setExpectedVersion(result.data.version)
        form.reset(draftOf(result.data))
        toast.success("Preguntas al paciente guardadas")
        void queryClient.invalidateQueries({ queryKey: ["patient-registration-config"] })
      } catch (error) {
        if (error instanceof ApiError && error.shape.code === "STALE_REGISTRATION_CONFIG") {
          setConflict(true)
          const refreshed = await configQuery.refetch()
          if (!refreshed.data) throw new Error("No pudimos volver a cargar el registro. Reintenta antes de guardar.")
          setExpectedVersion(refreshed.data.data.version)
          return
        }
        const { picker, rest } = splitPickerErrors(error)
        setPickerErrors(picker)
        throw rest
      }
    },
  })
  const values = useStore(form.store, (state) => state.values)
  const dirty = useStore(form.store, (state) => !state.isDefaultValue)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  const submitError = useFormSubmitError(form)

  const loaded = configQuery.data?.data
  // Los valores guardados, una sola vez: una recarga no pisa el borrador.
  useEffect(() => {
    if (loaded && !ready) {
      form.reset(draftOf(loaded))
      setExpectedVersion(loaded.version)
      setReady(true)
    }
  }, [loaded, ready, form])

  if (!ready) {
    return (
      <div className="flex max-w-6xl flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        {configQuery.isError ? (
          <SettingsLoadError
            what="las preguntas al paciente"
            onRetry={() => void configQuery.refetch()}
          />
        ) : (
          <SkeletonRegion message="Cargando las preguntas al paciente…">
            <PatientRegistrationSkeleton />
          </SkeletonRegion>
        )}
      </div>
    )
  }

  const today = configQuery.data?.meta.today ?? ""
  const noticeSuggested = configQuery.data?.meta.noticeSuggested === true
  const noticeShown = configQuery.data?.meta.noticeShown ?? ""
  const newQuestions = configQuery.data?.meta.newQuestions ?? []
  const newKeys = new Set(newQuestions.map((item) => item.key))
  const { fields, enabled, privacyNotice, askReminders, askMessages } = values
  const published = loaded?.enabled ?? false

  function setModes(keys: RegistrationFieldKey[], mode: RegistrationFieldMode) {
    form.setFieldValue("fields", (current) => {
      const next = { ...current }
      for (const key of keys) next[key] = mode
      return next
    })
    setPickerErrors((current) => {
      const next = { ...current }
      for (const key of keys) delete next[key]
      return next
    })
  }

  async function handleQuestionsSeen() {
    try {
      await markRegistrationQuestionsSeen()
      void queryClient.invalidateQueries({ queryKey: ["patient-registration-config"] })
    } catch {
      toast.error("No pudimos guardarlo. Vuelve a intentarlo.")
    }
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(publicLink)
      setCopied(true)
    } catch {
      setCopied(false)
      toast.error("No pudimos copiar el enlace. Selecciónalo y cópialo a mano.")
    }
  }

  async function handleGenerateQr() {
    setQrPending(true)
    setQrError(null)
    try {
      // El código con el [32] al centro; el nombre y el logo de la clínica van en la hoja.
      const [svg, png, sheet] = await Promise.all([
        brandedQrDataUrl(qrLink),
        brandedQrPng(qrLink),
        registrationSheetPng({
          clinicName: profile.data?.tradeName || org?.name || slug,
          logoUrl: profile.data?.logo ?? null,
          url: qrLink,
        }),
      ])
      setQrDataUrl(svg)
      setQrPng(png)
      setSheetPng(sheet)
    } catch {
      setQrError("No pudimos generar el código QR. Vuelve a intentarlo.")
    } finally {
      setQrPending(false)
    }
  }

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <PageDraftGuard dirty={dirty} />
      <PageHeader title={TITLE} subtitle={SUBTITLE} />
      {canWrite ? (
        // «Guardar» arriba, a la vista mientras se baja: lo marcado se pregunta desde que se guarda.
        <div className="sticky top-0 z-10 flex flex-col gap-2 rounded-2xl border bg-card/95 p-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Lo que marques «Opcional» u «Obligatorio» se le pregunta desde que guardes. A quien ya respondió
            solo se le pregunta lo que le falta.
          </p>
          <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
            <SubmitButton
              type="button"
              className="min-h-11"
              pending={isSubmitting}
              onClick={() => void submitForm(form)}
            >
              {dirty ? "Guardar cambios" : "Guardar"}
            </SubmitButton>
            {submitError ? (
              <p role="alert" className="text-sm text-destructive">
                {submitError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
      {newQuestions.length > 0 && canWrite ? (
        <Alert>
          <AlertDescription className="flex flex-col gap-2">
            <span>
              Hay preguntas nuevas: {newQuestions.map((item) => item.label).join(", ")}. Ya se le preguntan
              a tus pacientes como «Opcional» y nada es obligatorio. Si no las quieres, márcalas «No
              preguntar» y guarda.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 self-start sm:min-h-8"
              onClick={() => void handleQuestionsSeen()}
            >
              Entendido
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {configQuery.isError ? (
            <SettingsLoadError
              stale
              what="las preguntas al paciente"
              onRetry={() => void configQuery.refetch()}
            />
          ) : null}
          {!canWrite ? (
            <p role="note" className="text-sm text-muted-foreground">
              Puedes ver las preguntas; cambiarlas es de quien administra la clínica.
            </p>
          ) : null}

          <section className={CARD} aria-labelledby="registro-datos">
            <div className="flex flex-col gap-1.5">
              <h2 id="registro-datos" className="font-heading text-base font-medium">
                Qué le pedimos
              </h2>
              <p className="text-sm text-muted-foreground">
                Elige, dato por dato, si es obligatorio, opcional o no se pregunta. Vale para
                recepción y para lo que llena el paciente en su celular; en «Así lo ve el paciente»
                ves cómo le queda.
              </p>
            </div>
            <RegistrationFieldsPicker
              fields={fields}
              onMode={setModes}
              disabled={!canWrite}
              showOrigin={clinicalProfile.origin}
              errors={pickerErrors}
              newKeys={newKeys}
            />
          </section>

          <section className={CARD} aria-labelledby="registro-mensajes">
            <div className="flex flex-col gap-1.5">
              <h2 id="registro-mensajes" className="font-heading text-base font-medium">
                Mensajes de la clínica
              </h2>
              <p className="text-sm text-muted-foreground">
                Lo que el registro pregunta, además de la atención. Lo que la persona acepte vale de
                inmediato para lo que {ADMIN_NAME} le escribe por su cuenta; sin preguntarlo, casi
                nadie podrá recibirlo.
              </p>
            </div>
            <ul className="flex flex-col divide-y rounded-xl border">
              <li className="flex items-center gap-3 p-3">
                <div className="flex-1">
                  <div className="text-sm font-medium">Atención</div>
                  <div className="text-sm text-muted-foreground">
                    Siempre se pide: es la base del registro.
                  </div>
                </div>
                <span className="text-xs font-semibold text-muted-foreground">Fijo</span>
              </li>
              <li className="flex min-h-11 items-center gap-3 p-3">
                <Checkbox
                  id="registro-otros-mensajes"
                  checked={askMessages}
                  onCheckedChange={(value) => form.setFieldValue("askMessages", value === true)}
                  disabled={!canWrite}
                />
                <label htmlFor="registro-otros-mensajes" className="flex-1">
                  <span className="block text-sm font-medium">
                    Novedades y promociones de la clínica
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    Es lo único que pide permiso. Lo de su atención (citas, controles, presupuestos)
                    no se pregunta: es parte del servicio.
                  </span>
                </label>
              </li>
            </ul>
          </section>

          <section className={CARD} aria-labelledby="registro-publicacion">
            <div className="flex flex-col gap-1.5">
              <h2 id="registro-publicacion" className="font-heading text-base font-medium">
                Aviso de privacidad y publicación
              </h2>
              <p className="text-sm text-muted-foreground">
                El aviso lo escribe tu clínica y se muestra antes de pedir el consentimiento.
              </p>
            </div>
            <form.AppField name="privacyNotice">
              {(field) => (
                <field.TextareaField
                  id="registro-aviso"
                  label="Aviso de privacidad"
                  rows={5}
                  maxLength={10000}
                  disabled={!canWrite}
                />
              )}
            </form.AppField>
            {noticeSuggested ? (
              <div className="flex flex-col gap-2 rounded-2xl border border-dashed p-3 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">Sugerido, sin revisar</Badge>
                  Lo armamos con los datos de tu clínica.
                </span>
                <span className="text-muted-foreground">
                  Ya lo ve quien se registra o completa sus datos desde su enlace. Tu clínica responde por lo que dice:
                  revísalo y cámbialo si hace falta. Mientras no lo revises, se vuelve a armar si cambias la razón social,
                  el RUC o la dirección.
                </span>
                {/* Sin aviso propio, el paciente ve el sugerido en «Tus datos»: aquí se ve el mismo texto. */}
                {!privacyNotice.trim() && noticeShown ? (
                  <>
                    <blockquote className="rounded-xl bg-muted/60 p-3 text-muted-foreground whitespace-pre-wrap">{noticeShown}</blockquote>
                    {canWrite ? (
                      <Button type="button" variant="outline" size="sm" className="min-h-11 self-start sm:min-h-8" onClick={() => form.setFieldValue("privacyNotice", noticeShown)}>
                        Usarlo como base
                      </Button>
                    ) : null}
                  </>
                ) : null}
                {canWrite && privacyNotice.trim() ? (
                  <label htmlFor="registro-aviso-revisado" className="flex min-h-11 items-center gap-2 sm:min-h-0">
                    <Checkbox id="registro-aviso-revisado" checked={reviewed} onCheckedChange={(value) => setReviewed(value === true)} />
                    Lo revisé: guardarlo como el aviso de la clínica
                  </label>
                ) : null}
              </div>
            ) : null}
            <div className="flex min-h-11 items-center justify-between gap-3 rounded-2xl border p-3">
              <label htmlFor="registro-habilitado" className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">Que se registren solos</span>
                <span className="text-sm text-muted-foreground">
                  Con el enlace de la clínica o el código QR de recepción. {receptionName} manda este enlace a quien aún
                  no es paciente para que se registre y reserve.
                </span>
              </label>
              <Switch
                id="registro-habilitado"
                checked={enabled}
                onCheckedChange={(value) => form.setFieldValue("enabled", value === true)}
                disabled={!canWrite}
              />
            </div>
          </section>

          <section className={CARD} aria-labelledby="registro-enlace">
            <div className="flex flex-col gap-1.5">
              <h2 id="registro-enlace" className="font-heading text-base font-medium">
                Enlace público y código QR
              </h2>
              <p className="text-sm break-all text-muted-foreground">{publicLink}</p>
            </div>
            {!published ? (
              <p role="status" className="rounded-xl border bg-muted p-3 text-sm">
                El formulario público está apagado: el enlace y el código QR no admiten registros.
                {enabled ? " Ya lo marcaste arriba; falta guardar." : ""}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                className="min-h-11"
                onClick={() => void handleCopyLink()}
              >
                {copied ? "Enlace copiado" : "Copiar enlace"}
              </Button>
              {qrDataUrl ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    className="min-h-11"
                    onClick={() => void handleGenerateQr()}
                    disabled={qrPending}
                  >
                    Volver a generar
                  </Button>
                  {/* Descarga de un archivo: es un enlace (`download`), no un botón. */}
                  {sheetPng ? (
                    <a
                      href={sheetPng}
                      download={`hoja-registro-${slug}.png`}
                      className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}
                    >
                      Descargar la hoja para imprimir
                    </a>
                  ) : null}
                  {qrPng ? (
                    <a
                      href={qrPng}
                      download={`registro-${slug}.png`}
                      className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}
                    >
                      Descargar el código QR
                    </a>
                  ) : null}
                </>
              ) : null}
            </div>
            {qrError ? (
              <p role="alert" className="text-sm text-destructive">
                {qrError}
              </p>
            ) : null}
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt={`Código QR del registro de ${slug}`}
                className="size-64 max-w-full rounded-xl border bg-white p-2"
              />
            ) : (
              <EmptyState
                icon={QrCode}
                title="Aún no hay código QR"
                description="Genéralo para descargarlo o imprimir la hoja del mostrador. Lleva al registro de tu clínica, para quien llega sin ficha."
                actionLabel={qrPending ? "Generando…" : "Generar código QR"}
                onAction={() => {
                  if (!qrPending) void handleGenerateQr()
                }}
              />
            )}
          </section>

          {conflict ? (
            <Alert>
              <AlertDescription>
                Otra persona guardó un cambio antes que tú. Tu borrador sigue aquí: revísalo y
                vuelve a guardar.
              </AlertDescription>
            </Alert>
          ) : null}
          <section className={CARD} aria-labelledby="registro-falta">
            <h2 id="registro-falta" className="font-heading text-base font-medium">
              ¿Te falta una pregunta?
            </h2>
            <p className="text-sm text-muted-foreground">
              Lo que tu clínica pregunta y no está aquí, pregúntalo en la consulta y anótalo en una{" "}
              <Link to="/settings/consultation-forms" className="underline underline-offset-4">
                ficha de consulta
              </Link>
              . Si crees que toda clínica debería preguntarlo, cuéntanoslo desde Ayuda.
            </p>
          </section>
        </div>
        <aside
          className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-4"
          aria-label="Así lo ve el paciente"
        >
          <div className="flex flex-col gap-0.5">
            <h2 className="font-heading text-base font-medium">Así lo ve el paciente</h2>
            <p className="text-sm text-muted-foreground">
              Con lo que marcaste, una pregunta a la vez, en su celular. Es una vista previa: no
              guarda nada.
            </p>
          </div>
          <ScrollArea className="flex max-h-[75vh] min-h-[32rem] flex-col rounded-[2rem] border-8 border-foreground/85 bg-background shadow-sm">
            <div className="p-5">
              {previewDone ? (
                <div className="flex flex-col items-start gap-3 p-2">
                  <p role="status" className="text-sm">
                    Vista previa: no se guardaron datos.
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setPreviewDone(false)}
                  >
                    Volver a la vista previa
                  </Button>
                </div>
              ) : (
                <RegistrationQuestionnaire
                  config={{
                    version: expectedVersion,
                    enabled,
                    fields,
                    privacyNotice,
                    askReminders,
                    askMessages,
                  }}
                  today={today}
                  countryCode={profile.data?.countryCode ?? null}
                  shortcuts={false}
                  onSubmit={async () => {
                    setPreviewDone(true)
                  }}
                />
              )}
            </div>
          </ScrollArea>
        </aside>
      </div>
    </div>
  )
}
