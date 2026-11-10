import { appWords } from "../../lib/product-words"
/**
 * Comisiones: lo que le corresponde a cada profesional por lo que atendió y ya
 * se cobró.
 *
 * - `CommissionsAdminPanel` (quien administra): el mes de toda la clínica, el
 *   detalle de cada profesional, su porcentaje, el pago en un solo paso y la
 *   anulación de un pago.
 * - `MyCommissionsPanel` (cada profesional): solo lo suyo, pensado para teléfono.
 *
 * Importes, estados y permisos los decide el servidor; aquí solo se presentan.
 * La moneda y el formato son los de la clínica y llegan en cada respuesta.
 */
import { currencyWord, formatMoney } from "@odentia/clinical"
import {
  Badge,
  Button,
  Checkbox,
  cn,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@odentia/ui"
import {
  DetailDrawer,
  EmptyState,
  FormChoiceField,
  FormDrawer,
  PersonAvatar,
  useAppForm,
  useFormSurface,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { z } from "zod"
import { useStore } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Check, ChevronRight, Percent } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { useActiveBranch } from "../../lib/active-branch"
import {
  agreementWords,
  calculationGroups,
  type CommissionLine,
  type CommissionPayment,
  type CommissionStatus,
  commissionStatusLabel,
  compareMonths,
  currentMonthIn,
  dayLabel,
  fetchCommissionPayments,
  fetchCommissionsOwed,
  fetchMonthCommissions,
  fetchMyCommissions,
  fetchProfessionalCommissions,
  fetchUnassignedCommissionSessions,
  type CommissionSummary,
  type MonthlyCommissions,
  monthLabel,
  monthName,
  payMonthCommissionApi,
  percentLabel,
  plainAmount,
  RETURN_METHODS,
  type ReturnMethod,
  returnMethodWords,
  discountFromWords,
  FORGIVE_REASON_MAX,
  settleCommissionDebtApi,
  showAllLabel,
  debtClosureWords,
  previousMonthsDiscounts,
  summaryAmountWords,
  summaryDiscountWords,
  voidCommissionPaymentApi,
  type YearMonth,
} from "../../lib/commissions"
import { useOrgMembers, usePermission } from "../../lib/crm"
import { financeFormMessage } from "../../lib/finance"
import { invalidateFinance, todayIn, useCashState } from "../../lib/finance-cash"
import { CASH_TYPE_CODE, fetchPaymentMethods } from "../../lib/finance-collect"
import { PaymentMethodButtons } from "./collect-drawer"
import { useOrgEvents } from "../../lib/org-events"
import { QueryErrorState } from "../../lib/query-error"
import { ChoiceSelect } from "../ui/choice-select"
import { ChoiceButtons } from "../choice-buttons"
import { AgreementLink, exceptionWords } from "./commission-agreements"
import { CashMoveDrawer } from "./cash-close-drawer"

// La ruta de Comisiones lo importa desde aquí.
export { MonthPicker } from "./MonthPicker"
import { CommissionsMonthSkeleton, MyCommissionsSkeleton } from "../skeletons/commissions"

/** Lo que cambia una comisión sin que esta pantalla lo haga: cobros, anulaciones y atenciones. */
const COMMISSION_EVENT_KINDS = [
  "payment.created",
  "payment.voided",
  "payment.refunded",
  "patient.account.updated",
  "encounter.finalized",
]

/** Cobros a la vista antes de «Ver los N cobros». */
const PREVIEW_ROWS = 4

const commissionKeys = {
  all: ["commissions"] as const,
  month: (period: YearMonth) => ["commissions", "month", period.year, period.month] as const,
  detail: (userId: string, period: YearMonth) =>
    ["commissions", "detail", userId, period.year, period.month] as const,
  payments: (userId: string, period: YearMonth) =>
    ["commissions", "payments", userId, period.year, period.month] as const,
  mine: (period: YearMonth) => ["commissions", "mine", period.year, period.month] as const,
  owed: ["commissions", "owed"] as const,
  unassigned: ["commissions", "unassigned"] as const,
}

/** Una cifra por moneda, juntas: «S/ 1,200.00 y USD 300.00». */
function amountsWords(amounts: Array<{ cents: number; currency: string }>, locale: string): string {
  const words = amounts.map((amount) => formatMoney(amount.cents, amount.currency, locale))
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} y ${words.at(-1)}` : (words[0] ?? "")
}

/** El resumen de cada moneda de una fila: la de la clínica y las demás con algo del mes. */
function summaryCurrencies(row: CommissionSummary): CommissionSummary[] {
  const all = [row, ...(row.others ?? [])]
  const active = all.filter(
    (view) => view.commissionCents > 0 || view.pendingCents > 0 || view.paidCents > 0 || (view.owedCents ?? 0) > 0,
  )
  return active.length > 0 ? active : [row]
}

// --- Piezas compartidas ------------------------------------------------------------

function StatusBadge({ status, baseCents }: { status: CommissionStatus; baseCents: number }) {
  const label = commissionStatusLabel(status, baseCents)
  if (status === "pagado") {
    return (
      <Badge variant="success">
        <Check aria-hidden className="size-3" />
        {label}
      </Badge>
    )
  }
  if (status === "por_pagar") return <Badge variant="warning">{label}</Badge>
  // Se descuenta de lo ya pagado: no es una alarma, es lo que pasa con un cobro anulado.
  if (status === "por_descontar") return <Badge variant="secondary">{label}</Badge>
  return <Badge variant="secondary">{label}</Badge>
}

/**
 * La cuenta de una línea, en una frase: cuándo se cobró, con qué porcentaje y con qué promoción.
 * Con esto se comprueba cada comisión sin salir de la pantalla.
 */
function lineFacts(line: CommissionLine, day: (iso: string) => string, locale: string, currency: string): string {
  return [day(line.occurredAt), ruleWords(line, locale, currency), sessionWords(line), line.promotionName]
    .filter(Boolean)
    .join(" · ")
}

/** La regla que usó la línea: «35 %», «45 % para este servicio» o «monto fijo de 150.00 por cada uno». */
function ruleWords(line: CommissionLine, locale: string, currency: string): string {
  if (line.fixedCents !== null)
    return `monto fijo de ${formatMoney(line.fixedCents, currency, locale)} por cada uno${otherServiceName(line, " · ")}`
  if (line.rateBps === null || (line.rateBps === 0 && !line.forService)) return "sin porcentaje"
  return line.forService ? `${percentLabel(line.rateBps, locale)} ${serviceWords(line)}` : percentLabel(line.rateBps, locale)
}

/**
 * El servicio de la regla, cuando el texto del cobro no lo dice («Endodoncia molar 46» es la
 * endodoncia): así la línea se encuentra en su fila de «Cómo se calcula».
 */
function otherServiceName(line: CommissionLine, prefix: string): string {
  return line.serviceName && line.serviceName !== line.description ? `${prefix}${line.serviceName}` : ""
}

/** «para este servicio» o, si el cobro se llamó de otra forma, «para Endodoncia». */
function serviceWords(line: CommissionLine): string {
  return otherServiceName(line, "para ") || "para este servicio"
}

/** «sesión 2 de 3» en un tratamiento compartido: lo cobrado se reparte igual entre sus sesiones. */
function sessionWords(line: CommissionLine): string | null {
  return line.slice && line.sessions && line.sessions > 1 ? `sesión ${line.slice} de ${line.sessions}` : null
}

/** La clave de una línea: el cobro y, si se reparte por sesiones, su parte. */
function lineKey(line: CommissionLine): string {
  return line.slice ? `${line.applicationId}:${line.slice}` : line.applicationId
}

const LIQUIDATION_HOLDER_ID = "liquidacion-para-imprimir"

/**
 * La liquidación del mes de un profesional, para entregarle (y que haga su recibo): cada cobro con
 * su fecha, paciente, servicio, lo cobrado, el porcentaje y la comisión, y al pie lo que le
 * corresponde, lo pagado, lo descontado y lo que falta. Se arma con texto (nunca HTML del dato) y se
 * imprime como la hoja de un cierre de caja; desde ahí el navegador también la guarda en PDF.
 */
function printLiquidation(
  detail: MonthlyCommissions,
  name: string,
  period: YearMonth,
  locale: string,
  zone: string,
  /** «En dólares», si hay más de una moneda: cada una tiene su hoja. */
  heading: string | null = null,
  /** Hoy, si el mes aún no termina: la hoja dice «al 8 de noviembre» para no tomarse por la final. */
  asOf: string | null = null,
): void {
  document.getElementById(LIQUIDATION_HOLDER_ID)?.remove()
  document.getElementById(`${LIQUIDATION_HOLDER_ID}-estilo`)?.remove()
  const plain = (cents: number) => plainAmount(cents, detail.currency, locale)
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    return node
  }
  const holder = el("div")
  holder.id = LIQUIDATION_HOLDER_ID
  holder.append(
    // Para el profesional son sus honorarios (en Perú entrega recibo por honorarios); la administración sigue diciendo comisiones.
    el(
      "h1",
      `Liquidación de honorarios · ${monthLabel(period, locale)}${asOf ? `, al ${asOf}` : ""}${heading ? ` · ${heading.toLocaleLowerCase(locale)}` : ""}`,
    ),
  )
  holder.append(el("p", name))
  const table = el("table")
  const head = el("tr")
  for (const title of ["Fecha", "Paciente", "Servicio", "Cobrado", "Regla", "Comisión"]) head.append(el("th", title))
  table.append(head)
  for (const line of [...detail.lines].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    const row = el("tr")
    for (const text of [
      dayLabel(line.occurredAt, locale, zone, period.year),
      line.patientName || "Paciente",
      [line.description, sessionWords(line), line.promotionName].filter(Boolean).join(" · ") +
        (line.voidedAfterPaid ? " (anulado después de pagado)" : ""),
      plain(line.baseCents),
      ruleWords(line, locale, detail.currency),
      plain(line.commissionCents),
    ])
      row.append(el("td", text))
    table.append(row)
  }
  holder.append(table)
  const totals = el("dl")
  // Con sueldo, la cifra de la hoja es la comisión: el sueldo va aparte, debajo, y se paga en Gastos.
  const mainLabel = detail.salary ? "Comisión" : "Le corresponde"
  for (const [label, cents] of [
    [mainLabel, detail.commissionCents],
    ["Ya pagado", detail.paidCents],
    ["Ya descontado", detail.discountedCents],
    ["Se descuenta en el próximo pago", detail.discountCents],
    ["Falta pagar", detail.pendingCents],
  ] as const) {
    if (cents === 0 && label !== mainLabel && label !== "Falta pagar") continue
    totals.append(el("dt", label), el("dd", plain(cents)))
  }
  holder.append(totals)
  if (detail.salary) {
    const salary = detail.salary
    holder.append(
      el(
        "p",
        `Sueldo del mes (va aparte de la comisión, se paga en Gastos): ${plain(salary.cents)} · ${
          salary.dueCents > 0
            ? "por pagar"
            : salary.paidAt
              ? `pagado el ${dayLabel(salary.paidAt, locale, zone, period.year)}`
              : "pagado"
        }`,
      ),
    )
  }
  const style = el("style")
  style.id = `${LIQUIDATION_HOLDER_ID}-estilo`
  style.textContent = `
    #${LIQUIDATION_HOLDER_ID} { display: none; }
    @media print {
      body > *:not(#${LIQUIDATION_HOLDER_ID}) { display: none !important; }
      #${LIQUIDATION_HOLDER_ID} { display: block; font: 11pt system-ui, sans-serif; color: #000; }
      #${LIQUIDATION_HOLDER_ID} h1 { font-size: 14pt; margin: 0 0 4pt; }
      #${LIQUIDATION_HOLDER_ID} table { width: 100%; border-collapse: collapse; margin: 8pt 0; }
      #${LIQUIDATION_HOLDER_ID} th, #${LIQUIDATION_HOLDER_ID} td { border-bottom: 1px solid #000; padding: 2pt 4pt; text-align: left; }
      #${LIQUIDATION_HOLDER_ID} dl { display: grid; grid-template-columns: auto auto; gap: 2pt 12pt; justify-content: end; }
      #${LIQUIDATION_HOLDER_ID} dd { margin: 0; text-align: right; font-weight: 600; }
    }`
  const cleanup = () => {
    holder.remove()
    style.remove()
    window.removeEventListener("afterprint", cleanup)
  }
  window.addEventListener("afterprint", cleanup)
  document.head.append(style)
  document.body.append(holder)
  window.print()
}

function countedLines(detail: MonthlyCommissions): CommissionLine[] {
  return detail.lines.filter((line) => !line.voidedAfterPaid)
}

/** Lo mismo, dicho al profesional en «Mis honorarios». */
function myPaymentTitle(payment: CommissionPayment, day: (iso: string) => string): string {
  const on = payment.settledAt ? day(payment.settledAt) : null
  if (payment.kind === "devuelto") return on ? `Devolviste el ${on}` : "Devolviste"
  if (payment.kind === "saldado") return on ? `La clínica lo dio por saldado el ${on}` : "La clínica lo dio por saldado"
  if (payment.commissionCents === 0) return `Descuento del ${on ?? "mes"}`
  return `Pago del ${on ?? "mes"}`
}

/** Lo que cerró una deuda (lo devolvió o se dio por saldado), no un pago. */
function isDebtRecord(payment: CommissionPayment): boolean {
  return payment.kind === "devuelto" || payment.kind === "saldado"
}

/** Qué fue cada fila de los pagos, en una frase: un pago, un descuento, lo devuelto o lo saldado. */
function paymentTitle(payment: CommissionPayment, day: (iso: string) => string): string {
  const on = payment.settledAt ? ` el ${day(payment.settledAt)}` : ""
  if (payment.kind === "devuelto") {
    const how = returnMethodWords(payment.methodTypeCode)
    return `Lo devolvió${on}${how ? `, ${how}` : ""}`
  }
  if (payment.kind === "saldado")
    return `Dado por saldado${on}${payment.settledByName ? ` por ${payment.settledByName}` : ""}`
  // Un descuento que cubrió todo lo del mes: no salió dinero.
  if (payment.commissionCents === 0) return payment.settledAt ? `Descontado${on}, sin pago` : "Descuento registrado, sin pago"
  return payment.settledAt ? `Pagado${on}` : "Pago registrado"
}

// --- Administración: el mes de toda la clínica ---------------------------------------

export function CommissionsAdminPanel({
  period,
  locale,
  timeZone,
  selectedId,
  onSelect,
  onPeriodChange,
}: {
  period: YearMonth
  locale: string
  timeZone: string
  /** Profesional con el detalle abierto. */
  selectedId: string | null
  onSelect: (professionalUserId: string | null) => void
  /** Ir a otro mes (desde «Falta pagar de otros meses»). */
  onPeriodChange?: (period: YearMonth) => void
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const canWrite = usePermission("commissions.write")
  // Lo que falta pagar de todos los meses: cada mes se mira solo, y lo de antes no debe perderse.
  const owedQuery = useQuery({
    queryKey: commissionKeys.owed,
    queryFn: fetchCommissionsOwed,
    enabled: canWrite,
    staleTime: 60_000,
  })
  const owed = owedQuery.data?.data ?? null
  // Cada moneda con lo suyo; un mes con algo en dos monedas sale una vez, con las dos cifras.
  const owedAll = owed ? [owed, ...(owed.others ?? [])].filter((item) => item.owedCents > 0 || item === owed) : []
  const owedMonths = new Map<string, YearMonth & { amounts: Array<{ cents: number; currency: string }> }>()
  for (const item of owedAll)
    for (const month of item.months) {
      const key = `${month.year}-${month.month}`
      const entry = owedMonths.get(key) ?? { year: month.year, month: month.month, amounts: [] }
      entry.amounts.push({ cents: month.cents, currency: item.currency })
      owedMonths.set(key, entry)
    }
  const otherMonths = [...owedMonths.values()]
    .filter((item) => compareMonths(item, period) !== 0)
    .sort((a, b) => compareMonths(b, a))
  const unassignedQuery = useQuery({
    queryKey: commissionKeys.unassigned,
    queryFn: fetchUnassignedCommissionSessions,
    enabled: canWrite,
    staleTime: 60_000,
  })
  const unassigned = unassignedQuery.data?.data ?? []
  const unassignedPending = unassigned.filter((item) => item.pendingCents > 0)
  const unassignedStopped = unassigned.filter((item) => item.stoppedCents > 0)
  // Cada importe con su moneda: la clínica puede cobrar en dos.
  const monthAmounts = (amounts: Array<{ cents: number; currency: string }>): string => amountsWords(amounts, locale)
  const members = useOrgMembers()

  const monthQuery = useQuery({
    queryKey: commissionKeys.month(period),
    queryFn: () => fetchMonthCommissions(period),
  })
  useOrgEvents(COMMISSION_EVENT_KINDS, () => {
    void queryClient.invalidateQueries({ queryKey: commissionKeys.all })
  })

  const rows = monthQuery.data?.data ?? []
  // Lo del mes entre todos, en cada moneda: nunca se suman monedas distintas. Lo que se descuenta de
  // comisiones ya pagadas va aparte: no es dinero pagado.
  const monthTotals: Array<{ currency: string; pendingCents: number; commissionCents: number; discountCents: number }> = []
  for (const view of rows.flatMap((row) => [row, ...(row.others ?? [])])) {
    const total = monthTotals.find((item) => item.currency === view.currency)
    if (total) {
      total.pendingCents += Math.max(0, view.pendingCents)
      total.commissionCents += view.commissionCents
      total.discountCents += view.discountCents ?? 0
    } else
      monthTotals.push({
        currency: view.currency,
        pendingCents: Math.max(0, view.pendingCents),
        commissionCents: view.commissionCents,
        discountCents: view.discountCents ?? 0,
      })
  }
  const pendingTotals = monthTotals.filter((total) => total.pendingCents > 0)
  const monthDiscounts = monthTotals.filter((total) => total.discountCents > 0)
  const owingPeople = rows.filter((row) => [row, ...(row.others ?? [])].some((view) => view.pendingCents > 0)).length
  const selectedRow = rows.find((row) => row.professionalUserId === selectedId) ?? null
  const selectedName =
    selectedRow?.professionalName ??
    members.find((member) => member.userId === selectedId)?.user.name ??
    "Profesional"
  const monthWords = monthLabel(period, locale).toLocaleLowerCase(locale)

  // El detalle abierto sobrevive al cambio de mes: solo la lista espera su carga.
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {monthQuery.isPending ? (
        <SkeletonRegion message="Cargando comisiones…">
          <CommissionsMonthSkeleton />
        </SkeletonRegion>
      ) : monthQuery.isError ? (
        <QueryErrorState error={monthQuery.error} onRetry={() => void monthQuery.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Percent}
          title={`Nada por liquidar en ${monthWords}`}
          description="Aquí aparece cada profesional con lo que le corresponde por lo que atendió y ya se cobró. Lo que se lleva cada uno se pone en Configuración › Comisiones por profesional."
          actionLabel={canWrite ? "Configurar comisiones" : undefined}
          onAction={() => void navigate({ to: "/settings/commissions" })}
        />
      ) : null}

      {pendingTotals.length > 0 ? (
        // Una cifra, no otra tarjeta: cuánto falta pagar del mes entre todos, en cada moneda.
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm text-muted-foreground">Falta pagar</span>
          <span className="text-2xl font-bold tabular-nums">
            {amountsWords(
              pendingTotals.map((total) => ({ cents: total.pendingCents, currency: total.currency })),
              locale,
            )}
          </span>
          <span className="text-sm text-muted-foreground">
            a {owingPeople === 1 ? "1 profesional" : `${owingPeople} profesionales`} por {monthWords}
          </span>
        </p>
      ) : null}
      {monthDiscounts.length > 0 ? (
        <p className="text-sm text-muted-foreground">
          Se descuentan{" "}
          {amountsWords(
            monthDiscounts.map((total) => ({ cents: total.discountCents, currency: total.currency })),
            locale,
          )}{" "}
          de comisiones ya pagadas de cobros que después se anularon.
        </p>
      ) : null}

      {owed && otherMonths.length > 0 ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border bg-card px-4 py-3 text-sm">
          <span>{otherMonths.length === 1 ? "Otro mes todavía tiene cobros sin pagar:" : "Otros meses todavía tienen cobros sin pagar:"}</span>
          {otherMonths.slice(0, 6).map((item) =>
            onPeriodChange ? (
              <Button
                key={`${item.year}-${item.month}`}
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={() => onPeriodChange({ year: item.year, month: item.month })}
              >
                {monthLabel(item, locale)} ({monthAmounts(item.amounts)})
              </Button>
            ) : (
              <span key={`${item.year}-${item.month}`}>
                {monthLabel(item, locale)} ({monthAmounts(item.amounts)})
              </span>
            ),
          )}
          {otherMonths.length > 6 ? (
            <span>y {otherMonths.length - 6 === 1 ? "1 mes más" : `${otherMonths.length - 6} meses más`}</span>
          ) : null}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <section aria-label="Profesionales" className="elevated min-w-0 rounded-xl border bg-card">
          <ul className="flex min-w-0 flex-col divide-y">
            {rows.map((row) => {
              const name = row.professionalName ?? "Profesional fuera del equipo"
              const selected = row.professionalUserId === selectedId
              const views = summaryCurrencies(row)
              // Lo que se descuenta de comisiones ya pagadas, en cada moneda: no es algo que pagar ni ya pagado.
              const discounts = views.flatMap((view) => summaryDiscountWords(view, locale) ?? [])
              // Lo que pide atención primero: lo que falta pagar en alguna moneda.
              const leading = views.find((view) => view.status === "por_pagar") ?? views[0] ?? row
              // Atendió y nadie decidió aún su comisión: se dice en su fila, con el camino para ponerla.
              const undecided = row.inTeam && !row.hasRate && !row.exceptionCount
              const nothingToPay = views.every((view) => view.commissionCents === 0 && view.pendingCents === 0)
              // Lo que usaron los cobros del mes: si el porcentaje cambió, el de hoy no explica la cifra.
              const used = row.ratesUsed ?? []
              const services = row.exceptionCount
                ? ` y ${row.exceptionCount === 1 ? "1 servicio" : `${row.exceptionCount} servicios`} con comisión distinta`
                : ""
              const rule =
                used.length > 1
                  ? `varios porcentajes${services}`
                  : agreementWords(
                      {
                        hasRate: row.hasRate,
                        rateBps: used.length === 1 ? (used[0] as number) : row.rateBps,
                        exceptionCount: row.exceptionCount ?? 0,
                      },
                      locale,
                    )
              return (
                <li key={row.professionalUserId} className="flex min-w-0 items-stretch">
                  <Button
                    type="button"
                    variant="ghost"
                    aria-current={selected ? "true" : undefined}
                    className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-none px-4 py-3 text-left font-normal whitespace-normal aria-[current=true]:bg-muted"
                    onClick={() => onSelect(row.professionalUserId)}
                  >
                    <PersonAvatar name={name} fallbackClassName="text-xs" decorative />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium text-foreground">{name}</span>
                      <span className="text-sm text-muted-foreground">
                        {amountsWords(
                          views.length > 0
                            ? views.map((view) => ({ cents: view.baseCents, currency: view.currency }))
                            : [{ cents: row.baseCents, currency: row.currency }],
                          locale,
                        )}{" "}
                        cobrado de lo que atendió · {rule}
                        {row.inTeam ? null : " · Ya no está en el equipo"}
                      </span>
                      {discounts.length > 0 ? (
                        // No es algo que pagar: se descuenta solo, de este pago o del próximo.
                        <span className="text-sm text-muted-foreground">{discounts.join(" · ")}</span>
                      ) : null}
                    </span>
                    {undecided && nothingToPay ? null : (
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        {/* Con un pago a cuenta o un descuento, lo que importa es lo que falta. Una cifra por moneda, apiladas. */}
                        {views.map((view) => (
                          <span key={view.currency} className="text-base font-semibold text-foreground tabular-nums">
                            {summaryAmountWords(view, locale)}
                            {/* Con dos monedas, la que ya se pagó lo dice: el estado de abajo es el de la que falta. */}
                            {views.length > 1 && view.status === "pagado" ? (
                              <span className="ml-1 text-xs font-normal text-muted-foreground">pagado</span>
                            ) : null}
                          </span>
                        ))}
                        <StatusBadge status={leading.status} baseCents={leading.baseCents} />
                      </span>
                    )}
                  </Button>
                  {undecided && canWrite ? (
                    // Fuera del botón de la fila: un enlace dentro de otro control no se puede usar con teclado.
                    <span className="flex shrink-0 items-center pr-4 text-sm">
                      <AgreementLink professionalUserId={row.professionalUserId} openRate label={`Poner el porcentaje de ${name}`}>
                        Poner su porcentaje
                      </AgreementLink>
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {unassignedPending.length > 0 || unassignedStopped.length > 0 ? (
        // No pide hacer nada: explica por qué la suma de las comisiones no es todo lo cobrado.
        <details className="text-sm text-muted-foreground">
          <summary className="min-h-11 cursor-pointer content-center font-medium text-foreground sm:min-h-8">
            Lo cobrado que aún no es comisión de nadie
          </summary>
          <div className="mt-1 flex flex-col gap-1">
            {unassignedPending.length > 0 ? (
              <p>
                De sesiones que aún nadie hace:{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {amountsWords(
                    unassignedPending.map((item) => ({ cents: item.pendingCents, currency: item.currency })),
                    locale,
                  )}
                </span>
                . No se paga todavía: su comisión será de quien haga cada sesión.
              </p>
            ) : null}
            {unassignedStopped.length > 0 ? (
              <p>
                De tratamientos que se cancelaron antes de hacer todas sus sesiones:{" "}
                <span className="font-medium text-foreground tabular-nums">
                  {amountsWords(
                    unassignedStopped.map((item) => ({ cents: item.stoppedCents, currency: item.currency })),
                    locale,
                  )}
                </span>
                . Esa parte no es comisión de nadie.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}

      <ProfessionalDetail
        professionalUserId={selectedId}
        fallbackName={selectedName}
        period={period}
        locale={locale}
        timeZone={timeZone}
        onClose={() => onSelect(null)}
      />
    </div>
  )
}

// --- Administración: la liquidación de un profesional ---------------------------------

/** El mes que se mira es el de hoy en la clínica: la liquidación va «hasta hoy». */
function isCurrentMonth(period: YearMonth, timeZone: string): boolean {
  return compareMonths(period, currentMonthIn(timeZone)) === 0
}

function ProfessionalDetail({
  professionalUserId,
  fallbackName,
  period,
  locale,
  timeZone,
  onClose,
}: {
  professionalUserId: string | null
  fallbackName: string
  period: YearMonth
  locale: string
  timeZone: string
  onClose: () => void
}) {
  const userId = professionalUserId ?? ""
  const detailQuery = useQuery({
    queryKey: commissionKeys.detail(userId, period),
    queryFn: () => fetchProfessionalCommissions({ ...period, professionalUserId: userId }),
    enabled: professionalUserId !== null,
  })
  const detail = detailQuery.data?.data ?? null
  const name = detail?.professionalName ?? fallbackName
  const zone = detail?.timezone || timeZone
  // El mes en curso todavía no termina: lo que se ve es hasta hoy.
  const description = isCurrentMonth(period, zone)
    ? `${monthLabel(period, locale)} · hasta hoy, ${dayLabel(new Date().toISOString(), locale, zone, period.year)}`
    : monthLabel(period, locale)

  return (
    <DetailDrawer
      open={professionalUserId !== null}
      onClose={onClose}
      size="lg"
      title={name}
      description={description}
      isLoading={professionalUserId !== null && detailQuery.isPending}
    >
      {detailQuery.isError ? (
        <QueryErrorState
          error={detailQuery.error}
          onRetry={() => void detailQuery.refetch()}
          notFound="Esta persona no atiende ni atendió en la clínica."
        />
      ) : detail ? (
        // Otro profesional u otro mes: el cuerpo nace de nuevo, con su lista resumida.
        <ProfessionalDetailBody
          key={`${detail.professionalUserId}-${detail.year}-${detail.month}`}
          detail={detail}
          name={name}
          period={period}
          timeZone={timeZone}
        />
      ) : null}
    </DetailDrawer>
  )
}

/**
 * La liquidación del mes, en el orden en que se lee un recibo: lo que falta pagar y el botón, cómo
 * se calcula, los cobros por fecha, los pagos y, al final, la comisión con que se calculó, solo a la
 * vista (se cambia en Configuración › Comisiones por profesional).
 */
function ProfessionalDetailBody({
  detail,
  name,
  period,
  timeZone,
}: {
  detail: MonthlyCommissions
  name: string
  period: YearMonth
  timeZone: string
}) {
  const canWrite = usePermission("commissions.write")
  const [voiding, setVoiding] = useState<CommissionPayment | null>(null)
  const paymentsQuery = useQuery({
    queryKey: commissionKeys.payments(detail.professionalUserId, period),
    queryFn: () =>
      fetchCommissionPayments({
        ...period,
        professionalUserId: detail.professionalUserId,
        // Los anulados quedan a la vista, tachados y con su motivo.
        includeVoided: true,
      }),
  })

  const locale = detail.locale
  const zone = detail.timezone || timeZone
  const day = (iso: string): string => dayLabel(iso, locale, zone, period.year)
  const payments = paymentsQuery.data?.data ?? []
  // La comisión va en la moneda de lo cobrado (ADR 0155): cada moneda se mira y se paga aparte. La de
  // la clínica no se muestra vacía si solo hubo cobros en la otra.
  const others = detail.others ?? []
  const blocks =
    others.length > 0 && detail.lines.length === 0 && detail.adjustmentCents === 0 && !detail.salary
      ? others
      : [detail, ...others]
  const titled = blocks.length > 1 || blocks[0]?.currency !== detail.currency
  const asOf = isCurrentMonth(period, zone) ? day(new Date().toISOString()) : null

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {blocks.map((view) => (
        <CommissionCurrencyBlock
          key={view.currency}
          view={view}
          heading={titled ? `En ${currencyWord(view.currency, locale)}` : null}
          name={name}
          period={period}
          zone={zone}
          asOf={asOf}
        />
      ))}

      <section aria-label="Pagos" className="flex min-w-0 flex-col gap-2">
        <h3 className="text-sm font-semibold">Pagos</h3>
        {paymentsQuery.isPending ? (
          <Skeleton className="h-12 w-full" />
        ) : paymentsQuery.isError ? (
          <QueryErrorState error={paymentsQuery.error} onRetry={() => void paymentsQuery.refetch()} />
        ) : payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aún no hay pagos de {monthLabel(period, locale).toLocaleLowerCase(locale)}.
          </p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y rounded-lg border">
            {payments.map((payment) => (
              <li
                key={payment.id}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "font-medium",
                      payment.voidedAt && "text-muted-foreground line-through",
                    )}
                  >
                    {paymentTitle(payment, day)}
                  </span>
                  {payment.notes ? (
                    <span className="block text-muted-foreground">
                      {payment.kind === "saldado" ? `Motivo: ${payment.notes}` : payment.notes}
                    </span>
                  ) : null}
                  {payment.voidedAt ? (
                    <span className="block text-muted-foreground">
                      Anulado el {day(payment.voidedAt)}
                      {payment.voidedByName ? ` por ${payment.voidedByName}` : ""}
                      {payment.voidReason ? `. Motivo: ${payment.voidReason}` : ""}
                    </span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-semibold tabular-nums",
                    payment.voidedAt && "font-normal text-muted-foreground line-through",
                  )}
                >
                  {formatMoney(payment.commissionCents, payment.currency, locale)}
                </span>
                {canWrite && !payment.voidedAt ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setVoiding(payment)}
                  >
                    {isDebtRecord(payment) ? "Anular" : "Anular pago"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <AgreementSection detail={detail} period={period} zone={zone} />

      <VoidPaymentDrawer
        payment={voiding}
        onClose={() => setVoiding(null)}
        name={name}
        locale={locale}
        timeZone={zone}
      />
    </div>
  )
}

/**
 * «Su comisión»: con qué se calculó el mes (en uno pasado, lo que valía al terminar; los cobros dicen
 * cada uno la suya), solo a la vista. Se cambia en Configuración › Comisiones por profesional y vale desde que se guarda.
 */
function AgreementSection({ detail, period, zone }: { detail: MonthlyCommissions; period: YearMonth; zone: string }) {
  const canWrite = usePermission("commissions.write")
  const titleId = useId()
  const locale = detail.locale
  const exceptions = detail.exceptions ?? []
  const words = agreementWords(
    { hasRate: detail.hasRate, rateBps: detail.rateBps, exceptionCount: exceptions.length },
    locale,
  )
  const current = isCurrentMonth(period, zone)
  const lead = current
    ? words
    : `En ${monthLabel(period, locale).toLocaleLowerCase(locale)} valía: ${words.charAt(0).toLocaleLowerCase(locale)}${words.slice(1)}`
  // Los servicios ya salen en «Cómo se calcula»: aquí basta el resumen y el camino para cambiarla.
  const services = exceptions
    .map((exception) => `${exception.serviceName}: ${exceptionWords(exception, locale, detail.currency)}`)
    .join("; ")
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-1 border-t pt-4 text-sm">
      <h3 id={titleId} className="font-semibold">
        Su comisión
      </h3>
      <p>
        {lead}
        {services ? ` (${services})` : ""}
        {!detail.inTeam ? (
          // Su comisión ya no cambia (solo se fija a quien puede atender); lo que ganó se le paga igual.
          <span className="text-muted-foreground"> · Ya no está en el equipo: lo que ganó se le paga igual.</span>
        ) : canWrite ? (
          <>
            {" · "}
            <AgreementLink professionalUserId={detail.professionalUserId}>Ver o cambiar en Configuración</AgreementLink>
          </>
        ) : null}
      </p>
    </section>
  )
}

/** «2 nov», en la zona de la clínica: la fecha de cada cobro en la tabla. */
function shortDay(iso: string, locale: string, timeZone: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: timeZone || undefined })
    .format(date)
    .replace(/\.$/, "")
}

/**
 * La regla de un cobro, solo cuando no es la de siempre: una comisión distinta para el servicio, un
 * monto fijo, otro porcentaje (el de antes de un cambio) o ninguna todavía. Nulo si usó el general.
 */
function specialRule(
  line: CommissionLine,
  generalBps: number,
  locale: string,
  currency: string,
  /** Con su comisión decidida, lo que queda sin regla es un monto fijo que quedó en otra moneda. */
  decided: boolean,
): string | null {
  if (line.unruled) return decided ? "sin comisión: el monto fijo quedó en otra moneda" : "sin comisión decidida"
  if (line.fixedCents !== null)
    return `monto fijo de ${formatMoney(line.fixedCents, currency, locale)} por cada uno${otherServiceName(line, " · ")}`
  const rate = line.rateBps ?? 0
  if (line.forService) return `${percentLabel(rate, locale)} ${serviceWords(line)}`
  if (rate === generalBps) return null
  return rate > 0 ? percentLabel(rate, locale) : "sin comisión"
}

/**
 * Lo de un mes en una moneda, como un recibo: lo que falta pagar con su botón, cómo se calcula (una
 * fila por regla, que suman lo que le corresponde), lo que se descuenta y cada cobro en orden de fecha,
 * como en la hoja impresa. Con dos monedas va uno por moneda, con su título: cada moneda se paga aparte.
 */
function CommissionCurrencyBlock({
  view,
  heading,
  name,
  period,
  zone,
  asOf,
}: {
  view: MonthlyCommissions
  /** «En dólares», si hay más de una moneda. */
  heading: string | null
  name: string
  period: YearMonth
  zone: string
  /** Hoy, si el mes aún no termina: la liquidación es «hasta hoy». */
  asOf: string | null
}) {
  const canWrite = usePermission("commissions.write")
  const canFinance = usePermission("finance.read")
  const payHintId = useId()
  const calcId = useId()
  const linesId = useId()
  const [payOpen, setPayOpen] = useState(false)
  // Lo que debe: lo devolvió o se da por saldado.
  const [debtMode, setDebtMode] = useState<"devuelto" | "saldado" | null>(null)
  const locale = view.locale
  const day = (iso: string): string => dayLabel(iso, locale, zone, period.year)
  const money = (cents: number): string => formatMoney(cents, view.currency, locale)
  // Todos, en orden de fecha, como los da el servidor y como sale en la hoja impresa: así los que se
  // ven suman lo que dice «Cómo se calcula».
  const lines = view.lines
  const counted = lines.filter((line) => !line.voidedAfterPaid).length
  // Con su comisión decidida, lo que queda sin regla es un monto fijo en otra moneda, no algo por decidir.
  const decided = Boolean(view.hasRate) || (view.exceptions ?? []).length > 0
  const groups = calculationGroups(lines, locale, view.currency, decided)
  const monthWords = monthLabel(period, locale).toLocaleLowerCase(locale)
  // Se puede registrar mientras el mes tenga cobros sin pagar; si el descuento los cubre, no sale dinero.
  const payable = view.pendingCents > 0 || view.discountCents > 0
  const discountOnly = view.pendingCents === 0 && view.discountCents > 0
  const partial = view.paidCents > 0 || view.discountCents > 0
  // Lo que queda por descontar después de este pago, para el siguiente.
  const discountLeft = view.adjustmentCents - view.discountCents
  const inCurrency = heading ? ` en ${currencyWord(view.currency, locale)}` : ""
  // De qué pago se descuenta lo que este mes no alcanza: el de otro mes con cobros por pagar, si hay.
  const discountMonth = view.discountFrom ? monthLabel(view.discountFrom, locale).toLocaleLowerCase(locale) : null
  const discountWhole = view.discountFrom ? view.discountFrom.cents >= (view.owedCents ?? 0) : false
  const undecided = !view.hasRate && (view.exceptions ?? []).length === 0
  // Junto al botón, qué hace; sin nada que pagar, por qué.
  const payNote = discountOnly
    ? `Lo de este mes (${money(view.discountCents)}) se descuenta de comisiones ya pagadas de cobros que después se anularon: no sale dinero.${discountLeft > 0 ? ` Quedan ${money(discountLeft)} por descontar en los próximos pagos.` : ""}`
    : payable
      ? `Anota lo que ya le pagaste: queda en Gastos como pago de comisiones. Si te equivocas, se anula con su motivo.${asOf ? " El mes aún no termina: lo que se cobre después queda por pagar aparte." : ""}${discountLeft > 0 ? ` Quedan ${money(discountLeft)} por descontar en los próximos pagos.` : ""}`
      : (view.owedCents ?? 0) > 0
        ? discountMonth
          ? `${money(view.owedCents ?? 0)} por descontar${inCurrency}: se le pagó la comisión de cobros que después se anularon. ${discountFromWords(view, locale)}`
          : `${money(view.owedCents ?? 0)} por descontar del próximo pago${inCurrency}: se le pagó la comisión de cobros que después se anularon y aún no hay cobros nuevos de donde descontarla. Se descuenta sola; si ya lo devolvió o la clínica lo perdona, regístralo en «Por descontar».`
        : view.status === "pagado"
          ? `No queda nada por pagar de este mes${inCurrency}.`
          : undecided && view.baseCents > 0
            ? view.inTeam
              ? "Aún no tiene una comisión decidida: lo cobrado de lo que atendió no comisiona hasta ponerla."
              : "Ya no está en el equipo y no tenía una comisión decidida: no le corresponde comisión."
            : view.baseCents > 0
              ? "No hay nada por pagar: lo cobrado de lo que atendió no comisiona."
              : "No hay nada por pagar: aún no se cobró nada de lo que atendió este mes."
  // La cifra de arriba: lo que falta pagar o se descuenta; sin nada pendiente, lo que le corresponde.
  const top = payable
    ? discountOnly
      ? { label: "Se descuenta", cents: view.discountCents }
      : { label: "Falta pagar", cents: view.pendingCents }
    : { label: view.salary ? "Comisión" : "Le corresponde", cents: view.commissionCents }

  return (
    <section aria-label={heading ?? undefined} className="flex min-w-0 flex-col gap-6">
      {heading ? <h3 className="border-b pb-1 text-base font-semibold">{heading}</h3> : null}

      <div className="flex min-w-0 flex-col gap-3">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm text-muted-foreground">{top.label}</span>
          <span className="text-3xl leading-tight font-bold tracking-tight tabular-nums">{money(top.cents)}</span>
          {payable ? null : <StatusBadge status={view.status} baseCents={view.baseCents} />}
        </p>
        {canWrite && payable ? (
          <Button type="button" className="w-full" aria-describedby={payHintId} onClick={() => setPayOpen(true)}>
            {discountOnly ? "Registrar el descuento" : `Registrar el pago de ${money(view.pendingCents)}`}
          </Button>
        ) : null}
        <p id={payHintId} className="text-sm text-muted-foreground">
          {payNote}
        </p>
        {canWrite && lines.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => printLiquidation(view, name, period, locale, zone, heading, asOf)}
          >
            {heading ? `Imprimir la liquidación ${heading.toLocaleLowerCase(locale)}` : "Imprimir la liquidación"}
          </Button>
        ) : null}
      </div>

      {lines.length > 0 || view.salary ? (
        <section aria-labelledby={calcId} className="flex min-w-0 flex-col gap-2">
          <h3 id={calcId} className="text-sm font-semibold">
            Cómo se calcula
          </h3>
          <dl className="flex min-w-0 flex-col rounded-lg border text-sm">
            {groups.map((group) => (
              <div key={group.key} className="flex items-baseline justify-between gap-3 border-b px-3 py-2">
                <dt className="min-w-0">
                  <span className="block font-medium break-words">{group.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {group.count === 1 ? "1 cobro" : `${group.count} cobros`} · {money(group.baseCents)}
                  </span>
                </dt>
                <dd className="shrink-0 font-medium tabular-nums">{money(group.commissionCents)}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3 bg-muted/40 px-3 py-2.5">
              <dt className="font-semibold">{view.salary ? "Comisión" : "Le corresponde"}</dt>
              <dd className="text-lg font-bold tabular-nums">{money(view.commissionCents)}</dd>
            </div>
            {view.paidCents > 0 ? (
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-t px-3 py-2">
                <dt className="text-muted-foreground">Ya pagado</dt>
                <dd className="tabular-nums">{money(view.paidCents)}</dd>
                {/* Por qué es más que la comisión: lo de un cobro anulado que después devolvió o se dio por saldado. */}
                {(view.debtClosures ?? []).map((closure) => (
                  <dd key={closure.settlementId} className="basis-full text-xs text-muted-foreground">
                    {debtClosureWords(closure, view.currency, locale, day)}
                  </dd>
                ))}
              </div>
            ) : null}
            {view.discountedCents > 0 ? (
              // Lo que los pagos de este mes ya descontaron: sin esto, «Le corresponde − Ya pagado» no cuadra.
              <div className="flex items-baseline justify-between gap-3 border-t px-3 py-2">
                <dt className="text-muted-foreground">Ya descontado</dt>
                <dd className="tabular-nums">−{money(view.discountedCents)}</dd>
              </div>
            ) : null}
            {view.discountCents > 0 ? (
              <div className="flex items-baseline justify-between gap-3 border-t px-3 py-2">
                <dt className="text-muted-foreground">Se descuenta: comisión ya pagada de cobros anulados</dt>
                <dd className="tabular-nums">−{money(view.discountCents)}</dd>
              </div>
            ) : null}
            {partial && payable ? (
              <div className="flex items-baseline justify-between gap-3 border-t px-3 py-2">
                <dt className="font-semibold">Falta pagar</dt>
                <dd className="font-semibold tabular-nums">{money(view.pendingCents)}</dd>
              </div>
            ) : !payable && (view.owedCents ?? 0) > 0 ? (
              // No es un error ni algo que pagar: se descuenta solo del próximo pago.
              <div className="flex items-baseline justify-between gap-3 border-t px-3 py-2">
                <dt className="font-semibold">
                  {discountMonth
                    ? discountWhole
                      ? `Por descontar del pago de ${discountMonth}`
                      : `Por descontar, desde el pago de ${discountMonth}`
                    : "Por descontar del próximo pago"}
                </dt>
                <dd className="font-semibold tabular-nums">{money(view.owedCents ?? 0)}</dd>
              </div>
            ) : null}
          </dl>
          {view.salary ? (
            // El sueldo se paga en Gastos; aquí solo se ve junto a la comisión, sin sumarse.
            <p className="text-sm text-muted-foreground">
              Aparte, su sueldo del mes: <span className="font-medium text-foreground tabular-nums">{money(view.salary.cents)}</span>
              {", "}
              {view.salary.dueCents > 0
                ? view.salary.dueOn
                  ? `${view.salary.dueOn < todayIn(zone) ? "venció" : "vence"} el ${day(`${view.salary.dueOn}T17:00:00Z`)}`
                  : "por pagar"
                : view.salary.paidAt
                  ? `pagado el ${day(view.salary.paidAt)}`
                  : "pagado"}
              .
              {view.salary.dueCents > 0 && canFinance ? (
                <>
                  {" "}
                  <Link
                    to="/finance"
                    search={{ tab: "gastos", ...(view.salary.dueBranchId ? { branch: view.salary.dueBranchId } : {}) }}
                    className="font-medium text-primary-soft-foreground underline-offset-2 hover:underline"
                  >
                    Pagar en Gastos
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            No entra lo que aún no se cobra, una venta suelta (como {appWords().examples.soldItem}) ni las sesiones que
            todavía nadie hace.
          </p>
        </section>
      ) : null}

      {view.adjustments.length > 0 ? (
        <section aria-label="Por descontar" className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-semibold">Por descontar</h3>
          <p className="text-sm text-muted-foreground">
            Debe {money(view.adjustmentCents)}: comisiones ya pagadas de cobros que después se anularon. Se
            descuentan de los próximos pagos que registres, de este mes o de otro, hasta completarse.
            {canWrite ? " Si ya lo devolvió, o si la clínica lo perdona, regístralo aquí y deja de descontarse." : ""}
          </p>
          <ul className="flex min-w-0 flex-col divide-y rounded-lg border">
            {view.adjustments.map((adjustment) => (
              <li
                key={adjustment.applicationId}
                className="flex min-w-0 items-baseline gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{adjustment.patientName || "Paciente"}</span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {adjustment.description}
                    {adjustment.paidAt ? ` · se pagó el ${day(adjustment.paidAt)}` : ""}
                  </span>
                </span>
                <span className="shrink-0 font-medium tabular-nums">
                  −{money(adjustment.commissionCents)}
                </span>
              </li>
            ))}
          </ul>
          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setDebtMode("devuelto")}>
                Registrar que lo devolvió
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setDebtMode("saldado")}>
                Darlo por saldado
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby={linesId} className="flex min-w-0 flex-col gap-1">
        <h3 id={linesId} className="text-sm font-semibold">
          Cobros de {monthWords}
          {counted > 0 ? ` · ${counted}` : ""}
        </h3>
        {lines.length === 0 ? (
          // Ya se está en Finanzas: basta decirlo, sin otro botón.
          <p className="text-sm text-muted-foreground">
            Sin cobros este mes. Cuando se cobre algo de lo que atendió, aparece aquí con su comisión.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="hidden h-9 w-16 pl-0 sm:table-cell">
                  Fecha
                </TableHead>
                <TableHead scope="col" className="h-9 pl-0 sm:pl-2">
                  Paciente y servicio
                </TableHead>
                <TableHead scope="col" className="hidden h-9 text-right sm:table-cell">
                  Cobrado
                </TableHead>
                <TableHead scope="col" className="h-9 pr-0 text-right">
                  Comisión
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((line) => {
                const facts = [
                  specialRule(line, view.rateBps, locale, view.currency, decided),
                  sessionWords(line),
                  line.promotionName,
                ].filter(Boolean)
                return (
                  <TableRow key={lineKey(line)}>
                    <TableCell className="hidden py-2 pl-0 align-top text-muted-foreground sm:table-cell">
                      {shortDay(line.occurredAt, locale, zone)}
                    </TableCell>
                    <TableCell className="py-2 pl-0 whitespace-normal sm:pl-2">
                      <span className="font-medium">{line.patientName || "Paciente"}</span>
                      <span className="text-muted-foreground"> · {line.description}</span>
                      {facts.length > 0 ? (
                        <span className="block text-xs text-muted-foreground">{facts.join(" · ")}</span>
                      ) : null}
                      {/* En el teléfono la fecha y lo cobrado van debajo: no caben columnas. */}
                      <span className="block text-xs text-muted-foreground sm:hidden">
                        {shortDay(line.occurredAt, locale, zone)} · cobrado {money(line.baseCents)}
                      </span>
                      {line.voidedAfterPaid ? (
                        <Badge variant="destructive" className="mt-1">
                          Anulado después de pagado
                        </Badge>
                      ) : line.settled ? (
                        <Badge variant="success" className="mt-1">
                          {line.paidAt ? `Liquidado el ${day(line.paidAt)}` : "Liquidado"}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "hidden py-2 text-right align-top text-muted-foreground tabular-nums sm:table-cell",
                        line.voidedAfterPaid && "line-through",
                      )}
                    >
                      {money(line.baseCents)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "py-2 pr-0 text-right align-top font-medium tabular-nums",
                        line.voidedAfterPaid && "text-muted-foreground line-through",
                      )}
                    >
                      {money(line.commissionCents)}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </section>

      <PayDrawer
        open={payOpen}
        onClose={() => setPayOpen(false)}
        detail={view}
        name={name}
        period={period}
        currencyNamed={heading !== null}
      />
      <DebtDrawer
        mode={debtMode}
        onClose={() => setDebtMode(null)}
        detail={view}
        name={name}
        period={period}
        currencyNamed={heading !== null}
      />
    </section>
  )
}

// --- Registrar el pago (un solo paso) -------------------------------------------------

function PayDrawer({
  open,
  onClose,
  detail,
  name,
  period,
  currencyNamed = false,
}: {
  open: boolean
  onClose: () => void
  detail: MonthlyCommissions
  name: string
  period: YearMonth
  /** Hay más de una moneda: la caja se dice con la suya. */
  currencyNamed?: boolean
}) {
  const queryClient = useQueryClient()
  const sede = useActiveBranch()
  const defaultBranch = sede.branchId ?? sede.branches[0]?.id ?? ""
  // Un descuento no registra gasto: no hay sede que elegir.
  const pickBranch = sede.branches.length > 1 && detail.pendingCents > 0

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: commissionKeys.all })
    void queryClient.invalidateQueries({ queryKey: ["finance-expenses"] })
    void queryClient.invalidateQueries({ queryKey: ["monthly-finance-result"] })
  }
  // Salir de la caja es mover efectivo: lo ofrece solo a quien registra gastos.
  const canUseCash = usePermission("finance.write") && detail.pendingCents > 0
  // Los medios de la clínica, como al registrar un gasto: solo el efectivo sale de la caja (ADR 0167).
  const methods = useQuery({ queryKey: ["org-payment-methods"], queryFn: fetchPaymentMethods, enabled: open && canUseCash })
  const isCash = (id: string) => (methods.data?.data ?? []).find((method) => method.id === id)?.typeCode === CASH_TYPE_CODE
  const form = useAppForm({
    defaultValues: { branchId: "", notes: "", method: "", reference: "" },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (pickBranch && !value.branchId) fields.branchId = "Elige la sede del gasto."
        // Con qué se pagó, como en un gasto (ADR 0167).
        if (canUseCash && !value.method) fields.method = "Elige con qué se pagó."
        // Mismo freno que en un gasto: el efectivo nunca queda negativo, y se dice qué hacer.
        else if (isCash(value.method) && cashState && cashState.cashOnHandCents < detail.pendingCents)
          fields.method = `En la caja solo hay ${formatMoney(cashState.cashOnHandCents, detail.currency, detail.locale)}: no alcanza para pagarlo con el efectivo. Si el dinero está en el cajón, ingrésalo a la caja con el botón de abajo; si no, elige con qué se pagó.`
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      try {
        const notes = value.notes.trim()
        const result = await payMonthCommissionApi({
          ...period,
          professionalUserId: detail.professionalUserId,
          branchId: value.branchId || defaultBranch,
          // Cada moneda se paga aparte, en la suya.
          currency: detail.currency,
          expectedCents: detail.pendingCents,
          ...(notes ? { notes } : {}),
          ...(canUseCash && value.method ? { paymentMethodId: value.method } : {}),
          ...(canUseCash && value.method && !isCash(value.method) && value.reference.trim()
            ? { paymentReference: value.reference.trim() }
            : {}),
        })
        refresh()
        if (isCash(value.method)) invalidateFinance(queryClient)
        // Se dice lo que el servidor pagó de verdad, no lo que mostraba la pantalla.
        toast.success(
          result.data.settlement.commissionCents === 0
            ? "Descuento registrado: no salió dinero"
            : `Pago registrado: ${formatMoney(result.data.settlement.commissionCents, result.data.settlement.currency, detail.locale)}`,
        )
        onClose()
      } catch (err) {
        refresh()
        throw err
      }
    },
  })
  const surface = useFormSurface(form, { formMessage: financeFormMessage })
  const branchId = useStore(form.store, (state) => state.values.branchId)
  const methodId = useStore(form.store, (state) => state.values.method)
  const fromCash = isCash(methodId)
  const cashBranch = branchId || defaultBranch
  const cash = useCashState(cashBranch, open && canUseCash, detail.currency)
  const cashState = cash.data?.data ?? null
  const cashAfter = cashState ? cashState.cashOnHandCents - detail.pendingCents : null
  const [cashOpen, setCashOpen] = useState(false)

  // La sede activa es la propuesta; si llega tarde no pisa lo ya elegido.
  useEffect(() => {
    if (open && !form.getFieldValue("branchId") && defaultBranch)
      form.setFieldValue("branchId", defaultBranch, { dontUpdateMeta: true })
  }, [open, defaultBranch, form])
  useEffect(() => {
    if (open) return
    form.reset({ branchId: "", notes: "", method: "", reference: "" })
  }, [open, form])

  const amount = formatMoney(detail.pendingCents, detail.currency, detail.locale)
  const branchName = sede.branches.find((branch) => branch.id === branchId)?.name ?? ""

  return (
    <FormDrawer
      {...surface}
      dock={false}
      open={open}
      onClose={onClose}
      title={detail.pendingCents === 0 ? "Registrar el descuento" : "Registrar el pago"}
      description={
        detail.pendingCents === 0
          ? `Lo de ${monthLabel(period, detail.locale).toLocaleLowerCase(detail.locale)} de ${name} se descuenta de comisiones ya pagadas: no sale dinero.`
          : `${amount} a ${name} por ${monthLabel(period, detail.locale).toLocaleLowerCase(detail.locale)}.`
      }
      submitLabel={detail.pendingCents === 0 ? "Registrar el descuento" : `Registrar el pago de ${amount}`}
      // Sin ninguna sede no hay dónde registrar el gasto; el motivo está a la vista.
      submitDisabled={!pickBranch && !branchId}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {detail.pendingCents === 0
            ? "Los cobros de este mes dejan de estar por pagar y lo descontado deja de estar pendiente. No se registra ningún gasto. Si te equivocas, puedes anularlo con su motivo."
            : "Queda en Gastos como pago de comisiones y los cobros de este pago dejan de estar por pagar. Si te equivocas, puedes anular el pago con su motivo."}
        </p>
        {pickBranch ? (
          <form.AppField name="branchId">
            {(field) => (
              <field.Control label="Sede del gasto" description="El gasto se registra en esta sede.">
                {(control) => (
                  <ChoiceSelect
                    id={control.id}
                    name={control.name}
                    value={field.state.value}
                    placeholder="Elige la sede"
                    required
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    {sede.branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </ChoiceSelect>
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : branchName ? (
          <p className="text-sm">El gasto se registra en la sede {branchName}.</p>
        ) : (
          <p role="alert" className="text-sm text-destructive">
            No hay una sede activa donde registrar el gasto.
          </p>
        )}
        {canUseCash ? (
          <form.AppField name="method">
            {(field) => (
              <field.Group
                legend="¿Con qué se pagó?"
                description={
                  !methodId
                    ? undefined
                    : !fromCash
                      ? "No toca la caja."
                      : cashAfter === null || cashAfter < 0
                        ? `Sale del efectivo de la caja${currencyNamed ? ` de ${currencyWord(detail.currency, detail.locale)}` : ""}.`
                        : `Sale del efectivo de la caja${currencyNamed ? ` de ${currencyWord(detail.currency, detail.locale)}` : ""}: queda en ${formatMoney(cashAfter, detail.currency, detail.locale)}.`
                }
              >
                {(control) => (
                  <PaymentMethodButtons
                    id={control.id}
                    methods={methods.data?.data ?? []}
                    value={field.state.value}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
        {canUseCash && methodId && !fromCash ? (
          <form.AppField name="reference">
            {(field) => <field.TextField label="N.º de operación (opcional)" maxLength={60} autoComplete="off" inputClassName="sm:w-56" />}
          </form.AppField>
        ) : null}
        {canUseCash && fromCash && cashAfter !== null && cashAfter < 0 ? (
          // Lo que falta se ingresa encima, sin salir: al guardarlo, el pago sigue como estaba.
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setCashOpen(true)}>
              Ingresar {formatMoney(-cashAfter, detail.currency, detail.locale)} a la caja
            </Button>
          </div>
        ) : null}
        <form.AppField name="notes">
          {(field) => <field.TextareaField label="Nota (opcional)" rows={2} maxLength={2000} />}
        </form.AppField>
      </div>
      <CashMoveDrawer
        branchId={cashBranch}
        currency={detail.currency}
        locale={detail.locale}
        open={cashOpen}
        onClose={() => setCashOpen(false)}
        initialAmountCents={cashAfter !== null && cashAfter < 0 ? -cashAfter : undefined}
      />
    </FormDrawer>
  )
}

// --- Lo que debe: lo devolvió o se da por saldado --------------------------------------

/**
 * Cierra lo que el profesional le debe a la clínica en una moneda (comisiones ya pagadas de cobros
 * que después se anularon), sin esperar a descontarlo de un pago. «Lo devolvió»: con su medio; en
 * efectivo entra a la caja de la sede, que no dice de quién es. «Darlo por saldado»: la clínica lo
 * perdona, con un motivo corto, sin mover dinero. Lo decide y lo guarda el servidor.
 */
function DebtDrawer({
  mode,
  onClose,
  detail,
  name,
  period,
  currencyNamed = false,
}: {
  mode: "devuelto" | "saldado" | null
  onClose: () => void
  detail: MonthlyCommissions
  name: string
  period: YearMonth
  /** Hay más de una moneda: lo que debe y la caja se dicen con la suya. */
  currencyNamed?: boolean
}) {
  const queryClient = useQueryClient()
  const sede = useActiveBranch()
  const defaultBranch = sede.branchId ?? sede.branches[0]?.id ?? ""
  const open = mode !== null
  // El texto conserva lo último mientras el cajón termina de cerrarse.
  const shownMode = useRef(mode)
  if (mode) shownMode.current = mode
  const kind = shownMode.current ?? "devuelto"
  // Que entre a la caja es mover efectivo: lo ofrece solo a quien registra gastos, como al pagar.
  const canUseCash = usePermission("finance.write")
  const methods = canUseCash ? RETURN_METHODS : RETURN_METHODS.filter((option) => option.value !== "10")
  const pickBranch = sede.branches.length > 1
  const owedText = formatMoney(detail.adjustmentCents, detail.currency, detail.locale)
  const inCurrency = currencyNamed ? ` en ${currencyWord(detail.currency, detail.locale)}` : ""

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: commissionKeys.all })
    void queryClient.invalidateQueries({ queryKey: ["monthly-finance-result"] })
  }
  const form = useAppForm({
    defaultValues: { method: "" as ReturnMethod | "", branchId: "", notes: "" },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        const notes = value.notes.trim()
        if (kind === "devuelto") {
          if (!value.method) fields.method = "Elige cómo lo devolvió."
          if (value.method === "10" && pickBranch && !value.branchId) fields.branchId = "Elige la sede de la caja."
        } else if (!notes) fields.notes = "Escribe el motivo."
        else if (notes.length > FORGIVE_REASON_MAX)
          fields.notes = `Escribe el motivo en ${FORGIVE_REASON_MAX} caracteres como máximo.`
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const notes = value.notes.trim()
      const toCash = kind === "devuelto" && value.method === "10"
      try {
        const result = await settleCommissionDebtApi({
          ...period,
          professionalUserId: detail.professionalUserId,
          // Cada moneda aparte, en la suya.
          currency: detail.currency,
          kind,
          ...(kind === "devuelto" && value.method ? { methodTypeCode: value.method } : {}),
          ...(toCash ? { branchId: value.branchId || defaultBranch } : {}),
          ...(notes ? { notes } : {}),
          expectedCents: detail.adjustmentCents,
        })
        refresh()
        if (toCash) invalidateFinance(queryClient)
        // Se dice lo que el servidor registró de verdad, y dónde quedó: en el mes de los cobros anulados,
        // que puede no ser el que se tiene abierto (ahí se ve entre sus pagos y ahí se anula).
        const saved = result.data.settlement
        const done = formatMoney(saved.commissionCents, saved.currency, detail.locale)
        const where =
          saved.periodYear && saved.periodMonth
            ? ` Queda en ${monthLabel({ year: saved.periodYear, month: saved.periodMonth }, detail.locale).toLocaleLowerCase(detail.locale)}, el mes de esos cobros.`
            : ""
        toast.success(
          kind === "devuelto"
            ? `Registrado: devolvió ${done} y ya no debe nada.${where}`
            : `Dado por saldado: ${done}. Ya no debe nada.${where}`,
        )
        onClose()
      } catch (err) {
        refresh()
        throw err
      }
    },
  })
  const surface = useFormSurface(form, { formMessage: financeFormMessage, fieldMap: { methodTypeCode: "method" } })
  const method = useStore(form.store, (state) => state.values.method)
  const branchId = useStore(form.store, (state) => state.values.branchId)
  const cashBranch = branchId || defaultBranch
  const inCash = kind === "devuelto" && method === "10"
  const cash = useCashState(cashBranch, open && inCash && canUseCash, detail.currency)
  const cashState = cash.data?.data ?? null
  const branchName = sede.branches.find((branch) => branch.id === cashBranch)?.name ?? ""

  // La sede activa es la propuesta; si llega tarde no pisa lo ya elegido.
  useEffect(() => {
    if (open && !form.getFieldValue("branchId") && defaultBranch)
      form.setFieldValue("branchId", defaultBranch, { dontUpdateMeta: true })
  }, [open, defaultBranch, form])
  useEffect(() => {
    if (open) return
    form.reset({ method: "", branchId: "", notes: "" })
  }, [open, form])

  return (
    <FormDrawer
      {...surface}
      dock={false}
      open={open}
      onClose={onClose}
      title={kind === "devuelto" ? "Registrar que lo devolvió" : "Darlo por saldado"}
      description={
        kind === "devuelto"
          ? `${name} devolvió ${owedText}${inCurrency} de comisiones ya pagadas de cobros que después se anularon.`
          : `La clínica perdona ${owedText}${inCurrency} que ${name} debe de comisiones ya pagadas de cobros que después se anularon.`
      }
      submitLabel={kind === "devuelto" ? `Registrar la devolución de ${owedText}` : "Darlo por saldado"}
      // En efectivo y sin ninguna sede no hay caja donde entre; el motivo está a la vista.
      submitDisabled={inCash && !cashBranch}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {kind === "devuelto"
            ? "Ya no debe nada: deja de descontarse de sus próximos pagos. Si te equivocas, puedes anularlo con su motivo."
            : "No se mueve dinero. Ya no debe nada: deja de descontarse de sus próximos pagos, y queda registrado quién lo decidió y cuándo. Si te equivocas, puedes anularlo con su motivo."}
        </p>
        {kind === "devuelto" ? (
          <>
            <form.AppField name="method">
              {(field) => (
                <field.Group legend="Cómo lo devolvió" className="gap-3">
                  {(control) => (
                    <ChoiceButtons
                      id={control.id}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      tone="primary"
                      value={field.state.value || null}
                      options={methods}
                      onChange={(next) => field.handleChange(next)}
                    />
                  )}
                </field.Group>
              )}
            </form.AppField>
            {inCash && pickBranch ? (
              <form.AppField name="branchId">
                {(field) => (
                  <field.Control label="Caja de la sede" description="El efectivo entra a la caja de esta sede.">
                    {(control) => (
                      <ChoiceSelect
                        id={control.id}
                        name={control.name}
                        value={field.state.value}
                        placeholder="Elige la sede"
                        required
                        aria-invalid={control.invalid || undefined}
                        aria-describedby={control.describedBy}
                        onBlur={control.onBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      >
                        {sede.branches.map((branch) => (
                          <option key={branch.id} value={branch.id}>
                            {branch.name}
                          </option>
                        ))}
                      </ChoiceSelect>
                    )}
                  </field.Control>
                )}
              </form.AppField>
            ) : null}
            {inCash ? (
              cashBranch ? (
                <p className="text-sm">
                  Entra al efectivo de la caja{currencyNamed ? ` de ${currencyWord(detail.currency, detail.locale)}` : ""}
                  {branchName ? ` de ${branchName}` : ""} como «Devolución de comisiones», sin su nombre
                  {cashState
                    ? `: la caja queda en ${formatMoney(cashState.cashOnHandCents + detail.adjustmentCents, detail.currency, detail.locale)}.`
                    : "."}
                </p>
              ) : (
                <p role="alert" className="text-sm text-destructive">
                  No hay una sede activa con una caja donde entre el efectivo.
                </p>
              )
            ) : method ? (
              <p className="text-sm text-muted-foreground">No toca la caja.</p>
            ) : null}
            <form.AppField name="notes">
              {(field) => <field.TextareaField label="Nota (opcional)" rows={2} maxLength={2000} />}
            </form.AppField>
          </>
        ) : (
          <form.AppField name="notes">
            {(field) => (
              <field.TextareaField
                label="Motivo"
                description="Corto: por qué la clínica lo perdona. Lo ven quien administra las comisiones y el profesional."
                rows={2}
                maxLength={FORGIVE_REASON_MAX}
                aria-required
              />
            )}
          </form.AppField>
        )}
      </div>
    </FormDrawer>
  )
}

// --- Anular un pago registrado --------------------------------------------------------

function VoidPaymentDrawer({
  payment,
  onClose,
  name,
  locale,
  timeZone,
}: {
  payment: CommissionPayment | null
  onClose: () => void
  name: string
  locale: string
  timeZone: string
}) {
  const queryClient = useQueryClient()
  const open = payment !== null

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: commissionKeys.all })
    void queryClient.invalidateQueries({ queryKey: ["finance-expenses"] })
    void queryClient.invalidateQueries({ queryKey: ["monthly-finance-result"] })
  }
  const form = useAppForm({
    defaultValues: { reason: "" },
    validators: { onSubmit: voidReasonSchema },
    onSubmit: async ({ value }) => {
      try {
        await voidCommissionPaymentApi(payment?.id ?? "", value.reason.trim())
        refresh()
        // Si salió de la caja (o entró, lo devuelto), anularlo lo revierte.
        invalidateFinance(queryClient)
        toast.success(
          payment?.kind === "devuelto"
            ? "Anulado: vuelve a deber lo que había devuelto"
            : payment?.kind === "saldado"
              ? "Anulado: vuelve a deber lo que se había dado por saldado"
              : "Pago anulado: sus cobros vuelven a quedar por pagar",
        )
        onClose()
      } catch (err) {
        refresh()
        throw err
      }
    },
  })
  const surface = useFormSurface(form, { formMessage: financeFormMessage })

  useEffect(() => {
    if (open) return
    form.reset({ reason: "" })
  }, [open, form])

  // El texto conserva el último pago mientras el cajón termina de cerrarse.
  const shown = useRef(payment)
  if (payment) shown.current = payment
  const last = shown.current
  const amount = last ? formatMoney(last.commissionCents, last.currency, locale) : ""
  const paidOn = last?.settledAt ? ` del ${dayLabel(last.settledAt, locale, timeZone)}` : ""
  const kind = last?.kind ?? "pago"

  return (
    <FormDrawer
      {...surface}
      dock={false}
      open={open}
      onClose={onClose}
      title={kind === "devuelto" ? "Anular la devolución" : kind === "saldado" ? "Anular «Dado por saldado»" : "Anular pago"}
      description={
        kind === "devuelto"
          ? `Lo que devolvió ${name}${paidOn}: ${amount}.`
          : kind === "saldado"
            ? `Lo que se dio por saldado a ${name}${paidOn}: ${amount}.`
            : `El pago de ${amount}${paidOn} a ${name}.`
      }
      submitLabel={kind === "pago" ? "Anular pago" : "Anular"}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {kind === "devuelto"
            ? "Vuelve a deber lo que había devuelto, y se descuenta de sus próximos pagos. Si entró a la caja, sale de ella. La anulación queda registrada con su motivo."
            : kind === "saldado"
              ? "Vuelve a deber lo que se había dado por saldado, y se descuenta de sus próximos pagos. La anulación queda registrada con su motivo."
              : "Se anula el pago (y su gasto, si salió dinero). Sus cobros vuelven a quedar por pagar. La anulación queda registrada con su motivo."}
        </p>
        <form.AppField name="reason">
          {(field) => (
            <field.TextareaField label="Motivo" rows={3} maxLength={2000} aria-required />
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

/** Los mismos límites que `POST /api/commissions/payments/:id/void`. */
const voidReasonSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Indica el motivo de la anulación.")
    .max(2000, "Escribe el motivo en 2000 caracteres como máximo."),
})

// --- Mis honorarios (cada profesional, primero en teléfono) ----------------------------

export function MyCommissionsPanel({
  period,
  currentMonth,
  locale,
  timeZone,
  onMonthChange,
}: {
  period: YearMonth
  /** Mes en curso de la clínica: destino de «Ver el mes actual». */
  currentMonth: YearMonth
  locale: string
  timeZone: string
  onMonthChange: (next: YearMonth) => void
}) {
  const queryClient = useQueryClient()
  // La lista completa se despliega por mes: al cambiar de mes vuelve a su resumen.
  const periodKey = `${period.year}-${period.month}`
  const [expandedFor, setExpandedFor] = useState<string | null>(null)
  const showAll = expandedFor === periodKey
  // La lista de lo atendido sin cobrar, igual: se despliega por mes.
  const [attendedFor, setAttendedFor] = useState<string | null>(null)
  const showAttended = attendedFor === periodKey
  const query = useQuery({
    queryKey: commissionKeys.mine(period),
    queryFn: () => fetchMyCommissions(period),
  })
  // Sus pagos del mes, también los anulados: el servidor da solo los propios a quien no administra.
  const myPayments = useQuery({
    queryKey: [...commissionKeys.mine(period), "pagos"],
    queryFn: () => fetchCommissionPayments({ ...period, includeVoided: true }),
  })
  useOrgEvents(COMMISSION_EVENT_KINDS, () => {
    void queryClient.invalidateQueries({ queryKey: commissionKeys.all })
  })

  if (query.isPending) {
    return (
      <SkeletonRegion message="Cargando honorarios…">
        <MyCommissionsSkeleton />
      </SkeletonRegion>
    )
  }
  if (query.isError) {
    return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  }

  const mine = query.data.data
  const zone = mine.timezone || timeZone
  const format = mine.locale || locale
  const money = (cents: number): string => formatMoney(cents, mine.currency, format)
  // Lo cobrado en otra moneda le da su comisión en esa moneda (ADR 0155): cada cifra con su símbolo.
  const others = mine.others ?? []
  const currencyOf = new Map<string, string>()
  for (const view of [mine, ...others]) for (const line of view.lines) currencyOf.set(lineKey(line), view.currency)
  const lineAmount = (cents: number, line: CommissionLine): string =>
    formatMoney(cents, currencyOf.get(lineKey(line)) ?? mine.currency, format)
  // Por fecha, lo más reciente primero: la vista previa muestra lo último que se cobró, en cualquier moneda.
  const sorted = [...mine.lines, ...others.flatMap((view) => view.lines)].sort(
    (a, b) => b.occurredAt.localeCompare(a.occurredAt) || lineKey(a).localeCompare(lineKey(b)),
  )
  const visible = showAll ? sorted : sorted.slice(0, PREVIEW_ROWS)
  const counted = countedLines(mine)
  // Lo ya pagado conserva su porcentaje: solo se dice uno si todos los cobros comparten el mismo.
  const rates = new Set(counted.map((line) => line.rateBps))
  const singleRate = rates.size === 1 ? [...rates][0] : rates.size === 0 ? mine.rateBps : null
  const isCurrent = compareMonths(period, currentMonth) === 0
  // Lo atendido sin cobrar, cada moneda aparte; sin ninguna comisión no hay «tu parte» que esperar.
  const hasServices = (mine.exceptions ?? []).length > 0
  const noCommission = mine.hasRate && mine.rateBps === 0 && !hasServices
  const unpaid =
    (mine.hasRate || hasServices) && !noCommission
      ? (mine.attended?.currencies ?? []).filter((item) => item.unpaidCents > 0)
      : []
  const unpaidItems = unpaid.length > 0 ? (mine.attended?.items ?? []) : []
  const firstUnpaid = unpaid[0]
  // Lo que debe, repartido una sola vez entre los meses anteriores con algo por pagar.
  const owedSplit = previousMonthsDiscounts(
    mine.previous,
    new Map([mine, ...others].map((view) => [view.currency, view.adjustmentCents])),
  )
  // Lo que falta descontarle es suyo, no del mes: se le dice aunque este mes ya esté saldado.
  const pendingDiscount =
    mine.adjustmentCents > mine.discountCents
      ? ` Quedan ${money(mine.adjustmentCents - mine.discountCents)} por descontar de tus próximos pagos.`
      : ""
  const statusNote =
    mine.status === "pagado" && mine.lastPaidAt
      ? `Liquidado el ${dayLabel(mine.lastPaidAt, format, zone, period.year)}.${pendingDiscount}`
      : mine.status === "por_descontar"
        ? `Lo de este mes se descuenta de comisiones que ya se te pagaron de cobros que después se anularon: ${money(mine.discountCents)}.`
        : mine.status === "por_pagar" && (mine.paidCents > 0 || mine.discountCents > 0)
          ? [
              mine.paidCents > 0 ? `Ya te pagaron ${money(mine.paidCents)}.` : "",
              mine.discountCents > 0
                ? `Se descuentan ${money(mine.discountCents)} de comisiones ya pagadas de cobros que después se anularon.`
                : "",
              `Falta pagarte ${money(mine.pendingCents)}.`,
            ]
              .filter(Boolean)
              .join(" ")
          : mine.status === "sin_cobros" && mine.baseCents > 0
            ? noCommission
              ? "No cobras comisión por lo que atiendes."
              : "Aún no tienes una comisión decidida. Consúltalo con la administración de la clínica."
            : null

  return (
    <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
      <section
        aria-label={`Me corresponde en ${monthLabel(period, format).toLocaleLowerCase(format)}`}
        className="elevated min-w-0 rounded-xl border bg-card p-5"
      >
        <p className="text-sm font-medium text-muted-foreground">Me corresponde</p>
        <p className="mt-1 text-3xl leading-tight font-bold tracking-tight tabular-nums">
          {money(mine.commissionCents + (mine.salary?.cents ?? 0))}
        </p>
        {mine.salary ? (
          // Solo quien tiene un sueldo anotado: sueldo + comisión.
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 text-sm">
            <dt className="text-muted-foreground">Sueldo</dt>
            <dd className="tabular-nums">
              {money(mine.salary.cents)}
              <span className="ml-2 text-muted-foreground">
                {mine.salary.dueCents > 0
                  ? "por pagar"
                  : mine.salary.paidAt
                    ? `pagado el ${dayLabel(mine.salary.paidAt, format, zone, period.year)}`
                    : "pagado"}
              </span>
            </dd>
            <dt className="text-muted-foreground">Comisión</dt>
            <dd className="tabular-nums">{money(mine.commissionCents)}</dd>
          </dl>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <StatusBadge status={mine.status} baseCents={mine.baseCents} />
          <span className="text-muted-foreground">
            {singleRate !== null && singleRate > 0
              ? `${percentLabel(singleRate, format)} de ${money(mine.baseCents)} cobrados`
              : `De ${money(mine.baseCents)} cobrados`}
          </span>
        </div>
        {statusNote ? <p className="mt-2 text-sm text-muted-foreground">{statusNote}</p> : null}
        {others.map((view) => (
          // Lo de otra moneda va aparte: se paga en esa moneda.
          <p key={view.currency} className="mt-2 text-sm">
            <span className="text-muted-foreground">En {currencyWord(view.currency, format)}: </span>
            <span className="font-semibold tabular-nums">{formatMoney(view.commissionCents, view.currency, format)}</span>
            <span className="text-muted-foreground">
              {" · "}
              {view.pendingCents > 0
                ? `falta pagarte ${formatMoney(view.pendingCents, view.currency, format)}`
                : (view.owedCents ?? 0) > 0
                  ? `se descuentan ${formatMoney(view.owedCents ?? 0, view.currency, format)} de tu próximo pago en ${currencyWord(view.currency, format)}`
                  : commissionStatusLabel(view.status, view.baseCents).toLocaleLowerCase(format)}
            </span>
          </p>
        ))}
        {(myPayments.data?.data ?? []).length > 0 ? (
          <ul aria-label="Mis pagos de este mes" className="mt-3 flex flex-col gap-1 border-t pt-3 text-sm">
            {(myPayments.data?.data ?? []).map((payment) => (
              <li key={payment.id} className="flex min-w-0 items-baseline justify-between gap-3">
                <span className={payment.voidedAt ? "text-muted-foreground line-through" : ""}>
                  {myPaymentTitle(payment, (iso) => dayLabel(iso, format, zone, period.year))}
                  {payment.voidedAt ? `, anulado el ${dayLabel(payment.voidedAt, format, zone, period.year)}` : ""}
                </span>
                <span className={`shrink-0 tabular-nums ${payment.voidedAt ? "text-muted-foreground line-through" : "font-medium"}`}>
                  {formatMoney(payment.commissionCents, payment.currency, format)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="mis-comisiones-detalle" className="flex min-w-0 flex-col gap-2">
        <h2 id="mis-comisiones-detalle" className="text-base font-semibold">
          De qué sale
        </h2>
        {sorted.length === 0 ? (
          <EmptyState
            title={`Sin cobros en ${monthLabel(period, format).toLocaleLowerCase(format)}`}
            description="Cuando se cobre algo de lo que atendiste, aparece aquí con tu comisión."
            actionLabel={isCurrent ? undefined : "Ver el mes actual"}
            onAction={() => onMonthChange(currentMonth)}
          />
        ) : (
          <>
            <ul className="elevated flex min-w-0 flex-col divide-y rounded-xl border bg-card">
              {visible.map((line) => (
                <li key={lineKey(line)} className="flex min-w-0 items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{line.patientName || "Paciente"}</p>
                    <p className="text-sm text-muted-foreground">
                      {line.description} · cobrado {lineAmount(line.baseCents, line)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {lineFacts(
                        line,
                        (iso) => dayLabel(iso, format, zone, period.year),
                        format,
                        currencyOf.get(lineKey(line)) ?? mine.currency,
                      )}
                    </p>
                    {line.voidedAfterPaid ? (
                      // Mientras lo debe, en rojo; ya cerrado, cómo se cerró.
                      <p className={cn("mt-1 text-sm", line.owedClosedBy ? "text-muted-foreground" : "text-destructive")}>
                        {line.owedClosedBy === "devuelto"
                          ? line.owedPartlyDiscounted
                            ? "El cobro se anuló después de pagarte: una parte se descontó de un pago y el resto lo devolviste."
                            : "El cobro se anuló después de pagarte: ya devolviste esa comisión."
                          : line.owedClosedBy === "saldado"
                            ? line.owedPartlyDiscounted
                              ? "El cobro se anuló después de pagarte: una parte se descontó de un pago y la clínica dio por saldado el resto."
                              : "El cobro se anuló después de pagarte: la clínica lo dio por saldado."
                            : line.owedClosedBy === "pago"
                              ? "El cobro se anuló después de pagarte: ya se descontó de un pago."
                              : "El cobro se anuló después de pagarte: se descuenta de tu siguiente pago."}
                      </p>
                    ) : line.settled ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {line.paidAt
                          ? `Liquidado el ${dayLabel(line.paidAt, format, zone, period.year)}`
                          : "Liquidado"}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={`shrink-0 font-semibold tabular-nums ${line.voidedAfterPaid ? "text-muted-foreground line-through" : ""}`}
                  >
                    {lineAmount(line.commissionCents, line)}
                  </span>
                </li>
              ))}
            </ul>
            {sorted.length > PREVIEW_ROWS ? (
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={showAll}
                  onClick={() => setExpandedFor(showAll ? null : periodKey)}
                >
                  {showAll ? "Ver menos" : showAllLabel(sorted)}
                </Button>
              </div>
            ) : null}
          </>
        )}
        {firstUnpaid ? (
          // Lo atendido que aún no se cobra va aquí, lejos de «Me corresponde»: no es lo que gana,
          // es de lo que saldrá su parte. Solo el servicio y el día: sin paciente ni importe de cada uno.
          <div className="flex min-w-0 flex-col gap-1 text-sm">
            <p>
              <span className="text-muted-foreground">Atendido y aún sin cobrar: </span>
              <span className="font-medium tabular-nums">{formatMoney(firstUnpaid.unpaidCents, firstUnpaid.currency, format)}</span>.
              {unpaid.length === 1 ? <span className="text-muted-foreground"> Tu parte llega cuando se cobre.</span> : null}
            </p>
            {unpaid.slice(1).map((item) => (
              // Cada moneda aparte: nunca se suman.
              <p key={item.currency}>
                <span className="text-muted-foreground">En {currencyWord(item.currency, format)}: </span>
                <span className="font-medium tabular-nums">{formatMoney(item.unpaidCents, item.currency, format)}</span>.
              </p>
            ))}
            {unpaid.length > 1 ? <p className="text-muted-foreground">Tu parte llega cuando se cobre.</p> : null}
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={showAttended}
                aria-controls={`sin-cobrar-${periodKey}`}
                onClick={() => setAttendedFor(showAttended ? null : periodKey)}
              >
                {showAttended ? "Ver menos" : unpaidItems.length === 1 ? "Ver el servicio" : `Ver los ${unpaidItems.length} servicios`}
              </Button>
            </div>
            {showAttended ? (
              <div id={`sin-cobrar-${periodKey}`} className="flex min-w-0 flex-col gap-2">
                {unpaid.map((group) => (
                  <div key={group.currency} className="flex min-w-0 flex-col gap-1">
                    {unpaid.length > 1 ? (
                      <p className="text-xs font-medium text-muted-foreground">En {currencyWord(group.currency, format)}</p>
                    ) : null}
                    <ul
                      aria-label={
                        unpaid.length > 1
                          ? `Atendido y aún sin cobrar en ${currencyWord(group.currency, format)}`
                          : "Atendido y aún sin cobrar"
                      }
                      className="elevated flex min-w-0 flex-col divide-y rounded-xl border bg-card"
                    >
                      {unpaidItems
                        .filter((item) => item.currency === group.currency)
                        .map((item) => (
                          <li key={item.id} className="flex min-w-0 items-baseline justify-between gap-3 px-4 py-2">
                            <span className="min-w-0 break-words">{item.description}</span>
                            <span className="shrink-0 text-muted-foreground">
                              {dayLabel(item.attendedAt, format, zone, period.year)}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Cuenta lo que ya se cobró de lo que atendiste. Lo atendido que aún no se cobra entra
            cuando el paciente pague.
          </p>
        )}
      </section>

      {mine.previous.length > 0 ? (
        <section
          aria-labelledby="mis-comisiones-anteriores"
          className="flex min-w-0 flex-col gap-2"
        >
          <h2 id="mis-comisiones-anteriores" className="text-base font-semibold">
            Meses anteriores
          </h2>
          <ul className="elevated flex min-w-0 flex-col divide-y rounded-xl border bg-card">
            {mine.previous.map((previous) => {
              const title =
                previous.year === period.year
                  ? monthName(previous.month, format)
                  : monthLabel(previous, format)
              return (
                <li key={`${previous.year}-${previous.month}`} className="min-w-0">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto w-full min-w-0 justify-start gap-3 rounded-none px-4 py-3 text-left font-normal whitespace-normal"
                    title={`Ver ${monthLabel(previous, format).toLocaleLowerCase(format)}`}
                    onClick={() => onMonthChange({ year: previous.year, month: previous.month })}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium text-foreground">{title}</span>
                      <span className="text-sm text-muted-foreground">
                        {[
                          previous.status === "pagado" && previous.lastPaidAt
                            ? `Liquidado el ${dayLabel(previous.lastPaidAt, format, zone, period.year)}`
                            : commissionStatusLabel(previous.status, previous.baseCents),
                          // Como la fila de la clínica: lo que se le descuenta de lo ya pagado, repartido una sola vez.
                          ...summaryCurrencies(previous).flatMap((view) => {
                            const cents = owedSplit.get(`${view.year}-${view.month}-${view.currency}`)?.discountCents ?? 0
                            return cents > 0 ? [`${formatMoney(cents, view.currency, format)} por descontar`] : []
                          }),
                        ].join(" · ")}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end text-base font-semibold text-foreground tabular-nums">
                      {summaryCurrencies(previous).map((view) => {
                        const split = owedSplit.get(`${view.year}-${view.month}-${view.currency}`)
                        // Con un descuento o un pago a cuenta, lo que se le pagará; si no, lo que le corresponde.
                        return (
                          <span key={view.currency}>
                            {split && (split.discountCents > 0 || (view.status === "por_pagar" && view.paidCents > 0))
                              ? `Falta ${formatMoney(split.pendingCents, view.currency, format)}`
                              : formatMoney(view.commissionCents, view.currency, format)}
                          </span>
                        )
                      })}
                    </span>
                    <ChevronRight aria-hidden className="text-muted-foreground" />
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
