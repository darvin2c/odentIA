/**
 * Reportes › Agenda (tablero 4): si los pacientes vinieron, cuánto de la agenda
 * de cada profesional se ocupó y cuándo queda libre. «Agenda ocupada» son los
 * minutos de citas no canceladas dentro del horario de cada profesional, menos
 * sus ausencias y los bloqueos de su sede; cada día usa el horario que valía
 * ese día (decisión 4). Los tres mapas tienen su detalle al lado y «Ver como
 * tabla»; el profesional se elige sin volver a preguntar al servidor.
 */
import { Button, cn, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@odentia/ui"
import { ColumnChart, EmptyState, HeatmapGrid, SkeletonRegion, Sparkline } from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { ArrowDown, ArrowUp } from "lucide-react"
import { type ReactNode, useId, useMemo, useState } from "react"
import { usePermission } from "../../lib/crm"
import { QueryErrorState } from "../../lib/query-error"
import {
  type AgendaReport,
  absoluteChange,
  bucketLabel,
  bucketShort,
  dayText,
  fetchReport,
  GRAIN_WORD,
  hoursLabel,
  POINTS,
  previousPhrase,
  rateOf,
  reportKey,
  type ReportListKey,
  type ReportQuery,
  spanLabel,
} from "../../lib/reports"
import { ChoiceButtons } from "../choice-buttons"
import { ChoiceSelect } from "../ui/choice-select"
import { AgendaTabSkeleton } from "../skeletons/reports"
import { type Better, ChangeLine, EmptyLine, ReportCard, ReportBody } from "./report-parts"
import { appWords } from "../../lib/product-words"

/** Lo que se aparta de la clínica más de estos puntos (o la mitad, en minutos) lleva su marca. */
const APART_POINTS = 5
const APART_MINUTES = 0.5

const WEEKDAY_NAMES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"]
const WEEKDAY_SHORT = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"]
/** La semana empieza el lunes. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

type MapView = "dias" | "horas" | "semana"

/** «3 p. m.», «12 m.»: la hora como se dice en la clínica. */
function clock(hour: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 5, hour % 24)))
}

function hourSpan(hour: number, locale: string): string {
  return `de ${clock(hour, locale)} a ${clock(hour + 1, locale)}`
}

function occupied(item: { availMin: number; occMin: number } | undefined): number | null {
  return item && item.availMin > 0 ? Math.round((item.occMin * 100) / item.availMin) : null
}

function sum<T>(list: T[], pick: (item: T) => number): number {
  return list.reduce((total, item) => total + pick(item), 0)
}

export function AgendaTab({ query, onOpenList, advice }: { query: ReportQuery; onOpenList: (list: ReportListKey) => void; advice?: ReactNode }) {
  const navigate = useNavigate()
  const canAgenda = usePermission("appointments.read")
  const canSchedules = usePermission("settings.write")
  const report = useQuery({ queryKey: reportKey("agenda", query), queryFn: () => fetchReport<AgendaReport>("agenda", query), placeholderData: keepPreviousData, retry: false })
  if (report.isPending)
    return (
      <SkeletonRegion message="Cargando las cifras…">
        <AgendaTabSkeleton />
      </SkeletonRegion>
    )
  if (report.isError)
    return <QueryErrorState error={report.error} onRetry={() => void report.refetch()} notFound="La sede elegida ya no está disponible. Elige otra sede." />
  const data = report.data.data
  const current = data.appointments.current
  if (current.total === 0 && data.occupancy.current.availMin === 0 && data.appointments.months.every((month) => month.total === 0))
    return (
      <EmptyState
        title={`Sin citas ni horarios en ${spanLabel(data.period, data.locale)}`}
        description="Cuando los profesionales tengan su horario y la agenda sus citas, aquí verás cuánto se ocupa y cuándo queda libre."
        actionLabel={canSchedules ? "Ir a los horarios" : canAgenda ? "Ir a la Agenda" : undefined}
        onAction={() => void navigate({ to: canSchedules ? "/settings/availability" : "/agenda" })}
      />
    )
  return (
    <ReportBody stale={report.isPlaceholderData}>
      <AgendaCards data={data} onOpenList={onOpenList} />
      {advice}
      <AppointmentsChart data={data} />
      <FreeHours data={data} />
      <Professionals data={data} />
    </ReportBody>
  )
}

// --- Las cuatro cifras ------------------------------------------------------------------

function AgendaCard({ title, value, change, better, detail, spark }: { title: string; value: string; change?: ReturnType<typeof absoluteChange>; better: Better; detail?: ReactNode; spark?: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="elevated flex min-w-0 flex-col gap-1 rounded-xl border bg-card px-[18px] py-4">
      <h3 id={id} className="text-[13px] font-bold text-muted-foreground">
        {title}
      </h3>
      <div className="flex min-w-0 items-end justify-between gap-3">
        <span className="min-w-0 truncate text-[28px] leading-9 font-extrabold tracking-tight tabular-nums">{value}</span>
        {spark}
      </div>
      {change !== undefined ? <ChangeLine change={change} better={better} /> : null}
      {detail ? <span className="text-[13px] text-foreground/80">{detail}</span> : null}
    </section>
  )
}

function ListButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button type="button" variant="link" className="h-auto min-h-11 p-0 text-[13px] font-bold sm:min-h-6" onClick={onClick}>
      {children}
    </Button>
  )
}

function AgendaCards({ data, onOpenList }: { data: AgendaReport; onOpenList: (list: ReportListKey) => void }) {
  const { locale } = data
  const phrase = previousPhrase(data, locale)
  const { current, previous } = data.appointments
  const passed = current.attended + current.noShow + current.cancelled
  const previousPassed = previous.attended + previous.noShow + previous.cancelled
  const noShow = rateOf(current.noShow, passed)
  const cancelled = rateOf(current.cancelled, passed)
  const busy = occupied(data.occupancy.current)
  const busyBefore = occupied(data.occupancy.previous)
  const months = data.occupancy.months.map((month) => occupied(month))
  const partial = data.months[data.months.length - 1]?.partial ?? false
  const free = data.occupancy.current.availMin - data.occupancy.current.occMin
  return (
    <section aria-label="Cifras de agenda" className="grid min-w-0 gap-3.5 @xl:grid-cols-2 @5xl:grid-cols-4">
      <AgendaCard
        title="Citas atendidas"
        value={String(current.attended)}
        change={current.attended === 0 && previous.attended === 0 ? undefined : absoluteChange(current.attended, previous.attended, phrase, locale)}
        better="up"
        detail={
          <>
            De {passed} {passed === 1 ? "cita que ya pasó" : "citas que ya pasaron"}
            {current.unmarked > 0 ? (
              <>
                {" · "}
                {current.unmarked} sin marcar · <ListButton onClick={() => onOpenList("unmarked")}>Ver cuáles</ListButton>
              </>
            ) : null}
          </>
        }
      />
      <AgendaCard
        title="No vinieron"
        value={noShow === null ? "Sin datos" : `${noShow} %`}
        change={noShow === null ? undefined : absoluteChange(noShow, rateOf(previous.noShow, previousPassed), phrase, locale, POINTS)}
        better="down"
        detail={
          current.noShow > 0 ? (
            <>
              {current.noShow} {current.noShow === 1 ? "cita" : "citas"} · <ListButton onClick={() => onOpenList("no_show")}>Ver quiénes</ListButton>
            </>
          ) : undefined
        }
      />
      <AgendaCard
        title="Canceladas"
        value={cancelled === null ? "Sin datos" : `${cancelled} %`}
        change={cancelled === null ? undefined : absoluteChange(cancelled, rateOf(previous.cancelled, previousPassed), phrase, locale, POINTS)}
        better="down"
        detail={
          current.cancelled > 0 ? (
            <>
              {current.cancelled} {current.cancelled === 1 ? "cita" : "citas"} · <ListButton onClick={() => onOpenList("cancelled")}>Ver quiénes</ListButton>
            </>
          ) : undefined
        }
      />
      <AgendaCard
        title="Agenda ocupada"
        value={busy === null ? "Sin horario" : `${busy} %`}
        change={busy === null ? undefined : absoluteChange(busy, busyBefore, phrase, locale, POINTS)}
        better="up"
        detail={busy === null ? "Ningún profesional tenía horario en el periodo." : `${hoursLabel(free, locale)} libres de ${hoursLabel(data.occupancy.current.availMin, locale)}`}
        spark={
          <Sparkline
            values={months}
            lastPartial={partial}
            label={`Agenda ocupada en los últimos 12 meses: ${months.filter((value) => value !== null).map((value) => `${value} %`).join(", ") || "sin datos"}`}
          />
        }
      />
    </section>
  )
}

// --- Citas por tramo --------------------------------------------------------------------

function AppointmentsChart({ data }: { data: AgendaReport }) {
  const { locale } = data
  const grain = data.period.grain
  if (data.chart.length < 2) return null
  const complete = data.chart.filter((bucket) => !bucket.partial && bucket.attended + bucket.noShow + bucket.cancelled > 0)
  const first = complete[0]
  const last = complete[complete.length - 1]
  const rate = (bucket: (typeof data.chart)[number]) => rateOf(bucket.noShow, bucket.attended + bucket.noShow + bucket.cancelled)
  const insight =
    first && last && first.key !== last.key && rate(first) !== null && rate(last) !== null
      ? `La inasistencia pasó de ${rate(first)} % en ${bucketLabel(first, grain, locale).toLocaleLowerCase(locale)} a ${rate(last)} % en ${bucketLabel(last, grain, locale).toLocaleLowerCase(locale)}; se atendieron ${first.attended} y ${last.attended} citas.`
      : ""
  return (
    <ReportCard title={`Citas ${GRAIN_WORD[grain]} y cómo terminaron`}>
      {insight ? <p className="-mt-2 text-sm text-muted-foreground">{insight}</p> : null}
      <ColumnChart
        title={`Citas ${GRAIN_WORD[grain]}: atendidas, no vinieron y canceladas`}
        stacked
        total={{ label: "Citas que ya pasaron", values: data.chart.map((bucket) => bucket.attended + bucket.noShow + bucket.cancelled) }}
        tableHeading={grain === "month" ? "Mes" : grain === "week" ? "Semana" : "Día"}
        categories={data.chart.map((bucket) => ({ key: bucket.key, label: bucketLabel(bucket, grain, locale), short: bucketShort(bucket, grain, locale), partial: bucket.partial }))}
        bars={[
          { key: "atendidas", label: "Atendidas", tone: "series-1", values: data.chart.map((bucket) => bucket.attended) },
          { key: "no_vinieron", label: "No vinieron", tone: "series-2", values: data.chart.map((bucket) => bucket.noShow) },
          { key: "canceladas", label: "Canceladas", tone: "series-3", values: data.chart.map((bucket) => bucket.cancelled) },
        ]}
        format={(value) => new Intl.NumberFormat(locale).format(value)}
      />
    </ReportCard>
  )
}

// --- Cuándo queda libre la agenda -------------------------------------------------------

function FreeHours({ data }: { data: AgendaReport }) {
  const { locale } = data
  const canAgenda = usePermission("appointments.read")
  const canSchedules = usePermission("settings.write")
  const [view, setView] = useState<MapView>("dias")
  const [who, setWho] = useState<string>("")
  const names = useMemo(() => new Map(data.professionals.map((row) => [row.userId, row.name])), [data.professionals])
  if (!data.map.days.some((day) => day.scheduledMin > 0))
    return (
      <ReportCard title="Cuándo queda libre la agenda">
        <EmptyLine
          action={
            canSchedules ? (
              <Link to="/settings/availability" className="font-bold text-primary-soft-foreground">
                Ir a los horarios
              </Link>
            ) : undefined
          }
        >
          Nadie tuvo horario en estos 12 meses: sin horario no se sabe cuándo queda libre.
        </EmptyLine>
      </ReportCard>
    )
  const people =[...new Set(data.map.days.map((day) => day.userId))].filter((id) => names.has(id))
  const mine = <T extends { userId: string }>(list: T[]): T[] => (who ? list.filter((item) => item.userId === who) : list)
  const days = mine(data.map.days)
  const hours = mine(data.map.hours)
  const week = mine(data.map.week)
  const firsts = mine(data.map.firstSchedule)
  const assumed = days.some((day) => day.assumed)
  const months = data.months
  const monthLabel = (key: string) => dayText(`${key}-15`, locale, { month: "long", year: "numeric" })
  const shortMonth = (key: string) => dayText(`${key}-15`, locale, { month: "short" }).replace(/\./g, "")
  const periodText = spanLabel(data.period, locale)
  const views: Array<{ value: MapView; label: string }> = [
    { value: "dias", label: "Día a día" },
    { value: "horas", label: "Hora por mes" },
    { value: "semana", label: "Semana tipo" },
  ]
  const legend = { low: "Libre", high: "Ocupada", noData: "Sin horario o cerrado" }

  let map: ReactNode = null
  let scope = ""
  let insight = ""

  if (view === "dias") {
    // Una columna por semana (de lunes a domingo) de los 12 meses; una fila por día con horario.
    const byDay = new Map<string, { availMin: number; occMin: number; scheduledMin: number; assumed: boolean }>()
    for (const day of days) {
      const entry = byDay.get(day.day) ?? { availMin: 0, occMin: 0, scheduledMin: 0, assumed: false }
      entry.availMin += day.availMin
      entry.occMin += day.occMin
      entry.scheduledMin += day.scheduledMin
      entry.assumed = entry.assumed || day.assumed
      byDay.set(day.day, entry)
    }
    const first = months[0]?.firstDay ?? data.period.from.year.toString()
    const last = months[months.length - 1]?.lastDay ?? first
    const startDate = new Date(`${first}T12:00:00Z`)
    const monday = new Date(startDate.getTime() - ((startDate.getUTCDay() + 6) % 7) * 86_400_000)
    const columns: Array<{ key: string; label: string; name: string; days: string[] }> = []
    for (let cursor = monday; cursor.toISOString().slice(0, 10) <= last; cursor = new Date(cursor.getTime() + 7 * 86_400_000)) {
      const weekDays = Array.from({ length: 7 }, (_, index) => new Date(cursor.getTime() + index * 86_400_000).toISOString().slice(0, 10))
      const firstOfMonth = weekDays.find((day) => day.endsWith("-01") && day >= first && day <= last) ?? (columns.length === 0 ? weekDays.find((day) => day >= first) : undefined)
      const month = firstOfMonth?.slice(0, 7)
      const monthBusy = month ? occupied(byMonthOf(byDay, month)) : null
      columns.push({
        key: weekDays[0] as string,
        label: month ? `${shortMonth(month)}${monthBusy !== null ? ` ${monthBusy} %` : ""}` : "",
        name: `Semana del ${dayText(weekDays[0] as string, locale, { day: "numeric", month: "long", year: "numeric" })}`,
        days: weekDays,
      })
    }
    const rowsShown = WEEK_ORDER.filter((weekday) => days.some((day) => day.weekday === weekday && day.scheduledMin > 0))
    const values = rowsShown.map((weekday) =>
      columns.map((column) => {
        const day = column.days[(weekday + 6) % 7] as string
        if (day < first || day > last) return null
        return occupied(byDay.get(day))
      }),
    )
    const monthValues = months.map((month) => ({ key: month.key, busy: occupied(byMonthOf(byDay, month.key)) })).filter((month) => month.busy !== null)
    const most = [...monthValues].sort((a, b) => (b.busy ?? 0) - (a.busy ?? 0))[0]
    const least = [...monthValues].sort((a, b) => (a.busy ?? 0) - (b.busy ?? 0))[0]
    const weekdayBusy = rowsShown
      .map((weekday) => ({ weekday, busy: occupied({ availMin: sum(days.filter((day) => day.weekday === weekday), (day) => day.availMin), occMin: sum(days.filter((day) => day.weekday === weekday), (day) => day.occMin) }) }))
      .filter((row) => row.busy !== null)
      .sort((a, b) => (a.busy ?? 0) - (b.busy ?? 0))
    scope = `12 meses, de ${monthLabel(months[0]?.key ?? "")} a ${monthLabel(months[months.length - 1]?.key ?? "")} · junto a cada mes, cuánto estuvo ocupada`
    insight =
      most && least && most.key !== least.key
        ? `${monthLabel(most.key).replace(/^./, (letter) => letter.toLocaleUpperCase(locale))} fue el mes más ocupado (${most.busy} %) y ${monthLabel(least.key)} el más libre (${least.busy} %).${weekdayBusy[0] ? ` Los ${WEEKDAY_NAMES[weekdayBusy[0].weekday]?.toLowerCase()} son el día más libre (${weekdayBusy[0].busy} % ocupada).` : ""}`
        : ""
    const dayOf = (row: number, column: number) => columns[column]?.days[((rowsShown[row] ?? 1) + 6) % 7] ?? ""
    const lastWithData = Math.max(0, columns.length - 1)
    map = (
      <HeatmapGrid
        key={`dias:${who}`}
        title={`Agenda ocupada día a día, ${scope}`}
        rows={rowsShown.map((weekday) => ({ key: String(weekday), label: WEEKDAY_SHORT[weekday] ?? "", name: WEEKDAY_NAMES[weekday] }))}
        columns={columns.map((column) => ({ key: column.key, label: column.label, name: column.name }))}
        values={values}
        max={100}
        cellHeight={16}
        labelWidth={36}
        initial={{ row: 0, column: lastWithData }}
        legend={legend}
        format={(value) => `${value} %`}
        describe={(row, column, value) => {
          const day = dayOf(row, column)
          const name = day ? dayText(day, locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : ""
          const entry = byDay.get(day)
          return `${name}: ${value === null ? (entry && entry.scheduledMin > 0 ? "cerrado" : "sin horario") : `${value} % ocupada`}`
        }}
        detail={(row, column, value) => {
          const day = dayOf(row, column)
          const entry = byDay.get(day)
          const name = day ? dayText(day, locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : ""
          return (
            <>
              <strong className="text-[15px]">{name.replace(/^./, (letter) => letter.toLocaleUpperCase(locale))}</strong>
              <span className="text-[22px] font-extrabold">{value === null ? (entry && entry.scheduledMin > 0 ? "Cerrado" : "Sin horario") : `${value} % ocupada`}</span>
              <span className="text-sm text-foreground/80">
                {value === null
                  ? entry && entry.scheduledMin > 0
                    ? "Un feriado o un bloqueo cerró la agenda ese día."
                    : "Nadie tenía horario ese día."
                  : `${hoursLabel((entry?.availMin ?? 0) - (entry?.occMin ?? 0), locale)} libres de ${hoursLabel(entry?.availMin ?? 0, locale)}`}
              </span>
              <span className="text-[13px] text-muted-foreground">
                {entry?.assumed ? "Antes de guardar su horario: se usó el de hoy." : "Con el horario que tenía cada profesional ese día."}
              </span>
              {canAgenda && day ? (
                <Link to="/agenda" search={{ date: day, ...(data.branch ? { branch: data.branch.id } : {}) }} className="mt-1 text-[13px] font-bold text-primary-soft-foreground">
                  Ver la agenda de ese día
                </Link>
              ) : null}
            </>
          )
        }}
      />
    )
  } else if (view === "horas") {
    const hourList = [...new Set(hours.map((cell) => cell.hour))].sort((a, b) => a - b)
    const cell = (hour: number, month: string) => {
      const list = hours.filter((item) => item.hour === hour && item.month === month)
      return { availMin: sum(list, (item) => item.availMin), occMin: sum(list, (item) => item.occMin) }
    }
    const values = hourList.map((hour) => months.map((month) => occupied(cell(hour, month.key))))
    const yearly = hourList
      .map((hour) => ({ hour, busy: occupied({ availMin: sum(hours.filter((item) => item.hour === hour), (item) => item.availMin), occMin: sum(hours.filter((item) => item.hour === hour), (item) => item.occMin) }) }))
      .filter((row) => row.busy !== null)
      .sort((a, b) => (a.busy ?? 0) - (b.busy ?? 0))
    const lastMonth = months.length - 1
    const freestHour = hourList
      .map((hour, row) => ({ row, free: cell(hour, months[lastMonth]?.key ?? "").availMin - cell(hour, months[lastMonth]?.key ?? "").occMin }))
      .sort((a, b) => b.free - a.free)[0]
    scope = "Cada fila es una hora del día; cada columna, un mes · 12 meses"
    insight = yearly[0] ? `${hourSpan(yearly[0].hour, locale).replace(/^./, (letter) => letter.toUpperCase())} es la hora más libre de los 12 meses: ${yearly[0].busy} % ocupada.` : ""
    map = (
      <HeatmapGrid
        key={`horas:${who}`}
        title="Agenda ocupada por hora del día, mes a mes"
        rows={hourList.map((hour) => ({ key: String(hour), label: clock(hour, locale), name: hourSpan(hour, locale) }))}
        columns={months.map((month) => ({ key: month.key, label: shortMonth(month.key), name: monthLabel(month.key) }))}
        values={values}
        max={100}
        cellHeight={22}
        labelWidth={64}
        initial={{ row: freestHour?.row ?? 0, column: Math.max(0, lastMonth) }}
        legend={legend}
        format={(value) => `${value} %`}
        describe={(row, column, value) => `${hourSpan(hourList[row] ?? 0, locale)} en ${monthLabel(months[column]?.key ?? "")}: ${value === null ? "sin horario" : `${value} % ocupada`}`}
        detail={(row, column, value) => {
          const hour = hourList[row] ?? 0
          const month = months[column]?.key ?? ""
          const item = cell(hour, month)
          return (
            <>
              <strong className="text-[15px]">
                {hourSpan(hour, locale).replace(/^./, (letter) => letter.toUpperCase())} en {monthLabel(month)}
              </strong>
              <span className="text-[22px] font-extrabold">{value === null ? "Sin horario" : `${value} % ocupada`}</span>
              <span className="text-sm text-foreground/80">{value === null ? "Nadie tenía horario a esa hora." : `${hoursLabel(item.availMin - item.occMin, locale)} libres de ${hoursLabel(item.availMin, locale)} ese mes`}</span>
              <span className="text-[13px] text-muted-foreground">{who ? `De ${names.get(who) ?? ""}.` : "Suma de todos los profesionales con horario a esa hora."}</span>
            </>
          )
        }}
      />
    )
  } else {
    const hourList = [...new Set(week.map((cell) => cell.hour))].sort((a, b) => a - b)
    const rowsShown = WEEK_ORDER.filter((weekday) => week.some((cell) => cell.weekday === weekday))
    const cellOf = (weekday: number, hour: number) => week.filter((item) => item.weekday === weekday && item.hour === hour)
    const total = (list: typeof week) => ({ availMin: sum(list, (item) => item.availMin), occMin: sum(list, (item) => item.occMin) })
    const values = rowsShown.map((weekday) => hourList.map((hour) => occupied(total(cellOf(weekday, hour)))))
    const freest = rowsShown
      .flatMap((weekday) => hourList.map((hour) => ({ weekday, hour, free: total(cellOf(weekday, hour)).availMin - total(cellOf(weekday, hour)).occMin })))
      .sort((a, b) => b.free - a.free)[0]
    scope = `${periodText.replace(/^./, (letter) => letter.toLocaleUpperCase(locale))} · cómo queda una semana normal del periodo`
    insight = freest && freest.free > 0 ? `Los ${WEEKDAY_NAMES[freest.weekday]?.toLowerCase()} ${hourSpan(freest.hour, locale)} es lo más libre: ${hoursLabel(freest.free, locale)} en el periodo.` : ""
    map =
      rowsShown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nadie tenía horario en el periodo.</p>
      ) : (
        <HeatmapGrid
          key={`semana:${who}`}
          title={`Semana tipo de ${periodText}`}
          rows={rowsShown.map((weekday) => ({ key: String(weekday), label: WEEKDAY_SHORT[weekday] ?? "", name: WEEKDAY_NAMES[weekday] }))}
          columns={hourList.map((hour) => ({ key: String(hour), label: clock(hour, locale), name: hourSpan(hour, locale) }))}
          values={values}
          max={100}
          cellHeight={34}
          labelWidth={40}
          initial={freest ? { row: Math.max(0, rowsShown.indexOf(freest.weekday)), column: Math.max(0, hourList.indexOf(freest.hour)) } : undefined}
          legend={legend}
          format={(value) => `${value} %`}
          describe={(row, column, value) =>
            `${WEEKDAY_NAMES[rowsShown[row] ?? 1]} ${hourSpan(hourList[column] ?? 0, locale)}: ${value === null ? "sin horario" : `${value} % ocupada`}`
          }
          detail={(row, column, value) => {
            const weekday = rowsShown[row] ?? 1
            const hour = hourList[column] ?? 0
            const list = cellOf(weekday, hour)
            const item = total(list)
            const freeOnes = list
              .map((entry) => ({ name: names.get(entry.userId) ?? "", free: entry.availMin - entry.occMin }))
              .filter((entry) => entry.free > 0 && entry.name)
              .sort((a, b) => b.free - a.free)
              .slice(0, 4)
            return (
              <>
                <strong className="text-[15px]">
                  {WEEKDAY_NAMES[weekday]} {hourSpan(hour, locale)}
                </strong>
                <span className="text-[22px] font-extrabold">{value === null ? "Sin horario" : `${value} % ocupada`}</span>
                <span className="text-sm text-foreground/80">
                  {value === null ? "Ningún profesional atiende a esa hora." : `${hoursLabel(item.availMin - item.occMin, locale)} libres de ${hoursLabel(item.availMin, locale)} en el periodo`}
                </span>
                {value !== null && !who && freeOnes.length > 0 ? (
                  <span className="text-[13px] text-muted-foreground">Más libres: {freeOnes.map((entry) => entry.name).join(", ")}</span>
                ) : null}
                {value === null && canSchedules ? (
                  <Link to="/settings/availability" className="mt-1 text-[13px] font-bold text-primary-soft-foreground">
                    Ir a los horarios
                  </Link>
                ) : null}
              </>
            )
          }}
        />
      )
  }

  return (
    <ReportCard title="Cuándo queda libre la agenda">
      <div className="-mt-2 flex min-w-0 flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{insight || "Pasa el mouse o toca una casilla para ver su detalle."}</p>
        <div className="flex flex-wrap items-center gap-2">
          {people.length > 1 ? (
            <ChoiceSelect aria-label="Profesional" className="w-56" value={who} onChange={(event) => setWho(event.target.value)}>
              <option value="">Todos los profesionales</option>
              {people.map((id) => (
                <option key={id} value={id}>
                  {names.get(id)}
                </option>
              ))}
            </ChoiceSelect>
          ) : null}
          <ChoiceButtons aria-label="Vista del mapa" value={view} options={views} onChange={setView} />

        </div>
      </div>
      <p className="text-xs text-foreground/80">{scope}</p>
      {map}
      <p className="rounded-lg bg-muted/50 px-3 py-2 text-[13px] text-foreground/80">
        Cada día se calcula con el horario que tenía cada profesional ese día; los feriados y los bloqueos de la sede cuentan como cerrado.
        {assumed && firsts.length > 0
          ? ` Antes de que ${appWords().name} guardara su horario se usó el de hoy: ${firsts
              .map((first) => `${names.get(first.userId) ?? "un profesional"} desde el ${dayText(first.day, locale)}`)
              .join(", ")}.`
          : ""}
      </p>
    </ReportCard>
  )
}

function byMonthOf(byDay: Map<string, { availMin: number; occMin: number }>, month: string) {
  let availMin = 0
  let occMin = 0
  for (const [day, entry] of byDay) {
    if (!day.startsWith(month)) continue
    availMin += entry.availMin
    occMin += entry.occMin
  }
  return { availMin, occMin }
}

// --- Por profesional --------------------------------------------------------------------

/** Una cifra que se aparta de la clínica: la flecha y lo que significa, no solo el color. */
function Apart({ text, gap, worse, explain }: { text: string; gap: number | null; worse: "up" | "down"; explain: string }) {
  if (gap === null || gap === 0) return <span>{text}</span>
  const bad = (gap > 0 && worse === "up") || (gap < 0 && worse === "down")
  const Arrow = gap > 0 ? ArrowUp : ArrowDown
  return (
    <span className={cn("inline-flex items-center justify-end gap-0.5 font-bold", bad ? "text-warning" : "text-success")}>
      <Arrow aria-hidden className="size-3" strokeWidth={2.5} />
      {text}
      <span className="sr-only">, {explain}</span>
    </span>
  )
}

function Professionals({ data }: { data: AgendaReport }) {
  const { locale } = data
  const rows = data.professionals
  if (rows.length === 0) return null
  const passed = (row: (typeof rows)[number]) => row.attended + row.noShow + row.cancelled
  const clinicNoShow = rateOf(sum(rows, (row) => row.noShow), sum(rows, passed))
  const clinicBusy = occupied({ availMin: sum(rows, (row) => row.availMin), occMin: sum(rows, (row) => row.occMin) })
  const freeOf = (row: (typeof rows)[number]) => row.availMin - row.occMin
  const clinicWait = data.waitInRoom.medianMinutes
  const pointGap = (value: number | null, clinic: number | null) => (value === null || clinic === null || Math.abs(value - clinic) <= APART_POINTS ? null : value - clinic)
  const ratioGap = (value: number | null, clinic: number | null) =>
    value === null || clinic === null || clinic <= 0 || Math.abs(value - clinic) <= clinic * APART_MINUTES ? null : value - clinic
  const legend = `Ordenado por agenda ocupada. Las flechas marcan lo que se aparta de la clínica (más de ${APART_POINTS} puntos, o la mitad en minutos de espera)${clinicNoShow !== null ? `: no vinieron ${clinicNoShow} %` : ""}${clinicBusy !== null ? `, ocupada ${clinicBusy} %` : ""}${clinicWait !== null ? `, espera ${clinicWait} min` : ""}.`
  const row = (item: (typeof rows)[number]) => {
    const noShow = rateOf(item.noShow, passed(item))
    const busy = occupied(item)
    return {
      noShow: <Apart text={noShow === null ? "—" : `${noShow} %`} gap={pointGap(noShow, clinicNoShow)} worse="up" explain={`frente a ${clinicNoShow} % de la clínica`} />,
      // Las horas libres dependen del tamaño de cada horario: no se marcan; lo que se aparta lo dice «Agenda ocupada».
      free: <span>{item.availMin > 0 ? hoursLabel(freeOf(item), locale) : "Sin horario"}</span>,
      busy,
      busyText: <Apart text={busy === null ? "—" : `${busy} %`} gap={pointGap(busy, clinicBusy)} worse="down" explain={`frente a ${clinicBusy} % de la clínica`} />,
      wait: <Apart text={item.waitMinutes === null ? "—" : `${item.waitMinutes} min`} gap={ratioGap(item.waitMinutes, clinicWait)} worse="up" explain={`frente a ${clinicWait} min de la clínica`} />,
    }
  }
  return (
    <ReportCard title="Por profesional">
      <ul className="flex min-w-0 flex-col divide-y md:hidden">
        {rows.map((item) => {
          const cells = row(item)
          return (
            <li key={item.userId} className="flex min-w-0 flex-col gap-1 py-2.5">
              <span className="flex items-baseline justify-between gap-3">
                <span className="truncate font-semibold">{item.name}</span>
                <span className="shrink-0 font-semibold tabular-nums">{cells.busyText}</span>
              </span>
              <span aria-hidden className="h-2 overflow-hidden rounded-full bg-primary-soft">
                <span className="block h-full rounded-full bg-primary" style={{ width: `${cells.busy ?? 0}%` }} />
              </span>
              <span className="flex flex-wrap gap-x-3 text-[13px] text-muted-foreground">
                <span>{item.attended} {item.attended === 1 ? "atendida" : "atendidas"}</span>
                <span className="inline-flex gap-1">No vinieron {cells.noShow}</span>
                <span className="inline-flex gap-1">Libres {cells.free}</span>
                <span className="inline-flex gap-1">Espera {cells.wait}</span>
              </span>
            </li>
          )
        })}
      </ul>
      <div className="hidden min-w-0 md:block">
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
                Horas libres
              </TableHead>
              <TableHead scope="col" className="w-[28%]">
                Agenda ocupada
              </TableHead>
              <TableHead scope="col" className="text-right">
                Espera en sala
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((item) => {
              const cells = row(item)
              return (
                <TableRow key={item.userId}>
                  <TableHead scope="row" className="font-semibold whitespace-normal">
                    {item.name}
                  </TableHead>
                  <TableCell className="text-right tabular-nums">{item.attended}</TableCell>
                  <TableCell className="text-right tabular-nums">{cells.noShow}</TableCell>
                  <TableCell className="text-right tabular-nums">{cells.free}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2.5">
                      <span aria-hidden className="h-2 flex-1 overflow-hidden rounded-full bg-primary-soft">
                        <span className="block h-full rounded-full bg-primary" style={{ width: `${cells.busy ?? 0}%` }} />
                      </span>
                      <span className="w-14 shrink-0 text-right tabular-nums">{cells.busyText}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{cells.wait}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-[13px] text-muted-foreground">{legend}</p>
    </ReportCard>
  )
}
