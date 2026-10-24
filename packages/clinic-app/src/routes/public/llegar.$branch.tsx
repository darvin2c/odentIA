import { EmptyState, LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useEffect } from "react"
import { fetchBranchDirections } from "../../lib/booking-link"
import { orgSlugFromHostname, requestHostname } from "../../lib/host"

export const Route = createFileRoute("/llegar/$branch")({
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: DirectionsPage,
})

/**
 * El enlace corto para llegar a una sede (issue 36): lo manda Sofi y se copia
 * en Sedes. Lleva a la ficha de la sede en Google Maps; sin sesión y sin datos
 * de nadie. Una sede desactivada o sin dirección no existe para este enlace.
 */
function DirectionsPage() {
  const { branch } = Route.useParams()
  const slug = orgSlugFromHostname(requestHostname())
  const query = useQuery({
    queryKey: ["branch-directions", slug, branch],
    queryFn: () => fetchBranchDirections(slug ?? "", branch),
    enabled: typeof window !== "undefined" && slug !== null,
    retry: false,
  })
  const found = query.data?.data
  useEffect(() => {
    if (found) window.location.replace(found.url)
  }, [found])

  if (slug === null || query.isError) {
    return (
      <PageShell maxWidth="md">
        <EmptyState
          title="Este enlace ya no sirve"
          description="Puede que la sede haya cambiado. Escríbele a la clínica y te dirá cómo llegar."
        />
      </PageShell>
    )
  }
  if (!found) {
    return (
      <PageShell maxWidth="md">
        <LoadingState message="Abriendo el mapa…" />
      </PageShell>
    )
  }
  return (
    <PageShell maxWidth="md">
      <EmptyState
        title={`Cómo llegar a ${found.branchName}`}
        description="Si el mapa no se abrió solo, tócalo aquí abajo."
        actionLabel="Abrir Google Maps"
        onAction={() => window.location.assign(found.url)}
      />
    </PageShell>
  )
}
