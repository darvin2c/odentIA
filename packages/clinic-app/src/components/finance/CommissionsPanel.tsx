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
import { canAttend } from "@odentia/auth/permissions"
import { formatMoney } from "@odentia/clinical"
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
import { useNavigate } from "@tanstack/react-router"
import { Check, ChevronRight, Percent, Plus } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { useActiveBranch } from "../../lib/active-branch"
import {
  type CommissionLine,
  type CommissionPayment,
  type CommissionStatus,
  commissionStatusLabel,
  compareMonths,
  dayLabel,
  fetchCommissionPayments,
  fetchMonthCommissions,
  fetchMyCommissions,
  fetchProfessionalCommissions,
  type MonthlyCommissions,
  monthLabel,
  monthName,
  payMonthCommissionApi,
  percentInput,
  percentLabel,
  plainAmount,
  rateBpsFromPercent,
  setCommissionRateApi,
  voidCommissionPaymentApi,
  type YearMonth,
} from "../../lib/commissions"
import { useOrgMembers, usePermission } from "../../lib/crm"
import { financeFormMessage } from "../../lib/finance"
import { invalidateFinance, useCashState } from "../../lib/finance-cash"
import { useOrgEvents } from "../../lib/org-events"
import { QueryErrorState } from "../../lib/query-error"
import { ChoiceSelect } from "../ui/choice-select"

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
}

function countLabel(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
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

/** Cobros ordenados de mayor a menor: los que más pesan en la comisión, primero. */
function byAmount(lines: CommissionLine[]): CommissionLine[] {
  return [...lines].sort(
    (a, b) => b.baseCents - a.baseCents || a.occurredAt.localeCompare(b.occurredAt),
  )
}

/** Cobros que cuentan para el mes: los anulados después de pagados ya no. */
/**
 * La cuenta de una línea, en una frase: cuándo se cobró, con qué porcentaje y con qué promoción.
 * Con esto se comprueba cada comisión sin salir de la pantalla.
 */
function lineFacts(line: CommissionLine, day: (iso: string) => string, locale: string): string {
  return [day(line.occurredAt), line.rateBps > 0 ? percentLabel(line.rateBps, locale) : "sin porcentaje", line.promotionName]
    .filter(Boolean)
    .join(" · ")
}

const LIQUIDATION_HOLDER_ID = "liquidacion-para-imprimir"

/**
 * La liquidación del mes de un profesional, para entregarle (y que haga su recibo): cada cobro con
 * su fecha, paciente, servicio, lo cobrado, el porcentaje y la comisión, y al pie lo que le
 * corresponde, lo pagado, lo descontado y lo que falta. Se arma con texto (nunca HTML del dato) y se
 * imprime como la hoja de un cierre de caja; desde ahí el navegador también la guarda en PDF.
 */
function printLiquidation(detail: MonthlyCommissions, name: string, period: YearMonth, locale: string, zone: string): void {
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
  holder.append(el("h1", `Liquidación de comisiones · ${monthLabel(period, locale)}`))
  holder.append(el("p", name))
  const table = el("table")
  const head = el("tr")
  for (const title of ["Fecha", "Paciente", "Servicio", "Cobrado", "%", "Comisión"]) head.append(el("th", title))
  table.append(head)
  for (const line of [...detail.lines].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))) {
    const row = el("tr")
    for (const text of [
      dayLabel(line.occurredAt, locale, zone, period.year),
      line.patientName || "Paciente",
      [line.description, line.promotionName].filter(Boolean).join(" · ") + (line.voidedAfterPaid ? " (anulado después de pagado)" : ""),
      plain(line.baseCents),
      line.rateBps > 0 ? percentLabel(line.rateBps, locale) : "—",
      plain(line.commissionCents),
    ])
      row.append(el("td", text))
    table.append(row)
  }
  holder.append(table)
  const totals = el("dl")
  for (const [label, cents] of [
    ["Le corresponde", detail.commissionCents],
    ["Ya pagado", detail.paidCents],
    ["Ya descontado", detail.discountedCents],
    ["Se descuenta en el próximo pago", detail.discountCents],
    ["Falta pagar", detail.pendingCents],
  ] as const) {
    if (cents === 0 && label !== "Le corresponde" && label !== "Falta pagar") continue
    totals.append(el("dt", label), el("dd", plain(cents)))
  }
  holder.append(totals)
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

// --- Administración: el mes de toda la clínica ---------------------------------------

export function CommissionsAdminPanel({
  period,
  locale,
  timeZone,
  selectedId,
  onSelect,
}: {
  period: YearMonth
  locale: string
  timeZone: string
  /** Profesional con el detalle abierto. */
  selectedId: string | null
  onSelect: (professionalUserId: string | null) => void
}) {
  const queryClient = useQueryClient()
  const canWrite = usePermission("commissions.write")
  const members = useOrgMembers()
  const [newRateOpen, setNewRateOpen] = useState(false)

  const monthQuery = useQuery({
    queryKey: commissionKeys.month(period),
    queryFn: () => fetchMonthCommissions(period),
  })
  useOrgEvents(COMMISSION_EVENT_KINDS, () => {
    void queryClient.invalidateQueries({ queryKey: commissionKeys.all })
  })

  const rows = monthQuery.data?.data ?? []
  const rateById = new Map(rows.map((row) => [row.professionalUserId, row.rateBps]))
  // Quien puede atender y aún no tiene porcentaje: decide el permiso, no el nombre del rol.
  const withoutRate = members
    .filter((member) => canAttend(member.role))
    .filter((member) => (rateById.get(member.userId) ?? 0) === 0)
    .map((member) => ({ userId: member.userId, name: member.user.name }))
  const nobodyHasRate = rows.filter((row) => row.inTeam).every((row) => row.rateBps === 0)
  const selectedRow = rows.find((row) => row.professionalUserId === selectedId) ?? null
  const selectedName =
    selectedRow?.professionalName ??
    members.find((member) => member.userId === selectedId)?.user.name ??
    "Profesional"

  // El detalle abierto sobrevive al cambio de mes: solo la lista espera su carga.
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {monthQuery.isPending ? (
        <SkeletonRegion message="Cargando comisiones…">
          <CommissionsMonthSkeleton />
        </SkeletonRegion>
      ) : monthQuery.isError ? (
        <QueryErrorState error={monthQuery.error} onRetry={() => void monthQuery.refetch()} />
      ) : nobodyHasRate ? (
        <EmptyState
          icon={Percent}
          title="Aún no hay porcentajes"
          description="Fija el porcentaje de cada profesional para saber cuánto le corresponde por lo que atendió y ya se cobró."
          actionLabel={canWrite && withoutRate.length > 0 ? "Fijar un porcentaje" : undefined}
          onAction={() => setNewRateOpen(true)}
        />
      ) : null}

      {rows.some((row) => row.pendingCents > 0) ? (
        // Una línea, no otra tarjeta: cuánto falta pagar del mes entre todos.
        <p className="text-sm text-muted-foreground">
          Falta pagar{" "}
          <span className="font-semibold text-foreground tabular-nums">
            {formatMoney(
              rows.reduce((total, row) => total + Math.max(0, row.pendingCents), 0),
              rows[0]?.currency ?? "",
              locale,
            )}
          </span>{" "}
          de {formatMoney(rows.reduce((total, row) => total + row.commissionCents, 0), rows[0]?.currency ?? "", locale)}{" "}
          · {rows.filter((row) => row.pendingCents > 0).length === 1 ? "1 profesional" : `${rows.filter((row) => row.pendingCents > 0).length} profesionales`}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <section aria-label="Profesionales" className="elevated min-w-0 rounded-xl border bg-card">
          <ul className="flex min-w-0 flex-col divide-y">
            {rows.map((row) => {
              const name = row.professionalName ?? "Profesional fuera del equipo"
              const selected = row.professionalUserId === selectedId
              return (
                <li key={row.professionalUserId} className="min-w-0">
                  <Button
                    type="button"
                    variant="ghost"
                    aria-current={selected ? "true" : undefined}
                    className="h-auto w-full min-w-0 justify-start gap-3 rounded-none px-4 py-3 text-left font-normal whitespace-normal aria-[current=true]:bg-muted"
                    onClick={() => onSelect(row.professionalUserId)}
                  >
                    <PersonAvatar name={name} fallbackClassName="text-xs" decorative />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium text-foreground">{name}</span>
                      <span className="text-sm text-muted-foreground">
                        Se cobró {plainAmount(row.baseCents, row.currency, locale)} de lo que
                        atendió
                        {" · "}
                        {row.rateBps > 0 ? percentLabel(row.rateBps, locale) : "sin porcentaje"}
                        {row.inTeam ? null : " · Ya no está en el equipo"}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      {/* Con un pago a cuenta, lo que importa es lo que falta. */}
                      <span className="text-base font-semibold text-foreground tabular-nums">
                        {row.status === "por_pagar" && row.paidCents > 0
                          ? `Falta ${formatMoney(row.pendingCents, row.currency, locale)}`
                          : formatMoney(row.commissionCents, row.currency, locale)}
                      </span>
                      <StatusBadge status={row.status} baseCents={row.baseCents} />
                    </span>
                  </Button>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      {canWrite && monthQuery.isSuccess && !nobodyHasRate && withoutRate.length > 0 ? (
        <div>
          <Button type="button" variant="outline" onClick={() => setNewRateOpen(true)}>
            <Plus aria-hidden />
            Fijar el porcentaje de otra persona
          </Button>
        </div>
      ) : null}

      <ProfessionalDetail
        professionalUserId={selectedId}
        fallbackName={selectedName}
        period={period}
        locale={locale}
        timeZone={timeZone}
        onClose={() => onSelect(null)}
      />

      <RateDrawer
        open={newRateOpen}
        onClose={() => setNewRateOpen(false)}
        professional={null}
        candidates={withoutRate}
        currentRateBps={0}
        locale={locale}
      />
    </div>
  )
}

// --- Administración: el detalle de un profesional -------------------------------------

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
  const collections = detail ? countedLines(detail).length : 0
  const name = detail?.professionalName ?? fallbackName
  const monthText = monthLabel(period, locale)
  const description = detail
    ? `${monthText} · ${
        collections > 0
          ? `${countLabel(collections, "cobro", "cobros")} de tratamientos que atendió`
          : "sin cobros de tratamientos que atendió"
      }`
    : monthText

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
  const navigate = useNavigate()
  const canWrite = usePermission("commissions.write")
  const canFinance = usePermission("finance.read")
  const payHintId = useId()
  const [showAll, setShowAll] = useState(false)
  const [rateOpen, setRateOpen] = useState(false)
  const [payOpen, setPayOpen] = useState(false)
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
  const money = (cents: number): string => formatMoney(cents, detail.currency, locale)
  // Importes secundarios sin símbolo, como en el tablero; el principal de cada bloque lo conserva.
  const plain = (cents: number): string => plainAmount(cents, detail.currency, locale)
  const day = (iso: string): string => dayLabel(iso, locale, zone, period.year)
  const sorted = byAmount(detail.lines)
  const visible = showAll ? sorted : sorted.slice(0, PREVIEW_ROWS)
  const payments = paymentsQuery.data?.data ?? []
  // Se puede registrar mientras el mes tenga cobros sin pagar; si el descuento los cubre, no sale dinero.
  const payable = detail.pendingCents > 0 || detail.discountCents > 0
  const discountOnly = detail.pendingCents === 0 && detail.discountCents > 0
  const partial = detail.paidCents > 0 || detail.discountCents > 0
  // Lo que queda por descontar después de este pago, para el siguiente.
  const discountLeft = detail.adjustmentCents - detail.discountCents
  // El botón deshabilitado siempre dice por qué; el de solo descontar, qué va a pasar.
  const payHint = discountOnly
    ? `Lo de este mes (${money(detail.discountCents)}) se descuenta de comisiones ya pagadas de cobros que después se anularon: no sale dinero.${discountLeft > 0 ? ` Quedan ${money(discountLeft)} por descontar en los próximos pagos.` : ""}`
    : payable
      ? discountLeft > 0
        ? `Quedan ${money(discountLeft)} por descontar en los próximos pagos.`
        : null
      : detail.status === "pagado"
        ? "No queda nada por pagar de este mes."
        : detail.rateBps === 0 && detail.baseCents > 0
          ? detail.inTeam
            ? "No tiene un porcentaje fijado: fíjalo para calcular lo que le corresponde."
            : "Ya no está en el equipo y no tenía un porcentaje fijado: no le corresponde comisión."
          : "No hay nada por pagar: aún no se cobró nada de lo que atendió este mes."

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
        {detail.rateBps > 0 ? (
          <p className="text-sm">
            <span className="text-lg font-semibold tabular-nums">
              {percentLabel(detail.rateBps, locale)}
            </span>{" "}
            {/* Es el de hoy: cada línea dice el suyo, que en lo ya pagado puede ser otro. */}
            <span className="text-muted-foreground">de lo cobrado, vigente</span>
          </p>
        ) : (
          <p className="text-sm font-medium">Sin porcentaje fijado</p>
        )}
        {canWrite && detail.inTeam ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setRateOpen(true)}>
            {detail.rateBps > 0 ? "Cambiar" : "Fijar un porcentaje"}
          </Button>
        ) : null}
        {detail.inTeam ? null : (
          // Su porcentaje ya no cambia (solo se fija a quien puede atender); lo que ganó se le paga igual.
          <p className="w-full text-sm text-muted-foreground">
            Ya no está en el equipo. Lo que le corresponde por lo que atendió se le paga igual; su
            porcentaje ya no cambia.
          </p>
        )}
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          title="Sin cobros este mes"
          description="Cuando se cobre algo de lo que atendió, aparece aquí con su comisión."
          actionLabel={canFinance ? "Abrir Finanzas" : undefined}
          onAction={() => void navigate({ to: "/finance" })}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="h-9 pl-0">
                  Cobro
                </TableHead>
                <TableHead scope="col" className="h-9 text-right">
                  Cobrado
                </TableHead>
                <TableHead scope="col" className="h-9 pr-0 text-right">
                  Comisión
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((line) => (
                <TableRow key={line.applicationId}>
                  <TableCell className="py-2 pl-0 whitespace-normal">
                    <span className="font-medium">{line.patientName || "Paciente"}</span>
                    <span className="text-muted-foreground"> · {line.description}</span>
                    <span className="block text-xs text-muted-foreground">{lineFacts(line, day, locale)}</span>
                    {line.voidedAfterPaid ? (
                      <Badge variant="destructive" className="ml-2">
                        Anulado después de pagado
                      </Badge>
                    ) : line.settled ? (
                      <Badge variant="success" className="ml-2">
                        {line.paidAt ? `Liquidado el ${day(line.paidAt)}` : "Liquidado"}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "py-2 text-right text-muted-foreground tabular-nums",
                      line.voidedAfterPaid && "line-through",
                    )}
                  >
                    {plain(line.baseCents)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "py-2 pr-0 text-right font-medium tabular-nums",
                      line.voidedAfterPaid && "text-muted-foreground line-through",
                    )}
                  >
                    {plain(line.commissionCents)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {sorted.length > PREVIEW_ROWS ? (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-3"
                aria-expanded={showAll}
                onClick={() => setShowAll((value) => !value)}
              >
                {showAll ? "Ver menos" : `Ver los ${sorted.length} cobros`}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {detail.adjustments.length > 0 ? (
        <section aria-label="Por descontar" className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-semibold">Por descontar</h3>
          <p className="text-sm text-muted-foreground">
            Comisiones ya pagadas de cobros que después se anularon. Se descuentan de los próximos
            pagos que registres, de este mes o de otro, hasta completarse.
          </p>
          <ul className="flex min-w-0 flex-col divide-y rounded-lg border">
            {detail.adjustments.map((adjustment) => (
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
                  −{plain(adjustment.commissionCents)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <dl className="flex flex-col gap-2 border-t pt-4 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Cobrado de lo que atendió</dt>
          <dd className="tabular-nums">{plain(detail.baseCents)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="font-semibold">Le corresponde</dt>
          <dd className="text-xl font-bold tabular-nums">{money(detail.commissionCents)}</dd>
        </div>
        {detail.paidCents > 0 ? (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Ya pagado</dt>
            <dd className="tabular-nums">{plain(detail.paidCents)}</dd>
          </div>
        ) : null}
        {detail.discountedCents > 0 ? (
          // Lo que los pagos de este mes ya descontaron: sin esto, «Le corresponde − Ya pagado» no cuadra.
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Ya descontado</dt>
            <dd className="tabular-nums">−{plain(detail.discountedCents)}</dd>
          </div>
        ) : null}
        {detail.discountCents > 0 ? (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Se descuenta</dt>
            <dd className="tabular-nums">−{plain(detail.discountCents)}</dd>
          </div>
        ) : null}
        {partial && payable ? (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="font-semibold">Falta pagar</dt>
            <dd className="font-semibold tabular-nums">{money(detail.pendingCents)}</dd>
          </div>
        ) : null}
      </dl>

      {canWrite ? (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            className="w-full"
            disabled={!payable}
            aria-describedby={payHint ? payHintId : undefined}
            onClick={() => setPayOpen(true)}
          >
            {discountOnly
              ? "Registrar el descuento"
              : payable
                ? `Registrar el pago de ${money(detail.pendingCents)}`
                : "Registrar el pago"}
          </Button>
          {payHint ? (
            <p id={payHintId} className="text-sm text-muted-foreground">
              {payHint}
            </p>
          ) : null}
          {detail.lines.length > 0 ? (
            <Button type="button" variant="outline" className="w-full" onClick={() => printLiquidation(detail, name, period, locale, zone)}>
              Imprimir la liquidación
            </Button>
          ) : null}
        </div>
      ) : null}

      {paymentsQuery.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : paymentsQuery.isError ? (
        <QueryErrorState error={paymentsQuery.error} onRetry={() => void paymentsQuery.refetch()} />
      ) : payments.length > 0 ? (
        <section aria-label="Pagos registrados" className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-semibold">Pagos registrados</h3>
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
                    {payment.commissionCents === 0
                      ? // Un descuento que cubrió todo lo del mes: no salió dinero.
                        payment.settledAt
                        ? `Descontado el ${day(payment.settledAt)}, sin pago`
                        : "Descuento registrado, sin pago"
                      : payment.settledAt
                        ? `Pagado el ${day(payment.settledAt)}`
                        : "Pago registrado"}
                  </span>
                  {payment.notes ? (
                    <span className="block text-muted-foreground">{payment.notes}</span>
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
                    Anular pago
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {discountOnly ? "Un descuento no registra gasto." : "El pago queda en Gastos como pago de comisiones."} Solo
        comisiona lo cobrado de una atención; una venta suelta, como{" "}
        {appWords().examples.soldItem}, no es de ningún profesional.
      </p>

      <RateDrawer
        open={rateOpen}
        onClose={() => setRateOpen(false)}
        professional={{ userId: detail.professionalUserId, name }}
        currentRateBps={detail.rateBps}
        locale={locale}
      />
      <PayDrawer
        open={payOpen}
        onClose={() => setPayOpen(false)}
        detail={detail}
        name={name}
        period={period}
      />
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

// --- Fijar o cambiar el porcentaje ----------------------------------------------------

function RateDrawer({
  open,
  onClose,
  professional,
  candidates = [],
  currentRateBps,
  locale,
}: {
  open: boolean
  onClose: () => void
  /** Profesional ya elegido; `null` deja elegirlo entre `candidates`. */
  professional: { userId: string; name: string } | null
  candidates?: Array<{ userId: string; name: string }>
  currentRateBps: number
  locale: string
}) {
  const queryClient = useQueryClient()
  const initial = currentRateBps > 0 ? percentInput(currentRateBps, locale) : ""
  const form = useAppForm({
    defaultValues: { professionalUserId: professional?.userId ?? "", percent: initial },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.professionalUserId) fields.professionalUserId = "Elige a la persona"
        if (rateBpsFromPercent(value.percent) === null)
          fields.percent = "Escribe un porcentaje entre 0 y 100, con dos decimales como máximo."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      await setCommissionRateApi({
        professionalUserId: value.professionalUserId,
        rateBps: rateBpsFromPercent(value.percent) ?? 0,
      })
      void queryClient.invalidateQueries({ queryKey: commissionKeys.all })
      toast.success("Porcentaje guardado")
      onClose()
    },
  })
  const surface = useFormSurface(form, {
    formMessage: financeFormMessage,
    fieldMap: { rateBps: "percent" },
  })

  // Cada apertura parte del porcentaje vigente.
  const professionalId = professional?.userId ?? ""
  useEffect(() => {
    if (!open) return
    form.reset({ professionalUserId: professionalId, percent: initial })
  }, [open, initial, professionalId, form])

  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={onClose}
      title={currentRateBps > 0 ? "Cambiar el porcentaje" : "Fijar un porcentaje"}
      description={
        professional
          ? `Lo que le corresponde a ${professional.name} de lo cobrado por lo que atendió.`
          : "Lo que le corresponde a la persona de lo cobrado por lo que atendió."
      }
      submitLabel="Guardar"
    >
      <div className="flex flex-col gap-4">
        {professional ? null : (
          <form.AppField name="professionalUserId">
            {(field) => (
              <field.Control label="Profesional">
                {(control) => (
                  <ChoiceSelect
                    id={control.id}
                    name={control.name}
                    value={field.state.value}
                    placeholder="Elige a la persona"
                    required
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    {candidates.map((candidate) => (
                      <option key={candidate.userId} value={candidate.userId}>
                        {candidate.name}
                      </option>
                    ))}
                  </ChoiceSelect>
                )}
              </field.Control>
            )}
          </form.AppField>
        )}
        <form.AppField name="percent">
          {(field) => (
            <field.TextField
              label="Porcentaje de lo cobrado (%)"
              description="Se aplica a lo que aún no se ha pagado. Lo ya pagado conserva el porcentaje con que se pagó."
              inputMode="decimal"
              autoComplete="off"
              inputClassName="w-32"
            />
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

// --- Registrar el pago (un solo paso) -------------------------------------------------

function PayDrawer({
  open,
  onClose,
  detail,
  name,
  period,
}: {
  open: boolean
  onClose: () => void
  detail: MonthlyCommissions
  name: string
  period: YearMonth
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
  const form = useAppForm({
    defaultValues: { branchId: "", notes: "", fromCash: false },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (pickBranch && !value.branchId) fields.branchId = "Elige la sede del gasto."
        // Mismo freno que en un gasto: el efectivo nunca queda negativo, y se dice qué hacer.
        if (value.fromCash && cashState && cashState.cashOnHandCents < detail.pendingCents)
          fields.fromCash = `En la caja solo hay ${formatMoney(cashState.cashOnHandCents, detail.currency, detail.locale)}: no alcanza para pagarlo con el efectivo. Si el dinero está en el cajón, regístralo antes en Finanzas con «Ingresar o retirar efectivo». Si se pagó por transferencia, deja la casilla sin marcar.`
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
          expectedCents: detail.pendingCents,
          ...(notes ? { notes } : {}),
          ...(value.fromCash && canUseCash ? { fromCash: true } : {}),
        })
        refresh()
        if (value.fromCash) invalidateFinance(queryClient)
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
  const fromCash = useStore(form.store, (state) => state.values.fromCash)
  const cashBranch = branchId || defaultBranch
  const cash = useCashState(cashBranch, open && canUseCash, detail.currency)
  const cashState = cash.data?.data ?? null
  const cashAfter = cashState ? cashState.cashOnHandCents - detail.pendingCents : null

  // La sede activa es la propuesta; si llega tarde no pisa lo ya elegido.
  useEffect(() => {
    if (open && !form.getFieldValue("branchId") && defaultBranch)
      form.setFieldValue("branchId", defaultBranch, { dontUpdateMeta: true })
  }, [open, defaultBranch, form])
  useEffect(() => {
    if (open) return
    form.reset({ branchId: "", notes: "", fromCash: false })
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
          <form.AppField name="fromCash">
            {(field) => (
              <FormChoiceField
                label="Se pagó con el efectivo de la caja"
                description={
                  !fromCash
                    ? "Déjala sin marcar si se pagó por transferencia u otro medio: no toca la caja."
                    : cashAfter === null || cashAfter < 0
                      ? "Se descuenta del efectivo que debe haber al cerrar."
                      : `Se descuenta del efectivo que debe haber al cerrar: la caja queda en ${formatMoney(cashAfter, detail.currency, detail.locale)}.`
                }
              >
                {(control) => (
                  <Checkbox
                    id={control.id}
                    aria-invalid={control.invalid || undefined}
                    aria-describedby={control.describedBy}
                    checked={field.state.value}
                    onCheckedChange={(checked) => {
                      field.handleChange(checked === true)
                      control.onBlur()
                    }}
                  />
                )}
              </FormChoiceField>
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="notes">
          {(field) => <field.TextareaField label="Nota (opcional)" rows={2} maxLength={2000} />}
        </form.AppField>
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
        // Si salió de la caja, anularlo la devuelve.
        invalidateFinance(queryClient)
        toast.success("Pago anulado: sus cobros vuelven a quedar por pagar")
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

  return (
    <FormDrawer
      {...surface}
      dock={false}
      open={open}
      onClose={onClose}
      title="Anular pago"
      description={`El pago de ${amount}${paidOn} a ${name}.`}
      submitLabel="Anular pago"
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Se anula el pago (y su gasto, si salió dinero). Sus cobros vuelven a quedar por pagar. La
          anulación queda registrada con su motivo.
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

// --- Mis comisiones (cada profesional, primero en teléfono) ----------------------------

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
      <SkeletonRegion message="Cargando comisiones…">
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
  const plain = (cents: number): string => plainAmount(cents, mine.currency, format)
  const sorted = byAmount(mine.lines)
  const visible = showAll ? sorted : sorted.slice(0, PREVIEW_ROWS)
  const counted = countedLines(mine)
  // Lo ya pagado conserva su porcentaje: solo se dice uno si todos los cobros comparten el mismo.
  const rates = new Set(counted.map((line) => line.rateBps))
  const singleRate = rates.size === 1 ? [...rates][0] : rates.size === 0 ? mine.rateBps : null
  const isCurrent = compareMonths(period, currentMonth) === 0
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
            ? "Aún no tienes un porcentaje fijado. Consúltalo con la administración de la clínica."
            : null

  return (
    <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
      <section
        aria-label={`Me corresponde en ${monthLabel(period, format).toLocaleLowerCase(format)}`}
        className="elevated min-w-0 rounded-xl border bg-card p-5"
      >
        <p className="text-sm font-medium text-muted-foreground">Me corresponde</p>
        <p className="mt-1 text-3xl leading-tight font-bold tracking-tight tabular-nums">
          {money(mine.commissionCents)}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <StatusBadge status={mine.status} baseCents={mine.baseCents} />
          <span className="text-muted-foreground">
            {singleRate !== null && singleRate > 0
              ? `${percentLabel(singleRate, format)} de ${plain(mine.baseCents)} cobrados`
              : `De ${plain(mine.baseCents)} cobrados`}
          </span>
        </div>
        {statusNote ? <p className="mt-2 text-sm text-muted-foreground">{statusNote}</p> : null}
        {(myPayments.data?.data ?? []).length > 0 ? (
          <ul aria-label="Mis pagos de este mes" className="mt-3 flex flex-col gap-1 border-t pt-3 text-sm">
            {(myPayments.data?.data ?? []).map((payment) => (
              <li key={payment.id} className="flex min-w-0 items-baseline justify-between gap-3">
                <span className={payment.voidedAt ? "text-muted-foreground line-through" : ""}>
                  {payment.commissionCents === 0
                    ? `Descuento del ${payment.settledAt ? dayLabel(payment.settledAt, format, zone, period.year) : "mes"}`
                    : `Pago del ${payment.settledAt ? dayLabel(payment.settledAt, format, zone, period.year) : "mes"}`}
                  {payment.voidedAt ? `, anulado el ${dayLabel(payment.voidedAt, format, zone, period.year)}` : ""}
                </span>
                <span className={`shrink-0 tabular-nums ${payment.voidedAt ? "text-muted-foreground line-through" : "font-medium"}`}>
                  {plain(payment.commissionCents)}
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
                <li key={line.applicationId} className="flex min-w-0 items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{line.patientName || "Paciente"}</p>
                    <p className="text-sm text-muted-foreground">
                      {line.description} · cobrado {plain(line.baseCents)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {lineFacts(line, (iso) => dayLabel(iso, format, zone, period.year), format)}
                    </p>
                    {line.voidedAfterPaid ? (
                      <p className="mt-1 text-sm text-destructive">
                        El cobro se anuló después de pagarte: se descuenta de tu siguiente pago.
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
                    {plain(line.commissionCents)}
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
                  {showAll ? "Ver menos" : `Ver los ${sorted.length} cobros`}
                </Button>
              </div>
            ) : null}
          </>
        )}
        <p className="text-sm text-muted-foreground">
          Cuenta lo que ya se cobró de lo que atendiste. Lo atendido que aún no se cobra entra
          cuando el paciente pague.
        </p>
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
                        {previous.status === "pagado" && previous.lastPaidAt
                          ? `Liquidado el ${dayLabel(previous.lastPaidAt, format, zone, period.year)}`
                          : commissionStatusLabel(previous.status, previous.baseCents)}
                      </span>
                    </span>
                    <span className="shrink-0 text-base font-semibold text-foreground tabular-nums">
                      {formatMoney(previous.commissionCents, previous.currency, format)}
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
