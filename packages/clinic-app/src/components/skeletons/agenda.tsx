/**
 * Esqueleto de la Agenda, con las clases de `schedule/grid.tsx`,
 * `schedule/agenda-list.tsx`, `schedule/week-overview.tsx` y `schedule/toolbar.tsx`.
 * La pantalla decide con `SCHEDULE_SMALL_QUERY` (bajo 640 px) y aquí el mismo
 * corte va en clases `sm:`:
 * - Día: columnas por profesional; en el teléfono una sola y sin cabecera.
 * - Semana: siete columnas; en el teléfono, la lista de días con su barra.
 * - Lista: las fichas por estado y una fila por cita.
 */
import { ParamTabs } from "./param-tabs"
import { buttonVariants, cn, ScrollArea, Skeleton, Tabs, TabsList, TabsTrigger } from "@odentia/ui"
import { PageHeader, PageShell, ScheduleOccupancyLegend, SkeletonRegion, useListSearch } from "@odentia/ui-patterns"
import { ChevronLeft, ChevronRight } from "lucide-react"
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

function GridSkeleton({ lanes, day }: { lanes: number; day: boolean }) {
  const laneList = Array.from({ length: lanes }, (_, index) => index)
  return (
    <section
      className={cn(
        "elevated flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-card",
        // El alto de una hora en cada ancho (`hourHeight` de la Agenda).
        day ? "[--agenda-hour:88px] sm:[--agenda-hour:72px]" : "[--agenda-hour:96px] max-sm:hidden",
      )}
    >
      {/* Mismo ancho mínimo que la rejilla: lo que no cabe se corta en vez de desplazarse. */}
      <div className={cn("flex min-h-0 w-full flex-1 flex-col", day ? "sm:min-w-[564px]" : "min-w-[984px]")}>
        <div className={cn("flex shrink-0 border-b bg-card", day && "max-sm:hidden")}>
          <div className="shrink-0" style={GUTTER} />
          {laneList.map((lane) => (
            <div
              key={lane}
              className={cn(
                "flex min-w-0 flex-1 basis-0 items-center gap-2.5 border-l px-3 py-2.5",
                day && lane > 0 && "max-sm:hidden",
              )}
            >
              {day ? <Skeleton className="size-9 shrink-0 rounded-full" /> : null}
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
            <div key={lane} className={cn("relative min-w-0 flex-1 basis-0 border-l", day && lane > 0 && "max-sm:hidden")}>
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

/** La semana en el teléfono (`ScheduleWeekOverview`): una tarjeta por día. */
function WeekOverviewSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden sm:hidden">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <ScheduleOccupancyLegend className="flex-1" />
          <Skeleton className="h-3 w-20 shrink-0" />
        </div>
        <ul className="flex flex-col gap-2">
          {[0, 1, 2, 3, 4, 5].map((day) => (
            <li key={day} className="flex w-full flex-col gap-2.5 rounded-2xl border bg-card px-3.5 py-3">
              <span className="flex w-full items-center gap-2">
                <Skeleton className="my-1 h-3.5 w-14 shrink-0" />
                <Skeleton className="h-3 w-12" />
                <span className="flex-1" />
                <Skeleton className="h-3.5 w-16 shrink-0" />
              </span>
              <Skeleton className="h-3 w-full rounded-full" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** Los estados fijos de `ScheduleStatusSummary`: su cuenta es lo que espera. */
const TILES = ["Todas", "Por confirmar", "Confirmadas", "Atendidas"]

function ListSkeleton() {
  return (
    <ScrollArea className="-mr-2 min-h-0 flex-1">
      <div className="flex flex-col gap-3 pr-2">
        <div className="flex min-w-0 shrink-0 gap-2.5 overflow-x-auto [scrollbar-width:none] sm:grid sm:grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] sm:overflow-visible [&::-webkit-scrollbar]:hidden">
          {TILES.map((label) => (
            <div
              key={label}
              className="flex h-[68px] min-w-36 shrink-0 items-center gap-3 rounded-2xl border bg-card px-3.5 sm:min-w-0"
            >
              <Skeleton className="size-[38px] shrink-0 rounded-full" />
              <span className="flex flex-col">
                <Skeleton className="h-6 w-8" />
                <span className="text-[13px] text-muted-foreground">{label}</span>
              </span>
            </div>
          ))}
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
        <WeekOverviewSkeleton />
        <GridSkeleton lanes={7} day={false} />
      </>
    )
  }
  return <GridSkeleton lanes={3} day />
}

/** Los rótulos de `VIEWS` en `routes/_org/agenda.tsx`. */
const VIEWS: Array<{ id: AgendaSkeletonView; label: string }> = [
  { id: "dia", label: "Día" },
  { id: "semana", label: "Semana" },
  { id: "lista", label: "Lista" },
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
          <>
            <Skeleton className="h-4 w-28" />
            {/* El buscador de citas: en el teléfono, solo el ícono. */}
            <Skeleton className="size-9 rounded-full sm:h-9 sm:w-62" />
          </>
        }
      />
      <SkeletonRegion message="Cargando agenda…" className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
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
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <span className="flex h-9 items-center">
              <Skeleton className="h-5 w-52 max-w-full" />
            </span>
            {week ? null : <Skeleton className="h-3.5 w-14" />}
          </div>
          <ParamTabs param="view" fallback="dia" value={view} className="max-sm:w-full sm:ml-auto">
            <TabsList aria-label="Vista de la agenda" className="max-sm:w-full">
              {VIEWS.map((option) => (
                <TabsTrigger key={option.id} value={option.id} className="max-sm:h-10">
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </ParamTabs>
          <div className="flex min-w-0 items-center gap-2 max-sm:hidden">
            <Skeleton className="h-9 w-44 rounded-full" />
          </div>
        </div>
        {/* En el teléfono, el botón que abre los días y los profesionales. */}
        <Skeleton className="h-11 w-full shrink-0 rounded-full sm:hidden" />
        <AgendaSkeleton view={view} />
      </SkeletonRegion>
    </PageShell>
  )
}
