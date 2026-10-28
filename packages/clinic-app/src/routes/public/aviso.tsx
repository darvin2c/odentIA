import { EmptyState, ErrorState, LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ApiError } from "../../lib/api"
import { orgSlugFromHostname, requestHostname } from "../../lib/host"
import { fetchPublicPrivacyNotice } from "../../lib/patient-registration"

/**
 * El aviso de privacidad de la clínica fuera del formulario de registro: lo
 * enlaza el agente al pedir el sí que registra a alguien por el chat (ADR
 * 0101). El texto es el que la clínica escribe en Configuración › Registro de pacientes.
 */
export const Route = createFileRoute("/aviso")({
  head: () => ({
    meta: [
      { title: "Aviso de privacidad" },
      { name: "robots", content: "noindex" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: PrivacyNoticePage,
})

function PrivacyNoticePage() {
  const slug = orgSlugFromHostname(requestHostname())
  const query = useQuery({
    queryKey: ["public-privacy-notice", slug],
    queryFn: () => fetchPublicPrivacyNotice(slug ?? ""),
    enabled: typeof window !== "undefined" && slug !== null,
    retry: false,
    staleTime: 5 * 60_000,
  })

  if (slug === null) {
    return (
      <PageShell maxWidth="md">
        <EmptyState title="Aviso no disponible" description="No pudimos identificar la clínica. Verifica el enlace." />
      </PageShell>
    )
  }
  if (query.isPending) {
    return (
      <PageShell maxWidth="md">
        <LoadingState message="Cargando el aviso de privacidad…" />
      </PageShell>
    )
  }
  if (query.isError) {
    return (
      <PageShell maxWidth="md">
        <ErrorState
          title="Aviso no disponible"
          error={query.error instanceof ApiError ? query.error.shape : "No pudimos cargar el aviso. Inténtalo más tarde."}
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    )
  }

  const { organization, notice, version } = query.data.data
  return (
    <PageShell maxWidth="md" className="flex flex-col gap-4 py-6 sm:py-10">
      <header className="flex items-center gap-3">
        {organization.logo ? (
          <img src={organization.logo} alt="" className="size-10 rounded-md object-contain" referrerPolicy="no-referrer" />
        ) : null}
        <div className="flex min-w-0 flex-col">
          <p className="text-sm text-muted-foreground">{organization.name}</p>
          <h1 className="font-heading text-xl font-semibold">Aviso de privacidad</h1>
          <p className="text-sm text-muted-foreground">Versión {version}</p>
        </div>
      </header>
      <section className="rounded-3xl border bg-card p-5 shadow-xs">
        <p className="text-sm leading-relaxed whitespace-pre-wrap text-pretty">{notice}</p>
      </section>
      <p className="px-1 text-sm text-muted-foreground">¿Dudas? Escríbenos por el chat y te ayudamos.</p>
    </PageShell>
  )
}
