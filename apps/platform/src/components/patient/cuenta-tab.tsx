/**
 * Cuenta económica del paciente: cargos, anticipos, aplicaciones y devoluciones.
 *
 * Aceptar una propuesta no genera cargos: el cargo se emite explícitamente desde
 * la línea aceptada, desde un procedimiento realizado o como concepto manual.
 * Nada se borra: las correcciones son anulaciones con motivo. Los importes nunca
 * se suman entre monedas distintas.
 */
import { Badge, Button, Field, FieldLabel, Input, Textarea } from "@odentia/ui"
import { EmptyState, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import { apiFetch } from "../../lib/api"
import { fetchBudgets } from "../../lib/budgets"
import {
  applyPaymentApi,
  centsFromInput,
  chargeAvailability,
  createChargeApi,
  createPaymentApi,
  fetchPatientAccount,
  formatDate,
  mutationMessage,
  PAYMENT_METHOD_LABELS,
  PAYMENT_METHODS,
  type PaymentMethod,
  paymentAvailability,
  refundPaymentApi,
  voidChargeApi,
  voidPaymentApi,
  voidPaymentApplicationApi,
} from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { fetchShifts } from "../../lib/finance"
import type { PatientFull, PlanItem } from "../../lib/patients"
import { formatMoney } from "../../lib/services"

const MAX_TEXT = 2000
const MAX_REFERENCE = 200
const CURRENCIES = ["PEN", "USD", "EUR"] as const

const BALANCE_LABELS: Array<[string, keyof AccountKeys]> = [
  ["Acordado", "agreedCents"],
  ["Cargado", "chargedCents"],
  ["Pagado", "paidCents"],
  ["Aplicado", "appliedCents"],
  ["Devuelto", "refundedCents"],
  ["Por cobrar", "outstandingCents"],
  ["Anticipo disponible", "availableCreditCents"],
]
interface AccountKeys {
  agreedCents: number
  chargedCents: number
  paidCents: number
  appliedCents: number
  refundedCents: number
  outstandingCents: number
  availableCreditCents: number
}

/** Cuenta económica del paciente: cargos, anticipos, aplicaciones y devoluciones. */
export function CuentaTab({ patientId }: { patientId: string }): React.JSX.Element {
  const uid = useId()
  const canRead = usePermission("finance.read")
  const canWrite = usePermission("finance.write")
  const queryClient = useQueryClient()
  const account = useQuery({
    queryKey: ["patient-account", patientId],
    queryFn: () => fetchPatientAccount(patientId),
  })
  const budgets = useQuery({
    queryKey: ["budgets", patientId],
    queryFn: () => fetchBudgets(patientId),
  })
  const patient = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => apiFetch<{ data: PatientFull }>(`/api/patients/${patientId}`),
  })
  const planItems = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
  })
  // Turnos abiertos para ingresar el cobro a caja sin duplicar (solo lectura).
  const openShifts = useQuery({
    queryKey: ["finance-shifts-open"],
    queryFn: () => fetchShifts("abierta"),
    enabled: canRead,
  })

  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<
    | "charge-source"
    | "charge-manual"
    | "payment"
    | "apply"
    | "refund"
    | "void-charge"
    | "void-payment"
    | "void-application"
    | null
  >(null)
  const [budgetItemId, setBudgetItemId] = useState("")
  const [chargeAmount, setChargeAmount] = useState("")
  const [description, setDescription] = useState("")
  const [chargeCurrency, setChargeCurrency] = useState<string>("PEN")
  const [planItemId, setPlanItemId] = useState("")
  const [paymentAmount, setPaymentAmount] = useState("")
  const [paymentCurrency, setPaymentCurrency] = useState<string>("PEN")
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("efectivo")
  const [paymentReference, setPaymentReference] = useState("")
  const [payerContactId, setPayerContactId] = useState("")
  const [applyPaymentId, setApplyPaymentId] = useState("")
  const [applyChargeId, setApplyChargeId] = useState("")
  const [applyAmount, setApplyAmount] = useState("")
  const [refundPaymentId, setRefundPaymentId] = useState("")
  const [refundAmount, setRefundAmount] = useState("")
  const [targetId, setTargetId] = useState("")
  const [reason, setReason] = useState("")
  const [paymentShiftId, setPaymentShiftId] = useState("")
  const [compensateShiftId, setCompensateShiftId] = useState("")

  const data = account.data?.data
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["patient-account", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["patient-summary", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["treatment-journey", patientId] })
    void queryClient.invalidateQueries({ queryKey: ["budgets", patientId] })
  }
  const close = () => {
    setForm(null)
    setError(null)
    setReason("")
    setPaymentShiftId("")
    setCompensateShiftId("")
  }

  const createChargeMutation = useMutation({
    mutationFn: () =>
      createChargeApi(patientId, {
        budgetItemId: budgetItemId || null,
        planItemId: budgetItemId ? null : planItemId || null,
        description: budgetItemId ? undefined : description.trim(),
        amountCents: budgetItemId ? undefined : (centsFromInput(chargeAmount) ?? undefined),
        currency: budgetItemId ? undefined : chargeCurrency,
      }),
    onSuccess: () => {
      close()
      setChargeAmount("")
      setDescription("")
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  const createPaymentMutation = useMutation({
    mutationFn: () =>
      createPaymentApi(patientId, {
        amountCents: centsFromInput(paymentAmount) ?? 0,
        currency: paymentCurrency,
        paidAt: new Date().toISOString(),
        method: paymentMethod,
        reference: paymentReference.trim() || null,
        payerContactId: payerContactId || null,
        shiftId: paymentShiftId || null,
      }),
    onSuccess: () => {
      close()
      setPaymentAmount("")
      setPaymentReference("")
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  const applyMutation = useMutation({
    mutationFn: () =>
      applyPaymentApi(patientId, applyPaymentId, {
        chargeId: applyChargeId,
        amountCents: centsFromInput(applyAmount) ?? 0,
      }),
    onSuccess: () => {
      close()
      setApplyAmount("")
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  const refundMutation = useMutation({
    mutationFn: () =>
      refundPaymentApi(patientId, refundPaymentId, {
        amountCents: centsFromInput(refundAmount) ?? 0,
        reason: reason.trim(),
      }),
    onSuccess: () => {
      close()
      setRefundAmount("")
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  const voidChargeMutation = useMutation({
    mutationFn: () => voidChargeApi(patientId, targetId, { reason: reason.trim() }),
    onSuccess: () => {
      close()
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  const voidPaymentMutation = useMutation({
    mutationFn: () =>
      voidPaymentApi(patientId, targetId, {
        reason: reason.trim(),
        compensateShiftId: compensateShiftId || null,
      }),
    onSuccess: () => {
      close()
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })
  const voidApplicationMutation = useMutation({
    mutationFn: () => voidPaymentApplicationApi(patientId, targetId, { reason: reason.trim() }),
    onSuccess: () => {
      close()
      invalidate()
    },
    onError: (mutationError) => setError(mutationMessage(mutationError)),
  })

  if (!canRead) {
    return (
      <EmptyState
        title="Sin acceso a la cuenta"
        description="Tu rol no tiene permiso de finanzas. Pide a un administrador el rol de cajero."
      />
    )
  }
  if (account.isPending) {
    return <p className="text-sm text-muted-foreground">Cargando cuenta del paciente…</p>
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-sm text-destructive">
          {account.error?.message ?? "No se pudo cargar la cuenta del paciente."}
        </p>
        <Button type="button" variant="outline" onClick={() => void account.refetch()}>
          Reintentar
        </Button>
      </div>
    )
  }

  const charges = chargeAvailability(data)
  const payments = paymentAvailability(data)
  const patientContacts = patient.data?.data.contacts ?? []
  const eligibleLines = (budgets.data?.data ?? [])
    .filter((budget) => budget.status === "aceptado" || budget.status === "parcial")
    .flatMap((budget) =>
      budget.items
        .filter((line) => line.decision === "aceptado" && line.priceCents != null)
        .map((line) => {
          const generated = data.charges
            .filter(
              (charge) =>
                charge.planItemId === line.planItemId &&
                charge.currency === line.currency &&
                !charge.voidedAt,
            )
            .reduce((sum, charge) => sum + charge.amountCents, 0)
          return {
            line,
            budget,
            remainingCents: (line.priceCents ?? 0) - generated,
          }
        })
        .filter((entry) => entry.remainingCents > 0),
    )
  const contactName = (contactId: string | null) =>
    contactId
      ? (patientContacts.find((contact) => contact.contactId === contactId)?.displayName ??
        "Contacto")
      : null

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-md bg-card p-6">
        <div className="flex flex-col gap-1.5">
          <div className="font-heading text-base font-medium">Cuenta del paciente</div>
          <p className="text-sm text-muted-foreground">
            Aceptar una propuesta no genera cargos. Lo acordado es lo aceptado en las propuestas
            vigentes; lo cargado y lo cobrado son movimientos explícitos.
          </p>
        </div>
        {data.byCurrency.length === 0 ? (
          <EmptyState
            title="Sin movimientos económicos"
            description="Genera un cargo desde una propuesta aceptada o registra un anticipo cuando corresponda."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {data.byCurrency.map((balance) => (
              <div key={balance.currency} className="flex flex-col gap-2">
                <h4 className="text-sm font-semibold">{balance.currency}</h4>
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  {BALANCE_LABELS.map(([label, field]) => (
                    <div key={field}>
                      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                        {label}
                      </dt>
                      <dd className="text-lg font-semibold tabular-nums">
                        {formatMoney(balance[field], balance.currency)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        )}
      </div>

      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setError(null)
              setBudgetItemId(eligibleLines[0]?.line.id ?? "")
              setChargeAmount(eligibleLines[0] ? String(eligibleLines[0].remainingCents / 100) : "")
              setForm("charge-source")
            }}
          >
            Generar cargo de una propuesta aceptada
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null)
              setForm("charge-manual")
            }}
          >
            Registrar cargo manual
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null)
              setForm("payment")
            }}
          >
            Registrar pago o anticipo
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-4 rounded-md bg-card p-6">
        <div className="font-heading text-base font-medium">Cargos</div>
        {charges.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin cargos registrados.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {charges.map(({ charge, pendingCents, appliedCents }) => (
              <li key={charge.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{charge.description}</span>
                  <Badge variant={charge.voidedAt ? "destructive" : "secondary"}>
                    {charge.voidedAt ? "Anulado" : "Activo"}
                  </Badge>
                  <span className="text-sm tabular-nums">
                    {formatMoney(charge.amountCents, charge.currency)}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Aplicado {formatMoney(appliedCents, charge.currency)} · pendiente{" "}
                  {formatMoney(pendingCents, charge.currency)}
                  {charge.dueAt ? ` · vence ${formatDate(charge.dueAt)}` : ""}
                </p>
                {charge.voidReason ? (
                  <p className="text-sm text-muted-foreground">Anulado: {charge.voidReason}</p>
                ) : null}
                {canWrite && !charge.voidedAt ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={appliedCents > 0}
                      onClick={() => {
                        setError(null)
                        setTargetId(charge.id)
                        setForm("void-charge")
                      }}
                    >
                      Anular cargo
                    </Button>
                    {pendingCents > 0 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setError(null)
                          setApplyChargeId(charge.id)
                          setApplyPaymentId(
                            payments.find((p) => p.availableCents > 0)?.payment.id ?? "",
                          )
                          setApplyAmount(String(pendingCents / 100))
                          setForm("apply")
                        }}
                      >
                        Aplicar un pago
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {canWrite && !charge.voidedAt && appliedCents > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Para anularlo, anula primero sus aplicaciones.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-4 rounded-md bg-card p-6">
        <div className="font-heading text-base font-medium">Pagos, aplicaciones y devoluciones</div>
        {payments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin pagos registrados.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {payments.map(({ payment, availableCents }) => (
              <li key={payment.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium tabular-nums">
                    {formatMoney(payment.amountCents, payment.currency)}
                  </span>
                  <Badge variant={payment.voidedAt ? "destructive" : "secondary"}>
                    {payment.voidedAt
                      ? "Anulado"
                      : PAYMENT_METHOD_LABELS[payment.method as PaymentMethod]
                        ? PAYMENT_METHOD_LABELS[payment.method as PaymentMethod]
                        : payment.method}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    {formatDate(payment.paidAt)}
                    {payment.reference ? ` · ${payment.reference}` : ""}
                    {contactName(payment.payerContactId)
                      ? ` · paga ${contactName(payment.payerContactId)}`
                      : ""}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Disponible sin aplicar: {formatMoney(availableCents, payment.currency)}
                </p>
                {(() => {
                  const applications = data.applications.filter(
                    (application) => application.paymentId === payment.id && !application.voidedAt,
                  )
                  if (applications.length === 0) return null
                  return (
                    <ul className="flex flex-col gap-1 text-sm">
                      {applications.map((application) => {
                        const charge = data.charges.find(
                          (candidate) => candidate.id === application.chargeId,
                        )
                        return (
                          <li key={application.id} className="flex flex-wrap items-center gap-2">
                            <span>
                              Aplicado {formatMoney(application.amountCents, payment.currency)} a{" "}
                              {charge?.description ?? "cargo"}
                            </span>
                            {canWrite ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setError(null)
                                  setTargetId(application.id)
                                  setForm("void-application")
                                }}
                              >
                                Anular aplicación
                              </Button>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  )
                })()}
                {(() => {
                  const refunds = data.refunds.filter((refund) => refund.paymentId === payment.id)
                  if (refunds.length === 0) return null
                  return (
                    <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                      {refunds.map((refund) => (
                        <li key={refund.id}>
                          Devuelto {formatMoney(refund.amountCents, payment.currency)} ·{" "}
                          {refund.reason} · {formatDate(refund.refundedAt)}
                        </li>
                      ))}
                    </ul>
                  )
                })()}
                {canWrite && !payment.voidedAt ? (
                  <div className="flex flex-wrap gap-2">
                    {availableCents > 0 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setError(null)
                          setApplyPaymentId(payment.id)
                          setApplyChargeId(
                            charges.find(
                              (entry) =>
                                entry.pendingCents > 0 &&
                                entry.charge.currency === payment.currency,
                            )?.charge.id ?? "",
                          )
                          setApplyAmount(String(availableCents / 100))
                          setForm("apply")
                        }}
                      >
                        Aplicar a un cargo
                      </Button>
                    ) : null}
                    {availableCents > 0 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setError(null)
                          setRefundPaymentId(payment.id)
                          setRefundAmount(String(availableCents / 100))
                          setForm("refund")
                        }}
                      >
                        Devolver excedente
                      </Button>
                    ) : null}
                    {data.applications.every(
                      (application) => application.paymentId !== payment.id,
                    ) && data.refunds.every((refund) => refund.paymentId !== payment.id) ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setError(null)
                          setTargetId(payment.id)
                          setForm("void-payment")
                        }}
                      >
                        Anular pago
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {payment.voidReason ? (
                  <p className="text-sm text-muted-foreground">Anulado: {payment.voidReason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <FormDrawer
        open={form === "charge-source"}
        title="Generar cargo de una propuesta aceptada"
        description="El cargo conserva la línea y el tratamiento de su origen; nunca supera el importe pendiente de esa línea."
        error={form === "charge-source" ? error : null}
        isSubmitting={createChargeMutation.isPending}
        submitLabel="Generar cargo"
        onClose={() => {
          if (!createChargeMutation.isPending) close()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!budgetItemId) {
            setError("Elige la línea aceptada de la que generar el cargo.")
            return
          }
          createChargeMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          {eligibleLines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No hay líneas aceptadas con importe pendiente de generar.
            </p>
          ) : (
            <Field>
              <FieldLabel htmlFor={`${uid}-budget-line`}>Línea aceptada</FieldLabel>
              <select
                id={`${uid}-budget-line`}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={budgetItemId}
                onChange={(event) => {
                  setBudgetItemId(event.target.value)
                  const entry = eligibleLines.find((item) => item.line.id === event.target.value)
                  setChargeAmount(entry ? String(entry.remainingCents / 100) : "")
                }}
              >
                <option value="">Seleccionar línea</option>
                {eligibleLines.map(({ line, budget, remainingCents }) => (
                  <option key={line.id} value={line.id}>
                    {budget.title} · {line.title} · pendiente{" "}
                    {formatMoney(remainingCents, line.currency)}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </FormDrawer>

      <FormDrawer
        open={form === "charge-manual"}
        title="Registrar cargo manual"
        description="Úsalo solo para conceptos que no provienen de una propuesta ni de un procedimiento."
        error={form === "charge-manual" ? error : null}
        isSubmitting={createChargeMutation.isPending}
        submitLabel="Registrar cargo"
        onClose={() => {
          if (!createChargeMutation.isPending) close()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!description.trim()) {
            setError("Describe el concepto del cargo.")
            return
          }
          if (centsFromInput(chargeAmount) == null) {
            setError("Indica un importe positivo con hasta dos decimales.")
            return
          }
          createChargeMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${uid}-charge-description`}>Concepto del cargo</FieldLabel>
            <Input
              id={`${uid}-charge-description`}
              maxLength={MAX_TEXT}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-charge-amount`}>Importe</FieldLabel>
            <Input
              id={`${uid}-charge-amount`}
              value={chargeAmount}
              onChange={(event) => setChargeAmount(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-charge-currency`}>Moneda</FieldLabel>
            <select
              id={`${uid}-charge-currency`}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={chargeCurrency}
              onChange={(event) => setChargeCurrency(event.target.value)}
            >
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-charge-item`}>Tratamiento</FieldLabel>
            <select
              id={`${uid}-charge-item`}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={planItemId}
              onChange={(event) => setPlanItemId(event.target.value)}
            >
              <option value="">Sin tratamiento asociado</option>
              {(planItems.data?.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                  {item.toothNumber != null ? ` · Pieza ${item.toothNumber}` : ""}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        open={form === "payment"}
        title="Registrar pago o anticipo"
        description="Un anticipo es simplemente un pago sin aplicaciones; queda disponible para aplicarlo después."
        error={form === "payment" ? error : null}
        isSubmitting={createPaymentMutation.isPending}
        submitLabel="Registrar pago"
        onClose={() => {
          if (!createPaymentMutation.isPending) close()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (centsFromInput(paymentAmount) == null) {
            setError("Indica un importe positivo con hasta dos decimales.")
            return
          }
          createPaymentMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${uid}-payment-amount`}>Importe</FieldLabel>
            <Input
              id={`${uid}-payment-amount`}
              value={paymentAmount}
              onChange={(event) => setPaymentAmount(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-payment-currency`}>Moneda</FieldLabel>
            <select
              id={`${uid}-payment-currency`}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={paymentCurrency}
              onChange={(event) => setPaymentCurrency(event.target.value)}
            >
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-payment-method`}>Medio de pago</FieldLabel>
            <select
              id={`${uid}-payment-method`}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}
            >
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>
                  {PAYMENT_METHOD_LABELS[method]}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-payment-payer`}>Quién paga</FieldLabel>
            <select
              id={`${uid}-payment-payer`}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={payerContactId}
              onChange={(event) => setPayerContactId(event.target.value)}
            >
              <option value="">Sin especificar</option>
              {patientContacts.map((contact) => (
                <option key={contact.contactId} value={contact.contactId}>
                  {contact.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-payment-reference`}>Referencia</FieldLabel>
            <Input
              id={`${uid}-payment-reference`}
              maxLength={MAX_REFERENCE}
              value={paymentReference}
              onChange={(event) => setPaymentReference(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-payment-shift`}>Turno de caja (opcional)</FieldLabel>
            <select
              id={`${uid}-payment-shift`}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={paymentShiftId}
              onChange={(event) => setPaymentShiftId(event.target.value)}
            >
              <option value="">Sin turno (solo cuenta)</option>
              {(openShifts.data?.data ?? [])
                .filter((shift) => shift.currency === paymentCurrency)
                .map((shift) => (
                  <option key={shift.id} value={shift.id}>
                    Turno {shift.currency} · {shift.id.slice(0, 8)}
                    {paymentMethod === "efectivo"
                      ? " · entra al arqueo"
                      : " · electrónico, sin arqueo"}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        open={form === "apply"}
        title="Aplicar pago a un cargo"
        description="Solo se ofrece el saldo realmente disponible del pago y lo pendiente del cargo, en la misma moneda."
        error={form === "apply" ? error : null}
        isSubmitting={applyMutation.isPending}
        submitLabel="Aplicar"
        onClose={() => {
          if (!applyMutation.isPending) close()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!applyPaymentId || !applyChargeId) {
            setError("Elige el pago y el cargo.")
            return
          }
          if (centsFromInput(applyAmount) == null) {
            setError("Indica un importe positivo con hasta dos decimales.")
            return
          }
          applyMutation.mutate()
        }}
      >
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={`${uid}-apply-payment`}>Pago disponible</FieldLabel>
            <select
              id={`${uid}-apply-payment`}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={applyPaymentId}
              onChange={(event) => setApplyPaymentId(event.target.value)}
            >
              <option value="">Seleccionar pago</option>
              {payments
                .filter((entry) => !entry.payment.voidedAt && entry.availableCents > 0)
                .map(({ payment, availableCents }) => (
                  <option key={payment.id} value={payment.id}>
                    {formatDate(payment.paidAt)} · disponible{" "}
                    {formatMoney(availableCents, payment.currency)}
                  </option>
                ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-apply-charge`}>Cargo pendiente</FieldLabel>
            <select
              id={`${uid}-apply-charge`}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={applyChargeId}
              onChange={(event) => setApplyChargeId(event.target.value)}
            >
              <option value="">Seleccionar cargo</option>
              {charges
                .filter((entry) => entry.pendingCents > 0)
                .map(({ charge, pendingCents }) => (
                  <option key={charge.id} value={charge.id}>
                    {charge.description} · pendiente {formatMoney(pendingCents, charge.currency)}
                  </option>
                ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-apply-amount`}>Importe a aplicar</FieldLabel>
            <Input
              id={`${uid}-apply-amount`}
              value={applyAmount}
              onChange={(event) => setApplyAmount(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        open={form === "refund"}
        title="Devolver excedente"
        description="Solo puede devolverse dinero no aplicado. Para devolver un importe aplicado, anula primero su aplicación."
        error={form === "refund" ? error : null}
        isSubmitting={refundMutation.isPending}
        submitLabel="Registrar devolución"
        onClose={() => {
          if (!refundMutation.isPending) close()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (centsFromInput(refundAmount) == null) {
            setError("Indica un importe positivo con hasta dos decimales.")
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
            <FieldLabel htmlFor={`${uid}-refund-payment`}>Pago</FieldLabel>
            <select
              id={`${uid}-refund-payment`}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={refundPaymentId}
              onChange={(event) => {
                setRefundPaymentId(event.target.value)
                const entry = payments.find((item) => item.payment.id === event.target.value)
                setRefundAmount(entry ? String(entry.refundableCents / 100) : "")
              }}
            >
              <option value="">Seleccionar pago</option>
              {payments
                .filter((entry) => !entry.payment.voidedAt && entry.refundableCents > 0)
                .map(({ payment, refundableCents }) => (
                  <option key={payment.id} value={payment.id}>
                    {formatDate(payment.paidAt)} · devoluble{" "}
                    {formatMoney(refundableCents, payment.currency)}
                  </option>
                ))}
            </select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-refund-amount`}>Importe a devolver</FieldLabel>
            <Input
              id={`${uid}-refund-amount`}
              value={refundAmount}
              onChange={(event) => setRefundAmount(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-refund-reason`}>Motivo</FieldLabel>
            <Textarea
              id={`${uid}-refund-reason`}
              maxLength={MAX_TEXT}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </FormDrawer>

      <FormDrawer
        open={form === "void-charge" || form === "void-payment" || form === "void-application"}
        title={
          form === "void-charge"
            ? "Anular cargo"
            : form === "void-payment"
              ? "Anular pago"
              : "Anular aplicación"
        }
        description="La anulación conserva el movimiento y su motivo; los saldos se recalculan."
        error={form?.startsWith("void") ? error : null}
        isSubmitting={
          voidChargeMutation.isPending ||
          voidPaymentMutation.isPending ||
          voidApplicationMutation.isPending
        }
        submitLabel="Anular"
        onClose={() => {
          if (
            !voidChargeMutation.isPending &&
            !voidPaymentMutation.isPending &&
            !voidApplicationMutation.isPending
          ) {
            close()
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!reason.trim()) {
            setError("Indica el motivo de la anulación.")
            return
          }
          if (form === "void-charge") voidChargeMutation.mutate()
          else if (form === "void-payment") voidPaymentMutation.mutate()
          else voidApplicationMutation.mutate()
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-void-reason`}>Motivo</FieldLabel>
          <Textarea
            id={`${uid}-void-reason`}
            maxLength={MAX_TEXT}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {form === "void-payment" ? (
          <Field>
            <FieldLabel htmlFor={`${uid}-void-compensate`}>
              Compensación en caja (si su turno ya cerró)
            </FieldLabel>
            <select
              id={`${uid}-void-compensate`}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={compensateShiftId}
              onChange={(event) => setCompensateShiftId(event.target.value)}
            >
              <option value="">Sin compensación</option>
              {(openShifts.data?.data ?? []).map((shift) => (
                <option key={shift.id} value={shift.id}>
                  Turno {shift.currency} · {shift.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
      </FormDrawer>
    </div>
  )
}
