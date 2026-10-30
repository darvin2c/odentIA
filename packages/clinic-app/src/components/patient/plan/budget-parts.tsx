/**
 * Piezas comunes del presupuesto en la pestaña Plan: importes con el formato
 * de la clínica, totales, líneas y la nota de lo que se cobra por sesión. Los
 * importes llegan calculados del servidor (`lineTotalCents`, `totalCents`,
 * `discountCents`, `acceptedCents`): aquí se muestran, no se recalculan.
 */
import { formatMoney, formatMoneyAmount } from "@odentia/clinical"
import { Badge, cn } from "@odentia/ui"
import {
  type BudgetLine,
  type BudgetOption,
  type BudgetWithTotals,
  budgetAnswerLabel,
} from "../../../lib/budgets"
import { label as glossaryLabel } from "../../../lib/glossary"
import { useOrgProfile } from "../../../lib/org"

/**
 * Importe con la moneda y el formato de la clínica. `plain` es el mismo importe
 * sin símbolo, para las cifras de una lista cuyo total ya dice la moneda.
 */
export type Money = ((cents: number | null, currency: string) => string) & {
  plain: (cents: number | null, currency: string) => string
}

/** Importes y fechas con el formato y la zona de la clínica. */
export function useBudgetFormat(): {
  money: Money
  locale: string | undefined
  timeZone: string | undefined
  localePending: boolean
  retryLocale: () => void
  /** «15 oct». */
  day: (iso: string | null | undefined) => string
} {
  const profile = useOrgProfile()
  const locale = profile.data?.locale
  const timeZone = profile.data?.timezone
  const money: Money = Object.assign(
    (cents: number | null, currency: string) =>
      cents == null || !locale ? "…" : formatMoney(cents, currency, locale),
    {
      plain: (cents: number | null, currency: string) =>
        cents == null || !locale ? "…" : formatMoneyAmount(cents, currency, locale),
    },
  )
  const day = (iso: string | null | undefined) => {
    if (!iso) return "—"
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return "—"
    return date.toLocaleDateString(locale, { day: "numeric", month: "short", timeZone }).replace(".", "")
  }
  return {
    money,
    locale,
    timeZone,
    localePending: profile.isPending,
    retryLocale: () => void profile.refetch(),
    day,
  }
}

/** Sitio clínico resumido de un ítem o línea (nunca inventa piezas). */
export function treatmentSiteLabel(site: {
  scope: string | null
  toothNumber: number | null
  surfaces: string[]
  quadrant: number | null
  arch: string | null
}): string {
  if (site.scope === "tooth" && site.toothNumber != null) return `Pieza ${site.toothNumber}`
  if (site.scope === "surfaces" && site.toothNumber != null) {
    const extra = site.surfaces.length > 0 ? ` (${site.surfaces.join(", ")})` : ""
    return `Pieza ${site.toothNumber}${extra}`
  }
  if (site.scope === "quadrant" && site.quadrant != null) return `Cuadrante ${site.quadrant}`
  if (site.scope === "arch" && site.arch === "upper") return "Arcada superior"
  if (site.scope === "arch" && site.arch === "lower") return "Arcada inferior"
  // La vista económica (caja) no recibe el sitio: no se dice «General».
  if (site.scope === "tooth" || site.scope === "surfaces" || site.scope === "quadrant" || site.scope === "arch")
    return ""
  return "General"
}

export const AMOUNT_PENDING = "Falta el precio de algún tratamiento"

export type BadgeTone = "secondary" | "warning" | "success" | "destructive" | "outline"

export function budgetStatusTone(status: string): BadgeTone {
  switch (status) {
    case "borrador":
      return "secondary"
    case "presentado":
    case "pospuesto":
      return "warning"
    case "aceptado":
    case "parcial":
      return "success"
    case "rechazado":
      return "destructive"
    default:
      return "outline"
  }
}

export function answerTone(decision: string): BadgeTone {
  if (decision === "aceptado") return "success"
  if (decision === "rechazado") return "destructive"
  if (decision === "pospuesto") return "warning"
  if (decision === "no_elegida") return "outline"
  return "secondary"
}

export function isSessionLine(line: BudgetLine): boolean {
  return line.billingMode === "session"
}

/** Con precio fijo de promoción el importe no se negocia (lo rechaza el servidor). */
export function hasFixedPromotion(line: BudgetLine): boolean {
  return line.promotionId != null && line.promotionMode === "fixed"
}

/** El precio guardado quedó por debajo de la tarifa de referencia. */
export function isBelowTariff(line: BudgetLine): boolean {
  return (
    line.priceCents != null && line.tariffPriceCents != null && line.priceCents < line.tariffPriceCents
  )
}

/** «a», «a y b», «a, b y c». */
export function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("")
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`
}

/** Cómo se cobra la línea: una vez o en cada visita. */
export function billingNote(line: BudgetLine, money: Money, withVisits: boolean): string {
  if (!isSessionLine(line)) return "Se cobra una vez"
  const each =
    line.priceCents == null
      ? "Se cobra por sesión, en cada visita"
      : `Se cobra por sesión: ${money.plain(line.priceCents, line.currency)} en cada visita`
  if (!withVisits || line.sessionsPlanned == null) return each
  return `${each} · ${line.sessionsPlanned} ${line.sessionsPlanned === 1 ? "visita prevista" : "visitas previstas"}`
}

/** Aclaración bajo el total cuando algo se cobra por sesión: el total no es deuda. */
export function sessionExplanation(lines: BudgetLine[], money: Money): string | null {
  const perVisit = lines.filter(isSessionLine)
  if (perVisit.length === 0) return null
  const parts = perVisit.map((line) =>
    line.priceCents == null
      ? `cada visita de «${line.title}»`
      : `${money.plain(line.priceCents, line.currency)} en cada visita de «${line.title}»`,
  )
  const once = lines.length > perVisit.length ? "lo que se cobra una vez cuando se atiende, y " : ""
  return `La persona ve el total, pero no lo debe todo desde el primer día: paga ${once}${joinList(parts)}.`
}

/** Totales de una opción (o del presupuesto con una sola): precio normal, descuento y total. */
export function BudgetTotals({
  option,
  lines,
  currency,
  money,
  className,
}: {
  option: Pick<BudgetOption, "totalCents" | "tariffTotalCents" | "discountCents">
  lines: BudgetLine[]
  currency: string
  money: Money
  className?: string
}): React.JSX.Element {
  const hasSessions = lines.some(isSessionLine)
  return (
    <dl className={cn("flex flex-col gap-1.5 rounded-xl bg-muted/50 p-4 text-sm", className)}>
      <div className="flex gap-3">
        <dt className="flex-1 text-muted-foreground">Precio normal</dt>
        <dd className="text-right tabular-nums">
          {option.tariffTotalCents == null ? AMOUNT_PENDING : money.plain(option.tariffTotalCents, currency)}
        </dd>
      </div>
      {option.discountCents != null && option.discountCents > 0 ? (
        <div className="flex gap-3">
          <dt className="flex-1 text-muted-foreground">Descuento</dt>
          <dd className="text-right tabular-nums">−&nbsp;{money.plain(option.discountCents, currency)}</dd>
        </div>
      ) : null}
      <div className="flex items-baseline gap-3 border-t pt-2">
        <dt className="flex-1 font-semibold">{hasSessions ? "Total del tratamiento" : "Total"}</dt>
        <dd className="text-right text-xl font-semibold tabular-nums">
          {option.totalCents == null ? AMOUNT_PENDING : money(option.totalCents, currency)}
        </dd>
      </div>
    </dl>
  )
}

export function SessionNote({ lines, money }: { lines: BudgetLine[]; money: Money }): React.JSX.Element | null {
  const text = sessionExplanation(lines, money)
  return text ? <p className="text-sm text-muted-foreground">{text}</p> : null
}

/** Líneas de una opción ya entregada (o de un borrador que no se puede editar). */
export function BudgetLinesList({
  lines,
  money,
  showAnswers,
  label = "Tratamientos del presupuesto",
}: {
  lines: BudgetLine[]
  money: Money
  showAnswers: boolean
  label?: string
}): React.JSX.Element {
  return (
    <ul aria-label={label} className="flex flex-col divide-y rounded-xl border">
      {lines.map((line) => {
        const site = treatmentSiteLabel(line)
        return (
          <li key={line.id} className="flex flex-col gap-2 px-3 py-3">
            <div className="flex items-start gap-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium">{line.title}</span>
                <span className="text-xs text-muted-foreground">
                  {[site, billingNote(line, money, true)].filter(Boolean).join(" · ")}
                </span>
                {line.promotionName ? (
                  <span className="text-xs text-muted-foreground">Promoción: {line.promotionName}</span>
                ) : null}
                {line.priceReason ? (
                  <span className="text-xs text-muted-foreground">Motivo del ajuste: {line.priceReason}</span>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-col items-end">
                <span className="font-semibold whitespace-nowrap tabular-nums">
                  {line.lineTotalCents == null ? "Sin precio" : money.plain(line.lineTotalCents, line.currency)}
                </span>
                {isBelowTariff(line) && line.tariffLineTotalCents != null ? (
                  <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                    <span className="sr-only">Precio normal: </span>
                    <span className="line-through">{money.plain(line.tariffLineTotalCents, line.currency)}</span>
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {showAnswers ? <Badge variant={answerTone(line.decision)}>{budgetAnswerLabel(line.decision)}</Badge> : null}
              <Badge variant="outline">{glossaryLabel("tratamiento", line.itemStatus)}</Badge>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** «Opción A · recomendada · S/ 540», el encabezado de una opción. */
export function optionHeading(option: BudgetOption, budget: BudgetWithTotals, money: Money): string {
  const state =
    option.decision === "elegida" ? " · elegida" : option.decision === "no_elegida" ? " · no elegida" : ""
  return `${option.label}${option.isRecommended ? " · recomendada" : ""}${state} · ${
    option.totalCents == null ? AMOUNT_PENDING : money(option.totalCents, budget.currency)
  }`
}
