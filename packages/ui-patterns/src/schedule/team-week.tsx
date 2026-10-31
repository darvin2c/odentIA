/**
 * La semana del equipo: quién tiene sitio y cuándo. Una fila por recurso y una
 * columna por día; cada día dice cuánto hay libre, reparte la jornada en una
 * barra y escribe a qué hora empieza cada hueco. Tocar un día avisa a la pantalla
 * (abre la reserva con ese recurso y ese día); aquí no se reserva nada. En el
 * teléfono, los mismos datos por día (`ScheduleTeamWeekList`).
 */

import { cn } from "@odentia/ui"

import { type DaySegment, formatSpan, freeMinutesOf } from "./occupancy.js"
import { formatDateLong, formatDayShort, hourLabel } from "./time.js"
import { ResourceAvatar } from "./tone.js"
import type { ScheduleColumn } from "./types.js"
import { ScheduleDayBar } from "./week-overview.js"

/** Horas de inicio que se escriben antes de resumir con «+2». */
const MAX_STARTS = 3

export interface ScheduleTeamDay {
  date: string
  /** Reparto de la jornada (ver `daySegments`). */
  segments: DaySegment[]
  count: number
  /** Lo que impide atender ese día («Vacaciones»); sin ello, se dice lo libre o que no atiende. */
  away?: string
  /** Hasta cuándo dura lo anterior («Hasta el viernes»). */
  awayNote?: string
}

export interface ScheduleTeamRow extends ScheduleColumn {
  days: ScheduleTeamDay[]
}

export interface ScheduleTeamWeekProps {
  rows: ScheduleTeamRow[]
  dates: string[]
  today?: string
  /** Día con la reserva abierta al lado. */
  selected?: { columnId: string; date: string } | null
  onPick: (columnId: string, date: string) => void
  /** Tocar el nombre: la semana de esa persona, por horas. */
  onResource?: (columnId: string) => void
  /** Nombre accesible de la tabla. */
  label?: string
  className?: string
}

const freeStarts = (segments: DaySegment[]) =>
  segments.filter((segment) => segment.kind === "free").map((segment) => segment.startMinutes)

/** «3 h libres», «Sin sitio», «No atiende» o el motivo de la ausencia. */
function dayHeadline(day: ScheduleTeamDay): string {
  if (day.away) return day.away
  const free = Math.floor(freeMinutesOf(day.segments) / 15) * 15
  if (free >= 15) return `${formatSpan(free)} libres`
  return day.segments.some((segment) => segment.kind !== "closed") ? "Sin sitio" : "No atiende"
}

/** «9:00, 11:15, 15:00 +1»; sin huecos, lo que aclare el día. */
function dayDetail(day: ScheduleTeamDay): string {
  if (day.away) return day.awayNote ?? ""
  const starts = freeStarts(day.segments)
  if (starts.length === 0) {
    if (day.count === 0) return ""
    return day.count === 1 ? "1 cita" : `${day.count} citas`
  }
  const shown = starts.slice(0, MAX_STARTS).map(hourLabel).join(", ")
  return starts.length > MAX_STARTS ? `${shown} +${starts.length - MAX_STARTS}` : shown
}

/** Para quien no ve la barra: todo lo libre, sin resumir. */
function dayAccessible(row: ScheduleColumn, day: ScheduleTeamDay): string {
  const starts = freeStarts(day.segments)
  const free = starts.length > 0 ? `Huecos desde las ${starts.map(hourLabel).join(", ")}. ` : ""
  return `${row.label}, ${formatDateLong(day.date)}: ${dayHeadline(day)}. ${free}Reservar`
}

const headlineTone = (day: ScheduleTeamDay) =>
  day.away
    ? "text-warning"
    : freeMinutesOf(day.segments) >= 15
      ? "text-primary-soft-foreground"
      : "text-muted-foreground"

export function ScheduleTeamWeek({
  rows,
  dates,
  today,
  selected,
  onPick,
  onResource,
  label = "Semana del equipo",
  className,
}: ScheduleTeamWeekProps) {
  return (
    <table
      aria-label={label}
      className={cn("w-full min-w-[820px] table-fixed border-separate border-spacing-0", className)}
    >
      <thead>
        <tr>
          <th
            scope="col"
            className="sticky top-0 left-0 z-20 w-48 border-b bg-card px-4 py-3 text-left text-[13px] font-bold text-muted-foreground"
          >
            Profesionales
          </th>
          {dates.map((date) => {
            const free = rows.reduce((total, row) => {
              const day = row.days.find((item) => item.date === date)
              return total + (day ? freeMinutesOf(day.segments) : 0)
            }, 0)
            const [weekday = "", number = ""] = formatDayShort(date).split(" ")
            return (
              <th
                key={date}
                scope="col"
                className="sticky top-0 z-10 border-b border-l bg-card px-3 py-2.5 text-left font-normal"
              >
                <span className="flex items-center gap-1.5 text-sm font-bold capitalize">
                  {weekday.replace(".", "")} {number}
                  {date === today ? (
                    <span className="rounded-full bg-primary px-2 text-[11px] leading-[18px] font-bold text-primary-foreground normal-case">
                      Hoy
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {free >= 15 ? `${formatSpan(Math.floor(free / 15) * 15)} libres` : "Sin sitio"}
                </span>
              </th>
            )
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const total = row.days.reduce((sum, day) => sum + freeMinutesOf(day.segments), 0)
          const name = (
            <>
              <ResourceAvatar label={row.label} tone={row.tone} />
              <span className="min-w-0">
                <span className="block text-sm leading-[18px] font-bold">{row.label}</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {total >= 15 ? `${formatSpan(Math.floor(total / 15) * 15)} libres` : "Sin sitio"}
                </span>
              </span>
            </>
          )
          return (
            <tr key={row.id}>
              <th scope="row" className="sticky left-0 z-10 border-b bg-card p-2 text-left font-normal">
                {onResource ? (
                  <button
                    type="button"
                    aria-label={`Ver la semana de ${row.label} por horas`}
                    onClick={() => onResource(row.id)}
                    className="flex w-full items-center gap-2.5 rounded-xl p-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {name}
                  </button>
                ) : (
                  <span className="flex items-center gap-2.5 p-2">{name}</span>
                )}
              </th>
              {row.days.map((day) => {
                const picked = selected?.columnId === row.id && selected.date === day.date
                return (
                  <td key={day.date} className="border-b border-l p-1 align-top">
                    <button
                      type="button"
                      aria-pressed={picked}
                      aria-label={dayAccessible(row, day)}
                      onClick={() => onPick(row.id, day.date)}
                      className={cn(
                        "flex min-h-[104px] w-full flex-col justify-center gap-1.5 rounded-xl border px-2.5 py-2 text-left outline-none transition-colors",
                        "hover:border-primary hover:bg-agent-soft focus-visible:ring-2 focus-visible:ring-ring",
                        picked ? "border-primary bg-agent-soft" : "border-transparent",
                      )}
                    >
                      <span className={cn("truncate text-sm font-bold", headlineTone(day))}>
                        {dayHeadline(day)}
                      </span>
                      <ScheduleDayBar segments={day.segments} />
                      <span className="min-h-[17px] text-xs leading-[17px] font-medium text-muted-foreground tabular-nums">
                        {dayDetail(day)}
                      </span>
                    </button>
                  </td>
                )
              })}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** La semana del equipo en el teléfono: una tarjeta por día y una fila por recurso. */
export function ScheduleTeamWeekList({
  rows,
  dates,
  today,
  onPick,
  className,
}: Pick<ScheduleTeamWeekProps, "rows" | "dates" | "today" | "onPick" | "className">) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {dates.map((date) => {
        const lines = rows.flatMap((row) => {
          const day = row.days.find((item) => item.date === date)
          return day ? [{ row, day }] : []
        })
        const attending = lines.filter(({ day }) => !day.away && day.segments.some((segment) => segment.kind !== "closed"))
        const others = lines.filter((line) => !attending.includes(line))
        const free = attending.reduce((total, { day }) => total + freeMinutesOf(day.segments), 0)
        const [weekday = "", number = ""] = formatDayShort(date).split(" ")
        return (
          <section
            key={date}
            aria-label={formatDateLong(date)}
            className="overflow-hidden rounded-2xl border bg-card"
          >
            <h2 className="flex items-center gap-2 px-3.5 py-2.5 text-[15px] font-bold capitalize">
              {weekday.replace(".", "")} {number}
              {date === today ? (
                <span className="rounded-full bg-primary px-2 text-[11px] leading-[18px] font-bold text-primary-foreground normal-case">
                  Hoy
                </span>
              ) : null}
              <span className="ml-auto text-[13px] font-bold text-primary-soft-foreground normal-case">
                {free >= 15 ? `${formatSpan(Math.floor(free / 15) * 15)} libres` : "Sin sitio"}
              </span>
            </h2>
            {attending.map(({ row, day }) => (
              <button
                key={row.id}
                type="button"
                aria-label={dayAccessible(row, day)}
                onClick={() => onPick(row.id, date)}
                className="grid min-h-13 w-full grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 border-t px-3.5 py-2.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <ResourceAvatar label={row.label} tone={row.tone} size="sm" className="row-span-3 size-8" />
                <span className="truncate text-sm font-bold">{row.label}</span>
                <span className={cn("text-[13px] font-bold whitespace-nowrap", headlineTone(day))}>
                  {dayHeadline(day)}
                </span>
                <ScheduleDayBar segments={day.segments} className="col-span-2 h-2" />
                <span className="col-span-2 text-xs leading-[17px] font-medium text-muted-foreground tabular-nums">
                  {dayDetail(day) || " "}
                </span>
              </button>
            ))}
            {others.length > 0 ? (
              <p className="border-t px-3.5 py-2.5 text-xs leading-[17px] text-muted-foreground">
                No atienden:{" "}
                {others.map(({ row, day }) => (day.away ? `${row.label} (${day.away.toLocaleLowerCase("es")})` : row.label)).join(", ")}
              </p>
            ) : null}
          </section>
        )
      })}
    </div>
  )
}
