/**
 * Plan y pagos de la organización (panel de cuenta, owner/admin).
 * Disponible aun con acceso restringido: ver el plan y registrar el
 * comprobante nunca se bloquean.
 */
import { Button } from "@odentia/ui"
import { EmptyState, LoadingState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { ReceiptForm, type ReceiptCharge, type ReceiptMethod } from "../../components/billing/receipt-form"
import { SubscriptionStatusCard, type BillingSummary } from "../../components/billing/subscription-status"
import { formatPlanMoney } from "../../components/billing/money"
import { apiFetch, ApiError } from "../../lib/api"

export const Route = createFileRoute("/_app/billing/$organizationId")({
  component: BillingPage,
})

interface Plan {
  code: string
  name: string
  currency: string
  priceCents: number
  billingPeriod: string
}

interface Charge extends ReceiptCharge {
  periodStart: string
  periodEnd: string
  dueAt: string | null
}

interface Payment {
  id: string
  chargeId: string | null
  amountCents: number
  currency: string
  methodCode: string
  status: string
  receiptFilename: string | null
  createdAt: string
}

const PAYMENT_STATUS: Record<string, string> = {
  pendiente: "Pendiente de confirmación",
  confirmado: "Confirmado",
  reversado: "Reversado",
  devuelto: "Devuelto",
}

function BillingPage() {
  const { organizationId } = Route.useParams()
  const queryClient = useQueryClient()
  const [planMessage, setPlanMessage] = useState<string | null>(null)

  const subscription = useQuery({
    queryKey: ["billing", organizationId, "subscription"],
    queryFn: () =>
      apiFetch<{ data: BillingSummary }>(
        `/api/account/billing/subscription?orgId=${encodeURIComponent(organizationId)}`,
      ).then((res) => res.data),
    retry: false,
  })
  const plans = useQuery({
    queryKey: ["billing", organizationId, "plans"],
    queryFn: () =>
      apiFetch<{ data: Plan[] }>(`/api/account/billing/plans?orgId=${encodeURIComponent(organizationId)}`).then(
        (res) => res.data,
      ),
    retry: false,
  })
  const charges = useQuery({
    queryKey: ["billing", organizationId, "charges"],
    queryFn: () =>
      apiFetch<{ data: Charge[] }>(
        `/api/account/billing/charges?orgId=${encodeURIComponent(organizationId)}`,
      ).then((res) => res.data),
    retry: false,
  })
  const payments = useQuery({
    queryKey: ["billing", organizationId, "payments"],
    queryFn: () =>
      apiFetch<{ data: Payment[] }>(
        `/api/account/billing/payments?orgId=${encodeURIComponent(organizationId)}`,
      ).then((res) => res.data),
    retry: false,
  })
  const methods = useQuery({
    queryKey: ["billing", organizationId, "methods"],
    queryFn: () =>
      apiFetch<{ data: ReceiptMethod[] }>(
        `/api/account/billing/methods?orgId=${encodeURIComponent(organizationId)}`,
      ).then((res) => res.data),
    retry: false,
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["billing", organizationId] })
  }

  const choosePlan = useMutation({
    mutationFn: (planCode: string) =>
      apiFetch<{ data: unknown }>(`/api/account/billing/plan`, {
        method: "POST",
        body: JSON.stringify({ orgId: organizationId, planCode }),
      }),
    onSuccess: () => {
      setPlanMessage("Plan actualizado.")
      refresh()
    },
    onError: () => setPlanMessage("No se pudo cambiar el plan."),
  })

  if (subscription.isPending) {
    return (
      <PageShell className="flex flex-col gap-2">
        <PageHeader title="Plan y pagos" />
        <LoadingState message="Cargando tu plan…" />
      </PageShell>
    )
  }
  if (subscription.isError) {
    const forbidden = subscription.error instanceof ApiError && subscription.error.status === 403
    return (
      <PageShell className="flex flex-col gap-2">
        <PageHeader title="Plan y pagos" />
        <EmptyState
          title={forbidden ? "Solo quien administra" : "No se pudo cargar"}
          description={
            forbidden
              ? "Solo quien administra la organización (owner/admin) ve el plan y los pagos."
              : "Reintenta en un momento."
          }
        />
      </PageShell>
    )
  }

  const summary = subscription.data

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title="Plan y pagos" subtitle="Tu suscripción, cargos y comprobantes" />
      {planMessage ? <p className="text-sm text-muted-foreground">{planMessage}</p> : null}
      <SubscriptionStatusCard summary={summary} />

      <section aria-labelledby="planes" className="flex flex-col gap-2">
        <h2 id="planes" className="text-base font-semibold">
          Planes
        </h2>
        {plans.isPending ? (
          <LoadingState message="Cargando planes…" />
        ) : plans.isError ? (
          <p className="text-sm text-muted-foreground">No se pudieron cargar los planes.</p>
        ) : plans.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no hay planes publicados.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {plans.data.map((plan) => {
              const current = summary.plan?.code === plan.code
              return (
                <li
                  key={plan.code}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="text-sm font-medium">
                      {plan.name} {current ? <span className="text-muted-foreground">(actual)</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{plan.billingPeriod}</p>
                  </div>
                  <p className="text-sm font-semibold tabular-nums">
                    {formatPlanMoney(plan.priceCents, plan.currency)}
                  </p>
                  {!current ? (
                    <Button size="sm" variant="outline" onClick={() => choosePlan.mutate(plan.code)}>
                      Elegir
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="comprobante" className="flex flex-col gap-2">
        <h2 id="comprobante" className="text-base font-semibold">
          Registrar comprobante
        </h2>
        {charges.isPending || methods.isPending ? (
          <LoadingState message="Cargando cargos…" />
        ) : charges.isError || methods.isError ? (
          <p className="text-sm text-muted-foreground">No se pudieron cargar los cargos o los medios de pago.</p>
        ) : (
          <ReceiptForm orgId={organizationId} charges={charges.data} methods={methods.data} onDone={refresh} />
        )}
      </section>

      <section aria-labelledby="historial" className="flex flex-col gap-2">
        <h2 id="historial" className="text-base font-semibold">
          Historial de pagos
        </h2>
        {payments.isPending ? (
          <LoadingState message="Cargando pagos…" />
        ) : payments.isError ? (
          <p className="text-sm text-muted-foreground">No se pudieron cargar los pagos.</p>
        ) : payments.data.length === 0 ? (
          <EmptyState
            title="Sin pagos"
            description="Cuando registres un comprobante aparecerá aquí con su estado."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {payments.data.map((payment) => (
              <li
                key={payment.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border p-4"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium">{payment.receiptFilename ?? "Comprobante"}</p>
                  <p className="text-xs text-muted-foreground">
                    {PAYMENT_STATUS[payment.status] ?? payment.status} · {payment.methodCode}
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums">
                  {formatPlanMoney(payment.amountCents, payment.currency)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageShell>
  )
}
