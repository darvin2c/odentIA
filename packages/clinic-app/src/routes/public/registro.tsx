import { EmptyState, ErrorState, PageShell } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { CircleCheck } from "lucide-react"
import { useMemo, useState } from "react"
import { RegistrationQuestionnaire } from "../../components/patient/registration-questionnaire"
import { RegistroPageSkeleton } from "../../components/skeletons/public-registro"
import { publicAddressSource } from "../../lib/address-suggestions"
import { ApiError } from "../../lib/api"
import { orgSlugFromHostname, requestHostname } from "../../lib/host"
import { setOrgLocale } from "../../lib/locale"
import { fetchPublicRegistration, submitPublicRegistration } from "../../lib/patient-registration"

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
  pendingComponent: RegistroPageSkeleton,
  component: PublicRegistrationPage,
})

function PublicRegistrationPage() {
  const { token, via } = Route.useSearch()
  const queryClient = useQueryClient()
  const slug = orgSlugFromHostname(requestHostname())
  // La dirección se sugiere por la página de la clínica (issue 36).
  const addressSource = useMemo(() => (slug ? publicAddressSource(slug) : undefined), [slug])
  const [submissionId] = useState(() => crypto.randomUUID())
  /** Lo que dice la pantalla final: la clínica y de quién recibió los datos. */
  const [done, setDone] = useState<{ org: string; name: string; forOther: boolean } | null>(null)

  const infoQuery = useQuery({
    queryKey: ["public-registration", slug, token ?? null],
    queryFn: () => fetchPublicRegistration(slug ?? "", token),
    enabled: typeof window !== "undefined" && slug !== null && done === null,
    retry: false,
    staleTime: 30_000,
  })

  const entryPoint = via === "qr" ? "qr" : "public_link"

  if (done !== null) {
    return (
      <PageShell maxWidth="md" className="py-6 sm:py-10">
        <div className="flex flex-col items-center gap-4 rounded-2xl border bg-card px-5 py-10 text-center shadow-xs sm:px-8">
          <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <CircleCheck aria-hidden className="size-6" />
          </span>
          <div className="flex flex-col gap-1.5">
            <h1 className="font-heading text-xl font-semibold">Registro recibido</h1>
            <p className="text-sm text-pretty text-muted-foreground">
              {done.forOther
                ? `${done.org} ya tiene los datos de ${done.name}.`
                : `Gracias, ${done.name}. ${done.org} ya tiene tus datos.`}{" "}
              Este registro no reserva una cita.
            </p>
          </div>
          {via === "qr" ? (
            <p className="text-sm font-medium">Ya puedes avisar en recepción que terminaste.</p>
          ) : null}
        </div>
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
    return <RegistroPageSkeleton />
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

  // Ya tiene su ficha: el enlace solo sirve para registrar a otra persona.
  const ownRecord = info.context.kind === "conversation" && info.context.ownRecord === true

  return (
    <PageShell maxWidth="md" className="flex flex-col gap-6 py-6 sm:py-10">
      <header className="flex items-center gap-3">
        {info.organization.logo ? (
          <img
            src={info.organization.logo}
            alt=""
            className="size-10 rounded-md object-contain"
            referrerPolicy="no-referrer"
          />
        ) : null}
        <div className="flex min-w-0 flex-col">
          <h1 className="font-heading text-base font-semibold">{info.organization.name}</h1>
          <p className="text-sm text-muted-foreground">
            {ownRecord
              ? "Ya tienes tu registro en la clínica. Aquí registras a tu hijo o a un familiar."
              : "Registro de paciente"}
          </p>
        </div>
      </header>
      <div className="rounded-2xl border bg-card p-5 shadow-xs sm:p-8">
        <RegistrationQuestionnaire
          config={info.config}
          today={info.today}
          countryCode={info.countryCode ?? null}
          ownRecord={ownRecord}
          addressSource={addressSource}
          onSubmit={async (answers) => {
            try {
              const result = await submitPublicRegistration(slug, {
                submissionId,
                formVersion: info.config.version,
                token,
                entryPoint,
                answers,
              })
              if (result.data.registered)
                setDone({
                  org: info.organization.name,
                  name:
                    answers.demographics.givenNames?.split(" ")[0] ??
                    answers.demographics.displayName,
                  forOther: answers.respondent === "representative",
                })
            } catch (error) {
              const shape = error instanceof ApiError ? error.shape : null
              if (shape?.code === "FORM_CHANGED") {
                await queryClient.invalidateQueries({
                  queryKey: ["public-registration", slug, token ?? null],
                })
                throw new Error(
                  "La clínica cambió el registro: revisa tus respuestas y vuelve a enviar.",
                )
              }
              if (shape?.code === "REGISTRATION_NOT_COMPLETED")
                throw new Error("No pudimos completar el registro. Comunícate con recepción.")
              // Lo escrito con un formato que no vale: el cuestionario lo dice en su campo.
              if (shape?.fields && Object.keys(shape.fields).length > 0) throw error
              throw new Error(
                shape?.message ?? "No pudimos enviar el registro. Inténtalo de nuevo.",
              )
            }
          }}
        />
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Tus respuestas se envían solo al final.
      </p>
    </PageShell>
  )
}
