import type {
  RegistrationConfig,
  RegistrationFieldKey,
  RegistrationFieldMode,
} from "@odentia/clinical"
import { registrationConfigSchema } from "@odentia/clinical"
import {
  Alert,
  AlertDescription,
  Button,
  buttonVariants,
  Checkbox,
  cn,
  Field,
  FieldError,
  FieldLabel,
  ScrollArea,
  Skeleton,
  Textarea,
  toast,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { EmptyState, PageHeader, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { QrCode } from "lucide-react"
import { useEffect, useState } from "react"
import { RegistrationQuestionnaire } from "../../components/patient/registration-questionnaire"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { RegistrationFieldsPicker } from "../../components/settings/registration-fields-picker"
import { ADMIN_NAME } from "../../lib/agent-names"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { orgSlugFromHostname, requestHostname, tenantUrl } from "../../lib/host"
import { useClinicalProfile, useOrgProfile } from "../../lib/org"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"
import { fetchRegistrationConfig, saveRegistrationConfig } from "../../lib/patient-registration"
import { brandedQrDataUrl, brandedQrPng, registrationSheetPng } from "../../lib/branded-qr"

export const Route = createFileRoute("/_org/settings/patient-registration")({
  component: PatientRegistrationSettingsPage,
})

const orgRouteApi = getRouteApi("/_org")

const TITLE = "Registro de pacientes"
const SUBTITLE =
  "Qué le pedimos a cada paciente, lo registre recepción o se registre solo, y el aviso de privacidad."

/** La tarjeta de página, la misma en toda la plataforma. */
const CARD = "elevated flex flex-col gap-5 rounded-xl border bg-card p-5 sm:p-6"

type Draft = Pick<
  RegistrationConfig,
  "fields" | "enabled" | "privacyNotice" | "askReminders" | "askMessages"
>

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

/** El hueco de la pantalla mientras carga: tarjetas con sus campos. */
function RegistrationSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <p role="status" className="sr-only">
        Cargando el registro de pacientes…
      </p>
      {["a", "b", "c"].map((key) => (
        <div key={key} className={CARD} aria-hidden>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      ))}
    </div>
  )
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

  const [fields, setFields] = useState<RegistrationConfig["fields"] | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [privacyNotice, setPrivacyNotice] = useState("")
  const [askReminders, setAskReminders] = useState(true)
  const [askMessages, setAskMessages] = useState(true)
  const [expectedVersion, setExpectedVersion] = useState(0)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
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
  const [baseline, setBaseline] = useState<Draft | null>(null)

  const loaded = configQuery.data?.data
  useEffect(() => {
    if (loaded && fields === null) {
      setFields({ ...loaded.fields })
      setEnabled(loaded.enabled)
      setPrivacyNotice(loaded.privacyNotice)
      setAskReminders(loaded.askReminders)
      setAskMessages(loaded.askMessages)
      setExpectedVersion(loaded.version)
      setBaseline({
        fields: loaded.fields,
        enabled: loaded.enabled,
        privacyNotice: loaded.privacyNotice,
        askReminders: loaded.askReminders,
        askMessages: loaded.askMessages,
      })
    }
  }, [loaded, fields])

  const saveMutation = useMutation({
    mutationFn: () =>
      saveRegistrationConfig({
        expectedVersion,
        enabled,
        fields: fields as RegistrationConfig["fields"],
        privacyNotice,
        askReminders,
        askMessages,
      }),
    onSuccess: (result) => {
      setExpectedVersion(result.data.version)
      setBaseline({
        fields: result.data.fields,
        enabled: result.data.enabled,
        privacyNotice: result.data.privacyNotice,
        askReminders: result.data.askReminders,
        askMessages: result.data.askMessages,
      })
      setFormErrors({})
      setConflict(false)
      toast.success("Registro de pacientes guardado")
      void queryClient.invalidateQueries({ queryKey: ["patient-registration-config"] })
    },
    onError: async (error: unknown) => {
      const shape = error instanceof ApiError ? error.shape : null
      if (shape?.code === "STALE_REGISTRATION_CONFIG") {
        setConflict(true)
        const refreshed = await configQuery.refetch()
        if (refreshed.data) {
          setExpectedVersion(refreshed.data.data.version)
        } else {
          setFormErrors({
            general: "No pudimos volver a cargar el registro. Reintenta antes de guardar.",
          })
        }
        return
      }
      setConflict(false)
      const details = shape?.details as Record<string, string> | undefined
      if (details && typeof details === "object") {
        setFormErrors(details)
      } else {
        setFormErrors({
          general: shape?.message ?? "No pudimos guardar el registro. Vuelve a intentarlo.",
        })
      }
    },
  })

  if (fields === null) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        {configQuery.isError ? (
          <SettingsLoadError
            what="el registro de pacientes"
            onRetry={() => void configQuery.refetch()}
          />
        ) : (
          <RegistrationSkeleton />
        )}
      </div>
    )
  }

  const today = configQuery.data?.meta.today ?? ""
  const draft: Draft = { fields, enabled, privacyNotice, askReminders, askMessages }
  const dirty = baseline !== null && !sameDraft(draft, baseline)
  const published = baseline?.enabled ?? false

  function setModes(keys: RegistrationFieldKey[], mode: RegistrationFieldMode) {
    setFields((current) => {
      if (!current) return current
      const next = { ...current }
      for (const key of keys) next[key] = mode
      return next
    })
  }

  function handleSave() {
    if (!canWrite || !fields) return
    const parsed = registrationConfigSchema.safeParse({
      version: expectedVersion,
      enabled,
      fields,
      privacyNotice,
      askReminders,
      askMessages,
    })
    const errors: Record<string, string> = {}
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        errors[String(issue.path.at(-1) ?? "general")] ??= issue.message
    setFormErrors(errors)
    setConflict(false)
    if (Object.keys(errors).length > 0) return
    saveMutation.mutate()
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

  const otherErrors = Object.entries(formErrors).filter(
    ([key]) => key !== "general" && key !== "privacyNotice" && !(key in fields),
  )

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <PageDraftGuard dirty={dirty} />
      <PageHeader title={TITLE} subtitle={SUBTITLE} />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          {configQuery.isError ? (
            <SettingsLoadError
              stale
              what="el registro de pacientes"
              onRetry={() => void configQuery.refetch()}
            />
          ) : null}
          {!canWrite ? (
            <p role="note" className="text-sm text-muted-foreground">
              Puedes ver el registro; cambiarlo es de quien administra la clínica.
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
            />
            {Object.keys(formErrors).some((key) => key in fields) ? (
              <FieldError>
                {Object.entries(formErrors)
                  .filter(([key]) => key in fields)
                  .map(([, message]) => message)
                  .join(" ")}
              </FieldError>
            ) : null}
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
                  onCheckedChange={(value) => setAskMessages(value === true)}
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
            <Field>
              <FieldLabel htmlFor="registro-aviso">Aviso de privacidad</FieldLabel>
              <Textarea
                id="registro-aviso"
                value={privacyNotice}
                onChange={(event) => setPrivacyNotice(event.target.value)}
                rows={5}
                disabled={!canWrite}
              />
              {formErrors.privacyNotice ? (
                <FieldError>{formErrors.privacyNotice}</FieldError>
              ) : null}
            </Field>
            <div className="flex min-h-11 items-center justify-between gap-3 rounded-2xl border p-3">
              <label htmlFor="registro-habilitado" className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">Que se registren solos</span>
                <span className="text-sm text-muted-foreground">
                  Con el enlace de la clínica o el código QR de recepción.
                </span>
              </label>
              <Switch
                id="registro-habilitado"
                checked={enabled}
                onCheckedChange={(value) => setEnabled(value === true)}
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
          {formErrors.general ? (
            <Alert variant="destructive">
              <AlertDescription>{formErrors.general}</AlertDescription>
            </Alert>
          ) : null}
          {otherErrors.length > 0 ? (
            <Alert variant="destructive">
              <AlertDescription>
                {otherErrors.map(([, message]) => message).join(" ")}
              </AlertDescription>
            </Alert>
          ) : null}
          {canWrite ? (
            <div>
              <SubmitButton
                type="button"
                className="min-h-11"
                pending={saveMutation.isPending}
                onClick={handleSave}
              >
                Guardar
              </SubmitButton>
            </div>
          ) : null}
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
