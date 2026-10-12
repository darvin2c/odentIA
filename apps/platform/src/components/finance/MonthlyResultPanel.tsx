/**
 * Resultado del mes: cuánto entró, cuánto se gastó y cuánto queda, con sus
 * desgloses. Extraíble: Reportes lo monta tal cual; elige su mes y su sede.
 *
 * «Cobrado» es siempre el neto (ya descontadas devoluciones y anulaciones).
 * Nunca se suman monedas distintas: con más de una, hay una sección por moneda.
 * Las barras son un apoyo visual; cada dato va también en texto.
 */
import { formatMoney } from "@odentia/clinical"
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  useIsMobile,
} from "@odentia/ui"
import { EmptyState, KpiCard, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { ChevronDown, Settings } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import {
  compareMonths,
  currentMonthIn,
  fetchMonthlyFinanceResult,
  type MonthlyFinanceResult,
  type MonthlyResultBucket,
  monthLabel,
  plainAmount,
  shareOf,
  type YearMonth,
} from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import { useBranchesOptions, useOrgFinanceProfile } from "../../lib/finance-collect"
import { QueryErrorState } from "../../lib/query-error"
import { ChoiceSelect } from "../ui/choice-select"
import { MonthPicker } from "./MonthPicker"

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

const EMPTY_BUCKET: Omit<MonthlyResultBucket, "currency"> = {
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
    if (name && name !== code) {
      return `${name.charAt(0).toLocaleUpperCase(locale)}${name.slice(1)} (${code})`
    }
  } catch {
    // Código que el navegador no reconoce: se muestra tal cual.
  }
  return code
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function toBars<T>(
  items: T[],
  read: (item: T) => { key: string; label: string; cents: number },
  total: number,
): BarRow[] {
  return items
    .map(read)
    .filter((row) => row.cents !== 0)
    .sort((a, b) => b.cents - a.cents)
    .map((row) => ({ ...row, share: shareOf(row.cents, total) }))
}

export function MonthlyResultPanel() {
  const titleId = useId()
  const navigate = useNavigate()
  const canSettings = usePermission("settings.write")
  const profile = useOrgFinanceProfile()
  const branches = useBranchesOptions()
  const [chosen, setChosen] = useState<YearMonth | null>(null)
  const [branchId, setBranchId] = useState("")

  const region = profile.data?.data ?? null
  const currentMonth = currentMonthIn(region?.timezone)
  const period = chosen ?? currentMonth
  const branchList = branches.data?.data ?? []
  const branchName = branchList.find((branch) => branch.id === branchId)?.name ?? null

  const query = useQuery({
    queryKey: ["monthly-finance-result", period.year, period.month, branchId],
    queryFn: () => fetchMonthlyFinanceResult({ ...period, branchId: branchId || undefined }),
    enabled: region !== null,
  })

  return (
    <section aria-labelledby={titleId} className="@container flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-semibold">
            Resultado del mes
          </h2>
          <p className="text-sm text-muted-foreground">
            Cuánto entró, cuánto se gastó y cuánto queda
          </p>
        </div>
        {region ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {branchList.length > 1 ? (
              <ChoiceSelect
                aria-label="Sede"
                className="w-48"
                value={branchId}
                onChange={(event) => setBranchId(event.target.value)}
              >
                <option value="">Todas las sedes</option>
                {branchList.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </ChoiceSelect>
            ) : null}
            <MonthPicker
              value={period}
              onChange={setChosen}
              max={currentMonth}
              locale={region.locale}
            />
          </div>
        ) : null}
      </div>

      {profile.isPending ? (
        <LoadingState />
      ) : profile.isError ? (
        <QueryErrorState error={profile.error} onRetry={() => void profile.refetch()} />
      ) : !region ? (
        <EmptyState
          icon={Settings}
          title="Falta configurar la clínica"
          description="El resultado se calcula con la moneda y la zona horaria de la clínica. Aún no están configuradas."
          actionLabel={canSettings ? "Ir a Configuración" : undefined}
          onAction={() => void navigate({ to: "/settings" })}
        />
      ) : query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <QueryErrorState
          error={query.error}
          onRetry={() => void query.refetch()}
          notFound="La sede elegida ya no está disponible. Elige otra sede."
        />
      ) : (
        <ResultBody
          result={query.data.data}
          period={period}
          isCurrentMonth={compareMonths(period, currentMonth) === 0}
          orgCurrency={region.currency}
          branchName={branchName}
          onShowCurrentMonth={() => setChosen(null)}
        />
      )}
    </section>
  )
}

function ResultBody({
  result,
  period,
  isCurrentMonth,
  orgCurrency,
  branchName,
  onShowCurrentMonth,
}: {
  result: MonthlyFinanceResult
  period: YearMonth
  isCurrentMonth: boolean
  orgCurrency: string
  branchName: string | null
  onShowCurrentMonth: () => void
}) {
  const navigate = useNavigate()
  const canFinance = usePermission("finance.read")
  const locale = result.locale

  // Una sección por moneda: la de la clínica primero. También cuenta la que solo tiene deuda.
  const currencies = [
    ...new Set([
      ...result.byCurrency.map((bucket) => bucket.currency),
      ...result.outstanding.map((row) => row.currency),
    ]),
  ].sort((a, b) => Number(b === orgCurrency) - Number(a === orgCurrency) || a.localeCompare(b))

  if (currencies.length === 0) {
    const month = monthLabel(period, locale).toLocaleLowerCase(locale)
    return (
      <EmptyState
        title={`Sin movimientos en ${month}`}
        description={
          branchName
            ? `No se registraron cobros ni gastos en ${branchName} y nadie quedó debiendo.`
            : "No se registraron cobros ni gastos y nadie quedó debiendo."
        }
        actionLabel={
          !isCurrentMonth ? "Ver el mes actual" : canFinance ? "Ir a Finanzas" : undefined
        }
        onAction={!isCurrentMonth ? onShowCurrentMonth : () => void navigate({ to: "/finance" })}
      />
    )
  }

  const multi = currencies.length > 1
  return (
    <div className="flex min-w-0 flex-col gap-8">
      {currencies.map((currency) => (
        <CurrencyResult
          key={currency}
          result={result}
          currency={currency}
          heading={multi ? currencyName(currency, locale) : null}
          isCurrentMonth={isCurrentMonth}
        />
      ))}
    </div>
  )
}

function CurrencyResult({
  result,
  currency,
  heading,
  isCurrentMonth,
}: {
  result: MonthlyFinanceResult
  currency: string
  /** Nombre de la moneda cuando hay más de una; `null` si es la única. */
  heading: string | null
  isCurrentMonth: boolean
}) {
  const headingId = useId()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const canFinance = usePermission("finance.read")
  const canExpense = usePermission("finance.write")
  const canCatalog = usePermission("catalog.read")
  const [moreOpen, setMoreOpen] = useState(false)

  const locale = result.locale
  const money: Money = (cents) => formatMoney(cents, currency, locale)
  // Las filas van sin símbolo, como en el tablero; las cifras destacadas lo conservan.
  const plain: Money = (cents) => plainAmount(cents, currency, locale)
  const bucket = result.byCurrency.find((item) => item.currency === currency) ?? {
    ...EMPTY_BUCKET,
    currency,
  }
  const hasMovement = result.byCurrency.some((item) => item.currency === currency)
  const discounted = bucket.devolucionesCents + bucket.anulacionesCents
  const limit = isMobile ? MOBILE_ROWS : undefined
  const level = heading ? "h4" : "h3"

  const methods = toBars(
    bucket.byMethod,
    (row) => ({ key: row.key, label: row.label, cents: row.cents }),
    bucket.netoCents,
  )
  const professionals = result.byProfessional.filter((row) => row.currency === currency)
  const professionalTotal = sum(professionals.map((row) => Math.max(0, row.cobradoCents)))
  const professionalBars = toBars(
    professionals,
    (row) => ({
      key: row.professionalUserId,
      label: row.name ?? "Profesional fuera del equipo",
      cents: row.cobradoCents,
    }),
    professionalTotal,
  )
  const categories = toBars(
    bucket.byCategory,
    (row) => ({ key: row.category, label: row.category, cents: row.cents }),
    bucket.gastadoCents,
  )
  const promotions = result.byPromotion.filter((row) => row.currency === currency)
  const outstanding = result.outstanding.find((row) => row.currency === currency) ?? null
  const cashNote = cashAgainstClosures(result, bucket, money)

  const byMethod = (
    <ResultCard title="Cobrado por medio de pago" level={level}>
      {methods.length === 0 ? (
        <EmptyState
          title="Sin cobros"
          description="No se cobró nada en este mes."
          actionLabel={canFinance ? "Ir a Finanzas" : undefined}
          onAction={() => void navigate({ to: "/finance" })}
        />
      ) : (
        <BarList rows={methods} money={plain} showShare limit={limit} />
      )}
      {cashNote ? (
        <p className={`text-sm ${cashNote.matches ? "text-muted-foreground" : "font-medium"}`}>
          {cashNote.text}
        </p>
      ) : null}
    </ResultCard>
  )
  const byProfessional = (
    <ResultCard title="Cobrado por profesional" level={level}>
      {professionalBars.length === 0 ? (
        <EmptyState
          title="Sin cobros de atenciones"
          description="Lo cobrado en este mes no corresponde a tratamientos que alguien atendió."
        />
      ) : (
        <BarList rows={professionalBars} money={plain} showShare limit={limit} />
      )}
      <p className="text-sm text-muted-foreground">
        Según quién atendió cada tratamiento cobrado.
        {professionalBars.length > 0 && professionalTotal < bucket.netoCents
          ? " Lo cobrado sin atención no cuenta para ningún profesional."
          : ""}
      </p>
    </ResultCard>
  )
  const byCategory = (
    <ResultCard title="Gastado por tipo" level={level}>
      {categories.length === 0 ? (
        <EmptyState
          title="Sin gastos"
          description="No se registró ningún gasto en este mes."
          actionLabel={canExpense ? "Registrar un gasto" : undefined}
          onAction={() => void navigate({ to: "/finance", search: { tab: "gastos" } })}
        />
      ) : (
        <BarList rows={categories} money={plain} limit={limit} />
      )}
    </ResultCard>
  )
  const byPromotion = (
    <ResultCard title="Promociones" level={level} className="@6xl:col-span-2">
      {promotions.length === 0 ? (
        <EmptyState
          title="Sin promociones cobradas"
          description="Cuando se cobre con una promoción, aparece aquí con sus veces y su importe."
          actionLabel={canCatalog ? "Ver promociones" : undefined}
          onAction={() => void navigate({ to: "/services/promotions" })}
        />
      ) : (
        <ul className="flex min-w-0 flex-col divide-y">
          {promotions.map((row) => (
            <li
              key={row.promotionId}
              className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2 text-sm first:pt-0 last:pb-0"
            >
              <span className="min-w-0 flex-1 basis-40 font-medium">{row.name}</span>
              <span className="shrink-0 text-muted-foreground">
                {row.veces} {row.veces === 1 ? "vez" : "veces"}
                {/* Solo en las promociones «desde»: su precio cambia en cada caso. */}
                {row.mode === "from" && row.averageCents != null
                  ? ` · precio promedio ${plain(row.averageCents)}`
                  : ""}
              </span>
              <span className="shrink-0 tabular-nums">{plain(row.cobradoCents)}</span>
            </li>
          ))}
        </ul>
      )}
    </ResultCard>
  )
  const stillOwed = (
    <ResultCard
      title={isCurrentMonth ? "Queda por cobrar hasta hoy" : "Quedó por cobrar al terminar el mes"}
      level={level}
      className="@3xl:col-span-2 @6xl:col-span-1"
    >
      <p className="text-2xl leading-tight font-bold tracking-tight tabular-nums">
        {money(outstanding?.pendienteCents ?? 0)}
      </p>
      <p className="text-sm text-muted-foreground">
        {outstanding
          ? `${outstanding.pacientes} ${outstanding.pacientes === 1 ? "persona debe" : "personas deben"}`
          : isCurrentMonth
            ? "Nadie debe."
            : "Nadie quedó debiendo."}
      </p>
      {outstanding && canFinance ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/finance" search={{ tab: "deudas" }} />}
          >
            Ver quién debe
          </Button>
        </div>
      ) : null}
    </ResultCard>
  )

  return (
    <section
      aria-labelledby={heading ? headingId : undefined}
      aria-label={heading ? undefined : "Resultado"}
      className="flex min-w-0 flex-col gap-4"
    >
      {heading ? (
        <h3 id={headingId} className="text-base font-semibold">
          {heading}
        </h3>
      ) : null}

      <div className="grid min-w-0 gap-3 @4xl:grid-cols-3">
        <KpiCard
          title="Cobrado"
          value={money(bucket.netoCents)}
          description={
            discounted > 0
              ? `Ya descontadas las devoluciones (${money(discounted)})`
              : "Ya descontadas las devoluciones"
          }
        />
        <KpiCard
          title="Gastado"
          value={money(bucket.gastadoCents)}
          description="Los gastos registrados en el mes"
        />
        {/* En teléfono, lo que queda va primero: es la respuesta que se busca. */}
        <KpiCard
          className="order-first @4xl:order-none"
          title="Queda"
          value={money(bucket.quedaCents)}
          description={
            bucket.quedaCents < 0 ? "Se gastó más de lo que se cobró" : "Cobrado menos gastado"
          }
        />
      </div>

      {!hasMovement ? (
        <>
          <EmptyState
            title="Sin cobros ni gastos"
            description="En este mes no hubo movimientos en esta moneda; solo queda lo que se debía."
          />
          {stillOwed}
        </>
      ) : isMobile ? (
        <div className="flex min-w-0 flex-col gap-4">
          {byMethod}
          {byCategory}
          <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
            <CollapsibleTrigger
              render={<Button type="button" variant="outline" className="w-full justify-between" />}
            >
              Por profesional y por promoción
              <ChevronDown
                aria-hidden
                className={moreOpen ? "rotate-180 transition-transform" : "transition-transform"}
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="flex min-w-0 flex-col gap-4 pt-4">
                {byProfessional}
                {byPromotion}
              </div>
            </CollapsibleContent>
          </Collapsible>
          {stillOwed}
        </div>
      ) : (
        <div className="grid min-w-0 gap-4 @3xl:grid-cols-2 @6xl:grid-cols-3">
          {byMethod}
          {byProfessional}
          {byCategory}
          {byPromotion}
          {stillOwed}
        </div>
      )}
    </section>
  )
}

/**
 * El efectivo del mes frente a los cierres de caja hechos en el mes. Solo se
 * afirma que coincide cuando coincide; si no, se dice cuánto falta o sobra.
 */
function cashAgainstClosures(
  result: MonthlyFinanceResult,
  bucket: MonthlyResultBucket,
  money: Money,
): { matches: boolean; text: string } | null {
  const closure = result.closures.find((row) => row.currency === bucket.currency) ?? null
  const hasCash = bucket.byMethod.some((row) => row.cash)
  if (!closure) {
    return hasCash && bucket.efectivoCents !== 0
      ? {
          matches: false,
          text: "Aún no hay cierres de caja en este mes para comparar con el efectivo.",
        }
      : null
  }
  // Los cierres guardan aparte lo cobrado y lo devuelto en efectivo: se compara el neto.
  const closedCash = closure.efectivoCents - closure.efectivoDevueltoCents
  const difference = Math.abs(bucket.efectivoCents - closedCash)
  if (difference === 0) {
    return {
      matches: true,
      text: "El efectivo coincide con la suma de los cierres de caja del mes.",
    }
  }
  return {
    matches: false,
    text: `El efectivo del mes (${money(bucket.efectivoCents)}) no coincide con la suma de los cierres de caja (${money(closedCash)}): hay ${money(difference)} de diferencia. Puede haber una caja sin cerrar o un cierre que abarca días de otro mes.`,
  }
}

function ResultCard({
  title,
  level,
  className,
  children,
}: {
  title: string
  level: "h3" | "h4"
  className?: string
  children: ReactNode
}) {
  const id = useId()
  const Heading = level
  return (
    <section
      aria-labelledby={id}
      className={`elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5 ${className ?? ""}`}
    >
      <Heading id={id} className="font-semibold">
        {title}
      </Heading>
      {children}
    </section>
  )
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
  limit,
}: {
  rows: BarRow[]
  money: Money
  showShare?: boolean
  limit?: number
}) {
  const [expanded, setExpanded] = useState(false)
  // Agrupar solo vale la pena si esconde más de una fila.
  const groups = limit !== undefined && rows.length > limit + 1
  const collapsed = groups && !expanded
  const visible = collapsed ? rows.slice(0, limit) : rows
  const rest = collapsed ? rows.slice(limit) : []

  return (
    <ul className="flex min-w-0 flex-col gap-3">
      {visible.map((row) => (
        <li key={row.key} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-baseline gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
            {showShare ? (
              <span className="shrink-0 text-muted-foreground tabular-nums">{row.share} %</span>
            ) : null}
            <span className="shrink-0 tabular-nums">{money(row.cents)}</span>
          </div>
          <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className="h-full rounded-full bg-primary" style={{ width: `${row.share}%` }} />
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
            className="-mx-2 h-auto w-[calc(100%+1rem)] min-w-0 justify-start gap-2 px-2 py-1.5 text-left font-normal"
            onClick={() => setExpanded((value) => !value)}
          >
            {collapsed ? (
              <>
                <span className="min-w-0 flex-1 truncate font-medium">Otros {rest.length}</span>
                {showShare ? (
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {sum(rest.map((row) => row.share))} %
                  </span>
                ) : null}
                <span className="shrink-0 tabular-nums">
                  {money(sum(rest.map((row) => row.cents)))}
                </span>
              </>
            ) : (
              <span className="font-medium">Ver menos</span>
            )}
          </Button>
        </li>
      ) : null}
    </ul>
  )
}
