import { isClinicalProduct } from "@odentia/clinical"
import {
  FieldLabel,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import {
  AgentMark,
  AgentSurface,
  BarList,
  type ChartCategory,
  ColumnChart,
  EmptyState,
  ErrorState,
  KpiCard,
  PageHeader,
  PageShell,
  SkeletonRegion,
  ViewTabs,
} from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"
import { z } from "zod"
import { HowCalculated } from "../../components/arm/how-calculated"
import { ClientName } from "../../components/arm/hoy-links"
import {
  DEFAULT_REPORT_MONTHS,
  REPORT_MONTHS,
  type ReportMonths,
  reportsSearchOf,
} from "../../components/arm/hoy-search"
import { ProductMark } from "../../components/product"
import {
  FUNNEL_KPIS,
  REPORTS_SUBTITLE,
  REPORTS_TITLE,
  ReportsBodySkeleton,
  ReportsPageSkeleton,
} from "../../components/skeletons/reports"
import { api } from "../../lib/api"
import { money } from "../../lib/cost-format"
import { limaDayWords } from "../../lib/invitation-words"
import { requireAdminRole } from "../../lib/session"

export const Route = createFileRoute("/_app/reports")({
  // Reportes llevan importes: solo Administración (la API también se lo niega a Soporte).
  beforeLoad: requireAdminRole,
  validateSearch: reportsSearchOf,
  pendingComponent: ReportsPageSkeleton,
  component: ReportsPage,
})

/**
 * Reportes del ARM (`/api/admin/reports`): el embudo de la venta, los
 * ingresos y la previsión, y el resumen de la semana que escribió Kairós.
 * Cada cifra y sus palabras vienen del servidor, con «Así se calcula»; con
 * pocos casos dice «3 de 7» en lugar de un porcentaje. Las cifras las pone el
 * cálculo: Kairós solo las cuenta en palabras.
 */

const figure = z.object({ value: z.number(), words: z.string(), howCalculated: z.string() })
const maybeFigure = z.object({
  value: z.number().nullable(),
  words: z.string(),
  howCalculated: z.string(),
})
const ratio = z.object({
  n: z.number(),
  m: z.number(),
  pct: z.number().nullable(),
  words: z.string(),
  howCalculated: z.string(),
})
const moneyFigure = z.object({
  amounts: z.array(z.object({ currency: z.string(), cents: z.number() })),
  words: z.string(),
  howCalculated: z.string(),
})
const counts = z.record(z.string(), z.number())
const group = z.object({
  key: z.string(),
  label: z.string(),
  clients: z.number(),
  outcomes: counts,
  conversion: ratio,
})

const funnelSchema = z.object({
  months: z.number(),
  spanWords: z.string(),
  clients: figure,
  conversion: ratio,
  stages: z.array(
    z.object({
      stage: z.string(),
      label: z.string(),
      reached: figure,
      fromPrevious: ratio.nullable(),
      medianDays: maybeFigure.extend({ cases: z.number() }).nullable(),
    }),
  ),
  outcomes: z.record(z.string(), figure.extend({ label: z.string() })),
  cohorts: z.array(
    z.object({
      month: z.string(),
      label: z.string(),
      clients: z.number(),
      outcomes: counts,
      conversion: ratio,
    }),
  ),
  cohortsHowCalculated: z.string(),
  byOrigin: z.array(group),
  byProduct: z.array(group),
  byOwner: z.array(group),
  groupsHowCalculated: z.string(),
  lostReasons: z.array(z.object({ reason: z.string(), label: z.string(), count: z.number() })),
  lost: figure,
})
type Funnel = z.infer<typeof funnelSchema>

const revenueSchema = z.object({
  month: z.string(),
  monthLabel: z.string(),
  paying: figure,
  monthlyFee: moneyFigure,
  withDiscount: figure,
  collected: moneyFigure.extend({ payments: z.number() }),
  movements: z.array(
    z.object({ month: z.string(), label: z.string(), starts: z.number(), stops: z.number() }),
  ),
  movementsHowCalculated: z.string(),
  starts: figure,
  stops: figure,
  costMargin: z.object({
    clinics: z.number(),
    toReview: z.number(),
    charged: moneyFigure,
    cost: figure,
    margin: maybeFigure,
    marginAfterCommission: maybeFigure,
  }),
})
type Revenue = z.infer<typeof revenueSchema>

const forecastSchema = z.object({
  today: z.string(),
  proposals: figure,
  total: moneyFigure,
  rows: z.array(
    z.object({
      proposalId: z.string(),
      clientId: z.string(),
      clientName: z.string(),
      product: z.string(),
      version: z.number(),
      planName: z.string(),
      currency: z.string(),
      monthlyCents: z.number(),
      discountBps: z.number(),
      discountMonths: z.number().nullable(),
      validUntil: z.string(),
      daysLeft: z.number(),
      sentAt: z.string().nullable(),
    }),
  ),
})
type Forecast = z.infer<typeof forecastSchema>

const weeklySchema = z
  .object({
    weekStart: z.string(),
    text: z.string(),
    figures: z.array(z.object({ label: z.string(), words: z.string() })),
  })
  .nullable()

const count = (value: number) => new Intl.NumberFormat("es-PE").format(value)
const monthsWords = (months: number) =>
  months === 1 ? "el último mes" : `los últimos ${months} meses`

function ReportsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const tab = search.pestana ?? "embudo"
  const months: ReportMonths = search.meses ?? DEFAULT_REPORT_MONTHS
  const setSearch = (next: Partial<typeof search>) =>
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true })
  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title={REPORTS_TITLE} subtitle={REPORTS_SUBTITLE} />
      <div className="flex flex-wrap items-end gap-3">
        <ViewTabs
          label="Qué reporte ver"
          value={tab}
          options={[
            { value: "embudo", label: "Embudo" },
            { value: "ingresos", label: "Ingresos" },
            { value: "prevision", label: "Previsión" },
          ]}
          onValueChange={(next) => setSearch({ pestana: next === "embudo" ? undefined : next })}
        />
        {tab !== "prevision" ? (
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor="reportes-meses">
              {tab === "embudo" ? "Primer contacto en" : "Meses"}
            </FieldLabel>
            <Select
              value={String(months)}
              items={Object.fromEntries(
                REPORT_MONTHS.map((value) => [String(value), monthsWords(value)]),
              )}
              onValueChange={(value) => {
                const next =
                  REPORT_MONTHS.find((option) => String(option) === value) ?? DEFAULT_REPORT_MONTHS
                setSearch({
                  meses:
                    next === DEFAULT_REPORT_MONTHS ? undefined : (next as Exclude<ReportMonths, 6>),
                })
              }}
            >
              <SelectTrigger id="reportes-meses" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPORT_MONTHS.map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    {monthsWords(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
      {tab === "embudo" ? (
        <FunnelTab months={months} />
      ) : tab === "ingresos" ? (
        <RevenueTab months={months} />
      ) : (
        <ForecastTab />
      )}
      <WeeklySummary />
    </PageShell>
  )
}

/** Una cifra de arriba con su «Así se calcula». */
function Kpi({
  title,
  value,
  description,
  how,
}: {
  title: string
  value: string
  description?: string
  how: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <KpiCard title={title} value={value} {...(description ? { description } : {})} />
      <HowCalculated text={how} what={title} className="self-start" />
    </div>
  )
}

/** Una tarjeta del reporte: su título, su línea, su «Así se calcula» y lo de adentro. */
function ReportCard({
  id,
  title,
  lead,
  how,
  children,
}: {
  id: string
  title: string
  lead?: string
  how?: string
  children: ReactNode
}) {
  return (
    <section
      aria-labelledby={id}
      className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {lead ? <p className="text-sm text-muted-foreground">{lead}</p> : null}
        </div>
        {how ? <HowCalculated text={how} what={title} /> : null}
      </div>
      {children}
    </section>
  )
}

function useReport<T>(path: string, key: readonly unknown[], schema: z.ZodType<T>) {
  return useQuery({
    queryKey: ["admin", "reports", ...key],
    queryFn: async () => schema.parse(await api<unknown>(path)),
    placeholderData: keepPreviousData,
  })
}

/* ---------- Embudo ---------- */

function FunnelTab({ months }: { months: number }) {
  const funnel = useReport(
    `/api/admin/reports/funnel?months=${months}`,
    ["funnel", months],
    funnelSchema,
  )
  if (funnel.isPending)
    return (
      <SkeletonRegion message="Calculando el embudo…">
        <ReportsBodySkeleton kpis={FUNNEL_KPIS} />
      </SkeletonRegion>
    )
  if (funnel.isError)
    return <ErrorState error={funnel.error} onRetry={() => void funnel.refetch()} />
  const data = funnel.data
  if (data.clients.value === 0)
    return (
      <EmptyState
        title="Sin clientes en esos meses"
        description={`Ninguna clínica tuvo su primer contacto en ${monthsWords(data.months)}. Prueba con más meses.`}
      />
    )
  const open = data.outcomes.abierta
  return (
    <div className="flex flex-col gap-6" aria-busy={funnel.isFetching || undefined}>
      <p className="text-sm text-muted-foreground">
        Clínicas con su primer contacto de {data.spanWords}. Sin demos ni archivadas.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          title="Clínicas"
          value={count(data.clients.value)}
          description={data.clients.words}
          how={data.clients.howCalculated}
        />
        <Kpi
          title="Entraron"
          value={data.conversion.words}
          description={`${count(data.conversion.n)} de ${count(data.conversion.m)}`}
          how={data.conversion.howCalculated}
        />
        {open ? (
          <Kpi
            title="Siguen abiertas"
            value={count(open.value)}
            description={open.words}
            how={open.howCalculated}
          />
        ) : null}
        <Kpi
          title="Perdidas"
          value={count(data.lost.value)}
          description={data.lost.words}
          how={data.lost.howCalculated}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ReportCard
          id="embudo-pasan"
          title="Cuántas pasan a la siguiente"
          lead={`${data.clients.words} con primer contacto de ${data.spanWords}`}
          how={[
            ...new Set(
              data.stages.map(
                (stage) => stage.fromPrevious?.howCalculated ?? stage.reached.howCalculated,
              ),
            ),
          ].join(" ")}
        >
          <BarList
            title="Cuántas llegan a cada etapa"
            size="sm"
            rows={data.stages.map((stage) => ({
              key: stage.stage,
              label: stage.label,
              value: stage.reached.value,
              valueText: stage.fromPrevious ? stage.fromPrevious.words : count(stage.reached.value),
              ...(stage.fromPrevious &&
              stage.fromPrevious.pct !== null &&
              !stage.fromPrevious.words.includes(" de ")
                ? { note: stage.reached.words }
                : {}),
            }))}
            table={{ label: "Etapa", value: "Llegaron", note: "Clínicas" }}
          />
        </ReportCard>
        <ReportCard
          id="embudo-tiempo"
          title="Tiempo típico en cada etapa"
          lead="La mediana de días, de las que ya pasaron al paso siguiente"
          how={data.stages.find((stage) => stage.medianDays)?.medianDays?.howCalculated}
        >
          <dl className="divide-y">
            {data.stages
              .filter((stage) => stage.medianDays)
              .map((stage) => (
                <div
                  key={stage.stage}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 py-2 text-sm"
                >
                  <dt>{stage.label}</dt>
                  <dd className="font-medium tabular-nums">{stage.medianDays?.words}</dd>
                </div>
              ))}
          </dl>
        </ReportCard>
        <ReportCard
          id="embudo-motivos"
          title="Motivos de pérdida"
          lead={data.lost.words}
          how={data.lost.howCalculated}
        >
          {data.lostReasons.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Ninguna venta se cerró como «Perdido» en esos meses.
            </p>
          ) : (
            <BarList
              title="Motivos de pérdida"
              size="sm"
              rows={data.lostReasons.map((reason) => ({
                key: reason.reason,
                label: reason.label,
                value: reason.count,
                valueText: count(reason.count),
                muted: reason.reason === "otro",
              }))}
              table={{ label: "Motivo", value: "Ventas" }}
            />
          )}
        </ReportCard>
        <ReportCard
          id="embudo-meses"
          title="Por mes del primer contacto"
          how={data.cohortsHowCalculated}
        >
          <ColumnChart
            title="Clínicas por mes del primer contacto y cómo terminaron"
            tableHeading="Mes"
            stacked
            categories={data.cohorts.map(
              (cohort, index): ChartCategory => ({
                key: cohort.month,
                label: cohort.label,
                short: cohort.label.slice(0, 3),
                partial: index === data.cohorts.length - 1,
              }),
            )}
            bars={[
              {
                key: "entro",
                label: "Entraron",
                tone: "series-1",
                values: data.cohorts.map((c) => c.outcomes.entro ?? 0),
              },
              {
                key: "abierta",
                label: "Siguen abiertas",
                tone: "series-2",
                values: data.cohorts.map((c) => c.outcomes.abierta ?? 0),
              },
              {
                key: "sin",
                label: "No entraron",
                tone: "series-3",
                values: data.cohorts.map(
                  (c) => (c.outcomes.no_por_ahora ?? 0) + (c.outcomes.perdido ?? 0),
                ),
              },
            ]}
            format={(value) => count(value)}
            height={200}
          />
        </ReportCard>
      </div>
      <GroupsCard data={data} />
    </div>
  )
}

const GROUPS = [
  { value: "origen", label: "Por origen", heading: "Origen" },
  { value: "producto", label: "Por producto", heading: "Producto" },
  { value: "responsable", label: "Por responsable", heading: "Responsable" },
] as const

/** Resultados por origen, por producto o por responsable: las mismas clínicas, repartidas. */
function GroupsCard({ data }: { data: Funnel }) {
  const [by, setBy] = useState<(typeof GROUPS)[number]["value"]>("origen")
  const rows = by === "origen" ? data.byOrigin : by === "producto" ? data.byProduct : data.byOwner
  const heading = GROUPS.find((option) => option.value === by)?.heading ?? "Origen"
  const total = rows.reduce(
    (sum, row) => ({
      clients: sum.clients + row.clients,
      entro: sum.entro + (row.outcomes.entro ?? 0),
      abierta: sum.abierta + (row.outcomes.abierta ?? 0),
      sin: sum.sin + (row.outcomes.no_por_ahora ?? 0) + (row.outcomes.perdido ?? 0),
    }),
    { clients: 0, entro: 0, abierta: 0, sin: 0 },
  )
  return (
    <ReportCard
      id="embudo-grupos"
      title="Resultados"
      lead={`Las mismas ${count(data.clients.value)}`}
      how={data.groupsHowCalculated}
    >
      <ViewTabs
        label="Cómo repartir los resultados"
        value={by}
        options={GROUPS}
        onValueChange={setBy}
      />
      <ScrollArea horizontal className="min-w-0 max-w-full">
        <table className="w-full min-w-[32rem] text-sm">
          <caption className="sr-only">
            Resultados {GROUPS.find((option) => option.value === by)?.label.toLowerCase()}
          </caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                {heading}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Clínicas
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Entraron
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Abiertas
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Sin entrar
              </th>
              <th scope="col" className="py-2 pl-3 text-right font-medium">
                Entran
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.key}>
                <th
                  scope="row"
                  className="py-2 pr-3 text-left font-normal [overflow-wrap:anywhere]"
                >
                  {by === "producto" && isClinicalProduct(row.key) ? (
                    <ProductMark product={row.key} className="text-sm" />
                  ) : (
                    row.label
                  )}
                </th>
                <td className="px-3 py-2 text-right tabular-nums">{count(row.clients)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {count(row.outcomes.entro ?? 0)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {count(row.outcomes.abierta ?? 0)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {count((row.outcomes.no_por_ahora ?? 0) + (row.outcomes.perdido ?? 0))}
                </td>
                <td className="py-2 pl-3 text-right tabular-nums">{row.conversion.words}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t font-medium">
              <th scope="row" className="py-2 pr-3 text-left">
                Total
              </th>
              <td className="px-3 py-2 text-right tabular-nums">{count(total.clients)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{count(total.entro)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{count(total.abierta)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{count(total.sin)}</td>
              <td className="py-2 pl-3 text-right tabular-nums">{data.conversion.words}</td>
            </tr>
          </tfoot>
        </table>
      </ScrollArea>
    </ReportCard>
  )
}

/* ---------- Ingresos ---------- */

const REVENUE_KPIS = ["Pagan", "Cuota mensual", "Cobrado", "Margen"]

function RevenueTab({ months }: { months: number }) {
  const revenue = useReport(
    `/api/admin/reports/revenue?months=${months}`,
    ["revenue", months],
    revenueSchema,
  )
  if (revenue.isPending)
    return (
      <SkeletonRegion message="Calculando los ingresos…">
        <ReportsBodySkeleton kpis={REVENUE_KPIS} />
      </SkeletonRegion>
    )
  if (revenue.isError)
    return <ErrorState error={revenue.error} onRetry={() => void revenue.refetch()} />
  const data: Revenue = revenue.data
  const margin = data.costMargin
  return (
    <div className="flex flex-col gap-6" aria-busy={revenue.isFetching || undefined}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          title="Pagan"
          value={count(data.paying.value)}
          description={`${data.paying.words} · ${data.withDiscount.words}`}
          how={`${data.paying.howCalculated} ${data.withDiscount.howCalculated}`}
        />
        <Kpi
          title="Cuota mensual"
          value={data.monthlyFee.words}
          how={data.monthlyFee.howCalculated}
        />
        <Kpi
          title={`Cobrado en ${data.monthLabel}`}
          value={data.collected.words}
          description={
            data.collected.payments === 1
              ? "1 pago confirmado"
              : `${count(data.collected.payments)} pagos confirmados`
          }
          how={data.collected.howCalculated}
        />
        <Kpi
          title="Margen"
          value={margin.margin.words}
          description={`Después de comisiones: ${margin.marginAfterCommission.words}`}
          how={`${margin.margin.howCalculated} ${margin.marginAfterCommission.howCalculated}`}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ReportCard
          id="ingresos-altas"
          title="Altas y bajas por mes"
          lead={`${data.starts.words} y ${data.stops.words} en ${monthsWords(data.movements.length)}`}
          how={[
            data.movementsHowCalculated,
            data.starts.howCalculated,
            data.stops.howCalculated,
          ].join(" ")}
        >
          <ColumnChart
            title="Altas y bajas por mes"
            tableHeading="Mes"
            categories={data.movements.map(
              (row, index): ChartCategory => ({
                key: row.month,
                label: row.label,
                short: row.label.slice(0, 3),
                partial: index === data.movements.length - 1,
              }),
            )}
            bars={[
              {
                key: "altas",
                label: "Altas",
                tone: "series-1",
                values: data.movements.map((row) => row.starts),
              },
              {
                key: "bajas",
                label: "Bajas",
                tone: "series-3",
                values: data.movements.map((row) => row.stops),
              },
            ]}
            format={(value) => count(value)}
            height={200}
          />
        </ReportCard>
        <ReportCard
          id="ingresos-costo"
          title="Costo y margen"
          lead={`${count(margin.clinics)} ${margin.clinics === 1 ? "clínica" : "clínicas"} este mes`}
          how={margin.charged.howCalculated}
        >
          <dl className="divide-y text-sm">
            {/* Lo facturado del mes, no lo pagado: «Cobrado en <mes>» de arriba es lo que entró. */}
            <Pair
              label="Facturado"
              value={margin.charged.words}
              how={margin.charged.howCalculated}
            />
            <Pair label="Nos costó" value={margin.cost.words} how={margin.cost.howCalculated} />
            <Pair label="Margen" value={margin.margin.words} how={margin.margin.howCalculated} />
            <Pair
              label="Después de comisiones"
              value={margin.marginAfterCommission.words}
              how={margin.marginAfterCommission.howCalculated}
            />
          </dl>
          {margin.toReview > 0 ? (
            <p className="text-sm text-muted-foreground">
              {margin.toReview === 1
                ? "1 clínica para revisar"
                : `${count(margin.toReview)} clínicas para revisar`}{" "}
              en Cobros y planes: con la alarma de IA o Fundadoras sin uso.
            </p>
          ) : null}
        </ReportCard>
      </div>
    </div>
  )
}

function Pair({ label, value, how }: { label: string; value: string; how: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 py-1.5">
      <dt className="flex items-center gap-1">
        {label}
        <HowCalculated text={how} what={label} />
      </dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}

/* ---------- Previsión ---------- */

function ForecastTab() {
  const forecast = useReport("/api/admin/reports/forecast", ["forecast"], forecastSchema)
  if (forecast.isPending)
    return (
      <SkeletonRegion message="Calculando la previsión…">
        <ReportsBodySkeleton kpis={["Propuestas enviadas", "Cuota si entran"]} />
      </SkeletonRegion>
    )
  if (forecast.isError)
    return <ErrorState error={forecast.error} onRetry={() => void forecast.refetch()} />
  const data: Forecast = forecast.data
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          title="Propuestas enviadas"
          value={count(data.proposals.value)}
          description={data.proposals.words}
          how={data.proposals.howCalculated}
        />
        <Kpi title="Cuota si entran" value={data.total.words} how={data.total.howCalculated} />
      </div>
      <ReportCard
        id="prevision-propuestas"
        title="Propuestas vigentes"
        lead="La última versión enviada de cada cliente, de las que vencen hoy o después. Sin probabilidades."
      >
        {data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hay propuestas enviadas que sigan vigentes.
          </p>
        ) : (
          <ul className="divide-y">
            {data.rows.map((row) => (
              <li key={row.proposalId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="flex flex-wrap items-center gap-x-2">
                    <ClientName clientId={row.clientId} tab="venta">
                      {row.clientName}
                    </ClientName>
                    {isClinicalProduct(row.product) ? <ProductMark product={row.product} /> : null}
                  </p>
                  <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    {row.planName} · versión {row.version}
                    {row.discountBps > 0
                      ? ` · ${row.discountBps / 100} % menos en cada acción${row.discountMonths ? ` por ${row.discountMonths} ${row.discountMonths === 1 ? "mes" : "meses"}` : ""}`
                      : ""}
                  </p>
                </div>
                <div className="text-right text-sm">
                  <p className="font-medium tabular-nums">
                    {money(row.monthlyCents, row.currency)} al mes
                  </p>
                  <p
                    className={
                      row.daysLeft <= 3 ? "font-medium text-destructive" : "text-muted-foreground"
                    }
                  >
                    {row.daysLeft === 0 ? "Vence hoy" : `Vence el ${limaDayWords(row.validUntil)}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ReportCard>
    </div>
  )
}

/* ---------- La semana ---------- */

/** El resumen de la semana que escribió Kairós: sus palabras y las cifras que citó, tal como las dio el cálculo. */
function WeeklySummary() {
  const weekly = useReport("/api/admin/reports/weekly", ["weekly"], weeklySchema)
  return (
    <AgentSurface aria-labelledby="reportes-semana" className="flex flex-col gap-3">
      <h2 id="reportes-semana" className="flex items-center gap-2 text-base font-semibold">
        <AgentMark size="sm" />
        La semana, en palabras de Kairós
      </h2>
      {weekly.isPending ? (
        <p className="text-sm text-muted-foreground">Consultando el resumen…</p>
      ) : weekly.isError ? (
        <ErrorState error={weekly.error} onRetry={() => void weekly.refetch()} />
      ) : !weekly.data ? (
        <p className="text-sm text-muted-foreground">
          Kairós escribe el resumen los lunes por la mañana. Todavía no hay uno.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Semana del {limaDayWords(weekly.data.weekStart)}
          </p>
          <p className="whitespace-pre-line [overflow-wrap:anywhere]">{weekly.data.text}</p>
          {weekly.data.figures.length > 0 ? (
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {weekly.data.figures.map((item) => (
                <div key={item.label} className="flex flex-wrap justify-between gap-x-3">
                  <dt className="text-muted-foreground">{item.label}</dt>
                  <dd className="font-medium tabular-nums">{item.words}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Las cifras las pone el cálculo; Kairós solo las cuenta.
          </p>
        </>
      )}
    </AgentSurface>
  )
}
