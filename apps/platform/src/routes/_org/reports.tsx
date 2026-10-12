/**
 * Reportes: cómo va la clínica, para quien la dirige. Un periodo y una sede
 * valen para toda la pantalla; arriba, una cifra por pregunta; abajo, el
 * detalle de la que se elige. Todo viaja en la dirección (`?tab`, `?period`,
 * `?branch`, `?lista`): se puede compartir el enlace y volver a él.
 */
import { formatMoney } from "@odentia/clinical"
import { cn, Skeleton } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Bot, Settings } from "lucide-react"
import { type ReactNode, useState } from "react"
import { RecommendationDrawer } from "../../components/agent/advisor"
import { adviceFor, AdviceNote, useReportAdvice } from "../../components/reports/advice-note"
import { AgendaTab } from "../../components/reports/agenda-tab"
import { MoneyTab } from "../../components/reports/money-tab"
import { ReportListDrawer } from "../../components/reports/report-list-drawer"
import { type Better, ChangeLine, unlessEmpty } from "../../components/reports/report-parts"
import { ReportPeriodPicker } from "../../components/reports/report-period"
import { SalesTab } from "../../components/reports/sales-tab"
import { ServiceTab } from "../../components/reports/service-tab"
import { ChoiceSelect } from "../../components/ui/choice-select"
import { currentMonthIn } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import { useBranchesOptions, useOrgFinanceProfile } from "../../lib/finance-collect"
import { QueryErrorState } from "../../lib/query-error"
import {
  absoluteChange,
  type Comparison,
  comparedWith,
  durationLabel,
  fetchReport,
  isReportList,
  isReportPeriod,
  MINUTES,
  periodLabel,
  previousPhrase,
  relativeChange,
  reportKey,
  type ReportListKey,
  type ReportOverview,
  type ReportAdviceTab,
  type ReportQuery,
} from "../../lib/reports"

const TABS = ["dinero", "agenda", "ventas", "atencion"] as const
type ReportTab = (typeof TABS)[number]

const TAB_COPY: Record<ReportTab, { title: string; question: string }> = {
  dinero: { title: "Dinero", question: "Cuánto entró, cuánto se gastó y cuánto falta cobrar" },
  agenda: { title: "Agenda", question: "Si los pacientes vinieron y quién los atendió" },
  ventas: { title: "Pacientes y ventas", question: "El trabajo nuevo que entró y el que se hizo" },
  atencion: { title: "Atención", question: "Cómo respondimos a quien escribió" },
}

/** Sin periodo en la dirección se mira el mes en curso, comparado con los mismos días del anterior. */
const DEFAULT_PERIOD = "este_mes"

interface ReportsSearch {
  tab?: ReportTab
  period?: string
  /** Sede; sin ella, todas. */
  branch?: string
  /** Lista abierta al lado. */
  lista?: ReportListKey
}

export const Route = createFileRoute("/_org/reports")({
  // Un valor mal escrito en el enlace no rompe la pantalla: se usa el de siempre.
  validateSearch: (search: Record<string, unknown>): ReportsSearch => ({
    ...((TABS as readonly unknown[]).includes(search.tab) ? { tab: search.tab as ReportTab } : {}),
    ...(isReportPeriod(search.period) && search.period !== DEFAULT_PERIOD ? { period: search.period } : {}),
    ...(typeof search.branch === "string" && search.branch ? { branch: search.branch } : {}),
    ...(isReportList(search.lista) ? { lista: search.lista } : {}),
  }),
  component: ReportsPage,
})

function ReportsPage() {
  const allowed = usePermission("reports.read")
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const profile = useOrgFinanceProfile()
  const branches = useBranchesOptions()
  const region = profile.data?.data ?? null

  const tab = search.tab ?? "dinero"
  const period = search.period ?? DEFAULT_PERIOD
  const query: ReportQuery = { period, branchId: search.branch }
  const overview = useQuery({
    queryKey: reportKey("overview", query),
    queryFn: () => fetchReport<ReportOverview>("overview", query),
    enabled: allowed && region !== null,
    retry: false,
  })

  // Los avisos del asesor acompañan a su cifra; la recomendación se abre al lado con su lista y su acción.
  const advice = useReportAdvice(query, allowed && region !== null)
  const notices = advice.data?.data.notices
  const [recommendation, setRecommendation] = useState<string | null>(null)
  const adviceNote = (item: ReportAdviceTab): ReactNode => {
    const found = adviceFor(notices, item)
    return found ? <AdviceNote advice={found} onOpen={setRecommendation} /> : undefined
  }

  const setSearch = (patch: Partial<ReportsSearch>): void => void navigate({ search: (prev) => ({ ...prev, ...patch }) })
  const openList = (lista: ReportListKey): void => setSearch({ lista })
  const showCurrentMonth = (): void => setSearch({ period: undefined })

  if (!allowed) {
    return (
      <PageShell>
        <PageHeader title="Reportes" />
        <ErrorState title="Sin acceso" message="Los reportes los ve quien dirige la clínica. Pide acceso a la administración." />
      </PageShell>
    )
  }

  const head = overview.data?.data
  const locale = head?.locale ?? region?.locale ?? "es"
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
              label={head ? periodLabel(head.period, locale) : "Periodo"}
              currentMonth={currentMonthIn(region.timezone)}
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
            {head ? <span className="text-sm text-muted-foreground">Comparado con {comparedWith(head, locale)}</span> : null}
          </div>

          {overview.isError ? (
            <QueryErrorState error={overview.error} onRetry={() => void overview.refetch()} notFound="La sede elegida ya no está disponible. Elige otra sede." />
          ) : (
            <>
              <nav aria-label="Preguntas" className="grid min-w-0 grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
                {TABS.map((item) => (
                  <QuestionTile key={item} tab={item} selected={item === tab} {...tileOf(item, head)} loading={overview.isPending} advised={item !== "atencion" && adviceFor(notices, item) !== null} />
                ))}
              </nav>

              <div>
                <h2 className="text-lg font-bold tracking-tight">{TAB_COPY[tab].title}</h2>
                <p className="text-sm text-muted-foreground">{TAB_COPY[tab].question}</p>
              </div>

              {tab === "dinero" ? (
                <MoneyTab query={query} onShowCurrentMonth={showCurrentMonth} advice={adviceNote("dinero")} />
              ) : tab === "agenda" ? (
                <AgendaTab query={query} onOpenList={openList} advice={adviceNote("agenda")} />
              ) : tab === "ventas" ? (
                <SalesTab query={query} onOpenList={openList} advice={adviceNote("ventas")} />
              ) : (
                <ServiceTab query={query} />
              )}
            </>
          )}
        </>
      )}
      <ReportListDrawer list={search.lista ?? null} query={query} onClose={() => setSearch({ lista: undefined })} />
      <RecommendationDrawer recommendationKey={recommendation} onClose={() => setRecommendation(null)} />
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

interface TileContent {
  caption: string
  value: ReactNode
  /** `undefined`: nada que comparar todavía (sin datos o cargando). */
  change?: Comparison | null
  better: Better
}

/** La cifra que resume cada pregunta; su detalle no la repite. */
function tileOf(tab: ReportTab, head: ReportOverview | undefined): TileContent {
  if (!head) return { caption: TILE_CAPTION[tab], value: null, better: "none" }
  const locale = head.locale
  const phrase = previousPhrase(head, locale)
  if (tab === "dinero") {
    // La moneda de la clínica primero; con más de una, la cifra dice de cuál es.
    const row = head.money.find((item) => item.currency === head.currency) ?? head.money[0]
    if (!row) return { caption: TILE_CAPTION.dinero, value: "Sin movimientos", better: "up" }
    return {
      caption: head.money.length > 1 ? `Queda · ${row.currency}` : TILE_CAPTION.dinero,
      value: formatMoney(row.quedaCents, row.currency, locale),
      change: unlessEmpty(row.quedaCents, relativeChange(row.quedaCents, row.previousQuedaCents, phrase, locale)),
      better: "up",
    }
  }
  if (tab === "agenda")
    return {
      caption: TILE_CAPTION.agenda,
      value: head.agenda.attended,
      change: unlessEmpty(head.agenda.attended, relativeChange(head.agenda.attended, head.agenda.previousAttended, phrase, locale)),
      better: "up",
    }
  if (tab === "ventas")
    return {
      caption: TILE_CAPTION.ventas,
      value: head.sales.newPatients,
      change: head.sales.newPatients === 0 && head.sales.previousNewPatients === 0 ? undefined : absoluteChange(head.sales.newPatients, head.sales.previousNewPatients, phrase, locale),
      better: "up",
    }
  const seconds = head.service.avgFirstResponseSeconds
  const before = head.service.previousAvgFirstResponseSeconds
  if (seconds === null) return { caption: TILE_CAPTION.atencion, value: "Sin datos", better: "down" }
  return {
    caption: TILE_CAPTION.atencion,
    value: durationLabel(seconds),
    change: before === null ? null : absoluteChange(Math.round(seconds / 60), Math.round(before / 60), phrase, locale, MINUTES),
    better: "down",
  }
}

const TILE_CAPTION: Record<ReportTab, string> = {
  dinero: "Queda",
  agenda: "Citas atendidas",
  ventas: "Pacientes nuevos",
  atencion: "Primera respuesta",
}

function QuestionTile({ tab, selected, caption, value, change, better, loading, advised }: TileContent & { tab: ReportTab; selected: boolean; loading: boolean; advised: boolean }) {
  return (
    <Link
      to="/reports"
      search={(prev) => ({ ...prev, tab: tab === "dinero" ? undefined : tab, lista: undefined })}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "elevated flex min-h-[104px] min-w-0 flex-col gap-0.5 rounded-xl bg-card px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4 sm:py-3.5",
        selected ? "border-2 border-primary" : "border-2 border-transparent ring-1 ring-border",
      )}
    >
      <span className={cn("text-sm font-bold", selected ? "text-primary-soft-foreground" : "")}>{TAB_COPY[tab].title}</span>
      <span className="text-xs text-muted-foreground">{caption}</span>
      {loading ? (
        <Skeleton className="mt-1 h-7 w-24" />
      ) : (
        <span className="truncate text-xl leading-7 font-bold tracking-tight tabular-nums sm:text-2xl sm:leading-[30px]">{value}</span>
      )}
      {!loading && change !== undefined ? <ChangeLine change={change} better={better} /> : null}
      {advised ? (
        <span className="mt-0.5 inline-flex items-center gap-1.5 text-[13px] font-bold text-primary-soft-foreground">
          <Bot aria-hidden className="size-3.5 shrink-0" />1 aviso del asesor
        </span>
      ) : null}
    </Link>
  )
}
