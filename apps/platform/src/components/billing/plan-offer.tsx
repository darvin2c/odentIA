/**
 * Activar el plan (ADR 0031, tablero C1): lo que resalta es que la cuota
 * vuelve en crédito; después el precio de cada acción, con cuándo se cobra y
 * cuándo no, y un estimado sacado de lo que la clínica hizo en su prueba.
 */
import { Button } from "@odentia/ui"
import type { Consumption } from "./consumption"
import { formatMicros, formatPlanMoney } from "./money"
import { agentName } from "../../lib/agent"
import { useReceptionName, withReceptionName } from "../../lib/agent-names"

export interface OfferPlan {
  code: string
  name: string
  currency: string
  priceCents: number
  billingPeriod: string
  creditCents: number
  conversationMicros: number | null
  consultationMicros: number | null
  recoveryMicros: number | null
}

const ACTIONS = [
  {
    key: "conversationMicros" as const,
    agent: "recepcion",
    what: "Conversación atendida",
    when: "Una por persona cada 24 horas, aunque escriba diez mensajes o cambie de canal.",
    /** «Sofi» se cambia por el nombre de la clínica al mostrarlo. */
    not: "No se cobra si responde tu equipo, si se deriva sin IA o si Sofi falla.",
  },
  {
    key: "consultationMicros" as const,
    agent: "asistente_clinico",
    what: "Consulta dictada y confirmada",
    when: "Una por atención, sin importar cuántos minutos dictes.",
    not: "No se cobra si descartas el borrador.",
  },
  {
    key: "recoveryMicros" as const,
    agent: "administrador",
    what: "Cita recuperada",
    when: "Cuando un paciente vuelve tras un seguimiento y asiste.",
    not: "No se cobran recordatorios, mensajes sin respuesta ni citas canceladas.",
  },
]

export function PlanOffer({
  plan,
  current,
  trialing,
  consumption,
  taxLabel,
  busy,
  onActivate,
}: {
  plan: OfferPlan
  current: boolean
  trialing: boolean
  consumption: Consumption | null
  taxLabel: string | null
  busy: boolean
  onActivate: () => void
}) {
  const receptionName = useReceptionName()
  const money = (cents: number) => formatPlanMoney(cents, plan.currency)
  const priced = ACTIONS.some((action) => plan[action.key] !== null)
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
            {busy ? "Activando…" : "Activar plan"}
          </Button>
        ) : null}
      </div>
      {returnsCredit ? (
        <p className="rounded-lg bg-primary-soft px-3 py-2 text-base font-medium text-primary">
          Te devolvemos los {money(plan.creditCents)} en crédito para las acciones de tus agentes.
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Todo el sistema, sin límite de odontólogos, sedes ni cuentas. Recordatorios y avisos al equipo incluidos. Pagas mes a mes, sin
        permanencia. Tu mes empieza el día que activas{trialing ? " (si estás en prueba, cuando termina)" : ""}.
      </p>
      {priced ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Lo que pase del crédito se paga por acción: solo cuando un agente hace su trabajo.</p>
          <ul className="flex flex-col divide-y rounded-lg border">
            {ACTIONS.map((action) => {
              const price = plan[action.key]
              if (price === null) return null
              return (
                <li key={action.key} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1 basis-60">
                    <p className="text-xs text-muted-foreground">{agentName(action.agent, receptionName)}</p>
                    <p className="text-sm font-medium">{action.what}</p>
                    <p className="text-xs text-muted-foreground">
                      {action.when} {withReceptionName(action.not, receptionName)}
                    </p>
                  </div>
                  <p className="text-base font-semibold tabular-nums">{formatMicros(price, plan.currency)}</p>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      {estimate ? (
        <p className="text-sm">
          A este ritmo serían unos <strong>{money(estimate.total)}</strong> al mes{taxLabel ? ` más ${taxLabel}` : ""}: {money(plan.priceCents)} que vuelven en crédito
          {estimate.total > plan.priceCents ? ` y ${money(estimate.total - plan.priceCents)} por acción` : ""}. Es una estimación con lo que hicieron tus agentes en la prueba.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        ¿Tu clínica tiene mucho volumen? Tu asesor puede mejorar tus precios por acción; siempre verás el precio base junto al tuyo. WhatsApp lo
        pagas directo a Meta. El crédito que no usas no pasa al mes siguiente.
      </p>
    </section>
  )
}
