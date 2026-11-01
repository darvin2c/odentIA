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
  if (status === "por_descontar") return <Badge variant="destructive">{label}</Badge>
  return <Badge variant="secondary">{label}</Badge>
}

/** Cobros ordenados de mayor a menor: los que más pesan en la comisión, primero. */
function byAmount(lines: CommissionLine[]): CommissionLine[] {
  return [...lines].sort(
    (a, b) => b.baseCents - a.baseCents || a.occurredAt.localeCompare(b.occurredAt),
  )
}

/** Cobros que cuentan para el mes: los anulados después de pagados ya no. */
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
  const nobodyHasRate = rows.every((row) => row.rateBps === 0)
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
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-base font-semibold text-foreground tabular-nums">
                        {formatMoney(row.commissionCents, row.currency, locale)}
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
          notFound="Esta persona ya no forma parte del equipo de la clínica."
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
  const payable = detail.pendingCents > 0
  const partial = detail.paidCents > 0 || detail.adjustmentCents > 0
  // El botón deshabilitado siempre dice por qué.
  const payHint = payable
    ? null
    : detail.status === "por_descontar"
      ? `Quedan ${money(-detail.pendingCents)} por descontar: se pagó la comisión de cobros que después se anularon y eso supera lo de este mes. Se descontará cuando haya más cobros.`
      : detail.status === "pagado"
        ? "Ya se pagó todo lo de este mes."
        : detail.rateBps === 0 && detail.baseCents > 0
          ? "No tiene un porcentaje fijado: fíjalo para calcular lo que le corresponde."
          : "No hay nada por pagar: aún no se cobró nada de lo que atendió este mes."

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
        {detail.rateBps > 0 ? (
          <p className="text-sm">
            <span className="text-lg font-semibold tabular-nums">
              {percentLabel(detail.rateBps, locale)}
            </span>{" "}
            <span className="text-muted-foreground">de lo cobrado</span>
          </p>
        ) : (
          <p className="text-sm font-medium">Sin porcentaje fijado</p>
        )}
        {canWrite ? (
          <Button type="button" variant="outline" size="sm" onClick={() => setRateOpen(true)}>
            {detail.rateBps > 0 ? "Cambiar" : "Fijar un porcentaje"}
          </Button>
        ) : null}
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
                    {line.voidedAfterPaid ? (
                      <Badge variant="destructive" className="ml-2">
                        Anulado después de pagado
                      </Badge>
                    ) : line.settled ? (
                      <Badge variant="success" className="ml-2">
                        {line.paidAt ? `Pagado el ${day(line.paidAt)}` : "Pagado"}
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
            Comisiones ya pagadas de cobros que después se anularon. Se descuentan del siguiente
            pago.
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
        {detail.adjustmentCents > 0 ? (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Por descontar</dt>
            <dd className="tabular-nums">−{plain(detail.adjustmentCents)}</dd>
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
            {payable ? `Registrar el pago de ${money(detail.pendingCents)}` : "Registrar el pago"}
          </Button>
          {payHint ? (
            <p id={payHintId} className="text-sm text-muted-foreground">
              {payHint}
            </p>
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
                    {payment.settledAt ? `Pagado el ${day(payment.settledAt)}` : "Pago registrado"}
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
        El pago queda como gasto de Personal. Lo que agrega caja sin atención, como vender{" "}
        {appWords().examples.soldItem}, no cuenta para ningún profesional.
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
  const pickBranch = sede.branches.length > 1

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: commissionKeys.all })
    void queryClient.invalidateQueries({ queryKey: ["finance-expenses"] })
    void queryClient.invalidateQueries({ queryKey: ["monthly-finance-result"] })
  }
  const form = useAppForm({
    defaultValues: { branchId: "", notes: "" },
    validators: {
      onSubmit: ({ value }) =>
        pickBranch && !value.branchId
          ? { fields: { branchId: "Elige la sede del gasto." } }
          : undefined,
    },
    onSubmit: async ({ value }) => {
      try {
        const notes = value.notes.trim()
        const result = await payMonthCommissionApi({
          ...period,
          professionalUserId: detail.professionalUserId,
          branchId: value.branchId,
          expectedCents: detail.pendingCents,
          ...(notes ? { notes } : {}),
        })
        refresh()
        // Se dice lo que el servidor pagó de verdad, no lo que mostraba la pantalla.
        toast.success(
          `Pago registrado: ${formatMoney(result.data.settlement.commissionCents, result.data.settlement.currency, detail.locale)}`,
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

  // La sede activa es la propuesta; si llega tarde no pisa lo ya elegido.
  useEffect(() => {
    if (open && !form.getFieldValue("branchId") && defaultBranch)
      form.setFieldValue("branchId", defaultBranch, { dontUpdateMeta: true })
  }, [open, defaultBranch, form])
  useEffect(() => {
    if (open) return
    form.reset({ branchId: "", notes: "" })
  }, [open, form])

  const amount = formatMoney(detail.pendingCents, detail.currency, detail.locale)
  const branchName = sede.branches.find((branch) => branch.id === branchId)?.name ?? ""

  return (
    <FormDrawer
      {...surface}
      dock={false}
      open={open}
      onClose={onClose}
      title="Registrar el pago"
      description={`${amount} a ${name} por ${monthLabel(period, detail.locale).toLocaleLowerCase(detail.locale)}.`}
      submitLabel={`Registrar el pago de ${amount}`}
      // Sin ninguna sede no hay dónde registrar el gasto; el motivo está a la vista.
      submitDisabled={!pickBranch && !branchId}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Queda como gasto de Personal y los cobros de este pago dejan de estar por pagar. Si te
          equivocas, puedes anular el pago con su motivo.
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
          Se anula el pago y su gasto de Personal. Sus cobros vuelven a quedar por pagar. La
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
  const statusNote =
    mine.status === "pagado" && mine.lastPaidAt
      ? `Pagado el ${dayLabel(mine.lastPaidAt, format, zone, period.year)}.`
      : mine.status === "por_descontar"
        ? `Ya se te pagó la comisión de cobros que después se anularon: quedan ${money(-mine.pendingCents)} por descontar de tus próximos pagos.`
        : mine.status === "por_pagar" && (mine.paidCents > 0 || mine.adjustmentCents > 0)
          ? [
              mine.paidCents > 0 ? `Ya te pagaron ${money(mine.paidCents)}.` : "",
              mine.adjustmentCents > 0
                ? `Se descuentan ${money(mine.adjustmentCents)} de comisiones ya pagadas de cobros que después se anularon.`
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
                    {line.voidedAfterPaid ? (
                      <p className="mt-1 text-sm text-destructive">
                        El cobro se anuló después de pagarte: se descuenta de tu siguiente pago.
                      </p>
                    ) : line.settled ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {line.paidAt
                          ? `Pagado el ${dayLabel(line.paidAt, format, zone, period.year)}`
                          : "Pagado"}
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
                          ? `Pagado el ${dayLabel(previous.lastPaidAt, format, zone, period.year)}`
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
