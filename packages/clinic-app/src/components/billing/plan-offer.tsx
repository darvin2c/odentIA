/**
 * Activar el plan (ADR 0031 y 0085, tablero C1): lo que resalta es que la
 * cuota vuelve en crédito; después el precio de cada tipo de acción por
 * agente, lo que no se cobra, y un estimado sacado de lo que la clínica hizo
 * en su prueba.
 */
import { Button } from "@odentia/ui"
import type { Consumption } from "./consumption"
import { formatMicros, formatPlanMoney } from "./money"
import { agentName } from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"
import { conversationRule, useSaasTerms } from "../../lib/billing"
import { activeOrgLocale } from "../../lib/locale"
import { META_ACCOUNT_URL } from "../../lib/whatsapp"
import { appWords } from "../../lib/product-words"

export interface OfferPlan {
  code: string
  name: string
  currency: string
  priceCents: number
  billingPeriod: string
  /** El plan de lista de odentIA (el por defecto de la administración). */
  isDefault: boolean
  creditCents: number
  /** Gestiona y Completa: los de antes de los tipos (ADR 0085). */
  conversationMicros: number | null
  consultationMicros: number | null
  recoveryMicros: number | null
  conversationInformMicros?: number | null
  conversationAgendaMicros?: number | null
  consultationSimpleMicros?: number | null
  consultationStandardMicros?: number | null
  argosIncludedQuestions?: number
  argosPackQuestions?: number
  argosPackMicros?: number | null
  storageIncludedGb?: number
  storageGbMicros?: number | null
}

/** Los precios de cada agente, en el orden del tablero: lo que se cobra y cuándo (ADR 0085). */
function priceColumns(plan: OfferPlan, receptionName: string) {
  const or = (own: number | null | undefined, fallback: number | null) => own ?? fallback
  return [
    {
      agent: receptionName,
      about: "lo que pasó en la agenda",
      rows: [
        { label: "Informa", micros: or(plan.conversationInformMicros, plan.conversationMicros) },
        { label: "Gestiona", micros: plan.conversationMicros },
        { label: "Agenda, si viene", micros: or(plan.conversationAgendaMicros, plan.conversationMicros) },
      ],
    },
    {
      agent: agentName("asistente_clinico", receptionName),
      about: "lo que dejó hecho",
      rows: [
        { label: "Simple", micros: or(plan.consultationSimpleMicros, plan.consultationMicros) },
        { label: "Estándar", micros: or(plan.consultationStandardMicros, plan.consultationMicros) },
        { label: "Completa", micros: plan.consultationMicros },
      ],
    },
    {
      agent: agentName("administrador", receptionName),
      about: "y espacio",
      rows: [
        { label: "Cita recuperada", micros: plan.recoveryMicros },
        ...(plan.argosPackMicros !== null && plan.argosPackMicros !== undefined
          ? [
              { label: `${plan.argosIncludedQuestions ?? 0} preguntas`, micros: null, text: "incluidas" },
              { label: `${plan.argosPackQuestions ?? 100} preguntas más`, micros: plan.argosPackMicros },
            ]
          : []),
        ...(plan.storageGbMicros !== null && plan.storageGbMicros !== undefined
          ? [
              { label: `${plan.storageIncludedGb ?? 0} GB`, micros: null, text: "incluidos" },
              { label: "GB extra al mes", micros: plan.storageGbMicros },
            ]
          : []),
      ],
    },
  ]
}

export function PlanOffer({
  plan,
  current,
  switching = false,
  trialing,
  consumption,
  taxLabel,
  busy,
  onActivate,
}: {
  plan: OfferPlan
  current: boolean
  /** La clínica ya tiene otro plan: el botón la pasa a este. */
  switching?: boolean
  trialing: boolean
  consumption: Consumption | null
  taxLabel: string | null
  busy: boolean
  onActivate: () => void
}) {
  const receptionName = useReceptionName()
  const terms = useSaasTerms().data
  const money = (cents: number) => formatPlanMoney(cents, plan.currency)
  const priced = plan.conversationMicros !== null || plan.consultationMicros !== null || plan.recoveryMicros !== null
  const unit = (micros: number) => new Intl.NumberFormat(activeOrgLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(micros / 1_000_000)
  const returnsCredit = plan.creditCents > 0 && plan.creditCents >= plan.priceCents
  // El estimado sale de lo que hicieron los agentes en la prueba, llevado a un mes.
  const estimate =
    trialing && consumption?.priced && consumption.projectedCents !== null
      ? (() => {
          const days = (new Date(consumption.period.end).getTime() - new Date(consumption.period.start).getTime()) / 86_400_000
          const perMonth = Math.round((consumption.projectedCents / Math.max(days, 1)) * 30)
          return { perMonth, total: plan.priceCents + Math.max(0, perMonth - plan.creditCents) }
        })()
      : null
  return (
    <section aria-label={plan.name} className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {plan.name} {current ? <span className="text-muted-foreground">(tu plan)</span> : null}
          </p>
          <p className="text-2xl font-semibold tabular-nums">
            {money(plan.priceCents)} <span className="text-sm font-normal text-muted-foreground">al mes{taxLabel ? ` + ${taxLabel}` : ""}</span>
          </p>
        </div>
        {!current ? (
          <Button onClick={onActivate} disabled={busy}>
            {switching ? (busy ? "Cambiando…" : "Pasarme a este plan") : busy ? "Activando…" : "Activar plan"}
          </Button>
        ) : null}
      </div>
      {returnsCredit ? (
        <p className="rounded-lg bg-primary-soft px-3 py-2 text-base font-medium text-primary">
          Te devolvemos los {money(plan.creditCents)} en crédito para las acciones de tus agentes.
        </p>
      ) : null}
      {!current ? (
        <p className="text-sm text-muted-foreground">
          Pagas mes a mes, sin permanencia. Tu mes empieza el día que activas{trialing ? " (si estás en prueba, cuando termina)" : ""}.
        </p>
      ) : null}
      {priced ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            Todo el sistema, sin límite de {appWords().clinician.many}, sedes ni cuentas. Lo que pase del crédito se paga por lo que hace cada agente{" "}
            <span className="text-muted-foreground">({plan.currency})</span>.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {priceColumns(plan, receptionName).map((column) => (
              <div key={column.agent} className="flex flex-col gap-1.5 rounded-lg border p-3">
                <p className="text-xs">
                  <span className="font-semibold text-agent">{column.agent}</span>
                  <span className="text-muted-foreground"> · {column.about}</span>
                </p>
                <dl className="flex flex-col gap-0.5 text-sm">
                  {column.rows
                    .filter((row) => row.micros !== null || "text" in row)
                    .map((row) => (
                      <div key={row.label} className="flex items-baseline justify-between gap-3">
                        <dt>{row.label}</dt>
                        <dd className="font-semibold tabular-nums">{row.micros !== null ? unit(row.micros) : "text" in row ? row.text : ""}</dd>
                      </div>
                    ))}
                </dl>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {terms ? `${conversationRule(terms)}. ` : ""}No se cobran el spam, los mensajes ajenos, lo que pasa a tu equipo, los recordatorios ni el borrador
            descartado. WhatsApp lo cobra Meta directamente a tu clínica:{" "}
            <a href={META_ACCOUNT_URL} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
              revisa sus tarifas y tu facturación en Meta
            </a>
            .
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Todo el sistema, sin límite de {appWords().clinician.many}, sedes ni cuentas. Recordatorios y avisos al equipo incluidos. Pagas mes a mes, sin permanencia.
        </p>
      )}
      {estimate ? (
        <p className="text-sm">
          A este ritmo serían unos <strong>{money(estimate.total)}</strong> al mes{taxLabel ? ` más ${taxLabel}` : ""}: {money(plan.priceCents)} que vuelven en crédito
          {estimate.total > plan.priceCents ? ` y ${money(estimate.total - plan.priceCents)} por acción` : ""}. Es una estimación con lo que hicieron tus agentes en la prueba.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        ¿Tu clínica tiene mucho volumen? Tu asesor puede mejorar los precios de Gestiona, Agenda, Completa y la cita recuperada; siempre verás el precio
        base junto al tuyo. El crédito que no usas no pasa al mes siguiente.
      </p>
    </section>
  )
}

/** El plan especial que la administración le asignó a la clínica, debajo del de lista y en corto. */
export function SpecialPlanCard({ plan, taxLabel }: { plan: OfferPlan; taxLabel: string | null }) {
  return (
    <section aria-label={plan.name} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-primary bg-card p-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">
          {plan.name} <span className="font-normal text-muted-foreground">(tu plan)</span>
        </p>
        <p className="text-sm text-muted-foreground">Condiciones que acordaste con {appWords().name}. Arriba, el plan de lista, por si quieres pasarte.</p>
      </div>
      <p className="text-lg font-semibold tabular-nums">
        {formatPlanMoney(plan.priceCents, plan.currency)}{" "}
        <span className="text-sm font-normal text-muted-foreground">al mes{taxLabel ? ` + ${taxLabel}` : ""}</span>
      </p>
    </section>
  )
}
