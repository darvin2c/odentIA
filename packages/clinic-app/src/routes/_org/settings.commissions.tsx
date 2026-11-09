/**
 * Configuración › Comisiones por profesional: lo que se lleva cada profesional de lo cobrado por lo que atiende.
 * Es un acuerdo con la persona, no algo del mes: se fija aquí y Finanzas › Comisiones lo usa para
 * liquidar y pagar. Lo ve y lo cambia quien administra las comisiones (`commissions.write`); el
 * servidor lo comprueba otra vez. `?profesional=` lleva a la tarjeta de esa persona.
 */
import { EmptyState, ErrorState, PageHeader, SkeletonRegion } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Settings } from "lucide-react"
import {
  AGREEMENTS_KEY,
  CommissionAgreementsList,
} from "../../components/finance/commission-agreements"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { CommissionAgreementsSkeleton, CommissionsSettingsPageSkeleton } from "../../components/skeletons/settings"
import { fetchCommissionAgreements } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import { useOrgFinanceProfile } from "../../lib/finance-collect"

export const Route = createFileRoute("/_org/settings/commissions")({
  validateSearch: (search: Record<string, unknown>): { profesional?: string } =>
    typeof search.profesional === "string" && search.profesional ? { profesional: search.profesional } : {},
  pendingComponent: CommissionsSettingsPageSkeleton,
  component: CommissionsSettingsPage,
})

const COMMISSIONS_SETTINGS_SUBTITLE =
  "Lo que se lleva cada profesional de lo cobrado por lo que atiende. Un cambio vale para lo que se atienda desde ese día: lo ya atendido conserva lo que tenía."

function CommissionsSettingsPage() {
  const allowed = usePermission("commissions.write")
  const canFinance = usePermission("finance.read")
  const search = Route.useSearch()
  const navigate = useNavigate()
  const profile = useOrgFinanceProfile()
  const agreementsQuery = useQuery({
    queryKey: AGREEMENTS_KEY,
    queryFn: fetchCommissionAgreements,
    enabled: allowed,
  })

  const subtitle = (
    <p className="min-w-0">
      {COMMISSIONS_SETTINGS_SUBTITLE}
      {canFinance ? (
        <>
          {" "}
          Lo de cada mes se paga en{" "}
          <Link
            to="/finance"
            search={{ tab: "comisiones" }}
            className="font-medium text-primary-soft-foreground underline-offset-2 hover:underline"
          >
            Finanzas › Comisiones
          </Link>
          .
        </>
      ) : null}
    </p>
  )

  if (!allowed) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Comisiones por profesional" subtitle={COMMISSIONS_SETTINGS_SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }

  const region = profile.data?.data ?? null
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Comisiones por profesional" subtitle={subtitle} />
      {agreementsQuery.isPending || profile.isPending ? (
        <SkeletonRegion message="Cargando las comisiones…">
          <CommissionAgreementsSkeleton />
        </SkeletonRegion>
      ) : agreementsQuery.isError ? (
        <ErrorState
          title="No pudimos cargar las comisiones"
          message="Comprueba tu conexión y vuelve a intentarlo."
          onRetry={() => void agreementsQuery.refetch()}
        />
      ) : !region ? (
        <EmptyState
          icon={Settings}
          title="Falta configurar la clínica"
          description="Las comisiones usan la moneda y el formato de la clínica. Aún no están configurados."
          actionLabel="Ir a Datos de la clínica"
          onAction={() => void navigate({ to: "/settings" })}
        />
      ) : (
        <>
          <CommissionAgreementsList
            agreements={agreementsQuery.data.data}
            locale={region.locale}
            timeZone={region.timezone}
            currency={region.currency}
            focusId={search.profesional ?? null}
          />
          <p className="text-sm text-muted-foreground">
            Aparece cada persona del equipo que puede atender. Si además tiene un sueldo fijo, se registra en Finanzas ›
            Gastos como gasto que se repite. Cada profesional ve su comisión en «Mis honorarios».
          </p>
        </>
      )}
    </div>
  )
}
