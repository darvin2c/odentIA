/**
 * Reportes › Finanzas › Qué dejó cada promoción (tablero 2b): si trajo gente
 * nueva o solo le bajó el precio a quien igual iba a venir. Cada promoción con
 * quiénes la usaron (nuevas y ya pacientes, a la misma escala), lo que pagaron
 * desde entonces, el descuento frente a la tarifa y su veredicto; al lado, su
 * recorrido. Presupuestos y cobros son de la persona: no se filtra por sede.
 */
import { formatMoney } from "@odentia/clinical"
import { Button, cn } from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { EmptyState, SkeletonRegion } from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { AlertTriangle, ArrowLeft, Check } from "lucide-react"
import { useState } from "react"
import { usePermission } from "../../lib/crm"
import { QueryErrorState } from "../../lib/query-error"
import { fetchReport, rateOf, reportKey, type ReportPromotions, type ReportQuery, spanLabel } from "../../lib/reports"
import { PromotionsCardBodySkeleton, PromotionsViewSkeleton } from "../skeletons/reports"
import { EmptyLine, ReportCard, WHOLE_CLINIC } from "./report-parts"
import { Link } from "@tanstack/react-router"

type Promotion = ReportPromotions["promotions"][number]

function usePromotions(query: ReportQuery) {
  return useQuery({ queryKey: reportKey("finance/promotions", query), queryFn: () => fetchReport<ReportPromotions>("finance/promotions", query), placeholderData: keepPreviousData, retry: false })
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** El veredicto con su marca: nunca solo con color. */
function Verdict({ promotion, className }: { promotion: Promotion; className?: string }) {
  const bad = promotion.verdict === "solo_bajo_precio"
  const Icon = bad ? AlertTriangle : Check
  const text =
    promotion.verdict === "solo_bajo_precio"
      ? "Solo bajó el precio"
      : promotion.verdict === "trajo_nuevos"
        ? promotion.returned > 0
          ? `Trajo nuevos; ${promotion.returned} ${promotion.returned === 1 ? "volvió" : "volvieron"} por más`
          : "Trajo pacientes nuevos"
        : `${promotion.returned} ${promotion.returned === 1 ? "volvió" : "volvieron"} por más`
  return (
    <span className={cn("inline-flex items-center gap-1 text-[13px] font-bold", bad ? "text-warning" : "text-success", className)}>
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />
      {text}
    </span>
  )
}

function datesOf(promotion: Promotion, locale: string, timezone: string, now: Date): string {
  const day = (iso: string) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: timezone }).format(new Date(iso)).replace(/\./g, "")
  if (!promotion.startsAt) return ""
  if (!promotion.endsAt) return `Desde el ${day(promotion.startsAt)} · sigue activa`
  const ended = new Date(promotion.endsAt).getTime() < now.getTime()
  return `${day(promotion.startsAt)} – ${day(promotion.endsAt)} · ${ended ? "terminó" : "sigue activa"}`
}

/** La tarjeta de Finanzas: cuánto se dejó de cobrar y a quién llegó. */
export function PromotionsCard({ query, onOpen }: { query: ReportQuery; onOpen: () => void }) {
  const report = usePromotions(query)
  const canCatalog = usePermission("catalog.read")
  if (report.isPending)
    return (
      <ReportCard title="Promociones y descuentos">
        <SkeletonRegion message="Cargando las promociones…" className="flex min-w-0 flex-col gap-3">
          <PromotionsCardBodySkeleton />
        </SkeletonRegion>
      </ReportCard>
    )
  if (report.isError)
    return (
      <ReportCard title="Promociones y descuentos">
        <QueryErrorState error={report.error} onRetry={() => void report.refetch()} />
      </ReportCard>
    )
  const data = report.data.data
  const money = (cents: number) => formatMoney(cents, data.currency, data.locale)
  const total = data.discountCents + data.loose.cents
  return (
    <ReportCard title="Promociones y descuentos" note={data.wholeClinic.includes("promotions") ? WHOLE_CLINIC : undefined}>
      {data.promotions.length === 0 && data.loose.count === 0 ? (
        <EmptyLine
          action={
            canCatalog ? (
              <Link to="/services/promotions" className="font-semibold text-primary-soft-foreground underline">
                Ver promociones
              </Link>
            ) : undefined
          }
        >
          Nadie usó una promoción ni recibió un descuento en este periodo.
        </EmptyLine>
      ) : (
        <>
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-bold text-muted-foreground">Dejaste de cobrar</span>
            <span className="text-[26px] font-extrabold tracking-tight tabular-nums">{money(total)}</span>
            <span className="text-[13px] text-muted-foreground">Frente a tus precios de tarifa, en lo que se aceptó o se cobró.</span>
          </div>
          <ul className="flex min-w-0 flex-col gap-1.5 text-sm">
            {data.promotions.map((promotion) => (
              <li key={promotion.promotionId} className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="min-w-0">
                  {promotion.name}
                  {promotion.verdict === "solo_bajo_precio" ? <span className="font-bold text-warning"> · solo bajó el precio</span> : null}
                </span>
                <strong className="shrink-0 tabular-nums">{money(promotion.discountCents)}</strong>
              </li>
            ))}
            {data.loose.count > 0 ? (
              <li className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Descuentos sueltos ({data.loose.count})</span>
                <strong className="shrink-0 tabular-nums">{money(data.loose.cents)}</strong>
              </li>
            ) : null}
          </ul>
          {data.people > 0 ? (
            <p className="text-sm text-foreground/80">
              {data.fresh} de las {plural(data.people, "persona que usó", "personas que usaron")} una promoción {data.fresh === 1 ? "era nueva" : "eran nuevas"}.
            </p>
          ) : null}
          {data.promotions.length > 0 ? (
            <Button type="button" variant="link" className="h-auto min-h-11 justify-start p-0 text-[13px] font-bold sm:min-h-8" onClick={onOpen}>
              Ver qué dejó cada promoción
            </Button>
          ) : null}
        </>
      )}
    </ReportCard>
  )
}

/** La vista entera de promociones, dentro de Finanzas (`?vista=promociones`). */
export function PromotionsView({ query, onBack }: { query: ReportQuery; onBack: () => void }) {
  const report = usePromotions(query)
  const [selected, setSelected] = useState<string | null>(null)
  const back = (
    <Button type="button" variant="ghost" className="self-start" onClick={onBack}>
      <ArrowLeft aria-hidden />
      Volver a Finanzas
    </Button>
  )
  if (report.isPending)
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {back}
        <SkeletonRegion message="Cargando las promociones…">
          <PromotionsViewSkeleton />
        </SkeletonRegion>
      </div>
    )
  if (report.isError)
    return (
      <div className="flex flex-col gap-3">
        {back}
        <QueryErrorState error={report.error} onRetry={() => void report.refetch()} />
      </div>
    )
  const data = report.data.data
  const { locale, currency, timezone } = data
  const money = (cents: number) => formatMoney(cents, currency, locale)
  const now = new Date()
  const chosen = data.promotions.find((promotion) => promotion.promotionId === selected) ?? data.promotions[0] ?? null
  const most = Math.max(1, ...data.promotions.map((promotion) => promotion.people))
  const intro = (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="text-lg font-bold tracking-tight">Qué dejó cada promoción</h3>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Si trajo gente nueva o solo le bajó el precio a quien igual iba a venir. Toca una promoción para ver su recorrido. {spanLabel(data.period, locale).replace(/^./, (letter) => letter.toLocaleUpperCase(locale))}
        {data.wholeClinic.includes("promotions") ? ` · ${WHOLE_CLINIC}` : ""}.
      </p>
    </div>
  )
  if (data.promotions.length === 0)
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {back}
        {intro}
        <EmptyState title="Nadie usó una promoción en este periodo" description="Una promoción cuenta cuando un presupuesto presentado o un cobro del periodo la lleva." />
      </div>
    )
  const steps = chosen
    ? [
        { label: "Usaron la promoción", value: chosen.people },
        { label: "Aceptaron el tratamiento", value: chosen.accepted },
        { label: "Pagaron algo", value: chosen.paidSome },
        { label: "Volvieron por otro tratamiento", value: chosen.returned },
      ]
    : []
  const reading = (promotion: Promotion): string => {
    if (promotion.verdict === "solo_bajo_precio")
      return `${promotion.people === 1 ? "Quien la usó ya era paciente" : `Los ${promotion.people} que la usaron ya eran pacientes`} y nadie volvió por otro tratamiento: se dio ${money(promotion.discountCents)} de descuento a quien igual iba a venir.`
    const accepted = `${promotion.accepted} ${promotion.accepted === 1 ? "aceptó" : "aceptaron"}`
    const returned = promotion.returned > 0 ? ` ${promotion.returned} ${promotion.returned === 1 ? "volvió" : "volvieron"} por otro tratamiento.` : ""
    const fresh = promotion.fresh > 0 ? `${promotion.fresh} ${promotion.fresh === 1 ? "era nueva" : "eran nuevas"}` : "ninguna era nueva"
    return `De ${plural(promotion.people, "persona que la usó", "personas que la usaron")}, ${fresh} y ${accepted}.${returned} Pagaron ${money(promotion.collectedCents)} desde que la usaron.`
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {back}
      {intro}
      <section aria-label="Cifras de promociones" className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { title: "Personas que usaron una", value: String(data.people), note: `En ${plural(data.promotions.length, "promoción", "promociones")}` },
          { title: "Eran nuevas", value: `${data.fresh}${rateOf(data.fresh, data.people) !== null ? ` · ${rateOf(data.fresh, data.people)} %` : ""}`, note: "Sin una cita atendida antes de usarla" },
          { title: "Cobrado a quienes las usaron", value: money(data.collectedCents), note: "Con la promoción y lo que vino después, hasta hoy" },
          { title: "Descuento dado", value: money(data.discountCents), note: "Frente a tus precios de tarifa, en lo aceptado" },
        ].map((card) => (
          <div key={card.title} className="elevated flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card px-4 py-3.5">
            <span className="text-[13px] font-bold text-muted-foreground">{card.title}</span>
            <span className="truncate text-[24px] font-extrabold tracking-tight tabular-nums">{card.value}</span>
            <span className="text-[13px] text-muted-foreground">{card.note}</span>
          </div>
        ))}
      </section>
      <div className="flex min-w-0 flex-wrap items-start gap-4">
        <section aria-label="Promociones" className="elevated min-w-0 flex-[1_1_560px] overflow-hidden rounded-xl border bg-card">
          <div className="hidden grid-cols-[minmax(0,1.5fr)_minmax(150px,1.2fr)_96px_96px_minmax(0,1.3fr)] border-b bg-muted/50 text-xs font-bold text-muted-foreground md:grid">
            <span className="px-3.5 py-2.5">Promoción</span>
            <span className="px-3.5 py-2.5">Quiénes la usaron</span>
            <span className="px-3.5 py-2.5 text-right">Cobrado</span>
            <span className="px-3.5 py-2.5 text-right">Descuento</span>
            <span className="px-3.5 py-2.5">¿Funcionó?</span>
          </div>
          {/* Una sola elegida a la vez: las flechas recorren la lista y tocar la elegida no la quita. */}
          <ToggleGroup
            aria-label="Elige una promoción para ver su recorrido"
            orientation="vertical"
            value={chosen ? [chosen.promotionId] : []}
            onValueChange={(next: unknown[]) => {
              const picked = next[0]
              if (typeof picked === "string") setSelected(picked)
            }}
            className="w-full min-w-0 gap-0 divide-y rounded-none"
          >
            {data.promotions.map((promotion) => {
              const width = (promotion.people / most) * 100
              return (
                <ToggleGroupItem
                  key={promotion.promotionId}
                  value={promotion.promotionId}
                  className="grid h-auto w-full min-w-0 grid-cols-1 items-stretch justify-start gap-1.5 rounded-none px-3.5 py-3 text-left text-sm font-normal whitespace-normal hover:bg-muted/40 aria-pressed:bg-primary-soft md:grid-cols-[minmax(0,1.5fr)_minmax(150px,1.2fr)_96px_96px_minmax(0,1.3fr)] md:items-center md:gap-0 md:px-0 md:py-0"
                >
                  <span className="flex min-w-0 flex-col md:px-3.5 md:py-3">
                    <strong>{promotion.name}</strong>
                    <span className="text-xs text-muted-foreground">{datesOf(promotion, locale, timezone, now)}</span>
                  </span>
                  <span className="flex min-w-0 flex-col gap-1 md:px-3.5 md:py-3">
                    <span aria-hidden className="flex h-3 gap-0.5" style={{ width: `${Math.max(6, width)}%` }}>
                      {promotion.fresh > 0 ? <span className="h-full rounded-l-[3px] bg-series-1" style={{ flex: `${promotion.fresh} 1 0` }} /> : null}
                      {promotion.people - promotion.fresh > 0 ? <span className="h-full rounded-r-[3px] bg-secondary" style={{ flex: `${promotion.people - promotion.fresh} 1 0` }} /> : null}
                    </span>
                    <span className="text-xs text-foreground/80">
                      {plural(promotion.people, "persona", "personas")} · {promotion.fresh} {promotion.fresh === 1 ? "nueva" : "nuevas"}
                    </span>
                  </span>
                  <span className="flex justify-between gap-2 md:block md:px-3.5 md:py-3 md:text-right">
                    <span className="text-muted-foreground md:hidden">Cobrado</span>
                    <strong className="tabular-nums">{money(promotion.collectedCents)}</strong>
                  </span>
                  <span className="flex justify-between gap-2 md:block md:px-3.5 md:py-3 md:text-right">
                    <span className="text-muted-foreground md:hidden">Descuento</span>
                    <strong className="tabular-nums text-warning">{money(promotion.discountCents)}</strong>
                  </span>
                  <span className="md:px-3.5 md:py-3">
                    <Verdict promotion={promotion} />
                  </span>
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
          <div className="flex flex-wrap items-center gap-4 border-t px-3.5 py-3 text-xs text-foreground/80">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-[3px] bg-series-1" />
              Nuevas
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-[3px] bg-secondary" />
              Ya eran pacientes
            </span>
            <span className="ml-auto">La barra de cada promoción mide a cuántas personas la usaron, a la misma escala.</span>
          </div>
        </section>
        {chosen ? (
          <aside aria-live="polite" aria-label="Recorrido de la promoción" className="elevated flex min-w-0 flex-[0_1_360px] flex-col gap-3 rounded-xl border bg-card p-[18px]">
            <strong className="text-base">{chosen.name}</strong>
            <span className="-mt-2 text-[13px] text-muted-foreground">{datesOf(chosen, locale, timezone, now)}</span>
            {steps.map((step) => (
              <div key={step.label} className="flex flex-col gap-1">
                <span className="flex justify-between text-sm">
                  <span className="font-semibold">{step.label}</span>
                  <strong className="tabular-nums">{step.value}</strong>
                </span>
                <span aria-hidden className="h-4 rounded-r bg-secondary">
                  <span
                    className={cn("block h-full rounded-r", chosen.verdict === "solo_bajo_precio" ? "bg-series-2" : "bg-primary")}
                    style={{ width: `${chosen.people > 0 ? (step.value / chosen.people) * 100 : 0}%` }}
                  />
                </span>
              </div>
            ))}
            <p className={cn("rounded-lg px-3 py-2.5 text-sm", chosen.verdict === "solo_bajo_precio" ? "bg-warning-soft text-warning" : "bg-primary-soft text-primary-soft-foreground")}>
              {reading(chosen)}
            </p>
          </aside>
        ) : null}
      </div>
      <section aria-label="Cómo se cuenta" className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Usó la promoción:", "un presupuesto presentado o un cobro suyo del periodo la lleva. Si nadie la marcó al presupuestar o cobrar, no aparece."],
          ["Nueva:", "no tenía ninguna cita atendida antes de usarla."],
          ["Volvió por más:", "tuvo otro cargo, sin esa promoción, después de usarla."],
          ["Descuento:", "precio de tarifa menos precio acordado, solo en lo aceptado o cobrado. En una «desde», contra el precio de tarifa, no contra el «desde»."],
        ].map(([title, text]) => (
          <p key={title} className="rounded-xl border bg-card px-3.5 py-3 text-[13px]">
            <strong>{title}</strong> {text}
          </p>
        ))}
      </section>
    </div>
  )
}
