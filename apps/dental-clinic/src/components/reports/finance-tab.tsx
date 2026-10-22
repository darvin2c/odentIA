/**
 * Reportes › Finanzas (tablero 2): de lo cobrado a lo que deja el periodo, las
 * comisiones de cada profesional, lo que te deben y lo que debes, lo que viene
 * y de dónde vino lo cobrado. La comisión cuenta al cobrar, en su propia línea
 * (decisión 13); «En caja quedó» la descuenta cuando se paga. Cada cifra lleva
 * a su lugar de Finanzas, donde se opera (decisión 14). Todo en la moneda de la
 * clínica: otra moneda se dice aparte, nunca se suma.
 */
import { formatMoney } from "@odentia/clinical"
import { Button, cn, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, toast } from "@odentia/ui"
import { ColumnChart, EmptyState, LoadingState, ShareBar, WaterfallChart, type WaterfallStep } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { AlertTriangle, ArrowDown, Bot } from "lucide-react"
import { type ReactNode, useId, useMemo, useState } from "react"
import { plainAmount } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import { cashErrorMessage, dismissExpenseGapApi, type ExpenseCategory } from "../../lib/finance-cash"
import { QueryErrorState } from "../../lib/query-error"
import {
  bucketLabel,
  bucketShort,
  type Comparison,
  dayText,
  fetchReport,
  GRAIN_WORD,
  previousPhrase,
  rateOf,
  relativeChange,
  reportKey,
  type ReportCommissions,
  type ReportFinance,
  type ReportListKey,
  type ReportOutlook,
  type ReportQuery,
  spanLabel,
} from "../../lib/reports"
import { amountFromCents } from "../../lib/workspace"
import { ExpenseFormDrawer, type ExpenseDraft, type ExpensePlace } from "../finance/expense-form-drawer"
import { PromotionsCard, PromotionsView } from "./promotions-view"
import { BarRows, type Better, ChangeLine, DownloadButton, EmptyLine, ReportCard, WHOLE_CLINIC } from "./report-parts"
import { downloadReportTable } from "../../lib/reports-ask"
import { ADMIN_NAME } from "../../lib/agent-names"

type Money = (cents: number) => string

/** Lo que se aparta de la clínica más de estos puntos lleva su marca. */
const APART_POINTS = 5

function compactMoney(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(amountFromCents(String(cents), currency))
}

/** El importe sin decimales sobre una barra: «48 200». */
function roundMoney(cents: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(amountFromCents(String(cents), currency))
}

/** Una diferencia de dinero dicha con palabras: «S/ 620 más que en agosto». */
function moneyChange(current: number, previous: number, money: Money, phrase: string): Comparison {
  const difference = current - previous
  if (difference === 0) return { text: `Igual ${phrase}`, direction: "same" }
  return { text: `${money(Math.abs(difference))} ${difference > 0 ? "más" : "menos"} ${phrase}`, direction: difference > 0 ? "up" : "down" }
}

function percentOf(part: number, total: number): string {
  const value = rateOf(part, total)
  return value === null ? "—" : `${value} %`
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

export type FinanceView = "promociones"

export function FinanceTab({
  query,
  view,
  onView,
  onOpenList,
  onShowCurrentMonth,
  advice,
}: {
  query: ReportQuery
  view?: FinanceView
  onView: (view: FinanceView | undefined) => void
  onOpenList: (list: ReportListKey) => void
  onShowCurrentMonth: () => void
  advice?: ReactNode
}) {
  if (view === "promociones") return <PromotionsView query={query} onBack={() => onView(undefined)} />
  return <FinanceMain query={query} onView={onView} onOpenList={onOpenList} onShowCurrentMonth={onShowCurrentMonth} advice={advice} />
}

function FinanceMain({
  query,
  onView,
  onOpenList,
  onShowCurrentMonth,
  advice,
}: {
  query: ReportQuery
  onView: (view: FinanceView | undefined) => void
  onOpenList: (list: ReportListKey) => void
  onShowCurrentMonth: () => void
  advice?: ReactNode
}) {
  const navigate = useNavigate()
  const canFinance = usePermission("finance.read")
  const report = useQuery({ queryKey: reportKey("finance", query), queryFn: () => fetchReport<ReportFinance>("finance", query), retry: false })
  if (report.isPending) return <LoadingState />
  if (report.isError)
    return <QueryErrorState error={report.error} onRetry={() => void report.refetch()} notFound="La sede elegida ya no está disponible. Elige otra sede." />
  const data = report.data.data
  const { current } = data.totals
  // Lo que se debe (comisiones, compras sin pagar) también es movimiento: sin cobros, igual hay que verlo.
  const nothing =
    current.cobradoCents === 0 &&
    current.otherExpensesCents === 0 &&
    data.debts.current.totalCents === 0 &&
    data.payables.commissions.cents === 0 &&
    data.payables.purchases.cents === 0 &&
    data.trend.every((month) => month.cobradoCents === 0)
  if (nothing)
    return (
      <EmptyState
        title={`Sin movimientos en ${spanLabel(data.period, data.locale)}`}
        description="Cuando la clínica cobre y registre sus gastos, aquí verás cuánto deja cada mes y en qué se va lo cobrado."
        actionLabel={query.period !== "este_mes" ? "Ver este mes" : canFinance ? "Ir a Finanzas" : undefined}
        onAction={query.period !== "este_mes" ? onShowCurrentMonth : () => void navigate({ to: "/finance" })}
      />
    )
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FinanceCards data={data} />
      {data.otherCurrencies.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Además se cobró {data.otherCurrencies.map((item) => formatMoney(item.cobradoCents, item.currency, data.locale)).join(" y ")}: otra moneda no se suma a estas cifras.
        </p>
      ) : null}
      <Cascade data={data} />
      <MonthlyChart data={data} />
      <CommissionsSection query={query} data={data} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <DebtsCard data={data} onOpenList={onOpenList} advice={advice} />
        <PayablesCard data={data} />
      </div>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <OutlookCard query={query} onOpenList={onOpenList} />
        <TreatmentsCard data={data} />
        <MethodsCard data={data} />
        <PromotionsCard query={query} onOpen={() => onView("promociones")} />
      </div>
    </div>
  )
}

// --- Las cuatro cifras ------------------------------------------------------------------

function FinanceCard({
  title,
  value,
  change,
  better = "none",
  detail,
  tone = "plain",
  children,
}: {
  title: string
  value: string
  change?: Comparison | null
  better?: Better
  detail?: ReactNode
  tone?: "plain" | "highlight"
  children?: ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-xl px-[18px] py-4",
        tone === "highlight" ? "border-[1.5px] border-primary bg-primary-soft" : "elevated border bg-card",
      )}
    >
      <h3 id={id} className={cn("text-[13px] font-bold", tone === "highlight" ? "text-primary-soft-foreground" : "text-muted-foreground")}>
        {title}
      </h3>
      <span className="min-w-0 truncate text-[28px] leading-9 font-extrabold tracking-tight tabular-nums">{value}</span>
      {change !== undefined ? <ChangeLine change={change} better={better} /> : null}
      {detail ? <span className="text-[13px] text-foreground/80">{detail}</span> : null}
      {children}
    </section>
  )
}

function AnchorLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="font-bold text-primary-soft-foreground underline-offset-2 hover:underline">
      {children}
    </a>
  )
}

function FinanceCards({ data }: { data: ReportFinance }) {
  const { locale, currency } = data
  const money: Money = (cents) => formatMoney(cents, currency, locale)
  const phrase = previousPhrase(data, locale)
  const { current, previous } = data.totals
  const commissionShare = rateOf(current.commissionCents, current.cobradoCents)
  const previousShare = rateOf(previous.commissionCents, previous.cobradoCents)
  const overdueChange = data.debts.overdueCents - data.debts.previousOverdueCents
  return (
    <section aria-label="Cifras de finanzas" className="grid min-w-0 gap-3.5 @xl:grid-cols-2 @5xl:grid-cols-4">
      <FinanceCard
        title="Cobrado"
        value={money(current.cobradoCents)}
        change={current.cobradoCents === 0 && previous.cobradoCents === 0 ? undefined : relativeChange(current.cobradoCents, previous.cobradoCents, phrase, locale)}
        better="up"
        detail="Ya descontadas las devoluciones"
      />
      <FinanceCard
        title={data.period.from.year === data.period.to.year && data.period.from.month === data.period.to.month && !data.period.days ? "Lo que deja el mes" : "Lo que deja el periodo"}
        value={money(current.leavesCents)}
        tone="highlight"
        change={current.leavesCents === 0 && previous.leavesCents === 0 ? undefined : moneyChange(current.leavesCents, previous.leavesCents, money, phrase)}
        better="up"
        detail={current.cobradoCents > 0 ? `${percentOf(current.leavesCents, current.cobradoCents)} de lo cobrado` : undefined}
      />
      <FinanceCard
        title="Comisiones"
        value={money(data.commissions.generatedCents)}
        detail={
          <>
            {commissionShare !== null
              ? `${commissionShare} % de lo cobrado${previousShare !== null ? (previousShare === commissionShare ? ` · igual ${phrase}` : ` · ${previousShare} % ${phrase.replace(/^que /, "")}`) : ""}`
              : "Sin cobros de lo atendido"}
            <br />
            Por pagar: {money(data.commissions.pendingCents)}
            {data.commissions.pendingCents > 0 || data.commissions.generatedCents > 0 ? (
              <>
                {" · "}
                <AnchorLink href="#comisiones">Ver</AnchorLink>
              </>
            ) : null}
          </>
        }
      />
      <FinanceCard
        title="Te deben"
        value={money(data.debts.current.totalCents)}
        change={
          data.debts.overdueCents === 0 && data.debts.previousOverdueCents === 0
            ? undefined
            : {
                ...moneyChange(data.debts.overdueCents, data.debts.previousOverdueCents, money, phrase),
                text: `Vencido hace más de 30 días: ${overdueChange === 0 ? `igual ${phrase}` : `${money(Math.abs(overdueChange))} ${overdueChange > 0 ? "más" : "menos"} ${phrase}`}`,
              }
        }
        better="down"
        detail={
          data.debts.current.people === 0 ? (
            "Nadie debe"
          ) : (
            <>
              {data.debts.current.people} {data.debts.current.people === 1 ? "persona" : "personas"} · <AnchorLink href="#deuda">Ver</AnchorLink>
            </>
          )
        }
      />
    </section>
  )
}

// --- La cascada -------------------------------------------------------------------------

/** Lo que dice el detalle de cada tipo de gasto en la cascada. */
const CATEGORY_NOTE: Record<string, string> = {
  Personal: "Sueldos y otros pagos al personal, sin las comisiones: esas tienen su propia barra.",
  Laboratorio: "Trabajos de laboratorio registrados en Finanzas › Gastos.",
  Alquiler: "El alquiler de las sedes.",
  Servicios: "Luz, agua, internet y teléfono.",
  Impuestos: "Impuestos registrados como gasto.",
  Otros: "Gastos registrados como «Otros».",
}

function Cascade({ data }: { data: ReportFinance }) {
  const { locale, currency } = data
  const canFinance = usePermission("finance.read")
  const money: Money = (cents) => formatMoney(cents, currency, locale)
  const { cascade } = data
  const current = data.totals.current
  const gastosSearch = { tab: "gastos" as const, ...(data.branch ? { branch: data.branch.id } : {}) }
  const steps: Array<WaterfallStep & { note: string; link?: ReactNode }> = [
    {
      key: "cobrado",
      label: "Cobrado",
      value: cascade.cobradoCents,
      kind: "total",
      note: "Los pagos del periodo, ya descontadas las devoluciones y las anulaciones.",
      link: canFinance ? (
        <Link to="/finance" search={data.branch ? { branch: data.branch.id } : {}} className="font-bold text-primary-soft-foreground underline-offset-2 hover:underline">
          Ver la caja
        </Link>
      ) : null,
    },
    {
      key: "comisiones",
      label: "Comisiones",
      value: cascade.commissionCents,
      kind: "less",
      tone: "series-2",
      note: `Se generan al cobrar. Pagadas ${money(data.commissions.paidCents)}; por pagar ${money(data.commissions.pendingCents)}.`,
      link: <AnchorLink href="#comisiones">Ver por profesional</AnchorLink>,
    },
    ...cascade.categories.map((item) => ({
      key: item.category,
      label: item.category,
      value: item.cents,
      kind: "less" as const,
      note:
        item.cents < 0
          ? `En el periodo se anularon más gastos de ${item.category} de periodos anteriores de los que se registraron: suma a lo que deja.`
          : item.category === "Materiales"
            ? `Gastos de materiales${cascade.purchasePaidCents > 0 ? `, incluidos ${money(cascade.purchasePaidCents)} de pagos de compras de Inventario` : ""}. Lo recibido y aún no pagado está en «Lo que debes».`
            : (CATEGORY_NOTE[item.category] ?? `Gastos de ${item.category} registrados en Finanzas › Gastos.`),
      link: canFinance ? (
        <Link to="/finance" search={gastosSearch} className="font-bold text-primary-soft-foreground underline-offset-2 hover:underline">
          Ver los gastos
        </Link>
      ) : null,
    })),
    {
      key: "deja",
      label: "Lo que deja",
      value: cascade.leavesCents,
      kind: "result",
      note: "Lo cobrado menos las comisiones generadas y los demás gastos del periodo.",
    },
  ]
  const otherShare = rateOf(current.otherExpensesCents, current.cobradoCents)
  const commissionShare = rateOf(current.commissionCents, current.cobradoCents)
  const leavesShare = rateOf(current.leavesCents, current.cobradoCents)
  const period = spanLabel(data.period, locale)
  const owed = data.payables.commissions.cents + data.payables.purchases.cents
  return (
    <ReportCard title="De lo cobrado a lo que deja el periodo">
      <div className="-mt-2 flex min-w-0 flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">
          {current.cobradoCents > 0 && commissionShare !== null && otherShare !== null && leavesShare !== null
            ? leavesShare >= 0
              ? `De lo cobrado en ${period}, el ${commissionShare} % fueron comisiones, el ${otherShare} % otros gastos y quedó el ${leavesShare} %.`
              : `En ${period} las comisiones (${commissionShare} %) y los otros gastos (${otherShare} %) pasaron lo cobrado: faltaron ${money(-current.leavesCents)}.`
            : `En ${period} no se cobró nada.`}
        </p>
        <span className="rounded-full bg-secondary px-2.5 py-1 text-[13px] font-semibold text-foreground/80">
          En caja quedó {money(current.cashLeftCents)}
          {owed > 0 ? ` · debes ${money(owed)} (comisiones y compras)` : ""}
        </span>
      </div>
      {data.missing.slice(0, 3).map((gap) => (
        <MissingExpense key={`${gap.branch.id}:${gap.category}`} data={data} gap={gap} />
      ))}
      {steps.every((step) => step.value === 0) ? null : (
      <WaterfallChart
        title={`De lo cobrado a lo que deja ${period}`}
        steps={steps}
        format={(cents) => (cents < 0 ? `−${money(-cents)}` : money(cents))}
        short={(cents) => (cents < 0 ? "−" : "") + roundMoney(Math.abs(cents), currency, locale)}
        share={{ heading: "Parte de lo cobrado", value: (index) => percentOf(steps[index]?.value ?? 0, cascade.cobradoCents) }}
        detail={(index) => {
          const step = steps[index]
          if (!step) return null
          return (
            <>
              <strong className="text-[15px]">{step.label}</strong>
              <span className="text-2xl font-extrabold tabular-nums">
                {/* Un gasto que resta con neto negativo devuelve: se dice con «+», no con dos signos. */}
                {step.value < 0 ? `${step.kind === "less" ? "+" : "−"}${money(-step.value)}` : money(step.value)}
              </span>
              <span className="text-sm text-foreground/80">
                {step.kind === "total" ? "Todo lo que entró en el periodo." : `${percentOf(Math.abs(step.value), cascade.cobradoCents)} de lo cobrado`}
              </span>
              <span className="text-[13px] text-muted-foreground">{step.note}</span>
              {step.link ? <span className="mt-1 text-[13px]">{step.link}</span> : null}
            </>
          )
        }}
      />
      )}
      <p className="text-[13px] text-muted-foreground">
        Las comisiones cuentan cuando se generan (al cobrar), aunque todavía no se hayan pagado. Los gastos son los que el equipo registra en Finanzas › Gastos, por tipo; solo aparecen los tipos con algo en el periodo.
      </p>
    </ReportCard>
  )
}

/** «Puede faltar un gasto»: con «Copiar el de agosto» (el formulario ya escrito) y «No hubo ese gasto». */
function MissingExpense({ data, gap }: { data: ReportFinance; gap: ReportFinance["missing"][number] }) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("finance.write")
  const [copying, setCopying] = useState(false)
  const { locale, currency, timezone } = data
  const money: Money = (cents) => formatMoney(cents, currency, locale)
  const monthOf = (key: string) => lowerFirst(new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(`${key}-15T12:00:00Z`)))
  const periodMonth = `${data.period.from.year}-${String(data.period.from.month).padStart(2, "0")}`
  const dismiss = useMutation({
    mutationFn: () => dismissExpenseGapApi({ category: gap.category, month: periodMonth, branchId: gap.branch.id }),
    onSuccess: () => {
      toast.success(`Listo: ${monthOf(periodMonth)} sin gastos de ${gap.category}`)
      void queryClient.invalidateQueries({ queryKey: ["report"] })
    },
    onError: (error) => toast.error(cashErrorMessage(error)),
  })
  const same = gap.previous.every((item) => item.cents === gap.previous[0]?.cents)
  // El mismo día del mes, sin pasar del último día ni de hoy.
  const lastDay = new Date(Date.UTC(data.period.from.year, data.period.from.month, 0)).getUTCDate()
  const draftDay = `${periodMonth}-${String(Math.min(gap.copy.day, lastDay)).padStart(2, "0")}`
  // Los mismos objetos mientras no cambie lo que copian: volver a pintar no es abrir otro formulario.
  const place: ExpensePlace = useMemo(
    () => ({ branchId: gap.branch.id, branchName: gap.branch.name, currency, locale, orgTimeZone: timezone }),
    [gap.branch.id, gap.branch.name, currency, locale, timezone],
  )
  const draft: ExpenseDraft = useMemo(
    () => ({ category: gap.category as ExpenseCategory, concept: gap.copy.concept, amountCents: gap.copy.amountCents, day: draftDay }),
    [gap.category, gap.copy.concept, gap.copy.amountCents, draftDay],
  )
  return (
    <div role="status" className="flex min-w-0 flex-wrap items-center gap-2.5 rounded-xl bg-warning-soft px-3.5 py-3 text-warning">
      <AlertTriangle aria-hidden className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-[1_1_320px] text-sm">
        <strong>Puede faltar un gasto:</strong> en {monthOf(periodMonth)} no hay gastos de {gap.category}
        {data.branch ? "" : ` en ${gap.branch.name}`}, y en {gap.previous.map((item) => monthOf(item.month)).join(" y ")} sí (
        {same ? `${money(gap.previous[0]?.cents ?? 0)} cada mes` : gap.previous.map((item) => money(item.cents)).join(" y ")}). Si falta, el periodo deja menos de lo que dice.
      </span>
      {canWrite ? (
        <span className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => setCopying(true)}>
            Copiar el de {monthOf(gap.copy.month)}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={dismiss.isPending} onClick={() => dismiss.mutate()}>
            No hubo ese gasto
          </Button>
        </span>
      ) : null}
      {canWrite ? (
        <ExpenseFormDrawer
          place={place}
          open={copying}
          initial={draft}
          onClose={() => {
            setCopying(false)
            void queryClient.invalidateQueries({ queryKey: ["report"] })
          }}
        />
      ) : null}
    </div>
  )
}

// --- Mes a mes --------------------------------------------------------------------------

function MonthlyChart({ data }: { data: ReportFinance }) {
  const { locale, currency } = data
  const grain = data.period.grain
  const money: Money = (cents) => formatMoney(cents, currency, locale)
  if (data.chart.length < 2) return null
  if (data.chart.every((bucket) => bucket.cobradoCents === 0 && bucket.commissionCents === 0 && bucket.otherExpensesCents === 0)) return null
  const complete = data.chart.filter((bucket) => !bucket.partial)
  const first = complete[0]
  const last = complete[complete.length - 1]
  const insight =
    first && last && first.key !== last.key
      ? `Lo que deja pasó de ${money(first.leavesCents)} en ${lowerFirst(bucketLabel(first, grain, locale))} a ${money(last.leavesCents)} en ${lowerFirst(bucketLabel(last, grain, locale))}; lo cobrado, de ${money(first.cobradoCents)} a ${money(last.cobradoCents)}.`
      : ""
  return (
    <ReportCard title={`En qué se fue lo cobrado, ${GRAIN_WORD[grain]}`} note={currency}>
      {insight ? <p className="-mt-2 text-sm text-muted-foreground">{insight}</p> : null}
      <ColumnChart
        title={`Cobrado ${GRAIN_WORD[grain]}, repartido en otros gastos, comisiones y lo que deja`}
        stacked
        total={{ label: "Cobrado", values: data.chart.map((bucket) => bucket.cobradoCents) }}
        tableHeading={grain === "month" ? "Mes" : grain === "week" ? "Semana" : "Día"}
        categories={data.chart.map((bucket) => ({ key: bucket.key, label: bucketLabel(bucket, grain, locale), short: bucketShort(bucket, grain, locale), partial: bucket.partial }))}
        bars={[
          { key: "otros", label: "Otros gastos", tone: "series-3", values: data.chart.map((bucket) => bucket.otherExpensesCents) },
          { key: "comisiones", label: "Comisiones", tone: "series-2", values: data.chart.map((bucket) => bucket.commissionCents) },
          // Un mes con pérdida deja menos de cero: la tabla lo escribe así y el dibujo no lo apila.
          { key: "deja", label: "Lo que deja", tone: "series-1", values: data.chart.map((bucket) => bucket.leavesCents) },
        ]}
        format={money}
        axis={(cents) => compactMoney(cents, currency, locale)}
        detail={(index) => {
          const bucket = data.chart[index]
          if (!bucket) return null
          return (
            <>
              <strong className="text-[13px]">
                {bucketLabel(bucket, grain, locale)}
                {bucket.partial ? ", hasta hoy" : ""}
              </strong>
              <span>Cobrado: {money(bucket.cobradoCents)}</span>
              <span>Comisiones: {money(bucket.commissionCents)}</span>
              <span>Otros gastos: {money(bucket.otherExpensesCents)}</span>
              <span className="font-bold">{bucket.leavesCents >= 0 ? `Deja: ${money(bucket.leavesCents)}` : `Faltaron: ${money(-bucket.leavesCents)}`}</span>
            </>
          )
        }}
      />
      <p className="text-[13px] text-muted-foreground">
        La altura de cada columna es lo que se fue más lo que deja: igual a lo cobrado, salvo cuando se gastó más de lo cobrado (entonces «Lo que deja» no se dibuja y el detalle dice cuánto faltó).
      </p>
    </ReportCard>
  )
}

// --- Comisiones -------------------------------------------------------------------------

/** Una cifra que se aparta de la clínica: la flecha y lo que significa, no solo el color. */
function ApartMoney({ value, text, share, clinic }: { value: number; text: string; share: number | null; clinic: number | null }) {
  const apart = share !== null && clinic !== null && share - clinic > APART_POINTS
  if (!apart || value === 0) return <span>{text}</span>
  return (
    <span className="inline-flex items-center justify-end gap-0.5 font-bold text-warning">
      <ArrowDown aria-hidden className="size-3" strokeWidth={2.5} />
      {text}
      <span className="sr-only">, se cobró menos de lo atendido que en la clínica</span>
    </span>
  )
}

function CommissionsSection({ query, data }: { query: ReportQuery; data: ReportFinance }) {
  const report = useQuery({
    queryKey: reportKey("finance/commissions", query),
    queryFn: () => fetchReport<ReportCommissions>("finance/commissions", query),
    retry: false,
  })
  const canPay = usePermission("commissions.write")
  const { locale, currency } = data
  const money: Money = (cents) => formatMoney(cents, currency, locale)
  const plain: Money = (cents) => plainAmount(cents, currency, locale)
  const end = new Date(new Date(data.period.end).getTime() - 1)
  const endMonth = new Intl.DateTimeFormat("en-CA", { timeZone: data.timezone, year: "numeric", month: "2-digit" }).format(end).split("-").map(Number)
  const payLink = (
    <Link
      to="/finance"
      search={{ tab: "comisiones", year: endMonth[0], month: endMonth[1] }}
      className="inline-flex min-h-9 items-center rounded-lg bg-primary px-3.5 text-[13px] font-bold text-primary-foreground no-underline"
    >
      Pagar comisiones
    </Link>
  )
  const body = () => {
    if (report.isPending) return <LoadingState />
    if (report.isError) return <QueryErrorState error={report.error} onRetry={() => void report.refetch()} />
    const rows = report.data.data.rows
    if (rows.length === 0) return <EmptyLine>Nadie atendió ni cobró en este periodo.</EmptyLine>
    const max = Math.max(...rows.map((row) => Math.max(row.attendedCents, row.collectedCents + row.unpaidCents)), 1)
    const attended = rows.reduce((total, row) => total + row.attendedCents, 0)
    const unpaid = rows.reduce((total, row) => total + row.unpaidCents, 0)
    const clinicUnpaid = rateOf(unpaid, attended)
    const worst = [...rows]
      .filter((row) => row.attendedCents > 0)
      .map((row) => ({ row, share: rateOf(row.unpaidCents, row.attendedCents) ?? 0 }))
      .sort((a, b) => b.share - a.share)[0]
    const bar = (row: (typeof rows)[number]) => {
      const clinic = Math.max(0, row.collectedCents - row.commissionCents)
      const total = row.commissionCents + clinic + row.unpaidCents
      return (
        <span
          role="img"
          aria-label={`De ${plain(row.attendedCents)} atendido: comisión ${plain(row.commissionCents)}, le queda a la clínica ${plain(clinic)}, sin cobrar ${plain(row.unpaidCents)}`}
          className="flex h-3.5 gap-0.5 overflow-hidden rounded"
          style={{ width: `${Math.max(4, (total / max) * 100)}%` }}
        >
          <span className="h-full min-w-0.5 bg-series-2" style={{ flex: `${row.commissionCents} 1 0` }} />
          <span className="h-full min-w-0.5 bg-series-1" style={{ flex: `${clinic} 1 0` }} />
          <span className="h-full min-w-0.5 bg-secondary" style={{ flex: `${row.unpaidCents} 1 0` }} />
        </span>
      )
    }
    return (
      <>
        <div className="grid min-w-0 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-0.5 rounded-xl bg-muted/50 px-3.5 py-3">
            <span className="text-[13px] font-bold text-muted-foreground">Generadas en {spanLabel(data.period, locale)}</span>
            <strong className="text-[22px] tabular-nums">{money(data.commissions.generatedCents)}</strong>
            <span className="text-[13px] text-muted-foreground">{percentOf(data.commissions.generatedCents, data.totals.current.cobradoCents)} de lo cobrado</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-xl bg-muted/50 px-3.5 py-3">
            <span className="text-[13px] font-bold text-muted-foreground">Ya pagadas</span>
            <strong className="text-[22px] tabular-nums">{money(data.commissions.paidCents)}</strong>
            <span className="text-[13px] text-muted-foreground">Registradas como gasto de comisiones</span>
          </div>
          <div className="flex flex-col gap-0.5 rounded-xl bg-warning-soft px-3.5 py-3">
            <span className="text-[13px] font-bold text-warning">Por pagar</span>
            <strong className="text-[22px] tabular-nums">{money(data.commissions.pendingCents)}</strong>
            <span className="text-[13px] text-warning">
              {data.commissions.professionals === 0 ? "Nadie espera pago" : `De ${data.commissions.professionals} ${data.commissions.professionals === 1 ? "profesional" : "profesionales"}`}
            </span>
          </div>
        </div>
        <ul aria-label="Leyenda" className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-foreground/80">
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="size-3 rounded-[3px] bg-series-2" />
            Comisión
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="size-3 rounded-[3px] bg-series-1" />
            Le queda a la clínica
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="size-3 rounded-[3px] bg-secondary" />
            Atendido sin cobrar
          </li>
        </ul>
        {/* En teléfono, una fila por profesional: la tabla no cabe sin desbordar. */}
        <ul className="flex min-w-0 flex-col divide-y md:hidden">
          {rows.map((row) => (
            <li key={row.userId} className="flex min-w-0 flex-col gap-1.5 py-3">
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate font-semibold">{row.name}</span>
                <span className="shrink-0 font-bold tabular-nums">{plain(row.commissionCents)}</span>
              </span>
              <span className="flex flex-wrap gap-x-3 text-[13px] text-muted-foreground">
                <span>Atendió {plain(row.attendedCents)}</span>
                <span>Se cobró {plain(row.collectedCents)}</span>
                <span>{row.rateBps / 100} %</span>
                <span className="font-semibold text-warning">Por pagar {plain(row.pendingCents)}</span>
              </span>
              {bar(row)}
            </li>
          ))}
        </ul>
        <div className="hidden min-w-0 md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Profesional</TableHead>
                <TableHead scope="col" className="text-right">
                  Atendió
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Se cobró
                </TableHead>
                <TableHead scope="col" className="text-right">
                  %
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Comisión
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Por pagar
                </TableHead>
                <TableHead scope="col" className="w-[30%]">
                  Cómo se reparte lo que atendió
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.userId}>
                  <TableHead scope="row" className="font-semibold whitespace-normal">
                    {row.name}
                  </TableHead>
                  <TableCell className="text-right tabular-nums">{plain(row.attendedCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <ApartMoney value={row.unpaidCents} text={plain(row.collectedCents)} share={rateOf(row.unpaidCents, row.attendedCents)} clinic={clinicUnpaid} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.rateBps / 100}</TableCell>
                  <TableCell className="text-right font-extrabold tabular-nums">{plain(row.commissionCents)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums text-warning">{plain(row.pendingCents)}</TableCell>
                  <TableCell>{bar(row)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {worst && clinicUnpaid !== null && worst.share - clinicUnpaid > APART_POINTS ? (
          <p className="flex min-w-0 items-start gap-2.5 rounded-xl border bg-muted/40 px-3.5 py-3 text-sm">
            <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Bot className="size-3.5" />
            </span>
            <span>
              <strong>{ADMIN_NAME}:</strong> de lo que atendió {worst.row.name} aún no se cobran {money(worst.row.unpaidCents)} ({worst.share} %; en la clínica, {clinicUnpaid} %). Su comisión de eso llegará cuando se cobre.
            </span>
          </p>
        ) : null}
        <p className="text-[13px] text-muted-foreground">
          La barra de cada profesional mide lo que se cobró más lo que atendió sin cobrar, a la misma escala. «Se cobró» incluye lo cobrado en el periodo de atenciones anteriores. Los porcentajes se cambian en Finanzas › Comisiones, y pagar también se hace allí: el pago queda como gasto de comisiones, separado de los sueldos.
        </p>
      </>
    )
  }
  return (
    <section id="comisiones" aria-labelledby="comisiones-titulo" className="elevated flex min-w-0 scroll-mt-4 flex-col gap-3 rounded-xl border bg-card p-[18px]">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 max-w-3xl flex-col gap-0.5">
          <h3 id="comisiones-titulo" className="font-semibold">
            Comisiones
          </h3>
          <p className="text-sm text-muted-foreground">Cada profesional gana su porcentaje de lo que se cobró de lo que atendió. Lo atendido que aún no se cobra no genera comisión todavía.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {report.data && report.data.data.rows.length > 0 ? <DownloadButton onDownload={() => downloadReportTable("commissions", query)} /> : null}
          {/* Solo cuando hay algo que pagar: sin comisiones por pagar, el botón sería ruido. */}
          {canPay && data.payables.commissions.cents > 0 ? payLink : null}
        </div>
      </div>
      {body()}
    </section>
  )
}

// --- Te deben y debes -------------------------------------------------------------------

const AGES: Array<{ key: "0_30" | "31_60" | "61_90" | "90_plus"; label: string; list: ReportListKey; color: string }> = [
  { key: "0_30", label: "0 a 30 días", list: "debts_age_0_30", color: "var(--scale-1)" },
  { key: "31_60", label: "31 a 60 días", list: "debts_age_31_60", color: "var(--scale-2)" },
  { key: "61_90", label: "61 a 90 días", list: "debts_age_61_90", color: "var(--scale-3)" },
  { key: "90_plus", label: "Más de 90 días", list: "debts_age_90_plus", color: "var(--scale-4)" },
]

function closingDay(data: ReportFinance): string {
  const end = new Date(new Date(data.period.end).getTime() - 1)
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: data.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(end)
  return dayText(day, data.locale, { day: "numeric", month: "long" })
}

function DebtsCard({ data, onOpenList, advice }: { data: ReportFinance; onOpenList: (list: ReportListKey) => void; advice?: ReactNode }) {
  const { locale, currency } = data
  const money: Money = (cents) => formatMoney(cents, currency, locale)
  const debts = data.debts.current
  const at = data.period.partial ? "hoy" : `al ${closingDay(data)}`
  return (
    <section id="deuda" aria-labelledby="deuda-titulo" className="elevated flex min-w-0 scroll-mt-4 flex-col gap-3.5 rounded-xl border bg-card p-[18px]">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 id="deuda-titulo" className="font-semibold">
          Cuánto te deben y desde cuándo
        </h3>
        <p className="text-sm text-muted-foreground">
          {debts.people === 0
            ? `Nadie debe ${at}.`
            : `${money(debts.totalCents)} de ${debts.people} ${debts.people === 1 ? "persona" : "personas"} ${at}. Cuenta desde el día del cargo; quien debe varios va en el tramo del más antiguo.`}
        </p>
      </div>
      {debts.people > 0 ? (
        <>
          <div
            role="img"
            aria-label={`Deuda por antigüedad: ${AGES.map((age) => `${age.label} ${money(debts.ages.find((item) => item.key === age.key)?.cents ?? 0)}`).join("; ")}`}
            className="flex h-8 gap-0.5 overflow-hidden rounded-lg"
          >
            {AGES.map((age) => {
              const cents = debts.ages.find((item) => item.key === age.key)?.cents ?? 0
              return cents > 0 ? <span key={age.key} className="h-full min-w-1" style={{ flex: `${cents} 1 0`, background: age.color }} /> : null
            })}
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
            {AGES.map((age) => {
              const item = debts.ages.find((entry) => entry.key === age.key) ?? { cents: 0, people: 0 }
              return (
                <div key={age.key} className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-[13px] font-bold text-foreground/80">
                    <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: age.color }} />
                    {age.label}
                  </span>
                  <strong className="text-lg tabular-nums">{money(item.cents)}</strong>
                  <span className="text-[13px] text-muted-foreground">
                    {item.people} {item.people === 1 ? "persona" : "personas"}
                  </span>
                  {item.people > 0 ? (
                    <Button type="button" variant="link" className="h-auto min-h-11 justify-start p-0 text-[13px] font-bold sm:min-h-7" onClick={() => onOpenList(age.list)}>
                      Ver quiénes
                    </Button>
                  ) : null}
                </div>
              )
            })}
          </div>
        </>
      ) : null}
      {advice}
    </section>
  )
}

function PayablesCard({ data }: { data: ReportFinance }) {
  const { locale, currency } = data
  const money: Money = (cents) => formatMoney(cents, currency, locale)
  // «Pagar comisiones» se ofrece a quien puede pagarlas, no solo verlas.
  const canPay = usePermission("commissions.write")
  const canInventory = usePermission("inventory.read")
  const { commissions, purchases } = data.payables
  const total = commissions.cents + purchases.cents
  const daysSince = purchases.oldestReceivedAt ? Math.max(0, Math.floor((new Date(data.period.end).getTime() - new Date(purchases.oldestReceivedAt).getTime()) / 86_400_000)) : null
  return (
    <ReportCard title="Lo que debes">
      <p className="-mt-2 text-sm text-muted-foreground">{data.period.partial ? "Hoy." : `Al ${closingDay(data)}.`}</p>
      <span className="text-[28px] leading-9 font-extrabold tracking-tight tabular-nums">{money(total)}</span>
      {total > 0 ? (
        <ShareBar
          title="Lo que debes: comisiones por pagar y compras sin pagar"
          format={money}
          parts={[
            { key: "comisiones", label: "Comisiones", value: commissions.cents, tone: "series-2" },
            { key: "compras", label: "Compras", value: purchases.cents, tone: "series-3" },
          ]}
        />
      ) : null}
      <ul className="flex min-w-0 flex-col gap-2.5 text-sm">
        <li className="flex min-w-0 flex-col">
          <span className="flex justify-between gap-2">
            <strong>Comisiones por pagar</strong>
            <strong className="tabular-nums">{money(commissions.cents)}</strong>
          </span>
          <span className="text-[13px] text-muted-foreground">
            {commissions.professionals === 0 ? "Nadie espera pago" : `De ${commissions.professionals} ${commissions.professionals === 1 ? "profesional" : "profesionales"}`}
            {canPay && commissions.cents > 0 ? (
              <>
                {" · "}
                <Link to="/finance" search={{ tab: "comisiones" }} className="font-bold text-primary-soft-foreground">
                  Pagar comisiones
                </Link>
              </>
            ) : null}
          </span>
        </li>
        <li className="flex min-w-0 flex-col">
          <span className="flex justify-between gap-2">
            <strong>Compras recibidas sin pagar</strong>
            <strong className="tabular-nums">{money(purchases.cents)}</strong>
          </span>
          <span className="text-[13px] text-muted-foreground">
            {purchases.orders === 0
              ? "Ninguna"
              : `${purchases.orders} ${purchases.orders === 1 ? "compra" : "compras"}${daysSince !== null ? `; la más antigua llegó hace ${daysSince} ${daysSince === 1 ? "día" : "días"}` : ""}`}
            {canInventory && purchases.orders > 0 ? (
              <>
                {" · "}
                <Link to="/inventory" search={{ tab: "compras", pago: "por_pagar" }} className="font-bold text-primary-soft-foreground">
                  Ver compras
                </Link>
              </>
            ) : null}
          </span>
        </li>
      </ul>
      <p className="text-[13px] text-muted-foreground">Un adelanto de una compra que aún no llega no está aquí: ya se pagó, y se descuenta cuando llegue.</p>
    </ReportCard>
  )
}

// --- Lo que viene y de dónde vino lo cobrado ---------------------------------------------

function OutlookCard({ query, onOpenList }: { query: ReportQuery; onOpenList: (list: ReportListKey) => void }) {
  const report = useQuery({ queryKey: reportKey("finance/outlook", query), queryFn: () => fetchReport<ReportOutlook>("finance/outlook", query), retry: false })
  if (report.isPending)
    return (
      <ReportCard title="Lo que viene">
        <LoadingState />
      </ReportCard>
    )
  if (report.isError)
    return (
      <ReportCard title="Lo que viene">
        <QueryErrorState error={report.error} onRetry={() => void report.refetch()} />
      </ReportCard>
    )
  const data = report.data.data
  const money: Money = (cents) => formatMoney(cents, data.currency, data.locale)
  return (
    <ReportCard title="Lo que viene" note={data.wholeClinic.includes("upcoming") ? `${WHOLE_CLINIC} · a hoy` : "A hoy"}>
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-bold text-muted-foreground">Presupuestos aceptados por hacer</span>
        <span className="text-[28px] leading-9 font-extrabold tracking-tight tabular-nums">{money(data.upcoming.cents)}</span>
        <span className="text-[13px] text-muted-foreground">
          {data.upcoming.patients === 0 ? "Nada aceptado por hacer." : `De ${data.upcoming.patients} ${data.upcoming.patients === 1 ? "paciente" : "pacientes"}: trabajo ya vendido que aún no se hace.`}
        </span>
      </div>
      {data.upcoming.unbooked.patients > 0 ? (
        <div className="flex flex-col gap-1.5 rounded-xl bg-warning-soft px-3.5 py-3 text-warning">
          <strong>
            {data.upcoming.unbooked.patients} {data.upcoming.unbooked.patients === 1 ? "no tiene" : "no tienen"} cita: {money(data.upcoming.unbooked.cents)}
          </strong>
          <span className="text-[13px]">«Presupuesto aceptado sin cita» de {ADMIN_NAME} deja una tarea a recepción para llamarlos.</span>
          <Button type="button" size="sm" className="self-start" onClick={() => onOpenList("upcoming_unbooked")}>
            Ver {data.upcoming.unbooked.patients === 1 ? "quién" : `los ${data.upcoming.unbooked.patients}`}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-bold text-muted-foreground">Un paciente nuevo, en sus primeros 6 meses</span>
        <span className="text-[22px] font-extrabold tabular-nums">{data.patientValue.averageCents === null ? "Sin datos" : money(data.patientValue.averageCents)}</span>
        <span className="text-[13px] text-muted-foreground">
          {data.patientValue.patients > 0
            ? `Lo que pagaron, en promedio, los ${data.patientValue.patients} pacientes nuevos de hace 6 a 9 meses. Sirve para saber cuánto conviene gastar en traer a alguien nuevo.`
            : "Aún no hay pacientes nuevos de hace 6 a 9 meses para calcularlo."}
        </span>
      </div>
    </ReportCard>
  )
}

function TreatmentsCard({ data }: { data: ReportFinance }) {
  const plain: Money = (cents) => plainAmount(cents, data.currency, data.locale)
  const { rows, others } = data.byTreatment
  const top = Math.max(1, ...rows.map((row) => row.cents), others?.cents ?? 0)
  return (
    <ReportCard title="Cobrado por tratamiento" note={data.currency}>
      {rows.length === 0 ? (
        <EmptyLine>No se aplicaron cobros a tratamientos en este periodo.</EmptyLine>
      ) : (
        <BarRows
          rows={[
            ...rows.map((row) => ({ key: row.name, label: row.name, value: plain(row.cents), share: (row.cents / top) * 100 })),
            ...(others ? [{ key: "otros", label: `Otros ${others.count}`, value: plain(others.cents), share: (others.cents / top) * 100, tone: "muted" as const }] : []),
          ]}
        />
      )}
      <p className="text-[13px] text-muted-foreground">Lo que se aplicó a los cargos de cada servicio. Lo cobrado a cuenta, sin aplicar todavía, no aparece aquí.</p>
    </ReportCard>
  )
}

function MethodsCard({ data }: { data: ReportFinance }) {
  const plain: Money = (cents) => plainAmount(cents, data.currency, data.locale)
  const money: Money = (cents) => formatMoney(cents, data.currency, data.locale)
  const { methods, closures } = data.byMethod
  const top = Math.max(1, ...methods.map((row) => row.cents))
  const cash = methods.filter((row) => row.cash).reduce((total, row) => total + row.cents, 0)
  const note =
    closures.count === 0
      ? cash !== 0
        ? "Aún no hay cierres de caja en este periodo para comparar el efectivo."
        : null
      : cash === closures.cashCents
        ? "El efectivo coincide con los cierres de caja del periodo."
        : `El efectivo (${money(cash)}) no coincide con los cierres de caja (${money(closures.cashCents)}): puede haber una caja sin cerrar o un cierre que abarca días de otro periodo.`
  return (
    <ReportCard title="Cobrado por medio de pago" note={data.currency}>
      {methods.length === 0 ? (
        <EmptyLine>No se cobró nada en este periodo.</EmptyLine>
      ) : (
        <BarRows rows={methods.map((row) => ({ key: row.label, label: row.label, value: plain(row.cents), share: (row.cents / top) * 100 }))} />
      )}
      {note ? <p className="text-[13px] text-muted-foreground">{note}</p> : null}
    </ReportCard>
  )
}

