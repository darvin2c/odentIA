/**
 * Lo que hicieron los agentes en el tramo que corre (ADR 0031, tablero C2):
 * primero las acciones con su precio base y el propio, después el crédito y
 * lo que se proyecta al cierre. Mientras no se cobra lo dice arriba.
 */
import { Button } from "@odentia/ui"
import { UsageMeter } from "@odentia/ui-patterns"
import { formatBps, formatMicros, formatPlanMoney } from "./money"
import { agentName, type AgentRole } from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"

type AgentRoleId = Exclude<AgentRole["id"], "ayuda">

export type SaasActionKind = "conversacion" | "consulta" | "cita"

export interface Consumption {
  period: { start: string; end: string; credit: "prueba" | "mes" }
  currency: string | null
  priced: boolean
  /** true cuando lo de este tramo se factura; mientras no, «así sería tu factura». */
  charging?: boolean
  discountBps: number
  lines: Array<{
    kind: SaasActionKind
    count: number
    basePriceMicros: number | null
    priceMicros: number | null
    amountCents: number
    baseAmountCents: number
  }>
  /** Conversaciones ya cobradas que devuelven las citas recuperadas; ya restadas de la línea de la cita. */
  refunds?: { count: number; amountCents: number }
  pendingRecoveries: number
  subtotalCents: number
  baseSubtotalCents: number
  creditCents: number
  creditUsedCents: number
  creditExhaustedAt: string | null
  overCreditCents: number
  projectedCents: number | null
  spendCapCents?: number | null
  /** Desde qué parte avisa y alarma el medidor: las condiciones comerciales que rigen (ADR 0074). */
  warnPercent: number
  alarmPercent: number
  tax?: { label: string; rateBps: number } | null
  whatsapp?: {
    templates: { marketing: number; utility: number; authentication: number }
    currency: string | null
    estimateMicros: number | null
  }
}

/** De qué agente es cada acción (su id de rol: el nombre se dice con `agentName`). */
export const AGENT_OF: Record<SaasActionKind, { agent: AgentRoleId; what: (count: number) => string }> = {
  conversacion: { agent: "recepcion", what: (n) => `${n} ${n === 1 ? "conversación atendida" : "conversaciones atendidas"}` },
  consulta: { agent: "asistente_clinico", what: (n) => `${n} ${n === 1 ? "consulta dictada y confirmada" : "consultas dictadas y confirmadas"}` },
  cita: { agent: "administrador", what: (n) => `${n} ${n === 1 ? "cita recuperada" : "citas recuperadas"}` },
}

function day(iso: string): string {
  return new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "long" }).format(new Date(iso))
}

/** Precio base tachado y el propio al lado, solo si hubo negociación. */
export function PriceWithDiscount({ base, price, currency, discountBps }: { base: number | null; price: number | null; currency: string; discountBps: number }) {
  if (base === null || price === null) return <span className="text-muted-foreground">Sin precio</span>
  if (discountBps <= 0 || price === base) return <span className="tabular-nums">{formatMicros(base, currency)}</span>
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5 tabular-nums">
      <s className="text-muted-foreground">
        <span className="sr-only">Precio base </span>
        {formatMicros(base, currency)}
      </s>
      <span className="font-semibold text-primary">{formatMicros(price, currency)}</span>
      <span className="text-xs text-muted-foreground">−{formatBps(discountBps)}</span>
    </span>
  )
}

export function ConsumptionCard({
  data,
  exempt = false,
  onShowActions,
  onChangeCap,
}: {
  data: Consumption
  exempt?: boolean
  onShowActions: () => void
  onChangeCap?: () => void
}) {
  const receptionName = useReceptionName()
  const currency = data.currency ?? "USD"
  const money = (cents: number) => formatPlanMoney(cents, currency)
  const trial = data.period.credit === "prueba"
  const savings = data.baseSubtotalCents - data.subtotalCents
  const title = trial ? "Lo que hicieron tus agentes en la prueba" : "Lo que hicieron tus agentes este mes"
  return (
    <section aria-labelledby="consumo" className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h2 id="consumo" className="text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">
          Del {day(data.period.start)} al {day(data.period.end)}
          {data.discountBps > 0 ? ` · precios negociados con tu asesor: ${formatBps(data.discountBps)} menos en cada acción` : ""}
        </p>
        {exempt ? (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm">Cuenta demo: se cuenta lo que hacen los agentes, pero no se cobra.</p>
        ) : trial ? (
          <p className="text-sm">Se descuenta del saldo de regalo de la prueba: no se cobra.</p>
        ) : !data.charging ? (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm">
            Este mes no se cobra: así sería tu factura. Revisa que cada acción sea correcta en «Ver cada acción».
          </p>
        ) : (
          <p className="text-sm">
            Se factura al cerrar tu mes, el {day(data.period.end)}: la cuota y lo que pase del crédito, más {data.tax?.label ?? "impuestos"}.
          </p>
        )}
      </div>

      {!data.priced ? (
        <p className="text-sm text-muted-foreground">
          Tu plan aún no tiene precios por acción: abajo ves cuántas hizo cada agente. Escríbele a soporte si esperabas verlos.
        </p>
      ) : null}

      <ul className="flex flex-col divide-y rounded-lg border">
        {data.lines.map((line) => (
          <li key={line.kind} className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{agentName(AGENT_OF[line.kind].agent, receptionName)}</p>
              <p className="text-sm font-medium">
                {AGENT_OF[line.kind].what(line.count)}
                {line.kind === "cita" && data.pendingRecoveries > 0 ? (
                  <span className="font-normal text-muted-foreground"> · {data.pendingRecoveries} más esperan que el paciente asista</span>
                ) : null}
                {line.kind === "cita" && data.priced && data.refunds?.count ? (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · menos {money(data.refunds.amountCents)} de {data.refunds.count === 1 ? "la conversación ya cobrada que llevó a ella" : `${data.refunds.count} conversaciones ya cobradas que llevaron a ellas`}
                  </span>
                ) : null}
              </p>
            </div>
            <div className="col-start-1 row-start-2 text-sm sm:col-start-auto sm:row-start-auto">
              <PriceWithDiscount base={line.basePriceMicros} price={line.priceMicros} currency={currency} discountBps={data.discountBps} />
            </div>
            <p className="row-span-2 text-right text-sm font-semibold tabular-nums sm:row-span-1">{data.priced ? money(line.amountCents) : "—"}</p>
          </li>
        ))}
        {data.priced ? (
          <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 bg-muted/40 px-4 py-3">
            <p className="text-sm">
              Subtotal, sin {data.tax?.label ?? "impuestos"}
              {savings > 0 ? (
                <span className="text-muted-foreground"> · a precio base serían {money(data.baseSubtotalCents)}: ahorras {money(savings)}</span>
              ) : null}
            </p>
            <p className="text-base font-semibold tabular-nums">{money(data.subtotalCents)}</p>
          </li>
        ) : null}
      </ul>

      {data.priced ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <UsageMeter
            label={trial ? "Saldo de prueba" : "Crédito del mes"}
            value={data.creditUsedCents}
            total={data.creditCents}
            warnAt={data.warnPercent / 100}
            alarmAt={data.alarmPercent / 100}
            valueText={`${money(data.creditUsedCents)} de ${money(data.creditCents)}`}
            description={
              data.creditExhaustedAt
                ? trial
                  ? `Se acabó el ${day(data.creditExhaustedAt)}: los agentes quedaron en pausa.`
                  : `Se acabó el ${day(data.creditExhaustedAt)}. Desde entonces cada acción se cobra con tu precio y los agentes siguen atendiendo. Van ${money(data.overCreditCents)} por encima del crédito.`
                : trial
                  ? "Cuando se acabe, los agentes se pausan hasta que elijas tu plan."
                  : "Lo que pase del crédito se cobra por acción, con tu precio."
            }
          />
          {!trial && onChangeCap ? (
            <div className="flex flex-col gap-1.5">
              {data.spendCapCents ? (
                <UsageMeter
                  label="Tope por encima del crédito"
                  value={data.overCreditCents}
                  total={data.spendCapCents}
                  warnAt={data.warnPercent / 100}
                  alarmAt={data.alarmPercent / 100}
                  valueText={`${money(data.overCreditCents)} de ${money(data.spendCapCents)}`}
                  description={`Al llegar, ${receptionName} pasa los casos nuevos a tu equipo con un mensaje fijo.`}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Sin tope de gasto: los agentes siguen atendiendo y cada acción se cobra con tu precio.</p>
              )}
              <div>
                <Button variant="link" size="sm" className="px-0" onClick={onChangeCap}>
                  {data.spendCapCents ? "Cambiar tope" : "Poner un tope"}
                </Button>
              </div>
            </div>
          ) : null}
          {data.projectedCents !== null ? (
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">A este ritmo, al cierre</p>
              <p className="text-xl font-semibold tabular-nums">{money(data.projectedCents)}</p>
              <p className="text-xs text-muted-foreground">Estimado con lo que va del tramo; no es un cobro.</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {data.whatsapp && data.whatsapp.templates.marketing + data.whatsapp.templates.utility + data.whatsapp.templates.authentication > 0 ? (
        <div className="rounded-lg border px-4 py-3 text-sm">
          <p className="font-medium">
            WhatsApp (Meta), estimado del tramo
            {data.whatsapp.estimateMicros !== null && data.whatsapp.currency ? (
              <span className="ml-2 tabular-nums">{formatMicros(data.whatsapp.estimateMicros, data.whatsapp.currency)}</span>
            ) : null}
          </p>
          <p className="mt-1 text-muted-foreground">
            {data.whatsapp.templates.utility + data.whatsapp.templates.authentication} mensajes de servicio y {data.whatsapp.templates.marketing} de marketing enviados
            como plantilla. Es solo una estimación: lo cobra Meta directo a tu cuenta y depende por completo de Meta. odentIA no cobra ni recibe ese pago.
            {data.whatsapp.estimateMicros === null ? " Aún no tenemos la tarifa de Meta para tu país." : ""}
          </p>
        </div>
      ) : null}

      <div>
        <Button variant="outline" size="sm" onClick={onShowActions}>
          Ver cada acción
        </Button>
      </div>
    </section>
  )
}
