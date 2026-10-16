import { formatPlanMoney } from "./money"

export interface PlanSummary {
  code: string
  name: string
  currency: string
  priceCents: number
  billingPeriod: string
}

export interface BillingSummary {
  plan: PlanSummary | null
  status: "prueba" | "activa" | "gracia" | "restringida" | "pausada" | "cancelada" | "sin_suscripcion"
  isDemo: boolean
  currency: string | null
  trialEndsAt: string | null
  graceEndsAt: string | null
  currentPeriodEnd: string | null
  restricted: boolean
  restrictReason: string | null
  pauseReason: string | null
  outstandingByCurrency: Array<{ currency: string; cents: number }>
  proofExtensionUntil: string | null
  usage30d: {
    agentRuns: number
    llmCalls: number
    inputTokens: number | null
    outputTokens: number | null
    periodLabel: string
  }
}

const STATUS_TITLE: Record<BillingSummary["status"], string> = {
  prueba: "Período de prueba",
  activa: "Suscripción activa",
  gracia: "Período de gracia",
  restringida: "Acceso restringido",
  pausada: "Suscripción en pausa",
  cancelada: "Suscripción cancelada",
  sin_suscripcion: "Sin suscripción",
}

function dateLabel(iso: string | null): string {
  if (!iso) return "—"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat("es-PE", { dateStyle: "medium" }).format(date)
}

export function SubscriptionStatusCard({ summary }: { summary: BillingSummary }) {
  const tone =
    summary.status === "restringida"
      ? "border-destructive/40 bg-destructive/5"
      : summary.status === "gracia" || summary.status === "prueba"
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-border"
  return (
    <section aria-label="Estado de la suscripción" className={`rounded-lg border p-4 ${tone}`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-base font-semibold">{STATUS_TITLE[summary.status]}</h2>
        {summary.isDemo ? <span className="text-xs text-muted-foreground">Demo (exenta de cobro)</span> : null}
      </div>
      {summary.plan ? (
        <p className="mt-1 text-sm">
          {summary.plan.name} · {formatPlanMoney(summary.plan.priceCents, summary.plan.currency)} /{" "}
          {summary.plan.billingPeriod}
        </p>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">Aún no elegiste un plan.</p>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Prueba hasta</dt>
          <dd>{dateLabel(summary.trialEndsAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Gracia hasta</dt>
          <dd>{dateLabel(summary.graceEndsAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Período hasta</dt>
          <dd>{dateLabel(summary.currentPeriodEnd)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Saldo</dt>
          <dd className="font-semibold tabular-nums">
            {summary.outstandingByCurrency.length > 0
              ? summary.outstandingByCurrency
                  .map((entry) => formatPlanMoney(entry.cents, entry.currency))
                  .join(" · ")
              : "Al día"}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        Uso {summary.usage30d.periodLabel}: {summary.usage30d.agentRuns} corridas del agente
      </p>
      {summary.status === "restringida" ? (
        <p className="mt-3 text-sm">
          El acceso está restringido por falta de pago
          {summary.restrictReason ? ` (${summary.restrictReason})` : ""}. Puedes ver tu plan, registrar tu
          comprobante y pedir ayuda desde aquí.
        </p>
      ) : null}
      {summary.status === "pausada" ? (
        <p className="mt-3 text-sm">
          La suscripción está en pausa{summary.pauseReason ? `: ${summary.pauseReason}` : ""}. Escribe a soporte
          para reanudarla.
        </p>
      ) : null}
      {summary.proofExtensionUntil ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Prórroga por comprobante pendiente hasta el {dateLabel(summary.proofExtensionUntil)}.
        </p>
      ) : null}
    </section>
  )
}
