import type {
  RegistrationAnswers,
  RegistrationConfig,
  RegistrationFieldKey,
  RegistrationFieldMode,
} from "@odentia/clinical"
import { REGISTRATION_FIELDS as CATALOGUE, registrationConfigSchema } from "@odentia/clinical"
import {
  Alert,
  AlertDescription,
  Button,
  buttonVariants,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  toast,
} from "@odentia/ui"
import {
  type CountryCode,
  EmptyState,
  normalizeCountry,
  PageHeader,
  phonePlaceholder,
  SubmitButton,
  toE164,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { QrCode } from "lucide-react"
import { useEffect, useState } from "react"
import { PatientRegistrationForm } from "../../components/patient/patient-registration-form"
import { SettingsLoadError } from "../../components/settings/load-error"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { orgSlugFromHostname, requestHostname, tenantUrl } from "../../lib/host"
import { useOrgProfile } from "../../lib/org"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"
import { fetchRegistrationConfig, saveRegistrationConfig } from "../../lib/patient-registration"

export const Route = createFileRoute("/_org/settings/patient-registration")({
  component: PatientRegistrationSettingsPage,
})

const orgRouteApi = getRouteApi("/_org")

const TITLE = "Registro de pacientes"
const SUBTITLE = "Qué se le pide a quien se registra con el enlace de la clínica, el aviso que acepta y su código QR."

/** La tarjeta de página, la misma en toda la plataforma. */
const CARD = "elevated flex flex-col gap-5 rounded-xl border bg-card p-5 sm:p-6"

const MODE_LABELS: Record<RegistrationFieldMode, string> = {
  hidden: "No se pide",
  optional: "Opcional",
  required: "Obligatorio",
}

const STEP_TITLES: Record<string, string> = {
  datos: "Datos",
  contacto: "Contacto y filiación",
  salud: "Salud",
  odontologicos: "Odontológicos",
}

const LOCKED_REQUIRED: RegistrationFieldKey[] = ["displayName", "birthDate"]

/**
 * Datos de ejemplo de la vista previa. El teléfono sale del país de la
 * clínica (el ejemplo oficial de su plan de numeración), nunca de uno fijo;
 * sin país en el perfil, el campo queda vacío.
 */
function previewValues(country: CountryCode | undefined): Partial<RegistrationAnswers> {
  const phone = country ? toE164(phonePlaceholder(country), country) : null
  return {
    demographics: {
      displayName: "Paciente de ejemplo",
      birthDate: "1990-05-12",
      ...(phone ? { phone } : {}),
    },
    respondent: "patient",
    privacyAccepted: true,
  }
}

type Draft = Pick<RegistrationConfig, "fields" | "enabled" | "privacyNotice" | "askReminders" | "askMessages">

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
  const countryCode = normalizeCountry(profile.data?.countryCode)
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
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewDone, setPreviewDone] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
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
        setFormErrors({ general: shape?.message ?? "No pudimos guardar el registro. Vuelve a intentarlo." })
      }
    },
  })

  if (fields === null) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        {configQuery.isError ? (
          <SettingsLoadError what="el registro de pacientes" onRetry={() => void configQuery.refetch()} />
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

  function setMode(key: RegistrationFieldKey, mode: RegistrationFieldMode) {
    setFields((current) => {
      if (!current) return current
      const next = { ...current, [key]: mode }
      if (key === "docType") next.docNumber = mode
      if (key === "docNumber") next.docType = mode
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
      // Importación dinámica: qrcode solo se usa en esta pantalla y no debe
      // entrar al bundle inicial de la plataforma.
      const { default: QRCode } = await import("qrcode")
      setQrDataUrl(
        await QRCode.toDataURL(qrLink, { width: 512, margin: 4, errorCorrectionLevel: "M" }),
      )
    } catch {
      setQrError("No pudimos generar el código QR. Vuelve a intentarlo.")
    } finally {
      setQrPending(false)
    }
  }

  const steps = ["datos", "contacto", "salud", "odontologicos"] as const
  const otherErrors = Object.entries(formErrors).filter(
    ([key]) => key !== "general" && key !== "privacyNotice" && !(key in fields),
  )

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageDraftGuard dirty={dirty} />
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <Button type="button" variant="secondary" className="min-h-11" onClick={() => setPreviewOpen(true)}>
            Vista previa
          </Button>
        }
      />

      {configQuery.isError ? (
        <SettingsLoadError stale what="el registro de pacientes" onRetry={() => void configQuery.refetch()} />
      ) : null}
      {!canWrite ? (
        <p role="note" className="text-sm text-muted-foreground">
          Puedes ver el registro; cambiarlo es de quien administra la clínica.
        </p>
      ) : null}

      {steps.map((step) => (
        <section key={step} className={CARD} aria-labelledby={`registro-paso-${step}`}>
          <h2 id={`registro-paso-${step}`} className="font-heading text-base font-medium">
            {STEP_TITLES[step]}
          </h2>
          <div className="flex flex-col gap-4">
            {CATALOGUE.filter((field) => field.step === step).map((field) => {
              const key = field.key as RegistrationFieldKey
              const locked = (LOCKED_REQUIRED as string[]).includes(key)
              return (
                <Field key={field.key}>
                  <FieldLabel htmlFor={`registro-campo-${field.key}`}>{field.label}</FieldLabel>
                  <Select
                    value={fields[key]}
                    items={MODE_LABELS}
                    onValueChange={(value) => setMode(key, value as RegistrationFieldMode)}
                    disabled={!canWrite || locked}
                  >
                    <SelectTrigger id={`registro-campo-${field.key}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(MODE_LABELS) as RegistrationFieldMode[]).map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {MODE_LABELS[mode]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {locked ? <FieldDescription>Siempre se pide: sin este dato no hay registro.</FieldDescription> : null}
                  {(key === "docType" || key === "docNumber") && !locked ? (
                    <FieldDescription>El tipo y el número de documento van juntos: se piden igual.</FieldDescription>
                  ) : null}
                  {formErrors[key] ? <FieldError>{formErrors[key]}</FieldError> : null}
                </Field>
              )
            })}
          </div>
        </section>
      ))}

      <section className={CARD} aria-labelledby="registro-mensajes">
        <div className="flex flex-col gap-1.5">
          <h2 id="registro-mensajes" className="font-heading text-base font-medium">
            Mensajes de la clínica
          </h2>
          <p className="text-sm text-muted-foreground">
            Lo que el registro pregunta, además de la atención. Lo que la persona acepte vale de inmediato para lo
            que el agente le escribe por su cuenta; sin preguntarlo, casi nadie podrá recibirlo.
          </p>
        </div>
        <ul className="flex flex-col divide-y rounded-xl border">
          <li className="flex items-center gap-3 p-3">
            <div className="flex-1">
              <div className="text-sm font-medium">Atención</div>
              <div className="text-sm text-muted-foreground">Siempre se pide: es la base del registro.</div>
            </div>
            <span className="text-xs font-semibold text-muted-foreground">Fijo</span>
          </li>
          <li className="flex min-h-11 items-center gap-3 p-3">
            <Checkbox
              id="registro-recordatorios"
              checked={askReminders}
              onCheckedChange={(value) => setAskReminders(value === true)}
              disabled={!canWrite}
            />
            <label htmlFor="registro-recordatorios" className="flex-1 text-sm font-medium">
              Recordatorios de citas y controles
            </label>
          </li>
          <li className="flex min-h-11 items-center gap-3 p-3">
            <Checkbox
              id="registro-otros-mensajes"
              checked={askMessages}
              onCheckedChange={(value) => setAskMessages(value === true)}
              disabled={!canWrite}
            />
            <label htmlFor="registro-otros-mensajes" className="flex-1">
              <span className="block text-sm font-medium">Otros mensajes de la clínica</span>
              <span className="block text-sm text-muted-foreground">Inasistencias y presupuestos pendientes.</span>
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
          {formErrors.privacyNotice ? <FieldError>{formErrors.privacyNotice}</FieldError> : null}
        </Field>
        <div className="flex min-h-11 items-center gap-3">
          <Checkbox
            id="registro-habilitado"
            checked={enabled}
            onCheckedChange={(value) => setEnabled(value === true)}
            disabled={!canWrite}
          />
          <label htmlFor="registro-habilitado" className="text-sm">
            Formulario público habilitado
          </label>
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
          <Button type="button" variant="secondary" className="min-h-11" onClick={() => void handleCopyLink()}>
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
              <a
                href={qrDataUrl}
                download={`registro-${slug}.png`}
                className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}
              >
                Descargar el código QR
              </a>
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
            description="Genéralo para descargarlo e imprimirlo. Lleva al registro de tu clínica."
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
            Otra persona guardó un cambio antes que tú. Tu borrador sigue aquí: revísalo y vuelve a guardar.
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
          <AlertDescription>{otherErrors.map(([, message]) => message).join(" ")}</AlertDescription>
        </Alert>
      ) : null}
      {canWrite ? (
        <div>
          <SubmitButton type="button" className="min-h-11" pending={saveMutation.isPending} onClick={handleSave}>
            Guardar
          </SubmitButton>
        </div>
      ) : null}

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[90vh] w-full overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Vista previa del formulario</DialogTitle>
            <DialogDescription>
              Datos de ejemplo, solo en esta pantalla. Finalizar no guarda nada.
            </DialogDescription>
          </DialogHeader>
          {previewDone ? (
            <p role="status" className="rounded-xl border bg-muted p-3 text-sm">
              Vista previa: no se guardaron datos
            </p>
          ) : (
            <PatientRegistrationForm
              mode="preview"
              config={{ version: expectedVersion, enabled, fields, privacyNotice, askReminders, askMessages }}
              today={today}
              defaultCountry={countryCode}
              context={{ kind: "generic" }}
              initialValues={previewValues(countryCode)}
              onSubmit={async () => {
                setPreviewDone(true)
              }}
            >
              {(view) => (
                <form onSubmit={view.onSubmit} className="space-y-6">
                  {view.progress}
                  {view.body}
                  <div className="flex flex-col gap-3">
                    {view.error ? (
                      <p role="alert" className="text-sm text-destructive">
                        {view.error}
                      </p>
                    ) : null}
                    <SubmitButton
                      type="submit"
                      pending={view.isSubmitting}
                      disabled={view.submitDisabled}
                      className="w-full"
                    >
                      {view.submitLabel}
                    </SubmitButton>
                    {view.previous}
                  </div>
                </form>
              )}
            </PatientRegistrationForm>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setPreviewOpen(false)
                setPreviewDone(false)
              }}
            >
              Cerrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
