/**
 * Reportes › Agente: lo que hizo el agente en el periodo, lo que pagaste por él
 * y lo cobrado en las citas que agendó, y cómo se respondió a quien escribió.
 * Lo pagado va en la moneda del plan de odentIA y lo cobrado en la de la
 * clínica, lado a lado y sin convertir; nunca se dice que el agente «ganó»
 * (decisión 5). Donde el cobro no factura (demo, prueba o sin plan) no se dice
 * «pagaste»: se dice lo mismo que Facturación. Mejor o peor se dice con
 * palabras y flecha, nunca solo con color.
 */
import { formatMoney } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import { ColumnChart, EmptyState, LoadingState, ShareBar, type SharePart } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { ArrowRight, Bot } from "lucide-react"
import { useId } from "react"
import { channelLabel } from "../../lib/channels"
import { usePermission } from "../../lib/crm"
import { PLAN_PATH } from "../../lib/billing"
import { QueryErrorState } from "../../lib/query-error"
import {
  absoluteChange,
  type AgentBilling,
  bucketLabel,
  bucketShort,
  durationLabel,
  fetchReport,
  GRAIN_WORD,
  POINTS,
  previousPhrase,
  rateOf,
  type ReportAgent,
  reportKey,
  type ReportListKey,
  type ReportQuery,
  spanLabel,
} from "../../lib/reports"
import { ReceptionOffNotice } from "../agent/reception-off-notice"
import { ChangeLine, during, EmptyLine, FooterButton, ReportCard, SummaryFigure, travel, WHOLE_CLINIC } from "./report-parts"


/**
 * Cada línea de lo pagado con las palabras de Facturación: quién lo hizo y cuándo cuenta una. La
 * conversación que se cobra (una por persona cada 24 horas) no es la de «Conversaciones que atendió».
 */
const LINE: Record<AgentBilling["lines"][number]["kind"], { agent: string; what: (count: number) => string; rule: string }> = {
  conversacion: {
    agent: "Recepción",
    what: (n) => `${n} ${n === 1 ? "conversación atendida" : "conversaciones atendidas"}`,
    rule: "Una por persona cada 24 horas, aunque escriba diez mensajes o cambie de canal",
  },
  consulta: {
    agent: "Asistente clínico",
    what: (n) => `${n} ${n === 1 ? "consulta dictada y confirmada" : "consultas dictadas y confirmadas"}`,
    rule: "Una por atención, sin importar cuántos minutos se dicten",
  },
  cita: {
    agent: "Administrador",
    what: (n) => `${n} ${n === 1 ? "cita recuperada" : "citas recuperadas"}`,
    rule: "Cuando un paciente vuelve tras un seguimiento y asiste",
  },
}

/** Por qué no se cobra, con las palabras de Facturación. */
function notChargedText(paid: AgentBilling, period: string): string | null {
  if (paid.charging !== "no") return null
  if (paid.notCharged === "demo") return "Cuenta demo: se cuenta lo que hacen los agentes, pero no se cobra."
  if (paid.notCharged === "prueba") return "Se descuenta del saldo de regalo de la prueba: no se cobra."
  return `${upperFirst(during(period))} no se cobra: así sería tu factura.`
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Tres canales con color como mucho; los demás juntos, en gris. */
const CHANNEL_TONES = ["series-1", "series-2", "series-3"] as const

export function AgentTab({ query, onOpenList }: { query: ReportQuery; onOpenList: (list: ReportListKey) => void }) {
  const navigate = useNavigate()
  const canAgent = usePermission("agent.read")
  const report = useQuery({ queryKey: reportKey("agent", query), queryFn: () => fetchReport<ReportAgent>("agent", query), retry: false })

  if (report.isPending) return <LoadingState />
  if (report.isError)
    return <QueryErrorState error={report.error} onRetry={() => void report.refetch()} notFound="La sede elegida ya no está disponible. Elige otra sede." />

  const data = report.data.data
  const { locale } = data
  const period = spanLabel(data.period, locale)
  const phrase = previousPhrase(data, locale)
  const twelve = "en los últimos 12 meses"
  const partialMonth = data.months[data.months.length - 1]?.partial ?? false
  const whole = (key: string): string | undefined => (data.wholeClinic.includes(key) ? WHOLE_CLINIC : undefined)
  const change = (current: number, previous: number) => (current === 0 && previous === 0 ? undefined : absoluteChange(current, previous, phrase, locale))

  const { conversations, booked, recovered, dictated, responses } = data
  const nothing =
    conversations.current.attended === 0 &&
    booked.current.booked === 0 &&
    recovered.current === 0 &&
    dictated.current === 0 &&
    responses.current.conversations === 0 &&
    (data.paid?.totalCents ?? 0) === 0
  if (nothing) {
    return (
      <EmptyState
        icon={Bot}
        title={`El agente no hizo nada ${during(period)}`}
        description="Cuando Recepción atienda conversaciones o agende citas, o un odontólogo confirme una consulta dictada, aquí verás lo que hizo y lo cobrado en sus citas."
        actionLabel={canAgent ? "Ver el agente" : undefined}
        onAction={() => void navigate({ to: "/agent" })}
      />
    )
  }

  const alone = rateOf(conversations.current.alone, conversations.current.attended)

  // Las columnas siguen al ancho de la pestaña (`@container`), no al de la ventana: con una lista abierta al lado, caben menos.
  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      <section aria-label="Lo que hizo el agente" className="grid min-w-0 gap-3.5 @xl:grid-cols-2 @5xl:grid-cols-4">
        <SummaryFigure
          title="Conversaciones que atendió"
          note={whole("conversations")}
          value={conversations.current.attended}
          spark={conversations.months}
          sparkPartial={partialMonth}
          sparkLabel={`Conversaciones que atendió ${twelve}: ${travel(conversations.months, String)}`}
          change={change(conversations.current.attended, conversations.previous.attended)}
          better="up"
          detail={alone === null ? undefined : `${conversations.current.alone} sin el equipo · ${alone} %`}
        />
        <SummaryFigure
          title="Citas que agendó"
          value={booked.current.booked}
          spark={booked.months}
          sparkPartial={partialMonth}
          sparkLabel={`Citas que agendó ${twelve}: ${travel(booked.months, String)}`}
          change={change(booked.current.booked, booked.previous.booked)}
          better="up"
          detail={booked.current.booked > 0 ? `${booked.current.attended} ya ${booked.current.attended === 1 ? "vino" : "vinieron"}` : undefined}
          footer={booked.current.booked > 0 ? <FooterButton onClick={() => onOpenList("agent_booked")}>Ver cuáles</FooterButton> : undefined}
        />
        <SummaryFigure
          title="Citas recuperadas"
          value={recovered.current}
          spark={recovered.months}
          sparkPartial={partialMonth}
          sparkLabel={`Citas recuperadas ${twelve}: ${travel(recovered.months, String)}`}
          change={change(recovered.current, recovered.previous)}
          better="up"
          detail="Volvieron tras un mensaje del Administrador"
        />
        <SummaryFigure
          title="Consultas dictadas"
          value={dictated.current}
          spark={dictated.months}
          sparkPartial={partialMonth}
          sparkLabel={`Consultas dictadas ${twelve}: ${travel(dictated.months, String)}`}
          change={change(dictated.current, dictated.previous)}
          better="up"
          detail="Confirmadas por el odontólogo"
        />
      </section>

      <PaidAndCollected data={data} period={period} />

      <div className="grid min-w-0 items-start gap-4 @5xl:grid-cols-[1.3fr_1fr]">
        <BookedChart data={data} />
        <Responses data={data} period={period} phrase={phrase} onOpenList={onOpenList} />
      </div>
    </div>
  )
}

/** Una línea de cuenta: el concepto a la izquierda, con su pista debajo si la tiene, y el importe a la derecha. */
function AccountLine({ label, hint, amount, muted }: { label: string; hint?: string; amount: string; muted?: boolean }) {
  return (
    <div className={muted ? "contents text-muted-foreground" : "contents"}>
      <dt className="flex min-w-0 flex-col">
        <span>{label}</span>
        {hint ? <span className="text-[13px] text-muted-foreground">{hint}</span> : null}
      </dt>
      <dd className="text-right font-semibold tabular-nums">{amount}</dd>
    </div>
  )
}

/** Lo pagado a odentIA por el agente y lo cobrado en sus citas, lado a lado, cada uno en su moneda. */
function PaidAndCollected({ data, period }: { data: ReportAgent; period: string }) {
  const id = useId()
  const { locale, paid, collected } = data
  const title = !paid
    ? "Lo cobrado en las citas del agente"
    : paid.charging === "no"
      ? "Lo que se contó por el agente y lo cobrado en sus citas"
      : "Lo que pagaste por el agente y lo cobrado en sus citas"
  return (
    <section aria-labelledby={id} className="elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-[18px] sm:p-[22px]">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 id={id} className="text-[17px] font-extrabold tracking-tight">
          {title}
        </h3>
        {paid ? <p className="text-sm text-muted-foreground">Con las mismas cuentas de tu factura de odentIA. Cada lado en su moneda: no convertimos.</p> : null}
      </div>
      <div className="grid min-w-0 gap-4 @3xl:grid-cols-2">
        {paid ? (
          <Paid paid={paid} period={period} running={data.period.partial} locale={locale} timezone={data.timezone} wholeClinic={data.wholeClinic.includes("paid")} />
        ) : null}
        <Collected collected={collected} period={period} locale={locale} />
      </div>
    </section>
  )
}

function Paid({
  paid,
  period,
  running,
  locale,
  timezone,
  wholeClinic,
}: {
  paid: AgentBilling
  period: string
  /** El periodo llega hasta hoy: lo del mes que corre aún no se cobra. */
  running: boolean
  locale: string
  timezone: string
  wholeClinic: boolean
}) {
  const charged = paid.charging !== "no"
  // Sin la moneda del plan no hay importe: nunca se supone una.
  const currency = paid.currency
  const money = (cents: number): string => (currency ? formatMoney(cents, currency, locale) : "—")
  const unit = (micros: number): string =>
    currency
      ? new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(micros / 1_000_000)
      : ""
  const lines = paid.lines.filter((line) => line.count > 0)
  const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
  const notice = notChargedText(paid, period)
  const notes: string[] = []
  if (!currency) notes.push("Tu plan aún no tiene precios por acción: no hay importe que mostrar.")
  if (charged && currency) {
    const closedOver = paid.overCents - paid.pendingCents
    const apart = [
      closedOver > 0 ? `${money(closedOver)} se cobraron aparte` : null,
      paid.pendingCents > 0 ? `${money(paid.pendingCents)} se cobrarán al cerrar el mes` : null,
    ]
      .filter(Boolean)
      .join(" y ")
    if (paid.totalCents > 0 && paid.overCents === 0)
      notes.push(running ? "Hasta hoy todo lo cubre el crédito del plan: nada aparte por el agente." : "Todo lo cubrió el crédito del plan: no pagaste nada aparte por el agente.")
    else if (paid.overCents > 0)
      notes.push(paid.coveredCents > 0 ? `El crédito del plan ${running ? "cubre" : "cubrió"} ${money(paid.coveredCents)}; ${apart}.` : `${upperFirst(apart)}, aparte del crédito del plan.`)
    // El crédito se renueva el día en que empezó el plan: un periodo que toca dos meses del plan trae dos créditos,
    // y uno que empieza a mitad de un mes del plan puede encontrarlo ya usado. Se dice, para que lo cubierto se entienda.
    const credit = paid.planCreditCents === null ? null : money(paid.planCreditCents)
    const day = paid.planStart ? new Intl.DateTimeFormat(locale, { day: "numeric", timeZone: timezone }).format(new Date(paid.planStart)) : null
    if (paid.totalCents > 0 && paid.planMonths > 1)
      notes.push(`${upperFirst(during(period))} corren ${paid.planMonths} meses de tu plan${day ? ` (empiezan el día ${day})` : ""}, cada uno con su crédito${credit ? ` de ${credit}` : ""}.`)
    else if (paid.totalCents > 0 && paid.planMonths === 1)
      notes.push(`Tu plan trae ${credit ? `${credit} de crédito` : "su crédito"} por mes${day ? `, contado desde el día ${day}` : ""}.`)
    if (paid.uncharged.count > 0)
      notes.push(`Además, ${plural(paid.uncharged.count, "acción", "acciones")} por ${money(paid.uncharged.amountCents)} se ${paid.uncharged.count === 1 ? "contó" : "contaron"} en un tramo que no se cobra.`)
  }
  if (paid.trial.count > 0) notes.push(`${plural(paid.trial.count, "acción salió", "acciones salieron")} del saldo de prueba, de regalo: ${money(paid.trial.amountCents)}.`)
  if (paid.unpriced > 0) notes.push(`${plural(paid.unpriced, "acción se contó", "acciones se contaron")} sin precio: tu plan aún no lo tenía.`)
  if (charged && paid.tax && paid.totalCents > 0) notes.push(`Sin el ${paid.tax.label}, que tu factura suma aparte.`)
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-xl border bg-muted/40 px-4 py-4 sm:px-5 sm:py-[18px]">
      <span className="text-[13px] font-bold text-muted-foreground">
        {charged ? "Lo que pagaste por el agente" : "Lo que se contó por el agente"} {during(period)}
        {wholeClinic ? <span className="font-medium"> · {WHOLE_CLINIC}</span> : null}
      </span>
      <span className="text-[30px] leading-9 font-extrabold tracking-tight tabular-nums">{money(paid.totalCents)}</span>
      {notice ? <p className="rounded-lg bg-muted px-3 py-2 text-sm">{notice}</p> : null}
      {lines.length > 0 ? (
        <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
          {lines.map((line) => (
            <AccountLine
              key={line.kind}
              label={`${LINE[line.kind].agent}: ${LINE[line.kind].what(line.count)}`}
              hint={`${LINE[line.kind].rule}${line.unitMicros === null || !currency ? "" : ` · ${unit(line.unitMicros)} cada una`}`}
              amount={money(line.amountCents)}
            />
          ))}
          {paid.refunds.count > 0 ? (
            <AccountLine
              muted
              label={`Devolución de ${paid.refunds.count === 1 ? "la conversación ya cobrada" : `${paid.refunds.count} conversaciones ya cobradas`} de citas recuperadas`}
              amount={`−${money(paid.refunds.amountCents)}`}
            />
          ) : null}
        </dl>
      ) : (
        <EmptyLine>{upperFirst(during(period))} el agente no hizo nada que se cobre.</EmptyLine>
      )}
      {notes.length > 0 ? <p className="text-[13px] text-muted-foreground">{notes.join(" ")}</p> : null}
      <Link
        to={PLAN_PATH}
        className="inline-flex min-h-11 items-center gap-1 self-start text-[13px] font-bold text-primary-soft-foreground underline-offset-2 hover:underline sm:min-h-8"
      >
        Ver en Plan y pagos
        <ArrowRight aria-hidden className="size-3.5" />
      </Link>
    </div>
  )
}

function Collected({ collected, period, locale }: { collected: ReportAgent["collected"]; period: string; locale: string }) {
  const money = (cents: number, currency = collected.currency): string => formatMoney(cents, currency, locale)
  const total = collected.booked.cents + collected.recovered.cents
  const visits = collected.booked.visits + collected.recovered.visits
  const others = collected.recovered.visits > 0
  const bookedLine =
    collected.booked.visits === 1
      ? `En ${others ? "otra" : "la"} cita que agendó y ya vino`
      : `En ${others ? "otras " : ""}${collected.booked.visits} citas que agendó y ya vinieron`
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-xl bg-primary-soft px-4 py-4 sm:px-5 sm:py-[18px] text-primary-soft-foreground">
      <span className="text-[13px] font-bold">Cobrado en citas que agendó el agente</span>
      <span className="text-[30px] leading-9 font-extrabold tracking-tight tabular-nums">{money(total)}</span>
      {visits > 0 ? (
        <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
          {others ? (
            <AccountLine
              label={collected.recovered.visits === 1 ? "En la cita recuperada" : `En las ${collected.recovered.visits} citas recuperadas`}
              amount={money(collected.recovered.cents)}
            />
          ) : null}
          {collected.booked.visits > 0 ? <AccountLine label={bookedLine} amount={money(collected.booked.cents)} /> : null}
        </dl>
      ) : (
        <EmptyLine>Ninguna cita que agendó el agente {during(period)} vino todavía.</EmptyLine>
      )}
      {collected.others.length > 0 ? (
        <p className="text-[13px]">Además, {collected.others.map((item) => money(item.cents, item.currency)).join(" y ")} en otra moneda.</p>
      ) : null}
      <p className="text-[13px]">Es lo que esos pacientes pagaron hasta hoy por esas citas, no lo que el agente «ganó»: quizá algunos habrían venido igual.</p>
    </div>
  )
}

/** Las citas que agendó el agente por tramo, con su parte de todas las citas reservadas. */
function BookedChart({ data }: { data: ReportAgent }) {
  const { locale } = data
  const grain = data.period.grain
  const title = `Citas que agendó el agente, ${GRAIN_WORD[grain]}`
  if (data.chart.length < 2) return null
  const last = data.chart[data.chart.length - 1]
  // Antes de su primera respuesta, cita o acción contada el agente no trabajaba: esos tramos van vacíos.
  const firstOn = data.chart.findIndex((bucket) => bucket.booked !== null)
  const share = last && last.booked !== null ? rateOf(last.booked, last.all) : null
  const lastName = last ? bucketLabel(last, grain, locale) : ""
  const insight = [
    firstOn > 0 ? `Empezó a trabajar en ${bucketLabel(data.chart[firstOn] as (typeof data.chart)[number], grain, locale).toLocaleLowerCase(locale)}.` : null,
    share !== null ? `${lastName}${last?.partial ? ", hasta hoy" : ""}: el ${share} % de todas las citas que se reservaron.` : null,
  ]
    .filter(Boolean)
    .join(" ")
  return (
    <ReportCard title={title}>
      {insight ? <p className="-mt-2 text-sm text-muted-foreground">{insight}</p> : null}
      <ColumnChart
        title={title}
        tableHeading={grain === "month" ? "Mes" : grain === "week" ? "Semana" : "Día"}
        categories={data.chart.map((bucket) => ({ key: bucket.key, label: bucketLabel(bucket, grain, locale), short: bucketShort(bucket, grain, locale), partial: bucket.partial }))}
        bars={[{ key: "agendo", label: "Agendó el agente", tone: "series-1", values: data.chart.map((bucket) => bucket.booked) }]}
        format={String}
        detail={(index) => {
          const bucket = data.chart[index]
          if (!bucket) return null
          const part = bucket.booked === null ? null : rateOf(bucket.booked, bucket.all)
          return (
            <>
              <strong className="text-[13px]">
                {bucketLabel(bucket, grain, locale)}
                {bucket.partial ? ", hasta hoy" : ""}
              </strong>
              <span>{bucket.booked === null ? "El agente todavía no trabajaba" : `Agendó ${bucket.booked} de ${bucket.all} citas`}</span>
              {part !== null ? <span className="opacity-80">{part} % de todas</span> : null}
            </>
          )
        }}
      />
    </ReportCard>
  )
}

/** Cómo se respondió a quien escribió por primera vez: quién primero, a qué velocidad y por qué canal. */
function Responses({ data, period, phrase, onOpenList }: { data: ReportAgent; period: string; phrase: string; onOpenList: (list: ReportListKey) => void }) {
  const { locale } = data
  const { current, previous, handedOff, byChannel } = data.responses
  const waiting = current.conversations - current.responded
  const respondedRate = rateOf(current.responded, current.conversations)
  const previousRate = rateOf(previous.responded, previous.conversations)
  const first: SharePart[] = [
    { key: "agent", label: "El agente", value: current.byAgent, tone: "series-1" },
    { key: "team", label: "El equipo", value: current.byTeam, tone: "series-2" },
    ...(waiting > 0 ? [{ key: "none", label: "Nadie todavía", value: waiting, tone: "muted" as const }] : []),
  ]
  const speeds = [
    current.agentMedianSeconds !== null ? `del agente, en menos de ${durationLabel(current.agentMedianSeconds)}` : null,
    current.teamMedianSeconds !== null ? `del equipo, en menos de ${durationLabel(current.teamMedianSeconds)}` : null,
  ].filter(Boolean)
  const top = byChannel.slice(0, CHANNEL_TONES.length)
  const rest = byChannel.slice(CHANNEL_TONES.length).reduce((sum, row) => sum + row.count, 0)
  const channels: SharePart[] = [
    ...top.map((row, index) => ({ key: row.channel ?? "sin-canal", label: row.channel ? channelLabel(row.channel) : "Canal retirado", value: row.count, tone: CHANNEL_TONES[index] ?? "muted" })),
    ...(rest > 0 ? [{ key: "otros", label: "Otros canales", value: rest, tone: "muted" as const }] : []),
  ]
  return (
    <ReportCard title="Cómo respondimos a quien escribió" note={data.wholeClinic.includes("responses") ? WHOLE_CLINIC : undefined}>
      {current.conversations === 0 ? (
        <EmptyLine>Nadie escribió por primera vez {during(period)}.</EmptyLine>
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm">
              {current.conversations} {current.conversations === 1 ? "persona escribió" : "personas escribieron"} por primera vez; {respondedRate} % recibió respuesta.
            </p>
            <ChangeLine change={absoluteChange(respondedRate ?? 0, previousRate, phrase, locale, POINTS)} better="up" />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <h4 className="text-[13px] font-bold text-muted-foreground">Quién respondió primero</h4>
            <ShareBar title="Quién respondió primero" parts={first} format={String} />
            {speeds.length > 0 ? <p className="text-[13px] text-muted-foreground">La mitad recibió la primera respuesta {speeds.join("; ")}.</p> : null}
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-3">
            {/* De esas mismas personas: nunca más que las que escribieron. */}
            <div className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-muted/50 px-3.5 py-3">
              <span className="text-[13px] font-bold text-muted-foreground">Pasaron al equipo</span>
              <strong className="text-[22px] tabular-nums">{handedOff}</strong>
              {handedOff > 0 ? (
                <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 text-[13px] font-bold sm:min-h-8" onClick={() => onOpenList("agent_handoffs")}>
                  Ver cuáles
                </Button>
              ) : null}
            </div>
            <div className={waiting > 0 ? "flex min-w-0 flex-col gap-0.5 rounded-xl bg-warning-soft px-3.5 py-3 text-warning" : "flex min-w-0 flex-col gap-0.5 rounded-xl bg-muted/50 px-3.5 py-3"}>
              <span className={waiting > 0 ? "text-[13px] font-bold" : "text-[13px] font-bold text-muted-foreground"}>Siguen sin respuesta</span>
              <strong className="text-[22px] text-foreground tabular-nums">{waiting}</strong>
              {waiting > 0 ? (
                <Link to="/inbox" search={{ conversation: undefined }} className="inline-flex min-h-11 items-center self-start text-[13px] font-bold underline sm:min-h-8">
                  Ver en la Bandeja
                </Link>
              ) : null}
            </div>
          </div>
          {/* Con gente sin respuesta, si Recepción está apagada se dice aquí, con su salida. */}
          {waiting > 0 ? <ReceptionOffNotice /> : null}
          <div className="flex min-w-0 flex-col gap-2">
            <h4 className="text-[13px] font-bold text-muted-foreground">Por dónde escribieron</h4>
            <ShareBar title="Por dónde escribieron" parts={channels} format={String} />
          </div>
        </>
      )}
    </ReportCard>
  )
}
