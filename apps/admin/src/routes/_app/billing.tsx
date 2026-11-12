/**
 * Cobros y planes (admin): suscripciones con saldo, comprobantes pendientes
 * de confirmación, cargos manuales, los planes y el alta de cada producto
 * (ADR 0093) y medios por moneda.
 */
import { CLINICAL_PRODUCTS, type ClinicalProduct, productWords } from "@odentia/clinical"
import {
  Button,
  FieldLabel,
  FieldLegend,
  FieldSet,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DatePickerButton,
  EmptyState,
  ErrorState,
  FormDrawer,
  PageHeader,
  PageShell,
  submitErrorMessage,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
  useFormSurface,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { requireAdminRole } from "../../lib/session"
import { useState } from "react"
import { api } from "../../lib/api"
import { domainOf } from "../../lib/host"
import { matchesProduct, type ProductChoice, ProductFilter, ProductMark, useOrgProducts } from "../../components/product"
import { type AdminPlan, PlanDrawer } from "../../components/plan-drawer"
import { NegotiationsSection } from "../../components/billing-terms"
import {
  ManualPaymentDrawer,
  money,
  type PaymentActions,
  PaymentHistoryList,
  usePaymentActions,
  usePaymentMethods,
} from "../../components/billing-payments"
import { CommercialTermsSection } from "../../components/commercial-terms"
import {
  BillingMethodsSkeleton,
  BillingPageSkeleton,
  BillingPendingSkeleton,
  BillingPlansSkeleton,
  BillingSignupSkeleton,
  BillingSubscriptionsSkeleton,
} from "../../components/skeletons/billing"

export const Route = createFileRoute("/_app/billing")({
  beforeLoad: requireAdminRole,
  pendingComponent: BillingPageSkeleton,
  component: BillingPage,
})

const LOCALE = "es-PE"

type Plan = AdminPlan

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

const STATUS_LABEL: Record<string, string> = {
  prueba: "En prueba",
  activa: "Activa",
  gracia: "En gracia",
  restringida: "Restringida",
  pausada: "En pausa",
  cancelada: "Cancelada",
}

/** Precio por acción en millonésimas, hasta tres decimales. */
/** «Por tipo · Sofi 0,20 / 0,50 / 1,00 · Clío 0,10 / 0,30 / 0,50 · cita 2,00 · Argos 100 + 3,00 · 20 GB + 0,20» (ADR 0085 y 0105). */
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

function BillingPage() {
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState("")
  // El producto filtra las clínicas, los planes y el alta de esta página (ADR 0093); los medios son de los dos.
  const [product, setProduct] = useState<ProductChoice>("todos")
  const products = useOrgProducts().data ?? {}
  const ofProduct = <T extends { organizationId: string }>(rows: readonly T[] | undefined): T[] =>
    (rows ?? []).filter((row) => matchesProduct(product, products[row.organizationId]))
  const [planDrawer, setPlanDrawer] = useState<null | { plan?: Plan; product?: ClinicalProduct }>(null)
  const [chargeDrawer, setChargeDrawer] = useState<null | { orgId: string }>(null)
  const [methodDrawer, setMethodDrawer] = useState(false)

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
  const methods = usePaymentMethods()
  const unassigned = useQuery({
    queryKey: ["admin", "billing", "unassigned"],
    queryFn: () => api<UnassignedOrg[]>("/api/admin/billing/unassigned?limit=100"),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "billing"] })
  }
  // Confirmar o rechazar un comprobante cambia también lo que cuenta Inicio.
  const refreshPending = () => {
    refresh()
    void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] })
  }
  /** El medio por su nombre, no por su código. */
  const methodName = (code: string) => methods.data?.find((method) => method.code === code)?.name ?? code

  const [manualOpen, setManualOpen] = useState(false)
  const [historyOrgId, setHistoryOrgId] = useState("")
  // Confirmar o rechazar un comprobante cambia también lo que cuenta Inicio; reversar y devolver, solo Cobros.
  const payments = usePaymentActions({
    onChanged: (change) => (change === "confirm" || change === "reject" ? refreshPending() : refresh()),
  })
  const confirmPayment = payments.confirm

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title="Cobros y planes"
        subtitle="Suscripciones, comprobantes por confirmar, cargos, planes y medios"
        primary={{
          label: "Nuevo plan",
          icon: <Plus aria-hidden />,
          onClick: () => setPlanDrawer({ product: product === "todos" ? undefined : product }),
        }}
        menu={[
          { label: "Nuevo medio", onSelect: () => setMethodDrawer(true) },
          { label: "Registrar pago", onSelect: () => setManualOpen(true) },
        ]}
      />
      <ProductFilter value={product} onChange={setProduct} />

      <section aria-labelledby="pendientes" className="flex flex-col gap-2">
        <h2 id="pendientes" className="text-base font-semibold">
          Comprobantes por confirmar
        </h2>
        {pending.isPending ? (
          <SkeletonRegion message="Cargando comprobantes…">
            <BillingPendingSkeleton />
          </SkeletonRegion>
        ) : pending.isError ? (
          <ErrorState
            title="No se pudieron cargar los comprobantes"
            message={submitErrorMessage(pending.error)}
            onRetry={() => void pending.refetch()}
          />
        ) : ofProduct(pending.data).length === 0 ? (
          <EmptyState
            title="Sin comprobantes pendientes"
            description="Cuando una clínica registre su comprobante aparecerá aquí para confirmarlo."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {ofProduct(pending.data).map((payment) => (
              <li
                key={payment.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium">{payment.receiptFilename ?? "Comprobante"}</p>
                  <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    {payment.organizationName ?? payment.organizationId} · {methodName(payment.methodCode)}
                    {products[payment.organizationId] ? <ProductMark product={products[payment.organizationId]} /> : null}
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums">
                  {money(payment.amountCents, payment.currency)}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={payments.receiptBusy === payment.id}
                    onClick={() => payments.openReceipt(payment.organizationId, payment.id)}
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
                  <Button size="sm" variant="ghost" onClick={() => payments.requestReject(payment)}>
                    Rechazar
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {confirmPayment.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {submitErrorMessage(confirmPayment.error)}
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
          <SkeletonRegion message="Cargando suscripciones…">
            <BillingSubscriptionsSkeleton />
          </SkeletonRegion>
        ) : overview.isError ? (
          <ErrorState
            title="No se pudieron cargar las suscripciones"
            message={submitErrorMessage(overview.error)}
            onRetry={() => void overview.refetch()}
          />
        ) : ofProduct(overview.data).length === 0 ? (
          <EmptyState
            title="Sin suscripciones"
            description="Aún no hay clínicas con este estado."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {ofProduct(overview.data).map((row) => (
              <li
                key={row.organizationId}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {row.organizationName ?? row.organizationId}
                    {products[row.organizationId] ? <ProductMark product={products[row.organizationId]} /> : null}
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
        orgs={unassigned.data ? ofProduct(unassigned.data) : undefined}
        isPending={unassigned.isPending}
        plans={plans.data ?? []}
        onDone={refresh}
      />

      <SignupModeSection products={product === "todos" ? CLINICAL_PRODUCTS : [product]} />

      <section aria-labelledby="planes" className="flex flex-col gap-2">
        <h2 id="planes" className="text-base font-semibold">
          Planes
        </h2>
        {plans.isPending ? (
          <SkeletonRegion message="Cargando planes…" className="flex flex-col gap-2">
            <BillingPlansSkeleton />
          </SkeletonRegion>
        ) : plans.isError ? (
          <ErrorState
            title="No se pudieron cargar los planes"
            message={submitErrorMessage(plans.error)}
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
          // Una lista por producto (ADR 0093): sus clínicas y su web usan solo esos planes.
          (product === "todos" ? CLINICAL_PRODUCTS : [product]).map((of) => (
            <div key={of} className="flex flex-col gap-2">
              <h3 className="flex items-center gap-1.5 text-sm">
                <ProductMark product={of} className="text-sm" />
                <span className="text-muted-foreground">· {domainOf(of)}</span>
              </h3>
              {plans.data.some((plan) => plan.product === of) ? null : (
                <EmptyState
                  title={`Sin planes de ${productWords(of).name}`}
                  description={`Sus clínicas y su web necesitan un plan por defecto de ${productWords(of).name}.`}
                  actionLabel="Nuevo plan"
                  onAction={() => setPlanDrawer({ product: of })}
                />
              )}
          <ul className="flex flex-col gap-2">
            {plans.data.filter((plan) => plan.product === of).map((plan) => (
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
            </div>
          ))
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
          <SkeletonRegion message="Cargando medios…">
            <BillingMethodsSkeleton />
          </SkeletonRegion>
        ) : methods.isError ? (
          <ErrorState
            title="No se pudieron cargar los medios"
            message={submitErrorMessage(methods.error)}
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
          plans={plans.data ?? []}
          product={planDrawer.product}
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
      {payments.dialogs}
      {payments.actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {payments.actionError}
        </p>
      ) : null}
      {manualOpen ? (
        <ManualPaymentDrawer
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
        methodName={methodName}
        actions={payments}
      />
    </PageShell>
  )
}

const chargeSchema = z
  .object({
    planCode: z.string().min(1, "Elige el plan"),
    periodStart: z.string().min(1, "Elige el inicio del período"),
    periodEnd: z.string().min(1, "Elige el fin del período"),
  })
  .refine((value) => !value.periodStart || !value.periodEnd || value.periodEnd > value.periodStart, {
    path: ["periodEnd"],
    message: "El período debe terminar después de empezar",
  })

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
  // Solo los planes activos: un cargo no se crea con un plan archivado.
  const activePlans = plans.filter((plan) => plan.isActive)
  const save = useMutation({
    mutationFn: (body: { organizationId: string; planCode: string; periodStart: string; periodEnd: string }) =>
      api("/api/admin/billing/charges", { method: "POST", body: JSON.stringify(body) }),
  })
  const form = useAppForm({
    defaultValues: { planCode: activePlans[0]?.code ?? "", periodStart: "", periodEnd: "" },
    validators: { onSubmit: chargeSchema },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({
        organizationId: orgId,
        planCode: value.planCode,
        periodStart: new Date(`${value.periodStart}T00:00:00Z`).toISOString(),
        periodEnd: new Date(`${value.periodEnd}T00:00:00Z`).toISOString(),
      })
      onSaved()
      onClose()
    },
  })
  const periodStart = useStore(form.store, (state) => state.values.periodStart)

  return (
    <FormDrawer {...useFormSurface(form)} open title="Crear cargo" submitLabel="Crear" onClose={onClose}>
      <p className="text-sm text-muted-foreground">
        El cargo congela el precio del plan; cambiar el plan después no lo modifica.
      </p>
      <form.AppField name="planCode">
        {(field) => (
          <field.SelectField
            id="charge-plan"
            label="Plan"
            placeholder="Elige el plan"
            options={activePlans.map((plan) => ({
              value: plan.code,
              label: `${plan.name} · ${money(plan.priceCents, plan.currency)}`,
            }))}
          />
        )}
      </form.AppField>
      <div className="grid grid-cols-2 gap-3">
        <form.AppField name="periodStart">
          {(field) => (
            <field.Control id="charge-start" label="Inicio del período">
              {(control) => (
                <DatePickerButton
                  {...control.props}
                  value={field.state.value}
                  onChange={(next) => {
                    field.handleChange(next)
                    field.handleBlur()
                  }}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="periodEnd">
          {(field) => (
            <field.Control id="charge-end" label="Fin del período">
              {(control) => (
                <DatePickerButton
                  {...control.props}
                  value={field.state.value}
                  onChange={(next) => {
                    field.handleChange(next)
                    field.handleBlur()
                  }}
                  min={periodStart || undefined}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}

const methodSchema = z.object({
  code: z.string().trim().min(1, "Escribe el código del medio").max(80, "Escribe el código en 80 caracteres como mucho"),
  name: z.string().trim().min(1, "Escribe el nombre del medio").max(120, "Escribe el nombre en 120 caracteres como mucho"),
  instructions: z.string().max(2000, "Escribe las instrucciones en 2000 caracteres como mucho"),
})

function MethodDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const save = useMutation({
    mutationFn: (body: { code: string; name: string; instructions: string | null; create: true }) =>
      api("/api/admin/billing/methods", { method: "PUT", body: JSON.stringify(body) }),
  })
  const form = useAppForm({
    defaultValues: { code: "", name: "", instructions: "" },
    validators: { onSubmit: methodSchema },
    onSubmit: async ({ value }) => {
      // «Nuevo medio»: un código que ya existe vuelve 409 en su campo, no se sobrescribe.
      await save.mutateAsync({
        code: value.code.trim(),
        name: value.name.trim(),
        instructions: value.instructions.trim() || null,
        create: true,
      })
      onSaved()
      onClose()
    },
  })

  return (
    <FormDrawer {...useFormSurface(form)} open title="Nuevo medio de pago" submitLabel="Guardar" onClose={onClose}>
      <form.AppField name="code">
        {(field) => <field.TextField id="method-code" label="Código" placeholder="transferencia" maxLength={80} />}
      </form.AppField>
      <form.AppField name="name">
        {(field) => <field.TextField id="method-name" label="Nombre" placeholder="Transferencia" maxLength={120} />}
      </form.AppField>
      <form.AppField name="instructions">
        {(field) => (
          <field.TextareaField
            id="method-instructions"
            label="Cómo pagar (lo ve la clínica)"
            placeholder="Cuenta, titular y qué poner en el concepto"
            maxLength={2000}
          />
        )}
      </form.AppField>
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
  // Casi siempre no hay ninguna: mientras se sabe no se reserva sitio, para que lo de abajo no salte.
  if (isPending || !orgs || orgs.length === 0) return null
  const activePlans = plans.filter((plan) => plan.isActive)
  // El formulario nace con el primer plan activo (y vuelve a nacer si llega otro primero).
  return <AssignPlanForm key={activePlans[0]?.code ?? ""} orgs={orgs} activePlans={activePlans} onDone={onDone} />
}

const assignSchema = z.object({
  planCode: z.string().min(1, "Elige el plan a asignar"),
  organizationId: z.string(),
})

function AssignPlanForm({
  orgs,
  activePlans,
  onDone,
}: {
  orgs: UnassignedOrg[]
  activePlans: Plan[]
  onDone: () => void
}) {
  const activate = useMutation({
    mutationFn: ({ organizationId, planCode }: { organizationId: string; planCode: string }) =>
      api(`/api/admin/billing/subscriptions/${organizationId}/activate`, {
        method: "POST",
        body: JSON.stringify({ planCode }),
      }),
    onSuccess: onDone,
  })
  const form = useAppForm({
    defaultValues: { planCode: activePlans[0]?.code ?? "", organizationId: "" },
    validators: { onSubmit: assignSchema },
    onSubmit: async ({ value }) => {
      await activate.mutateAsync(value)
    },
  })
  const onSubmit = useFormSubmit(form)
  const submitError = useFormSubmitError(form)
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting)
  return (
    <section aria-labelledby="sin-plan" className="flex flex-col gap-2">
      <h2 id="sin-plan" className="text-base font-semibold">
        Sin plan asignado (legadas, exentas)
      </h2>
      <p className="text-sm text-muted-foreground">
        No se les cobra ni se les restringe hasta que asignes un plan (las pone en activa 30 días,
        sin deuda retroactiva).
      </p>
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-2">
        <form.AppField name="planCode">
          {(field) => (
            <field.SelectField
              id="assign-plan"
              label="Plan a asignar"
              placeholder="Elige el plan"
              className="max-w-64"
              options={activePlans.map((plan) => ({
                value: plan.code,
                label: `${plan.name} · ${money(plan.priceCents, plan.currency)}`,
              }))}
            />
          )}
        </form.AppField>
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
                type="submit"
                size="sm"
                variant="outline"
                disabled={isSubmitting}
                onClick={() => form.setFieldValue("organizationId", org.organizationId)}
              >
                Asignar plan
              </Button>
            </li>
          ))}
        </ul>
        {submitError ? (
          <p role="alert" className="text-sm text-destructive">
            {submitError}
          </p>
        ) : null}
      </form>
    </section>
  )
}

/** Historial de pagos de una clínica con anular/devolver y comprobante. */
function HistorySection({
  orgs,
  selectedOrgId,
  onSelectOrg,
  methodName,
  actions,
}: {
  orgs: OverviewRow[]
  selectedOrgId: string
  onSelectOrg: (orgId: string) => void
  methodName: (code: string) => string
  actions: PaymentActions
}) {
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
          Elige una clínica para ver sus comprobantes y pagos: pendientes, confirmados, rechazados, reversos y devoluciones.
        </p>
      ) : (
        <PaymentHistoryList
          organizationId={selectedOrgId}
          organizationName={orgs.find((org) => org.organizationId === selectedOrgId)?.organizationName ?? null}
          methodName={methodName}
          actions={actions}
        />
      )}
    </section>
  )
}

type SignupMode = "invitacion" | "abierta"

/** Las dos formas de abrir clínicas de un producto, con el nombre de su web y de su plan (ADR 0093). */
function signupModes(product: ClinicalProduct) {
  const { name } = productWords(product)
  const place = `su ${productWords(product).place.one}`
  return [
    {
      value: "invitacion",
      label: "Solo con invitación",
      hint: `La web de ${name} pide invitación y la solicitud entra a la lista de espera. Quien ya tiene cuenta no puede abrir ${place} sin invitación.`,
    },
    { value: "abierta", label: "Abierta", hint: `Cualquiera abre ${place} con el plan por defecto de ${name}.` },
  ] as const
}

/**
 * «Alta de clínicas nuevas» (Fundadores, decisión 2): cada producto decide si
 * se entra con invitación o libre (ADR 0093). Cambiarla rige al instante.
 */
function SignupModeSection({ products }: { products: readonly ClinicalProduct[] }) {
  const queryClient = useQueryClient()
  const mode = useQuery({
    queryKey: ["admin", "signup-mode"],
    queryFn: () => api<{ modes: Record<ClinicalProduct, SignupMode> }>("/api/admin/waitlist/signup-mode"),
  })
  const save = useMutation({
    mutationFn: (next: { mode: SignupMode; product: ClinicalProduct }) =>
      api<{ mode: SignupMode }>("/api/admin/waitlist/signup-mode", { method: "PUT", body: JSON.stringify(next) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "signup-mode"] })
      void queryClient.invalidateQueries({ queryKey: ["admin", "waitlist"] })
    },
  })
  const [confirming, setConfirming] = useState<null | { mode: SignupMode; product: ClinicalProduct }>(null)
  const confirmName = confirming ? productWords(confirming.product).name : ""
  return (
    <section id="alta" aria-labelledby="alta-titulo" className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-col gap-0.5">
        <h2 id="alta-titulo" className="text-base font-semibold">
          Alta de clínicas nuevas
        </h2>
        <p className="text-sm text-muted-foreground">Cada producto decide si se entra solo con invitación o libre.</p>
      </div>
      {mode.isPending ? (
        <SkeletonRegion message="Cargando…">
          <BillingSignupSkeleton />
        </SkeletonRegion>
      ) : mode.isError ? (
        <ErrorState title="No se pudo leer cómo se abren clínicas" message={submitErrorMessage(mode.error)} onRetry={() => void mode.refetch()} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {products.map((product) => (
            <FieldSet key={product} className="flex flex-col gap-2">
              <FieldLegend id={`alta-${product}`} className="mb-0">
                <ProductMark product={product} className="text-sm" />
              </FieldLegend>
              <RadioGroup
                aria-labelledby={`alta-${product}`}
                // Sin su modo (la API anterior, mientras se despliega), el seguro: «Solo con invitación».
                value={mode.data.modes[product] ?? "invitacion"}
                onValueChange={(value) => {
                  if (value !== (mode.data.modes[product] ?? "invitacion")) setConfirming({ mode: value as SignupMode, product })
                }}
                className="gap-3"
              >
                {signupModes(product).map((option) => (
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
            </FieldSet>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.mode === "abierta" ? `¿Abrir el alta de ${confirmName}?` : `¿Pedir invitación en ${confirmName}?`}
        description={
          confirming?.mode === "abierta"
            ? `Desde ahora cualquiera con cuenta puede abrir una clínica de ${confirmName} con su plan por defecto, sin pasar por la lista de espera. El otro producto no cambia.`
            : `Desde ahora abrir una clínica de ${confirmName} pide una invitación. Las clínicas que ya existen y el otro producto no cambian.`
        }
        confirmLabel={confirming?.mode === "abierta" ? "Abrir el alta" : "Pedir invitación"}
        variant="default"
        pending={save.isPending}
        error={save.isError ? submitErrorMessage(save.error) : null}
        onConfirm={() => {
          if (confirming) save.mutate(confirming, { onSuccess: () => setConfirming(null) })
        }}
        onClose={() => {
          save.reset()
          setConfirming(null)
        }}
      />
    </section>
  )
}
