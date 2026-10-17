import { EmptyState, ErrorState, LoadingState, PageShell, SubmitButton } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import type { RegistrationAnswers } from "@odentia/clinical"
import { PatientRegistrationForm } from "../components/patient/patient-registration-form"
import { ApiError } from "../lib/api"
import { orgSlugFromHostname, requestHostname } from "../lib/host"
import { setOrgLocale } from "../lib/locale"
import {
  fetchPublicRegistration,
  submitPublicRegistration,
} from "../lib/patient-registration"

export const Route = createFileRoute("/registro")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
    via: search.via === "qr" ? ("qr" as const) : undefined,
  }),
  head: () => ({
    meta: [
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: PublicRegistrationPage,
})

function PublicRegistrationPage() {
  const { token, via } = Route.useSearch()
  const queryClient = useQueryClient()
  const slug = orgSlugFromHostname(requestHostname())
  const [submissionId] = useState(() => crypto.randomUUID())
  const [succeededOrg, setSucceededOrg] = useState<string | null>(null)
  const [retainedDraft, setRetainedDraft] = useState<Partial<RegistrationAnswers> | undefined>(
    undefined,
  )
  const [notice, setNotice] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const infoQuery = useQuery({
    queryKey: ["public-registration", slug, token ?? null],
    queryFn: () => fetchPublicRegistration(slug ?? "", token),
    enabled: typeof window !== "undefined" && slug !== null && succeededOrg === null,
    retry: false,
    staleTime: 30_000,
  })

  const entryPoint = via === "qr" ? "qr" : "public_link"

  if (succeededOrg !== null) {
    return (
      <PageShell maxWidth="md">
        <EmptyState
          title="Paciente registrado"
          description={`Paciente registrado. Tus datos fueron recibidos por ${succeededOrg}. Este formulario no reserva una cita.`}
        />
      </PageShell>
    )
  }
  if (slug === null) {
    return (
      <PageShell maxWidth="md">
        <EmptyState
          title="Registro no disponible"
          description="No pudimos identificar la clínica para este registro. Verifica el enlace o el código QR."
        />
      </PageShell>
    )
  }

  if (infoQuery.isPending) {
    return (
      <PageShell maxWidth="md">
        <LoadingState message="Cargando el formulario de registro…" />
      </PageShell>
    )
  }

  if (infoQuery.isError) {
    const unavailableWithToken = token !== undefined
    return (
      <PageShell maxWidth="md">
        <ErrorState
          title={unavailableWithToken ? "Enlace no disponible" : "Registro no disponible"}
          error={
            infoQuery.error instanceof ApiError
              ? infoQuery.error.shape
              : infoQuery.error instanceof Error
                ? infoQuery.error
                : "No pudimos cargar el formulario. Inténtalo más tarde."
          }
          onRetry={() => void infoQuery.refetch()}
        />
      </PageShell>
    )
  }

  const info = infoQuery.data.data
  // Página pública, sin layout de organización: el formato regional, la zona y
  // el país de la clínica llegan con el registro y se fijan antes de pintar fechas.
  setOrgLocale(info.locale, info.timeZone, info.countryCode)

  if (!info.config.enabled) {
    return (
      <PageShell maxWidth="md">
        <EmptyState
          title="Registro no disponible"
          description="Esta clínica no tiene habilitado el registro en este momento. Comunícate con recepción."
        />
      </PageShell>
    )
  }


  const contextKind = info.context.kind === "conversation" ? "conversation" : "generic"
  // Ya tiene su ficha: el enlace solo sirve para registrar a otra persona.
  const ownRecord = info.context.kind === "conversation" && info.context.ownRecord === true

  return (
    <PageShell maxWidth="md">
      <header className="mb-6 flex items-center gap-3">
        {info.organization.logo ? (
          <img
            src={info.organization.logo}
            alt=""
            className="size-10 rounded-md object-contain"
            referrerPolicy="no-referrer"
          />
        ) : null}
        <div>
          <h1 className="text-xl font-semibold">Registro de paciente · {info.organization.name}</h1>
          {ownRecord ? (
            <p className="text-sm text-muted-foreground">
              Ya tienes tu registro en la clínica. Aquí puedes registrar a tu hijo o a un familiar.
            </p>
          ) : contextKind === "conversation" ? (
            <p className="text-sm text-muted-foreground">
              Continúa con el registro compartido por la clínica.
            </p>
          ) : null}
        </div>
      </header>
      {notice ? (
        <p role="status" className="mb-4 rounded-md border border-border bg-muted p-3 text-sm">
          {notice}
        </p>
      ) : null}
      {submitError ? (
        <p role="alert" className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
          {submitError}
        </p>
      ) : null}
      <PatientRegistrationForm
        mode="public"
        config={info.config}
        today={info.today}
        countryCode={info.countryCode ?? null}
        context={{ kind: contextKind, ownRecord }}
        initialValues={retainedDraft}
        onSubmit={async (draft) => {
          setNotice(null)
          setSubmitError(null)
          setRetainedDraft({ ...draft.answers })
          try {
            const result = await submitPublicRegistration(slug, {
              submissionId,
              formVersion: info.config.version,
              token,
              entryPoint,
              answers: draft.answers,
            })
            if (result.data.registered) {
              setRetainedDraft(undefined)
              setSucceededOrg(info.organization.name)
            }
          } catch (error) {
            const shape = error instanceof ApiError ? error.shape : null
            if (shape?.code === "FORM_CHANGED") {
              await queryClient.invalidateQueries({
                queryKey: ["public-registration", slug, token ?? null],
              })
              setNotice(
                "El formulario cambió: recargamos la configuración vigente. Revisa los campos marcados y vuelve a enviar.",
              )
              return
            }
            if (shape?.code === "REGISTRATION_NOT_COMPLETED") {
              setSubmitError("No pudimos completar el registro. Comunícate con recepción.")
              return
            }
            setSubmitError(
              shape?.message ?? "No pudimos enviar el registro. Inténtalo de nuevo.",
            )
          }
        }}
      >
        {(view) => (
          <form onSubmit={view.onSubmit} className="space-y-6">
            {view.progress}
            {view.body}
            {/* El aviso previo que pide WhatsApp para los mensajes de servicio (ADR 0040). */}
            <p className="text-sm text-muted-foreground">Te avisaremos por WhatsApp sobre tus citas.</p>
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
    </PageShell>
  )
}
