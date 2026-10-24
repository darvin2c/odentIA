/**
 * Facturación SaaS (admin): suscripciones con saldo, comprobantes pendientes
 * de confirmación, cargos manuales, planes y medios por moneda.
 */
import { formatMoney } from "@odentia/clinical"
import {
  Button,
  FieldLabel,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DatePickerButton,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  PageHeader,
  PageShell,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { CurrencySelect, centsToMajor, majorToCents } from "../../components/billing-fields"
import { ApiError, api } from "../../lib/api"
import { type AdminPlan, PlanDrawer } from "../../components/plan-drawer"
import { NegotiationsSection } from "../../components/billing-terms"
import { CommercialTermsSection } from "../../components/commercial-terms"

export const Route = createFileRoute("/_app/billing")({
  component: BillingPage,
})

const LOCALE = "es-PE"

type Plan = AdminPlan

interface PaymentMethod {
  id: string
  code: string
  name: string
  instructions: string | null
  isActive: boolean
}

interface OverviewRow {
  organizationId: string
  organizationName: string | null
  status: string
  isDemo: boolean
  planCode: string | null
  planName: string | null
  currency: string | null
  outstandingByCurrency: Array<{ currency: string; cents: number }>
  trialEndsAt: string | null
  graceEndsAt: string | null
}

interface UnassignedOrg {
  organizationId: string
  organizationName: string | null
  createdAt: string | null
}

interface PendingPayment {
  id: string
  organizationId: string
  organizationName: string | null
  chargeId: string | null
  amountCents: number
  currency: string
  methodCode: string
  receiptFilename: string | null
  createdAt: string
}

interface HistoryPayment {
  id: string
  organizationId: string
  amountCents: number
  currency: string
  methodCode: string
  status: string
  receiptFilename: string | null
  createdAt: string
}

interface ChargeOption {
  id: string
  planName: string
  amountCents: number
  currency: string
  paidCents: number
  status: string
}

const STATUS_LABEL: Record<string, string> = {
  prueba: "En prueba",
  activa: "Activa",
  gracia: "En gracia",
  restringida: "Restringida",
  pausada: "En pausa",
  cancelada: "Cancelada",
}

function money(cents: number, currency: string): string {
  try {
    return formatMoney(cents, currency, LOCALE)
  } catch {
    return `${cents} ${currency}`
  }
}

/** Precio por acción en millonésimas, hasta tres decimales. */
/** «Por tipo · Sofi 0,10 / 0,50 / 1,00 · Clío 0,10 / 0,20 / 0,50 · cita 2,00 · Argos 300 + 3,00 · 20 GB + 0,20» (ADR 0085). */
function tierSummary(plan: AdminPlan): string {
  const n = (micros: number | null | undefined, fallback: number | null) => {
    const value = micros ?? fallback
    return value === null ? "—" : new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(value / 1_000_000)
  }
  const parts = [
    `Sofi ${n(plan.conversationInformMicros, plan.conversationMicros)} / ${n(plan.conversationMicros, null)} / ${n(plan.conversationAgendaMicros, plan.conversationMicros)}`,
    `Clío ${n(plan.consultationSimpleMicros, plan.consultationMicros)} / ${n(plan.consultationStandardMicros, plan.consultationMicros)} / ${n(plan.consultationMicros, null)}`,
    `cita ${n(plan.recoveryMicros, null)}`,
  ]
  if (plan.argosPackMicros !== null) parts.push(`Argos ${plan.argosIncludedQuestions} + ${n(plan.argosPackMicros, null)}`)
  if (plan.storageGbMicros !== null) parts.push(`${plan.storageIncludedGb} GB + ${n(plan.storageGbMicros, null)}`)
  return `Por tipo (${plan.currency}) · ${parts.join(" · ")}`
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.shape.message ?? `Error ${error.status}`
  return "Error inesperado"
}

function BillingPage() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState("")
  const [planDrawer, setPlanDrawer] = useState<null | { plan?: Plan }>(null)
  const [chargeDrawer, setChargeDrawer] = useState<null | { orgId: string }>(null)
  const [methodDrawer, setMethodDrawer] = useState(false)
  const [reverseTarget, setReverseTarget] = useState<PendingPayment | null>(null)
  const [reverseReason, setReverseReason] = useState("")

  const overview = useQuery({
    queryKey: ["admin", "billing", "overview", statusFilter],
    queryFn: () =>
      api<OverviewRow[]>(
        `/api/admin/billing/overview${statusFilter ? `?status=${statusFilter}` : ""}`,
      ),
  })
  const pending = useQuery({
    queryKey: ["admin", "billing", "pending"],
    queryFn: () => api<PendingPayment[]>("/api/admin/billing/payments/pending?limit=100"),
  })
  const plans = useQuery({
    queryKey: ["admin", "billing", "plans"],
    queryFn: () => api<Plan[]>("/api/admin/billing/plans?includeInactive=1"),
  })
  const methods = useQuery({
    queryKey: ["admin", "billing", "methods"],
    queryFn: () => api<PaymentMethod[]>("/api/admin/billing/methods?includeInactive=1"),
  })
  const unassigned = useQuery({
    queryKey: ["admin", "billing", "unassigned"],
    queryFn: () => api<UnassignedOrg[]>("/api/admin/billing/unassigned?limit=100"),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "billing"] })
  }

  const [manualOpen, setManualOpen] = useState(false)
  const [historyOrgId, setHistoryOrgId] = useState("")
  const [refundTarget, setRefundTarget] = useState<{ id: string; organizationId: string } | null>(
    null,
  )
  const [receiptBusy, setReceiptBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const refundPayment = useMutation({
    mutationFn: () => {
      if (!refundTarget) throw new Error("Sin pago")
      return api(`/api/admin/billing/payments/${refundTarget.id}/refund`, {
        method: "POST",
        body: JSON.stringify({
          organizationId: refundTarget.organizationId,
          reason: reverseReason,
        }),
      })
    },
    onSuccess: () => {
      setRefundTarget(null)
      setReverseReason("")
      refresh()
    },
  })
  async function openReceipt(organizationId: string, paymentId: string) {
    setActionError(null)
    setReceiptBusy(paymentId)
    try {
      const res = await api<{ url: string }>(
        `/api/admin/billing/payments/receipt?organizationId=${encodeURIComponent(organizationId)}&paymentId=${encodeURIComponent(paymentId)}`,
      )
      window.open(res.url, "_blank", "noopener")
    } catch (e) {
      setActionError(
        e instanceof ApiError ? (e.shape.message ?? "No se pudo abrir") : "No se pudo abrir",
      )
    } finally {
      setReceiptBusy(null)
    }
  }
  const confirmPayment = useMutation({
    mutationFn: (payment: PendingPayment) =>
      api(`/api/admin/billing/payments/${payment.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ organizationId: payment.organizationId }),
      }),
    onSuccess: refresh,
  })
  const reversePayment = useMutation({
    mutationFn: () => {
      if (!reverseTarget) throw new Error("Sin pago")
      return api(`/api/admin/billing/payments/${reverseTarget.id}/reverse`, {
        method: "POST",
        body: JSON.stringify({
          organizationId: reverseTarget.organizationId,
          reason: reverseReason,
        }),
      })
    },
    onSuccess: () => {
      setReverseTarget(null)
      setReverseReason("")
      refresh()
    },
  })

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Facturación"
        subtitle="Suscripciones, comprobantes por confirmar, cargos, planes y medios"
        primary={{ label: "Nuevo plan", icon: <Plus aria-hidden />, onClick: () => setPlanDrawer({}) }}
        menu={[
          { label: "Nuevo medio", onSelect: () => setMethodDrawer(true) },
          { label: "Registrar pago", onSelect: () => setManualOpen(true) },
        ]}
      />

      <section aria-labelledby="pendientes" className="flex flex-col gap-2">
        <h2 id="pendientes" className="text-base font-semibold">
          Comprobantes por confirmar
        </h2>
        {pending.isPending ? (
          <LoadingState message="Cargando comprobantes…" />
        ) : pending.isError ? (
          <ErrorState
            title="No se pudieron cargar los comprobantes"
            message={errorMessage(pending.error)}
            onRetry={() => void pending.refetch()}
          />
        ) : pending.data.length === 0 ? (
          <EmptyState
            title="Sin comprobantes pendientes"
            description="Cuando una clínica registre su comprobante aparecerá aquí para confirmarlo."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {pending.data.map((payment) => (
              <li
                key={payment.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium">{payment.receiptFilename ?? "Comprobante"}</p>
                  <p className="text-xs text-muted-foreground">
                    {payment.organizationName ?? payment.organizationId} · {payment.methodCode}
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums">
                  {money(payment.amountCents, payment.currency)}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={receiptBusy === payment.id}
                    onClick={() => void openReceipt(payment.organizationId, payment.id)}
                  >
                    Ver
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={confirmPayment.isPending}
                    onClick={() => confirmPayment.mutate(payment)}
                  >
                    Confirmar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setReverseTarget(payment)}>
                    Reversar
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {confirmPayment.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(confirmPayment.error)}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="suscripciones" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="suscripciones" className="text-base font-semibold">
            Suscripciones
          </h2>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span id="billing-status-label">Estado</span>
            <Select
              value={statusFilter || "todas"}
              onValueChange={(value) =>
                setStatusFilter(value === null || value === "todas" ? "" : value)
              }
              aria-labelledby="billing-status-label"
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Todas" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todas">Todas</SelectItem>
                {Object.entries(STATUS_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {overview.isPending ? (
          <LoadingState message="Cargando suscripciones…" />
        ) : overview.isError ? (
          <ErrorState
            title="No se pudieron cargar las suscripciones"
            message={errorMessage(overview.error)}
            onRetry={() => void overview.refetch()}
          />
        ) : overview.data.length === 0 ? (
          <EmptyState
            title="Sin suscripciones"
            description="Aún no hay clínicas con este estado."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {overview.data.map((row) => (
              <li
                key={row.organizationId}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium">
                    {row.organizationName ?? row.organizationId}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {STATUS_LABEL[row.status] ?? row.status}
                    {row.isDemo ? " · Demo" : ""}
                    {row.planName ? ` · ${row.planName}` : ""}
                  </p>
                </div>
                {row.outstandingByCurrency.length > 0 ? (
                  <p className="text-sm font-semibold tabular-nums">
                    Debe{" "}
                    {row.outstandingByCurrency
                      .map((entry) => money(entry.cents, entry.currency))
                      .join(" · ")}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">Al día</p>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setChargeDrawer({ orgId: row.organizationId })}
                >
                  Crear cargo
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <UnassignedSection
        orgs={unassigned.data}
        isPending={unassigned.isPending}
        plans={plans.data ?? []}
        onDone={refresh}
      />

      <SignupModeSection />

      <section aria-labelledby="planes" className="flex flex-col gap-2">
        <h2 id="planes" className="text-base font-semibold">
          Planes
        </h2>
        {plans.isPending ? (
          <LoadingState message="Cargando planes…" />
        ) : plans.isError ? (
          <ErrorState
            title="No se pudieron cargar los planes"
            message={errorMessage(plans.error)}
            onRetry={() => void plans.refetch()}
          />
        ) : plans.data.length === 0 ? (
          <EmptyState
            title="Sin planes"
            description="Crea el primer plan para empezar a cobrar."
            actionLabel="Nuevo plan"
            onAction={() => setPlanDrawer({})}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {plans.data.map((plan) => (
              <li
                key={plan.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium">
                    {plan.name}{" "}
                    {!plan.isActive ? (
                      <span className="text-muted-foreground">(archivado)</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {plan.code} · {plan.billingPeriod}
                    {plan.isDefault ? " · por defecto" : ""}
                    {plan.seatLimit !== null ? ` · por invitación, ${plan.seatLimit} lugares` : ""}
                    {plan.guaranteeMonths ? ` · garantizado ${plan.guaranteeMonths} meses` : ""}
                    {plan.showOnWeb ? " · en la web" : ""}
                    {plan.creditCents ? ` · vuelve ${money(plan.creditCents, plan.currency)} en crédito` : ""}
                    {plan.conversationMicros !== null ? ` · ${tierSummary(plan)}` : ""}
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums">
                  {money(plan.priceCents, plan.currency)}
                </p>
                <Button size="sm" variant="outline" onClick={() => setPlanDrawer({ plan })}>
                  Editar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <CommercialTermsSection />

      <NegotiationsSection
        organizationNames={Object.fromEntries((overview.data ?? []).map((row) => [row.organizationId, row.organizationName ?? row.organizationId]))}
      />


      <section aria-labelledby="medios" className="flex flex-col gap-2">
        <h2 id="medios" className="text-base font-semibold">
          Medios de pago
        </h2>
        {methods.isPending ? (
          <LoadingState message="Cargando medios…" />
        ) : methods.isError ? (
          <ErrorState
            title="No se pudieron cargar los medios"
            message={errorMessage(methods.error)}
            onRetry={() => void methods.refetch()}
          />
        ) : methods.data.length === 0 ? (
          <EmptyState title="Sin medios" description="Configura cómo pueden pagar las clínicas." />
        ) : (
          <ul className="flex flex-col gap-2">
            {methods.data.map((method) => (
              <li key={method.id} className="rounded-lg border p-4">
                <p className="text-sm font-medium">
                  {method.name}{" "}
                  {!method.isActive ? (
                    <span className="text-muted-foreground">(inactivo)</span>
                  ) : null}
                </p>
                {method.instructions ? (
                  <p className="mt-1 text-xs text-muted-foreground">{method.instructions}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {planDrawer ? (
        <PlanDrawer
          plan={planDrawer.plan}
          listPlan={plans.data?.find((plan) => plan.isDefault && plan.isActive)}
          onClose={() => setPlanDrawer(null)}
          onSaved={refresh}
        />
      ) : null}
      {chargeDrawer ? (
        <ChargeDrawer
          orgId={chargeDrawer.orgId}
          plans={plans.data ?? []}
          onClose={() => setChargeDrawer(null)}
          onSaved={refresh}
        />
      ) : null}
      {methodDrawer ? (
        <MethodDrawer onClose={() => setMethodDrawer(false)} onSaved={refresh} />
      ) : null}
      <ConfirmDialog
        open={reverseTarget !== null}
        title="Reversar pago"
        description="El pago dejará de sumar al cargo. Si su comisión ya se liquidó, se descuenta como ajuste en la próxima liquidación (la liquidación original no se modifica)."
        confirmLabel="Reversar"
        onConfirm={() => reversePayment.mutate()}
        onClose={() => {
          setReverseTarget(null)
          setReverseReason("")
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="reverse-reason">Motivo</Label>
          <Textarea
            id="reverse-reason"
            value={reverseReason}
            onChange={(event) => setReverseReason(event.target.value)}
            placeholder="Por qué se reversa"
          />
        </div>
      </ConfirmDialog>
      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}
      <ConfirmDialog
        open={refundTarget !== null}
        title="Devolver pago"
        description="El dinero vuelve a la clínica y el cargo deja de sumarlo. Si su comisión ya se liquidó, se descuenta como ajuste en la próxima liquidación."
        confirmLabel="Devolver"
        onConfirm={() => refundPayment.mutate()}
        onClose={() => {
          setRefundTarget(null)
          setReverseReason("")
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="refund-reason">Motivo</Label>
          <Textarea
            id="refund-reason"
            value={reverseReason}
            onChange={(event) => setReverseReason(event.target.value)}
            placeholder="Por qué se devuelve"
          />
        </div>
      </ConfirmDialog>
      {manualOpen ? (
        <ManualDrawer
          orgs={overview.data ?? []}
          methods={methods.data ?? []}
          onClose={() => setManualOpen(false)}
          onSaved={refresh}
        />
      ) : null}
      <HistorySection
        orgs={overview.data ?? []}
        selectedOrgId={historyOrgId}
        onSelectOrg={setHistoryOrgId}
        onOpenReceipt={(organizationId, paymentId) => void openReceipt(organizationId, paymentId)}
        receiptBusy={receiptBusy}
        onReverseRequest={(payment) =>
          setReverseTarget({
            ...payment,
            organizationName: null,
            chargeId: null,
            receiptFilename: payment.receiptFilename,
            createdAt: "",
          })
        }
        onRefundRequest={setRefundTarget}
      />
    </PageShell>
  )
}

function ChargeDrawer({
  orgId,
  plans,
  onClose,
  onSaved,
}: {
  orgId: string
  plans: Plan[]
  onClose: () => void
  onSaved: () => void
}) {
  const [planCode, setPlanCode] = useState(plans[0]?.code ?? "")
  const [periodStart, setPeriodStart] = useState("")
  const [periodEnd, setPeriodEnd] = useState("")
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      api("/api/admin/billing/charges", {
        method: "POST",
        body: JSON.stringify({
          organizationId: orgId,
          planCode,
          periodStart: new Date(`${periodStart}T00:00:00Z`).toISOString(),
          periodEnd: new Date(`${periodEnd}T00:00:00Z`).toISOString(),
        }),
      }),
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e) =>
      setError(
        e instanceof ApiError ? (e.shape.message ?? "No se pudo crear") : "No se pudo crear",
      ),
  })

  return (
    <FormDrawer
      open
      title="Crear cargo"
      submitLabel="Crear"
      onSubmit={() => save.mutate()}
      onClose={onClose}
      isSubmitting={save.isPending}
    >
      <p className="text-sm text-muted-foreground">
        El cargo congela el precio del plan; cambiar el plan después no lo modifica.
      </p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="charge-plan">Plan</Label>
        <Select
          value={planCode}
          onValueChange={(value) => {
            if (value) setPlanCode(value)
          }}
        >
          <SelectTrigger id="charge-plan">
            <SelectValue placeholder="Elige el plan" />
          </SelectTrigger>
          <SelectContent>
            {plans.map((plan) => (
              <SelectItem key={plan.code} value={plan.code}>
                {plan.name} · {money(plan.priceCents, plan.currency)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="charge-start">Inicio del período</Label>
          <DatePickerButton id="charge-start" value={periodStart} onChange={setPeriodStart} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="charge-end">Fin del período</Label>
          <DatePickerButton
            id="charge-end"
            value={periodEnd}
            onChange={setPeriodEnd}
            min={periodStart || undefined}
          />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </FormDrawer>
  )
}

function MethodDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [instructions, setInstructions] = useState("")
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      api("/api/admin/billing/methods", {
        method: "PUT",
        body: JSON.stringify({
          code: code.trim(),
          name: name.trim(),
          instructions: instructions.trim() || null,
        }),
      }),
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e) =>
      setError(
        e instanceof ApiError ? (e.shape.message ?? "No se pudo guardar") : "No se pudo guardar",
      ),
  })

  return (
    <FormDrawer
      open
      title="Nuevo medio de pago"
      submitLabel="Guardar"
      onSubmit={() => save.mutate()}
      onClose={onClose}
      isSubmitting={save.isPending}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="method-code">Código</Label>
        <Input
          id="method-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="transferencia"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="method-name">Nombre</Label>
        <Input
          id="method-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Transferencia"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="method-instructions">Cómo pagar (lo ve la clínica)</Label>
        <Textarea
          id="method-instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Cuenta, titular y qué poner en el concepto"
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </FormDrawer>
  )
}
/** Clínicas legadas sin plan: admin asigna y las pone en `activa` 30 días. */
function UnassignedSection({
  orgs,
  isPending,
  plans,
  onDone,
}: {
  orgs: UnassignedOrg[] | undefined
  isPending: boolean
  plans: Plan[]
  onDone: () => void
}) {
  const [planCode, setPlanCode] = useState(plans[0]?.code ?? "")
  const [error, setError] = useState<string | null>(null)
  const activate = useMutation({
    mutationFn: (organizationId: string) =>
      api(`/api/admin/billing/subscriptions/${organizationId}/activate`, {
        method: "POST",
        body: JSON.stringify({ planCode }),
      }),
    onSuccess: onDone,
    onError: (e) =>
      setError(
        e instanceof ApiError ? (e.shape.message ?? "No se pudo asignar") : "No se pudo asignar",
      ),
  })
  if (isPending) return <LoadingState message="Buscando clínicas sin plan…" />
  if (!orgs || orgs.length === 0) return null
  const activePlans = plans.filter((plan) => plan.isActive)
  return (
    <section aria-labelledby="sin-plan" className="flex flex-col gap-2">
      <h2 id="sin-plan" className="text-base font-semibold">
        Sin plan asignado (legadas, exentas)
      </h2>
      <p className="text-sm text-muted-foreground">
        No se les cobra ni se les restringe hasta que asignes un plan (las pone en activa 30 días,
        sin deuda retroactiva).
      </p>
      <div className="flex items-center gap-2 text-sm">
        <span id="assign-plan-label">Plan a asignar</span>
        <Select
          value={planCode}
          onValueChange={(value) => {
            if (value) setPlanCode(value)
          }}
          aria-labelledby="assign-plan-label"
        >
          <SelectTrigger className="w-64">
            <SelectValue placeholder="Elige el plan" />
          </SelectTrigger>
          <SelectContent>
            {activePlans.map((plan) => (
              <SelectItem key={plan.code} value={plan.code}>
                {plan.name} · {money(plan.priceCents, plan.currency)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ul className="flex flex-col gap-2">
        {orgs.map((org) => (
          <li
            key={org.organizationId}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
          >
            <p className="min-w-0 flex-1 basis-56 text-sm font-medium">
              {org.organizationName ?? org.organizationId}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={!planCode || activate.isPending}
              onClick={() => activate.mutate(org.organizationId)}
            >
              Asignar plan
            </Button>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
/** Staff registra un pago recibido (D1): org y cargo por nombre, fecha de pago, medio, importe y comprobante real. */
function ManualDrawer({
  orgs,
  methods,
  onClose,
  onSaved,
}: {
  orgs: OverviewRow[]
  methods: PaymentMethod[]
  onClose: () => void
  onSaved: () => void
}) {
  const [orgId, setOrgId] = useState(orgs[0]?.organizationId ?? "")
  const [chargeId, setChargeId] = useState("")
  const [methodCode, setMethodCode] = useState(methods[0]?.code ?? "")
  const [amount, setAmount] = useState("")
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const charges = useQuery({
    queryKey: ["admin", "billing", "charges", orgId],
    queryFn: () =>
      api<ChargeOption[]>(`/api/admin/billing/charges?organizationId=${encodeURIComponent(orgId)}`),
    enabled: orgId !== "",
  })
  const charge = charges.data?.find((item) => item.id === chargeId) ?? null
  const save = useMutation({
    mutationFn: async () => {
      if (!orgId || !charge) throw new Error("Elige la clínica y el cargo")
      const amountCents = majorToCents(amount, charge.currency)
      if (amountCents === null) throw new Error("Importe inválido")
      if (!file) throw new Error("Adjunta el comprobante recibido")
      const form = new FormData()
      form.append("organizationId", orgId)
      form.append("chargeId", charge.id)
      form.append("methodCode", methodCode)
      form.append("amountCents", String(amountCents))
      form.append("idempotencyKey", crypto.randomUUID())
      if (notes.trim()) form.append("notes", notes.trim())
      if (paidAt) form.append("paidAt", new Date(`${paidAt}T12:00:00Z`).toISOString())
      form.append("file", file, file.name)
      return api("/api/admin/billing/payments/manual", { method: "POST", body: form })
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e) =>
      setError(
        e instanceof ApiError
          ? (e.shape.message ?? "No se pudo registrar")
          : "No se pudo registrar",
      ),
  })
  return (
    <FormDrawer
      open
      title="Registrar pago recibido"
      submitLabel="Registrar y confirmar"
      onSubmit={() => save.mutate()}
      onClose={onClose}
      isSubmitting={save.isPending}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="manual-org">Clínica</Label>
        <Select
          value={orgId}
          items={Object.fromEntries(orgs.map(org => [org.organizationId, org.organizationName ?? "Clínica"]))}
          onValueChange={(value) => {
            if (value) {
              setOrgId(value)
              setChargeId("")
            }
          }}
        >
          <SelectTrigger id="manual-org">
            <SelectValue placeholder="Elige la clínica" />
          </SelectTrigger>
          <SelectContent>
            {orgs.map((org) => (
              <SelectItem key={org.organizationId} value={org.organizationId}>
                {org.organizationName ?? org.organizationId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="manual-charge">Cargo</Label>
        <Select
          value={chargeId}
          items={Object.fromEntries((charges.data ?? []).map(item => [item.id, `${item.planName} · saldo ${money(item.amountCents - item.paidCents, item.currency)}`]))}
          onValueChange={(value) => {
            if (value) setChargeId(value)
          }}
        >
          <SelectTrigger id="manual-charge">
            <SelectValue placeholder="Elige el cargo" />
          </SelectTrigger>
          <SelectContent>
            {(charges.data ?? []).map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.planName} · saldo {money(item.amountCents - item.paidCents, item.currency)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="manual-method">Medio usado</Label>
          <Select
            value={methodCode}
            items={Object.fromEntries(methods.map(method => [method.code, method.name]))}
            onValueChange={(value) => {
              if (value) setMethodCode(value)
            }}
          >
            <SelectTrigger id="manual-method">
              <SelectValue placeholder="Elige el medio" />
            </SelectTrigger>
            <SelectContent>
              {methods.map((method) => (
                <SelectItem key={method.code} value={method.code}>
                  {method.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="manual-amount">Importe{charge ? ` (${charge.currency})` : ""}</Label>
          <Input
            id="manual-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="150.00"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="manual-paid">Fecha de pago</Label>
        <DatePickerButton id="manual-paid" value={paidAt} onChange={setPaidAt} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="manual-notes">Notas (opcional)</Label>
        <Textarea
          id="manual-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="manual-file">Comprobante (PNG, JPG, WebP o PDF, máx. 10 MB)</Label>
        <Input
          id="manual-file"
          type="file"
          accept="image/png,image/jpeg,image/webp,application/pdf"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </FormDrawer>
  )
}

/** Historial de pagos de una clínica con anular/devolver y comprobante. */
function HistorySection({
  orgs,
  selectedOrgId,
  onSelectOrg,
  onOpenReceipt,
  receiptBusy,
  onReverseRequest,
  onRefundRequest,
}: {
  orgs: OverviewRow[]
  selectedOrgId: string
  onSelectOrg: (orgId: string) => void
  onOpenReceipt: (organizationId: string, paymentId: string) => void
  receiptBusy: string | null
  onReverseRequest: (payment: HistoryPayment) => void
  onRefundRequest: (payment: { id: string; organizationId: string }) => void
}) {
  const payments = useQuery({
    queryKey: ["admin", "billing", "history", selectedOrgId],
    queryFn: () =>
      api<HistoryPayment[]>(
        `/api/admin/billing/payments?organizationId=${encodeURIComponent(selectedOrgId)}`,
      ),
    enabled: selectedOrgId !== "",
  })
  return (
    <section aria-labelledby="historial" className="flex flex-col gap-2">
      <h2 id="historial" className="text-base font-semibold">
        Historial de pagos
      </h2>
      <div className="flex items-center gap-2 text-sm">
        <span id="history-org-label">Clínica</span>
        <Select
          value={selectedOrgId}
          items={Object.fromEntries(orgs.map(org => [org.organizationId, org.organizationName ?? "Clínica"]))}
          onValueChange={(value) => onSelectOrg(value ?? "")}
          aria-labelledby="history-org-label"
        >
          <SelectTrigger className="w-64">
            <SelectValue placeholder="Elige la clínica" />
          </SelectTrigger>
          <SelectContent>
            {orgs.map((org) => (
              <SelectItem key={org.organizationId} value={org.organizationId}>
                {org.organizationName ?? org.organizationId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {selectedOrgId === "" ? (
        <p className="text-sm text-muted-foreground">
          Elige una clínica para ver sus pagos confirmados, reversos y devoluciones.
        </p>
      ) : payments.isPending ? (
        <LoadingState message="Cargando pagos…" />
      ) : payments.isError ? (
        <ErrorState
          title="No se pudieron cargar los pagos"
          message={errorMessage(payments.error)}
          onRetry={() => void payments.refetch()}
        />
      ) : payments.data.length === 0 ? (
        <EmptyState title="Sin pagos" description="Esta clínica aún no registra pagos." />
      ) : (
        <ul className="flex flex-col gap-2">
          {payments.data.map((payment) => (
            <li
              key={payment.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
            >
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-sm font-medium">{payment.receiptFilename ?? "Comprobante"}</p>
                <p className="text-xs text-muted-foreground">
                  {payment.status} · {payment.methodCode}
                </p>
              </div>
              <p className="text-sm font-semibold tabular-nums">
                {money(payment.amountCents, payment.currency)}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={receiptBusy === payment.id}
                  onClick={() => onOpenReceipt(payment.organizationId, payment.id)}
                >
                  Ver
                </Button>
                {payment.status === "confirmado" ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => onReverseRequest(payment)}>
                      Reversar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onRefundRequest(payment)}>
                      Devolver
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const SIGNUP_MODES = [
  {
    value: "invitacion",
    label: "Solo con invitación",
    hint: "La web pide invitación y la solicitud entra a la lista de espera. Quien ya tiene cuenta no puede abrir una clínica sin invitación.",
  },
  { value: "abierta", label: "Abierta", hint: "Cualquiera abre su clínica con el plan por defecto." },
] as const

/** «Alta de clínicas nuevas» (Fundadores, decisión 2): cambiarla rige al instante, sin programar nada. */
function SignupModeSection() {
  const queryClient = useQueryClient()
  const mode = useQuery({
    queryKey: ["admin", "signup-mode"],
    queryFn: () => api<{ mode: "invitacion" | "abierta" }>("/api/admin/waitlist/signup-mode"),
  })
  const save = useMutation({
    mutationFn: (next: "invitacion" | "abierta") =>
      api<{ mode: "invitacion" | "abierta" }>("/api/admin/waitlist/signup-mode", { method: "PUT", body: JSON.stringify({ mode: next }) }),
    onSuccess: (data) => {
      queryClient.setQueryData(["admin", "signup-mode"], data)
      void queryClient.invalidateQueries({ queryKey: ["admin", "waitlist"] })
    },
  })
  const [confirming, setConfirming] = useState<null | "invitacion" | "abierta">(null)
  return (
    <section id="alta" aria-labelledby="alta-titulo" className="flex flex-col gap-2 rounded-xl border bg-card p-4">
      <h2 id="alta-titulo" className="text-base font-semibold">
        Alta de clínicas nuevas
      </h2>
      {mode.isPending ? (
        <LoadingState message="Cargando…" />
      ) : mode.isError ? (
        <ErrorState title="No se pudo leer cómo se abren clínicas" message={errorMessage(mode.error)} onRetry={() => void mode.refetch()} />
      ) : (
        <RadioGroup
          aria-labelledby="alta-titulo"
          value={mode.data.mode}
          onValueChange={(value) => {
            if (value !== mode.data.mode) setConfirming(value as "invitacion" | "abierta")
          }}
          className="gap-3"
        >
          {SIGNUP_MODES.map((option) => (
            <FieldLabel
              key={option.value}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-data-checked:border-primary"
            >
              <RadioGroupItem value={option.value} className="mt-0.5" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{option.label}</span>
                <span className="text-sm text-muted-foreground">{option.hint}</span>
              </span>
            </FieldLabel>
          ))}
        </RadioGroup>
      )}
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(save.error)}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        title={confirming === "abierta" ? "¿Abrir el alta de clínicas?" : "¿Pedir invitación para abrir clínicas?"}
        description={
          confirming === "abierta"
            ? "Desde ahora cualquiera con cuenta puede abrir su clínica con el plan por defecto, sin pasar por la lista de espera."
            : "Desde ahora abrir una clínica pide una invitación. Las clínicas que ya existen no cambian."
        }
        confirmLabel={confirming === "abierta" ? "Abrir el alta" : "Pedir invitación"}
        variant="default"
        pending={save.isPending}
        onConfirm={() => {
          if (confirming) save.mutate(confirming, { onSettled: () => setConfirming(null) })
        }}
        onClose={() => setConfirming(null)}
      />
    </section>
  )
}
