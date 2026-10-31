import { ErrorState, LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import { accountOrganizationsQuery } from "../lib/account-organizations"
import { tenantUrl } from "../lib/host"

/**
 * Plan y pagos vive dentro de la clínica (ADR 0065). Las direcciones viejas del
 * panel (`/billing/<org>`, que traen los correos ya enviados) llevan a la misma
 * página en la clínica; si la persona ya no pertenece a ella, al selector.
 */
export function PlanRedirect({ organizationId, path }: { organizationId: string; path: string }) {
  const organizations = useQuery(accountOrganizationsQuery)
  const navigate = useNavigate()
  const clinic = organizations.data?.find((org) => org.organizationId === organizationId)
  const slug = clinic?.slug ?? null
  const product = clinic?.product ?? null
  const missing = organizations.isSuccess && slug === null

  useEffect(() => {
    if (slug) window.location.replace(tenantUrl(slug, path, product))
    else if (missing) void navigate({ to: "/", search: { cambiar: 1 }, replace: true })
  }, [slug, product, missing, path, navigate])

  return (
    <PageShell>
      {organizations.isError ? (
        <ErrorState title="No se pudo abrir Plan y pagos" error={organizations.error} onRetry={() => void organizations.refetch()} />
      ) : (
        <LoadingState kind="indeterminate" message="Abriendo Plan y pagos de tu clínica…" />
      )}
    </PageShell>
  )
}
