/**
 * La cuenta de una app que es otro sistema (gestorIA, ADR 0211): lo que dijo la app (nombre,
 * país y dueño), su plan y su estado, lo que lleva gastado, sus cargos y pagos, sus casos de
 * soporte y los avisos que la app le muestra. Lo mismo que la app recibe al preguntar por ella.
 * Solo la administración.
 */
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@odentia/ui"
import {
  ErrorState,
  PageHeader,
  PageShell,
  SkeletonRegion,
  submitErrorMessage,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useState } from "react"
import { z } from "zod"
import { ACCOUNT_STATUS, AppMark } from "../../components/app-accounts"
import {
  AppRequestDrawer,
  AppRequestList,
  appRequestSchema,
} from "../../components/app-requests"
import {
  ManualPaymentDrawer,
  money,
  PaymentHistoryList,
  usePaymentActions,
  usePaymentMethods,
} from "../../components/billing-payments"
import type { AdminPlan } from "../../components/plan-drawer"
import { ReasonDialog } from "../../components/reason-dialog"
import { api } from "../../lib/api"
import { requireAdminRole } from "../../lib/session"

export const Route = createFileRoute("/_app/accounts/$accountId")({
  beforeLoad: requireAdminRole,
  component: AccountPage,
})

const detailSchema = z.object({
  account: z.object({
    id: z.string(),
    app: z.string(),
    externalRef: z.string(),
    name: z.string().nullable(),
    country: z.string().nullable(),
    ownerName: z.string().nullable(),
    ownerEmail: z.string().nullable(),
    createdAt: z.string(),
  }),
  subscription: z.object({ status: z.string(), pauseReason: z.string().nullable() }).nullable(),
  state: z.object({
    access: z
      .object({
        status: z.string(),
        readOnlyAt: z.string().nullable(),
        trialEndsAt: z.string().nullable(),
      })
      .nullable(),
    agents: z.object({ trialExhausted: z.boolean(), capReached: z.boolean() }).nullable(),
    budget: z
      .object({
        currency: z.string().nullable(),
        creditCents: z.number(),
        creditUsedCents: z.number(),
        capCents: z.number().nullable(),
        spentCents: z.number(),
      })
      .nullable(),
    plan: z
      .object({ code: z.string(), name: z.string(), currency: z.string(), priceCents: z.number() })
      .nullable(),
    charges: z.array(
      z.object({
        id: z.string(),
        periodStart: z.string(),
        periodEnd: z.string(),
        amountCents: z.number(),
        paidCents: z.number(),
        currency: z.string(),
        status: z.string(),
        dueAt: z.string().nullable(),
        lines: z.array(
          z.object({ kind: z.string(), description: z.string(), amountCents: z.number() }),
        ),
      }),
    ),
    notices: z.array(z.object({ key: z.string(), family: z.string(), level: z.string() })),
    support: z.array(
      z.object({ id: z.string(), status: z.string(), question: z.string(), createdAt: z.string() }),
    ),
  }),
  requests: z.array(appRequestSchema),
  canRequest: z.boolean(),
})

const day = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso))

const CHARGE_STATUS: Record<string, string> = {
  pendiente: "Por pagar",
  parcial: "Pagado en parte",
  pagada: "Pagado",
  reversada: "Reversado",
  anulada: "Anulado",
}
const CASE_STATUS: Record<string, string> = {
  abierto: "Abierto",
  en_atencion: "En atención",
  esperando_clinica: "Esperando a la cuenta",
  resuelto: "Resuelto",
}
const NOTICE_WORDS: Record<string, string> = {
  saldo_prueba: "Saldo de prueba",
  dias_prueba: "Fin de la prueba",
  credito: "Crédito del mes",
  tope: "Presupuesto del mes",
  precio_especial: "Precio especial",
  condiciones: "Condiciones garantizadas",
}
const LEVEL_WORDS: Record<string, string> = {
  aviso: "aviso",
  alarma: "alarma",
  limite: "al límite",
}

function AccountPage() {
  const { accountId } = Route.useParams()
  const queryClient = useQueryClient()
  const detail = useQuery({
    queryKey: ["admin", "billing", "account", accountId],
    queryFn: async () =>
      detailSchema.parse(await api<unknown>(`/api/admin/billing/accounts/${accountId}`)),
  })
  const plans = useQuery({
    queryKey: ["admin", "billing", "plans"],
    queryFn: () => api<AdminPlan[]>("/api/admin/billing/plans?includeInactive=1"),
  })
  const methods = usePaymentMethods()
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["admin", "billing"] })
  const payments = usePaymentActions({ onChanged: refresh })
  const [planCode, setPlanCode] = useState("")
  const [manualOpen, setManualOpen] = useState(false)
  const [pauseOpen, setPauseOpen] = useState(false)
  const [asking, setAsking] = useState<null | "soporte.entrar" | "equipo.quitar">(null)
  const assign = useMutation({
    mutationFn: (code: string) =>
      api(`/api/admin/billing/accounts/${accountId}/plan`, {
        method: "POST",
        body: JSON.stringify({ planCode: code }),
      }),
    onSuccess: () => {
      toast.success("Plan asignado.")
      setPlanCode("")
      refresh()
    },
  })
  const resume = useMutation({
    mutationFn: () =>
      api(`/api/admin/billing/subscriptions/${accountId}/resume`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Reanudada.")
      refresh()
    },
  })

  if (detail.isPending)
    return (
      <PageShell>
        <SkeletonRegion message="Cargando la cuenta…">
          <div className="h-40 rounded-lg border" />
        </SkeletonRegion>
      </PageShell>
    )
  if (detail.isError)
    return (
      <PageShell>
        <ErrorState
          title="No se pudo cargar la cuenta"
          message={submitErrorMessage(detail.error)}
          onRetry={() => void detail.refetch()}
        />
      </PageShell>
    )
  const { account, subscription, state, requests, canRequest } = detail.data
  const name = account.name ?? account.externalRef
  const ownPlans = (plans.data ?? []).filter((plan) => plan.app === account.app && plan.isActive)
  const status = state.access?.status ?? "sin_suscripcion"
  const budget = state.budget

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader
        title={name}
        subtitle={`Cuenta de ${account.app === "gestoria" ? "gestorIA" : account.app} · abierta el ${day(account.createdAt)}`}
      />
      <section aria-labelledby="cuenta" className="flex flex-col gap-1 text-sm">
        <h2 id="cuenta" className="sr-only">
          La cuenta
        </h2>
        <p className="flex flex-wrap items-center gap-2">
          <AppMark app={account.app} />
          <span className="text-muted-foreground">· en la app: {account.externalRef}</span>
          {account.country ? (
            <span className="text-muted-foreground">· país {account.country}</span>
          ) : null}
        </p>
        <p className="text-muted-foreground">
          Dueño: {account.ownerName ?? "sin nombre"}
          {account.ownerEmail ? ` · ${account.ownerEmail}` : ""}
        </p>
      </section>

      <section aria-labelledby="plan" className="flex flex-col gap-3">
        <h2 id="plan" className="text-base font-semibold">
          Plan y estado
        </h2>
        <p className="text-sm">
          {ACCOUNT_STATUS[status] ?? status}
          {state.plan
            ? ` · ${state.plan.name} · ${money(state.plan.priceCents, state.plan.currency)} al mes`
            : ""}
          {state.access?.trialEndsAt
            ? ` · la prueba termina el ${day(state.access.trialEndsAt)}`
            : ""}
          {state.access?.readOnlyAt
            ? ` · solo lectura desde el ${day(state.access.readOnlyAt)} si no paga`
            : ""}
          {subscription?.pauseReason ? ` · pausada: ${subscription.pauseReason}` : ""}
        </p>
        {state.agents?.trialExhausted || state.agents?.capReached ? (
          <p role="status" className="rounded-lg bg-warning-soft px-3 py-2 text-sm">
            {state.agents.trialExhausted
              ? "Se usó todo el saldo de prueba: la app pausa a Sofi."
              : "Llegó a su presupuesto del mes: la app pasa lo nuevo a su equipo."}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={planCode}
            onValueChange={(value) => setPlanCode(typeof value === "string" ? value : "")}
          >
            <SelectTrigger className="w-64" aria-label="Plan de la cuenta">
              <SelectValue
                placeholder={ownPlans.length ? "Elige un plan de su app" : "Su app no tiene planes"}
              />
            </SelectTrigger>
            <SelectContent>
              {ownPlans.map((plan) => (
                <SelectItem key={plan.id} value={plan.code}>
                  {plan.name} · {money(plan.priceCents, plan.currency)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={!planCode || assign.isPending}
            onClick={() => assign.mutate(planCode)}
          >
            {state.plan ? "Cambiar el plan" : "Asignar el plan"}
          </Button>
          {subscription?.status === "pausada" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={resume.isPending}
              onClick={() => resume.mutate()}
            >
              Reanudar
            </Button>
          ) : subscription ? (
            <Button size="sm" variant="ghost" onClick={() => setPauseOpen(true)}>
              Pausar
            </Button>
          ) : null}
        </div>
        {assign.isError || resume.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {submitErrorMessage(assign.error ?? resume.error)}
          </p>
        ) : null}
        {budget ? (
          <p className="text-sm text-muted-foreground">
            Este tramo: {money(budget.creditUsedCents, budget.currency ?? "USD")} de{" "}
            {money(budget.creditCents, budget.currency ?? "USD")} de crédito
            {budget.capCents !== null
              ? ` · ${money(budget.spentCents, budget.currency ?? "USD")} de su presupuesto de ${money(budget.capCents, budget.currency ?? "USD")}`
              : " · sin presupuesto"}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="cargos" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="cargos" className="text-base font-semibold">
            Cargos
          </h2>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={!state.charges.length}
            onClick={() => setManualOpen(true)}
          >
            Registrar pago
          </Button>
        </div>
        {state.charges.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Sin cargos todavía: el primero sale al cerrar su primer mes con plan.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {state.charges.map((charge) => (
              <li key={charge.id} className="flex flex-col gap-1 rounded-lg border p-4 text-sm">
                <p className="flex flex-wrap items-center gap-x-3">
                  <span className="font-medium">
                    {day(charge.periodStart)} al {day(charge.periodEnd)}
                  </span>
                  <span className="text-muted-foreground">
                    {CHARGE_STATUS[charge.status] ?? charge.status}
                  </span>
                  <span className="ml-auto font-semibold tabular-nums">
                    {money(charge.amountCents, charge.currency)}
                  </span>
                </p>
                <ul className="text-xs text-muted-foreground">
                  {charge.lines.map((line) => (
                    <li key={`${line.kind}-${line.description}`} className="flex gap-2">
                      <span className="flex-1">{line.description}</span>
                      <span className="tabular-nums">
                        {money(line.amountCents, charge.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
                {charge.paidCents > 0 && charge.paidCents < charge.amountCents ? (
                  <p className="text-xs">Pagado {money(charge.paidCents, charge.currency)}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="pagos" className="flex flex-col gap-2">
        <h2 id="pagos" className="text-base font-semibold">
          Pagos
        </h2>
        <PaymentHistoryList
          organizationId={account.id}
          organizationName={name}
          methodName={(code) => methods.data?.find((method) => method.code === code)?.name ?? code}
          actions={payments}
          confirmPending
        />
        {payments.dialogs}
        {payments.actionError ? (
          <p role="alert" className="text-sm text-destructive">
            {payments.actionError}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="soporte" className="flex flex-col gap-2">
        <h2 id="soporte" className="text-base font-semibold">
          Soporte
        </h2>
        {state.support.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Sin casos. Los pide la cuenta desde su app.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {state.support.map((kase) => (
              <li
                key={kase.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border p-4 text-sm"
              >
                <span className="min-w-0 flex-1 basis-56">{kase.question}</span>
                <span className="text-muted-foreground">
                  {CASE_STATUS[kase.status] ?? kase.status}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link to="/support" search={{ caso: kase.id }} />}
                >
                  Abrir
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="pedidos" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="pedidos" className="text-base font-semibold">
            Lo que se le pide a su app
          </h2>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!canRequest}
              onClick={() => setAsking("soporte.entrar")}
            >
              Dejar entrar a soporte
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canRequest}
              onClick={() => setAsking("equipo.quitar")}
            >
              Quitar a una persona
            </Button>
          </div>
        </div>
        {!canRequest ? (
          <p className="text-sm text-muted-foreground">
            La conexión con su app no está encendida: todavía no se le puede pedir nada.
          </p>
        ) : null}
        <AppRequestList requests={requests} />
      </section>

      {state.notices.length ? (
        <section aria-labelledby="avisos" className="flex flex-col gap-1 text-sm">
          <h2 id="avisos" className="text-base font-semibold">
            Avisos que le muestra su app
          </h2>
          <ul className="text-muted-foreground">
            {state.notices.map((notice) => (
              <li key={notice.key}>
                {NOTICE_WORDS[notice.family] ?? notice.family} ·{" "}
                {LEVEL_WORDS[notice.level] ?? notice.level}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {asking ? (
        <AppRequestDrawer
          accountId={account.id}
          app={account.app}
          kind={asking}
          onClose={() => setAsking(null)}
          onSaved={() => {
            toast.success("Pedido: sale a su app ahora.")
            refresh()
          }}
        />
      ) : null}
      {manualOpen ? (
        <ManualPaymentDrawer
          orgs={[{ organizationId: account.id, organizationName: name }]}
          methods={methods.data ?? []}
          onClose={() => setManualOpen(false)}
          onSaved={refresh}
        />
      ) : null}
      <ReasonDialog
        open={pauseOpen}
        id="account-pause-reason"
        title={`Pausar ${name}`}
        description="La app deja de dejarla operar hasta reanudar: puede leer, pagar y pedir ayuda."
        confirmLabel="Pausar"
        placeholder="Por qué se pausa"
        onConfirm={async (reason) => {
          await api(`/api/admin/billing/subscriptions/${accountId}/pause`, {
            method: "POST",
            body: JSON.stringify({ pauseReason: reason }),
          })
          toast.success("Pausada.")
          refresh()
        }}
        onClose={() => setPauseOpen(false)}
      />
    </PageShell>
  )
}
