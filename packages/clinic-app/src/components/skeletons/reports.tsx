/**
 * Los esqueletos de Reportes: uno por pestaña, con sus secciones en el mismo
 * orden y las mismas clases que la pantalla, para que en cada ancho quede igual.
 * Lo que no depende de los datos (títulos de tarjeta, rótulos de tabla) se pinta
 * real; un título que cambia con el periodo o el producto queda en barra. El
 * esqueleto de cada pieza que se carga sola (embudo, comisiones, Lo que viene…)
 * también lo usa esa pieza mientras espera.
 */
import { seesBilling } from "@odentia/auth/permissions"
import { cn, Skeleton, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { Bot } from "lucide-react"
import type { ReactNode } from "react"
import { useMyRole, usePermission } from "../../lib/crm"
import { TextLine, TextLines, useSearchValue } from "./list-bar"
import { PageLoading } from "./page-loading"

type ReportTabKey = "resumen" | "finanzas" | "pacientes" | "agenda" | "agente"

const TABS: Array<{ key: ReportTabKey; title: string; question: string }> = [
  { key: "resumen", title: "Resumen", question: "Cómo va el negocio" },
  { key: "finanzas", title: "Finanzas", question: "Cuánto entró, cuánto se gastó y cuánto falta cobrar" },
  { key: "pacientes", title: "Pacientes", question: "Quiénes nos buscaron, hasta dónde llegaron y si vuelven" },
  { key: "agenda", title: "Agenda", question: "Si los pacientes vinieron y quién los atendió" },
  { key: "agente", title: "Agente", question: "Lo que hizo el agente, lo que pagaste por él y cómo respondimos a quien escribió" },
]

/** Los nombres de antes siguen abriendo su pestaña, como en la pantalla. */
const LEGACY_TABS: Record<string, ReportTabKey> = { dinero: "finanzas", ventas: "pacientes", atencion: "agente" }

const FIGURES_FOUR = "grid min-w-0 gap-3.5 @xl:grid-cols-2 @5xl:grid-cols-4"

function times(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index)
}

// --- Las tarjetas ---------------------------------------------------------------------------

/** `ReportCard` sin datos: su título real, o una barra si cambia con el periodo. */
function CardShell({ title, titleWidth = "w-48", note, action, className, children }: { title?: string; titleWidth?: string; note?: ReactNode; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn("elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-[18px]", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {title ? <h3 className="font-semibold">{title}</h3> : <TextLine width={titleWidth} height="h-6" bar="h-4" />}
        {note}
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

/** Lo que la pantalla escribe bajo un título con `-mt-2`: una frase que sale de los datos. */
function Insight({ widths = ["w-full max-w-xl"], className = "-mt-2" }: { widths?: string[]; className?: string }) {
  return <TextLines widths={widths} className={className} />
}

/** `SummaryFigure`: rótulo, valor con su línea de 12 meses, comparación, detalle y pie. */
function SummaryFigureSkeleton({ title, icon, goal = false, footer = true, detail = true }: { title?: string; icon?: ReactNode; goal?: boolean; footer?: boolean; detail?: boolean }) {
  return (
    <div className="elevated flex min-w-0 flex-col gap-1 rounded-xl border bg-card px-[18px] py-4">
      {title ? (
        <h3 className="flex items-center gap-1.5 text-[13px] font-bold text-muted-foreground">
          {icon}
          {title}
        </h3>
      ) : (
        <TextLine width="w-44" />
      )}
      <div className="flex min-w-0 items-end justify-between gap-3">
        <Skeleton className="h-9 min-w-0 flex-1 max-w-32" />
        <Skeleton className="h-9 w-[120px] shrink-0" />
      </div>
      <TextLine width="w-40" />
      {detail ? <TextLine width="w-48" /> : null}
      {goal ? (
        <div className="flex min-w-0 flex-col gap-1 pt-1.5">
          <Skeleton className="h-2 w-full rounded-full" />
          <TextLine width="w-56" />
        </div>
      ) : null}
      {footer ? (
        <div className="mt-auto pt-1.5">
          <div className="flex h-11 items-center sm:h-8">
            <Skeleton className="h-3.5 w-24" />
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** `Figure`: rótulo, valor, comparación, nota y su enlace. */
function FigureSkeleton({ title, note, footer = true, extra }: { title?: string; note?: string; footer?: boolean; extra?: ReactNode }) {
  return (
    <div className="elevated flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card px-[18px] py-4">
      {title ? <span className="text-[13px] font-semibold text-muted-foreground">{title}</span> : <TextLine width="w-44" />}
      <Skeleton className="h-8 w-24" />
      <TextLine width="w-40" />
      {note ? <span className="text-[13px] text-muted-foreground">{note}</span> : <TextLine width="w-52" />}
      {extra}
      {footer ? (
        <div className="flex h-11 items-center sm:h-8">
          <Skeleton className="h-3.5 w-24" />
        </div>
      ) : null}
    </div>
  )
}

/** Una cifra chica sobre fondo suave, dentro de una tarjeta. */
function TileSkeleton({ title, tone = "muted", value = "h-7", detail = true }: { title?: string; tone?: "muted" | "warning"; value?: string; detail?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-0.5 rounded-xl px-3.5 py-3", tone === "warning" ? "bg-warning-soft" : "bg-muted/50")}>
      {title ? <span className={cn("text-[13px] font-bold", tone === "warning" ? "text-warning" : "text-muted-foreground")}>{title}</span> : <TextLine width="w-36" />}
      <Skeleton className={cn("w-24", value)} />
      {detail ? <TextLine width="w-32" /> : null}
    </div>
  )
}

// --- Los gráficos ---------------------------------------------------------------------------

const COLUMN_HEIGHTS = [38, 52, 44, 60, 48, 66, 58, 72, 64, 80, 70, 50]

/** `ColumnChart`: eje, columnas, meses, leyenda y «Ver como tabla», en sus 200 px. */
export function ColumnChartSkeleton({ legend = 0, columns = 12 }: { legend?: number; columns?: number }) {
  const shown = COLUMN_HEIGHTS.slice(0, columns)
  const gridTemplateColumns = `repeat(${shown.length}, minmax(0, 1fr))`
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 gap-2">
        <div className="flex h-[200px] w-12 shrink-0 flex-col items-end justify-between py-0.5">
          {times(4).map((tick) => (
            <Skeleton key={tick} className="h-3 w-8" />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="grid h-[200px] items-end border-b border-input" style={{ gridTemplateColumns }}>
            {shown.map((height, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: columnas de relleno, siempre las mismas.
              <div key={index} className="flex h-full items-end justify-center px-[12%]">
                <Skeleton className="w-full rounded-b-none" style={{ height: `${height}%` }} />
              </div>
            ))}
          </div>
          <div className="grid" style={{ gridTemplateColumns }}>
            {shown.map((_, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rótulos de relleno, siempre los mismos.
              <div key={index} className="flex h-4 justify-center px-[12%]">
                <Skeleton className="h-3 w-full max-w-7" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <ChartFooter legend={legend} />
    </div>
  )
}

function ChartFooter({ legend = 0 }: { legend?: number }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
      {legend > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {times(legend).map((item) => (
            <Skeleton key={item} className="h-3.5 w-20" />
          ))}
        </div>
      ) : (
        <span />
      )}
      <div className="flex h-11 items-center sm:h-8">
        <Skeleton className="h-3.5 w-24" />
      </div>
    </div>
  )
}

const CASCADE_STEPS = [
  { bottom: 0, height: 92 },
  { bottom: 74, height: 18 },
  { bottom: 56, height: 18 },
  { bottom: 44, height: 12 },
  { bottom: 36, height: 8 },
  { bottom: 0, height: 36 },
]

/** El panel de detalle de `WaterfallChart` y `HeatmapGrid`. */
function DetailBox() {
  return (
    <div className="flex min-w-60 flex-[0_1_300px] flex-col gap-1.5 rounded-xl border bg-muted/50 p-4">
      <TextLine width="w-3/5" />
      <Skeleton className="h-8 w-2/5" />
      <TextLine width="w-1/2" />
      <TextLines widths={["w-full", "w-11/12", "w-2/3"]} />
    </div>
  )
}

/** `WaterfallChart`: las barras escalonadas en 260 px y su detalle al lado; lo que no cabe se recorta, sin desbordar. */
function WaterfallSkeleton() {
  const gridTemplateColumns = `repeat(${CASCADE_STEPS.length}, minmax(0, 1fr))`
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-start gap-4">
        <div className="min-w-0 flex-[1_1_480px] overflow-hidden">
          <div className="flex gap-2 pt-2 pb-2">
            <div className="flex h-[260px] w-12 shrink-0 flex-col items-end justify-between">
              {times(4).map((tick) => (
                <Skeleton key={tick} className="h-3 w-8" />
              ))}
            </div>
            <div className="flex flex-1 flex-col gap-1.5" style={{ minWidth: `${CASCADE_STEPS.length * 4.75}rem` }}>
              <div className="relative grid h-[260px] border-b border-input" style={{ gridTemplateColumns }}>
                {CASCADE_STEPS.map((step, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: barras de relleno, siempre las mismas.
                  <div key={index} className="relative h-full">
                    <Skeleton className="absolute inset-x-[14%] rounded-sm" style={{ bottom: `${step.bottom}%`, height: `${step.height}%` }} />
                  </div>
                ))}
              </div>
              <div className="grid" style={{ gridTemplateColumns }}>
                {CASCADE_STEPS.map((_, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rótulos de relleno, siempre los mismos.
                  <div key={index} className="flex h-4 justify-center">
                    <Skeleton className="h-3 w-14" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <DetailBox />
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <TextLine width="w-72" />
        <div className="flex h-11 items-center sm:h-8">
          <Skeleton className="h-3.5 w-24" />
        </div>
      </div>
    </div>
  )
}

/** `HeatmapGrid` en «Día a día»: leyenda, una fila por día con casillas de 16 px y su detalle. */
function HeatmapSkeleton() {
  const columns = 53
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Skeleton className="h-3.5 w-8" />
        {times(5).map((step) => (
          <Skeleton key={step} className="h-3 w-5 rounded-[3px]" />
        ))}
        <Skeleton className="h-3.5 w-12" />
        <Skeleton className="ml-2.5 h-3 w-5 rounded-[3px]" />
        <Skeleton className="h-3.5 w-28" />
      </div>
      <div className="flex min-w-0 flex-wrap items-start gap-4">
        <div className="min-w-0 flex-[1_1_480px] overflow-hidden pb-2">
          <div className="grid min-w-fit gap-[3px]" style={{ gridTemplateColumns: `36px repeat(${columns}, minmax(10px, 1fr))` }}>
            <span />
            {times(columns).map((column) => (
              <span key={column} className="h-4" />
            ))}
            {times(6).map((row) => (
              <div key={row} className="contents">
                <span className="flex items-center pr-1">
                  <Skeleton className="h-2.5 w-6" />
                </span>
                {times(columns).map((column) => (
                  <Skeleton key={column} className="h-4 rounded-[3px]" />
                ))}
              </div>
            ))}
          </div>
        </div>
        <DetailBox />
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <TextLine width="w-72" />
        <div className="flex h-11 items-center sm:h-8">
          <Skeleton className="h-3.5 w-24" />
        </div>
      </div>
    </div>
  )
}

const FUNNEL_WIDTHS = ["100%", "72%", "54%", "40%", "28%", "20%"]

/** `BarList`: nombre, barra (debajo en el teléfono) y valor, en las mismas columnas. */
function BarListSkeleton({ rows = 6, size = "md", between = false }: { rows?: number; size?: "md" | "sm"; between?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ul className="flex min-w-0 flex-col">
        {times(rows).map((row) => (
          <li key={row} className="flex min-w-0 flex-col">
            <div
              className={cn(
                "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-1.5 px-1.5",
                size === "sm" ? "py-1.5 sm:grid-cols-[minmax(6.5rem,10rem)_minmax(0,1fr)_minmax(5rem,auto)]" : "py-2 sm:grid-cols-[minmax(8rem,13rem)_minmax(0,1fr)_minmax(6.5rem,auto)]",
              )}
            >
              <span className="flex min-w-0 flex-col">
                <TextLine width="w-28" />
                {size === "md" ? <TextLine width="w-40" height="hidden h-4 sm:flex" bar="h-3" /> : null}
              </span>
              <span className={cn("col-span-2 row-start-2 block sm:col-span-1 sm:col-start-2 sm:row-start-1", size === "md" ? "h-6" : "h-4")}>
                <Skeleton className="h-full rounded-l-none" style={{ width: FUNNEL_WIDTHS[row % FUNNEL_WIDTHS.length] }} />
              </span>
              <span className="justify-self-end sm:col-start-3">
                <Skeleton className={cn("w-16", size === "md" ? "h-6" : "h-5")} />
              </span>
            </div>
            {between && row < rows - 1 ? (
              row === 1 ? (
                <Skeleton className="my-1 h-11 rounded-lg sm:ml-[14.25rem] sm:h-9" />
              ) : (
                <div className="flex items-center py-0.5 pl-3 sm:ml-[14.25rem] sm:pl-1">
                  <Skeleton className="my-[3px] h-3.5 w-44" />
                </div>
              )
            ) : null}
          </li>
        ))}
      </ul>
      <ChartFooter />
    </div>
  )
}

/** `ShareBar`: la barra repartida y, debajo, cada parte. */
function ShareBarSkeleton({ parts = 3 }: { parts?: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <Skeleton className="h-3.5 rounded-full" />
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        {times(parts).map((part) => (
          <TextLine key={part} width="w-28" />
        ))}
      </div>
    </div>
  )
}

/** `BarRows`: nombre e importe y su barra fina debajo. */
function BarRowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <ul className="flex min-w-0 flex-col gap-2.5">
      {times(rows).map((row) => (
        <li key={row} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <TextLine width="w-2/5" className="flex-1" />
            <Skeleton className="h-3.5 w-16 shrink-0" />
          </div>
          <Skeleton className="h-1.5 rounded-full" style={{ width: `${100 - row * 15}%` }} />
        </li>
      ))}
    </ul>
  )
}

// --- Resumen --------------------------------------------------------------------------------

/** Las seis cifras del Resumen. */
export function SummaryFiguresSkeleton() {
  return (
    <div className="grid min-w-0 gap-3.5 @xl:grid-cols-2 @4xl:grid-cols-3">
      <SummaryFigureSkeleton title="Cobrado" goal />
      <SummaryFigureSkeleton title="Pacientes nuevos" goal detail={false} />
      <SummaryFigureSkeleton title="Aceptaron su presupuesto" />
      <SummaryFigureSkeleton title="No vinieron" />
      <SummaryFigureSkeleton title="Citas que agendó el agente" icon={<Bot aria-hidden className="size-3.5 shrink-0" />} />
      <SummaryFigureSkeleton />
    </div>
  )
}

/** «Cobrado por mes»: el título sigue al tramo del periodo. */
export function CollectedChartSkeleton() {
  return (
    <CardShell note={<Skeleton className="h-3.5 w-8" />}>
      <Insight />
      <ColumnChartSkeleton legend={2} />
    </CardShell>
  )
}

/** Lo que va bajo el título de «Dónde se caen los pacientes» en el Resumen. */
export function FunnelBodySkeleton() {
  return (
    <>
      <TextLines widths={["w-full", "w-3/5"]} className="-mt-1.5" />
      <BarListSkeleton size="sm" />
      <Skeleton className="h-11 rounded-lg sm:h-9" />
    </>
  )
}

function FunnelCardSkeleton() {
  return (
    <section className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-[18px]">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-semibold">Dónde se caen los pacientes</h3>
        <span className="inline-flex min-h-11 items-center text-[13px] font-bold text-primary-soft-foreground sm:min-h-6">Ver el embudo</span>
      </div>
      <FunnelBodySkeleton />
    </section>
  )
}

/** «Por profesional» del Resumen: filas en el teléfono y tabla desde `sm`, como la pantalla. */
export function ProfessionalsBodySkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <>
      <ul className="flex min-w-0 flex-col divide-y sm:hidden">
        {times(rows).map((row) => (
          <li key={row} className="flex min-w-0 flex-col gap-0.5 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <TextLine width="w-36" height="h-6" />
              <Skeleton className="h-4 w-16 shrink-0" />
            </div>
            <div className="flex flex-wrap gap-x-3">
              <TextLine width="w-20" />
              <TextLine width="w-28" />
              <TextLine width="w-24" />
              <TextLine width="w-24" />
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden min-w-0 sm:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Profesional</TableHead>
              {["Atendidas", "No vinieron", "Aceptaron", "Ocupado", "Cobrado"].map((label) => (
                <TableHead key={label} scope="col" className="text-right">
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {times(rows).map((row) => (
              <TableRow key={row}>
                <TableCell>
                  <TextLine width="w-36" />
                </TableCell>
                {times(5).map((cell) => (
                  <TableCell key={cell}>
                    <div className="flex h-5 items-center justify-end">
                      <Skeleton className="h-3.5 w-10" />
                    </div>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <TextLines widths={["w-full", "w-3/5"]} />
    </>
  )
}

/** Las respuestas fijadas: tarjetas con su frase, su gráfico chico y su pie. */
export function PinnedGridSkeleton() {
  return (
    <div className="grid min-w-0 gap-3.5 @3xl:grid-cols-2">
      {times(2).map((card) => (
        <div key={card} className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-[18px]">
          <TextLine width="w-48" height="h-6" bar="h-4" />
          <TextLines widths={["w-full", "w-3/4"]} />
          <Skeleton className="h-40 w-full" />
          <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
            <TextLine width="w-44" height="h-4" bar="h-3" />
            <Skeleton className="h-11 w-16 sm:h-8" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** La pestaña Resumen entera, para cuando todavía no llegó su código. */
export function SummaryTabSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SummaryFiguresSkeleton />
      <CollectedChartSkeleton />
      <div className="flex min-w-0 flex-wrap gap-4">
        <div className="flex min-w-0 flex-[1.5_1_30rem] flex-col *:flex-1">
          <FunnelCardSkeleton />
        </div>
        <div className="flex min-w-0 flex-[1_1_22.5rem] flex-col *:flex-1">
          <CardShell titleWidth="w-36">
            <TextLines widths={["w-full", "w-11/12", "w-3/4"]} />
          </CardShell>
        </div>
      </div>
      <CardShell title="Por profesional" action={<Skeleton className="h-11 w-28 sm:h-8" />}>
        <ProfessionalsBodySkeleton />
      </CardShell>
      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="font-semibold">Fijadas</h3>
          <TextLine width="w-96" />
        </div>
        <PinnedGridSkeleton />
      </section>
      <CardShell title="El resumen del lunes">
        <div className="flex min-w-0 items-start gap-3">
          <TextLines widths={["w-full", "w-11/12", "w-2/3"]} className="flex-1" />
          <Skeleton className="h-5 w-8 shrink-0 rounded-full" />
        </div>
      </CardShell>
    </div>
  )
}

// --- Finanzas -------------------------------------------------------------------------------

function FinanceCardSkeleton({ title, highlight = false, lines = 2 }: { title?: string; highlight?: boolean; lines?: number }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 rounded-xl px-[18px] py-4", highlight ? "border-[1.5px] border-primary bg-primary-soft" : "elevated border bg-card")}>
      {title ? <h3 className="text-[13px] font-bold text-muted-foreground">{title}</h3> : <TextLine width="w-36" />}
      <Skeleton className="h-9 w-3/5" />
      <TextLines widths={["w-4/5", "w-3/5", "w-1/2"].slice(0, lines)} gap="gap-1" />
    </div>
  )
}

/** Lo que va bajo el encabezado de Comisiones: las tres cifras, la leyenda y la tabla o las filas. */
export function CommissionsBodySkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <>
      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <TileSkeleton />
        <TileSkeleton title="Ya pagadas" />
        <TileSkeleton title="Por pagar" tone="warning" />
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-foreground/80">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded-[3px] bg-series-2" />
          Comisión
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded-[3px] bg-series-1" />
          Le queda a la clínica
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="size-3 rounded-[3px] bg-secondary" />
          Atendido sin cobrar
        </li>
      </ul>
      <ul className="flex min-w-0 flex-col divide-y md:hidden">
        {times(rows).map((row) => (
          <li key={row} className="flex min-w-0 flex-col gap-1.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <TextLine width="w-36" height="h-6" />
              <Skeleton className="h-4 w-16 shrink-0" />
            </div>
            <div className="flex flex-wrap gap-x-3">
              <TextLine width="w-24" />
              <TextLine width="w-24" />
              <TextLine width="w-10" />
              <TextLine width="w-24" />
            </div>
            <Skeleton className="h-3.5 w-4/5 rounded" />
          </li>
        ))}
      </ul>
      <div className="hidden min-w-0 md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Profesional</TableHead>
              {["Atendió", "Se cobró", "%", "Comisión", "Por pagar"].map((label) => (
                <TableHead key={label} scope="col" className="text-right">
                  {label}
                </TableHead>
              ))}
              <TableHead scope="col" className="w-[30%]">
                Cómo se reparte lo que atendió
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {times(rows).map((row) => (
              <TableRow key={row}>
                <TableCell>
                  <TextLine width="w-36" />
                </TableCell>
                {times(5).map((cell) => (
                  <TableCell key={cell}>
                    <div className="flex h-5 items-center justify-end">
                      <Skeleton className="h-3.5 w-12" />
                    </div>
                  </TableCell>
                ))}
                <TableCell>
                  <Skeleton className="h-3.5 w-4/5 rounded" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <TextLines widths={["w-full", "w-full", "w-2/3"]} />
    </>
  )
}

/** «Lo que viene»: lo aceptado por hacer y lo que deja un paciente nuevo. */
export function OutlookBodySkeleton() {
  return (
    <>
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-bold text-muted-foreground">Presupuestos aceptados por hacer</span>
        <Skeleton className="h-9 w-32" />
        <TextLine width="w-4/5" />
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-bold text-muted-foreground">Un paciente nuevo, en sus primeros 6 meses</span>
        <Skeleton className="h-8 w-28" />
        <TextLines widths={["w-full", "w-11/12", "w-2/3"]} />
      </div>
    </>
  )
}

/** «Promociones y descuentos»: lo que se dejó de cobrar y una línea por promoción. */
export function PromotionsCardBodySkeleton() {
  return (
    <>
      <div className="flex flex-col gap-0.5">
        <span className="text-[13px] font-bold text-muted-foreground">Dejaste de cobrar</span>
        <Skeleton className="h-10 w-32" />
        <span className="text-[13px] text-muted-foreground">Frente a tus precios de tarifa, en lo que se aceptó o se cobró.</span>
      </div>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {times(3).map((row) => (
          <li key={row} className="flex min-w-0 items-center justify-between gap-3">
            <TextLine width="w-1/2" className="flex-1" />
            <Skeleton className="h-3.5 w-14 shrink-0" />
          </li>
        ))}
      </ul>
      <TextLine width="w-3/4" />
      <div className="flex h-11 items-center sm:h-8">
        <Skeleton className="h-3.5 w-44" />
      </div>
    </>
  )
}

/** El encabezado de la tarjeta de comisiones, igual al real. */
function CommissionsCardSkeleton() {
  // «Pagar comisiones» se ofrece a quien puede pagarlas, no solo verlas.
  const canPay = usePermission("commissions.write")
  return (
    <section className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-[18px]">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 max-w-3xl flex-col gap-0.5">
          <h3 className="font-semibold">Comisiones</h3>
          <p className="text-sm text-muted-foreground">Cada profesional gana su porcentaje de lo que se cobró de lo que atendió. Lo atendido que aún no se cobra no genera comisión todavía.</p>
        </div>
        {canPay ? <Skeleton className="h-11 w-28 sm:h-8" /> : null}
      </div>
      <CommissionsBodySkeleton />
    </section>
  )
}

/** Finanzas de Reportes, de lo cobrado a las promociones. */
export function FinanceTabSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className={FIGURES_FOUR}>
        <FinanceCardSkeleton title="Cobrado" />
        <FinanceCardSkeleton highlight lines={1} />
        <FinanceCardSkeleton title="Comisiones" />
        <FinanceCardSkeleton title="Te deben" />
      </div>
      <CardShell title="De lo cobrado a lo que deja el periodo">
        <div className="-mt-2 flex min-w-0 flex-wrap items-start justify-between gap-3">
          <TextLines widths={["w-full", "w-2/3"]} className="min-w-0 flex-[1_1_16rem] max-w-3xl" />
          <Skeleton className="h-7 w-56 max-w-full rounded-full" />
        </div>
        <WaterfallSkeleton />
        <TextLines widths={["w-full", "w-2/3"]} />
      </CardShell>
      <CardShell note={<Skeleton className="h-3.5 w-8" />}>
        <Insight widths={["w-full max-w-2xl"]} />
        <ColumnChartSkeleton legend={3} />
        <TextLines widths={["w-full", "w-1/2"]} />
      </CardShell>
      <CommissionsCardSkeleton />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="elevated flex min-w-0 flex-col gap-3.5 rounded-xl border bg-card p-[18px]">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="font-semibold">Cuánto te deben y desde cuándo</h3>
            <TextLine width="w-4/5" />
          </div>
          <Skeleton className="h-8 rounded-lg" />
          <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
            {["0 a 30 días", "31 a 60 días", "61 a 90 días", "Más de 90 días"].map((label) => (
              <div key={label} className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-bold text-foreground/80">{label}</span>
                <Skeleton className="h-7 w-20" />
                <TextLine width="w-16" />
                <div className="flex h-11 items-center sm:h-7">
                  <Skeleton className="h-3.5 w-20" />
                </div>
              </div>
            ))}
          </div>
        </section>
        <CardShell title="Lo que debes">
          <TextLine width="w-20" className="-mt-2" />
          <Skeleton className="h-9 w-32" />
          <ShareBarSkeleton parts={2} />
          <ul className="flex min-w-0 flex-col gap-2.5 text-sm">
            <li className="flex min-w-0 flex-col">
              <span className="flex items-center justify-between gap-2">
                <strong>Comisiones por pagar</strong>
                <Skeleton className="h-3.5 w-14" />
              </span>
              <TextLine width="w-36" />
            </li>
            <li className="flex min-w-0 flex-col">
              <span className="flex items-center justify-between gap-2">
                <strong>Compras recibidas sin pagar</strong>
                <Skeleton className="h-3.5 w-14" />
              </span>
              <TextLine width="w-44" />
            </li>
          </ul>
          <p className="text-[13px] text-muted-foreground">Un adelanto de una compra que aún no llega no está aquí: ya se pagó, y se descuenta cuando llegue.</p>
        </CardShell>
      </div>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <CardShell title="Lo que viene" note={<Skeleton className="h-3.5 w-12" />}>
          <OutlookBodySkeleton />
        </CardShell>
        <CardShell title="Cobrado por tratamiento" note={<Skeleton className="h-3.5 w-8" />}>
          <BarRowsSkeleton />
          <p className="text-[13px] text-muted-foreground">Lo que se aplicó a los cargos de cada servicio. Lo cobrado a cuenta, sin aplicar todavía, no aparece aquí.</p>
        </CardShell>
        <CardShell title="Cobrado por medio de pago" note={<Skeleton className="h-3.5 w-8" />}>
          <BarRowsSkeleton rows={4} />
          <TextLine width="w-3/4" />
        </CardShell>
        <CardShell title="Promociones y descuentos">
          <PromotionsCardBodySkeleton />
        </CardShell>
      </div>
    </div>
  )
}

/** «Qué dejó cada promoción»: cifras, lista con su recorrido al lado y cómo se cuenta. */
export function PromotionsViewSkeleton() {
  const grid = "md:grid-cols-[minmax(0,1.5fr)_minmax(150px,1.2fr)_96px_96px_minmax(0,1.3fr)]"
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-lg font-bold tracking-tight">Qué dejó cada promoción</h3>
        <TextLines widths={["w-full max-w-3xl", "w-2/3 max-w-xl"]} />
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { title: "Personas que usaron una", note: null },
          { title: "Eran nuevas", note: "Sin una cita atendida antes de usarla" },
          { title: "Cobrado a quienes las usaron", note: "Con la promoción y lo que vino después, hasta hoy" },
          { title: "Descuento dado", note: "Frente a tus precios de tarifa, en lo aceptado" },
        ].map((card) => (
          <div key={card.title} className="elevated flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card px-4 py-3.5">
            <span className="text-[13px] font-bold text-muted-foreground">{card.title}</span>
            <Skeleton className="my-1 h-7 w-20" />
            {card.note ? <span className="text-[13px] text-muted-foreground">{card.note}</span> : <TextLine width="w-24" />}
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-wrap items-start gap-4">
        <section className="elevated min-w-0 flex-[1_1_560px] overflow-hidden rounded-xl border bg-card">
          <div className={cn("hidden border-b bg-muted/50 text-xs font-bold text-muted-foreground md:grid", grid)}>
            <span className="px-3.5 py-2.5">Promoción</span>
            <span className="px-3.5 py-2.5">Quiénes la usaron</span>
            <span className="px-3.5 py-2.5 text-right">Cobrado</span>
            <span className="px-3.5 py-2.5 text-right">Descuento</span>
            <span className="px-3.5 py-2.5">¿Funcionó?</span>
          </div>
          <div className="flex w-full min-w-0 flex-col divide-y">
            {times(4).map((row) => (
              <div key={row} className={cn("grid w-full min-w-0 grid-cols-1 items-stretch gap-1.5 px-3.5 py-3 md:items-center md:gap-0 md:px-0 md:py-0", grid)}>
                <span className="flex min-w-0 flex-col md:px-3.5 md:py-3">
                  <TextLine width="w-36" />
                  <TextLine width="w-44" height="h-4" bar="h-3" />
                </span>
                <span className="flex min-w-0 flex-col gap-1 md:px-3.5 md:py-3">
                  <Skeleton className="h-3 rounded-[3px]" style={{ width: `${90 - row * 20}%` }} />
                  <TextLine width="w-28" height="h-4" bar="h-3" />
                </span>
                <span className="flex items-center justify-between gap-2 md:justify-end md:px-3.5 md:py-3">
                  <span className="text-sm text-muted-foreground md:hidden">Cobrado</span>
                  <Skeleton className="h-3.5 w-14" />
                </span>
                <span className="flex items-center justify-between gap-2 md:justify-end md:px-3.5 md:py-3">
                  <span className="text-sm text-muted-foreground md:hidden">Descuento</span>
                  <Skeleton className="h-3.5 w-14" />
                </span>
                <span className="md:px-3.5 md:py-3">
                  <TextLine width="w-32" />
                </span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-4 border-t px-3.5 py-3 text-xs text-foreground/80">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-[3px] bg-series-1" />
              Nuevas
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-[3px] bg-secondary" />
              Ya eran pacientes
            </span>
            <span className="ml-auto">La barra de cada promoción mide a cuántas personas la usaron, a la misma escala.</span>
          </div>
        </section>
        <aside className="elevated flex min-w-0 flex-[0_1_360px] flex-col gap-3 rounded-xl border bg-card p-[18px]">
          <TextLine width="w-44" height="h-6" bar="h-4" />
          <TextLine width="w-36" className="-mt-2" />
          {["Usaron la promoción", "Aceptaron el tratamiento", "Pagaron algo", "Volvieron por otro tratamiento"].map((label, index) => (
            <div key={label} className="flex flex-col gap-1">
              <span className="flex items-center justify-between text-sm">
                <span className="font-semibold">{label}</span>
                <Skeleton className="h-3.5 w-6" />
              </span>
              <span className="block h-4 rounded-r bg-secondary">
                <Skeleton className="h-full rounded-l-none" style={{ width: `${90 - index * 22}%` }} />
              </span>
            </div>
          ))}
          <Skeleton className="h-16 rounded-lg" />
        </aside>
      </div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Usó la promoción:", "un presupuesto presentado o un cobro suyo del periodo la lleva. Si nadie la marcó al presupuestar o cobrar, no aparece."],
          ["Nueva:", "no tenía ninguna cita atendida antes de usarla."],
          ["Volvió por más:", "tuvo otro cargo, sin esa promoción, después de usarla."],
          ["Descuento:", "precio de tarifa menos precio acordado, solo en lo aceptado o cobrado. En una «desde», contra el precio de tarifa, no contra el «desde»."],
        ].map(([title, text]) => (
          <p key={title} className="rounded-xl border bg-card px-3.5 py-3 text-[13px]">
            <strong>{title}</strong> {text}
          </p>
        ))}
      </div>
    </div>
  )
}

// --- Pacientes ------------------------------------------------------------------------------

export function PatientsTabSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className={FIGURES_FOUR}>
        <FigureSkeleton title="Nos buscaron por primera vez" note="Escribieron o los registró recepción" />
        <FigureSkeleton title="Pacientes nuevos" note="Vinieron por primera vez" />
        <FigureSkeleton footer={false} />
        <FigureSkeleton title="Pacientes activos" footer={false} />
      </div>
      <CardShell title="Dónde se caen los pacientes">
        <div className="-mt-1.5 flex min-w-0 flex-wrap items-start justify-between gap-3">
          <TextLines widths={["w-full", "w-3/5"]} className="min-w-0 flex-1 basis-80" />
          <Skeleton className="h-7 w-52 max-w-full shrink-0 rounded-full" />
        </div>
        <BarListSkeleton between />
      </CardShell>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[1.3fr_1fr]">
        <CardShell title="Por dónde nos buscaron">
          <p className="-mt-1.5 text-sm text-muted-foreground">Canal de la primera conversación. La parte oscura son los que vinieron.</p>
          <BarListSkeleton size="sm" rows={4} />
        </CardShell>
        <CardShell title="Cómo nos conocieron">
          <TextLine width="w-3/5" className="-mt-1.5" />
          <BarListSkeleton size="sm" />
          <p className="text-[13px] text-muted-foreground">Se pregunta al registrar al paciente, con una lista.</p>
        </CardShell>
      </div>
      <section className="flex min-w-0 flex-col gap-3">
        <h3 className="font-semibold">Si vuelven</h3>
        <div className={FIGURES_FOUR}>
          <FigureSkeleton title="Vinieron a su control" extra={<Skeleton className="mt-1 h-2 rounded-full" />} />
          <FigureSkeleton title="Volvieron en el año" footer={false} extra={<Skeleton className="mt-1 h-9 w-40 max-w-full" />} />
          <FigureSkeleton />
          <FigureSkeleton title="Volvieron tras la invitación" />
        </div>
      </section>
    </div>
  )
}

// --- Agenda ---------------------------------------------------------------------------------

function AgendaCardSkeleton({ title, spark = false, detailWidth = "w-32" }: { title: string; spark?: boolean; detailWidth?: string }) {
  return (
    <div className="elevated flex min-w-0 flex-col gap-1 rounded-xl border bg-card px-[18px] py-4">
      <h3 className="text-[13px] font-bold text-muted-foreground">{title}</h3>
      <div className="flex min-w-0 items-end justify-between gap-3">
        <Skeleton className="h-9 min-w-0 flex-1 max-w-24" />
        {spark ? <Skeleton className="h-9 w-[120px] shrink-0" /> : null}
      </div>
      <TextLine width="w-40" />
      <TextLine width={detailWidth} />
    </div>
  )
}

export function AgendaTabSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className={FIGURES_FOUR}>
        <AgendaCardSkeleton title="Citas atendidas" detailWidth="w-44" />
        <AgendaCardSkeleton title="No vinieron" />
        <AgendaCardSkeleton title="Canceladas" />
        <AgendaCardSkeleton title="Agenda ocupada" spark detailWidth="w-44" />
      </div>
      <CardShell>
        <Insight widths={["w-full max-w-2xl"]} />
        <ColumnChartSkeleton legend={3} />
      </CardShell>
      <CardShell title="Cuándo queda libre la agenda">
        <div className="-mt-2 flex min-w-0 flex-wrap items-start justify-between gap-3">
          <TextLine width="w-96" className="min-w-0 max-w-3xl" />
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-9 w-56 max-w-full rounded-full" />
            <Skeleton className="h-11 w-72 max-w-full rounded-3xl" />
          </div>
        </div>
        <TextLine width="w-80" height="h-4" bar="h-3" />
        <HeatmapSkeleton />
        <Skeleton className="h-14 rounded-lg" />
      </CardShell>
      <CardShell title="Por profesional">
        <ul className="flex min-w-0 flex-col divide-y md:hidden">
          {times(4).map((row) => (
            <li key={row} className="flex min-w-0 flex-col gap-1 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <TextLine width="w-36" height="h-6" />
                <Skeleton className="h-4 w-12 shrink-0" />
              </div>
              <Skeleton className="h-2 rounded-full" />
              <div className="flex flex-wrap gap-x-3">
                <TextLine width="w-20" />
                <TextLine width="w-28" />
                <TextLine width="w-20" />
                <TextLine width="w-24" />
              </div>
            </li>
          ))}
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
              {times(4).map((row) => (
                <TableRow key={row}>
                  <TableCell>
                    <TextLine width="w-36" />
                  </TableCell>
                  {times(3).map((cell) => (
                    <TableCell key={cell}>
                      <div className="flex h-5 items-center justify-end">
                        <Skeleton className="h-3.5 w-10" />
                      </div>
                    </TableCell>
                  ))}
                  <TableCell>
                    <span className="flex items-center gap-2.5">
                      <Skeleton className="h-2 flex-1 rounded-full" />
                      <Skeleton className="h-3.5 w-14 shrink-0" />
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="flex h-5 items-center justify-end">
                      <Skeleton className="h-3.5 w-10" />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <TextLines widths={["w-full", "w-2/3"]} />
      </CardShell>
    </div>
  )
}

// --- Agente ---------------------------------------------------------------------------------

export function AgentTabSkeleton() {
  // Lo pagado a odentIA solo llega a quien ve Facturación: el servidor no se lo entrega a nadie más.
  const paid = seesBilling(useMyRole())
  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      <div className={FIGURES_FOUR}>
        <SummaryFigureSkeleton title="Conversaciones que atendió" footer={false} />
        <SummaryFigureSkeleton title="Citas que agendó" />
        <SummaryFigureSkeleton title="Citas recuperadas" footer={false} />
        <SummaryFigureSkeleton title="Consultas dictadas" footer={false} />
      </div>
      <section className="elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-[18px] sm:p-[22px]">
        <div className="flex min-w-0 flex-col gap-0.5">
          {paid ? <TextLine width="w-96" height="h-7" bar="h-5" /> : <h3 className="text-[17px] font-extrabold tracking-tight">Lo cobrado en las citas del agente</h3>}
          {paid ? <TextLine width="w-4/5" /> : null}
        </div>
        <div className="grid min-w-0 gap-4 @3xl:grid-cols-2">
          {paid ? (
            <div className="flex min-w-0 flex-col gap-2.5 rounded-xl border bg-muted/40 px-4 py-4 sm:px-5 sm:py-[18px]">
              <TextLine width="w-56" />
              <Skeleton className="h-9 w-32" />
              <div className="flex flex-col gap-1.5">
                {times(2).map((row) => (
                  <div key={row} className="flex items-start justify-between gap-4">
                    <TextLines widths={["w-4/5", "w-3/5"]} className="flex-1" />
                    <Skeleton className="mt-1 h-3.5 w-14 shrink-0" />
                  </div>
                ))}
              </div>
              <TextLines widths={["w-full", "w-2/3"]} />
              <div className="flex h-11 items-center sm:h-8">
                <Skeleton className="h-3.5 w-32" />
              </div>
            </div>
          ) : null}
          <div className="flex min-w-0 flex-col gap-2.5 rounded-xl bg-primary-soft px-4 py-4 text-primary-soft-foreground sm:px-5 sm:py-[18px]">
            <span className="text-[13px] font-bold">Cobrado en citas que agendó el agente</span>
            <Skeleton className="h-9 w-32" />
            <div className="flex items-center justify-between gap-4">
              <TextLine width="w-3/5" className="flex-1" />
              <Skeleton className="h-3.5 w-14 shrink-0" />
            </div>
            <p className="text-[13px]">Es lo que esos pacientes pagaron hasta hoy por esas citas, no lo que el agente «ganó»: quizá algunos habrían venido igual.</p>
          </div>
        </div>
      </section>
      <div className="grid min-w-0 items-start gap-4 @5xl:grid-cols-[1.3fr_1fr]">
        <CardShell>
          <Insight />
          <ColumnChartSkeleton />
        </CardShell>
        <CardShell title="Cómo respondimos a quien escribió">
          <div className="flex min-w-0 flex-col gap-1">
            <TextLine width="w-4/5" />
            <TextLine width="w-2/5" />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <h4 className="text-[13px] font-bold text-muted-foreground">Quién respondió primero</h4>
            <ShareBarSkeleton parts={2} />
            <TextLine width="w-4/5" />
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-3">
            <TileSkeleton title="Pasaron al equipo" detail={false} />
            <TileSkeleton title="Siguen sin respuesta" detail={false} />
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <h4 className="text-[13px] font-bold text-muted-foreground">Por dónde escribieron</h4>
            <ShareBarSkeleton />
          </div>
        </CardShell>
      </div>
    </div>
  )
}

// --- La página ------------------------------------------------------------------------------

/** El periodo, la sede, la comparación y la pregunta a Argos, en la fila de la pantalla. */
function FiltersSkeleton() {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Skeleton className="h-9 w-40 rounded-full" />
      {/* En el teléfono, sede y comparación van cada una en su fila, como al llegar. */}
      <div className="max-sm:basis-full">
        <Skeleton className="h-9 w-48 rounded-full" />
      </div>
      <div className="max-sm:basis-full">
        <Skeleton className="h-4 w-56 max-w-full" />
      </div>
      <div className="flex min-w-0 flex-[1_1_22rem] flex-col gap-1 sm:max-w-xl md:ml-auto">
        <Skeleton className="h-11 w-full rounded-lg" />
      </div>
    </div>
  )
}

function TabsRowSkeleton({ active }: { active: ReportTabKey }) {
  return (
    <nav aria-label="Secciones de Reportes" className="flex min-w-0 gap-1 overflow-x-auto overflow-y-hidden border-b [scrollbar-width:none]">
      {TABS.map((item) => (
        <Link
          key={item.key}
          to="/reports"
          search={(prev) => ({ ...prev, tab: item.key === "resumen" ? undefined : item.key, lista: undefined, vista: undefined })}
          aria-current={item.key === active ? "page" : undefined}
          className={cn(
            "-mb-px inline-flex min-h-11 shrink-0 items-center border-b-[2.5px] px-3.5 text-sm",
            item.key === active ? "border-primary font-extrabold text-primary-soft-foreground" : "border-transparent font-semibold text-foreground/80",
          )}
        >
          {item.title}
        </Link>
      ))}
    </nav>
  )
}

function TabBody({ tab, promotions }: { tab: ReportTabKey; promotions: boolean }) {
  if (tab === "finanzas") return promotions ? <PromotionsViewSkeleton /> : <FinanceTabSkeleton />
  if (tab === "pacientes") return <PatientsTabSkeleton />
  if (tab === "agenda") return <AgendaTabSkeleton />
  if (tab === "agente") return <AgentTabSkeleton />
  return <SummaryTabSkeleton />
}

/** Lo que va bajo el título: filtros, pestañas y la pestaña elegida. También mientras se sabe si la clínica está configurada. */
export function ReportsBodySkeleton({ tab, promotions = false }: { tab: ReportTabKey; promotions?: boolean }) {
  const copy = TABS.find((item) => item.key === tab)
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FiltersSkeleton />
      <TabsRowSkeleton active={tab} />
      {tab !== "resumen" && copy ? (
        <div>
          <h2 className="text-lg font-bold tracking-tight">{copy.title}</h2>
          <p className="text-sm text-muted-foreground">{copy.question}</p>
        </div>
      ) : null}
      <div className="@container min-w-0">
        <TabBody tab={tab} promotions={promotions} />
      </div>
    </div>
  )
}

/** Mientras llega el código de Reportes: la pestaña de la dirección, con su título real. */
export function ReportsPageSkeleton() {
  const wanted = useSearchValue("tab")
  const vista = useSearchValue("vista")
  const mapped = wanted ? (LEGACY_TABS[wanted] ?? wanted) : "resumen"
  const tab = TABS.find((item) => item.key === mapped)?.key ?? "resumen"
  return (
    <PageLoading title="Reportes">
      <ReportsBodySkeleton tab={tab} promotions={vista === "promociones"} />
    </PageLoading>
  )
}
