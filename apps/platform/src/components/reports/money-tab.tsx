/**
 * Reportes › Dinero: cuánto entró, cuánto se gastó y cuánto falta cobrar, con
 * sus desgloses. «Cobrado» es siempre el neto (ya descontadas devoluciones y
 * anulaciones). Nunca se suman monedas distintas: con más de una, hay una
 * sección por moneda. Lo que «queda» va en la cifra de arriba de la pantalla.
 */
import { formatMoney } from "@odentia/clinical"
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, useIsMobile } from "@odentia/ui"
import { EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { ChevronDown } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { plainAmount, shareOf } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import { QueryErrorState } from "../../lib/query-error"
import { amountFromCents } from "../../lib/workspace"
import {
  fetchReport,
  type MoneyBucket,
  previousPhrase,
  relativeChange,
  reportKey,
  type ReportMoney,
  type ReportQuery,
  spanLabel,
} from "../../lib/reports"
import { MonthBars } from "./month-bars"
import { EmptyLine, Figure, ReportCard, unlessEmpty } from "./report-parts"

/** Filas a la vista en teléfono antes de agrupar el resto en «Otros N». */
const MOBILE_ROWS = 3

type Money = (cents: number) => string

interface BarRow {
  key: string
  label: string
  cents: number
  /** Parte del total (0–100): ancho de la barra y, si se pide, el porcentaje escrito. */
  share: number
}

const EMPTY_BUCKET: Omit<MoneyBucket, "currency"> = {
  cobradoCents: 0,
  devolucionesCents: 0,
  anulacionesCents: 0,
  netoCents: 0,
  gastadoCents: 0,
  quedaCents: 0,
  efectivoCents: 0,
  byMethod: [],
  byCategory: [],
}

/** «Sol peruano (PEN)»; el código solo si el navegador no conoce la moneda. */
function currencyName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames(locale, { type: "currency" }).of(code)
    if (name && name !== code) return `${name.charAt(0).toLocaleUpperCase(locale)}${name.slice(1)} (${code})`
  } catch {
    // Código que el navegador no reconoce: se muestra tal cual.
  }
  return code
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function toBars<T>(items: T[], read: (item: T) => { key: string; label: string; cents: number }, total: number): BarRow[] {
  return items
    .map(read)
    .filter((row) => row.cents !== 0)
    .sort((a, b) => b.cents - a.cents)
    .map((row) => ({ ...row, share: shareOf(row.cents, total) }))
}

export function MoneyTab({ query, onShowCurrentMonth, advice }: { query: ReportQuery; onShowCurrentMonth: () => void; advice?: ReactNode }) {
  const navigate = useNavigate()
  const canFinance = usePermission("finance.read")
  const report = useQuery({ queryKey: reportKey("money", query), queryFn: () => fetchReport<ReportMoney>("money", query), retry: false })

  if (report.isPending) return <LoadingState />
  if (report.isError)
    return <QueryErrorState error={report.error} onRetry={() => void report.refetch()} notFound="La sede elegida ya no está disponible. Elige otra sede." />

  const data = report.data.data
  const locale = data.locale
  // Una sección por moneda: la de la clínica primero. También cuenta la que solo tiene deuda.
  const currencies = [...new Set([...data.byCurrency.map((bucket) => bucket.currency), ...data.outstanding.map((row) => row.currency)])].sort(
    (a, b) => Number(b === data.currency) - Number(a === data.currency) || a.localeCompare(b),
  )
  const isCurrent = query.period === "este_mes"

  if (currencies.length === 0) {
    return (
      <EmptyState
        title={`Sin movimientos en ${spanLabel(data.period, locale)}`}
        description={
          data.branch
            ? `No se registraron cobros ni gastos en ${data.branch.name} y nadie quedó debiendo.`
            : "No se registraron cobros ni gastos y nadie quedó debiendo."
        }
        actionLabel={!isCurrent ? "Ver este mes" : canFinance ? "Ir a Finanzas" : undefined}
        onAction={!isCurrent ? onShowCurrentMonth : () => void navigate({ to: "/finance" })}
      />
    )
  }

  const multi = currencies.length > 1
  return (
    <div className="flex min-w-0 flex-col gap-8">
      {currencies.map((currency) => (
        <CurrencyMoney key={currency} data={data} currency={currency} heading={multi ? currencyName(currency, locale) : null} advice={currency === currencies[0] ? advice : undefined} />
      ))}
    </div>
  )
}

function CurrencyMoney({
  data,
  currency,
  heading,
  advice,
}: {
  data: ReportMoney
  currency: string
  /** Nombre de la moneda cuando hay más de una; `null` si es la única. */
  heading: string | null
  /** El aviso del administrador sobre lo que se debe: va bajo las cifras. */
  advice?: ReactNode
}) {
  const headingId = useId()
  const isMobile = useIsMobile()
  const canFinance = usePermission("finance.read")
  const canExpense = usePermission("finance.write")
  const canCatalog = usePermission("catalog.read")
  // Los enlaces a Finanzas llevan la sede del reporte: sin ella la lista de allá no corresponde a la cifra de aquí.
  const branchSearch = data.branch ? { branch: data.branch.id } : {}
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

  const locale = data.locale
  const money: Money = (cents) => formatMoney(cents, currency, locale)
  // Las filas van sin símbolo; las cifras destacadas lo conservan.
  const plain: Money = (cents) => plainAmount(cents, currency, locale)
  const bucket = data.byCurrency.find((item) => item.currency === currency) ?? { ...EMPTY_BUCKET, currency }
  const previous = data.previousTotals.find((item) => item.currency === currency) ?? null
  const hasMovement = data.byCurrency.some((item) => item.currency === currency)
  const discounted = bucket.devolucionesCents + bucket.anulacionesCents
  const limit = isMobile ? MOBILE_ROWS : undefined
  const phrase = previousPhrase(data, locale)
  const months = data.period.from.year !== data.period.to.year || data.period.from.month !== data.period.to.month

  const methods = toBars(bucket.byMethod, (row) => ({ key: row.key, label: row.label, cents: row.cents }), bucket.netoCents)
  const professionals = data.byProfessional.filter((row) => row.currency === currency)
  const professionalTotal = sum(professionals.map((row) => Math.max(0, row.cobradoCents)))
  const professionalBars = toBars(
    professionals,
    (row) => ({ key: row.professionalUserId, label: row.name ?? "Profesional fuera del equipo", cents: row.cobradoCents }),
    professionalTotal,
  )
  const categories = toBars(bucket.byCategory, (row) => ({ key: row.category, label: row.category, cents: row.cents }), bucket.gastadoCents)
  const promotions = data.byPromotion.filter((row) => row.currency === currency)
  const outstanding = data.outstanding.find((row) => row.currency === currency) ?? null
  const cashNote = cashAgainstClosures(data, bucket, money)

  const byMethod = (
    <ReportCard title="Cobrado por medio de pago">
      {methods.length === 0 ? (
        <EmptyLine
          action={
            canFinance ? (
              <Link to="/finance" search={branchSearch} className="font-semibold text-primary underline">
                Ir a Finanzas
              </Link>
            ) : undefined
          }
        >
          No se cobró nada en este periodo.
        </EmptyLine>
      ) : (
        <BarList rows={methods} money={plain} showShare limit={limit} />
      )}
      {cashNote ? <p className={`text-[13px] ${cashNote.matches ? "text-muted-foreground" : "font-medium"}`}>{cashNote.text}</p> : null}
    </ReportCard>
  )
  const byProfessional = (
    <ReportCard title="Cobrado por profesional">
      {professionalBars.length === 0 ? (
        <EmptyLine>Lo cobrado en este periodo no corresponde a tratamientos que alguien atendió.</EmptyLine>
      ) : (
        <BarList rows={professionalBars} money={plain} showShare limit={limit} />
      )}
      {professionalBars.length > 0 ? (
        <p className="text-[13px] text-muted-foreground">
          Según quién atendió cada tratamiento cobrado.
          {professionalTotal < bucket.netoCents ? " Lo cobrado sin atención no cuenta para ningún profesional." : ""}
        </p>
      ) : null}
    </ReportCard>
  )
  const byCategory = (
    <ReportCard title="Gastado por tipo">
      {categories.length === 0 ? (
        <EmptyLine
          action={
            canExpense ? (
              <Link to="/finance" search={{ tab: "gastos", ...branchSearch }} className="font-semibold text-primary underline">
                Registrar un gasto
              </Link>
            ) : undefined
          }
        >
          No se registró ningún gasto en este periodo.
        </EmptyLine>
      ) : (
        <BarList rows={categories} money={plain} tone="muted" limit={limit} />
      )}
    </ReportCard>
  )
  const byPromotion = (
    <ReportCard title="Promociones">
      {promotions.length === 0 ? (
        <EmptyLine
          action={
            canCatalog ? (
              <Link to="/services/promotions" className="font-semibold text-primary underline">
                Ver promociones
              </Link>
            ) : undefined
          }
        >
          No se cobró con ninguna promoción en este periodo.
        </EmptyLine>
      ) : (
        <ul className="flex min-w-0 flex-col divide-y">
          {promotions.map((row) => (
            <li key={row.promotionId} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-sm first:pt-0 last:pb-0">
              <span className="min-w-0 flex-1 basis-40 font-semibold">{row.name}</span>
              <span className="shrink-0 text-muted-foreground">
                {row.veces} {row.veces === 1 ? "vez" : "veces"}
                {/* Solo en las promociones «desde»: su precio cambia en cada caso. */}
                {row.mode === "from" && row.averageCents != null ? ` · precio promedio ${plain(row.averageCents)}` : ""}
              </span>
              <span className="shrink-0 font-semibold tabular-nums">{plain(row.cobradoCents)}</span>
            </li>
          ))}
        </ul>
      )}
    </ReportCard>
  )
  const stillOwed = (
    <Figure
      tone="attention"
      title={data.period.partial ? "Queda por cobrar hasta hoy" : months ? "Quedó por cobrar al terminar el periodo" : "Quedó por cobrar al terminar el mes"}
      value={money(outstanding?.pendienteCents ?? 0)}
      note={
        outstanding
          ? `${outstanding.pacientes} ${outstanding.pacientes === 1 ? "persona debe" : "personas deben"}`
          : data.period.partial
            ? "Nadie debe."
            : "Nadie quedó debiendo."
      }
    >
      {outstanding && canFinance ? (
        <Link to="/finance" search={{ tab: "deudas", ...branchSearch }} className="self-start text-sm font-semibold text-warning underline">
          Ver quién debe
        </Link>
      ) : null}
    </Figure>
  )

  return (
    <section aria-labelledby={heading ? headingId : undefined} aria-label={heading ? undefined : "Dinero"} className="@container flex min-w-0 flex-col gap-4">
      {heading ? (
        <h3 id={headingId} className="text-base font-semibold">
          {heading}
        </h3>
      ) : null}

      <div className="grid min-w-0 grid-cols-2 gap-3 @4xl:grid-cols-3">
        <Figure
          title="Cobrado"
          value={money(bucket.netoCents)}
          change={unlessEmpty(bucket.netoCents, relativeChange(bucket.netoCents, previous?.netoCents, phrase, locale))}
          better="up"
          note={discounted > 0 ? `Ya descontadas las devoluciones (${money(discounted)})` : "Ya descontadas las devoluciones"}
        />
        <Figure
          title="Gastado"
          value={money(bucket.gastadoCents)}
          change={unlessEmpty(bucket.gastadoCents, relativeChange(bucket.gastadoCents, previous?.gastadoCents, phrase, locale))}
          note="Los gastos registrados en el periodo"
        />
        <div className="col-span-2 @4xl:col-span-1">{stillOwed}</div>
      </div>

      {advice}

      {data.series.length > 1 ? (
        <MonthBars
          title="Cobrado y gastado por mes"
          note={`${spanLabel(data.period, locale).replace(/^./, (letter) => letter.toLocaleUpperCase(locale))} · ${currency}`}
          months={data.series}
          locale={locale}
          compact={(cents) => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(amountFromCents(String(cents), currency))}
          series={[
            { key: "cobrado", label: "Cobrado", tone: "primary", display: money, values: data.series.map((row) => row.totals.find((item) => item.currency === currency)?.netoCents ?? 0) },
            { key: "gastado", label: "Gastado", tone: "muted", display: money, values: data.series.map((row) => row.totals.find((item) => item.currency === currency)?.gastadoCents ?? 0) },
          ]}
        />
      ) : null}

      {!hasMovement ? (
        <EmptyState title="Sin cobros ni gastos" description="En este periodo no hubo movimientos en esta moneda; solo queda lo que se debía." />
      ) : isMobile ? (
        <div className="flex min-w-0 flex-col gap-3">
          {byMethod}
          <Fold label="Gastado por tipo" open={categoriesOpen} onOpenChange={setCategoriesOpen}>
            {byCategory}
          </Fold>
          <Fold label="Por profesional y por promoción" open={moreOpen} onOpenChange={setMoreOpen}>
            {byProfessional}
            {byPromotion}
          </Fold>
        </div>
      ) : (
        <>
          <div className="grid min-w-0 gap-4 @3xl:grid-cols-2 @5xl:grid-cols-3">
            {byMethod}
            {byProfessional}
            {byCategory}
          </div>
          {byPromotion}
        </>
      )}
    </section>
  )
}

/** En teléfono, lo secundario se despliega al tocarlo. */
function Fold({ label, open, onOpenChange, children }: { label: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger render={<Button type="button" variant="outline" className="min-h-12 w-full justify-between" />}>
        {label}
        <ChevronDown aria-hidden className={open ? "rotate-180 transition-transform" : "transition-transform"} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex min-w-0 flex-col gap-3 pt-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * El efectivo del tramo frente a los cierres de caja hechos en él. Solo se
 * afirma que coincide cuando coincide; si no, se dice cuánto falta o sobra.
 */
function cashAgainstClosures(data: ReportMoney, bucket: MoneyBucket, money: Money): { matches: boolean; text: string } | null {
  const closure = data.closures.find((row) => row.currency === bucket.currency) ?? null
  const hasCash = bucket.byMethod.some((row) => row.cash)
  if (!closure) {
    return hasCash && bucket.efectivoCents !== 0
      ? { matches: false, text: "Aún no hay cierres de caja en este periodo para comparar con el efectivo." }
      : null
  }
  // Los cierres guardan aparte lo cobrado y lo devuelto en efectivo: se compara el neto.
  const closedCash = closure.efectivoCents - closure.efectivoDevueltoCents
  const difference = Math.abs(bucket.efectivoCents - closedCash)
  if (difference === 0) return { matches: true, text: "El efectivo coincide con la suma de los cierres de caja del periodo." }
  return {
    matches: false,
    text: `El efectivo del periodo (${money(bucket.efectivoCents)}) no coincide con la suma de los cierres de caja (${money(closedCash)}): hay ${money(difference)} de diferencia. Puede haber una caja sin cerrar o un cierre que abarca días de otro mes.`,
  }
}

/**
 * Barras simples: nombre, porcentaje (si se pide) e importe en texto, con una
 * barra decorativa debajo. Con `limit`, el resto se agrupa en «Otros N» y se
 * despliega al pulsarlo.
 */
function BarList({
  rows,
  money,
  showShare = false,
  tone = "primary",
  limit,
}: {
  rows: BarRow[]
  money: Money
  showShare?: boolean
  tone?: "primary" | "muted"
  limit?: number
}) {
  const [expanded, setExpanded] = useState(false)
  // Agrupar solo vale la pena si esconde más de una fila.
  const groups = limit !== undefined && rows.length > limit + 1
  const collapsed = groups && !expanded
  const visible = collapsed ? rows.slice(0, limit) : rows
  const rest = collapsed ? rows.slice(limit) : []

  return (
    <ul className="flex min-w-0 flex-col gap-2.5">
      {visible.map((row) => (
        <li key={row.key} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-baseline gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {showShare ? <span className="shrink-0 text-muted-foreground tabular-nums">{row.share} %</span> : null}
            <span className="shrink-0 font-semibold tabular-nums">{money(row.cents)}</span>
          </div>
          <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className={`h-full rounded-full ${tone === "muted" ? "bg-muted-foreground/50" : "bg-primary"}`} style={{ width: `${row.share}%` }} />
          </div>
        </li>
      ))}
      {groups ? (
        <li className="min-w-0">
          {/* El mismo botón agrupa y despliega: el foco no se pierde al pulsarlo. */}
          <Button
            type="button"
            variant="ghost"
            aria-expanded={expanded}
            className="-mx-2 h-auto min-h-11 w-[calc(100%+1rem)] min-w-0 justify-start gap-3 px-2 py-1.5 text-left font-normal"
            onClick={() => setExpanded((value) => !value)}
          >
            {collapsed ? (
              <>
                <span className="min-w-0 flex-1 truncate font-semibold text-primary underline">Otros {rest.length}</span>
                {showShare ? <span className="shrink-0 text-muted-foreground tabular-nums">{sum(rest.map((row) => row.share))} %</span> : null}
                <span className="shrink-0 font-semibold tabular-nums">{money(sum(rest.map((row) => row.cents)))}</span>
              </>
            ) : (
              <span className="font-semibold text-primary underline">Ver menos</span>
            )}
          </Button>
        </li>
      ) : null}
    </ul>
  )
}
