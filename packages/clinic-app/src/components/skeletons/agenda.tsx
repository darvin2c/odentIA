/**
 * Esqueleto de la Agenda, con las clases de `schedule/grid.tsx`,
 * `schedule/agenda-list.tsx`, `schedule/team-week.tsx` y `schedule/toolbar.tsx`.
 * La pantalla decide con `SCHEDULE_SMALL_QUERY` (bajo 640 px) y aquí el mismo
 * corte va en clases `sm:`:
 * - Día: columnas por profesional; en el teléfono una sola y sin cabecera.
 * - Semana: una fila por profesional; en el teléfono, una tarjeta por día.
 * - Agenda: los filtros por estado y las citas bajo el encabezado de su día.
 */
import { ParamTabs } from "./param-tabs"
import { buttonVariants, cn, ScrollArea, Skeleton, TabsList, TabsTrigger } from "@odentia/ui"
import { PageHeader, PageShell, ScheduleOccupancyLegend, SkeletonRegion, useListSearch } from "@odentia/ui-patterns"
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, ListChecks } from "lucide-react"
import type { CSSProperties } from "react"
import { useCan } from "../../lib/crm"
import { agendaHeader } from "../../lib/screen-rules"

export type AgendaSkeletonView = "dia" | "semana" | "lista"

/** El ancho de la columna de las horas (`GUTTER_PX` de `ScheduleGrid`). */
const GUTTER = { width: 60 }
const HOURS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
/** Citas de relleno: desde qué hora y cuánto duran. */
const LANE_BLOCKS = [
  [
    { at: 0.5, span: 1 },
    { at: 2, span: 0.75 },
    { at: 4.25, span: 1.25 },
  ],
  [
    { at: 1, span: 1.5 },
    { at: 3.5, span: 1 },
    { at: 5, span: 0.75 },
  ],
  [
    { at: 0, span: 0.75 },
    { at: 2.5, span: 1 },
    { at: 4, span: 1.5 },
  ],
]

const atHour = (hours: number): string => `calc(var(--agenda-hour) * ${hours})`

function GridSkeleton({ lanes }: { lanes: number }) {
  const laneList = Array.from({ length: lanes }, (_, index) => index)
  return (
    <section
      className={cn(
        "elevated flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-card",
        // El alto de una hora en cada ancho (`hourHeight` de la Agenda).
        "[--agenda-hour:88px] sm:[--agenda-hour:72px]",
      )}
    >
      {/* Mismo ancho mínimo que la rejilla: lo que no cabe se corta en vez de desplazarse. */}
      <div className="flex min-h-0 w-full flex-1 flex-col sm:min-w-[564px]">
        <div className="flex shrink-0 border-b bg-card max-sm:hidden">
          <div className="shrink-0" style={GUTTER} />
          {laneList.map((lane) => (
            <div key={lane} className="flex min-w-0 flex-1 basis-0 items-center gap-2.5 border-l px-3 py-2.5">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            </div>
          ))}
        </div>
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0" style={{ left: GUTTER.width }}>
            {HOURS.map((hour) => (
              <div key={hour} className="absolute inset-x-0 border-t border-border/60" style={{ top: atHour(hour) }} />
            ))}
          </div>
          <div className="relative shrink-0 bg-card" style={GUTTER}>
            {HOURS.map((hour) => (
              <Skeleton
                key={hour}
                className={cn("absolute right-2.5 h-3 w-9", hour === 0 ? "mt-1" : "-translate-y-1/2")}
                style={{ top: atHour(hour) }}
              />
            ))}
          </div>
          {laneList.map((lane) => (
            <div key={lane} className={cn("relative min-w-0 flex-1 basis-0 border-l", lane > 0 && "max-sm:hidden")}>
              {(LANE_BLOCKS[lane % LANE_BLOCKS.length] ?? []).map((block) => {
                const style: CSSProperties = { top: atHour(block.at), height: atHour(block.span) }
                return <Skeleton key={block.at} className="absolute inset-x-1.5 rounded-[10px]" style={style} />
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/** La semana del equipo en escritorio (`ScheduleTeamWeek`): una fila por profesional. */
function TeamWeekSkeleton() {
  const days = [0, 1, 2, 3, 4, 5]
  return (
    <section className="elevated flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-card max-sm:hidden">
      <div className="flex shrink-0 border-b">
        <div className="w-48 shrink-0 px-4 py-3 text-[13px] font-bold text-muted-foreground">Profesionales</div>
        {days.map((day) => (
          <div key={day} className="flex min-w-0 flex-1 basis-0 flex-col gap-1.5 border-l px-3 py-2.5">
            <Skeleton className="h-3.5 w-14" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex border-b">
            <div className="flex w-48 shrink-0 items-center gap-2.5 p-4">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            </div>
            {days.map((day) => (
              <div key={day} className="flex min-h-28 min-w-0 flex-1 basis-0 flex-col justify-center gap-2 border-l px-3.5">
                <Skeleton className="h-3.5 w-16" />
                <Skeleton className="h-3 w-full rounded-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}

/** La semana del equipo en el teléfono (`ScheduleTeamWeekList`): una tarjeta por día. */
function TeamWeekListSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden sm:hidden">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <ScheduleOccupancyLegend className="flex-1" />
          <Skeleton className="h-3 w-20 shrink-0" />
        </div>
        {[0, 1, 2].map((day) => (
          <section key={day} className="overflow-hidden rounded-2xl border bg-card">
            <div className="flex items-center justify-between px-3.5 py-3">
              <Skeleton className="h-3.5 w-14" />
              <Skeleton className="h-3.5 w-16" />
            </div>
            {[0, 1].map((row) => (
              <div key={row} className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5 border-t px-3.5 py-2.5">
                <Skeleton className="row-span-2 size-8 rounded-full" />
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-2 w-full rounded-full" />
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

/** Los estados fijos de `ScheduleStatusSummary`: su cuenta es lo que espera. */
const CHIPS = ["Por confirmar", "Confirmadas", "Atendidas"]

function ListSkeleton() {
  return (
    <ScrollArea className="-mr-2 min-h-0 flex-1">
      <div className="flex flex-col gap-2 pr-2">
        <div className="flex items-center gap-3 border-b py-2 sm:gap-3.5">
          <Skeleton className="size-12 shrink-0 rounded-xl sm:size-14" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-36" />
          </div>
        </div>
        <ul className="flex flex-col gap-2">
          {[0, 1, 2, 3, 4, 5, 6].map((row) => (
            <li
              key={row}
              className="relative flex min-h-16 items-center gap-3 rounded-2xl bg-muted/50 py-2 pr-2 pl-4 sm:gap-4"
            >
              <div className="flex w-14 shrink-0 flex-col gap-1.5 sm:w-20">
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-3 w-9" />
              </div>
              <Skeleton className="size-7 shrink-0 rounded-full sm:hidden" />
              <div className="flex min-w-0 flex-[1.3] flex-col gap-1.5">
                <Skeleton className={cn("h-3.5", row % 2 === 0 ? "w-3/4" : "w-3/5")} />
                <Skeleton className={cn("h-3", row % 2 === 0 ? "w-1/2" : "w-2/3")} />
              </div>
              <div className="hidden min-w-0 flex-1 items-center gap-2.5 sm:flex">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
              <span className="hidden shrink-0 items-center gap-1.5 sm:flex sm:w-44">
                <Skeleton className="size-4 shrink-0 rounded-full" />
                <Skeleton className="h-3.5 w-24" />
              </span>
              <div className="flex shrink-0 items-center justify-end gap-1 sm:w-44">
                <Skeleton className="h-10 w-24 rounded-full" />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </ScrollArea>
  )
}

/** Lo que va bajo la barra de la Agenda; se apoya en un contenedor `flex min-h-0 flex-1 flex-col`. */
export function AgendaSkeleton({ view }: { view: AgendaSkeletonView }) {
  if (view === "lista") return <ListSkeleton />
  if (view === "semana") {
    return (
      <>
        <TeamWeekListSkeleton />
        <TeamWeekSkeleton />
      </>
    )
  }
  return <GridSkeleton lanes={3} />
}

/** Los rótulos de `VIEWS` en `routes/_org/agenda.tsx`. */
const VIEWS: Array<{ id: AgendaSkeletonView; label: string; icon: React.ReactNode }> = [
  { id: "dia", label: "Día", icon: <CalendarDays aria-hidden /> },
  { id: "semana", label: "Semana", icon: <CalendarRange aria-hidden /> },
  { id: "lista", label: "Agenda", icon: <ListChecks aria-hidden /> },
]

export function AgendaPageSkeleton() {
  const { get } = useListSearch()
  const param = get("view")
  const view: AgendaSkeletonView = param === "semana" || param === "lista" ? param : "dia"
  const week = view === "semana"
  const can = useCan()
  return (
    <PageShell fill className="gap-3 text-foreground">
      <PageHeader
        title="Agenda"
        {...agendaHeader(can)}
        subtitle={
          <span className="contents sm:hidden">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="size-9 rounded-full" />
          </span>
        }
      />
      <SkeletonRegion message="Cargando agenda…" className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-2">
          <Skeleton className="h-4 w-28 max-sm:hidden" />
          {/* En el teléfono las flechas quedan solo en Semana; «Hoy», solo desde `sm`. */}
          <div aria-hidden className={cn("flex shrink-0 items-center gap-1", !week && "max-sm:hidden")}>
            <span className={buttonVariants({ variant: "outline", size: "icon" })}>
              <ChevronLeft />
            </span>
            <span className={cn(buttonVariants({ variant: "outline" }), "max-sm:hidden")}>Hoy</span>
            <span className={buttonVariants({ variant: "outline", size: "icon" })}>
              <ChevronRight />
            </span>
          </div>
          <div className="flex min-w-0 flex-1 basis-0 items-center gap-x-2 overflow-hidden p-0.5 sm:min-w-60">
            {view === "lista" ? (
              <span className="flex gap-1.5 max-sm:hidden">
                {CHIPS.map((label) => (
                  <span key={label} className="flex h-9 items-center gap-2 rounded-full border bg-card px-3 text-sm font-semibold">
                    <Skeleton className="size-4 rounded-full" />
                    {label}
                  </span>
                ))}
              </span>
            ) : null}
            <span className={cn("flex h-9 items-center", view === "lista" && "sm:hidden")}>
              <Skeleton className="h-5 w-40 max-w-full sm:w-52" />
            </span>
            {view === "dia" ? <Skeleton className="h-3.5 w-14 max-sm:hidden" /> : null}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Skeleton className="size-9 rounded-full max-sm:hidden" />
            {week ? null : <Skeleton className="h-9 w-32 rounded-full max-sm:hidden" />}
            <ParamTabs param="view" fallback="dia" clear={["status"]} value={view}>
              <TabsList aria-label="Vista de la agenda">
                {VIEWS.map((option) => (
                  <TabsTrigger key={option.id} value={option.id} className="px-2 sm:px-2.5">
                    <span className="contents max-sm:hidden">{option.icon}</span>
                    {option.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </ParamTabs>
          </div>
        </div>
        {/* En el teléfono, la tira de días y debajo los profesionales o los filtros. */}
        {week ? null : (
          <div className="flex shrink-0 flex-col gap-2 sm:hidden">
            <Skeleton className="h-[54px] w-full rounded-lg" />
            <Skeleton className="h-11 w-full rounded-full" />
          </div>
        )}
        <AgendaSkeleton view={view} />
      </SkeletonRegion>
    </PageShell>
  )
}
