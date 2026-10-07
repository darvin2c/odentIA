import type {
  RegistrationAnswers,
  RegistrationConfig,
  RegistrationFieldKey,
  RegistrationFieldMode,
} from "@odentia/clinical"
import { REGISTRATION_FIELDS as CATALOGUE, registrationConfigSchema } from "@odentia/clinical"
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import {
  EmptyState,
  ErrorState,
  LoadingState,
  normalizeCountry,
  PageHeader,
  SubmitButton,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { PatientRegistrationForm } from "../../components/patient/patient-registration-form"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { orgSlugFromHostname, requestHostname, tenantUrl } from "../../lib/host"
import { useOrgProfile } from "../../lib/org"
import { fetchRegistrationConfig, saveRegistrationConfig } from "../../lib/patient-registration"
import { PageDraftGuard, sameDraft } from "../../lib/page-draft-guard"

export const Route = createFileRoute("/_org/settings/patient-registration")({
  component: PatientRegistrationSettingsPage,
})

const orgRouteApi = getRouteApi("/_org")

const MODE_LABELS: Record<RegistrationFieldMode, string> = {
  hidden: "Oculto",
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

const PREVIEW_VALUES: Partial<RegistrationAnswers> = {
  demographics: {
    displayName: "Paciente de ejemplo",
    birthDate: "1990-05-12",
    // E.164, como lo emite el campo: la vista previa muestra un teléfono válido.
    phone: "+51999888777",
  },
  respondent: "patient",
  privacyAccepted: true,
}

function PatientRegistrationSettingsPage() {
  const queryClient = useQueryClient()
  const canWrite = usePermission("settings.write")
  // El país del perfil define la máscara de los teléfonos de la vista previa.
  const profile = useOrgProfile()
  const countryCode = normalizeCountry(profile.data?.countryCode)
  const { org } = orgRouteApi.useRouteContext()
  const slug = org?.slug ?? orgSlugFromHostname(requestHostname()) ?? ""
  const publicLink = tenantUrl(slug, "/registro")
  const qrLink = tenantUrl(slug, "/registro?via=qr")

  const configQuery = useQuery({
    queryKey: ["patient-registration-config"],
    queryFn: fetchRegistrationConfig,
    retry: false,
  })

  const [fields, setFields] = useState<RegistrationConfig["fields"] | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [privacyNotice, setPrivacyNotice] = useState("")
  const [expectedVersion, setExpectedVersion] = useState(0)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [savedNotice, setSavedNotice] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewDone, setPreviewDone] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrPending, setQrPending] = useState(false)
  const [qrError, setQrError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [baseline, setBaseline] = useState<Pick<RegistrationConfig, "fields" | "enabled" | "privacyNotice"> | null>(null)

  const loaded = configQuery.data?.data
  useEffect(() => {
    if (loaded && fields === null) {
      setFields({ ...loaded.fields })
      setEnabled(loaded.enabled)
      setPrivacyNotice(loaded.privacyNotice)
      setExpectedVersion(loaded.version)
      setBaseline({ fields: loaded.fields, enabled: loaded.enabled, privacyNotice: loaded.privacyNotice })
    }
  }, [loaded, fields])

  const saveMutation = useMutation({
    mutationFn: () =>
      saveRegistrationConfig({
        expectedVersion,
        enabled,
        fields: fields as RegistrationConfig["fields"],
        privacyNotice,
      }),
    onSuccess: (result) => {
      setExpectedVersion(result.data.version)
      setBaseline({ fields: result.data.fields, enabled: result.data.enabled, privacyNotice: result.data.privacyNotice })
      setFormErrors({})
      setSavedNotice("Configuración guardada")
      void queryClient.invalidateQueries({ queryKey: ["patient-registration-config"] })
    },
    onError: async (error: unknown) => {
      const shape = error instanceof ApiError ? error.shape : null
      if (shape?.code === "STALE_REGISTRATION_CONFIG") {
        setSavedNotice(
          "Otro cambio se guardó antes. Conservamos tu borrador: revisa los cambios y vuelve a guardar.",
        )
        const refreshed = await configQuery.refetch()
        if (refreshed.data) {
          const current = refreshed.data.data
          setExpectedVersion(current.version)
        } else {
          setFormErrors({
            general: "No pudimos recargar la configuración. Reintenta antes de guardar.",
          })
        }
        return
      }
      setSavedNotice(null)
      const details = shape?.details as Record<string, string> | undefined
      if (details && typeof details === "object") {
        setFormErrors(details)
      } else {
        setFormErrors({ general: shape?.message ?? "No pudimos guardar la configuración" })
      }
    },
  })

  if (configQuery.isPending || fields === null) {
    if (configQuery.isError) {
      return (
        <div className="mx-auto w-full max-w-3xl">
          <PageHeader
            title="Registro de pacientes"
            subtitle="Formulario público y QR de admisión"
          />
          <ErrorState
            error={
              configQuery.error instanceof ApiError
                ? configQuery.error.shape
                : "No pudimos cargar la configuración"
            }
            onRetry={() => void configQuery.refetch()}
          />
        </div>
      )
    }
    return (
      <div className="mx-auto w-full max-w-3xl">
        <PageHeader title="Registro de pacientes" subtitle="Formulario público y QR de admisión" />
        <LoadingState message="Cargando la configuración…" />
      </div>
    )
  }

  const today = configQuery.data?.meta.today ?? ""

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
    })
    const errors: Record<string, string> = {}
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        errors[String(issue.path.at(-1) ?? "general")] ??= issue.message
    setFormErrors(errors)
    setSavedNotice(null)
    if (Object.keys(errors).length > 0) return
    saveMutation.mutate()
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(publicLink)
      setCopied(true)
    } catch {
      setCopied(false)
      setFormErrors((current) => ({
        ...current,
        general: "No pudimos copiar el enlace: cópialo manualmente",
      }))
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
      setQrError("No pudimos generar el QR. Inténtalo de nuevo.")
    } finally {
      setQrPending(false)
    }
  }

  const steps = ["datos", "contacto", "salud", "odontologicos"] as const

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageDraftGuard dirty={baseline !== null && !sameDraft({ fields, enabled, privacyNotice }, baseline)} />
      <PageHeader
        title="Registro de pacientes"
        subtitle="Campos del formulario público, aviso de privacidad y código QR"
        actions={
          <Button type="button" variant="secondary" onClick={() => setPreviewOpen(true)}>
            Vista previa
          </Button>
        }
      />

      {savedNotice ? (
        <p role="status" className="mb-4 rounded-md border border-border bg-muted p-3 text-sm">
          {savedNotice}
        </p>
      ) : null}
      {formErrors.general ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
        >
          {formErrors.general}
        </p>
      ) : null}

      <div className="space-y-6">
        {steps.map((step) => (
          <div key={step} className="flex flex-col gap-6 rounded-sm bg-card p-6">
            <div className="flex flex-col gap-1.5">
              <div className="font-heading text-base font-medium">{STEP_TITLES[step]}</div>
            </div>
            <div className="space-y-4">
              {CATALOGUE.filter((field) => field.step === step).map((field) => {
                const key = field.key as RegistrationFieldKey
                const locked = (LOCKED_REQUIRED as string[]).includes(key)
                return (
                  <Field key={field.key}>
                    <FieldLabel htmlFor={`registro-campo-${field.key}`}>{field.label}</FieldLabel>
                    <Select
                      value={fields[key]}
                      onValueChange={(value) => setMode(key, value as RegistrationFieldMode)}
                      disabled={!canWrite || locked}
                    >
                      <SelectTrigger id={`registro-campo-${field.key}`}>
                        <SelectValue>{MODE_LABELS[fields[key]]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(MODE_LABELS) as RegistrationFieldMode[]).map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {MODE_LABELS[mode]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {locked ? (
                      <p className="text-xs text-muted-foreground">
                        Este campo es obligatorio en el formulario público.
                      </p>
                    ) : null}
                    {(key === "docType" || key === "docNumber") && !locked ? (
                      <p className="text-xs text-muted-foreground">
                        Configura el documento como pareja: ambos campos comparten el mismo modo.
                      </p>
                    ) : null}
                    {formErrors[key] ? <FieldError>{formErrors[key]}</FieldError> : null}
                  </Field>
                )
              })}
            </div>
          </div>
        ))}
        <div className="flex flex-col gap-6 rounded-sm bg-card p-6">
          <div className="flex flex-col gap-1.5">
            <div className="font-heading text-base font-medium">
              Aviso de privacidad y publicación
            </div>
            <p className="text-sm text-muted-foreground">
              El aviso lo aporta la organización y se muestra antes del consentimiento.
            </p>
          </div>
          <div className="space-y-4">
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
            <Field>
              <label
                htmlFor="registro-habilitado"
                className="flex cursor-pointer items-center gap-2 text-sm"
              >
                <Checkbox
                  id="registro-habilitado"
                  checked={enabled}
                  onCheckedChange={(value) => setEnabled(value === true)}
                  disabled={!canWrite}
                />
                Formulario público habilitado
              </label>
            </Field>
            <SubmitButton
              type="button"
              pending={saveMutation.isPending}
              disabled={!canWrite}
              onClick={handleSave}
            >
              Guardar configuración
            </SubmitButton>
            {!canWrite ? (
              <p className="text-xs text-muted-foreground">
                Necesitas permiso de configuración para modificar esta pantalla.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-6 rounded-sm bg-card p-6">
          <div className="flex flex-col gap-1.5">
            <div className="font-heading text-base font-medium">Enlace público y QR</div>
            <p className="text-sm text-muted-foreground">{publicLink}</p>
          </div>
          <div className="space-y-4">
            {!enabled ? (
              <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">
                El formulario está deshabilitado: el enlace y el QR no admiten registros nuevos
                hasta volver a publicar.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" onClick={() => void handleCopyLink()}>
                {copied ? "Enlace copiado" : "Copiar enlace"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void handleGenerateQr()}
                disabled={qrPending}
              >
                {qrDataUrl ? "Regenerar QR" : "Generar QR"}
              </Button>
              {qrDataUrl ? (
                <a
                  href={qrDataUrl}
                  download={`registro-${slug}.png`}
                  className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium"
                >
                  Descargar QR
                </a>
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
                className="size-64 rounded-md border border-border bg-white p-2"
              />
            ) : (
              <EmptyState
                title="Sin QR generado"
                description="Genera el código para descargarlo e imprimirlo. Apunta al registro de esta organización."
              />
            )}
          </div>
        </div>
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[90vh] w-full overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Vista previa del formulario</DialogTitle>
            <DialogDescription>
              Datos ficticios en memoria. Finalizar no guarda nada.
            </DialogDescription>
          </DialogHeader>
          {previewDone ? (
            <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">
              Vista previa: no se guardaron datos
            </p>
          ) : (
            <PatientRegistrationForm
              mode="preview"
              config={{ version: expectedVersion, enabled, fields, privacyNotice }}
              today={today}
              defaultCountry={countryCode}
              context={{ kind: "generic" }}
              initialValues={PREVIEW_VALUES}
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
