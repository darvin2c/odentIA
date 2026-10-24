import { appWords } from "../../lib/product-words"
/**
 * Lo que hicieron los agentes en el tramo que corre (ADR 0031 y 0085, tablero
 * C1): cada agente con sus tipos, cuántas y a cuánto; después el crédito, el
 * presupuesto, las preguntas a Argos y lo guardado, y lo que se proyecta al
 * cierre. Mientras no se cobra lo dice arriba. Si la clínica llegó a su
 * presupuesto, lo que se cobró después va aparte (tablero C4).
 */
import { Button } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { UsageMeter } from "@odentia/ui-patterns"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import { META_ACCOUNT_URL } from "../../lib/whatsapp"
import { formatBps, formatMicros, formatPlanMoney } from "./money"
import { agentName, type AgentRole } from "../../lib/agent"
import { useReceptionName } from "../../lib/agent-names"

type AgentRoleId = Exclude<AgentRole["id"], "ayuda">

export type SaasActionKind = "conversacion" | "consulta" | "cita" | "preguntas" | "almacenamiento"
export type SaasActionTier = "informa" | "gestiona" | "agenda" | "simple" | "estandar" | "completa"

export interface ConsumptionTier {
  tier: SaasActionTier
  count: number
  basePriceMicros: number | null
  priceMicros: number | null
  amountCents: number
}

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
    /** Preguntas sumadas con paquetes o GB extra. */
    units?: number
    basePriceMicros: number | null
    priceMicros: number | null
    amountCents: number
    baseAmountCents: number
    tiers?: ConsumptionTier[]
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
  /** El presupuesto del mes (ADR 0085): lo que pasa del crédito sin el almacenamiento, y lo cobrado tras llegar. */
  budget?: {
    capCents: number | null
    spentCents: number
    reachedAt: string | null
    after: { count: number; amountCents: number; lines: Array<{ kind: SaasActionKind; tier: SaasActionTier | null; count: number; amountCents: number }> }
    storageCents: number
  }
  /** Las preguntas a Argos del mes (ADR 0085). */
  argos?: {
    limited: boolean
    included: number
    added: number
    used: number
    remaining: number
    packQuestions: number
    packPriceMicros: number | null
    autoPack: boolean
  }
  /** Lo guardado en la última medición y lo que incluye el plan. */
  storage?: { bytes: number | null; includedGb: number; gbBaseMicros: number | null; gbPriceMicros: number | null }
  /** Desde qué parte avisa y alarma el medidor: las condiciones comerciales que rigen (ADR 0074). */
  warnPercent: number
  alarmPercent: number
  tax?: { label: string; rateBps: number } | null
}

/** De qué agente es cada acción (su id de rol: el nombre se dice con `agentName`). */
export const AGENT_OF: Record<SaasActionKind, { agent: AgentRoleId | null; what: (count: number) => string }> = {
  conversacion: { agent: "recepcion", what: (n) => `${n} ${n === 1 ? "conversación atendida" : "conversaciones atendidas"}` },
  consulta: { agent: "asistente_clinico", what: (n) => `${n} ${n === 1 ? "consulta dictada y confirmada" : "consultas dictadas y confirmadas"}` },
  cita: { agent: "administrador", what: (n) => `${n} ${n === 1 ? "cita recuperada" : "citas recuperadas"}` },
  preguntas: { agent: "administrador", what: (n) => `${n} ${n === 1 ? "paquete de preguntas" : "paquetes de preguntas"}` },
  almacenamiento: { agent: null, what: () => "Almacenamiento por encima de lo incluido" },
}

/** El agente de una acción, o «Almacenamiento» para lo que no hace un agente. */
export function agentOfKind(kind: SaasActionKind, receptionName: string): string {
  const agent = AGENT_OF[kind].agent
  return agent ? agentName(agent, receptionName) : "Almacenamiento"
}

/** Cómo se llama cada tipo en pantalla (ADR 0085). */
export const TIER_NAME: Record<SaasActionTier, string> = {
  informa: "Informa",
  gestiona: "Gestiona",
  agenda: "Agenda",
  simple: "Simple",
  estandar: "Estándar",
  completa: "Completa",
}

/** Cada tipo, en una frase: lo que hizo el agente para que sea de ese tipo. */
const TIER_ROWS: Record<SaasActionTier, { count: (n: number) => string; what: string }> = {
  informa: { count: (n) => `${n} ${n === 1 ? "conversación" : "conversaciones"}`, what: "Respondió, confirmó o dio un precio; en la agenda no cambió nada" },
  gestiona: { count: (n) => `${n} ${n === 1 ? "conversación" : "conversaciones"}`, what: "Reservó, movió o canceló una cita" },
  agenda: { count: (n) => `${n} ${n === 1 ? "paciente vino" : "pacientes vinieron"}`, what: "Vino a la cita que reservó: cada una sube de Gestiona a Agenda" },
  simple: { count: (n) => `${n} ${n === 1 ? "atención" : "atenciones"}`, what: "Una receta, una nota o un control" },
  estandar: { count: (n) => `${n} ${n === 1 ? "atención" : "atenciones"}`, get what() { return appWords().clioTiers.estandar } },
  completa: { count: (n) => `${n} ${n === 1 ? "atención" : "atenciones"}`, get what() { return appWords().clioTiers.completa } },
}

function day(iso: string): string {
  return new Intl.DateTimeFormat(activeOrgLocale(), { day: "numeric", month: "long", timeZone: activeOrgTimeZone() }).format(new Date(iso))
}

/** «0,10»: el precio de una unidad sin la moneda, para «150 × 0,10». */
function unitText(micros: number): string {
  return new Intl.NumberFormat(activeOrgLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(micros / 1_000_000)
}

/** «14,2»: GB con un decimal. */
export function gbText(bytes: number): string {
  return new Intl.NumberFormat(activeOrgLocale(), { maximumFractionDigits: 1 }).format(bytes / 1024 ** 3)
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

/** Una fila de un agente: el tipo y cuántas, qué hizo, «N × precio» y el importe. */
function ActionRow({
  name,
  count,
  what,
  unit,
  amount,
  extra,
}: {
  name: string
  count: string
  what: string
  /** «150 × 0,10»; null si no hay precio. */
  unit: string | null
  amount: string
  extra?: React.ReactNode
}) {
  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm">
          <span className="font-semibold">{name}</span>
          <span className="text-muted-foreground"> · {count}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          {what}
          {extra}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {unit ? <p className="text-xs text-muted-foreground tabular-nums">{unit}</p> : null}
        <p className="text-sm font-semibold tabular-nums">{amount}</p>
      </div>
    </li>
  )
}

function AgentHeader({ name, about, tone = "agent" }: { name: string; about?: string; tone?: "agent" | "argos" | "muted" }) {
  return (
    <li className="bg-muted/40 px-4 py-1.5 text-xs">
      <span className={tone === "argos" ? "font-semibold text-warning" : tone === "muted" ? "font-semibold text-muted-foreground" : "font-semibold text-agent"}>
        {name}
      </span>
      {about ? <span className="text-muted-foreground"> · {about}</span> : null}
    </li>
  )
}

export function ConsumptionCard({
  data,
  exempt = false,
  onShowActions,
  onChangeCap,
  onAutoPack,
  autoPackPending = false,
}: {
  data: Consumption
  exempt?: boolean
  onShowActions: () => void
  onChangeCap?: () => void
  /** «Sumar solas» las preguntas a Argos; ausente si quien mira no lo administra. */
  onAutoPack?: (on: boolean) => void
  autoPackPending?: boolean
}) {
  const receptionName = useReceptionName()
  const currency = data.currency ?? "USD"
  const money = (cents: number) => formatPlanMoney(cents, currency)
  const trial = data.period.credit === "prueba"
  const savings = data.baseSubtotalCents - data.subtotalCents
  const title = trial ? "Lo que hicieron tus agentes en la prueba" : "Lo que hicieron tus agentes este mes"
  const line = (kind: SaasActionKind) => data.lines.find((item) => item.kind === kind)
  const tierRows = (kind: SaasActionKind) =>
    (line(kind)?.tiers ?? []).map((tier) => {
      const row = TIER_ROWS[tier.tier]
      return (
        <ActionRow
          key={tier.tier}
          name={TIER_NAME[tier.tier]}
          count={row.count(tier.count)}
          what={row.what}
          unit={tier.priceMicros !== null ? `${tier.count} × ${unitText(tier.priceMicros)}` : null}
          amount={data.priced ? money(tier.amountCents) : "—"}
        />
      )
    })
  const cita = line("cita")
  const packs = line("preguntas")
  const stored = line("almacenamiento")
  const elapsedDays = Math.min(
    Math.ceil((Date.now() - new Date(data.period.start).getTime()) / 86_400_000),
    Math.round((new Date(data.period.end).getTime() - new Date(data.period.start).getTime()) / 86_400_000),
  )
  const totalDays = Math.round((new Date(data.period.end).getTime() - new Date(data.period.start).getTime()) / 86_400_000)
  const lastDay = day(new Date(new Date(data.period.end).getTime() - 1).toISOString())
  const capCents = data.budget?.capCents ?? data.spendCapCents ?? null
  const spentCents = data.budget?.spentCents ?? data.overCreditCents
  const argos = data.argos
  const storage = data.storage
  const packPrice = argos?.packPriceMicros !== null && argos?.packPriceMicros !== undefined ? formatMicros(argos.packPriceMicros, currency) : null
  const after = data.budget?.reachedAt ? data.budget : null
  return (
    <section aria-labelledby="consumo" className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-1">
        <h2 id="consumo" className="text-base font-semibold">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">
          Del {day(data.period.start)} al {lastDay}; van {Math.max(elapsedDays, 0)} de {totalDays} días
          {data.discountBps > 0 ? ` · precios negociados con tu asesor: ${formatBps(data.discountBps)} menos en lo que se negocia` : ""}.
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
          <p className="text-sm text-muted-foreground">
            Se factura al cerrar tu mes, el {lastDay}: la cuota y lo que pase del crédito, más {data.tax?.label ?? "impuestos"}.
          </p>
        )}
      </div>

      {!data.priced ? (
        <p className="text-sm text-muted-foreground">
          Tu plan aún no tiene precios por acción: abajo ves cuántas hizo cada agente. Escríbele a soporte si esperabas verlos.
        </p>
      ) : null}

      <ul className="flex flex-col divide-y overflow-hidden rounded-lg border">
        <AgentHeader name={receptionName} about="se cobra según lo que pasó en la agenda" />
        {tierRows("conversacion")}
        <AgentHeader name={agentName("asistente_clinico", receptionName)} about="se cobra según lo que dejó hecho en cada atención" />
        {tierRows("consulta")}
        <AgentHeader name={agentName("administrador", receptionName)} tone="argos" />
        {cita ? (
          <ActionRow
            name="Citas recuperadas"
            count={`${cita.count} ${cita.count === 1 ? "paciente volvió" : "pacientes volvieron"}`}
            what="No tenían cita ni tratamiento en curso; Argos les escribió y vinieron"
            extra={
              <>
                {data.pendingRecoveries > 0 ? ` · ${data.pendingRecoveries} más esperan que el paciente asista` : ""}
                {data.priced && data.refunds?.count
                  ? ` · menos ${money(data.refunds.amountCents)} de ${data.refunds.count === 1 ? "la conversación ya cobrada que llevó a ella" : `${data.refunds.count} conversaciones ya cobradas que llevaron a ellas`}`
                  : ""}
              </>
            }
            unit={cita.priceMicros !== null ? `${cita.count} × ${unitText(cita.priceMicros)}` : null}
            amount={data.priced ? money(cita.amountCents) : "—"}
          />
        ) : null}
        {argos?.limited ? (
          <ActionRow
            name="Preguntas"
            count={`${argos.used} de ${argos.included + argos.added} ${argos.added ? "incluidas y sumadas" : "incluidas"}`}
            what={
              packs && packs.count > 0
                ? `Sumó ${packs.units ?? 0} con ${packs.count === 1 ? "un paquete" : `${packs.count} paquetes`}. Las que no pudo responder no cuentan`
                : "Las que no pudo responder no cuentan"
            }
            unit={packs && packs.count > 0 && packs.priceMicros !== null ? `${packs.count} × ${unitText(packs.priceMicros)}` : null}
            amount={money(packs?.amountCents ?? 0)}
          />
        ) : null}
        {storage && storage.gbPriceMicros !== null ? (
          <>
            <AgentHeader name="Almacenamiento" tone="muted" />
            <ActionRow
              name={storage.bytes === null ? "Aún sin medir" : `${gbText(storage.bytes)} GB`}
              count={`de ${storage.includedGb} GB incluidos`}
              what="Fotos, radiografías, tomografías y documentos"
              unit={stored && stored.count > 0 && stored.priceMicros !== null ? `${stored.units ?? 0} GB × ${unitText(stored.priceMicros)}` : null}
              amount={money(stored?.amountCents ?? 0)}
            />
          </>
        ) : null}
        {data.priced ? (
          <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 bg-muted/40 px-4 py-3">
            <div>
              <p className="text-sm">Subtotal, sin {data.tax?.label ?? "impuestos"}</p>
              <p className="text-xs text-muted-foreground">
                {data.creditCents > 0 && !trial ? `La cuota de ${money(data.creditCents)} ya va dentro: vuelve como crédito` : ""}
                {savings > 0 ? `${data.creditCents > 0 && !trial ? " · " : ""}a precio base serían ${money(data.baseSubtotalCents)}: ahorras ${money(savings)}` : ""}
              </p>
            </div>
            <p className="text-base font-semibold tabular-nums">{money(data.subtotalCents)}</p>
          </li>
        ) : null}
      </ul>

      {data.priced ? (
        <div className="grid gap-x-6 gap-y-5 rounded-lg border p-4 sm:grid-cols-2">
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
                  : `Se acabó el ${day(data.creditExhaustedAt)}. Desde entonces cada acción se cobra con su precio.`
                : trial
                  ? "Cuando se acabe, los agentes se pausan hasta que elijas tu plan."
                  : "Lo que pase del crédito se cobra por acción, con tu precio."
            }
          />
          {!trial && onChangeCap ? (
            <div className="flex flex-col gap-1.5">
              {capCents ? (
                <UsageMeter
                  label="Presupuesto del mes"
                  value={spentCents}
                  total={capCents}
                  warnAt={data.warnPercent / 100}
                  alarmAt={data.alarmPercent / 100}
                  valueText={`${money(spentCents)} de ${money(capCents)}`}
                  description={`Al llegar, ${receptionName} pasa todo al equipo, Clío deja de escuchar en las atenciones nuevas y Argos no escribe para recuperar. Lo que ya empezó se termina.`}
                />
              ) : (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium">Presupuesto del mes</p>
                  <p className="text-xs text-muted-foreground">Sin presupuesto: los agentes siguen atendiendo y cada acción se cobra con tu precio.</p>
                </div>
              )}
              <div>
                <Button variant="link" size="sm" className="h-auto px-0" onClick={onChangeCap}>
                  {capCents ? "Cambiar presupuesto" : "Poner un presupuesto"}
                </Button>
              </div>
            </div>
          ) : null}
          {argos?.limited ? (
            <div className="flex flex-col gap-2">
              <UsageMeter
                label="Preguntas a Argos"
                value={argos.used}
                total={argos.included + argos.added}
                warnAt={data.warnPercent / 100}
                alarmAt={data.alarmPercent / 100}
                valueText={`${argos.used} de ${argos.included + argos.added}`}
                description={
                  packPrice
                    ? argos.autoPack
                      ? `Al llegar a ${argos.included + argos.added}, Argos suma ${argos.packQuestions} más por ${packPrice} sin preguntar.`
                      : `Al llegar a ${argos.included + argos.added}, Argos te pregunta antes de sumar ${argos.packQuestions} más por ${packPrice}.`
                    : undefined
                }
              />
              {onAutoPack ? (
                <label className="flex items-center gap-2 text-xs">
                  <Switch checked={argos.autoPack} disabled={autoPackPending} onCheckedChange={(on: boolean) => onAutoPack(on)} aria-label="Sumar preguntas solas" />
                  Sumar {argos.packQuestions} solas al acabarse, sin preguntar
                </label>
              ) : null}
            </div>
          ) : null}
          {storage && storage.gbPriceMicros !== null ? (
            <UsageMeter
              label="Almacenamiento"
              value={storage.bytes ?? 0}
              total={storage.includedGb * 1024 ** 3}
              warnAt={data.warnPercent / 100}
              alarmAt={1}
              valueText={`${storage.bytes === null ? "0" : gbText(storage.bytes)} de ${storage.includedGb} GB`}
              description={`Desde el GB ${storage.includedGb + 1}, ${formatMicros(storage.gbPriceMicros, currency)} por GB al mes. Nunca dejamos de guardar.`}
            />
          ) : null}
          <div className="flex flex-wrap items-end justify-between gap-3 border-t pt-4 sm:col-span-2">
            {data.projectedCents !== null ? (
              <div className="flex flex-col gap-0.5">
                <p className="text-xs text-muted-foreground">A este ritmo, al cierre</p>
                <p className="text-xl font-semibold tabular-nums">{money(data.projectedCents)}</p>
                <p className="text-xs text-muted-foreground">Estimado con lo que va del mes; no es un cobro.</p>
              </div>
            ) : (
              <span />
            )}
            <Button variant="outline" size="sm" onClick={onShowActions}>
              Ver cada acción
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="outline" size="sm" onClick={onShowActions}>
            Ver cada acción
          </Button>
        </div>
      )}

      {after ? (
        <section aria-labelledby="tras-presupuesto" className="flex flex-col gap-2 rounded-lg border p-4">
          <h3 id="tras-presupuesto" className="text-sm font-semibold">
            Cobrado tras el presupuesto
          </h3>
          <p className="text-xs text-muted-foreground">
            Llegaste el {day(after.reachedAt as string)}. Son resultados de un trabajo ya hecho y se cobran aunque pasen el presupuesto.
          </p>
          <ul className="flex flex-col divide-y">
            {after.after.lines.map((item) => (
              <li key={`${item.kind}:${item.tier ?? ""}`} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                <span>{afterLineText(item, receptionName)}</span>
                <span className="font-semibold tabular-nums">{money(item.amountCents)}</span>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-4 py-2 text-sm">
              <span>
                Almacenamiento extra
                <span className="block text-xs text-muted-foreground">No cuenta para el presupuesto: guardar nunca detiene a un agente</span>
              </span>
              <span className="font-semibold tabular-nums">{money(after.storageCents)}</span>
            </li>
            <li className="flex items-baseline justify-between gap-4 py-2 text-sm font-semibold">
              <span>Total tras el presupuesto</span>
              <span className="tabular-nums">{money(after.after.amountCents + after.storageCents)}</span>
            </li>
          </ul>
        </section>
      ) : null}

      <p className="text-xs text-muted-foreground">
        WhatsApp lo cobra Meta directamente a tu clínica:{" "}
        <a href={META_ACCOUNT_URL} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
          revisa sus tarifas y tu facturación en Meta
        </a>
        .
      </p>
    </section>
  )
}

/** Una fila de «Cobrado tras el presupuesto», en palabras. */
function afterLineText(item: { kind: SaasActionKind; tier: SaasActionTier | null; count: number }, receptionName: string): string {
  const n = item.count
  if (item.kind === "conversacion" && item.tier === "agenda") return `${n} ${n === 1 ? "paciente vino" : "pacientes vinieron"} a la cita que reservó ${receptionName}`
  if (item.kind === "conversacion") return `${n} ${n === 1 ? "conversación que ya estaba abierta" : "conversaciones que ya estaban abiertas"} (${TIER_NAME[item.tier ?? "gestiona"]})`
  if (item.kind === "consulta") return `${n} ${n === 1 ? "atención que ya se estaba dictando" : "atenciones que ya se estaban dictando"} (${TIER_NAME[item.tier ?? "simple"]})`
  if (item.kind === "cita") return `${n} ${n === 1 ? "cita recuperada" : "citas recuperadas"}`
  return AGENT_OF[item.kind].what(n)
}
