/**
 * Reportes: cómo va la clínica, para quien la dirige. Un periodo y una sede
 * valen para toda la pantalla; el Resumen primero y una pestaña por pregunta
 * (Finanzas, Pacientes, Agenda, Agente; decisión 1). Todo viaja en la
 * dirección (`?tab`, `?period`, `?branch`, `?lista`): se puede compartir el
 * enlace y volver a él.
 */
import { cn } from "@odentia/ui"
import { ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Settings } from "lucide-react"
import { type ReactNode, useState } from "react"
import { AdminRecommendationDrawer } from "../../components/agent/admin-recommendation"
import { adviceFor, AdviceNote, useReportAdvice } from "../../components/reports/advice-note"
import { ArgosReportField } from "../../components/argos/argos-panel"
import { AgendaTab } from "../../components/reports/agenda-tab"
import { AgentTab } from "../../components/reports/agent-tab"
import { FinanceTab } from "../../components/reports/finance-tab"
import { PatientsTab } from "../../components/reports/patients-tab"
import { ReportListDrawer } from "../../components/reports/report-list-drawer"
import { ReportPeriodPicker } from "../../components/reports/report-period"
import { AdminWatch, SummaryTab } from "../../components/reports/summary-tab"
import { ChoiceSelect } from "../../components/ui/choice-select"
import { EmptyState } from "@odentia/ui-patterns"
import { currentMonthIn } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import { useBranchesOptions, useOrgFinanceProfile } from "../../lib/finance-collect"
import { QueryErrorState } from "../../lib/query-error"
import {
  comparedWith,
  fetchReport,
  isReportList,
  isReportPeriod,
  periodLabel,
  reportKey,
  type ReportAdviceTab,
  type ReportListKey,
  type ReportQuery,
  type ReportSummary,
} from "../../lib/reports"

const TABS = ["resumen", "finanzas", "pacientes", "agenda", "agente"] as const
type ReportTab = (typeof TABS)[number]

/** Los nombres de antes siguen abriendo su pestaña: hay enlaces y avisos guardados con ellos. */
const LEGACY_TABS: Record<string, ReportTab> = { dinero: "finanzas", ventas: "pacientes", atencion: "agente" }

const TAB_COPY: Record<ReportTab, { title: string; question: string }> = {
  resumen: { title: "Resumen", question: "Cómo va el negocio" },
  finanzas: { title: "Finanzas", question: "Cuánto entró, cuánto se gastó y cuánto falta cobrar" },
  pacientes: { title: "Pacientes", question: "Quiénes nos buscaron, hasta dónde llegaron y si vuelven" },
  agenda: { title: "Agenda", question: "Si los pacientes vinieron y quién los atendió" },
  agente: { title: "Agente", question: "Lo que hizo el agente, lo que pagaste por él y cómo respondimos a quien escribió" },
}

/** Los avisos del Administrador vienen marcados con la pregunta de antes. */
const ADVICE_TAB: Partial<Record<ReportTab, ReportAdviceTab>> = { finanzas: "dinero", agenda: "agenda", pacientes: "ventas" }

/** Sin periodo en la dirección se mira el mes en curso, comparado con los mismos días del anterior. */
const DEFAULT_PERIOD = "este_mes"

interface ReportsSearch {
  tab?: ReportTab
  period?: string
  /** Sede; sin ella, todas. */
  branch?: string
  /** Lista abierta al lado. */
  lista?: ReportListKey
  /** Una vista dentro de la pestaña: `promociones` en Finanzas (tablero 2b). */
  vista?: "promociones"
}

function tabOf(value: unknown): ReportTab | undefined {
  if (typeof value !== "string") return undefined
  const tab = LEGACY_TABS[value] ?? value
  return (TABS as readonly string[]).includes(tab) && tab !== "resumen" ? (tab as ReportTab) : undefined
}

/** Hoy en la clínica (`YYYY-MM-DD`): el último día que se puede elegir en un rango. */
function todayIn(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

export const Route = createFileRoute("/_org/reports")({
  // Un valor mal escrito en el enlace no rompe la pantalla: se usa el de siempre.
  validateSearch: (search: Record<string, unknown>): ReportsSearch => {
    const tab = tabOf(search.tab)
    return {
      ...(tab ? { tab } : {}),
      ...(isReportPeriod(search.period) && search.period !== DEFAULT_PERIOD ? { period: search.period } : {}),
      ...(typeof search.branch === "string" && search.branch ? { branch: search.branch } : {}),
      ...(isReportList(search.lista) ? { lista: search.lista } : {}),
      ...(search.vista === "promociones" ? { vista: "promociones" as const } : {}),
    }
  },
  component: ReportsPage,
})

function ReportsPage() {
  const allowed = usePermission("reports.read")
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const profile = useOrgFinanceProfile()
  const branches = useBranchesOptions()
  const region = profile.data?.data ?? null

  const tab = search.tab ?? "resumen"
  const period = search.period ?? DEFAULT_PERIOD
  const query: ReportQuery = { period, branchId: search.branch }
  // El Resumen trae el periodo resuelto: el botón y la comparación lo dicen igual en todas las pestañas.
  const head = useQuery({
    queryKey: reportKey("summary", query),
    queryFn: () => fetchReport<ReportSummary>("summary", query),
    enabled: allowed && region !== null,
    retry: false,
  })

  // Los avisos del Administrador acompañan a su cifra; la recomendación se abre al lado con su lista y su acción.
  const advice = useReportAdvice(query, allowed && region !== null)
  const notices = advice.data?.data.notices
  const [recommendation, setRecommendation] = useState<string | null>(null)
  const adviceNote = (item: ReportTab): ReactNode => {
    const key = ADVICE_TAB[item]
    const found = key ? adviceFor(notices, key) : null
    return found ? <AdviceNote advice={found} onOpen={setRecommendation} /> : undefined
  }

  const argosEnabled = advice.data?.data.enabled

  const setSearch = (patch: Partial<ReportsSearch>): void => void navigate({ search: (prev) => ({ ...prev, ...patch }) })
  // Una respuesta de Argos puede ser de otro periodo o sede («¿Y en agosto?»): su lista se abre con los suyos.
  const openList = (lista: ReportListKey, at?: ReportQuery): void =>
    setSearch({ lista, ...(at ? { period: at.period === DEFAULT_PERIOD ? undefined : at.period, branch: at.branchId } : {}) })
  const showCurrentMonth = (): void => setSearch({ period: undefined })

  if (!allowed) {
    return (
      <PageShell>
        <PageHeader title="Reportes" />
        <ErrorState title="Sin acceso" message="Los reportes los ve quien dirige la clínica. Pide acceso a la administración." />
      </PageShell>
    )
  }

  const data = head.data?.data
  const locale = data?.locale ?? region?.locale ?? "es"
  const branchList = branches.data?.data ?? []

  return (
    <PageShell className="flex flex-col gap-4">
      <PageHeader title="Reportes" />
      {profile.isPending ? (
        <LoadingState />
      ) : profile.isError ? (
        <QueryErrorState error={profile.error} onRetry={() => void profile.refetch()} />
      ) : !region ? (
        <ConfigureClinic />
      ) : (
        <>
          {/* Periodo y sede juntos, bajo el título: valen para toda la pantalla. */}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ReportPeriodPicker
              value={period}
              label={data ? periodLabel(data.period, locale) : "Periodo"}
              currentMonth={currentMonthIn(region.timezone)}
              today={todayIn(region.timezone)}
              locale={locale}
              onChange={(next) => setSearch({ period: next === DEFAULT_PERIOD ? undefined : next, lista: undefined })}
            />
            {branchList.length > 1 ? (
              <ChoiceSelect
                aria-label="Sede"
                className="w-48"
                value={search.branch ?? ""}
                onChange={(event) => setSearch({ branch: event.target.value || undefined, lista: undefined })}
              >
                <option value="">Todas las sedes</option>
                {branchList.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </ChoiceSelect>
            ) : null}
            {data ? <span className="text-sm text-muted-foreground">Comparado con {comparedWith(data, locale)}</span> : null}
            {/* Pregunta con el periodo y la sede de arriba (D7); la respuesta se abre en el panel de Argos. */}
            <ArgosReportField query={query} enabled={argosEnabled} />
          </div>

          {head.isError ? (
            <QueryErrorState error={head.error} onRetry={() => void head.refetch()} notFound="La sede elegida ya no está disponible. Elige otra sede." />
          ) : (
            <>
              <nav aria-label="Secciones de Reportes" className="flex min-w-0 gap-1 overflow-x-auto overflow-y-hidden border-b [scrollbar-width:none]">
                {TABS.map((item) => (
                  <Link
                    key={item}
                    to="/reports"
                    search={(prev) => ({ ...prev, tab: item === "resumen" ? undefined : item, lista: undefined, vista: undefined })}
                    aria-current={item === tab ? "page" : undefined}
                    className={cn(
                      "-mb-px inline-flex min-h-11 shrink-0 items-center border-b-[2.5px] px-3.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      item === tab ? "border-primary font-extrabold text-primary-soft-foreground" : "border-transparent font-semibold text-foreground/80 hover:text-foreground",
                    )}
                  >
                    {TAB_COPY[item].title}
                  </Link>
                ))}
              </nav>

              {tab !== "resumen" ? (
                <div>
                  <h2 className="text-lg font-bold tracking-tight">{TAB_COPY[tab].title}</h2>
                  <p className="text-sm text-muted-foreground">{TAB_COPY[tab].question}</p>
                </div>
              ) : null}

              {/* Las cifras siguen al ancho de la pestaña, no al de la ventana: con Argos o una lista al lado, caben menos. */}
              <div className="@container min-w-0">
              {tab === "resumen" ? (
                <SummaryTab
                  query={query}
                  onOpenList={openList}
                  argosEnabled={argosEnabled}
                  advice={
                    <AdminWatch enabled={advice.data?.data.enabled}>
                      {notices && notices.length > 0 ? (
                        <div className="flex min-w-0 flex-col gap-2.5">
                          {notices.map((notice) => (
                            <AdviceNote key={notice.key} advice={notice} onOpen={setRecommendation} />
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">{advice.isPending ? "Revisando…" : "Nada que atender en estas cifras."}</p>
                      )}
                    </AdminWatch>
                  }
                />
              ) : tab === "finanzas" ? (
                <FinanceTab
                  query={query}
                  view={search.vista}
                  onView={(vista) => setSearch({ vista })}
                  onOpenList={openList}
                  onShowCurrentMonth={showCurrentMonth}
                  advice={adviceNote("finanzas")}
                />
              ) : tab === "agenda" ? (
                <AgendaTab query={query} onOpenList={openList} advice={adviceNote("agenda")} />
              ) : tab === "pacientes" ? (
                <PatientsTab query={query} onOpenList={openList} advice={adviceNote("pacientes")} />
              ) : (
                <AgentTab query={query} onOpenList={openList} />
              )}
              </div>
            </>
          )}
        </>
      )}
      <ReportListDrawer list={search.lista ?? null} query={query} onClose={() => setSearch({ lista: undefined })} />
      <AdminRecommendationDrawer recommendationKey={recommendation} onClose={() => setRecommendation(null)} />
    </PageShell>
  )
}

function ConfigureClinic() {
  const navigate = useNavigate()
  const canSettings = usePermission("settings.write")
  return (
    <EmptyState
      icon={Settings}
      title="Falta configurar la clínica"
      description="Los reportes se calculan con la moneda y la zona horaria de la clínica. Aún no están configuradas."
      actionLabel={canSettings ? "Ir a Configuración" : undefined}
      onAction={() => void navigate({ to: "/settings" })}
    />
  )
}
