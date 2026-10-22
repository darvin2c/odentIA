/**
 * Comisiones. Quien administra (`commissions.write`) ve el mes de toda la
 * clínica; quien solo tiene `commissions.read` ve «Mis comisiones». El mes vive
 * en el enlace (`?year=&month=`), así el aviso de pago lleva al mes pagado; sin
 * él se muestra el mes en curso de la clínica.
 */
import { EmptyState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router"
import { Settings } from "lucide-react"
import {
  CommissionsAdminPanel,
  MonthPicker,
  MyCommissionsPanel,
} from "../../components/finance/CommissionsPanel"
import { compareMonths, currentMonthIn, FIRST_YEAR, type YearMonth } from "../../lib/commissions"
import { useMyUserId, useOrgMembers, usePermission } from "../../lib/crm"
import { useOrgFinanceProfile } from "../../lib/finance-collect"
import { QueryErrorState } from "../../lib/query-error"

interface CommissionsSearch {
  year?: number
  month?: number
  /** Profesional con el detalle abierto (solo administración). */
  profesional?: string
}

export const Route = createFileRoute("/_org/commissions")({
  // Un mes mal escrito en el enlace no rompe la pantalla: se muestra el mes en curso.
  validateSearch: (search: Record<string, unknown>): CommissionsSearch => {
    const year = Number(search.year)
    const month = Number(search.month)
    const validMonth =
      Number.isInteger(year) &&
      year >= FIRST_YEAR &&
      year <= 2100 &&
      Number.isInteger(month) &&
      month >= 1 &&
      month <= 12
    return {
      ...(validMonth ? { year, month } : {}),
      ...(typeof search.profesional === "string" && search.profesional
        ? { profesional: search.profesional }
        : {}),
    }
  },
  component: CommissionsPage,
})

const ADMIN_SUBTITLE = "Lo que le corresponde a cada profesional por lo que atendió y ya se cobró"

/**
 * Comisiones es una sección de Finanzas: quien ve Finanzas llega ahí con el
 * mismo mes y profesional (el aviso de pago enlaza a esta ruta). Quien solo
 * tiene «Mis comisiones» no entra a Finanzas y conserva aquí su vista.
 */
function CommissionsPage() {
  const canFinance = usePermission("finance.read")
  const search = Route.useSearch()
  if (canFinance) {
    return <Navigate to="/finance" search={{ tab: "comisiones", ...search }} replace />
  }
  return <OwnCommissionsPage />
}

function OwnCommissionsPage() {
  const allowed = usePermission("commissions.read")
  const canWrite = usePermission("commissions.write")
  const canSettings = usePermission("settings.write")
  const myUserId = useMyUserId()
  const members = useOrgMembers()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const goTo = useNavigate()
  const profile = useOrgFinanceProfile()

  const title = canWrite ? "Comisiones" : "Mis comisiones"
  const myName = members.find((member) => member.userId === myUserId)?.user.name
  const subtitle = canWrite ? ADMIN_SUBTITLE : myName

  if (!allowed) {
    return (
      <PageShell className="flex flex-col gap-6">
        <PageHeader title="Comisiones" subtitle={ADMIN_SUBTITLE} />
        <EmptyState
          title="Sin acceso a comisiones"
          description="Tu rol no tiene permiso para ver comisiones. Pide el acceso a la administración de la clínica."
        />
      </PageShell>
    )
  }
  if (profile.isPending) {
    return (
      <PageShell className="flex flex-col gap-6">
        <PageHeader title={title} subtitle={subtitle} />
        <LoadingState />
      </PageShell>
    )
  }
  if (profile.isError) {
    return (
      <PageShell className="flex flex-col gap-6">
        <PageHeader title={title} subtitle={subtitle} />
        <QueryErrorState error={profile.error} onRetry={() => void profile.refetch()} />
      </PageShell>
    )
  }
  const region = profile.data.data
  if (!region) {
    return (
      <PageShell className="flex flex-col gap-6">
        <PageHeader title={title} subtitle={subtitle} />
        <EmptyState
          icon={Settings}
          title="Falta configurar la clínica"
          description="Las comisiones se calculan con la moneda y la zona horaria de la clínica. Aún no están configuradas."
          actionLabel={canSettings ? "Ir a Configuración" : undefined}
          onAction={() => void goTo({ to: "/settings" })}
        />
      </PageShell>
    )
  }

  const currentMonth = currentMonthIn(region.timezone)
  const period: YearMonth =
    search.year !== undefined && search.month !== undefined
      ? { year: search.year, month: search.month }
      : currentMonth
  // El mes en curso no se escribe en el enlace: «Comisiones» siempre abre hoy.
  const setPeriod = (next: YearMonth): void => {
    const isCurrent = compareMonths(next, currentMonth) === 0
    void navigate({
      search: (previous) => ({
        ...previous,
        year: isCurrent ? undefined : next.year,
        month: isCurrent ? undefined : next.month,
      }),
    })
  }

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title={title}
        subtitle={
          <>
            {subtitle ? <p className="min-w-0">{subtitle}</p> : null}
            <MonthPicker
              value={period}
              onChange={setPeriod}
              max={currentMonth}
              locale={region.locale}
            />
          </>
        }
      />
      {canWrite ? (
        <CommissionsAdminPanel
          period={period}
          locale={region.locale}
          timeZone={region.timezone}
          selectedId={search.profesional ?? null}
          onSelect={(professionalUserId) =>
            void navigate({
              search: (previous) => ({ ...previous, profesional: professionalUserId ?? undefined }),
            })
          }
        />
      ) : (
        <MyCommissionsPanel
          period={period}
          currentMonth={currentMonth}
          locale={region.locale}
          timeZone={region.timezone}
          onMonthChange={setPeriod}
        />
      )}
    </PageShell>
  )
}
