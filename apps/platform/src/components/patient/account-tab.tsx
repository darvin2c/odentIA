/**
 * Cuenta económica del paciente: tres cifras por moneda (por cobrar, pagado
 * neto, a favor), pendiente por concepto, cobros con ticket, histórico
 * pre-ticket de solo lectura, promociones vigentes y presupuestos aceptados
 * integrados. Sin datos clínicos: solo conceptos económicos y propuestas.
 *
 * El cobro se hace en un paso (CollectDrawer, moneda de la clínica); anular y
 * devolver, con motivo. Dinero con `@odentia/clinical`; locale y zona del
 * perfil (nada fijo).
 */
import { formatMoney, formatMoneyInput, parseMoney } from "@odentia/clinical"
import { Badge, Button, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import { DetailDrawer, EmptyState, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useId, useState } from "react"
import { CollectDrawer } from "../finance/collect-drawer"
import { printNodeById, TicketView, ticketDisplayNumber } from "../finance/ticket-view"
import { ChoiceSelect } from "../ui/choice-select"
import { apiFetch } from "../../lib/api"
import { useActiveBranch } from "../../lib/active-branch"
import { budgetNumberLabel, budgetStatusLabel, fetchBudgets } from "../../lib/budgets"
import type { BudgetLine } from "../../lib/budgets"
import { usePermission } from "../../lib/crm"
import { financeErrorMessage } from "../../lib/finance"
import {
  fetchPatientAccount3,
  fetchPaymentMethods,
  fetchActivePromotions,
  formatDateTimeShortLocale,
  refundApi,
  useBranchesOptions,
  useOrgFinanceProfile,
  voidTicketApi,
  type AccountCobro,
  type AccountSummary,
  type CollectResultBody,
  type RefundResult,
} from "../../lib/finance-collect"
import { useOrgEvents } from "../../lib/org-events"
import type { PatientFull } from "../../lib/patients"

const MAX_REASON = 2000

const FINANCE_EVENT_KINDS = [
  "payment.created",
  "payment.voided",
  "payment.refunded",
  "patient.account.updated",
  "encounter.finalized",
]

type BudgetLineView = BudgetLine & { promotionName?: string | null }

/** Lectura de formulario: null si el texto no es un importe válido. */
function parseOrNull(raw: string, currency: string, locale: string): number | null {
  try {
    return parseMoney(raw, currency, locale)
  } catch {
    return null
  }
}

export function AccountTab({ patientId }: { patientId: string }): React.JSX.Element {
  const uid = useId()
  const queryClient = useQueryClient()
  const canRead = usePermission("finance.read")
  const canWrite = usePermission("finance.write")
  const canBudgets = usePermission("budgets.read")
  const sede = useActiveBranch()
  const profile = useOrgFinanceProfile()
  const branches = useBranchesOptions()

  const [branchId, setBranchId] = useState("")
  const [cobrarOpen, setCobrarOpen] = useState(false)
  const [preset, setPreset] = useState<string[]>([])
  const [collect, setCollect] = useState<CollectResultBody | null>(null)
  const [voidRow, setVoidRow] = useState<AccountCobro | null>(null)
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [refundOpen, setRefundOpen] = useState(false)
  const [refundAmount, setRefundAmount] = useState("")
  const [refundMethod, setRefundMethod] = useState("")
  const [receipt, setReceipt] = useState<RefundResult | null>(null)

  const account = useQuery({
    queryKey: ["patient-account3", patientId],
    queryFn: () => fetchPatientAccount3(patientId),
    enabled: canRead,
  })
  const budgets = useQuery({
    queryKey: ["budgets", patientId],
    queryFn: () => fetchBudgets(patientId),
    enabled: canRead && canBudgets,
  })
  const promotions = useQuery({
    queryKey: ["active-promotions"],
    queryFn: () => fetchActivePromotions(),
    enabled: canRead,
  })
  const patient = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
    enabled: canRead,
  })
  const methods = useQuery({
    queryKey: ["org-payment-methods"],
    queryFn: fetchPaymentMethods,
    enabled: canRead,
  })

  // Moneda de la clínica para cobrar y devolver; la cuenta puede traer varias.
  const prof = profile.data?.data ?? null
  const orgUnit = prof?.currency ?? null
  const locale = prof?.locale ?? null
  const timeZone = prof?.timezone ?? null

  useOrgEvents(FINANCE_EVENT_KINDS, () => {
    void queryClient.invalidateQueries({ queryKey: ["patient-account3", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["budgets", patientId] })
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["patient-account3", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["finance-debts"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-cash"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-movements"] })
    void queryClient.invalidateQueries({ queryKey: ["finance-closures"] })
  }


  const refundMutation = useMutation({
    mutationFn: () =>
      refundApi(patientId, {
        branchId: effectiveBranch,
        amountCents: parseOrNull(refundAmount, orgUnit as string, locale as string) as number,
        ...(refundMethod ? { paymentMethodId: refundMethod } : {}),
        reason: reason.trim(),
      }),
    onSuccess: (result) => {
      setReceipt(result.data)
      setRefundOpen(false)
      setRefundAmount("")
      setReason("")
      setError(null)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })


  const voidMutation = useMutation({
    mutationFn: () => voidTicketApi(patientId, voidRow!.ticketId, reason.trim()),
    onSuccess: () => {
      setVoidRow(null)
      setReason("")
      setError(null)
      invalidate()
    },
    onError: (err) => setError(financeErrorMessage(err)),
  })

  if (!canRead) {
    return (
      <EmptyState
        title="Sin acceso a la cuenta"
        description="Tu rol no tiene permiso de finanzas. Pide a un administrador el rol de cajero."
      />
    )
  }
  if (account.isPending || profile.isPending) {
    return <p className="text-sm text-muted-foreground">Cargando cuenta del paciente…</p>
  }
  if (account.isError || !account.data) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-sm text-destructive">
          {account.error ? financeErrorMessage(account.error) : "No se pudo cargar la cuenta."}
        </p>
        <Button type="button" variant="outline" onClick={() => void account.refetch()}>
          Reintentar
        </Button>
      </div>
    )
  }
  if (profile.isError || !orgUnit || !locale || !timeZone) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-sm text-destructive">
          {profile.error
            ? financeErrorMessage(profile.error)
            : "La moneda, el formato y la zona de la clínica aún no están configurados."}
        </p>
        <Button type="button" variant="outline" onClick={() => void profile.refetch()}>
          Reintentar
        </Button>
      </div>
    )
  }

  const data = account.data.data
  const pending = data.pendiente
  const orgFavor = data.byCurrency.find((row) => row.currency === orgUnit)?.aFavor ?? 0
  const orgOwed = data.byCurrency.find((row) => row.currency === orgUnit)?.porCobrar ?? 0
  const patientName =
    (patient.data?.data as { displayName?: string } | undefined)?.displayName ?? "Paciente"
  const branchOptions = branches.data?.data ?? []
  const effectiveBranch = branchId || sede.branchId || sede.branches[0]?.id || branchOptions[0]?.id || ""
  const branchName = branchOptions.find((item) => item.id === effectiveBranch)?.name ?? ""

  const integrable = (budgets.data?.data ?? []).filter(
    (budget) => budget.status === "aceptado" || budget.status === "parcial",
  )
  const outstandingFor = (lineId: string) =>
    data.pendiente
      .filter((item) => item.budgetItemId === lineId)
      .reduce((sum, item) => sum + item.saldoCents, 0)

  const openCobrar = (chargeIds: string[]) => {
    if (!effectiveBranch) {
      setError("Elige la sede del cobro.")
      return
    }
    setError(null)
    setPreset(chargeIds)
    setCobrarOpen(true)
  }

  const refundPreview = parseOrNull(refundAmount, orgUnit, locale)

  return (
    <div className="flex flex-col gap-6">
      <div className="elevated rounded-xl border bg-card p-6">
        <h2 className="font-heading text-base font-medium">Cuenta del paciente</h2>
        {data.byCurrency.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Sin movimientos económicos.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-4">
            {data.byCurrency.map((balance) => (
              <div key={balance.currency}>
                <h3 className="text-sm font-semibold">{balance.currency}</h3>
                <dl className="mt-1 grid grid-cols-3 gap-4">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">Por cobrar</dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {formatMoney(balance.porCobrar, balance.currency, locale)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">Pagado</dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {formatMoney(balance.pagado, balance.currency, locale)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">A favor</dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {formatMoney(balance.aFavor, balance.currency, locale)}
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        )}
        {error && !cobrarOpen && !voidRow && !refundOpen ? (
          <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>
        ) : null}
        {canWrite ? (
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <Field>
              <FieldLabel htmlFor={`${uid}-branch`}>Sede del cobro</FieldLabel>
              <ChoiceSelect
                id={`${uid}-branch`}
                className="w-56"
                value={effectiveBranch}
                onChange={(event) => setBranchId(event.target.value)}
              >
                <option value="">Seleccionar sede</option>
                {branchOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </ChoiceSelect>
            </Field>
            <Button
              onClick={() =>
                openCobrar(pending.filter((item) => item.currency === orgUnit).map((item) => item.chargeId))
              }
            >
              Cobrar {formatMoney(orgOwed, orgUnit, locale)}
            </Button>
            {orgFavor > 0 ? (
              <Button
                variant="outline"
                onClick={() => {
                  setRefundAmount(formatMoneyInput(orgFavor, orgUnit, locale))
                  setReason("")
                  setError(null)
                  setRefundOpen(true)
                }}
              >
                Devolver dinero
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <section className="elevated rounded-xl border bg-card p-6">
        <h2 className="font-heading text-base font-medium">Pendiente</h2>
        {pending.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Ya no debe nada.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y">
            {pending.map((item) => (
              <li key={item.chargeId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{item.description}</p>
                  <p className="text-sm text-muted-foreground">
                    {item.currency} · Costó {formatMoney(item.totalCents, item.currency, locale)} · pagó{" "}
                    {formatMoney(item.paidCents, item.currency, locale)}
                    {item.since ? ` · desde ${formatDateTimeShortLocale(item.since, locale, timeZone)}` : ""}
                  </p>
                  {item.promotionName ? <Badge>{item.promotionName}</Badge> : null}
                </div>
                <span className="text-base font-semibold tabular-nums">
                  {formatMoney(item.saldoCents, item.currency, locale)}
                </span>
                {canWrite && item.currency === orgUnit ? (
                  <Button variant="outline" size="sm" onClick={() => openCobrar([item.chargeId])}>
                    Cobrar
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="elevated rounded-xl border bg-card p-6">
        <h2 className="font-heading text-base font-medium">Cobros</h2>
        {data.cobros.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Sin cobros registrados.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y">
            {data.cobros.map((row) => (
              <li key={row.ticketId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">Ticket {ticketDisplayNumber(row.number)}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatDateTimeShortLocale(row.createdAt, locale, timeZone)} ·{" "}
                    {row.payments.map((payment) => payment.methodName).join(" + ") || "—"}
                    {row.creditAppliedCents > 0 ? (
                      <span>
                        {" "}· saldo usado {formatMoney(row.creditAppliedCents, row.currency, locale)}
                      </span>
                    ) : null}
                  </p>
                  {row.status === "anulado" ? (
                    <p className="text-sm text-destructive">
                      Anulado{row.voidReason ? `: ${row.voidReason}` : ""}
                    </p>
                  ) : null}
                </div>
                <Badge>{row.status === "vigente" ? "Vigente" : "Anulado"}</Badge>
                <span className="text-base font-semibold tabular-nums">
                  {formatMoney(row.totalCents, row.currency, locale)}
                </span>
                {canWrite && row.status === "vigente" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setVoidRow(row)
                      setReason("")
                      setError(null)
                    }}
                  >
                    Anular
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.historico.length > 0 ? (
        <section className="elevated rounded-xl border bg-card p-6">
          <h2 className="font-heading text-base font-medium">Movimientos anteriores</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Pagos registrados antes del ticket: solo lectura, no se imprimen ni se anulan desde aquí.
          </p>
          <ul className="mt-2 flex flex-col divide-y">
            {data.historico.map((row) => (
              <li key={row.paymentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{row.methodName}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatDateTimeShortLocale(row.paidAt, locale, timeZone)}
                    {row.status === "anulado" ? (
                      <span className="text-destructive">
                        {" "}· Anulado{row.voidReason ? `: ${row.voidReason}` : ""}
                      </span>
                    ) : null}
                  </p>
                </div>
                <Badge>Histórico</Badge>
                <span className="text-base font-semibold tabular-nums">
                  {formatMoney(row.amountCents, row.currency, locale)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canBudgets ? (
        <section className="elevated rounded-xl border bg-card p-6">
          <h2 className="font-heading text-base font-medium">Presupuestos</h2>
          {budgets.isPending ? (
            <p className="mt-2 text-sm text-muted-foreground">Consultando propuestas…</p>
          ) : budgets.isError ? (
            <div className="mt-2 flex flex-col gap-2">
              <p role="alert" className="text-sm text-destructive">
                {financeErrorMessage(budgets.error)}
              </p>
              <Button type="button" variant="outline" onClick={() => void budgets.refetch()}>
                Reintentar
              </Button>
            </div>
          ) : integrable.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Sin propuestas aceptadas. Solo lo aceptado puede cobrarse.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-4">
              {integrable.map((budget) => (
                <li key={budget.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">
                      {budgetNumberLabel(budget.budgetNumber)} · {budget.title}
                    </p>
                    <Badge>{budgetStatusLabel(budget.status)}</Badge>
                    {budget.acceptedCents != null ? (
                      <span className="text-sm text-muted-foreground">
                        Aceptado {formatMoney(budget.acceptedCents, budget.currency, locale)}
                      </span>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      nativeButton={false}
                      render={
                        <Link
                          to="/patients/$patientId"
                          params={{ patientId }}
                          search={{ tab: "plan" }}
                        />
                      }
                    >
                      Ver propuesta
                    </Button>
                  </div>
                  <ul className="mt-2 flex flex-col divide-y">
                    {budget.items
                      .filter((line) => line.decision === "aceptado" && line.priceCents != null)
                      .map((line) => {
                        const view = line as BudgetLineView
                        const outstanding = outstandingFor(line.id)
                        return (
                          <li key={line.id} className="flex flex-wrap items-center gap-2 py-1 text-sm">
                            <span className="flex-1">{line.title}</span>
                            {view.promotionName ? <Badge>{view.promotionName}</Badge> : null}
                            <span className="text-muted-foreground tabular-nums">
                              {outstanding > 0
                                ? `Por cobrar ${formatMoney(outstanding, line.currency, locale)}`
                                : "Sin saldo pendiente"}
                            </span>
                          </li>
                        )
                      })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-4 font-heading text-sm font-medium">Promociones vigentes</h3>
          {promotions.isPending ? (
            <p className="mt-1 text-sm text-muted-foreground">Consultando promociones…</p>
          ) : promotions.isError ? (
            <div className="mt-1 flex flex-col gap-2">
              <p role="alert" className="text-sm text-destructive">
                {financeErrorMessage(promotions.error)}
              </p>
              <Button type="button" variant="outline" onClick={() => void promotions.refetch()}>
                Reintentar
              </Button>
            </div>
          ) : (promotions.data ?? []).length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">Sin promociones vigentes hoy.</p>
          ) : (
            <ul className="mt-1 flex flex-col divide-y">
              {(promotions.data ?? []).map((promo) => (
                <li key={promo.id} className="py-1 text-sm">
                  <span className="font-medium">{promo.name}</span>
                  {promo.conditions ? (
                    <span className="text-muted-foreground"> · {promo.conditions}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <CollectDrawer
        patientId={patientId}
        patientName={patientName}
        branchId={effectiveBranch}
        currency={orgUnit}
        presetChargeIds={preset}
        locale={locale}
        open={cobrarOpen}
        onClose={() => setCobrarOpen(false)}
        onCollected={(result) => {
          invalidate()
          setCollect(result)
        }}
      />

      <DetailDrawer
        open={collect !== null}
        onClose={() => setCollect(null)}
        title={collect ? `Cobro registrado · Ticket ${ticketDisplayNumber(collect.ticket.ticketNumber)}` : "Cobro registrado"}
      >
        {collect ? (
          <TicketView
            ticket={collect.ticket}
            remainingCents={collect.remainingCents}
            patientName={patientName}
            branchName={branchName}
            locale={locale}
            timeZone={timeZone}
            receiptWidth={prof?.receiptWidth}
            ticketFooter={prof?.ticketFooter}
            onChanged={invalidate}
          />
        ) : null}
      </DetailDrawer>

      <FormDrawer
        dock={false}
        open={voidRow !== null}
        title={voidRow ? `Anular cobro · Ticket ${ticketDisplayNumber(voidRow.number)}` : "Anular cobro"}
        description="El ticket queda marcado como anulado, no se borra. El paciente vuelve a deber el importe."
        error={error}
        isSubmitting={voidMutation.isPending}
        submitLabel="Anular cobro"
        onClose={() => {
          if (!voidMutation.isPending) {
            setVoidRow(null)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!reason.trim()) {
            setError("Indica el motivo de la anulación.")
            return
          }
          voidMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-void-reason`}>Motivo</FieldLabel>
          <Textarea
            id={`${uid}-void-reason`}
            maxLength={MAX_REASON}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </FormDrawer>

      <FormDrawer
        open={refundOpen}
        title="Devolver dinero"
        description={`Tiene ${formatMoney(orgFavor, orgUnit, locale)} a favor. Solo se devuelve lo que está a favor; salen del efectivo de la caja.`}
        error={error}
        isSubmitting={refundMutation.isPending}
        submitLabel={refundPreview !== null && refundPreview > 0 ? `Devolver ${formatMoney(refundPreview, orgUnit, locale)}` : "Devolver"}
        onClose={() => {
          if (!refundMutation.isPending) {
            setRefundOpen(false)
            setError(null)
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          const cents = parseOrNull(refundAmount, orgUnit, locale)
          if (cents === null || cents <= 0 || cents > orgFavor) {
            setError("Indica un importe válido hasta el saldo a favor.")
            return
          }
          if (!effectiveBranch) {
            setError("Elige la sede de cuya caja sale la devolución.")
            return
          }
          if (!reason.trim()) {
            setError("Indica el motivo de la devolución.")
            return
          }
          refundMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${uid}-refund-amount`}>Cuánto devuelves</FieldLabel>
            <Input
              id={`${uid}-refund-amount`}
              inputMode="decimal"
              value={refundAmount}
              onChange={(event) => setRefundAmount(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-refund-method`}>Cómo se lo devuelves</FieldLabel>
            <ChoiceSelect
              id={`${uid}-refund-method`}
              className="w-full"
              value={refundMethod}
              onChange={(event) => setRefundMethod(event.target.value)}
            >
              <option value="">Efectivo de la caja</option>
              {(methods.data?.data ?? [])
                .filter((item) => item.typeCode !== "10")
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </ChoiceSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-refund-reason`}>Motivo</FieldLabel>
            <Textarea
              id={`${uid}-refund-reason`}
              maxLength={MAX_REASON}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <DetailDrawer
        open={receipt !== null}
        onClose={() => setReceipt(null)}
        title="Constancia de devolución"
      >
        {receipt ? (
          <div className="flex flex-col gap-3">
            <div id={`devolucion-${patientId}`} className="flex flex-col gap-1 rounded-md border bg-card p-4 text-sm">
              <p className="text-center font-heading text-base font-semibold">DEVOLUCIÓN</p>
              <p className="text-center text-muted-foreground">
                {formatDateTimeShortLocale(receipt.refundedAt, locale, timeZone)}
              </p>
              <div className="mt-2 flex justify-between gap-2">
                <span className="text-muted-foreground">Paciente</span>
                <span className="font-medium">{patientName}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Medio</span>
                <span>{receipt.methodName}</span>
              </div>
              <div className="flex justify-between gap-2 font-semibold">
                <span>Devuelto</span>
                <span className="tabular-nums">
                  {formatMoney(receipt.amountCents, receipt.currency, locale)}
                </span>
              </div>
            </div>
            <div>
              <Button type="button" variant="outline" onClick={() => printNodeById(`devolucion-${patientId}`)}>
                Imprimir constancia
              </Button>
            </div>
          </div>
        ) : null}
      </DetailDrawer>
    </div>
  )
}
