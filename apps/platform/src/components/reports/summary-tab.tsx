/**
 * Reportes › Resumen: cómo va el negocio. Seis cifras con su comparación y su
 * línea de 12 meses, lo cobrado por tramo con el año anterior al lado, lo que
 * vio el Administrador y una fila por profesional. Cada cifra lleva a donde se
 * mira entera o a su lista; mejor o peor se dice con palabras y flecha, nunca
 * solo con color.
 */
import { formatMoney } from "@odentia/clinical"
import { Button, cn, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@odentia/ui"
import { ColumnChart, EmptyState, LoadingState, Sparkline } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowDown, ArrowUp, Bot } from "lucide-react"
import { type ReactNode, useId } from "react"
import { plainAmount } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import { QueryErrorState } from "../../lib/query-error"
import {
  absoluteChange,
  bucketLabel,
  bucketShort,
  type Comparison,
  fetchReport,
  GRAIN_WORD,
  POINTS,
  previousPhrase,
  rateOf,
  relativeChange,
  reportKey,
  type ReportListKey,
  type ReportProfessionals,
  type ReportQuery,
  type ReportSummary,
  spanLabel,
} from "../../lib/reports"
import { FunnelCard } from "./patients-tab"
import { type Better, ChangeLine, EmptyLine, ReportCard, WHOLE_CLINIC } from "./report-parts"

/** Lo que se aparta de la clínica más de estos puntos lleva su marca en la tabla por profesional. */
const APART_POINTS = 5

export type SummaryTarget = "finanzas" | "pacientes" | "agenda" | "agente"

function compactMoney(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(cents / 100)
}

/** «de S/ 38 900 a S/ 48 200»: el recorrido de la línea pequeña dicho con palabras. */
export function travel(values: Array<number | null>, format: (value: number) => string): string {
  const known = values.filter((value): value is number => value !== null)
  if (known.length === 0) return "sin datos"
  if (known.length === 1) return format(known[0] as number)
  return `de ${format(known[0] as number)} a ${format(known[known.length - 1] as number)}`
}

/** Una diferencia de dinero dicha con palabras: «S/ 620 más que en agosto». */
function moneyChange(current: number, previous: number, currency: string, locale: string, phrase: string): Comparison {
  const difference = current - previous
  if (difference === 0) return { text: `Igual ${phrase}`, direction: "same" }
  return { text: `${formatMoney(Math.abs(difference), currency, locale)} ${difference > 0 ? "más" : "menos"} ${phrase}`, direction: difference > 0 ? "up" : "down" }
}

export function SummaryFigure({
  title,
  icon,
  value,
  spark,
  sparkLabel,
  sparkPartial,
  change,
  better,
  detail,
  note,
  footer,
}: {
  title: string
  icon?: ReactNode
  value: ReactNode
  spark: Array<number | null>
  sparkLabel: string
  /** El último mes de la línea todavía corre. */
  sparkPartial?: boolean
  change?: Comparison | null
  better: Better
  detail?: ReactNode
  note?: string
  footer?: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="elevated flex min-w-0 flex-col gap-1 rounded-xl border bg-card px-[18px] py-4">
      <h3 id={id} className="flex items-center gap-1.5 text-[13px] font-bold text-muted-foreground">
        {icon}
        {title}
        {note ? <span className="font-medium">· {note}</span> : null}
      </h3>
      <div className="flex min-w-0 items-end justify-between gap-3">
        <span className="min-w-0 truncate text-[28px] leading-9 font-extrabold tracking-tight tabular-nums">{value}</span>
        <Sparkline values={spark} label={`${sparkLabel}${sparkPartial ? ". El último mes no está completo" : ""}`} lastPartial={sparkPartial} />
      </div>
      {change !== undefined ? <ChangeLine change={change} better={better} /> : null}
      {detail ? <span className="text-[13px] text-foreground/80">{detail}</span> : null}
      {footer ? <div className="mt-auto pt-1.5">{footer}</div> : null}
    </section>
  )
}

function FooterLink({ to, children }: { to: SummaryTarget; children: ReactNode }) {
  return (
    <Link to="/reports" search={(prev) => ({ ...prev, tab: to, lista: undefined })} className="inline-flex min-h-11 items-center text-[13px] font-bold text-primary-soft-foreground underline-offset-2 hover:underline sm:min-h-8">
      {children}
    </Link>
  )
}

export function FooterButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" variant="link" className="h-auto min-h-11 p-0 text-[13px] font-bold sm:min-h-8" onClick={onClick}>
      {children}
    </Button>
  )
}

export function SummaryTab({ query, onOpenList, advice }: { query: ReportQuery; onOpenList: (list: ReportListKey) => void; advice?: ReactNode }) {
  const report = useQuery({ queryKey: reportKey("summary", query), queryFn: () => fetchReport<ReportSummary>("summary", query), retry: false })

  if (report.isPending) return <LoadingState />
  if (report.isError)
    return <QueryErrorState error={report.error} onRetry={() => void report.refetch()} notFound="La sede elegida ya no está disponible. Elige otra sede." />

  const data = report.data.data
  const { locale, currency } = data
  const phrase = previousPhrase(data, locale)
  const money = (cents: number): string => formatMoney(cents, currency, locale)
  const twelve = "en los últimos 12 meses"
  const partialMonth = data.months[data.months.length - 1]?.partial ?? false

  const acceptance = rateOf(data.acceptance.current.accepted, data.acceptance.current.presented)
  const previousAcceptance = rateOf(data.acceptance.previous.accepted, data.acceptance.previous.presented)
  const noShow = rateOf(data.noShow.current.noShow, data.noShow.current.total)
  const previousNoShow = rateOf(data.noShow.previous.noShow, data.noShow.previous.total)
  const acceptanceMonths = data.acceptance.months.map((month) => rateOf(month.accepted, month.presented))
  const noShowMonths = data.noShow.months.map((month) => rateOf(month.noShow, month.total))
  const percent = (value: number): string => `${value} %`
  const nothing =
    data.collected.current === 0 && data.newPatients.current === 0 && data.noShow.current.total === 0 && data.acceptance.current.presented === 0

  if (nothing && data.collected.months.every((value) => value === 0)) {
    return (
      <EmptyState
        title="Todavía no hay movimiento que mostrar"
        description="Cuando la clínica atienda, cobre y presente presupuestos, aquí verás cómo va el negocio mes a mes."
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section aria-label="Las seis cifras" className="grid min-w-0 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
        <SummaryFigure
          title="Cobrado"
          value={money(data.collected.current)}
          spark={data.collected.months}
          sparkPartial={partialMonth}
          sparkLabel={`Cobrado ${twelve}: ${travel(data.collected.months, money)}`}
          change={data.collected.current === 0 && data.collected.previous === 0 ? undefined : relativeChange(data.collected.current, data.collected.previous, phrase, locale)}
          better="up"
          detail={data.collected.others.length > 0 ? `Además, ${data.collected.others.map((item) => formatMoney(item.current, item.currency, locale)).join(" y ")}` : undefined}
          footer={<FooterLink to="finanzas">Ver en Finanzas</FooterLink>}
        />
        <SummaryFigure
          title="Pacientes nuevos"
          value={data.newPatients.current}
          spark={data.newPatients.months}
          sparkPartial={partialMonth}
          sparkLabel={`Pacientes nuevos ${twelve}: ${travel(data.newPatients.months, String)}`}
          change={data.newPatients.current === 0 && data.newPatients.previous === 0 ? undefined : absoluteChange(data.newPatients.current, data.newPatients.previous, phrase, locale)}
          better="up"
          footer={data.newPatients.current > 0 ? <FooterButton onClick={() => onOpenList("new_patients")}>Ver quiénes</FooterButton> : undefined}
        />
        <SummaryFigure
          title="Aceptaron su presupuesto"
          note={data.wholeClinic.includes("acceptance") ? WHOLE_CLINIC : undefined}
          value={acceptance === null ? "Sin datos" : percent(acceptance)}
          spark={acceptanceMonths}
          sparkPartial={partialMonth}
          sparkLabel={`Aceptación ${twelve}: ${travel(acceptanceMonths, percent)}`}
          change={acceptance === null ? undefined : absoluteChange(acceptance, previousAcceptance, phrase, locale, POINTS)}
          better="up"
          detail={
            data.acceptance.current.presented === 0
              ? `No se presentó ningún presupuesto en ${spanLabel(data.period, locale)}.`
              : `${data.acceptance.current.accepted} de ${data.acceptance.current.presented} ${data.acceptance.current.presented === 1 ? "presupuesto presentado" : "presupuestos presentados"}`
          }
          footer={<FooterLink to="pacientes">Ver en Pacientes</FooterLink>}
        />
        <SummaryFigure
          title="No vinieron"
          value={noShow === null ? "Sin datos" : percent(noShow)}
          spark={noShowMonths}
          sparkPartial={partialMonth}
          sparkLabel={`Inasistencia ${twelve}: ${travel(noShowMonths, percent)}`}
          change={noShow === null ? undefined : absoluteChange(noShow, previousNoShow, phrase, locale, POINTS)}
          better="down"
          detail={data.noShow.current.total > 0 ? `${data.noShow.current.noShow} de ${data.noShow.current.total} ${data.noShow.current.total === 1 ? "cita que ya pasó" : "citas que ya pasaron"}` : undefined}
          footer={data.noShow.current.noShow > 0 ? <FooterButton onClick={() => onOpenList("no_show")}>Ver quiénes</FooterButton> : <FooterLink to="agenda">Ver en Agenda</FooterLink>}
        />
        <SummaryFigure
          title="Citas que agendó el agente"
          icon={<Bot aria-hidden className="size-3.5 shrink-0" />}
          value={data.agent.current.booked}
          spark={data.agent.months}
          sparkPartial={partialMonth}
          sparkLabel={`Citas que agendó el agente ${twelve}: ${travel(data.agent.months, String)}`}
          change={data.agent.current.booked === 0 && data.agent.previous.booked === 0 ? undefined : absoluteChange(data.agent.current.booked, data.agent.previous.booked, phrase, locale)}
          better="up"
          detail={
            [
              data.agent.current.recovered > 0 ? `y recuperó ${data.agent.current.recovered} ${data.agent.current.recovered === 1 ? "cita" : "citas"}` : null,
              data.agent.current.collectedCents > 0 ? `${money(data.agent.current.collectedCents)} cobrados en esas citas` : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          }
          footer={<FooterLink to="agente">Ver en Agente</FooterLink>}
        />
        <SummaryFigure
          title={`Te deben hace más de ${data.overdue.days} días`}
          value={money(data.overdue.current.cents)}
          spark={data.overdue.months}
          sparkPartial={partialMonth}
          sparkLabel={`Deuda de más de ${data.overdue.days} días al cierre de cada mes ${twelve}: ${travel(data.overdue.months, money)}`}
          change={data.overdue.current.cents === 0 && data.overdue.previous.cents === 0 ? undefined : moneyChange(data.overdue.current.cents, data.overdue.previous.cents, currency, locale, phrase)}
          better="down"
          detail={data.overdue.current.people > 0 ? `${data.overdue.current.people} ${data.overdue.current.people === 1 ? "persona" : "personas"}, al cierre del periodo` : "Nadie, al cierre del periodo"}
          footer={data.overdue.current.people > 0 ? <FooterButton onClick={() => onOpenList("debts_overdue")}>Ver quiénes</FooterButton> : undefined}
        />
      </section>

      <CollectedChart data={data} />

      {/* Dónde se caen los pacientes, al lado de lo que vio el Administrador (tablero 1); si no caben, una debajo de la otra. */}
      <div className="flex min-w-0 flex-wrap gap-4">
        <div className="flex min-w-0 flex-[1.5_1_30rem] flex-col *:flex-1">
          <FunnelCard query={query} onOpenList={onOpenList} />
        </div>
        <div className="flex min-w-0 flex-[1_1_22.5rem] flex-col *:flex-1">{advice}</div>
      </div>

      <Professionals query={query} />
    </div>
  )
}

/** Lo cobrado por tramo del periodo, con el mismo tramo un año antes, y una frase con lo último. */
function CollectedChart({ data }: { data: ReportSummary }) {
  const { locale, currency } = data
  const grain = data.period.grain
  const title = `Cobrado ${GRAIN_WORD[grain]}`
  if (data.chart.length < 2) return null
  const last = data.chart[data.chart.length - 1]
  const lastName = last ? bucketLabel(last, grain, locale) : ""
  const complete = data.chart.filter((bucket) => !bucket.partial)
  const best = complete.reduce<(typeof data.chart)[number] | null>((top, bucket) => (top && top.cents >= bucket.cents ? top : bucket), null)
  const change = last && last.previousCents > 0 ? Math.round(((last.cents - last.previousCents) * 100) / last.previousCents) : null
  const versus = change === null ? "" : change === 0 ? ", igual que un año antes" : `, ${Math.abs(change)} % ${change > 0 ? "más" : "menos"} que un año antes`
  const insight = !last
    ? ""
    : last.partial
      ? `${lastName} va en ${formatMoney(last.cents, currency, locale)}${versus}.`
      : best && best.key === last.key && grain === "month"
        ? `${lastName} fue tu mejor mes de los últimos ${data.chart.length}: ${formatMoney(last.cents, currency, locale)}${versus}.`
        : `${lastName}: ${formatMoney(last.cents, currency, locale)}${versus}.`
  return (
    <ReportCard title={title} note={currency}>
      <p className="-mt-2 text-sm text-muted-foreground">{insight}</p>
      <ColumnChart
        title={`${title}, con el mismo tramo un año antes`}
        tableHeading={grain === "month" ? "Mes" : grain === "week" ? "Semana" : "Día"}
        categories={data.chart.map((bucket) => ({ key: bucket.key, label: bucketLabel(bucket, grain, locale), short: bucketShort(bucket, grain, locale), partial: bucket.partial }))}
        bars={[{ key: "cobrado", label: "Cobrado", tone: "series-1", values: data.chart.map((bucket) => bucket.cents) }]}
        line={{ key: "antes", label: "Un año antes", values: data.chart.map((bucket) => bucket.previousCents) }}
        format={(cents) => formatMoney(cents, currency, locale)}
        axis={(cents) => compactMoney(cents, locale)}
      />
    </ReportCard>
  )
}

/** Una cifra que se aparta de la clínica: la flecha y lo que significa, no solo el color. */
function Apart({ value, clinic, worse }: { value: number | null; clinic: number | null; worse: "up" | "down" }) {
  if (value === null) return <span className="text-muted-foreground">—</span>
  const gap = clinic === null ? 0 : value - clinic
  const apart = Math.abs(gap) > APART_POINTS
  if (!apart) return <span>{value} %</span>
  const bad = (gap > 0 && worse === "up") || (gap < 0 && worse === "down")
  const Arrow = gap > 0 ? ArrowUp : ArrowDown
  return (
    <span className={cn("inline-flex items-center justify-end gap-0.5 font-bold", bad ? "text-warning" : "text-success")}>
      <Arrow aria-hidden className="size-3" strokeWidth={2.5} />
      {value} %<span className="sr-only">, {gap > 0 ? "más" : "menos"} que la clínica ({clinic} %)</span>
    </span>
  )
}

function Professionals({ query }: { query: ReportQuery }) {
  const report = useQuery({ queryKey: reportKey("professionals", query), queryFn: () => fetchReport<ReportProfessionals>("professionals", query), retry: false })
  if (report.isPending)
    return (
      <ReportCard title="Por profesional">
        <LoadingState />
      </ReportCard>
    )
  if (report.isError)
    return (
      <ReportCard title="Por profesional">
        <QueryErrorState error={report.error} onRetry={() => void report.refetch()} />
      </ReportCard>
    )
  const { locale, currency, rows } = report.data.data
  if (rows.length === 0)
    return (
      <ReportCard title="Por profesional">
        <EmptyLine>Nadie atendió en este periodo.</EmptyLine>
      </ReportCard>
    )
  const sum = (pick: (row: (typeof rows)[number]) => number): number => rows.reduce((total, row) => total + pick(row), 0)
  const clinicNoShow = rateOf(sum((row) => row.noShow), sum((row) => row.total))
  const clinicAcceptance = rateOf(sum((row) => row.accepted), sum((row) => row.presented))
  const clinicBusy = rateOf(sum((row) => row.occMin), sum((row) => row.availMin))
  const legend = `Las flechas marcan lo que se aparta más de ${APART_POINTS} puntos de la clínica${clinicNoShow !== null ? ` (no vinieron ${clinicNoShow} %` : ""}${clinicAcceptance !== null ? `${clinicNoShow !== null ? ", " : " ("}aceptaron ${clinicAcceptance} %` : ""}${clinicBusy !== null ? `${clinicNoShow !== null || clinicAcceptance !== null ? ", " : " ("}ocupado ${clinicBusy} %` : ""}${clinicNoShow !== null || clinicAcceptance !== null || clinicBusy !== null ? ")" : ""}.`
  const amount = (cents: number): string => plainAmount(cents, currency, locale)
  return (
    <ReportCard title="Por profesional" note={`Ordenado por lo cobrado · ${currency}`}>
      {/* En teléfono, una fila por profesional: la tabla no cabe sin desbordar. */}
      <ul className="flex min-w-0 flex-col divide-y sm:hidden">
        {rows.map((row) => (
          <li key={row.userId} className="flex min-w-0 flex-col gap-0.5 py-2.5">
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate font-semibold">{row.name}</span>
              <span className="shrink-0 font-semibold tabular-nums">{amount(row.collectedCents)}</span>
            </span>
            <span className="flex flex-wrap gap-x-3 text-[13px] text-muted-foreground">
              <span>{row.attended} atendidas</span>
              <span className="inline-flex gap-1">
                No vinieron <Apart value={rateOf(row.noShow, row.total)} clinic={clinicNoShow} worse="up" />
              </span>
              <span className="inline-flex gap-1">
                Aceptaron <Apart value={rateOf(row.accepted, row.presented)} clinic={clinicAcceptance} worse="down" />
              </span>
              <span className="inline-flex gap-1">
                Ocupado <Apart value={rateOf(row.occMin, row.availMin)} clinic={clinicBusy} worse="down" />
              </span>
            </span>
          </li>
        ))}
      </ul>
      <div className="hidden min-w-0 sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Profesional</TableHead>
              <TableHead scope="col" className="text-right">
                Atendidas
              </TableHead>
              <TableHead scope="col" className="text-right">
                No vinieron
              </TableHead>
              <TableHead scope="col" className="text-right">
                Aceptaron
              </TableHead>
              <TableHead scope="col" className="text-right">
                Ocupado
              </TableHead>
              <TableHead scope="col" className="text-right">
                Cobrado
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.userId}>
                <TableHead scope="row" className="font-semibold whitespace-normal">
                  {row.name}
                </TableHead>
                <TableCell className="text-right tabular-nums">{row.attended}</TableCell>
                <TableCell className="text-right tabular-nums">
                  <Apart value={rateOf(row.noShow, row.total)} clinic={clinicNoShow} worse="up" />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <Apart value={rateOf(row.accepted, row.presented)} clinic={clinicAcceptance} worse="down" />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <Apart value={rateOf(row.occMin, row.availMin)} clinic={clinicBusy} worse="down" />
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{amount(row.collectedCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-[13px] text-muted-foreground">{legend} Cobrado es lo de sus atenciones, la misma base de las comisiones.</p>
    </ReportCard>
  )
}

/** Sin el Administrador encendido no hay avisos: se dice, con su salida para quien puede encenderlo. */
export function AdminWatch({ enabled, children }: { enabled: boolean | undefined; children: ReactNode }) {
  const canAgent = usePermission("agent.write")
  return (
    <ReportCard title="Lo que vio el Administrador">
      {enabled === false ? (
        <EmptyLine
          action={
            canAgent ? (
              <Link to="/agent/administrador" className="font-semibold text-primary-soft-foreground underline">
                Encender el Administrador
              </Link>
            ) : undefined
          }
        >
          El Administrador está apagado: no vigila estas cifras.
        </EmptyLine>
      ) : (
        children
      )}
    </ReportCard>
  )
}
