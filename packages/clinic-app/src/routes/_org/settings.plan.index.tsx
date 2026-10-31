/**
 * Plan y pagos de la clínica (ADR 0065): suscripción, lo que hicieron los
 * agentes, planes, cargos, comprobantes y pagos. Solo propietario y
 * administrador (`seesBilling`; el servidor lo vuelve a exigir). Abierta en
 * cualquier estado de la suscripción: en solo lectura, en pausa o cancelada
 * se puede ver el plan y registrar el comprobante.
 */
import { Button } from "@odentia/ui"
import { EmptyState, ErrorState, PageHeader, submitErrorMessage, SkeletonRegion } from "@odentia/ui-patterns"
import { seesBilling } from "@odentia/auth/permissions"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { ChargesList, type ChargeLine } from "../../components/billing/charges"
import { ConsumptionCard, type Consumption } from "../../components/billing/consumption"
import { formatPlanMoney } from "../../components/billing/money"
import { type OfferPlan, PlanOffer, SpecialPlanCard } from "../../components/billing/plan-offer"
import { ReceiptForm, type ReceiptCharge, type ReceiptMethod } from "../../components/billing/receipt-form"
import { SpendCapDrawer } from "../../components/billing/spend-cap"
import { type BillingSummary, SubscriptionStatusCard } from "../../components/billing/subscription-status"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { ApiError, apiFetch } from "../../lib/api"
import { PLAN_ACTIONS_PATH, useClinicLine, useSaasTerms } from "../../lib/billing"
import { ARGOS_ALLOWANCE_KEY } from "../../lib/argos"
import { useMyRole } from "../../lib/crm"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { appWords } from "../../lib/product-words"
import { PlanChargesSkeleton, PlanConsumptionSkeleton, PlanOffersSkeleton, PlanPageSkeleton, PlanPaymentsSkeleton, PlanReceiptSkeleton, PlanSkeleton } from "../../components/skeletons/settings"

export const Route = createFileRoute("/_org/settings/plan/")({
  pendingComponent: PlanPageSkeleton,
  component: PlanPage,
})

const orgRouteApi = getRouteApi("/_org")

interface Charge extends ReceiptCharge {
  planName: string
  periodStart: string
  periodEnd: string
  paidCents: number
  dueAt: string | null
  lines?: ChargeLine[]
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

/** «vie 30 oct», con el formato y la zona de la clínica. */
function shortDay(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(activeOrgLocale(), { weekday: "short", day: "numeric", month: "short", timeZone: activeOrgTimeZone() })
    .format(date)
    .replace(/\./g, "")
}

function PlanPage() {
  const role = useMyRole()
  if (!seesBilling(role)) {
    return (
      <>
        <PageHeader title="Plan y pagos" />
        <SettingsNoAccess />
      </>
    )
  }
  return <PlanContent />
}

function PlanContent() {
  const { org } = orgRouteApi.useRouteContext()
  const organizationId = org.id
  const clinicLine = useClinicLine()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [planMessage, setPlanMessage] = useState<string | null>(null)
  const [capOpen, setCapOpen] = useState(false)
  const orgParam = `orgId=${encodeURIComponent(organizationId)}`

  const terms = useSaasTerms().data
  const subscription = useQuery({
    queryKey: ["billing", organizationId, "subscription"],
    queryFn: () => apiFetch<{ data: BillingSummary }>(`/api/account/billing/subscription?${orgParam}`).then((res) => res.data),
    retry: false,
  })
  const consumption = useQuery({
    queryKey: ["billing", organizationId, "consumption"],
    queryFn: () => apiFetch<{ data: Consumption }>(`/api/account/billing/consumption?${orgParam}`).then((res) => res.data),
    retry: false,
  })
  const plans = useQuery({
    queryKey: ["billing", organizationId, "plans"],
    queryFn: () => apiFetch<{ data: OfferPlan[] }>(`/api/account/billing/plans?${orgParam}`).then((res) => res.data),
    retry: false,
  })
  const charges = useQuery({
    queryKey: ["billing", organizationId, "charges"],
    queryFn: () => apiFetch<{ data: Charge[] }>(`/api/account/billing/charges?${orgParam}`).then((res) => res.data),
    retry: false,
  })
  const payments = useQuery({
    queryKey: ["billing", organizationId, "payments"],
    queryFn: () => apiFetch<{ data: Payment[] }>(`/api/account/billing/payments?${orgParam}`).then((res) => res.data),
    retry: false,
  })
  const methods = useQuery({
    queryKey: ["billing", organizationId, "methods"],
    queryFn: () => apiFetch<{ data: ReceiptMethod[] }>(`/api/account/billing/methods?${orgParam}`).then((res) => res.data),
    retry: false,
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["billing", organizationId] })
    // La franja de avisos lee lo mismo: un pago o un tope nuevo la cambian.
    void queryClient.invalidateQueries({ queryKey: ["saas", organizationId] })
  }

  const saveCap = async (capCents: number | null) => {
    await apiFetch("/api/account/billing/spend-cap", { method: "POST", body: JSON.stringify({ orgId: organizationId, capCents }) })
    refresh()
  }

  // «Sumar solas» las preguntas a Argos (ADR 0085): al acabarse, se suma un paquete sin preguntar.
  const autoPack = useMutation({
    mutationFn: (on: boolean) =>
      apiFetch("/api/account/billing/argos-auto-pack", { method: "POST", body: JSON.stringify({ orgId: organizationId, on }) }),
    onSuccess: () => {
      refresh()
      void queryClient.invalidateQueries({ queryKey: ARGOS_ALLOWANCE_KEY })
    },
  })

  const choosePlan = useMutation({
    mutationFn: (planCode: string) =>
      apiFetch<{ data: unknown }>("/api/account/billing/plan", {
        method: "POST",
        body: JSON.stringify({ orgId: organizationId, planCode }),
      }),
    onSuccess: () => {
      setPlanMessage("Plan actualizado.")
      refresh()
    },
    onError: () => setPlanMessage("No se pudo cambiar el plan."),
  })

  const header = <PageHeader title="Plan y pagos" subtitle={clinicLine} />

  if (subscription.isPending) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <SkeletonRegion message="Cargando tu plan…">
          <PlanSkeleton />
        </SkeletonRegion>
      </div>
    )
  }
  if (subscription.isError) {
    const forbidden = subscription.error instanceof ApiError && subscription.error.status === 403
    return (
      <>
        {header}
        {forbidden ? (
          <SettingsNoAccess />
        ) : (
          <ErrorState title="No se pudo cargar tu plan" error={subscription.error} onRetry={() => void subscription.refetch()} />
        )}
      </>
    )
  }

  const summary = subscription.data
  const openCharges = (charges.data ?? []).filter((charge) => charge.status === "pendiente" || charge.status === "parcial")
  const next = [...openCharges].sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""))[0]
  const inReview = (payments.data ?? []).some((payment) => payment.status === "pendiente")

  return (
    <div className="flex flex-col gap-6">
      {header}
      {planMessage ? <p className="text-sm text-muted-foreground">{planMessage}</p> : null}

      {next ? (
        <section aria-labelledby="proximo-cobro" className="flex flex-col gap-3 rounded-xl border bg-card p-4">
          <h2 id="proximo-cobro" className="text-base font-semibold">
            Próximo cobro
          </h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">Monto</dt>
              <dd className="font-semibold tabular-nums">{formatPlanMoney(next.amountCents - next.paidCents, next.currency)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Vence</dt>
              <dd className="font-semibold">{next.dueAt ? shortDay(next.dueAt) : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Cómo pagar</dt>
              <dd className="font-semibold">{methods.data?.map((method) => method.name).join(", ") || "—"}</dd>
            </div>
          </dl>
          {inReview ? (
            <p className="text-sm text-muted-foreground">{appWords().name} está revisando tu pago. Mientras tanto la clínica sigue igual.</p>
          ) : (
            <Button className="self-start" render={<a href="#comprobante" />}>
              Registrar comprobante
            </Button>
          )}
        </section>
      ) : null}

      <SubscriptionStatusCard summary={summary} />
      {consumption.isPending ? (
        <SkeletonRegion message="Cargando lo que hicieron tus agentes…">
          <PlanConsumptionSkeleton />
        </SkeletonRegion>
      ) : consumption.isError ? (
        <ErrorState title="No se pudo cargar lo que hicieron tus agentes" error={consumption.error} onRetry={() => void consumption.refetch()} />
      ) : (
        <ConsumptionCard
          data={consumption.data}
          exempt={summary.isDemo}
          onShowActions={() => void navigate({ to: PLAN_ACTIONS_PATH })}
          onChangeCap={summary.isDemo ? undefined : () => setCapOpen(true)}
          onAutoPack={summary.isDemo ? undefined : (on) => autoPack.mutate(on)}
          autoPackPending={autoPack.isPending}
          autoPackError={autoPack.error ? submitErrorMessage(autoPack.error) : null}
        />
      )}
      {consumption.data ? (
        <SpendCapDrawer
          open={capOpen}
          currency={consumption.data.currency ?? "USD"}
          currentCents={consumption.data.spendCapCents ?? null}
          projectedOverCents={
            consumption.data.projectedCents !== null ? Math.max(0, consumption.data.projectedCents - consumption.data.creditCents) : null
          }
          onClose={() => setCapOpen(false)}
          onSave={saveCap}
        />
      ) : null}

      <section aria-labelledby="planes" className="flex flex-col gap-2">
        <h2 id="planes" className="text-base font-semibold">
          {(plans.data?.length ?? 0) > 1 ? "Planes" : "Tu plan"}
        </h2>
        {summary.guaranteedUntil ? (
          <p className="rounded-lg border bg-card px-4 py-3 text-sm">
            Tienes el plan <span className="font-medium">{summary.plan?.name ?? "Fundadores"}</span> con condiciones de Fundador hasta el{" "}
            {new Intl.DateTimeFormat(activeOrgLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: activeOrgTimeZone() }).format(
              new Date(summary.guaranteedUntil),
            )}
            . Después pasas al plan de lista de {appWords().name}
            {terms ? `; te avisamos ${terms.guaranteeNoticeDays} ${terms.guaranteeNoticeDays === 1 ? "día" : "días"} antes` : ""}. Si quieres cambiar algo
            antes, escríbenos desde Ayuda.
          </p>
        ) : plans.isPending ? (
          <SkeletonRegion message="Cargando planes…">
            <PlanOffersSkeleton />
          </SkeletonRegion>
        ) : plans.isError ? (
          <ErrorState title="No se pudieron cargar los planes" error={plans.error} onRetry={() => void plans.refetch()} />
        ) : plans.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no hay planes publicados.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {/* El plan de lista va completo; un plan especial de la clínica, debajo y en corto (issue 104). */}
            {plans.data.map((plan) =>
              plan.isDefault || plans.data.length === 1 ? (
                <PlanOffer
                  key={plan.code}
                  plan={plan}
                  current={summary.plan?.code === plan.code}
                  switching={summary.plan !== null && summary.plan.code !== plan.code}
                  trialing={summary.status === "prueba"}
                  consumption={consumption.data ?? null}
                  taxLabel={consumption.data?.tax?.label ?? null}
                  busy={choosePlan.isPending && choosePlan.variables === plan.code}
                  onActivate={() => choosePlan.mutate(plan.code)}
                />
              ) : (
                <SpecialPlanCard key={plan.code} plan={plan} taxLabel={consumption.data?.tax?.label ?? null} />
              ),
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="cargos" className="flex flex-col gap-2">
        <h2 id="cargos" className="text-base font-semibold">
          Tus cargos
        </h2>
        {charges.isPending ? (
          <SkeletonRegion message="Cargando cargos…">
            <PlanChargesSkeleton />
          </SkeletonRegion>
        ) : charges.isError ? (
          <ErrorState title="No se pudieron cargar los cargos" error={charges.error} onRetry={() => void charges.refetch()} />
        ) : (
          <ChargesList charges={charges.data} />
        )}
      </section>

      <section id="comprobante" aria-labelledby="comprobante-titulo" className="flex scroll-mt-24 flex-col gap-2">
        <h2 id="comprobante-titulo" className="text-base font-semibold">
          Registrar comprobante
        </h2>
        {charges.isPending || methods.isPending ? (
          <SkeletonRegion message="Cargando cargos…">
            <PlanReceiptSkeleton />
          </SkeletonRegion>
        ) : charges.isError || methods.isError ? (
          <ErrorState
            title="No se pudieron cargar los cargos o los medios de pago"
            error={charges.error ?? methods.error}
            onRetry={() => {
              void charges.refetch()
              void methods.refetch()
            }}
          />
        ) : (
          <ReceiptForm orgId={organizationId} charges={charges.data} methods={methods.data} onDone={refresh} />
        )}
      </section>

      <section aria-labelledby="historial" className="flex flex-col gap-2">
        <h2 id="historial" className="text-base font-semibold">
          Historial de pagos
        </h2>
        {payments.isPending ? (
          <SkeletonRegion message="Cargando pagos…">
            <PlanPaymentsSkeleton />
          </SkeletonRegion>
        ) : payments.isError ? (
          <ErrorState title="No se pudieron cargar los pagos" error={payments.error} onRetry={() => void payments.refetch()} />
        ) : payments.data.length === 0 ? (
          <EmptyState title="Sin pagos" description="Cuando registres un comprobante aparecerá aquí con su estado." />
        ) : (
          <ul className="flex flex-col gap-2">
            {payments.data.map((payment) => (
              <li key={payment.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border p-4">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium [overflow-wrap:anywhere]">{payment.receiptFilename ?? "Comprobante"}</p>
                  <p className="text-xs text-muted-foreground">
                    {PAYMENT_STATUS[payment.status] ?? payment.status} · {payment.methodCode}
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums">{formatPlanMoney(payment.amountCents, payment.currency)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
