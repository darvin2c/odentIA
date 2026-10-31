/**
 * Reportes › Pacientes: quiénes nos buscaron por primera vez y hasta dónde
 * llegaron (el embudo sigue a las mismas personas, decisión 2), por dónde nos
 * buscaron, cómo nos conocieron (decisión 3) y si vuelven. Cada paso abre su
 * lista al lado; dónde se caen más se dice con palabras, no solo con color.
 */
import { REFERRAL_KIND_LABELS, REFERRAL_KINDS, type ReferralKind } from "@odentia/clinical"
import { Button, cn } from "@odentia/ui"
import { BarList, type BarListRow, EmptyState, SkeletonRegion, Sparkline } from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { AlertTriangle } from "lucide-react"
import { type ReactNode, useId } from "react"
import { apiFetch } from "../../lib/api"
import { monthName } from "../../lib/commissions"
import { type Pipeline, usePermission } from "../../lib/crm"
import { QueryErrorState } from "../../lib/query-error"
import {
  absoluteChange,
  fetchPatientsReport,
  type FunnelCounts,
  type FunnelStep,
  firstContactChannel,
  POINTS,
  previousPhrase,
  rateOf,
  type ReportFunnel,
  type ReportHead,
  reportKey,
  type ReportListKey,
  type ReportPatients,
  type ReportQuery,
  spanLabel,
} from "../../lib/reports"
import { FunnelBodySkeleton, PatientsTabSkeleton } from "../skeletons/reports"
import { during, EmptyLine, Figure, ReportCard, unlessEmpty, WHOLE_CLINIC, ReportBody } from "./report-parts"

// --- El embudo, para la pestaña y para el Resumen ---------------------------------------

/** El paso de Oportunidades al que corresponde cada uno (el nombre lo pone la clínica). */
const STEP_MOMENT: Partial<Record<FunnelStep, "evaluacion_agendada" | "presupuesto_enviado">> = {
  booked: "evaluacion_agendada",
  budget: "presupuesto_enviado",
}
const DEFAULT_STAGE_NAMES = { evaluacion_agendada: "Evaluación agendada", presupuesto_enviado: "Presupuesto enviado" }

/** Lo que cuenta cada paso; a los que son un paso de Oportunidades `funnelRows` les añade el nombre que le dio la clínica. */
const STEP_COPY: Record<FunnelStep, { label: string; short: string; hint: string }> = {
  sought: { label: "Nos buscaron", short: "Nos buscaron", hint: "Primera conversación o registro" },
  booked: { label: "Agendaron", short: "Agendaron", hint: "Una cita sin cancelar" },
  came: { label: "Vinieron", short: "Vinieron", hint: "Una cita atendida o una atención firmada" },
  budget: { label: "Recibieron presupuesto", short: "Presupuesto", hint: "Presentado" },
  accepted: { label: "Aceptaron", short: "Aceptaron", hint: "Del todo o en parte · como «Ganada» en Oportunidades" },
  paid: { label: "Pagaron algo", short: "Pagaron algo", hint: "Aceptaron y pagaron algo" },
}

/** Sin presupuesto que aceptar (latidIA), pagar viene después de venir: la consulta cobrada. */
function paysAfterComing(steps: readonly FunnelStep[]): boolean {
  return !steps.includes("accepted")
}

function stepCopy(step: FunnelStep, steps: readonly FunnelStep[]): { label: string; short: string; hint: string } {
  if (step === "paid" && paysAfterComing(steps)) return { ...STEP_COPY.paid, hint: "Vinieron y pagaron algo" }
  return STEP_COPY[step]
}

/** La lista de quienes llegaron a cada paso y la de quienes se cayeron antes de él. */
const REACHED_LIST: Record<FunnelStep, ReportListKey> = {
  sought: "funnel_sought",
  booked: "funnel_booked",
  came: "funnel_came",
  budget: "funnel_budget",
  accepted: "funnel_accepted",
  paid: "funnel_paid",
}
const LOST_LIST: Partial<Record<FunnelStep, ReportListKey>> = {
  booked: "funnel_lost_booked",
  came: "funnel_lost_came",
  budget: "funnel_lost_budget",
  accepted: "funnel_lost_accepted",
  paid: "funnel_lost_paid",
}

/** «3 días», con el plazo que entrega el servidor. */
function days(count: number): string {
  return count === 1 ? "1 día" : `${count} días`
}

/** Quiénes se cayeron antes de un paso, dicho con palabras. */
function lostWords(step: FunnelStep, count: number, open: boolean, steps: readonly FunnelStep[]): string {
  const one = count === 1
  if (step === "booked") return one ? "1 no agendó" : `${count} no agendaron`
  // Quien canceló sin agendar otra ya no agendó: aquí quedan quienes faltaron o aún esperan su cita.
  if (step === "came") {
    if (open) return one ? "1 aún no viene o faltó" : `${count} aún no vienen o faltaron`
    return one ? "1 no vino" : `${count} no vinieron`
  }
  if (step === "budget") return one ? "1 vino y no recibió presupuesto" : `${count} vinieron y no recibieron presupuesto`
  if (step === "accepted") return one ? "1 aún no responde o lo rechazó" : `${count} aún no responden o lo rechazaron`
  if (paysAfterComing(steps)) return one ? "1 vino y aún no paga" : `${count} vinieron y aún no pagan`
  return one ? "1 aceptó y aún no paga" : `${count} aceptaron y aún no pagan`
}

/** El paso donde más personas se cayeron (el que no alcanzaron); nulo si nadie se cayó. */
function biggestDrop(counts: FunnelCounts, steps: readonly FunnelStep[]): FunnelStep | null {
  let found: FunnelStep | null = null
  let most = 0
  steps.forEach((step, index) => {
    if (index === 0) return
    const lost = counts[steps[index - 1] as FunnelStep] - counts[step]
    if (lost > most) {
      most = lost
      found = step
    }
  })
  return found
}

function previousCount(counts: FunnelCounts, step: FunnelStep, steps: readonly FunnelStep[]): number {
  const index = steps.indexOf(step)
  return index === 0 ? counts[step] : counts[steps[index - 1] as FunnelStep]
}

/** El periodo anterior en una palabra, para «· agosto 50 %»; un rango, «antes». */
function previousWord(head: Pick<ReportHead, "previous">, locale: string): string {
  const { previous } = head
  if (previous.days || previous.from.year !== previous.to.year || previous.from.month !== previous.to.month) return "antes"
  return monthName(previous.from.month, locale).toLocaleLowerCase(locale)
}

/** «Septiembre sigue abierto», «Este periodo sigue abierto». */
function openWords(head: Pick<ReportHead, "period">, locale: string): string {
  const { period } = head
  if (period.days || period.from.year !== period.to.year || period.from.month !== period.to.month) return "Este periodo sigue abierto"
  return `${monthName(period.from.month, locale)} sigue abierto`
}

/** Los nombres que la clínica dio a los pasos de Oportunidades; sin permiso para verlos, los de siempre. */
function useStageNames(): Record<"evaluacion_agendada" | "presupuesto_enviado", string> {
  const canCrm = usePermission("crm.read")
  const pipelines = useQuery({ queryKey: ["pipelines"], queryFn: () => apiFetch<{ data: Pipeline[] }>("/api/pipelines"), enabled: canCrm, retry: false })
  const list = pipelines.data?.data ?? []
  const stages = (list.find((pipeline) => pipeline.isDefault) ?? list[0])?.stages ?? []
  const named = (moment: "evaluacion_agendada" | "presupuesto_enviado"): string =>
    stages.find((stage) => stage.moment === moment)?.name ?? DEFAULT_STAGE_NAMES[moment]
  return { evaluacion_agendada: named("evaluacion_agendada"), presupuesto_enviado: named("presupuesto_enviado") }
}

function funnelRows(
  funnel: { steps: FunnelStep[]; current: FunnelCounts; previous: FunnelCounts },
  locale: string,
  head: Pick<ReportHead, "previous">,
  stageNames: Record<"evaluacion_agendada" | "presupuesto_enviado", string>,
  compact: boolean,
): BarListRow[] {
  const { steps } = funnel
  const drop = biggestDrop(funnel.current, steps)
  const before = previousWord(head, locale)
  return steps.map((step, index) => {
    const copy = stepCopy(step, steps)
    const moment = STEP_MOMENT[step]
    const rate = index === 0 ? null : rateOf(funnel.current[step], previousCount(funnel.current, step, steps))
    const previousRate = index === 0 ? null : rateOf(funnel.previous[step], previousCount(funnel.previous, step, steps))
    const note =
      rate === null ? undefined : compact || previousRate === null ? `${rate} %` : `${rate} % · ${before} ${previousRate} %`
    return {
      key: step,
      label: compact ? copy.short : copy.label,
      hint: compact ? undefined : moment ? `${copy.hint} · como «${stageNames[moment]}» en Oportunidades` : copy.hint,
      value: funnel.current[step],
      valueText: String(funnel.current[step]),
      note,
      attention: step === drop,
    }
  })
}

/** Aquí se caen más: el paso, cuántos y, si hay con qué comparar, cuánto pasaba antes. */
function DropCallout({
  step,
  funnel,
  head,
  locale,
  compact,
  onOpenList,
}: {
  step: FunnelStep
  funnel: { steps: FunnelStep[]; current: FunnelCounts; previous: FunnelCounts; open: boolean }
  head: Pick<ReportHead, "previous">
  locale: string
  compact: boolean
  onOpenList: (list: ReportListKey) => void
}) {
  const from = previousCount(funnel.current, step, funnel.steps)
  const lost = from - funnel.current[step]
  const previousRate = rateOf(funnel.previous[step], previousCount(funnel.previous, step, funnel.steps))
  const list = LOST_LIST[step]
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-warning", compact ? "" : "my-1 sm:ml-[14.25rem]")}>
      <AlertTriangle aria-hidden className="size-4 shrink-0" strokeWidth={2.25} />
      <span className="min-w-0 flex-1">
        <strong>Aquí se caen más:</strong>{" "}
        {compact ? `${lost} de cada ${funnel.current.sought} ${lostWords(step, lost, funnel.open, funnel.steps).replace(/^\d+ /, "")}` : lostWords(step, lost, funnel.open, funnel.steps)}
        {!compact && previousRate !== null ? ` · en ${previousWord(head, locale)} pasaba el ${previousRate} %` : ""}
      </span>
      {list ? (
        <Button type="button" variant="link" className="h-auto min-h-11 p-0 text-[13px] font-bold text-warning sm:min-h-6" onClick={() => onOpenList(list)}>
          {compact ? "Ver quiénes" : `Ver los ${lost}`}
        </Button>
      ) : null}
    </div>
  )
}

/** Resumen › «Dónde se caen los pacientes»: el embudo corto, dónde se caen más y el enlace a la pestaña. */
export function FunnelCard({ query, onOpenList }: { query: ReportQuery; onOpenList: (list: ReportListKey) => void }) {
  const report = useQuery({ queryKey: reportKey("funnel", query), queryFn: () => fetchPatientsReport<ReportFunnel>("funnel", query), placeholderData: keepPreviousData, retry: false })
  const stageNames = useStageNames()
  const id = useId()
  const header = (
    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 id={id} className="font-semibold">
        Dónde se caen los pacientes
      </h3>
      <Link
        to="/reports"
        search={(prev) => ({ ...prev, tab: "pacientes", lista: undefined })}
        className="inline-flex min-h-11 items-center text-[13px] font-bold text-primary-soft-foreground underline-offset-2 hover:underline sm:min-h-6"
      >
        Ver el embudo
      </Link>
    </div>
  )
  const card = (children: ReactNode) => (
    <section aria-labelledby={id} aria-busy={report.isPlaceholderData || undefined} className={cn("elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-[18px] transition-opacity", report.isPlaceholderData && "opacity-60")}>
      {header}
      {children}
    </section>
  )
  if (report.isPending)
    return card(
      <SkeletonRegion message="Cargando el embudo…" className="flex min-w-0 flex-col gap-3">
        <FunnelBodySkeleton />
      </SkeletonRegion>,
    )
  if (report.isError) return card(<QueryErrorState error={report.error} onRetry={() => void report.refetch()} />)
  const data = report.data.data
  const { funnel, locale } = data
  const period = spanLabel(data.period, locale)
  if (funnel.current.sought === 0) return card(<EmptyLine>Nadie nos buscó por primera vez en {period}.</EmptyLine>)
  const drop = biggestDrop(funnel.current, funnel.steps)
  return card(
    <>
      <p className="-mt-1.5 text-sm text-muted-foreground">
        {funnel.current.sought === 1 ? "La persona que nos buscó" : `Las ${funnel.current.sought} personas que nos buscaron`} por primera vez en {period}, y hasta dónde
        llegaron.{data.wholeClinic.includes("funnel") ? ` ${WHOLE_CLINIC}.` : ""}
      </p>
      <BarList
        title={`Embudo de ${period}`}
        size="sm"
        rows={funnelRows(funnel, locale, data, stageNames, true)}
        onSelect={(index) => onOpenList(REACHED_LIST[funnel.steps[index] as FunnelStep])}
        selectLabel="Ver quiénes"
        table={{ label: "Paso", value: "Personas", note: "Del paso anterior" }}
      />
      {drop ? <DropCallout step={drop} funnel={funnel} head={data} locale={locale} compact onOpenList={onOpenList} /> : null}
    </>,
  )
}

// --- La pestaña -------------------------------------------------------------------------

function FooterButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 text-[13px] font-bold sm:min-h-8" onClick={onClick}>
      {children}
    </Button>
  )
}

export function PatientsTab({ query, onOpenList, advice }: { query: ReportQuery; onOpenList: (list: ReportListKey) => void; advice?: ReactNode }) {
  const navigate = useNavigate()
  const report = useQuery({ queryKey: reportKey("patients", query), queryFn: () => fetchPatientsReport<ReportPatients>("patients", query), placeholderData: keepPreviousData, retry: false })
  const stageNames = useStageNames()

  if (report.isPending)
    return (
      <SkeletonRegion message="Cargando las cifras…">
        <PatientsTabSkeleton />
      </SkeletonRegion>
    )
  if (report.isError)
    return <QueryErrorState error={report.error} onRetry={() => void report.refetch()} notFound="La sede elegida ya no está disponible. Elige otra sede." />

  const data = report.data.data
  const { locale, funnel } = data
  const period = spanLabel(data.period, locale)
  const phrase = previousPhrase(data, locale)
  const whole = (key: string): string | undefined => (data.wholeClinic.includes(key) ? WHOLE_CLINIC : undefined)

  if (funnel.current.sought === 0 && data.newPatients.current === 0 && data.active.current === 0 && data.controls.current.due === 0) {
    return (
      <EmptyState
        title={`Nadie nos buscó ni vino por primera vez en ${period}`}
        description="Cuando alguien escriba por primera vez o recepción registre a un paciente, aquí verás hasta dónde llega."
        actionLabel="Ir a Pacientes"
        onAction={() => void navigate({ to: "/people" })}
      />
    )
  }

  const acceptance = rateOf(data.acceptance.current.accepted, data.acceptance.current.presented)
  const previousAcceptance = rateOf(data.acceptance.previous.accepted, data.acceptance.previous.presented)
  const paidAfterComing = rateOf(funnel.current.paid, funnel.current.came)
  const previousPaidAfterComing = rateOf(funnel.previous.paid, funnel.previous.came)
  const drop = biggestDrop(funnel.current, funnel.steps)

  return (
    <ReportBody stale={report.isPlaceholderData}>
      <section aria-label="Cifras de pacientes" className="grid min-w-0 gap-3.5 @xl:grid-cols-2 @5xl:grid-cols-4">
        <Figure
          title="Nos buscaron por primera vez"
          value={funnel.current.sought}
          change={unlessEmpty(funnel.current.sought, absoluteChange(funnel.current.sought, funnel.previous.sought, phrase, locale))}
          better="up"
          note={whole("funnel") ? `Escribieron o los registró recepción · ${WHOLE_CLINIC}` : "Escribieron o los registró recepción"}
        >
          {funnel.current.sought > 0 ? <FooterButton onClick={() => onOpenList("funnel_sought")}>Ver quiénes</FooterButton> : null}
        </Figure>
        <Figure
          title="Pacientes nuevos"
          value={data.newPatients.current}
          change={unlessEmpty(data.newPatients.current, absoluteChange(data.newPatients.current, data.newPatients.previous, phrase, locale))}
          better="up"
          note="Vinieron por primera vez"
        >
          {data.newPatients.current > 0 ? <FooterButton onClick={() => onOpenList("new_patients")}>Ver quiénes</FooterButton> : null}
        </Figure>
        {paysAfterComing(funnel.steps) ? (
          // Sin presupuesto que aceptar (latidIA), lo que se mide es la consulta cobrada.
          <Figure
            title="Pagaron al venir"
            value={paidAfterComing === null ? "Sin datos" : `${paidAfterComing} %`}
            change={paidAfterComing === null ? undefined : absoluteChange(paidAfterComing, previousPaidAfterComing, phrase, locale, POINTS)}
            better="up"
            note={[
              funnel.current.came === 0
                ? `Nadie que nos buscó en ${period} vino todavía`
                : `${funnel.current.paid} de ${funnel.current.came} que ${funnel.current.came === 1 ? "vino" : "vinieron"}`,
              whole("funnel"),
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        ) : (
          <Figure
            title="Aceptaron su presupuesto"
            value={acceptance === null ? "Sin datos" : `${acceptance} %`}
            change={acceptance === null ? undefined : absoluteChange(acceptance, previousAcceptance, phrase, locale, POINTS)}
            better="up"
            note={[
              data.acceptance.current.presented === 0
                ? `No se presentó ningún presupuesto en ${period}`
                : `${data.acceptance.current.accepted} de ${data.acceptance.current.presented} ${data.acceptance.current.presented === 1 ? "presentado" : "presentados"}`,
              whole("acceptance"),
            ]
              .filter(Boolean)
              .join(" · ")}
          />
        )}
        <Figure
          title="Pacientes activos"
          value={data.active.current}
          change={unlessEmpty(data.active.current, absoluteChange(data.active.current, data.active.previous, phrase, locale))}
          better="up"
          note={`Vinieron en los últimos ${data.active.months} meses`}
        />
      </section>

      <ReportCard title="Dónde se caen los pacientes" note={whole("funnel")}>
        <div className="-mt-1.5 flex min-w-0 flex-wrap items-start justify-between gap-3">
          <p className="min-w-0 flex-1 basis-80 text-sm text-muted-foreground">
            {funnel.current.sought === 1 ? "La persona que nos buscó" : `Las ${funnel.current.sought} personas que nos buscaron`} por primera vez en {period}, y hasta
            dónde llegaron hasta hoy. Cada paso cuenta a quienes llegaron a él o a uno posterior.
          </p>
          {funnel.open && funnel.current.sought > 0 ? (
            <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-[13px] font-semibold text-foreground/80">{openWords(data, locale)}: aún pueden agendar</span>
          ) : null}
        </div>
        {funnel.current.sought === 0 ? (
          <EmptyLine
            action={
              <Link to="/inbox" search={{ conversation: undefined }} className="font-semibold text-primary-soft-foreground underline">
                Abrir la Bandeja
              </Link>
            }
          >
            Nadie nos buscó por primera vez en {period}.
          </EmptyLine>
        ) : (
          <BarList
            title={`Embudo de ${period}: de las personas que nos buscaron, hasta dónde llegaron`}
            rows={funnelRows(funnel, locale, data, stageNames, false)}
            onSelect={(index) => onOpenList(REACHED_LIST[funnel.steps[index] as FunnelStep])}
            selectLabel="Ver quiénes"
            between={(index) => {
              const next = funnel.steps[index + 1]
              if (!next) return null
              const lost = funnel.current[funnel.steps[index] as FunnelStep] - funnel.current[next]
              if (lost <= 0) return null
              const list = LOST_LIST[next]
              // Quiénes dejaron de escribir son parte de los que no agendaron: su lista se abre ahí, sea o no la caída mayor.
              const stopped =
                next === "booked" && funnel.stopped > 0 ? (
                  <p className="flex flex-wrap items-baseline gap-x-2 pb-1 pl-3 text-[13px] text-muted-foreground sm:ml-[14.25rem] sm:pl-1">
                    <span>
                      {funnel.stopped === 1
                        ? `1 de ellos preguntó algo y no escribe hace más de ${days(funnel.stoppedDays)}.`
                        : `${funnel.stopped} de ellos preguntaron algo y no escriben hace más de ${days(funnel.stoppedDays)}.`}
                    </span>
                    <Button type="button" variant="link" className="h-auto min-h-11 p-0 text-[13px] font-semibold sm:min-h-6" onClick={() => onOpenList("funnel_stopped")}>
                      Ver quiénes
                    </Button>
                  </p>
                ) : null
              if (next === drop)
                return (
                  <>
                    <DropCallout step={next} funnel={funnel} head={data} locale={locale} compact={false} onOpenList={onOpenList} />
                    {stopped}
                  </>
                )
              return (
                <>
                  <p className="flex flex-wrap items-baseline gap-x-2 py-0.5 pl-3 text-[13px] text-muted-foreground sm:ml-[14.25rem] sm:pl-1">
                    <span aria-hidden>↓</span>
                    {list ? (
                      <Button type="button" variant="link" className="h-auto min-h-11 p-0 text-[13px] font-normal text-muted-foreground underline sm:min-h-6" onClick={() => onOpenList(list)}>
                        {lostWords(next, lost, funnel.open, funnel.steps)}
                      </Button>
                    ) : (
                      <span>{lostWords(next, lost, funnel.open, funnel.steps)}</span>
                    )}
                  </p>
                  {stopped}
                </>
              )
            }}
            table={{ label: "Paso", value: "Personas", note: "Del paso anterior" }}
          />
        )}
        {funnel.current.sought > 0 ? <p className="-mt-1 text-xs text-muted-foreground sm:hidden">Toca un paso para ver a esas personas.</p> : null}
        {advice}
      </ReportCard>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Channels data={data} />
        <Referral data={data} />
      </div>

      <Returns data={data} onOpenList={onOpenList} />
    </ReportBody>
  )
}

/** Por dónde nos buscaron: el canal de su primera conversación y, más oscuro, quiénes vinieron. */
function Channels({ data }: { data: ReportPatients }) {
  const { locale } = data
  const period = spanLabel(data.period, locale)
  const rows = data.channels
  return (
    <ReportCard title="Por dónde nos buscaron" note={data.wholeClinic.includes("channels") ? WHOLE_CLINIC : undefined}>
      {rows.length === 0 ? (
        <EmptyLine>Nadie nos buscó por primera vez en {period}.</EmptyLine>
      ) : (
        <>
          <p className="-mt-1.5 text-sm text-muted-foreground">Canal de la primera conversación. La parte oscura son los que vinieron.</p>
          <BarList
            title={`Por dónde nos buscaron en ${period} y cuántos vinieron`}
            size="sm"
            legend={{ value: "Nos buscaron", part: "Vinieron" }}
            rows={rows.map((row) => ({
              key: row.channel ?? "retirado",
              label: firstContactChannel(row.channel),
              value: row.sought,
              part: row.came,
              valueText: `${row.came} de ${row.sought}`,
              note: `${rateOf(row.came, row.sought) ?? 0} %`,
              muted: row.channel === null,
            }))}
            table={{ label: "Canal", value: "Vinieron de los que buscaron", note: "Vinieron" }}
          />
          {rows.some((row) => row.channel === "recepcion") ? (
            <p className="text-[13px] text-muted-foreground">Recepción = llamada o en persona: lo registró el equipo.</p>
          ) : null}
        </>
      )}
    </ReportCard>
  )
}

/** Cómo nos conocieron los pacientes nuevos, de la lista del registro (decisión 3). */
function Referral({ data }: { data: ReportPatients }) {
  const { locale } = data
  const canSettings = usePermission("settings.write")
  const period = spanLabel(data.period, locale)
  const count = (kind: ReferralKind | null): number => data.referral.find((row) => row.kind === kind)?.count ?? 0
  const total = data.referral.reduce((sum, row) => sum + row.count, 0)
  const unanswered = count(null)
  const rows: BarListRow[] = REFERRAL_KINDS.map((kind) => ({
    key: kind,
    // La misma etiqueta que en el registro y en la ficha.
    label: REFERRAL_KIND_LABELS[kind],
    value: count(kind),
    valueText: String(count(kind)),
    muted: kind === "otro",
  }))
  if (unanswered > 0) rows.push({ key: "sin_respuesta", label: "No lo dijeron", value: unanswered, valueText: String(unanswered), muted: true })
  return (
    <ReportCard title="Cómo nos conocieron">
      {total === 0 ? (
        <EmptyLine>Nadie vino por primera vez en {period}.</EmptyLine>
      ) : (
        <>
          <p className="-mt-1.5 text-sm text-muted-foreground">
            Lo que {total === 1 ? "respondió el paciente nuevo" : `respondieron los ${total} pacientes nuevos`}.
          </p>
          <BarList title={`Cómo nos conocieron los pacientes nuevos de ${period}`} size="sm" rows={rows} table={{ label: "Cómo nos conoció", value: "Pacientes nuevos" }} />
          <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted-foreground">
            <span>Se pregunta al registrar al paciente, con una lista.</span>
            {unanswered > 0 && canSettings ? (
              <Link to="/settings/patient-registration" className="font-semibold text-primary-soft-foreground underline">
                Revisar el registro
              </Link>
            ) : null}
          </p>
        </>
      )}
    </ReportCard>
  )
}

/** Si vuelven: sus controles, si volvieron en el año, quiénes no vienen hace más de 6 meses y si volvieron tras invitarlos. */
function Returns({ data, onOpenList }: { data: ReportPatients; onOpenList: (list: ReportListKey) => void }) {
  const { locale } = data
  const period = spanLabel(data.period, locale)
  const phrase = previousPhrase(data, locale)
  const id = useId()
  const controls = data.controls.current
  const cameRate = rateOf(controls.came, controls.due)
  const previousCameRate = rateOf(data.controls.previous.came, data.controls.previous.due)
  const missed = controls.due - controls.came
  const invites = data.invites
  const returned = rateOf(data.returned.current.returned, data.returned.current.cohort)
  const previousReturned = rateOf(data.returned.previous.returned, data.returned.previous.cohort)
  const returnedMonths = data.returned.months.map((month) => rateOf(month.returned, month.cohort))
  const known = returnedMonths.filter((value): value is number => value !== null)
  const partialMonth = data.months[data.months.length - 1]?.partial ?? false
  const sparkLabel =
    known.length === 0
      ? "Volvieron en el año: sin datos en los últimos 12 meses"
      : `Volvieron en el año, en los últimos 12 meses: de ${known[0]} % a ${known[known.length - 1]} %${partialMonth ? ". El último mes no está completo" : ""}`
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <h3 id={id} className="font-semibold">
        Si vuelven
      </h3>
      <div className="grid min-w-0 gap-3.5 @xl:grid-cols-2 @5xl:grid-cols-4">
        <Figure
          title="Vinieron a su control"
          value={cameRate === null ? "Sin datos" : `${cameRate} %`}
          change={cameRate === null ? undefined : absoluteChange(cameRate, previousCameRate, phrase, locale, POINTS)}
          better="up"
          note={[
            controls.due === 0
              ? `Ningún control tocaba en ${period}`
              : `${controls.came} de ${controls.due} ${controls.due === 1 ? "control que tocaba" : "controles que tocaban"} en ${period}`,
            data.wholeClinic.includes("controls") ? WHOLE_CLINIC : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          {cameRate !== null ? (
            <div aria-hidden className="mt-1 h-2 overflow-hidden rounded-full bg-primary-soft">
              <div className="h-full rounded-full bg-primary" style={{ width: `${cameRate}%` }} />
            </div>
          ) : null}
          {missed > 0 ? <FooterButton onClick={() => onOpenList("controls_missed")}>{missed === 1 ? "Ver el que no vino" : `Ver los ${missed} que no vinieron`}</FooterButton> : null}
        </Figure>
        <Figure
          title="Volvieron en el año"
          value={returned === null ? "Sin datos" : `${returned} %`}
          change={returned === null ? undefined : absoluteChange(returned, previousReturned, phrase, locale, POINTS)}
          better="up"
          note={
            data.returned.current.cohort === 0
              ? "Nadie vino hace 12 a 24 meses: todavía no hay con quién comparar"
              : `De los ${data.returned.current.cohort} que vinieron hace 12 a 24 meses, ${data.returned.current.returned} volvieron en los últimos 12`
          }
        >
          <Sparkline values={returnedMonths} label={sparkLabel} lastPartial={partialMonth} width={160} className="mt-1" />
        </Figure>
        <Figure
          title={`Sin venir hace más de ${data.lapsed.months} meses`}
          value={data.lapsed.count}
          note={data.lapsed.count === 0 ? "Todos tienen algo pendiente o vinieron hace poco" : "A hoy: sin cita, presupuesto que espere respuesta ni control pendiente"}
        >
          {data.lapsed.count > 0 ? <FooterButton onClick={() => onOpenList("lapsed")}>Ver quiénes</FooterButton> : null}
        </Figure>
        <Figure
          title="Volvieron tras la invitación"
          value={invites.returned}
          detail={invites.invited === 0 ? undefined : `de ${invites.invited} ${invites.invited === 1 ? "invitada" : "invitadas"}`}
          note={[
            invites.invited === 0 ? `Nadie recibió una invitación a volver ${during(period)}` : `Personas invitadas ${during(period)} que vinieron después, a hoy`,
            data.wholeClinic.includes("invites") ? WHOLE_CLINIC : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          {invites.returned > 0 ? <FooterButton onClick={() => onOpenList("invited_returned")}>Ver quiénes</FooterButton> : null}
        </Figure>
      </div>
    </section>
  )
}
